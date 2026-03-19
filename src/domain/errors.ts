/** Small, loud tagged errors used across the Revis runtime. */

import * as Schema from "effect/Schema";

/** User-facing validation failure at a command or config boundary. */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  detail: Schema.NonEmptyString
}) {}

/** Failed local process execution. */
export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  command: Schema.NonEmptyString,
  detail: Schema.NonEmptyString
}) {}

/** Failed filesystem read or write. */
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  path: Schema.NonEmptyString,
  detail: Schema.NonEmptyString
}) {}

/** Failed sandbox lifecycle or sandbox-local command. */
export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  sandbox: Schema.NonEmptyString,
  detail: Schema.NonEmptyString
}) {}

export type RevisError =
  | ValidationError
  | CommandError
  | StorageError
  | SandboxError;

/** Convert an arbitrary failure into one readable detail string. */
export function detailFromUnknown(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") {
    return cause.message;
  }

  return String(cause);
}

/** Render one operator-facing error message. */
export function formatDomainError(error: unknown): string {
  // Keep the operator-facing forms short and path/command first.
  if (error instanceof ValidationError) {
    return error.detail;
  }

  if (error instanceof StorageError) {
    return `${error.path}: ${error.detail}`;
  }

  if (error instanceof CommandError) {
    return `${error.command}: ${error.detail}`;
  }

  if (error instanceof SandboxError) {
    return `${error.sandbox}: ${error.detail}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
