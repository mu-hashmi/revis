/** Fresh status snapshots for the CLI and Ink monitor. */

import type {
  DaemonRecord,
  RevisConfig,
  RuntimeEvent,
  WorkspaceRecord
} from "../core/models";
import { loadConfig } from "../core/config";
import { daemonSocketPath } from "../core/ipc";
import { daemonProcessAlive, daemonSocketReady } from "./daemon";
import { deriveOperatorSlug, syncTargetBranch } from "./repo";
import {
  loadActivity,
  loadDaemonRecord,
  loadEvents,
  loadWorkspaceRecords
} from "./runtime";
import { refreshWorkspaceSnapshots } from "./workspaces";

export interface StatusSnapshot {
  root: string;
  config: RevisConfig;
  operatorSlug: string;
  syncBranch: string;
  daemon: DaemonRecord | null;
  daemonHealthy: boolean;
  workspaces: WorkspaceRecord[];
  events: RuntimeEvent[];
  activity: Record<string, string[]>;
}

/** Load a consistent snapshot of daemon and workspace runtime state. */
export async function loadStatusSnapshot(
  root: string,
  options: { refresh?: boolean; eventLimit?: number } = {}
): Promise<StatusSnapshot> {
  const { refresh = false, eventLimit = 12 } = options;

  const config = await loadConfig(root);
  const operatorSlug = await deriveOperatorSlug(root);
  const syncBranch = syncTargetBranch(config.coordinationRemote, config.trunkBase);
  const daemon = await loadDaemonRecord(root);
  const workspaces = await loadWorkspaceRecords(root);

  if (refresh) {
    await refreshWorkspaceSnapshots(root, workspaces);
  }

  const activity = await loadActivityMap(root, workspaces);
  const daemonHealthy = await loadDaemonHealth(root, daemon);

  return {
    root,
    config,
    operatorSlug,
    syncBranch,
    daemon,
    daemonHealthy,
    workspaces,
    events: await loadEvents(root, eventLimit),
    activity
  };
}

/** Load the latest activity snapshot for every workspace in one status view. */
async function loadActivityMap(
  root: string,
  workspaces: WorkspaceRecord[]
): Promise<Record<string, string[]>> {
  const activity: Record<string, string[]> = {};

  for (const workspace of workspaces) {
    activity[workspace.agentId] = await loadActivity(root, workspace.agentId);
  }

  return activity;
}

/** Return whether the daemon record and socket together indicate a healthy daemon. */
async function loadDaemonHealth(
  root: string,
  daemon: DaemonRecord | null
): Promise<boolean> {
  if (daemon) {
    return daemonProcessAlive(daemon) && (await daemonSocketReady(daemon.socketPath));
  }

  return daemonSocketReady(daemonSocketPath(root));
}
