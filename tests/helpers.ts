/** Repo and workspace fixtures for the Revis Vitest suite. */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../src/core/config";
import type { RevisConfig, WorkspaceRecord } from "../src/core/models";
import { processAlive, runCommand, sleep } from "../src/core/process";
import { RevisDaemon, notifyDaemon, stopDaemon } from "../src/coordination/daemon";
import { initializeProject } from "../src/coordination/setup";
import { loadStatusSnapshot } from "../src/coordination/status";
import { clearRuntime, loadWorkspaceRecords } from "../src/coordination/runtime";
import { createWorkspaces, stopWorkspaces } from "../src/coordination/workspaces";

export interface TestRepoOptions {
  userName: string;
  userEmail: string;
}

export interface WorkspaceHarness {
  config: RevisConfig;
  daemon: RevisDaemon | undefined;
  root: string;
  workspaces: Awaited<ReturnType<typeof createWorkspaces>>;
}

export interface CleanupStack {
  add: (cleanup: () => Promise<void>) => void;
  drain: () => Promise<void>;
}

/** Create a git repository with one committed README file. */
export async function createRepo(options: TestRepoOptions): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "revis-test-"));

  await runCommand(["git", "init", "-b", "main"], { cwd: root });
  await runCommand(["git", "config", "user.name", options.userName], { cwd: root });
  await runCommand(["git", "config", "user.email", options.userEmail], {
    cwd: root
  });
  await writeFile(join(root, "README.md"), "hello\n", "utf8");
  await runCommand(["git", "add", "README.md"], { cwd: root });
  await runCommand(["git", "commit", "-m", "initial"], { cwd: root });

  return root;
}

/** Create a bare remote plus two clones that share it. */
export async function createSharedRemote(
  alice: TestRepoOptions,
  bob: TestRepoOptions
): Promise<{ remotePath: string; aliceRoot: string; bobRoot: string }> {
  const remotePath = await mkdtemp(join(tmpdir(), "revis-remote-"));
  await runCommand(["git", "init", "--bare"], { cwd: remotePath });

  const seed = await createRepo(alice);
  await runCommand(["git", "remote", "add", "origin", remotePath], { cwd: seed });
  await runCommand(["git", "push", "-u", "origin", "main"], { cwd: seed });

  const aliceRoot = await cloneSharedRemoteCheckout("revis-alice-", remotePath, alice);
  const bobRoot = await cloneSharedRemoteCheckout("revis-bob-", remotePath, bob);

  await rm(seed, { recursive: true, force: true });
  return { remotePath, aliceRoot, bobRoot };
}

/** Initialize Revis and override the poll interval for faster tests. */
export async function initializeRevis(
  root: string,
  pollSeconds = 1
): Promise<RevisConfig> {
  const config = await initializeProject(root);
  config.remotePollSeconds = pollSeconds;
  await saveConfig(root, config);
  return config;
}

/** Start the daemon in-process for one test repository. */
export async function startTestDaemon(root: string): Promise<RevisDaemon> {
  const snapshot = await loadStatusSnapshot(root);
  const daemon = new RevisDaemon(root, snapshot.config);
  await daemon.start();
  return daemon;
}

/** Create a local test repo with workspaces and an optional daemon. */
export async function createWorkspaceHarness(options: {
  count: number;
  execCommand: string;
  pollSeconds?: number;
  startDaemon?: boolean;
  user: TestRepoOptions;
}): Promise<WorkspaceHarness> {
  const root = await createRepo(options.user);
  const config = await initializeRevis(root, options.pollSeconds);
  const workspaces = await createWorkspaces(root, config, options.count, options.execCommand);
  const daemon = options.startDaemon === false ? undefined : await startTestDaemon(root);

  if (daemon) {
    await notifyDaemon(root, {
      type: "reconcile",
      reason: "test-start"
    });
  }

  return {
    config,
    daemon,
    root,
    workspaces
  };
}

