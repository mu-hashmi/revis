/** Provider abstraction for workspace execution environments. */

import type { CompletedCommand } from "../core/process";
import type { RevisConfig, SandboxProvider, WorkspaceRecord } from "../core/models";
import { createDaytonaWorkspaceProvider } from "./provider-daytona";
import { createLocalWorkspaceProvider } from "./provider-local";

export interface WorkspaceSessionStatus {
  phase: "running" | "exited" | "missing";
  exitCode?: number;
}

export interface CreateWorkspaceParams {
  root: string;
  remoteName: string;
  remoteUrl: string;
  syncBranch: string;
  operatorSlug: string;
  agentId: string;
  coordinationBranch: string;
  execCommand: string;
}

export interface CreatedWorkspaceState {
  workspaceRoot: string;
  localBranch: string;
  lastCommitSha: string;
  attachCmd?: string[];
  attachLabel?: string;
  sandboxId?: string;
}

export interface WorkspaceCommandOptions {
  check?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WorkspaceProvider {
  readonly kind: SandboxProvider;

  createWorkspace(params: CreateWorkspaceParams): Promise<CreatedWorkspaceState>;

  startSession(record: WorkspaceRecord): Promise<string>;

  inspectSession(record: WorkspaceRecord): Promise<WorkspaceSessionStatus>;

  captureActivity(record: WorkspaceRecord): Promise<string[]>;

  runCommand(
    record: WorkspaceRecord,
    argv: string[],
    options?: WorkspaceCommandOptions
  ): Promise<CompletedCommand>;

  stopWorkspace(record: WorkspaceRecord): Promise<void>;
}

/** Construct the workspace provider for one Revis configuration. */
export function createWorkspaceProvider(config: RevisConfig): WorkspaceProvider {
  return createWorkspaceProviderForKind(config.sandboxProvider);
}

/** Construct the workspace provider for one provider kind. */
export function createWorkspaceProviderForKind(kind: SandboxProvider): WorkspaceProvider {
  switch (kind) {
    case "local":
      return createLocalWorkspaceProvider();
    case "daytona":
      return createDaytonaWorkspaceProvider();
  }
}
