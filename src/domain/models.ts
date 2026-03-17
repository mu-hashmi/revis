/** Effect-native domain models for Revis configuration, state, events, and APIs. */

import * as Schema from "effect/Schema";

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

export class RevisConfig extends Schema.Class<RevisConfig>("RevisConfig")({
  coordinationRemote: Schema.NonEmptyString,
  trunkBase: Schema.NonEmptyString,
  remotePollSeconds: Schema.Int.pipe(Schema.greaterThan(0)),
  sandboxProvider: SandboxProvider
}) {}

const TrackingFields = {
  iteration: NonNegativeInt,
  lastCommitSha: Schema.optional(Revision),
  lastPushedSha: Schema.optional(Revision),
  lastSeenRemoteSha: Schema.optional(Revision),
  lastRebasedOntoSha: Schema.optional(Revision),
  lastExitCode: Schema.optional(Schema.Int),
  lastExitedAt: Schema.optional(Timestamp)
} as const;

export class ProvisioningState extends Schema.TaggedClass<ProvisioningState>()(
  "Provisioning",
  TrackingFields
) {}

export class RunningState extends Schema.TaggedClass<RunningState>()("Running", {
  ...TrackingFields,
  sessionId: WorkspaceSessionId,
  startedAt: Timestamp
}) {}

export class RestartPendingState extends Schema.TaggedClass<RestartPendingState>()(
  "RestartPending",
  TrackingFields
) {}

export class AwaitingRebaseState extends Schema.TaggedClass<AwaitingRebaseState>()(
  "AwaitingRebase",
  {
    ...TrackingFields,
    requiredTarget: Revision,
    detail: Schema.NonEmptyString
  }
) {}

export class RebaseConflictState extends Schema.TaggedClass<RebaseConflictState>()(
  "RebaseConflict",
  {
    ...TrackingFields,
    requiredTarget: Revision,
    detail: Schema.NonEmptyString
  }
) {}

export class ProviderFailedState extends Schema.TaggedClass<ProviderFailedState>()(
  "ProviderFailed",
  {
    ...TrackingFields,
    detail: Schema.NonEmptyString
  }
) {}

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

export class WorkspaceSnapshot extends Schema.Class<WorkspaceSnapshot>("WorkspaceSnapshot")({
  spec: WorkspaceSpec,
  state: WorkspaceStateSchema
}) {
  get agentId(): AgentId {
    return this.spec.agentId;
  }
}

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

export class SessionParticipant extends Schema.Class<SessionParticipant>("SessionParticipant")({
  agentId: AgentId,
  coordinationBranch: BranchName,
  startedAt: Timestamp,
  stoppedAt: Schema.NullOr(Timestamp)
}) {}

export class SessionSummary extends Schema.Class<SessionSummary>("SessionSummary")({
  id: SessionId,
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
  coordinationRemote: Schema.NonEmptyString,
  trunkBase: Schema.NonEmptyString,
  operatorSlug: OperatorSlug,
  participantCount: NonNegativeInt
}) {}

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

const EventBaseFields = {
  timestamp: Timestamp,
  summary: Schema.NonEmptyString
} as const;

const EventWithWorkspaceFields = {
  ...EventBaseFields,
  agentId: AgentId,
  branch: BranchName
} as const;

export class WorkspaceProvisioned extends Schema.TaggedClass<WorkspaceProvisioned>()(
  "WorkspaceProvisioned",
  EventWithWorkspaceFields
) {}

export class IterationStarted extends Schema.TaggedClass<IterationStarted>()(
  "IterationStarted",
  EventWithWorkspaceFields
) {}

export class IterationExited extends Schema.TaggedClass<IterationExited>()("IterationExited", {
  ...EventWithWorkspaceFields,
  exitCode: Schema.optional(Schema.Int)
}) {}

export class WorkspaceRestarted extends Schema.TaggedClass<WorkspaceRestarted>()(
  "WorkspaceRestarted",
  EventWithWorkspaceFields
) {}

export class DaemonStarted extends Schema.TaggedClass<DaemonStarted>()(
  "DaemonStarted",
  EventBaseFields
) {}

export class DaemonStopped extends Schema.TaggedClass<DaemonStopped>()(
  "DaemonStopped",
  EventBaseFields
) {}

export class BranchPublished extends Schema.TaggedClass<BranchPublished>()("BranchPublished", {
  ...EventWithWorkspaceFields,
  sha: Revision
}) {}

