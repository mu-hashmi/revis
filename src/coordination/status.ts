/** Fresh status snapshots for the CLI and local dashboard. */

import type {
  DaemonRecord,
  RevisConfig,
  RuntimeEvent,
  StatusWorkspaceRecord,
  WorkspaceRecord
} from "../core/models";
import { loadConfig } from "../core/config";
import { daemonSocketPath } from "../core/ipc";
import { daemonProcessAlive, daemonSocketReady } from "./daemon";
import {
  commitCountSinceRef,
  currentHeadSubject,
  deriveOperatorSlug,
  remoteTrackingRef,
  syncTargetBranch
} from "./repo";
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
  workspaces: StatusWorkspaceRecord[];
  events: RuntimeEvent[];
  activity: Record<string, string[]>;
}

/** Load a consistent snapshot of daemon and workspace runtime state. */
export async function loadStatusSnapshot(
  root: string,
  options: {
    eventLimit?: number;
    includeGitDetails?: boolean;
    refresh?: boolean;
  } = {}
): Promise<StatusSnapshot> {
  const {
    includeGitDetails = true,
    refresh = false,
    eventLimit = 12
  } = options;

  const config = await loadConfig(root);
  const operatorSlug = await deriveOperatorSlug(root);
  const syncBranch = syncTargetBranch(config.coordinationRemote, config.trunkBase);
  const daemon = await loadDaemonRecord(root);
  const workspaces = await loadWorkspaceRecords(root);

  if (refresh) {
    await refreshWorkspaceSnapshots(root, workspaces);
  }

  const statusWorkspaces = includeGitDetails
    ? await loadWorkspaceStatus(workspaces, config.coordinationRemote, syncBranch)
    : workspaces.map((workspace) => ({
        ...workspace,
        commitCount: 0,
        lastCommitShortSha: workspace.lastCommitSha?.slice(0, 8) ?? "",
        lastCommitSubject: ""
      }));
  const activity = await loadActivityMap(root, statusWorkspaces);
  const daemonHealthy = await loadDaemonHealth(root, daemon);

  return {
    root,
    config,
    operatorSlug,
    syncBranch,
    daemon,
    daemonHealthy,
    workspaces: statusWorkspaces,
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

/** Add commit-progress details used by the CLI status table. */
async function loadWorkspaceStatus(
  workspaces: WorkspaceRecord[],
  remoteName: string,
  syncBranch: string
): Promise<StatusWorkspaceRecord[]> {
  const baseRef = remoteTrackingRef(remoteName, syncBranch);

  return Promise.all(
    workspaces.map(async (workspace) => ({
      ...workspace,
      commitCount: await commitCountSinceRef(workspace.repoPath, baseRef),
      lastCommitSubject: await currentHeadSubject(workspace.repoPath),
      lastCommitShortSha: workspace.lastCommitSha!.slice(0, 8)
    }))
  );
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
