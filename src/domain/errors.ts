/** Structured domain errors and operator-facing formatting for Revis. */

import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

import type { AgentId, SandboxProvider } from "./models";

/** Configuration file load/save failure. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.NonEmptyString,
  message: Schema.String
}) {}

/** Operator-facing validation failure caused by invalid input or state. */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String
}) {}

/** Command execution failure with the rendered command line attached. */
export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  command: Schema.String,
  message: Schema.String
}) {}

/** Git command failure classified as transient and worth retrying later. */
export class GitTransientError extends Schema.TaggedError<GitTransientError>()(
  "GitTransientError",
  {
    command: Schema.String,
    message: Schema.String
  }
) {}

/** Persistent filesystem/storage failure rooted at one project path. */
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  path: Schema.NonEmptyString,
  message: Schema.String
}) {}

/** Workspace provisioning failure inside one sandbox provider. */
export class WorkspaceProvisionError extends Schema.TaggedError<WorkspaceProvisionError>()(
  "WorkspaceProvisionError",
  {
    provider: Schema.Literal("local", "daytona"),
    message: Schema.String
  }
) {}

/** Workspace iteration start failure inside one sandbox provider. */
export class WorkspaceStartError extends Schema.TaggedError<WorkspaceStartError>()(
  "WorkspaceStartError",
  {
    provider: Schema.Literal("local", "daytona"),
    message: Schema.String
  }
) {}

/** Workspace session inspection failure inside one sandbox provider. */
export class WorkspaceInspectError extends Schema.TaggedError<WorkspaceInspectError>()(
  "WorkspaceInspectError",
  {
    provider: Schema.Literal("local", "daytona"),
    message: Schema.String
  }
) {}

/** Workspace activity capture failure inside one sandbox provider. */
export class WorkspaceActivityError extends Schema.TaggedError<WorkspaceActivityError>()(
  "WorkspaceActivityError",
  {
    provider: Schema.Literal("local", "daytona"),
    message: Schema.String
  }
) {}

/** Workspace command execution failure inside one sandbox provider. */
export class WorkspaceCommandError extends Schema.TaggedError<WorkspaceCommandError>()(
  "WorkspaceCommandError",
  {
    provider: Schema.Literal("local", "daytona"),
    message: Schema.String
  }
) {}

/** Workspace interrupt failure inside one sandbox provider. */
export class WorkspaceInterruptError extends Schema.TaggedError<WorkspaceInterruptError>()(
  "WorkspaceInterruptError",
  {
    provider: Schema.Literal("local", "daytona"),
    message: Schema.String
  }
) {}

/** Workspace destruction failure inside one sandbox provider. */
export class WorkspaceDestroyError extends Schema.TaggedError<WorkspaceDestroyError>()(
  "WorkspaceDestroyError",
  {
    provider: Schema.Literal("local", "daytona"),
    message: Schema.String
  }
) {}

export type ProviderError =
  | WorkspaceActivityError
  | WorkspaceCommandError
  | WorkspaceDestroyError
  | WorkspaceInspectError
  | WorkspaceInterruptError
  | WorkspaceProvisionError
  | WorkspaceStartError;

/** Rebase refusal because the workspace has local changes that must be resolved first. */
export class RebaseBlockedError extends Schema.TaggedError<RebaseBlockedError>()(
  "RebaseBlockedError",
  {
    agentId: Schema.String,
    target: Schema.String
  }
) {}

/** Rebase failure caused by an actual merge conflict. */
export class RebaseConflictError extends Schema.TaggedError<RebaseConflictError>()(
  "RebaseConflictError",
  {
    agentId: Schema.String,
    target: Schema.String,
    detail: Schema.String
  }
) {}

/** Daemon reachability failure surfaced to CLI callers. */
export class DaemonUnavailableError extends Schema.TaggedError<DaemonUnavailableError>()(
  "DaemonUnavailableError",
  {
    message: Schema.String
  }
) {}

