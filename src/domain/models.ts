/** Schema-backed config, run, participant, and event models for the SDK-native Revis runtime. */

import { Schema } from "effect";

/** Build a one-line runtime decoder for branded scalar schemas. */
function decodeSync<A, I>(schema: Schema.Schema<A, I>) {
  return Schema.decodeUnknownSync(schema);
}

export const NonNegativeInt = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.pipe(Schema.greaterThan(0));

export const AgentId = Schema.String.pipe(
  Schema.pattern(/^agent-\d+$/),
  Schema.brand("AgentId")
);
export type AgentId = typeof AgentId.Type;
export const asAgentId = decodeSync(AgentId);

export const BranchName = Schema.NonEmptyString.pipe(Schema.brand("BranchName"));
export type BranchName = typeof BranchName.Type;
export const asBranchName = decodeSync(BranchName);

export const OperatorSlug = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.brand("OperatorSlug")
);
export type OperatorSlug = typeof OperatorSlug.Type;
export const asOperatorSlug = decodeSync(OperatorSlug);

export const Revision = Schema.NonEmptyString.pipe(Schema.brand("Revision"));
export type Revision = typeof Revision.Type;
export const asRevision = decodeSync(Revision);

export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;
export const asRunId = decodeSync(RunId);

export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;
export const asSessionId = decodeSync(SessionId);

export const SandboxId = Schema.NonEmptyString.pipe(Schema.brand("SandboxId"));
export type SandboxId = typeof SandboxId.Type;
export const asSandboxId = decodeSync(SandboxId);

export const Timestamp = Schema.NonEmptyString.pipe(Schema.brand("Timestamp"));
export type Timestamp = typeof Timestamp.Type;
export const asTimestamp = decodeSync(Timestamp);

export const SandboxKind = Schema.Literal("local", "daytona", "e2b", "docker");
export type SandboxKind = typeof SandboxKind.Type;

export const AgentKind = Schema.Literal("codex", "claude", "opencode");
export type AgentKind = typeof AgentKind.Type;

/** Persisted git defaults shared by every run created in one repository. */
export class GitConfig extends Schema.Class<GitConfig>("GitConfig")({
  remoteName: Schema.NonEmptyString,
  baseBranch: Schema.NonEmptyString,
  branchPrefix: Schema.NonEmptyString
}) {}

/** Local sandbox configuration. */
export class LocalSandboxConfig extends Schema.Class<LocalSandboxConfig>("LocalSandboxConfig")({
  kind: Schema.Literal("local"),
  env: Schema.Array(Schema.NonEmptyString)
}) {}

/** Daytona sandbox configuration. */
export class DaytonaSandboxConfig extends Schema.Class<DaytonaSandboxConfig>(
  "DaytonaSandboxConfig"
)({
  kind: Schema.Literal("daytona"),
  env: Schema.Array(Schema.NonEmptyString)
}) {}

/** E2B sandbox configuration. */
export class E2BSandboxConfig extends Schema.Class<E2BSandboxConfig>("E2BSandboxConfig")({
  kind: Schema.Literal("e2b"),
  env: Schema.Array(Schema.NonEmptyString)
}) {}

/** Docker sandbox configuration. */
export class DockerSandboxConfig extends Schema.Class<DockerSandboxConfig>("DockerSandboxConfig")(
  {
    kind: Schema.Literal("docker"),
    env: Schema.Array(Schema.NonEmptyString),
    image: Schema.NonEmptyString
  }
) {}

export const SandboxConfigSchema = Schema.Union(
  LocalSandboxConfig,
  DaytonaSandboxConfig,
  E2BSandboxConfig,
  DockerSandboxConfig
);
export type SandboxConfig = typeof SandboxConfigSchema.Type;

/** Codex default profile used for new sessions. */
export class CodexAgentConfig extends Schema.Class<CodexAgentConfig>("CodexAgentConfig")({
  kind: Schema.Literal("codex"),
  model: Schema.NonEmptyString,
  mode: Schema.Literal("read-only", "auto", "full-access"),
  thoughtLevel: Schema.Literal("low", "medium", "high", "xhigh")
}) {}

/** Claude default profile used for new sessions. */
export class ClaudeAgentConfig extends Schema.Class<ClaudeAgentConfig>("ClaudeAgentConfig")({
  kind: Schema.Literal("claude"),
  model: Schema.Literal("default", "sonnet", "opus", "haiku"),
  mode: Schema.Literal("default", "acceptEdits", "plan", "dontAsk", "bypassPermissions")
}) {}