export class RemoteSynced extends Schema.TaggedClass<RemoteSynced>()("RemoteSynced", {
  ...EventBaseFields,
  reason: Schema.NonEmptyString
}) {}

export class WorkspaceRebased extends Schema.TaggedClass<WorkspaceRebased>()(
  "WorkspaceRebased",
  {
    ...EventWithWorkspaceFields,
    target: Revision
  }
) {}

export class WorkspaceRebaseAwaiting extends Schema.TaggedClass<WorkspaceRebaseAwaiting>()(
  "WorkspaceRebaseAwaiting",
  {
    ...EventWithWorkspaceFields,
    target: Revision
  }
) {}

export class WorkspaceRebaseFailed extends Schema.TaggedClass<WorkspaceRebaseFailed>()(
  "WorkspaceRebaseFailed",
  {
    ...EventWithWorkspaceFields,
    target: Revision,
    detail: Schema.NonEmptyString
  }
) {}

export class WorkspaceStopped extends Schema.TaggedClass<WorkspaceStopped>()(
  "WorkspaceStopped",
  EventWithWorkspaceFields
) {}

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

export class PullRequestRef extends Schema.Class<PullRequestRef>("PullRequestRef")({
  number: Schema.Int.pipe(Schema.greaterThan(0)),
  url: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  created: Schema.Boolean
}) {}

export class RemoteBranchHead extends Schema.Class<RemoteBranchHead>("RemoteBranchHead")({
  branch: BranchName,
  sha: Revision
}) {}

export class CommitSummary extends Schema.Class<CommitSummary>("CommitSummary")({
  sha: Revision,
  shortSha: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  shortstat: Schema.NonEmptyString,
  branch: BranchName,
  operatorSlug: OperatorSlug,
  agentId: AgentId
}) {}

export class ReconcileDaemonRequest extends Schema.TaggedClass<ReconcileDaemonRequest>()(
  "ReconcileDaemonRequest",
  {
    requestId: RequestId,
    reason: Schema.NonEmptyString
  }
) {}

export class StopWorkspacesDaemonRequest extends Schema.TaggedClass<StopWorkspacesDaemonRequest>()(
  "StopWorkspacesDaemonRequest",
  {
    requestId: RequestId,
    stopAll: Schema.Boolean,
    agentIds: Schema.Array(AgentId)
  }
) {}

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

export class DaemonResponse extends Schema.Class<DaemonResponse>("DaemonResponse")({
  requestId: RequestId,
  accepted: Schema.Boolean,
  message: Schema.NonEmptyString
}) {}

export class StatusWorkspace extends Schema.Class<StatusWorkspace>("StatusWorkspace")({
  snapshot: WorkspaceSnapshot,
  aheadCount: NonNegativeInt,
  lastCommitSubject: Schema.String
}) {}

export class StatusSnapshot extends Schema.Class<StatusSnapshot>("StatusSnapshot")({
  root: Schema.NonEmptyString,
  config: RevisConfig,
  operatorSlug: OperatorSlug,
  syncBranch: BranchName,
  daemon: Schema.NullOr(DaemonState),
  workspaces: Schema.Array(StatusWorkspace),
  events: Schema.Array(RuntimeEventSchema)
}) {}

export function workspaceStateTag(state: WorkspaceState): string {
  return state._tag;
}

export function workspaceIteration(snapshot: WorkspaceSnapshot): number {
  return snapshot.state.iteration;
}

export function workspaceCurrentSessionId(
  snapshot: WorkspaceSnapshot
): WorkspaceSessionId | undefined {
  return snapshot.state._tag === "Running" ? snapshot.state.sessionId : undefined;
}

export function workspaceLastCommitSha(
  snapshot: WorkspaceSnapshot
): Revision | undefined {
  return snapshot.state.lastCommitSha;
}

export function workspaceLastPushedSha(
  snapshot: WorkspaceSnapshot
): Revision | undefined {
  return snapshot.state.lastPushedSha;
}

export function workspaceLastSeenRemoteSha(
  snapshot: WorkspaceSnapshot
): Revision | undefined {
  return snapshot.state.lastSeenRemoteSha;
}

export function workspaceLastRebasedOntoSha(
  snapshot: WorkspaceSnapshot
): Revision | undefined {
  return snapshot.state.lastRebasedOntoSha;
}

export function statusWorkspaceStateName(workspace: StatusWorkspace): string {
  return workspace.snapshot.state._tag;
}
