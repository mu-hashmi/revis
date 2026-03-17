/** Effect-native domain models for Revis configuration, state, events, and APIs. */

import * as Schema from "effect/Schema";

// Primitive branded identifiers and scalar schemas.
export const NonNegativeInt = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0));

export const AgentId = Schema.String.pipe(
  Schema.pattern(/^agent-\d+$/),
  Schema.brand("AgentId")
);
export type AgentId = typeof AgentId.Type;
export const asAgentId = (value: string): AgentId => value as AgentId;

export const OperatorSlug = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.brand("OperatorSlug")
);
export type OperatorSlug = typeof OperatorSlug.Type;
export const asOperatorSlug = (value: string): OperatorSlug => value as OperatorSlug;

export const RequestId = Schema.NonEmptyString.pipe(Schema.brand("RequestId"));
export type RequestId = typeof RequestId.Type;
export const asRequestId = (value: string): RequestId => value as RequestId;

export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;
export const asSessionId = (value: string): SessionId => value as SessionId;

export const WorkspaceSessionId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkspaceSessionId")
);
export type WorkspaceSessionId = typeof WorkspaceSessionId.Type;
export const asWorkspaceSessionId = (value: string): WorkspaceSessionId =>
  value as WorkspaceSessionId;

export const Timestamp = Schema.NonEmptyString.pipe(Schema.brand("Timestamp"));
export type Timestamp = typeof Timestamp.Type;
export const asTimestamp = (value: string): Timestamp => value as Timestamp;

export const Revision = Schema.NonEmptyString.pipe(Schema.brand("Revision"));
export type Revision = typeof Revision.Type;
export const asRevision = (value: string): Revision => value as Revision;

export const BranchName = Schema.NonEmptyString.pipe(Schema.brand("BranchName"));
export type BranchName = typeof BranchName.Type;
export const asBranchName = (value: string): BranchName => value as BranchName;

export const SandboxProvider = Schema.Literal("local", "daytona");
export type SandboxProvider = typeof SandboxProvider.Type;

/** Persisted project configuration stored under `.revis/config.json`. */
export class RevisConfig extends Schema.Class<RevisConfig>("RevisConfig")({
  coordinationRemote: Schema.NonEmptyString,
  trunkBase: Schema.NonEmptyString,
  remotePollSeconds: Schema.Int.pipe(Schema.greaterThan(0)),
  sandboxProvider: SandboxProvider
}) {}

// Persisted workspace lifecycle records.
// Every workspace lifecycle variant carries the same tracking block so transitions preserve git
// and iteration facts without falling back to one mutable mega-record.
const TrackingFields = {
  iteration: NonNegativeInt,
  lastCommitSha: Schema.optional(Revision),
  lastPushedSha: Schema.optional(Revision),
  lastSeenRemoteSha: Schema.optional(Revision),
  lastRebasedOntoSha: Schema.optional(Revision),
  lastExitCode: Schema.optional(Schema.Int),
  lastExitedAt: Schema.optional(Timestamp)
} as const;

/** Workspace state used while a provider is still provisioning runtime resources. */
export class ProvisioningState extends Schema.TaggedClass<ProvisioningState>()(
  "Provisioning",
  TrackingFields
) {}

/** Workspace state for an actively running agent iteration. */
export class RunningState extends Schema.TaggedClass<RunningState>()("Running", {
  ...TrackingFields,
  sessionId: WorkspaceSessionId,
  startedAt: Timestamp
}) {}

/** Workspace state for a clean checkout waiting to start or restart an iteration. */
export class RestartPendingState extends Schema.TaggedClass<RestartPendingState>()(
  "RestartPending",
  TrackingFields
) {}

/** Workspace state for a dirty checkout that must be manually rebased first. */
export class AwaitingRebaseState extends Schema.TaggedClass<AwaitingRebaseState>()(
  "AwaitingRebase",
  {
    ...TrackingFields,
    requiredTarget: Revision,
    detail: Schema.NonEmptyString
  }
) {}

/** Workspace state for a failed automatic rebase that needs operator intervention. */
export class RebaseConflictState extends Schema.TaggedClass<RebaseConflictState>()(
  "RebaseConflict",
  {
    ...TrackingFields,
    requiredTarget: Revision,
    detail: Schema.NonEmptyString
  }
) {}

