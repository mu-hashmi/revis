/** Effect-native subprocess helpers for Revis host operations. */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import * as Command from "@effect/platform/Command";
import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { CommandError, GitTransientError } from "../domain/errors";

export interface CompletedCommand {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCommandOptions {
  check?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

interface ReadyProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readyLine: string;
  timeoutMs: number;
}

export type CommandFailure = CommandError | GitTransientError;

/** Render argv as a shell-safe string. */
export function shellJoin(argv: Iterable<string>): string {
  return Array.from(argv, shellEscape).join(" ");
}

/** Expand placeholders inside a launch template. */
export function substituteArgv(
  argv: string[],
  replacements: Record<string, string>
): string[] {
  return argv.map((part) =>
    part.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
      const value = replacements[name];
      if (value === undefined) {
        throw new Error(`Missing template replacement: ${name}`);
      }

      return value;
    })
  );
}

/** Return the current Revis invocation for spawning nested daemon commands. */
export function currentRevisCommand(): string[] {
  const explicit = process.env.REVIS_EXECUTABLE;
  if (explicit) {
    return [process.execPath, explicit];
  }

  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Could not determine the current Revis executable path");
  }

  return [process.execPath, scriptPath];
}

/** Return whether one process id still exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      // EPERM still means the process exists; this probe only cares about liveness.
      return true;
    }

    throw error;
  }
}

/** Provide a small Promise sleep for process-management edges outside Effect scopes. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a short-lived command and capture stdout, stderr, and exit code. */
export function runCommandWith(
  executor: CommandExecutor.CommandExecutor,
  argv: string[],
  options: RunCommandOptions = {}
): Effect.Effect<CompletedCommand, CommandFailure> {
  return Effect.scoped(
    Effect.gen(function* () {
      const commandText = shellJoin(argv);
      const command = buildCommand(argv, options);

      const processHandle = yield* executor.start(command).pipe(
        Effect.mapError((error) =>
          CommandError.make({
            command: commandText,
            message: String(error)
          })
        )
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStream(processHandle.stdout),
          collectStream(processHandle.stderr),
          processHandle.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError((error) =>
              CommandError.make({
                command: commandText,
                message: String(error)
              })
            )
          )
        ],
        { concurrency: "unbounded" }
      );

      const result = { stdout, stderr, exitCode };
      if (options.check !== false && exitCode !== 0) {
        return yield* classifyCommandFailure(argv, stderr.trim() || stdout.trim() || "command failed");
      }

      return result;
    })
  );
}

/** Spawn a detached background process and wait for a readiness marker. */
export function spawnReadyProcess(
  argv: string[],
  options: ReadyProcessOptions
): Effect.Effect<number, CommandError> {
  return Effect.async<number, CommandError>((resume, signal) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    void waitForReadySignal(argv, child, options, signal)
      .then((pid) => resume(Effect.succeed(pid)))
      .catch((error) =>
        resume(
          CommandError.make({
            command: shellJoin(argv),
            message: error instanceof Error ? error.message : String(error)
          })
        )
      );

    // If startup is interrupted before the ready marker arrives, tear the detached child down so
    // the daemon does not leak a background process that nobody owns anymore.
    return Effect.sync(() => {
      terminateChildProcess(child);
    });
  });
}

/** Collect a UTF-8 process stream into one string. */
function collectStream(
  stream: Stream.Stream<Uint8Array, unknown>
): Effect.Effect<string, CommandError> {
  const decoder = new TextDecoder();

  return Stream.runFold(stream, "", (output, chunk) => output + decoder.decode(chunk)).pipe(
    Effect.mapError((error) =>
      CommandError.make({
        command: "stream",
        message: String(error)
      })
    )
  );
}

/** Build one Effect command from argv plus standard execution options. */
function buildCommand(argv: string[], options: RunCommandOptions): Command.Command {
  let command = Command.make(argv[0]!, ...argv.slice(1));

  if (options.cwd) {
    command = Command.workingDirectory(command, options.cwd);
  }

  if (options.env) {
    command = Command.env(
      command,
      Object.fromEntries(Object.entries(options.env).map(([key, value]) => [key, value ?? ""]))
    );
  }

  if (options.stdin !== undefined) {
    command = Command.feed(command, options.stdin);
  }

  return command;
}

/** Map one failed command into a typed domain error. */
function classifyCommandFailure(
  argv: ReadonlyArray<string>,
  message: string
): Effect.Effect<never, CommandFailure> {
  const command = shellJoin(argv);
  if (argv[0] === "git" && isTransientCommandError(message)) {
    return GitTransientError.make({ command, message });
  }

  return CommandError.make({ command, message });
}

/** Return whether stderr looks like a transient transport failure. */
function isTransientCommandError(stderr: string): boolean {
  return /(timed out|temporary failure|could not resolve|connection reset|network|connection refused)/i.test(
    stderr
  );
}

/** Quote one shell argument for safe shell composition. */
function shellEscape(part: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(part)) {
    return part;
  }

  return `'${part.replaceAll("'", `'\\''`)}'`;
}

/** Wait until a detached child prints its ready marker or exits. */
async function waitForReadySignal(
  argv: string[],
  child: ChildProcessByStdio<null, Readable, Readable>,
  options: ReadyProcessOptions,
  signal: AbortSignal
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const commandText = shellJoin(argv);
    let settled = false;
    let stdout = "";
    let stderr = "";

    // One cleanup path keeps timers, listeners, and stdio teardown aligned across success,
    // timeout, startup failure, and interruption.
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout.destroy();
      child.stderr.destroy();
    };

    // Time out if the child never announces that it is ready to serve.
    const timer = setTimeout(() => {
      settle(() => {
        terminateChildProcess(child);
        reject(new Error(`${commandText} did not become ready in time`));
      });
    }, options.timeoutMs);

    // One shared completion path keeps timer and stream cleanup in sync.
    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      fn();
    };

    // Interruption means the caller gave up on startup, so the detached child should not keep
    // booting in the background.
    const onAbort = (): void => {
      settle(() => {
        terminateChildProcess(child);
        reject(new Error(`${commandText} startup interrupted`));
      });
    };

    const onStdout = (chunk: string): void => {
      stdout += chunk;
      if (stdout.includes(options.readyLine)) {
        child.unref();
        settle(() => {
          if (child.pid === undefined) {
            reject(new Error(`${commandText} started without a pid`));
            return;
          }

          resolve(child.pid);
        });
      }
    };

    const onStderr = (chunk: string): void => {
      stderr += chunk;
    };

    const onError = (error: Error): void => {
      settle(() => reject(error));
    };

    const onClose = (_code: number | null, closeSignal: NodeJS.Signals | null): void => {
      settle(() =>
        reject(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              `${commandText} exited before ready${closeSignal ? ` (${closeSignal})` : ""}`
          )
        )
      );
    };

    // Buffer stdout and stderr so early exits surface the real daemon failure.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

/** Terminate one not-yet-ready detached child process. */
function terminateChildProcess(child: ChildProcessByStdio<null, Readable, Readable>): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
}
