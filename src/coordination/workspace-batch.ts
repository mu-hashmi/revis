/** Workspace batch orchestration shared by CLI entrypoints. */

import { loadConfig } from "../core/config";
import type { RevisConfig, WorkspaceRecord } from "../core/models";
import { RevisError } from "../core/error";
import { ensureDaemonRunning, notifyDaemon, stopDaemon } from "./daemon";
import { loadRuntimeStore } from "./runtime-access";
import { createWorkspaces, stopWorkspaces } from "./workspaces";

export interface WorkspaceBatchOptions {
  count: number;
  execCommand: string;
}

/** Create workspaces and wake the daemon so iteration 1 can start. */
export async function prepareWorkspaceBatch(
  root: string,
  config: RevisConfig,
  options: WorkspaceBatchOptions
): Promise<WorkspaceRecord[]> {
  const created = await createWorkspaces(root, config, options.count, options.execCommand);
  await ensureDaemonRunning(root);

  await notifyDaemon(root, {
    type: "reconcile",
    reason: "spawn"
  });
  return created;
}

/** Tear down one workspace and stop the daemon when no workspaces remain. */
export async function stopWorkspace(root: string, agentId: string): Promise<void> {
  await loadConfig(root);
  const runtime = await loadRuntimeStore(root);
  const record = await runtime.loadWorkspaceRecord(agentId);
  if (!record) {
    throw new RevisError(`Unknown workspace ${agentId}`);
  }

  await stopDaemon(root);
  await stopWorkspaces(root, [record]);

  if ((await runtime.loadWorkspaceRecords()).length > 0) {
    await ensureDaemonRunning(root);
    await notifyDaemon(root, {
      type: "reconcile",
      reason: "stop-workspace"
    });
    return;
  }

  await runtime.finalizeLiveSession();
  await runtime.clearRuntime();
}

/** Tear down every workspace plus the daemon for one initialized repository. */
export async function stopWorkspaceBatch(root: string): Promise<number> {
  await loadConfig(root);
  const runtime = await loadRuntimeStore(root);
  const workspaces = await runtime.loadWorkspaceRecords();
  await stopDaemon(root);
  await stopWorkspaces(root, workspaces);
  await runtime.finalizeLiveSession();
  await runtime.clearRuntime();
  return workspaces.length;
}