/** Workspace state used when provider operations fail during supervision. */
export class ProviderFailedState extends Schema.TaggedClass<ProviderFailedState>()(
  "ProviderFailed",
  {
    ...TrackingFields,
    detail: Schema.NonEmptyString
  }
) {}

/** Workspace state recorded after a workspace has been intentionally removed. */
export class StoppedState extends Schema.TaggedClass<StoppedState>()("Stopped", TrackingFields) {}

export const WorkspaceStateSchema = Schema.Union(
  ProvisioningState,
  RunningState,
  RestartPendingState,
  AwaitingRebaseState,
  RebaseConflictState,
  ProviderFailedState,
  StoppedState
);
export type WorkspaceState = typeof WorkspaceStateSchema.Type;

/** Immutable workspace identity and provisioned runtime metadata. */
export class WorkspaceSpec extends Schema.Class<WorkspaceSpec>("WorkspaceSpec")({
  agentId: AgentId,
  operatorSlug: OperatorSlug,
  coordinationBranch: BranchName,
  localBranch: BranchName,
  workspaceRoot: Schema.NonEmptyString,
  execCommand: Schema.NonEmptyString,
  sandboxProvider: SandboxProvider,
  createdAt: Timestamp,
  attachCmd: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  attachLabel: Schema.optional(Schema.NonEmptyString),
  sandboxId: Schema.optional(Schema.NonEmptyString)
}) {}

/** Full persisted workspace record combining stable spec and current lifecycle state. */
export class WorkspaceSnapshot extends Schema.Class<WorkspaceSnapshot>("WorkspaceSnapshot")({
  spec: WorkspaceSpec,
  state: WorkspaceStateSchema
}) {
  get agentId(): AgentId {
    return this.spec.agentId;
  }
}

/** Persisted daemon liveness and reconcile metadata for operator tooling. */
export class DaemonState extends Schema.Class<DaemonState>("DaemonState")({
  sandboxProvider: SandboxProvider,
  syncTargetBranch: BranchName,
  startedAt: Timestamp,
  pid: Schema.Int.pipe(Schema.greaterThan(0)),
  socketPath: Schema.NonEmptyString,
  apiBaseUrl: Schema.NonEmptyString,
  lastSyncTargetSha: Schema.optional(Revision),
  lastFetchAt: Schema.optional(Timestamp),
  lastEventAt: Schema.optional(Timestamp),
  lastErrorTag: Schema.optional(Schema.NonEmptyString),
  lastErrorMessage: Schema.optional(Schema.NonEmptyString)
}) {}

/** One workspace participant tracked inside a daemon session archive. */
export class SessionParticipant extends Schema.Class<SessionParticipant>("SessionParticipant")({
  agentId: AgentId,
  coordinationBranch: BranchName,
  startedAt: Timestamp,
  stoppedAt: Schema.NullOr(Timestamp)
}) {}

/** Lightweight archive index entry for one recorded daemon session. */
export class SessionSummary extends Schema.Class<SessionSummary>("SessionSummary")({
  id: SessionId,
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
  coordinationRemote: Schema.NonEmptyString,
  trunkBase: Schema.NonEmptyString,
  operatorSlug: OperatorSlug,
  participantCount: NonNegativeInt
}) {}

/** Full archive metadata for one daemon session and its participating workspaces. */
export class SessionMeta extends Schema.Class<SessionMeta>("SessionMeta")({
  id: SessionId,
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
  coordinationRemote: Schema.NonEmptyString,
  trunkBase: Schema.NonEmptyString,
  operatorSlug: OperatorSlug,
  participants: Schema.Array(SessionParticipant),
  participantCount: NonNegativeInt
}) {}

// Runtime event schemas.
const EventBaseFields = {
  timestamp: Timestamp,
  summary: Schema.NonEmptyString
} as const;

// Reuse shared field blocks so the event union stays structurally consistent across persistence,
// CLI rendering, and dashboard consumers.
const EventWithWorkspaceFields = {
  ...EventBaseFields,
  agentId: AgentId,
  branch: BranchName
} as const;

