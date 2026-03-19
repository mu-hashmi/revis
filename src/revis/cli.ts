/** Manual CLI parser and command handlers for the SDK-native Revis runtime. */

import { Clock, Console, Effect } from "effect";

import { clearActiveRunId, loadActiveRun } from "./store";
import { openOrReusePullRequest, remoteUrl, resolveProjectRoot } from "./git";
import { initConfig, loadOrCreateConfig, type ConfigOverrides } from "./config";
import { resumeRun, spawnRun } from "./coordinator";
import { destroySandbox, sandboxHealth, startSandbox } from "./sandbox";
import { localWorkspaceOps, remoteWorkspaceOps } from "./workspace";
import { ValidationError, formatDomainError } from "../domain/errors";
import {
  ParticipantStopped,
  Promoted,
  RunRecord,
  RunStopped,
  StoppedParticipant,
  asAgentId,
  asTimestamp,
  participantIsActive,
  type AgentId,
  type AgentKind,
  type SandboxKind,
  type Timestamp
} from "../domain/models";

const VERSION = "0.1.1";

/** Run the Revis CLI against the provided argv array. */
export function runCli(argv: readonly string[]) {
  return Effect.catchAll(
    Effect.gen(function* () {
      const [command = "help", ...rest] = argv;
      const parsed = parseArgs(rest);

      switch (command) {
        case "help":
          return yield* Console.log(helpText());
        case "version":
          return yield* Console.log(VERSION);
        case "init":
          return yield* runInit(parsed);
        case "spawn":
          return yield* runSpawn(parsed);
        case "resume":
          return yield* runResume();
        case "status":
          return yield* runStatus(parsed);
        case "events":
          return yield* runEvents(parsed);
        case "stop":
          return yield* runStop(parsed);
        case "promote":
          return yield* runPromote(parsed);
        case "dashboard":
          return yield* runDashboard(parsed);
        default:
          return yield* new ValidationError({
            detail: `unknown command: ${command}`
          });
      }
    }),
    (error) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
        yield* Console.error(formatDomainError(error));
      })
  );
}

/** Initialize `.revis/` for the current repository. */
function runInit(parsed: ParsedArgs) {
  return Effect.gen(function* () {
    const root = yield* resolveProjectRoot(process.cwd());
    const config = yield* initConfig(root, yield* configOverrides(parsed));

    yield* Console.log(`Initialized ${root}`);
    yield* Console.log(`remote=${config.git.remoteName} base=${config.git.baseBranch}`);
    yield* Console.log(`sandbox=${config.sandbox.kind} agent=${config.agent.kind}`);
  });
}

/** Start a new multi-agent run from the current repository. */
function runSpawn(parsed: ParsedArgs) {
  return Effect.gen(function* () {
    // Validate the required positional arguments first.
    const countText = parsed.positionals[0];
    const task = parsed.positionals.slice(1).join(" ").trim();

    if (!countText || task.length === 0) {
      return yield* new ValidationError({
        detail: "usage: revis spawn <count> <task>"
      });
    }

    const count = Number(countText);
    if (!Number.isInteger(count) || count <= 0) {
      return yield* new ValidationError({
        detail: "spawn count must be a positive integer"
      });
    }

    // Resolve the repo and final config, then hand off to the coordinator.
    const root = yield* resolveProjectRoot(process.cwd());
    const config = yield* loadOrCreateConfig(root, yield* configOverrides(parsed));

    yield* spawnRun({
      config,
      count,
      root,
      task
    });
  });
}

/** Resume the currently active run. */
function runResume() {
  return Effect.gen(function* () {
    const root = yield* resolveProjectRoot(process.cwd());
    const store = yield* loadActiveRun(root);
    if (!store) {
      return yield* noActiveRun();
    }

    yield* resumeRun({
      run: yield* store.loadRun(),
      store
    });
  });
}

/** Print a one-shot or probing status snapshot for the active run. */
function runStatus(parsed: ParsedArgs) {
  return Effect.gen(function* () {
    const root = yield* resolveProjectRoot(process.cwd());
    const store = yield* loadActiveRun(root);
    if (!store) {
      return yield* noActiveRun();
    }

    const run = yield* store.loadRun();
    const participants = yield* store.listParticipants();

    yield* Console.log(`run ${run.id} ${run.task}`);
    yield* Console.log(`sandbox=${run.config.sandbox.kind} agent=${run.config.agent.kind}`);

    for (const participant of participants) {
      let probe = "";

      // Open a scoped sandbox only when the operator asked for a live health probe.
      if (parsed.flags.has("probe") && participantIsActive(participant) && participant.sandboxId) {
        probe = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* startSandbox(run.config.sandbox, store.sessionPersist, participant.sandboxId);
            const health = yield* sandboxHealth(handle);
            return ` health=${health.status}`;
          })
        );
      }

      yield* Console.log(
        `${participant.agentId} ${participant._tag} branch=${participant.branch} queued=${participant.pendingPrompts.length}${probe}`
      );
    }
  });
}