/** OpenCode default profile used for new sessions. */
export class OpenCodeAgentConfig extends Schema.Class<OpenCodeAgentConfig>(
  "OpenCodeAgentConfig"
)({
  kind: Schema.Literal("opencode"),
  model: Schema.NonEmptyString,
  mode: Schema.Literal("build", "plan")
}) {}

export const AgentConfigSchema = Schema.Union(
  CodexAgentConfig,
  ClaudeAgentConfig,
  OpenCodeAgentConfig
);
export type AgentConfig = typeof AgentConfigSchema.Type;

/** Fixed coordination policy for the first SDK-native runtime. */
export class CoordinationConfig extends Schema.Class<CoordinationConfig>("CoordinationConfig")({
  relayPolicy: Schema.Literal("completed_turn"),
  maxRelayChars: PositiveInt,
  maxQueuedRelaysPerAgent: PositiveInt
}) {}

/** Root Revis config stored under `.revis/config.json`. */
export class RevisConfig extends Schema.Class<RevisConfig>("RevisConfig")({
  version: Schema.Literal(2),
  git: GitConfig,
  sandbox: SandboxConfigSchema,
  agent: AgentConfigSchema,
  coordination: CoordinationConfig
}) {}

/** One active or archived run owned by the current repository. */
export class RunRecord extends Schema.Class<RunRecord>("RunRecord")({
  id: RunId,
  root: Schema.NonEmptyString,
  operatorSlug: OperatorSlug,
  task: Schema.NonEmptyString,
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
  config: RevisConfig
}) {}

/** Initial task prompt queued for one participant. */
export class TaskPrompt extends Schema.TaggedClass<TaskPrompt>()("TaskPrompt", {
  summary: Schema.NonEmptyString,
  text: Schema.NonEmptyString
}) {}

/** Coordination relay queued for one participant. */
export class RelayPrompt extends Schema.TaggedClass<RelayPrompt>()("RelayPrompt", {
  sourceAgentId: AgentId,
  summary: Schema.NonEmptyString,
  text: Schema.NonEmptyString
}) {}

/** Queue contents for one participant. */
export const PendingPromptSchema = Schema.Union(TaskPrompt, RelayPrompt);
export type PendingPrompt = typeof PendingPromptSchema.Type;

/** Shared fields carried by every participant state. */
const ParticipantFields = {
  runId: RunId,
  agentId: AgentId,
  branch: BranchName,
  workspaceRoot: Schema.NonEmptyString,
  sandboxId: Schema.NullOr(SandboxId),
  sessionId: Schema.NullOr(SessionId),
  lastEventIndex: NonNegativeInt,
  lastHeadSha: Schema.NullOr(Revision),
  lastPushedSha: Schema.NullOr(Revision),
  lastAssistantMessage: Schema.NullOr(Schema.String),
  pendingPrompts: Schema.Array(PendingPromptSchema),
  updatedAt: Timestamp
} as const;

/** Participant is being provisioned and has not started a session yet. */
export class CreatingParticipant extends Schema.TaggedClass<CreatingParticipant>()(
  "CreatingParticipant",
  ParticipantFields
) {}

/** Participant is currently waiting on an in-flight prompt. */
export class PromptingParticipant extends Schema.TaggedClass<PromptingParticipant>()(
  "PromptingParticipant",
  {
    ...ParticipantFields,
    promptSummary: Schema.NonEmptyString
  }
) {}

/** Participant is ready to accept another relay. */
export class IdleParticipant extends Schema.TaggedClass<IdleParticipant>()(
  "IdleParticipant",
  ParticipantFields
) {}

/** Participant is blocked on an SDK question request. */
export class BlockedParticipant extends Schema.TaggedClass<BlockedParticipant>()(
  "BlockedParticipant",
  {
    ...ParticipantFields,
    questionId: Schema.NonEmptyString,
    questionPrompt: Schema.NonEmptyString,
    questionOptions: Schema.Array(Schema.NonEmptyString)
  }
) {}

/** Participant was intentionally stopped. */
export class StoppedParticipant extends Schema.TaggedClass<StoppedParticipant>()(
  "StoppedParticipant",
  {
    ...ParticipantFields,
    stoppedAt: Timestamp
  }
) {}

