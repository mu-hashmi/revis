/** Deterministic test factories for project paths, daemon state, and workspace snapshots. */

import { join } from "node:path";

import {
  DaemonState,
  RestartPendingState,
  RevisConfig,
  RunningState,
  WorkspaceSnapshot,
  WorkspaceSpec,
  asAgentId,
  asBranchName,
  asOperatorSlug,
  asRevision,
  asTimestamp,
  asWorkspaceSessionId,
  type AgentId,
  type BranchName,
  type OperatorSlug,
  type Revision
} from "../../src/domain/models";
import type { ProjectPathsApi } from "../../src/services/project-paths";

interface WorkspaceSpecOverrides {
  readonly agentId?: AgentId;
  readonly coordinationBranch?: BranchName;
  readonly createdAt?: string;
  readonly execCommand?: string;
  readonly localBranch?: BranchName;
  readonly operatorSlug?: OperatorSlug;
  readonly sandboxProvider?: "local" | "daytona";
  readonly workspaceRoot?: string;
}

interface TrackingOverrides {
  readonly iteration?: number;
  readonly lastCommitSha?: Revision;
  readonly lastPushedSha?: Revision;
  readonly lastSeenRemoteSha?: Revision;
  readonly lastRebasedOntoSha?: Revision;
  readonly lastExitCode?: number;
  readonly lastExitedAt?: string;
}

/** Build one deterministic `ProjectPathsApi` for tests without touching the filesystem. */
export function makeProjectPaths(root: string): ProjectPathsApi {
  const revisDir = join(root, ".revis");
  const stateDir = join(revisDir, "state");
  const workspaceStateDir = join(stateDir, "workspaces");
  const journalDir = join(revisDir, "journal");
  const archiveDir = join(revisDir, "archive");
  const sessionsDir = join(archiveDir, "sessions");

  return {
    root,
    revisDir,
    configFile: join(revisDir, "config.json"),
    stateDir,
    daemonStateFile: join(stateDir, "daemon.json"),
    workspaceStateDir,
    journalDir,
    liveJournalFile: join(journalDir, "live.jsonl"),
    archiveDir,
    sessionsDir,
    dashboardRoot: join(root, "dist", "dashboard"),
    socketPath: join(revisDir, "daemon.sock"),
    workspaceRuntimeDir: (agentId) => join(revisDir, "workspaces", String(agentId)),
    workspaceRepoDir: (agentId) => join(revisDir, "workspaces", String(agentId), "repo"),
    workspaceLogFile: (agentId) => join(revisDir, "workspaces", String(agentId), "session.log"),
    workspaceExitFile: (agentId) => join(revisDir, "workspaces", String(agentId), "session.exit"),
    sessionDir: (sessionId) => join(sessionsDir, sessionId),
    sessionMetaFile: (sessionId) => join(sessionsDir, sessionId, "meta.json"),
    sessionEventsFile: (sessionId) => join(sessionsDir, sessionId, "events.jsonl"),
    workspaceStateFile: (agentId) => join(workspaceStateDir, `${String(agentId)}.json`)
  };
}

/** Build one deterministic project config for tests. */
export function makeConfig(
  overrides: Partial<RevisConfig> = {}
): RevisConfig {
  return RevisConfig.make({
    coordinationRemote: overrides.coordinationRemote ?? "revis-local",
    trunkBase: overrides.trunkBase ?? "main",
    remotePollSeconds: overrides.remotePollSeconds ?? 5,
    sandboxProvider: overrides.sandboxProvider ?? "local"
  });
}

