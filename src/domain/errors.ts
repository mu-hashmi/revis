/** Structured domain errors and operator-facing formatting for Revis. */

import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

import type { AgentId, SandboxProvider } from "./models";

export class RevisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisError";
  }
}

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

/** Provider-specific runtime failure for local or Daytona workspaces. */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  provider: Schema.Literal("local", "daytona"),
  action: Schema.NonEmptyString,
  message: Schema.String
}) {}

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

/** Build one provider-tagged error value. */
export function providerError(
  provider: SandboxProvider,
  action: string,
  message: string
): ProviderError {
  return ProviderError.make({ provider, action, message });
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
  if (error instanceof RevisError) {
    return error.message;
  }

  if (!(error instanceof Error) || !("_tag" in error)) {
    return error instanceof Error ? error.message : String(error);
  }

  return Match.value(error as RevisDomainError).pipe(
    Match.tag("CommandError", ({ message }) => message),
    Match.tag("ConfigError", ({ path, message }) => `${path}: ${message}`),
    Match.tag("DaemonUnavailableError", ({ message }) => message),
    Match.tag("GitTransientError", ({ message }) => message),
    Match.tag("ProviderError", ({ provider, action, message }) => `${provider} ${action}: ${message}`),
    Match.tag("RebaseBlockedError", ({ agentId, target }) =>
      `${agentId} has local changes and must rebase onto ${target.slice(0, 8)}`
    ),
    Match.tag("RebaseConflictError", ({ agentId, detail }) => `${agentId} rebase failed: ${detail}`),
    Match.tag("StorageError", ({ path, message }) => `${path}: ${message}`),
    Match.tag("ValidationError", ({ message }) => message),
    Match.orElse(() => (error instanceof Error ? error.message : String(error)))
  );
}
