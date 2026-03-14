/** Workspace batch orchestration shared by CLI entrypoints. */

import type { RevisConfig, WorkspaceRecord } from "../core/models";
import { RevisError } from "../core/error";
import { daemonSocketPath } from "../core/ipc";
import { runCommand } from "../core/process";
import { ensureDaemonRunning, notifyDaemon, stopDaemon } from "./daemon";
import { clearRuntime, loadWorkspaceRecord, loadWorkspaceRecords } from "./runtime";
import { createWorkspaces, runCommandInWorkspaces, stopWorkspaces } from "./workspaces";

export interface WorkspaceBatchOptions {
  count: number;
  execCommand?: string;
}

/** Create workspaces, start the daemon, and optionally run a command in each one. */
export async function prepareWorkspaceBatch(
  root: string,
  config: RevisConfig,
  options: WorkspaceBatchOptions
): Promise<WorkspaceRecord[]> {
  await ensureTmuxReady();

  const created = await createWorkspaces(
    root,
    config,
    options.count,
    daemonSocketPath(root)
  );
  await ensureDaemonRunning(root);

  if (options.execCommand) {
    await runCommandInWorkspaces(root, created, options.execCommand);
  }

  await notifyDaemon(root, {
    type: "sync",
    reason: options.execCommand ? "spawn-exec" : "spawn"
  });
  return created;
}

/** Tear down one workspace and stop the daemon when no workspaces remain. */
export async function stopWorkspace(root: string, agentId: string): Promise<void> {
  const record = await loadWorkspaceRecord(root, agentId);
  if (!record) {
    throw new RevisError(`Unknown workspace ${agentId}`);
  }

  await stopDaemon(root);
  await stopWorkspaces(root, [record]);

  if ((await loadWorkspaceRecords(root)).length > 0) {
    await ensureDaemonRunning(root);
    await notifyDaemon(root, {
      type: "sync",
      reason: "stop-workspace"
    });
    return;
  }

  await clearRuntime(root);
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