/** Participant hit an unrecoverable runtime failure. */
export class FailedParticipant extends Schema.TaggedClass<FailedParticipant>()(
  "FailedParticipant",
  {
    ...ParticipantFields,
    detail: Schema.NonEmptyString
  }
) {}

/** Full persisted participant state machine. */
export const ParticipantRecordSchema = Schema.Union(
  CreatingParticipant,
  PromptingParticipant,
  IdleParticipant,
  BlockedParticipant,
  StoppedParticipant,
  FailedParticipant
);
export type ParticipantRecord = typeof ParticipantRecordSchema.Type;

/** Shared fields carried by every high-level Revis event. */
const RevisEventBase = {
  timestamp: Timestamp,
  runId: RunId,
  summary: Schema.NonEmptyString
} as const;

/** Run lifecycle event. */
export class RunStarted extends Schema.TaggedClass<RunStarted>()("RunStarted", RevisEventBase) {}

/** Participant lifecycle event. */
export class ParticipantCreated extends Schema.TaggedClass<ParticipantCreated>()(
  "ParticipantCreated",
  {
    ...RevisEventBase,
    agentId: AgentId,
    branch: BranchName
  }
) {}

/** Prompt dispatch event. */
export class PromptStarted extends Schema.TaggedClass<PromptStarted>()("PromptStarted", {
  ...RevisEventBase,
  agentId: AgentId
}) {}

/** Completed-turn projection recorded after substantive agent output. */
export class TurnCompleted extends Schema.TaggedClass<TurnCompleted>()("TurnCompleted", {
  ...RevisEventBase,
  agentId: AgentId
}) {}

/** Relay event recorded when one participant nudges another. */
export class RelayDelivered extends Schema.TaggedClass<RelayDelivered>()("RelayDelivered", {
  ...RevisEventBase,
  sourceAgentId: AgentId,
  targetAgentId: AgentId
}) {}

/** Git publication event for one participant branch. */
export class BranchPushed extends Schema.TaggedClass<BranchPushed>()("BranchPushed", {
  ...RevisEventBase,
  agentId: AgentId,
  branch: BranchName,
  sha: Revision
}) {}

/** Blocking question event. */
export class ParticipantBlocked extends Schema.TaggedClass<ParticipantBlocked>()(
  "ParticipantBlocked",
  {
    ...RevisEventBase,
    agentId: AgentId
  }
) {}

/** Promotion event. */
export class Promoted extends Schema.TaggedClass<Promoted>()("Promoted", {
  ...RevisEventBase,
  agentId: AgentId,
  branch: BranchName,
  pullRequestUrl: Schema.NullOr(Schema.NonEmptyString)
}) {}

/** Participant stopped event. */
export class ParticipantStopped extends Schema.TaggedClass<ParticipantStopped>()(
  "ParticipantStopped",
  {
    ...RevisEventBase,
    agentId: AgentId
  }
) {}

/** Participant failure event. */
export class ParticipantFailed extends Schema.TaggedClass<ParticipantFailed>()(
  "ParticipantFailed",
  {
    ...RevisEventBase,
    agentId: AgentId
  }
) {}

/** Run stop event. */
export class RunStopped extends Schema.TaggedClass<RunStopped>()("RunStopped", RevisEventBase) {}

/** Full persisted Revis event stream. */
export const RevisEventSchema = Schema.Union(
  RunStarted,
  ParticipantCreated,
  PromptStarted,
  TurnCompleted,
  RelayDelivered,
  BranchPushed,
  ParticipantBlocked,
  Promoted,
  ParticipantStopped,
  ParticipantFailed,
  RunStopped
);
export type RevisEvent = typeof RevisEventSchema.Type;

/** Return whether the participant is still expected to make progress. */
export function participantIsActive(participant: ParticipantRecord): boolean {
  switch (participant._tag) {
    case "CreatingParticipant":
    case "PromptingParticipant":
    case "IdleParticipant":
    case "BlockedParticipant":
      return true;
    case "StoppedParticipant":
    case "FailedParticipant":
      return false;
  }
}

/** Return whether the participant can accept another prompt immediately. */
export function participantIsIdle(participant: ParticipantRecord): participant is IdleParticipant {
  return participant._tag === "IdleParticipant";
}

/** Return the effective inspector URL for one connected sandbox. */
export function sandboxInspectorUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/ui/`;
}
