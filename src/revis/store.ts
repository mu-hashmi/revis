/** Run-scoped storage for Revis config, participants, and event logs. */

import { join } from "node:path";

import { Effect, Schema } from "effect";

import { StorageError } from "../domain/errors";
import {
  AgentId,
  ParticipantRecordSchema,
  RevisConfig,
  RevisEventSchema,
  RunId,
  RunRecord,
  type ParticipantRecord,
  type RevisEvent
} from "../domain/models";
import {
  appendJsonLine,
  ensureDir,
  pathExists,
  readDirectory,
  readJsonFile,
  readJsonLines,
  readTextFile,
  removePath,
  writeJsonFile,
  writeTextFile
} from "./files";
import { FileSessionPersistDriver } from "./session-persist";

/** Stable project-level paths under `.revis/`. */
export interface ProjectPaths {
  readonly activeRunFile: string;
  readonly configFile: string;
  readonly revisDir: string;
  readonly root: string;
  readonly runsDir: string;
}

/** Stable run-level paths under `.revis/runs/<run-id>/`. */
export interface RunPaths extends ProjectPaths {
  readonly agentsDir: string;
  readonly eventsDir: string;
  readonly revisEventsFile: string;
  readonly runDir: string;
  readonly runFile: string;
  readonly runId: string;
  readonly sessionsDir: string;
  readonly worktreesDir: string;
}

/** Build stable project-level paths under `.revis/`. */
export function projectPaths(root: string): ProjectPaths {
  const revisDir = join(root, ".revis");

  return {
    activeRunFile: join(revisDir, "active-run"),
    configFile: join(revisDir, "config.json"),
    revisDir,
    root,
    runsDir: join(revisDir, "runs")
  };
}

/** Build stable run-scoped paths under `.revis/runs/<run-id>/`. */
export function runPaths(root: string, runId: string): RunPaths {
  const project = projectPaths(root);
  const runDir = join(project.runsDir, runId);

  return {
    ...project,
    agentsDir: join(runDir, "agents"),
    eventsDir: join(runDir, "events"),
    revisEventsFile: join(runDir, "revis-events.jsonl"),
    runDir,
    runFile: join(runDir, "run.json"),
    runId,
    sessionsDir: join(runDir, "sessions"),
    worktreesDir: join(runDir, "worktrees")
  };
}

/** File-backed store for one run. */
export class RunStore {
  /** Build a store plus session persistence driver for one run id. */
  static make(root: string, runId: string) {
    const paths = runPaths(root, runId);

    return Effect.map(
      FileSessionPersistDriver.make({
        eventsDir: paths.eventsDir,
        sessionsDir: paths.sessionsDir
      }),
      (sessionPersist) => new RunStore(paths, sessionPersist)
    );
  }

  readonly paths: RunPaths;
  readonly sessionPersist: FileSessionPersistDriver;

  constructor(paths: RunPaths, sessionPersist: FileSessionPersistDriver) {
    this.paths = paths;
    this.sessionPersist = sessionPersist;
  }

  /** Ensure the on-disk run layout exists. */
  ensureLayout() {
    return Effect.all(
      [
        ensureDir(this.paths.agentsDir),
        ensureDir(this.paths.eventsDir),
        ensureDir(this.paths.sessionsDir),
        ensureDir(this.paths.worktreesDir)
      ],
      { discard: true }
    );
  }

  /** Load the run metadata record. */
  loadRun() {
    return readJsonFile(this.paths.runFile, RunRecord);
  }

  /** Persist the run metadata record. */
  saveRun(run: RunRecord) {
    return writeJsonFile(this.paths.runFile, RunRecord, run);
  }

  /** Load one participant record. */
  loadParticipant(agentId: AgentId) {
    return readJsonFile(this.participantPath(agentId), ParticipantRecordSchema);
  }

  /** Load every participant record in agent-id order. */
  listParticipants() {
    const self = this;

    return Effect.gen(function* () {
      // A brand-new run may not have written any agent files yet.
      if (!(yield* pathExists(self.paths.agentsDir))) {
        return [];
      }

      const names = (yield* readDirectory(self.paths.agentsDir))
        .filter((name) => name.endsWith(".json"))
        .sort();

      return yield* Effect.forEach(
        names,
        (name) => readJsonFile(join(self.paths.agentsDir, name), ParticipantRecordSchema)
      );
    });
  }

  /** Upsert one participant record. */
  saveParticipant(participant: ParticipantRecord) {
    return writeJsonFile(this.participantPath(participant.agentId), ParticipantRecordSchema, participant);
  }

  /** Append one high-level Revis event. */
  appendEvent(event: RevisEvent) {
    return appendJsonLine(this.paths.revisEventsFile, RevisEventSchema, event);
  }

  /** Read all high-level Revis events in insertion order. */
  listEvents() {
    const self = this;

    return Effect.gen(function* () {
      // The event log is optional until the first event is appended.
      if (!(yield* pathExists(self.paths.revisEventsFile))) {
        return [];
      }

      return yield* readJsonLines(self.paths.revisEventsFile, RevisEventSchema);
    });
  }

  /** Remove local worktrees when the run is fully stopped. */
  destroyFiles() {
    return removePath(this.paths.runDir, { recursive: true, force: true });
  }

  /** Resolve one participant file path. */
  private participantPath(agentId: AgentId): string {
    return join(this.paths.agentsDir, `${agentId}.json`);
  }
}

/** Load the project config when it already exists. */
export function loadConfig(root: string) {
  const paths = projectPaths(root);

  return Effect.gen(function* () {
    if (!(yield* pathExists(paths.configFile))) {
      return null;
    }

    return yield* readJsonFile(paths.configFile, RevisConfig);
  });
}

/** Persist the project config. */
export function saveConfig(root: string, config: RevisConfig) {
  return writeJsonFile(projectPaths(root).configFile, RevisConfig, config);
}

/** Return the active run id for the project when one is set. */
export function loadActiveRunId(root: string) {
  const file = projectPaths(root).activeRunFile;

  return Effect.gen(function* () {
    if (!(yield* pathExists(file))) {
      return null;
    }

    return (yield* readTextFile(file)).trim();
  });
}

/** Point the project at one active run. */
export function saveActiveRunId(root: string, runId: string) {
  return writeTextFile(projectPaths(root).activeRunFile, `${runId}\n`);
}

/** Clear the active run pointer. */
export function clearActiveRunId(root: string) {
  return removePath(projectPaths(root).activeRunFile, { force: true });
}

/** Load the active run store and metadata together. */
export function loadActiveRun(root: string) {
  return Effect.gen(function* () {
    const runId = yield* loadActiveRunId(root);
    if (!runId) {
      return null;
    }

    // Fail loudly if the active pointer drifted away from the on-disk run state.
    const store = yield* RunStore.make(root, runId);
    if (!(yield* pathExists(store.paths.runFile))) {
      return yield* new StorageError({
        path: store.paths.runFile,
        detail: "active run file points at a missing run"
      });
    }

    return store;
  });
}
