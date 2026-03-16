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

export type AgentState =
  | "starting"
  | "idle"
  | "active"
  | "stopping"
  | "stopped"
  | "failed";

export interface RevisConfig {
  coordinationRemote: string;
  trunkBase: string;
  remotePollSeconds: number;
}

export interface WorkspaceRecord {
  agentId: string;
  operatorSlug: string;
  coordinationBranch: string;
  localBranch: string;
  expectedPaneCommand?: string;
  repoPath: string;
  tmuxSession: string;
  state: AgentState;
  createdAt: string;
  attachCmd: string[];
  attachLabel: string;
  lastCommitSha?: string;
  lastRelayedSha?: string;
  lastPushedSha?: string;
  lastSeenRemoteSha?: string;
  lastRebasedOntoSha?: string;
  rebaseRequiredSha?: string;
  queuedSteeringMessages?: string[];
  lastError?: string;
}

export interface StatusWorkspaceRecord extends WorkspaceRecord {
  commitCount: number;
  lastCommitSubject: string;
  lastCommitShortSha: string;
}

export interface DaemonRecord {
  pid: number;
  socketPath: string;
  syncTargetBranch: string;
  startedAt: string;
  lastSyncTargetSha?: string;
  lastFetchAt?: string;
  lastEventAt?: string;
  lastError?: string;
}

export interface RelayRegistry {
  byBranch: Record<string, string>;
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
    | "workspace_started"
    | "daemon_started"
    | "daemon_stopped"
    | "commit_relayed"
    | "relay_received"
    | "branch_pushed"
    | "remote_branch_seen"
    | "workspace_rebased"
    | "workspace_rebase_pending"
    | "workspace_rebase_failed"
    | "promoted"
    | "workspace_stopped";
  agentId?: string;
  branch?: string;
  sha?: string;
  sourceAgentId?: string;
  sourceBranch?: string;
  destinationAgentId?: string;
  destinationBranch?: string;
  deliveryMode?: "typed" | "queued";
  summary: string;
  metadata?: JsonValue;
}

export interface PullRequestRef {
  number: number;
  url: string;
  title: string;
  created: boolean;
}

export interface CommitNotification {
  type?: "commit" | "sync" | "shutdown";
  agentId?: string;
  sha?: string;
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
