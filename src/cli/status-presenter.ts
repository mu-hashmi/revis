/** Shared operator-facing status formatting for the CLI status view and dashboard data. */

import type { StatusSnapshot } from "../coordination/status";
import type { StatusWorkspaceRecord, WorkspaceRecord } from "../core/models";
import { daemonSocketPath } from "../core/ipc";

const ANSI = {
  blue: "\u001b[34m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  gray: "\u001b[90m",
  green: "\u001b[32m",
  magenta: "\u001b[35m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m"
} as const;

/** Format the daemon health line shared by CLI status and dashboard summaries. */
export function formatDaemonHealth(snapshot: StatusSnapshot): string {
  const socketPath = snapshot.daemon?.socketPath ?? daemonSocketPath(snapshot.root);
  return `daemon ${snapshot.daemonHealthy ? "up" : "down"} ${socketPath}`;
}

/** Format the shared repository context line for operator-facing views. */
export function formatStatusContext(snapshot: StatusSnapshot): string {
  return `operator ${snapshot.operatorSlug} remote ${snapshot.config.coordinationRemote} base ${snapshot.syncBranch}`;
}

/** Format the common workspace summary text shared by CLI status and dashboard views. */
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

/** Render a compact status table for the CLI. */
export function formatStatusTable(workspaces: StatusWorkspaceRecord[]): string[] {
  const rows = workspaces.map((workspace) => ({
    agent: workspace.agentId,
    state: `[${workspace.state}]`,
    commits: String(workspace.commitCount),
    lastCommit: `${workspace.lastCommitShortSha} ${workspace.lastCommitSubject}`,
    stateStyle: stateColor(workspace.state),
    commitsStyle: workspace.commitCount > 0 ? ANSI.blue : ANSI.gray
  }));
  const widths = {
    agent: Math.max("AGENT".length, ...rows.map((row) => row.agent.length)),
    state: Math.max("STATE".length, ...rows.map((row) => row.state.length)),
    commits: Math.max("COMMITS".length, ...rows.map((row) => row.commits.length)),
    lastCommit: Math.max("LAST COMMIT".length, ...rows.map((row) => row.lastCommit.length))
  };

  const header = [
    colorize(padCell("AGENT", widths.agent), ANSI.bold, ANSI.cyan),
    colorize(padCell("STATE", widths.state), ANSI.bold, ANSI.green),
    colorize(padCell("COMMITS", widths.commits), ANSI.bold, ANSI.blue),
    colorize(padCell("LAST COMMIT", widths.lastCommit), ANSI.bold, ANSI.magenta)
  ].join(" | ");
  const divider = [
    "-".repeat(widths.agent),
    "-".repeat(widths.state),
    "-".repeat(widths.commits),
    "-".repeat(widths.lastCommit)
  ].join("-+-");

  return [
    header,
    divider,
    ...rows.map((row) =>
      [
        colorize(padCell(row.agent, widths.agent), ANSI.cyan),
        colorize(padCell(row.state, widths.state), row.stateStyle),
        colorize(padCell(row.commits, widths.commits), row.commitsStyle),
        colorize(padCell(row.lastCommit, widths.lastCommit), ANSI.magenta)
      ].join(" | ")
    )
  ];
}

/** Pad one fixed-width table cell for CLI output. */
function padCell(value: string, width: number): string {
  return value.padEnd(width, " ");
}

/** Wrap one table cell in ANSI styles without changing its visible width. */
function colorize(value: string, ...styles: string[]): string {
  return `${styles.join("")}${value}${ANSI.reset}`;
}

/** Return the display color for one workspace state. */
function stateColor(state: WorkspaceRecord["state"]): string {
  switch (state) {
    case "active":
      return ANSI.green;
    case "idle":
      return ANSI.yellow;
    case "failed":
      return ANSI.red;
    case "stopped":
      return ANSI.gray;
    case "starting":
      return ANSI.blue;
    case "stopping":
      return ANSI.magenta;
  }
}