/** Event emitted when a new workspace has been provisioned and registered. */
export class WorkspaceProvisioned extends Schema.TaggedClass<WorkspaceProvisioned>()(
  "WorkspaceProvisioned",
  EventWithWorkspaceFields
) {}

/** Event emitted when a workspace iteration starts running. */
export class IterationStarted extends Schema.TaggedClass<IterationStarted>()(
  "IterationStarted",
  EventWithWorkspaceFields
) {}

/** Event emitted when a workspace iteration exits. */
export class IterationExited extends Schema.TaggedClass<IterationExited>()("IterationExited", {
  ...EventWithWorkspaceFields,
  exitCode: Schema.optional(Schema.Int)
}) {}

/** Event emitted when the daemon restarts a workspace iteration. */
export class WorkspaceRestarted extends Schema.TaggedClass<WorkspaceRestarted>()(
  "WorkspaceRestarted",
  EventWithWorkspaceFields
) {}

/** Event emitted when the daemon process finishes startup. */
export class DaemonStarted extends Schema.TaggedClass<DaemonStarted>()(
  "DaemonStarted",
  EventBaseFields
) {}

/** Event emitted when the daemon begins shutting down. */
export class DaemonStopped extends Schema.TaggedClass<DaemonStopped>()(
  "DaemonStopped",
  EventBaseFields
) {}

/** Event emitted when a workspace HEAD is published to its coordination branch. */
export class BranchPublished extends Schema.TaggedClass<BranchPublished>()("BranchPublished", {
  ...EventWithWorkspaceFields,
  sha: Revision
}) {}

/** Event emitted after the daemon refreshes the shared remote sync target. */
export class RemoteSynced extends Schema.TaggedClass<RemoteSynced>()("RemoteSynced", {
  ...EventBaseFields,
  reason: Schema.NonEmptyString
}) {}

/** Event emitted after a workspace rebases onto the latest sync target. */
export class WorkspaceRebased extends Schema.TaggedClass<WorkspaceRebased>()(
  "WorkspaceRebased",
  {
    ...EventWithWorkspaceFields,
    target: Revision
  }
) {}

/** Event emitted when a workspace cannot rebase because it has local changes. */
export class WorkspaceRebaseAwaiting extends Schema.TaggedClass<WorkspaceRebaseAwaiting>()(
  "WorkspaceRebaseAwaiting",
  {
    ...EventWithWorkspaceFields,
    target: Revision
  }
) {}

/** Event emitted when an automatic workspace rebase hits a conflict. */
export class WorkspaceRebaseFailed extends Schema.TaggedClass<WorkspaceRebaseFailed>()(
  "WorkspaceRebaseFailed",
  {
    ...EventWithWorkspaceFields,
    target: Revision,
    detail: Schema.NonEmptyString
  }
) {}

/** Event emitted when a workspace is intentionally stopped and removed. */
export class WorkspaceStopped extends Schema.TaggedClass<WorkspaceStopped>()(
  "WorkspaceStopped",
  EventWithWorkspaceFields
) {}

/** Event emitted when one workspace is promoted by an operator. */
export class Promoted extends Schema.TaggedClass<Promoted>()("Promoted", {
  ...EventWithWorkspaceFields,
  mode: Schema.Literal("local", "pull_request")
}) {}

export const RuntimeEventSchema = Schema.Union(
  WorkspaceProvisioned,
  IterationStarted,
  IterationExited,
  WorkspaceRestarted,
  DaemonStarted,
  DaemonStopped,
  BranchPublished,
  RemoteSynced,
  WorkspaceRebased,
  WorkspaceRebaseAwaiting,
  WorkspaceRebaseFailed,
  WorkspaceStopped,
  Promoted
);
export type RuntimeEvent = typeof RuntimeEventSchema.Type;

/** Pull-request metadata returned from GitHub-backed promotion flows. */
export class PullRequestRef extends Schema.Class<PullRequestRef>("PullRequestRef")({
  number: Schema.Int.pipe(Schema.greaterThan(0)),
  url: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  created: Schema.Boolean
}) {}

/** One remote branch head discovered during host-side git inspection. */
export class RemoteBranchHead extends Schema.Class<RemoteBranchHead>("RemoteBranchHead")({
  branch: BranchName,
  sha: Revision
}) {}

