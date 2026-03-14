/** Workspace batch orchestration shared by CLI entrypoints. */

import type { RevisConfig, WorkspaceRecord } from "../core/models";
import { daemonSocketPath } from "../core/ipc";
import { runCommand } from "../core/process";
import { ensureDaemonRunning, notifyDaemon, stopDaemon } from "./daemon";
import { clearRuntime, loadWorkspaceRecords } from "./runtime";
import { createWorkspaces, launchCodexInWorkspaces } from "./workspaces";
import { stopWorkspaces } from "./workspaces";

export interface WorkspaceBatchOptions {
  count: number;
  launchCodex: boolean;
}

/** Create workspaces, start the daemon, and optionally launch Codex. */
export async function prepareWorkspaceBatch(
  root: string,
  config: RevisConfig,
  options: WorkspaceBatchOptions
): Promise<WorkspaceRecord[]> {
  await ensureTmuxReady();
  if (options.launchCodex) {
    await ensureCodexReady();
  }

  const created = await createWorkspaces(
    root,
    config,
    options.count,
    daemonSocketPath(root)
  );
  await ensureDaemonRunning(root);

  if (options.launchCodex) {
    await launchCodexInWorkspaces(root, config, created);
  }

  await notifyDaemon(root, {
    type: "sync",
    reason: options.launchCodex ? "spawn" : "workspace"
  });
  return created;
}

/** Tear down every workspace plus the daemon for one initialized repository. */
export async function stopWorkspaceBatch(root: string): Promise<number> {
  const workspaces = await loadWorkspaceRecords(root);
  await stopWorkspaces(root, workspaces);
  await stopDaemon(root);
  await clearRuntime(root);
  return workspaces.length;
}

/** Fail fast when tmux is unavailable. */
async function ensureTmuxReady(): Promise<void> {
  await runCommand(["tmux", "-V"]);
}

/** Fail fast when the local Codex executable is unavailable. */
async function ensureCodexReady(): Promise<void> {
  await runCommand(["codex", "--version"]);
}
