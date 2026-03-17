/** Shared data structures for the passive Revis CLI. */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

export type SandboxProvider = "local" | "daytona";

export type AgentState = "starting" | "active" | "failed" | "stopped";

export interface RevisConfig {
  coordinationRemote: string;
  trunkBase: string;
  remotePollSeconds: number;
  sandboxProvider: SandboxProvider;
}

export interface WorkspaceRecord {
  agentId: string;
  operatorSlug: string;
  coordinationBranch: string;
  localBranch: string;
  workspaceRoot: string;
  execCommand: string;
  sandboxProvider: SandboxProvider;
  state: AgentState;
  createdAt: string;
  attachCmd?: string[];
  attachLabel?: string;
  sandboxId?: string;
  currentSessionId?: string;
  iteration: number;
  lastStartedAt?: string;
  lastExitedAt?: string;
  lastExitCode?: number;
  lastCommitSha?: string;
  lastPushedSha?: string;
  lastSeenRemoteSha?: string;
  lastRebasedOntoSha?: string;
  rebaseRequiredSha?: string;
  lastError?: string;
}

export interface StatusWorkspaceRecord extends WorkspaceRecord {
  commitCount: number;
  lastCommitSubject: string;
  lastCommitShortSha: string;
}

export interface DaemonRecord {
  sandboxProvider: SandboxProvider;
  syncTargetBranch: string;
  startedAt: string;
  pid?: number;
  socketPath?: string;
  lastSyncTargetSha?: string;
  lastFetchAt?: string;
  lastEventAt?: string;
  lastError?: string;
}

export interface SessionParticipant {
  agentId: string;
  coordinationBranch: string;
  startedAt: string;
  stoppedAt: string | null;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  coordinationRemote: string;
  trunkBase: string;
  operatorSlug: string;
  participantCount: number;
}

export interface SessionMeta extends SessionSummary {
  participants: SessionParticipant[];
}

export interface RuntimeEvent {
  timestamp: string;
  type:
    | "workspace_created"
    | "iteration_started"
    | "iteration_exited"
    | "workspace_restarted"
    | "daemon_started"
    | "daemon_stopped"
    | "branch_pushed"
    | "remote_refs_fetched"
    | "workspace_rebased"
    | "workspace_rebase_pending"
    | "workspace_rebase_failed"
    | "promoted"
    | "workspace_stopped";
  agentId?: string;
  branch?: string;
  sha?: string;
  summary: string;
  metadata?: JsonValue;
}

export interface PullRequestRef {
  number: number;
  url: string;
  title: string;
  created: boolean;
}

export interface DaemonRequest {
  type?: "reconcile" | "shutdown";
  reason?: string;
}

export interface RemoteBranchHead {
  branch: string;
  sha: string;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  shortstat: string;
  branch: string;
  operatorSlug: string;
  agentId: string;
}
