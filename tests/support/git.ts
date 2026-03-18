/** Small process helpers for driving real git repos in contract and acceptance tests. */

import { spawn } from "node:child_process";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Run one git command and capture its output without throwing on non-zero exit. */
export async function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  return runCommand("git", args, options.env ? { cwd, env: options.env } : { cwd });
}

/** Initialize one temporary git repo with a stable identity. */
export async function initGitRepo(root: string, branch = "main"): Promise<void> {
  await assertSuccess(await runGit(root, ["init", "-b", branch]));
  await assertSuccess(await runGit(root, ["config", "user.name", "Revis Tester"]));
  await assertSuccess(await runGit(root, ["config", "user.email", "tester@example.com"]));
}

/** Return the SHA for one git ref. */
export async function gitHead(root: string, ref = "HEAD"): Promise<string> {
  const result = await runGit(root, ["rev-parse", ref]);
  await assertSuccess(result);
  return result.stdout.trim();
}

/** Create an empty commit with the provided subject. */
export async function gitCommit(root: string, subject: string): Promise<void> {
  await assertSuccess(await runGit(root, ["commit", "--allow-empty", "-m", subject]));
}

/** Run one command and capture stdout, stderr, and exit code. */
export async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    // Use `spawn` so tests can capture stdout, stderr, and exit code uniformly across git and the
    // built Revis CLI.
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1
      });
    });
  });
}

/** Assert that one command completed successfully. */
export async function assertSuccess(result: CommandResult): Promise<void> {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(result.stderr.trim() || result.stdout.trim() || "command failed");
}