/** Build one workspace spec with stable defaults. */
export function makeWorkspaceSpec(
  root: string,
  overrides: WorkspaceSpecOverrides = {}
): WorkspaceSpec {
  const agentId = overrides.agentId ?? asAgentId("agent-1");
  const operatorSlug = overrides.operatorSlug ?? asOperatorSlug("operator-1");
  const coordinationBranch =
    overrides.coordinationBranch ?? asBranchName(`revis/${operatorSlug}/${agentId}/work`);
  const localBranch = overrides.localBranch ?? coordinationBranch;

  return WorkspaceSpec.make({
    agentId,
    operatorSlug,
    coordinationBranch,
    localBranch,
    workspaceRoot: overrides.workspaceRoot ?? join(root, ".revis", "workspaces", agentId, "repo"),
    execCommand: overrides.execCommand ?? "echo test",
    sandboxProvider: overrides.sandboxProvider ?? "local",
    createdAt: asTimestamp(overrides.createdAt ?? "2026-03-18T00:00:00.000Z")
  });
}

/** Build one restart-pending snapshot for tests. */
export function makeRestartPendingSnapshot(
  root: string,
  overrides: WorkspaceSpecOverrides & TrackingOverrides = {}
): WorkspaceSnapshot {
  return WorkspaceSnapshot.make({
    spec: makeWorkspaceSpec(root, overrides),
    state: RestartPendingState.make({
      iteration: overrides.iteration ?? 0,
      lastCommitSha: overrides.lastCommitSha ?? asRevision("1111111111111111111111111111111111111111"),
      lastPushedSha: overrides.lastPushedSha,
      lastSeenRemoteSha: overrides.lastSeenRemoteSha,
      lastRebasedOntoSha:
        overrides.lastRebasedOntoSha ??
        overrides.lastCommitSha ??
        asRevision("1111111111111111111111111111111111111111"),
      lastExitCode: overrides.lastExitCode,
      lastExitedAt: overrides.lastExitedAt ? asTimestamp(overrides.lastExitedAt) : undefined
    })
  });
}

/** Build one running snapshot for tests. */
export function makeRunningSnapshot(
  root: string,
  overrides: WorkspaceSpecOverrides &
    TrackingOverrides & {
      readonly sessionId?: string;
      readonly startedAt?: string;
    } = {}
): WorkspaceSnapshot {
  return WorkspaceSnapshot.make({
    spec: makeWorkspaceSpec(root, overrides),
    state: RunningState.make({
      iteration: overrides.iteration ?? 1,
      sessionId: asWorkspaceSessionId(overrides.sessionId ?? "session-1"),
      startedAt: asTimestamp(overrides.startedAt ?? "2026-03-18T00:00:00.000Z"),
      lastCommitSha: overrides.lastCommitSha ?? asRevision("1111111111111111111111111111111111111111"),
      lastPushedSha: overrides.lastPushedSha,
      lastSeenRemoteSha: overrides.lastSeenRemoteSha,
      lastRebasedOntoSha:
        overrides.lastRebasedOntoSha ??
        overrides.lastCommitSha ??
        asRevision("1111111111111111111111111111111111111111"),
      lastExitCode: overrides.lastExitCode,
      lastExitedAt: overrides.lastExitedAt ? asTimestamp(overrides.lastExitedAt) : undefined
    })
  });
}

/** Build one daemon snapshot for tests. */
export function makeDaemonState(
  overrides: Partial<DaemonState> = {}
): DaemonState {
  return DaemonState.make({
    sandboxProvider: overrides.sandboxProvider ?? "local",
    syncTargetBranch: overrides.syncTargetBranch ?? asBranchName("revis/trunk"),
    startedAt: overrides.startedAt ?? asTimestamp("2026-03-18T00:00:00.000Z"),
    pid: overrides.pid ?? 12345,
    socketPath: overrides.socketPath ?? "/tmp/revis.sock",
    apiBaseUrl: overrides.apiBaseUrl ?? "http://127.0.0.1:4000",
    lastSyncTargetSha: overrides.lastSyncTargetSha,
    lastFetchAt: overrides.lastFetchAt,
    lastEventAt: overrides.lastEventAt,
    lastErrorTag: overrides.lastErrorTag,
    lastErrorMessage: overrides.lastErrorMessage
  });
}
