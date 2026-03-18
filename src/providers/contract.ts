/** Workspace runtime boundary for local and Daytona-backed sandboxes. */

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  WorkspaceActivityError,
  WorkspaceCommandError,
  WorkspaceDestroyError,
  WorkspaceInspectError,
  WorkspaceInterruptError,
  WorkspaceProvisionError,
  WorkspaceStartError
} from "../domain/errors";
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

/** Inputs needed to provision a fresh workspace checkout for one agent. */
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

/** Provider-owned workspace metadata returned after a successful provision step. */
export interface ProvisionedWorkspace {
  readonly workspaceRoot: string;
  readonly localBranch: BranchName;
  readonly head: Revision;
  readonly attachCmd?: ReadonlyArray<string>;
  readonly attachLabel?: string;
  readonly sandboxId?: string;
}

/** Runtime boundary implemented by each sandbox provider. */
export interface WorkspaceProviderApi {
  readonly kind: SandboxProvider;
  readonly provision: (
    params: ProvisionWorkspaceParams
  ) => Effect.Effect<ProvisionedWorkspace, HostGitError | WorkspaceProvisionError>;
  readonly startIteration: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<WorkspaceSessionId, WorkspaceStartError>;
  readonly inspectSession: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<WorkspaceSessionStatus, WorkspaceInspectError>;
  readonly captureActivity: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<ReadonlyArray<string>, WorkspaceActivityError>;
  readonly runInWorkspace: (
    snapshot: WorkspaceSnapshot,
    argv: ReadonlyArray<string>,
    options?: RunCommandOptions
  ) => Effect.Effect<CompletedCommand, CommandFailure | WorkspaceCommandError>;
  readonly interruptIteration: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<void, WorkspaceInterruptError>;
  readonly destroyWorkspace: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<void, WorkspaceDestroyError>;
}

/** Abstract workspace runtime boundary shared by local and Daytona providers. */
export class WorkspaceProvider extends Context.Tag("@revis/WorkspaceProvider")<
  WorkspaceProvider,
  WorkspaceProviderApi
>() {}