/** Append and commit a change inside one workspace repository. */
export async function commitWorkspaceChange(
  workspaceRoot: string,
  message: string,
  body = `${message}\n`
): Promise<string> {
  const marker = join(workspaceRoot, `${message.replace(/\s+/g, "-")}.txt`);
  await writeFile(marker, body, "utf8");
  await runCommand(["git", "add", "."], { cwd: workspaceRoot });
  await runCommand(["git", "commit", "-m", message], { cwd: workspaceRoot });
  return (
    await runCommand(["git", "rev-parse", "HEAD"], {
      cwd: workspaceRoot
    })
  ).stdout.trim();
}

/** Wait until a predicate becomes true or throw. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(100);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

/** Load one workspace record by agent id or throw when it is missing. */
export async function requireWorkspaceRecord(
  root: string,
  agentId: string
): Promise<WorkspaceRecord> {
  const record = (await loadWorkspaceRecords(root)).find(
    (candidate) => candidate.agentId === agentId
  );
  if (!record) {
    throw new Error(`Missing workspace record for ${agentId}`);
  }

  return record;
}

/** Wait until one workspace record matches a predicate, then return it. */
export async function waitForWorkspaceRecord(
  root: string,
  agentId: string,
  predicate: (record: WorkspaceRecord) => boolean,
  timeoutMs = 8_000
): Promise<WorkspaceRecord> {
  let latest: WorkspaceRecord | undefined;

  await waitFor(async () => {
    latest = (await loadWorkspaceRecords(root)).find(
      (candidate) => candidate.agentId === agentId
    );
    return latest ? predicate(latest) : false;
  }, timeoutMs);

  return latest!;
}

/** Terminate one headless workspace command in a way that records an exit code. */
export async function exitWorkspaceSession(record: WorkspaceRecord): Promise<void> {
  const pid = requireWorkspacePid(record);

  process.kill(-pid, "SIGTERM");
}

/** Kill one headless workspace process group as an external crash. */
export async function killWorkspaceSession(record: WorkspaceRecord): Promise<void> {
  const pid = requireWorkspacePid(record);

  process.kill(-pid, "SIGKILL");
}

/** Return whether one local detached process id still exists. */
export function workspaceProcessAlive(pidText: string): boolean {
  const pid = Number.parseInt(pidText, 10);
  if (!Number.isInteger(pid)) {
    throw new Error(`Invalid process id: ${pidText}`);
  }

  return processAlive(pid);
}

/** Parse the detached process-group leader stored on one workspace record. */
function requireWorkspacePid(record: WorkspaceRecord): number {
  if (!record.currentSessionId) {
    throw new Error(`Workspace ${record.agentId} has no active process id`);
  }

  const pid = Number.parseInt(record.currentSessionId, 10);
  if (!Number.isInteger(pid)) {
    throw new Error(`Invalid process id for ${record.agentId}: ${record.currentSessionId}`);
  }

  return pid;
}

/** Create a LIFO cleanup stack shared by test files. */
export function createCleanupStack(): CleanupStack {
  const cleanups: Array<() => Promise<void>> = [];

  return {
    add(cleanup) {
      cleanups.push(cleanup);
    },
    async drain() {
      while (cleanups.length > 0) {
        await cleanups.pop()!();
      }
    }
  };
}

/** Read the current contents of one text file. */
export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** Stop daemons/workspaces and delete the repository under test. */
export async function cleanupRepo(
  root: string,
  daemon?: RevisDaemon
): Promise<void> {
  if (daemon) {
    await daemon.stop();
  } else {
    await stopDaemon(root);
  }

  const workspaces = await loadWorkspaceRecords(root);
  if (workspaces.length > 0) {
    await stopWorkspaces(root, workspaces);
  }
  await clearRuntime(root);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50
  });
}

/** Clone the shared bare remote and set the checkout identity for one operator. */
async function cloneSharedRemoteCheckout(
  prefix: string,
  remotePath: string,
  options: TestRepoOptions
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await runCommand(["git", "clone", remotePath, root]);
  await runCommand(["git", "config", "user.name", options.userName], {
    cwd: root
  });
  await runCommand(["git", "config", "user.email", options.userEmail], {
    cwd: root
  });
  return root;
}
