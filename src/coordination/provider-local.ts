/** Local headless workspace provider backed by detached child processes. */

import { open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { WorkspaceRecord } from "../core/models";
import { RevisError } from "../core/error";
import { pathExists } from "../core/files";
import {
  processAlive,
  runCommand,
  shellJoin,
  sleep,
  type CompletedCommand
} from "../core/process";
import {
  cloneWorkspaceRepo,
  createBranchFromRemote,
  currentBranch,
  currentHeadSha,
  setGitIdentity,
  workspaceEmail
} from "./repo";
import type {
  CreateWorkspaceParams,
  CreatedWorkspaceState,
  WorkspaceCommandOptions,
  WorkspaceProvider,
  WorkspaceSessionStatus
} from "./provider";

const WORKSPACES_DIR = join(".revis", "workspaces");
const ACTIVITY_LINE_LIMIT = 200;
const PROCESS_STOP_TIMEOUT_MS = 1_000;

/** Return the path to one local workspace clone. */
export function workspaceRepoPath(root: string, agentId: string): string {
  return join(root, WORKSPACES_DIR, agentId, "repo");
}

/** Return the log file for one headless local workspace session. */
export function workspaceSessionLogPath(root: string, agentId: string): string {
  return join(root, WORKSPACES_DIR, agentId, "session.log");
}

/** Build the local workspace provider. */
export function createLocalWorkspaceProvider(): WorkspaceProvider {
  return {
    kind: "local",

    async createWorkspace(params: CreateWorkspaceParams): Promise<CreatedWorkspaceState> {
      const workspaceDir = join(params.root, WORKSPACES_DIR, params.agentId);
      const repoPath = workspaceRepoPath(params.root, params.agentId);
      const logPath = workspaceSessionLogPath(params.root, params.agentId);

      await rm(workspaceDir, {
        recursive: true,
        force: true
      });

      await cloneWorkspaceRepo(
        params.remoteUrl,
        params.remoteName,
        params.syncBranch,
        repoPath
      );
      await createBranchFromRemote(
        repoPath,
        params.remoteName,
        params.coordinationBranch,
        params.syncBranch
      );
      await setGitIdentity(
        repoPath,
        `${params.operatorSlug}-${params.agentId}`,
        workspaceEmail(params.operatorSlug, params.agentId)
      );
      await writeFile(logPath, "", "utf8");

      const headSha = await currentHeadSha(repoPath);

      return {
        workspaceRoot: repoPath,
        localBranch: await currentBranch(repoPath),
        lastCommitSha: headSha,
        attachCmd: ["tail", "-f", logPath],
        attachLabel: logPath
      };
    },

    async startSession(record: WorkspaceRecord): Promise<string> {
      const logPath = sessionLogPath(record);
      const exitPath = sessionExitPath(record);
      const shell = process.env.SHELL ?? "/bin/sh";

      await writeFile(logPath, "", "utf8");
      await rm(exitPath, { force: true });

      const logHandle = await open(logPath, "a");
      const child = spawn(shell, ["-lc", localWrapperScript(record.execCommand, exitPath)], {
        cwd: record.workspaceRoot,
        detached: true,
        env: process.env,
        stdio: ["ignore", logHandle.fd, logHandle.fd]
      });

      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });

      await logHandle.close();
      child.unref();

      if (!child.pid) {
        throw new RevisError(`Failed to start local session for ${record.agentId}`);
      }

      return String(child.pid);
    },

    async inspectSession(record: WorkspaceRecord): Promise<WorkspaceSessionStatus> {
      if (!record.currentSessionId) {
        return { phase: "missing" };
      }

      const pid = Number.parseInt(record.currentSessionId, 10);
      if (!Number.isInteger(pid)) {
        throw new RevisError(`Invalid local session pid for ${record.agentId}`);
      }

      if (processAlive(pid)) {
        return { phase: "running" };
      }

      const exitPath = sessionExitPath(record);
      if (!(await pathExists(exitPath))) {
        return { phase: "missing" };
      }

      const exitCode = Number.parseInt((await readFile(exitPath, "utf8")).trim(), 10);
      if (Number.isFinite(exitCode)) {
        return {
          phase: "exited",
          exitCode
        };
      }

      return { phase: "exited" };
    },

    async captureActivity(record: WorkspaceRecord): Promise<string[]> {
      const logPath = sessionLogPath(record);
      if (!(await pathExists(logPath))) {
        return [];
      }

      return (await readFile(logPath, "utf8"))
        .replaceAll("\r", "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-ACTIVITY_LINE_LIMIT);
    },

    async runCommand(
      record: WorkspaceRecord,
      argv: string[],
      options: WorkspaceCommandOptions = {}
    ): Promise<CompletedCommand> {
      const commandOptions: {
        check?: boolean;
        cwd: string;
        env?: NodeJS.ProcessEnv;
      } = {
        cwd: options.cwd ?? record.workspaceRoot
      };
      if (options.env) {
        commandOptions.env = options.env;
      }
      if (options.check !== undefined) {
        commandOptions.check = options.check;
      }

      return runCommand(argv, commandOptions);
    },

    async stopWorkspace(record: WorkspaceRecord): Promise<void> {
      if (record.currentSessionId) {
        const pid = Number.parseInt(record.currentSessionId, 10);
        if (Number.isInteger(pid)) {
          await stopLocalProcess(pid);
        }
      }

      await rm(join(record.workspaceRoot, ".."), {
        recursive: true,
        force: true
      });
    }
  };
}

/** Return the current session log path derived from one workspace record. */
function sessionLogPath(record: WorkspaceRecord): string {
  return join(record.workspaceRoot, "..", "session.log");
}

/** Return the current session exit-code path derived from one workspace record. */
function sessionExitPath(record: WorkspaceRecord): string {
  return join(record.workspaceRoot, "..", "session.exit");
}

/** Render the shell wrapper that records the command's final exit code. */
function localWrapperScript(execCommand: string, exitPath: string): string {
  const escapedExitPath = shellJoin([exitPath]);

  return [
    `write_exit() { printf '%s\\n' "$1" > ${escapedExitPath}; }`,
    "trap 'write_exit 130; exit 130' INT",
    "trap 'write_exit 143; exit 143' TERM",
    execCommand,
    'status=$?',
    'write_exit "$status"',
    'exit "$status"'
  ].join("\n");
}

/** Terminate one detached local process group. */
async function stopLocalProcess(pid: number): Promise<void> {
  if (!processAlive(pid)) {
    return;
  }

  process.kill(-pid, "SIGTERM");
  if (await waitForLocalProcessExit(pid)) {
    return;
  }

  process.kill(-pid, "SIGKILL");
  await waitForLocalProcessExit(pid);
}

/** Wait until one detached local process group exits. */
async function waitForLocalProcessExit(pid: number): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < PROCESS_STOP_TIMEOUT_MS) {
    if (!processAlive(pid)) {
      return true;
    }

    await sleep(50);
  }

  return !processAlive(pid);
}
