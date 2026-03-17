/** Subprocess helpers for short-lived commands and detached services. */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { RevisError } from "./error";

export interface CompletedCommand {
  stdout: string;
  stderr: string;
  exitCode: number;
}

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
        throw new RevisError(`Missing template replacement: ${name}`);
      }
      return value;
    })
  );
}

/** Return the current Revis invocation for spawning nested commands. */
export function currentRevisCommand(): string[] {
  const explicit = process.env.REVIS_EXECUTABLE;
  if (explicit) {
    return [process.execPath, explicit];
  }

  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new RevisError("Could not determine the current Revis executable path");
  }

  return [process.execPath, scriptPath];
}

/** Sleep for the requested duration. */
export async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Run a subprocess and capture its output.
 *
 * This is the default path for short-lived git and process helpers.
 */
export async function runCommand(
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    check?: boolean;
    stdin?: string;
  } = {}
): Promise<CompletedCommand> {
  const { cwd, env, check = true, stdin } = options;

  const result = await new Promise<CompletedCommand>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      try {
        resolve({
          stdout,
          stderr,
          exitCode: normalizeExitCode(argv, exitCode, signal)
        });
      } catch (error) {
        reject(error);
      }
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });

  if (check && result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "command failed";
    throw new RevisError(`${shellJoin(argv)}: ${message}`);
  }

  return result;
}

/** Run a subprocess with inherited stdio. */
export async function runInteractive(
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    check?: boolean;
  } = {}
): Promise<number> {
  const { cwd, env, check = true } = options;

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: env ?? process.env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      try {
        resolve(normalizeExitCode(argv, code, signal));
      } catch (error) {
        reject(error);
      }
    });
  });

  if (check && exitCode !== 0) {
    throw new RevisError(`${shellJoin(argv)} exited with ${exitCode}`);
  }

  return exitCode;
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
      return true;
    }

    throw error;
  }
}

interface ReadyProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readyLine: string;
  timeoutMs: number;
}

/** Spawn a detached background process and wait for a readiness marker on stdout. */
export async function spawnReadyProcess(
  argv: string[],
  options: ReadyProcessOptions
): Promise<number> {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const ready = await waitForReadySignal(argv, child, options);

  child.unref();
  return ready;
}

/** Translate Node's `close` event outcome into a real numeric exit code. */
function normalizeExitCode(
  argv: string[],
  exitCode: number | null,
  signal: NodeJS.Signals | null
): number {
  if (exitCode !== null) {
    return exitCode;
  }

  if (signal) {
    throw new RevisError(`${shellJoin(argv)} terminated by signal ${signal}`);
  }

  throw new RevisError(`${shellJoin(argv)} exited without status information`);
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
  options: ReadyProcessOptions
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    // Time out if the child never announces that it is ready to serve.
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new RevisError(
            `${shellJoin(argv)} did not signal readiness within ${options.timeoutMs}ms`
          )
        )
      );
    }, options.timeoutMs);

    // One shared completion path keeps timer and stream cleanup in sync.
    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      fn();
    };

    // Buffer stdout/stderr so early exits can surface the real daemon failure.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(`${options.readyLine}\n`)) {
        settle(() => resolve(child.pid!));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("close", (code, signal) => {
      settle(() => reject(readySignalFailure(argv, code, signal, stdout, stderr)));
    });
  });
}

/** Build the daemon-readiness failure that should surface to the caller. */
function readySignalFailure(
  argv: string[],
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string
): RevisError {
  try {
    normalizeExitCode(argv, exitCode, signal);
    return new RevisError(`${shellJoin(argv)} exited before becoming ready`);
  } catch (error) {
    const detail = stderr.trim() || stdout.trim() || (error as Error).message;
    return new RevisError(detail);
  }
}