/** Operator-facing commit summary derived from one workspace branch head. */
export class CommitSummary extends Schema.Class<CommitSummary>("CommitSummary")({
  sha: Revision,
  shortSha: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  shortstat: Schema.NonEmptyString,
  branch: BranchName,
  operatorSlug: OperatorSlug,
  agentId: AgentId
}) {}

// Daemon transport and status API payloads.
/** Request payload for interactive daemon reconcile operations. */
export class ReconcileDaemonRequest extends Schema.TaggedClass<ReconcileDaemonRequest>()(
  "ReconcileDaemonRequest",
  {
    requestId: RequestId,
    reason: Schema.NonEmptyString
  }
) {}

/** Request payload for stopping one or more tracked workspaces. */
export class StopWorkspacesDaemonRequest extends Schema.TaggedClass<StopWorkspacesDaemonRequest>()(
  "StopWorkspacesDaemonRequest",
  {
    requestId: RequestId,
    stopAll: Schema.Boolean,
    agentIds: Schema.Array(AgentId)
  }
) {}

/** Request payload for shutting the daemon down. */
export class ShutdownDaemonRequest extends Schema.TaggedClass<ShutdownDaemonRequest>()(
  "ShutdownDaemonRequest",
  {
    requestId: RequestId,
    reason: Schema.NonEmptyString
  }
) {}

export const DaemonRequestSchema = Schema.Union(
  ReconcileDaemonRequest,
  StopWorkspacesDaemonRequest,
  ShutdownDaemonRequest
);
export type DaemonRequest = typeof DaemonRequestSchema.Type;

/** Generic daemon API acknowledgement payload. */
export class DaemonResponse extends Schema.Class<DaemonResponse>("DaemonResponse")({
  requestId: RequestId,
  accepted: Schema.Boolean,
  message: Schema.NonEmptyString
}) {}

/** One workspace row in the operator-facing status snapshot. */
export class StatusWorkspace extends Schema.Class<StatusWorkspace>("StatusWorkspace")({
  snapshot: WorkspaceSnapshot,
  aheadCount: NonNegativeInt,
  lastCommitSubject: Schema.String
}) {}

/** Full operator-facing status payload served by the daemon and CLI. */
export class StatusSnapshot extends Schema.Class<StatusSnapshot>("StatusSnapshot")({
  root: Schema.NonEmptyString,
  config: RevisConfig,
  operatorSlug: OperatorSlug,
  syncBranch: BranchName,
  daemon: Schema.NullOr(DaemonState),
  workspaces: Schema.Array(StatusWorkspace),
  events: Schema.Array(RuntimeEventSchema)
}) {}

/** Return the discriminant tag for one workspace lifecycle state. */
export function workspaceStateTag(state: WorkspaceState): string {
  return state._tag;
}

/** Return the current iteration counter for one workspace snapshot. */
export function workspaceIteration(snapshot: WorkspaceSnapshot): number {
  return snapshot.state.iteration;
}

/** Return the current provider session id when the workspace is running. */
export function workspaceCurrentSessionId(
  snapshot: WorkspaceSnapshot
): WorkspaceSessionId | undefined {
  return snapshot.state._tag === "Running" ? snapshot.state.sessionId : undefined;
}

/** Return the latest known workspace HEAD revision, if any. */
export function workspaceLastCommitSha(
  snapshot: WorkspaceSnapshot
): Revision | undefined {
  return snapshot.state.lastCommitSha;
}

/** Return the latest revision published to the coordination branch, if any. */
export function workspaceLastPushedSha(
  snapshot: WorkspaceSnapshot
): Revision | undefined {
  return snapshot.state.lastPushedSha;
}

/** Return the latest remote sync target observed by this workspace, if any. */
export function workspaceLastSeenRemoteSha(
  snapshot: WorkspaceSnapshot
): Revision | undefined {
  return snapshot.state.lastSeenRemoteSha;
}

/** Return the remote revision this workspace last rebased onto, if any. */
export function workspaceLastRebasedOntoSha(
  snapshot: WorkspaceSnapshot
): Revision | undefined {
  return snapshot.state.lastRebasedOntoSha;
}

/** Return the display name for one status row's current lifecycle state. */
export function statusWorkspaceStateName(workspace: StatusWorkspace): string {
  return workspace.snapshot.state._tag;
}
