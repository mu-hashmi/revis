/** CLI formatting helpers for Revis status output. */

import type { StatusSnapshot, StatusWorkspace } from "../domain/models";

/** Render one operator-facing status snapshot as plain text. */
export function formatStatusSnapshot(snapshot: StatusSnapshot): string {
  const lines = [
    `Root: ${snapshot.root}`,
    `Provider: ${snapshot.config.sandboxProvider}`,
    `Remote: ${snapshot.config.coordinationRemote}`,
    `Sync target: ${snapshot.syncBranch}`,
    `Daemon: ${snapshot.daemon ? `running (${snapshot.daemon.apiBaseUrl})` : "offline"}`,
    ""
  ];

  if (snapshot.workspaces.length === 0) {
    lines.push("No workspaces.");
  } else {
    lines.push("Workspaces:");
    for (const workspace of snapshot.workspaces) {
      lines.push(formatWorkspace(workspace));
    }
  }

  if (snapshot.events.length > 0) {
    lines.push("");
    lines.push("Recent events:");
    for (const event of snapshot.events) {
      lines.push(`  ${event.timestamp} ${event.summary}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Render one workspace row with its lifecycle tag and git position summary. */
function formatWorkspace(workspace: StatusWorkspace): string {
  const state = workspace.snapshot.state;
  const details = [
    `${workspace.snapshot.agentId}`,
    state._tag,
    `iter=${state.iteration}`,
    `ahead=${workspace.aheadCount}`
  ];

  if (state.lastCommitSha) {
    details.push(`head=${state.lastCommitSha.slice(0, 8)}`);
  }

  if (workspace.lastCommitSubject) {
    details.push(workspace.lastCommitSubject);
  }

  return `  ${details.join("  ")}`;
}
