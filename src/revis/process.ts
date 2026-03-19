/** Child-process helpers used by git, gh, and local shell operations. */

import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import { Effect, Fiber, Stream } from "effect";

import { CommandError, detailFromUnknown } from "../domain/errors";

/** Options for one spawned local command. */
export interface CommandOptions {
  readonly check?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
}

/** Collected result for one completed local command. */
export interface CommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Run one command and collect its full output. */
export function runCommand(
  command: string,
  args: readonly string[] = [],
  options: CommandOptions = {}
): Effect.Effect<CommandResult, CommandError, CommandExecutor.CommandExecutor> {
  const rendered = [command, ...args].join(" ");

  return Effect.mapError(
    Effect.scoped(
      Effect.gen(function* () {
        // Start the process and collect both streams before checking the exit code.
        const process = yield* Command.start(commandFromInput(command, args, options));
        const stdoutFiber = yield* Effect.fork(collectText(process.stdout));
        const stderrFiber = yield* Effect.fork(collectText(process.stderr));
        const exitCode = yield* process.exitCode;
        const stdout = yield* Fiber.join(stdoutFiber);
        const stderr = yield* Fiber.join(stderrFiber);

        const result = {
          command: rendered,
          exitCode,
          stderr,
          stdout
        } satisfies CommandResult;

        if (options.check !== false && exitCode !== 0) {
          return yield* new CommandError({
            command: rendered,
            detail: stderr.trim() || stdout.trim() || "command failed"
          });
        }

        return result;
      })
    ),
    (cause) =>
      cause instanceof CommandError
        ? cause
        : new CommandError({
            command: rendered,
            detail: detailFromUnknown(cause)
          })
  );
}

/** Apply the small set of supported process options to one command builder. */
function commandFromInput(
  command: string,
  args: readonly string[],
  options: CommandOptions
) {
  let current = Command.make(command, ...args);

  if (options.cwd) {
    current = Command.workingDirectory(current, options.cwd);
  }

  if (options.env) {
    current = Command.env(current, options.env);
  }

  if (options.stdin !== undefined) {
    current = Command.feed(current, options.stdin);
  }

  return current;
}

/** Collect a whole byte stream into one UTF-8 string. */
function collectText(stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const decoder = new TextDecoder();
    const text = yield* Stream.runFold(
      stream,
      "",
      (current, chunk) => current + decoder.decode(chunk, { stream: true })
    );

    return `${text}${decoder.decode()}`;
  });
}