/** Stream or print the high-level Revis event log. */
function runEvents(parsed: ParsedArgs) {
  return Effect.gen(function* () {
    const root = yield* resolveProjectRoot(process.cwd());
    const store = yield* loadActiveRun(root);
    if (!store) {
      return yield* noActiveRun();
    }

    let seen = 0;

    while (true) {
      const events = yield* store.listEvents();

      for (const event of events.slice(seen)) {
        yield* Console.log(`${event.timestamp} ${event.summary}`);
      }
      seen = events.length;

      if (!parsed.flags.has("follow")) {
        return;
      }

      yield* Effect.sleep("1 second");
    }
  });
}

/** Stop one participant or the whole active run. */
function runStop(parsed: ParsedArgs) {
  return Effect.gen(function* () {
    const root = yield* resolveProjectRoot(process.cwd());
    const store = yield* loadActiveRun(root);
    if (!store) {
      return yield* noActiveRun();
    }

    const run = yield* store.loadRun();
    const participants = yield* store.listParticipants();
    const targetAgentId =
      parsed.flags.has("all")
        ? null
        : parsed.positionals[0]
          ? yield* parseAgentId(parsed.positionals[0]!)
          : null;

    // Stop each matching active participant in place.
    for (const participant of participants) {
      if (!participantIsActive(participant)) {
        continue;
      }

      if (targetAgentId && participant.agentId !== targetAgentId) {
        continue;
      }

      if (participant.sandboxId) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* startSandbox(run.config.sandbox, store.sessionPersist, participant.sandboxId);
            yield* destroySandbox(handle);
          })
        );
      }

      if (run.config.sandbox.kind === "local") {
        yield* localWorkspaceOps(root, participant.workspaceRoot).destroy();
      }

      const timestamp = yield* now();
      const stopped = StoppedParticipant.make({
        ...participant,
        stoppedAt: timestamp,
        updatedAt: timestamp
      });

      yield* store.saveParticipant(stopped);
      yield* store.appendEvent(
        ParticipantStopped.make({
          agentId: stopped.agentId,
          runId: run.id,
          summary: `Stopped ${stopped.agentId}`,
          timestamp
        })
      );
      yield* Console.log(`stopped ${stopped.agentId}`);
    }

    // Once every participant is stopped, mark the run as ended too.
    const remaining = (yield* store.listParticipants()).some(participantIsActive);
    if (!remaining) {
      const stoppedRun = RunStopped.make({
        runId: run.id,
        summary: `Stopped run ${run.id}`,
        timestamp: yield* now()
      });

      yield* store.appendEvent(stoppedRun);
      yield* store.saveRun(runStoppedToRun(run, stoppedRun.timestamp));
      yield* clearActiveRunId(root);
    }
  });
}

/** Push one participant branch and open or reuse its pull request. */
function runPromote(parsed: ParsedArgs) {
  return Effect.scoped(
    Effect.gen(function* () {
      // Validate the target participant first.
      const inputAgentId = parsed.positionals[0];
      if (!inputAgentId) {
        return yield* new ValidationError({
          detail: "usage: revis promote <agent-id>"
        });
      }

      const agentId = yield* parseAgentId(inputAgentId);
      const root = yield* resolveProjectRoot(process.cwd());
      const store = yield* loadActiveRun(root);
      if (!store) {
        return yield* noActiveRun();
      }

      const run = yield* store.loadRun();
      const participant = (yield* store.listParticipants()).find((value) => value.agentId === agentId);
      if (!participant) {
        return yield* new ValidationError({
          detail: `unknown agent: ${inputAgentId}`
        });
      }

      // Resolve the workspace through the same abstraction used by the coordinator.
      const workspace =
        run.config.sandbox.kind === "local"
          ? localWorkspaceOps(root, participant.workspaceRoot)
          : remoteWorkspaceOps(
              yield* startSandbox(
                run.config.sandbox,
                store.sessionPersist,
                participant.sandboxId ??
                  (yield* new ValidationError({
                    detail: `${participant.agentId} has no active sandbox`
                  }))
              ),
              participant.workspaceRoot
            );

      if (yield* workspace.workingTreeDirty()) {
        return yield* new ValidationError({
          detail: `${participant.agentId} has uncommitted changes`
        });
      }

      yield* workspace.pushBranch(run.config.git.remoteName, participant.branch);

      const url = yield* openOrReusePullRequest({
        baseBranch: run.config.git.baseBranch,
        body: `Automated promotion candidate from ${participant.agentId}.`,
        headBranch: participant.branch,
        remoteUrl: yield* remoteUrl(root, run.config.git.remoteName),
        root,
        title: `[Revis] ${participant.branch}`
      });
      const timestamp = yield* now();

      yield* store.appendEvent(
        Promoted.make({
          agentId: participant.agentId,
          branch: participant.branch,
          pullRequestUrl: url,
          runId: run.id,
          summary: `Promoted ${participant.agentId} -> ${url}`,
          timestamp
        })
      );
      yield* Console.log(url);
    })
  );
}

