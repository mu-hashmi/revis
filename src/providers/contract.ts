/** Workspace runtime boundary for local and Daytona-backed sandboxes. */

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProviderError } from "../domain/errors";
import type {
  AgentId,
  BranchName,
  OperatorSlug,
  Revision,
  SandboxProvider,
  WorkspaceSessionId,
  WorkspaceSnapshot
} from "../domain/models";
import type {
  CommandFailure,
  CompletedCommand,
  RunCommandOptions
} from "../platform/process";
import type { HostGitError } from "../git/host-git";

export interface WorkspaceSessionStatus {
  readonly phase: "running" | "exited" | "missing";
  readonly exitCode?: number;
}

export interface ProvisionWorkspaceParams {
  readonly root: string;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly syncBranch: BranchName;
  readonly operatorSlug: OperatorSlug;
  readonly agentId: AgentId;
  readonly coordinationBranch: BranchName;
  readonly execCommand: string;
}

export interface ProvisionedWorkspace {
  readonly workspaceRoot: string;
  readonly localBranch: BranchName;
  readonly head: Revision;
  readonly attachCmd?: ReadonlyArray<string>;
  readonly attachLabel?: string;
  readonly sandboxId?: string;
}

export interface WorkspaceProviderApi {
  readonly kind: SandboxProvider;
  readonly provision: (
    params: ProvisionWorkspaceParams
  ) => Effect.Effect<ProvisionedWorkspace, HostGitError | ProviderError>;
  readonly startIteration: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<WorkspaceSessionId, ProviderError>;
  readonly inspectSession: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<WorkspaceSessionStatus, ProviderError>;
  readonly captureActivity: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<ReadonlyArray<string>, ProviderError>;
  readonly runInWorkspace: (
    snapshot: WorkspaceSnapshot,
    argv: ReadonlyArray<string>,
    options?: RunCommandOptions
  ) => Effect.Effect<CompletedCommand, CommandFailure | ProviderError>;
  readonly interruptIteration: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<void, ProviderError>;
  readonly destroyWorkspace: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<void, ProviderError>;
}

/** Abstract workspace runtime boundary shared by local and Daytona providers. */
export class WorkspaceProvider extends Context.Tag("@revis/WorkspaceProvider")<
  WorkspaceProvider,
  WorkspaceProviderApi
>() {}
