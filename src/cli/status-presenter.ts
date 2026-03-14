/** Shared operator-facing status formatting for the CLI and Ink monitor. */

import type { StatusSnapshot } from "../coordination/status";
import type { WorkspaceRecord } from "../core/models";
import { daemonSocketPath } from "../core/ipc";

/** Format the daemon health line shared by CLI status and the monitor. */
export function formatDaemonHealth(snapshot: StatusSnapshot): string {
  const socketPath = snapshot.daemon?.socketPath ?? daemonSocketPath(snapshot.root);
  return `daemon ${snapshot.daemonHealthy ? "up" : "down"} ${socketPath}`;
}

/** Format the shared repository context line for operator-facing views. */
export function formatStatusContext(snapshot: StatusSnapshot): string {
  return `operator ${snapshot.operatorSlug} remote ${snapshot.config.coordinationRemote} base ${snapshot.syncBranch}`;
}

/** Format the common workspace summary text shared by CLI and monitor views. */
export function formatWorkspaceSummary(workspace: WorkspaceRecord): string {
  const fields = [
    `last=${workspace.lastCommitSha!.slice(0, 8)}`,
    `pushed=${workspace.lastPushedSha!.slice(0, 8)}`,
    `relayed=${workspace.lastRelayedSha!.slice(0, 8)}`,
    `rebase=${workspace.rebaseRequiredSha ? "pending" : "ok"}`
  ];
  const queued = workspace.queuedSteeringMessages?.length ?? 0;
  if (queued > 0) {
    fields.push(`queued=${queued}`);
  }

  return [
    workspace.agentId,
    `[${workspace.state}]`,
    `coord=${workspace.coordinationBranch}`,
    `local=${workspace.localBranch}`,
    ...fields
  ].join(" ");
}