/** Print the inspector URL for one active participant sandbox. */
function runDashboard(parsed: ParsedArgs) {
  return Effect.scoped(
    Effect.gen(function* () {
      const root = yield* resolveProjectRoot(process.cwd());
      const store = yield* loadActiveRun(root);
      if (!store) {
        return yield* noActiveRun();
      }

      const run = yield* store.loadRun();
      const participants = yield* store.listParticipants();
      const targetAgentId = parsed.positionals[0] ? yield* parseAgentId(parsed.positionals[0]!) : null;
      const target = targetAgentId
        ? participants.find((participant) => participant.agentId === targetAgentId)
        : participants.find((participant) => participantIsActive(participant));

      if (!target || !target.sandboxId) {
        return yield* new ValidationError({
          detail: "no participant sandbox available"
        });
      }

      const handle = yield* startSandbox(run.config.sandbox, store.sessionPersist, target.sandboxId);
      yield* Console.log(handle.inspectorUrl);
    })
  );
}

/** Return a copy of the run marked with its terminal timestamp. */
function runStoppedToRun(run: RunRecord, endedAt: Timestamp) {
  return RunRecord.make({
    ...run,
    endedAt
  });
}

/** Collect CLI flags into the config override object used by init/spawn. */
function configOverrides(parsed: ParsedArgs) {
  return Effect.gen(function* () {
    const agent = textFlag(parsed, "agent");
    const baseBranch = textFlag(parsed, "base");
    const branchPrefix = textFlag(parsed, "branch-prefix");
    const mode = textFlag(parsed, "mode");
    const model = textFlag(parsed, "model");
    const remoteName = textFlag(parsed, "remote");
    const sandbox = textFlag(parsed, "sandbox");
    const thought = textFlag(parsed, "thought");
    const env = parsed.flags.get("env");

    const overrides: {
      -readonly [Key in keyof ConfigOverrides]?: ConfigOverrides[Key];
    } = {};

    // Keep the parsing explicit so bad flags fail with the provider-specific message.
    if (agent) {
      overrides.agent = yield* parseAgentKind(agent);
    }
    if (baseBranch) {
      overrides.baseBranch = baseBranch;
    }
    if (branchPrefix) {
      overrides.branchPrefix = branchPrefix;
    }
    if (env) {
      overrides.env = env;
    }
    if (mode) {
      overrides.mode = mode;
    }
    if (model) {
      overrides.model = model;
    }
    if (remoteName) {
      overrides.remoteName = remoteName;
    }
    if (sandbox) {
      overrides.sandbox = yield* parseSandboxKind(sandbox);
    }
    if (thought) {
      overrides.thought = thought;
    }

    return overrides;
  });
}

type ParsedArgs = {
  readonly flags: Map<string, string[]>;
  readonly positionals: string[];
};

/** Parse `--flag value` pairs plus positional arguments without extra dependencies. */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;

    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const name = value.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      flags.set(name, ["true"]);
      continue;
    }

    const current = flags.get(name) ?? [];
    current.push(next);
    flags.set(name, current);
    index += 1;
  }

  return { flags, positionals };
}

/** Return the last provided value for one text flag. */
function textFlag(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

/** Render the built-in CLI help text. */
function helpText(): string {
  return [
    "revis init [--remote <name>] [--base <branch>] [--sandbox <kind>] [--agent <kind>]",
    "revis spawn <count> <task> [--sandbox <kind>] [--agent <kind>] [--model <id>] [--mode <id>] [--thought <level>]",
    "revis resume",
    "revis status [--probe]",
    "revis events [--follow]",
    "revis stop [agent-id|--all]",
    "revis promote <agent-id>",
    "revis dashboard [agent-id]",
    "revis version"
  ].join("\n");
}

/** Parse the `--agent` flag. */
function parseAgentKind(value: string) {
  switch (value) {
    case "codex":
    case "claude":
    case "opencode":
      return Effect.succeed(value satisfies AgentKind);
    default:
      return Effect.fail(new ValidationError({
        detail: `unsupported agent: ${value}`
      }));
  }
}

/** Parse the `--sandbox` flag. */
function parseSandboxKind(value: string) {
  switch (value) {
    case "local":
    case "daytona":
    case "e2b":
    case "docker":
      return Effect.succeed(value satisfies SandboxKind);
    default:
      return Effect.fail(new ValidationError({
        detail: `unsupported sandbox: ${value}`
      }));
  }
}

/** Parse an agent id in the canonical `agent-N` form. */
function parseAgentId(value: string) {
  if (!/^agent-\d+$/.test(value)) {
    return Effect.fail(new ValidationError({
      detail: `unknown agent: ${value}`
    }));
  }

  return Effect.succeed<AgentId>(asAgentId(value));
}

/** Fail with the standard active-run-not-found message. */
function noActiveRun() {
  return Effect.fail(new ValidationError({
    detail: "no active run found"
  }));
}

/** Return the current wall-clock timestamp in persisted ISO form. */
function now() {
  return Effect.map(
    Clock.currentTimeMillis,
    (millis) => asTimestamp(new Date(millis).toISOString())
  );
}
