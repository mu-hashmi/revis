/** Project-local path ownership for Revis runtime state and assets. */

import * as PlatformPath from "@effect/platform/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AgentId } from "../domain/models";

export interface ProjectPathsApi {
  readonly root: string;
  readonly revisDir: string;
  readonly configFile: string;
  readonly stateDir: string;
  readonly daemonStateFile: string;
  readonly workspaceStateDir: string;
  readonly journalDir: string;
  readonly liveJournalFile: string;
  readonly archiveDir: string;
  readonly sessionsDir: string;
  readonly dashboardRoot: string;
  readonly socketPath: string;
  readonly workspaceRuntimeDir: (agentId: AgentId | string) => string;
  readonly workspaceRepoDir: (agentId: AgentId | string) => string;
  readonly workspaceLogFile: (agentId: AgentId | string) => string;
  readonly workspaceExitFile: (agentId: AgentId | string) => string;
  readonly sessionDir: (sessionId: string) => string;
  readonly sessionMetaFile: (sessionId: string) => string;
  readonly sessionEventsFile: (sessionId: string) => string;
  readonly workspaceStateFile: (agentId: AgentId | string) => string;
}

export class ProjectPaths extends Context.Tag("@revis/ProjectPaths")<
  ProjectPaths,
  ProjectPathsApi
>() {}

export function projectPathsLayer(root: string) {
  return Layer.effect(
    ProjectPaths,
    Effect.gen(function* () {
      const path = yield* PlatformPath.Path;
      const revisDir = path.join(root, ".revis");
      const stateDir = path.join(revisDir, "state");
      const workspaceStateDir = path.join(stateDir, "workspaces");
      const journalDir = path.join(revisDir, "journal");
      const archiveDir = path.join(revisDir, "archive");
      const sessionsDir = path.join(archiveDir, "sessions");
      const dashboardRoot = yield* path.fromFileUrl(new URL("../dashboard/", import.meta.url)).pipe(
        Effect.orDie
      );

      return ProjectPaths.of({
        root,
        revisDir,
        configFile: path.join(revisDir, "config.json"),
        stateDir,
        daemonStateFile: path.join(stateDir, "daemon.json"),
        workspaceStateDir,
        journalDir,
        liveJournalFile: path.join(journalDir, "live.jsonl"),
        archiveDir,
        sessionsDir,
        dashboardRoot,
        socketPath: path.join(revisDir, "daemon.sock"),
        workspaceRuntimeDir: (agentId) => path.join(revisDir, "workspaces", String(agentId)),
        workspaceRepoDir: (agentId) => path.join(revisDir, "workspaces", String(agentId), "repo"),
        workspaceLogFile: (agentId) => path.join(revisDir, "workspaces", String(agentId), "session.log"),
        workspaceExitFile: (agentId) => path.join(revisDir, "workspaces", String(agentId), "session.exit"),
        sessionDir: (sessionId) => path.join(sessionsDir, sessionId),
        sessionMetaFile: (sessionId) => path.join(sessionsDir, sessionId, "meta.json"),
        sessionEventsFile: (sessionId) => path.join(sessionsDir, sessionId, "events.jsonl"),
        workspaceStateFile: (agentId) => path.join(workspaceStateDir, `${String(agentId)}.json`)
      });
    })
  );
}