export type RevisDomainError =
  | CommandError
  | ConfigError
  | DaemonUnavailableError
  | GitTransientError
  | ProviderError
  | RebaseBlockedError
  | RebaseConflictError
  | StorageError
  | ValidationError;

/** Build one workspace-provision error value. */
export function workspaceProvisionError(
  provider: SandboxProvider,
  message: string
): WorkspaceProvisionError {
  return WorkspaceProvisionError.make({ provider, message });
}

/** Build one workspace-start error value. */
export function workspaceStartError(
  provider: SandboxProvider,
  message: string
): WorkspaceStartError {
  return WorkspaceStartError.make({ provider, message });
}

/** Build one workspace-inspection error value. */
export function workspaceInspectError(
  provider: SandboxProvider,
  message: string
): WorkspaceInspectError {
  return WorkspaceInspectError.make({ provider, message });
}

/** Build one workspace-activity error value. */
export function workspaceActivityError(
  provider: SandboxProvider,
  message: string
): WorkspaceActivityError {
  return WorkspaceActivityError.make({ provider, message });
}

/** Build one workspace-command error value. */
export function workspaceCommandError(
  provider: SandboxProvider,
  message: string
): WorkspaceCommandError {
  return WorkspaceCommandError.make({ provider, message });
}

/** Build one workspace-interrupt error value. */
export function workspaceInterruptError(
  provider: SandboxProvider,
  message: string
): WorkspaceInterruptError {
  return WorkspaceInterruptError.make({ provider, message });
}

/** Build one workspace-destroy error value. */
export function workspaceDestroyError(
  provider: SandboxProvider,
  message: string
): WorkspaceDestroyError {
  return WorkspaceDestroyError.make({ provider, message });
}

/** Build one storage error rooted at the provided path. */
export function storageError(path: string, message: string): StorageError {
  return StorageError.make({ path, message });
}

/** Build one operator-facing validation error. */
export function validationError(message: string): ValidationError {
  return ValidationError.make({ message });
}

/** Render any known domain error into operator-facing text at the outer boundary. */
export function formatDomainError(error: RevisDomainError | unknown): string {
  if (!(error instanceof Error) || !("_tag" in error)) {
    return error instanceof Error ? error.message : String(error);
  }

  // Keep this exhaustive so new domain errors cannot slip past the operator-facing formatter.
  return Match.value(error as RevisDomainError).pipe(
    Match.tag("CommandError", ({ message }) => message),
    Match.tag("ConfigError", ({ path, message }) => `${path}: ${message}`),
    Match.tag("DaemonUnavailableError", ({ message }) => message),
    Match.tag("GitTransientError", ({ message }) => message),
    Match.tag("WorkspaceProvisionError", ({ provider, message }) => `${provider} provision: ${message}`),
    Match.tag("WorkspaceStartError", ({ provider, message }) => `${provider} start iteration: ${message}`),
    Match.tag("WorkspaceInspectError", ({ provider, message }) => `${provider} inspect session: ${message}`),
    Match.tag("WorkspaceActivityError", ({ provider, message }) => `${provider} read activity: ${message}`),
    Match.tag("WorkspaceCommandError", ({ provider, message }) => `${provider} run command: ${message}`),
    Match.tag("WorkspaceInterruptError", ({ provider, message }) => `${provider} interrupt iteration: ${message}`),
    Match.tag("WorkspaceDestroyError", ({ provider, message }) => `${provider} destroy workspace: ${message}`),
    Match.tag("RebaseBlockedError", ({ agentId, target }) =>
      `${agentId} has local changes and must rebase onto ${target.slice(0, 8)}`
    ),
    Match.tag("RebaseConflictError", ({ agentId, detail }) => `${agentId} rebase failed: ${detail}`),
    Match.tag("StorageError", ({ path, message }) => `${path}: ${message}`),
    Match.tag("ValidationError", ({ message }) => message),
    Match.exhaustive
  );
}
