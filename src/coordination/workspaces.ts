/** Local workspace creation, hook installation, and tmux management. */

import { join } from "node:path";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";

import type { RevisConfig, WorkspaceRecord } from "../core/models";
import { RevisError } from "../core/error";
import { ensureDir, pathExists } from "../core/files";
import { runCommand, runInteractive, shellJoin, substituteArgv } from "../core/process";
import { templateExecutable } from "../core/templates";
import { sha256Text } from "../core/text";
import { isoNow } from "../core/time";
import { appendMissingLines } from "../core/text-files";
import {
  appendEvent,
  loadWorkspaceRecords,
  writeActivitySnapshot,
  writeWorkspaceRecord
} from "./runtime";
import { renderHookClientSource } from "./hook-client-source";
import {
  cloneWorkspaceRepo,
  createBranchFromRemote,
  currentHeadSha,
  deriveOperatorSlug,
  remoteUrl,
  setGitIdentity,
  syncTargetBranch,
  workspaceBranch,
  workspaceEmail
} from "./repo";

const WORKSPACES_DIR = join(".revis", "workspaces");
const HOOK_CLIENT_NAME = "hook-client.cjs";

/** Return the path to one workspace clone. */
export function workspaceRepoPath(root: string, agentId: string): string {
  return join(root, WORKSPACES_DIR, agentId, "repo");
}

/** Return the path to one workspace metadata file inside the clone. */
export function workspaceMetaPath(repoPath: string): string {
  return join(repoPath, ".revis", "agent.json");
}

/** Return the path to the workspace relay marker file. */
export function lastRelayedShaPath(repoPath: string): string {
  return join(repoPath, ".revis", "last-relayed-sha");
}

/** Return the tmux session name for one workspace. */
export function tmuxSessionName(root: string, agentId: string): string {
  return `revis-${sha256Text(root).slice(0, 8)}-${agentId}`;
}

/** Allocate the next available agent ids. */
export async function allocateAgentIds(
  root: string,
  count: number
): Promise<string[]> {
  const existing = await loadWorkspaceRecords(root);
  const next = existing.reduce((maxValue, record) => {
    const match = /^agent-(\d+)$/.exec(record.agentId);
    return Math.max(maxValue, match ? Number(match[1]) : 0);
  }, 0);

  return Array.from({ length: count }, (_, index) => `agent-${next + index + 1}`);
}

/** Create `count` new workspaces and return their runtime records. */
export async function createWorkspaces(
  root: string,
  config: RevisConfig,
  count: number,
  socketPath: string
): Promise<WorkspaceRecord[]> {
  const remoteName = config.coordinationRemote;
  const remoteUrlValue = await remoteUrl(root, remoteName);
  const operatorSlug = await deriveOperatorSlug(root);
  const syncBranch = syncTargetBranch(remoteName, config.trunkBase);
  const agentIds = await allocateAgentIds(root, count);

  const created: WorkspaceRecord[] = [];
  for (const agentId of agentIds) {
    created.push(
      await createWorkspace(
        root,
        remoteName,
        remoteUrlValue,
        syncBranch,
        operatorSlug,
        agentId,
        socketPath
      )
    );
  }

  return created;
}

/** Launch Codex in one or more existing tmux-backed workspaces. */
export async function launchCodexInWorkspaces(
  root: string,
  config: RevisConfig,
  records: WorkspaceRecord[]
): Promise<void> {
  if (templateExecutable(config.codexTemplate.argv) !== "codex") {
    throw new Error("Unsupported agent executable. Revis currently only launches Codex.");
  }

  await runCommand(["codex", "login", "status"]);

  for (const record of records) {
    const command = shellJoin(substituteArgv(config.codexTemplate.argv, {}));
    await resetWorkspacePane(record);
    await runCommand([
      "tmux",
      "send-keys",
      "-t",
      `${record.tmuxSession}:0`,
      command,
      "Enter"
    ]);
    await persistWorkspaceTransition(root, record, {
      state: "active",
      summary: `Launched Codex in ${record.agentId}`,
      type: "workspace_started"
    });
  }
}

/** Stop tmux sessions and delete workspace clones. */
export async function stopWorkspaces(
  root: string,
  records: WorkspaceRecord[]
): Promise<void> {
  for (const record of records) {
    await stopWorkspaceSession(record);
    await rm(join(root, WORKSPACES_DIR, record.agentId), {
      recursive: true,
      force: true
    });
    await persistWorkspaceTransition(root, record, {
      state: "stopped",
      summary: `Stopped ${record.agentId}`,
      type: "workspace_stopped"
    });
  }
}

/** Refresh workspace health and latest commit data from tmux/git. */
export async function refreshWorkspaceRecord(
  root: string,
  record: WorkspaceRecord
): Promise<WorkspaceRecord> {
  await updateWorkspaceSessionState(record);

  if (await pathExists(record.repoPath)) {
    record.lastCommitSha = await currentHeadSha(record.repoPath);
    const relayedSha = await readLastRelayedSha(record.repoPath);
    if (relayedSha) {
      record.lastRelayedSha = relayedSha;
    }
  }

  await flushQueuedSteeringMessages(root, record);

  await writeWorkspaceRecord(root, record);
  return record;
}

/** Refresh runtime records and activity snapshots for a workspace set. */
export async function refreshWorkspaceSnapshots(
  root: string,
  records: WorkspaceRecord[]
): Promise<WorkspaceRecord[]> {
  for (const record of records) {
    await refreshWorkspaceRecord(root, record);
    await captureWorkspaceActivity(root, record);
  }

  return records;
}

/** Capture recent terminal output for a workspace. */
export async function captureWorkspaceActivity(
  root: string,
  record: WorkspaceRecord
): Promise<string[]> {
  if (!(await tmuxSessionExists(record.tmuxSession))) {
    await writeActivitySnapshot(root, record.agentId, []);
    return [];
  }

  const completed = await runCommand(
    ["tmux", "capture-pane", "-t", `${record.tmuxSession}:0`, "-p"],
    { check: false }
  );
  if (completed.exitCode !== 0) {
    const message =
      completed.stderr.trim() || completed.stdout.trim() || "tmux capture-pane failed";
    throw new RevisError(`${record.tmuxSession}:0 activity capture failed: ${message}`);
  }

  const lines = completed.stdout.replaceAll("\r", "").split(/\r?\n/).filter(Boolean);
  await writeActivitySnapshot(root, record.agentId, lines);
  return lines;
}

/** Read the workspace's persisted last-relayed marker. */
export async function readLastRelayedSha(repoPath: string): Promise<string> {
  return (await readFile(lastRelayedShaPath(repoPath), "utf8")).trim();
}

/** Persist the workspace's last-relayed marker. */
export async function writeLastRelayedSha(
  repoPath: string,
  sha: string
): Promise<void> {
  await writeFile(lastRelayedShaPath(repoPath), `${sha}\n`, "utf8");
}

/** Return whether a workspace session is currently running Codex. */
export async function workspaceRunsCodex(record: WorkspaceRecord): Promise<boolean> {
  const output = await runCommand([
    "tmux",
    "display-message",
    "-p",
    "-t",
    `${record.tmuxSession}:0`,
    "#{pane_current_command}"
  ]);
  return output.stdout.trim() === "codex";
}

/** Return whether a tmux session currently exists. */
export async function tmuxSessionExists(session: string): Promise<boolean> {
  const result = await runCommand(["tmux", "has-session", "-t", session], {
    check: false
  });
  if (result.exitCode === 0) {
    return true;
  }

  const message = result.stderr.trim();
  if (result.exitCode === 1 && message.includes("can't find session")) {
    return false;
  }

  throw new RevisError(message || result.stdout.trim() || "tmux has-session failed");
}

/** Attach the current terminal to one workspace session. */
export async function attachWorkspace(record: WorkspaceRecord): Promise<void> {
  await runInteractive(record.attachCmd);
}

/** Send a steering message into one workspace session. */
export async function sendSteeringMessage(
  root: string,
  record: WorkspaceRecord,
  message: string
): Promise<void> {
  if (!(await tmuxSessionExists(record.tmuxSession))) {
    record.lastError = `Missing tmux session ${record.tmuxSession}`;
    await queueSteeringMessage(root, record, message);
    return;
  }

  if (await workspaceRunsCodex(record)) {
    await flushQueuedSteeringMessages(root, record);
    await deliverSteeringMessage(record, message);
    return;
  }

  await queueSteeringMessage(root, record, message);
}

/** Refresh the runtime state derived from the workspace tmux session. */
async function updateWorkspaceSessionState(record: WorkspaceRecord): Promise<void> {
  if (!(await tmuxSessionExists(record.tmuxSession))) {
    record.state = "stopped";
    return;
  }

  record.state = record.state === "active" ? "active" : "idle";
}

/** Write one workspace's local metadata and commit hook files. */
async function installWorkspaceFiles(
  repoPath: string,
  agentId: string,
  branch: string,
  socketPath: string
): Promise<void> {
  await ensureDir(join(repoPath, ".revis"));
  await writeFile(
    workspaceMetaPath(repoPath),
    `${JSON.stringify({ agentId, branch }, null, 2)}\n`,
    "utf8"
  );
  await installHookClient(repoPath, agentId, branch, socketPath);
  await appendInfoExclude(repoPath, [
    ".revis/agent.json",
    ".revis/last-relayed-sha",
    `.revis/${HOOK_CLIENT_NAME}`
  ]);
}

/** Install the hook client and shell wrapper for one workspace clone. */
async function installHookClient(
  repoPath: string,
  agentId: string,
  branch: string,
  socketPath: string
): Promise<void> {
  const revisDir = join(repoPath, ".revis");
  const hookClientPath = join(revisDir, HOOK_CLIENT_NAME);
  const hookPath = join(repoPath, ".git", "hooks", "post-commit");
  await writeFile(
    hookClientPath,
    renderHookClientSource(agentId, branch, socketPath),
    "utf8"
  );
  await writeFile(
    hookPath,
    `#!/bin/sh\n${shellJoin([process.execPath, `.revis/${HOOK_CLIENT_NAME}`])}\n`,
    "utf8"
  );
  await chmod(hookPath, 0o755);
}

/** Append workspace-local excludes without disturbing existing patterns. */
async function appendInfoExclude(repoPath: string, patterns: string[]): Promise<void> {
  const path = join(repoPath, ".git", "info", "exclude");
  await appendMissingLines(path, patterns);
}

/** Start the tmux session that owns one workspace shell. */
async function startWorkspaceTmux(
  root: string,
  repoPath: string,
  agentId: string
): Promise<void> {
  const session = tmuxSessionName(root, agentId);
  const shell = process.env.SHELL ?? "/bin/sh";
  await runCommand(["tmux", "kill-session", "-t", session], { check: false });
  await runCommand([
    "tmux",
    "new-session",
    "-d",
    "-s",
    session,
    "-c",
    repoPath,
    shellJoin([shell, "-l"])
  ]);
}

interface PreparedWorkspaceRepo {
  branch: string;
  headSha: string;
  repoPath: string;
}

/** Materialize one workspace clone, hook, tmux session, and runtime record. */
async function createWorkspace(
  root: string,
  remoteName: string,
  remoteUrlValue: string,
  syncBranch: string,
  operatorSlug: string,
  agentId: string,
  socketPath: string
): Promise<WorkspaceRecord> {
  const prepared = await prepareWorkspaceRepo(
    root,
    remoteName,
    remoteUrlValue,
    syncBranch,
    operatorSlug,
    agentId,
    socketPath
  );
  const record = buildWorkspaceRecord(
    root,
    operatorSlug,
    agentId,
    prepared.branch,
    prepared.repoPath,
    prepared.headSha
  );
  await recordWorkspaceCreation(root, record);
  return record;
}

/** Prepare the clone, branch, hook, and tmux session for one new workspace. */
async function prepareWorkspaceRepo(
  root: string,
  remoteName: string,
  remoteUrlValue: string,
  syncBranch: string,
  operatorSlug: string,
  agentId: string,
  socketPath: string
): Promise<PreparedWorkspaceRepo> {
  const repoPath = workspaceRepoPath(root, agentId);
  const branch = workspaceBranch(operatorSlug, agentId);

  // Start from a fresh disposable clone every time this workspace is created.
  await rm(join(root, WORKSPACES_DIR, agentId), { recursive: true, force: true });

  // Recreate the clone and branch from the shared sync target.
  await cloneWorkspaceRepo(remoteUrlValue, remoteName, syncBranch, repoPath);
  await createBranchFromRemote(repoPath, remoteName, branch, syncBranch);
  await setGitIdentity(
    repoPath,
    `${operatorSlug}-${agentId}`,
    workspaceEmail(operatorSlug, agentId)
  );

  // Install the commit hook and the owning tmux session.
  await installWorkspaceFiles(repoPath, agentId, branch, socketPath);
  await startWorkspaceTmux(root, repoPath, agentId);

  const headSha = await currentHeadSha(repoPath);
  await writeLastRelayedSha(repoPath, headSha);

  return {
    branch,
    headSha,
    repoPath
  };
}

/** Build the persisted runtime record for one newly created workspace. */
function buildWorkspaceRecord(
  root: string,
  operatorSlug: string,
  agentId: string,
  branch: string,
  repoPath: string,
  headSha: string
): WorkspaceRecord {
  const tmuxSession = tmuxSessionName(root, agentId);
  return {
    agentId,
    operatorSlug,
    branch,
    repoPath,
    tmuxSession,
    state: "idle",
    createdAt: isoNow(),
    attachCmd: ["tmux", "attach", "-t", `${tmuxSession}:0`],
    attachLabel: `${tmuxSession}:0`,
    lastCommitSha: headSha,
    lastRelayedSha: headSha,
    lastPushedSha: headSha,
    lastSeenRemoteSha: headSha,
    lastRebasedOntoSha: headSha
  };
}

/** Persist the initial record and creation event for one workspace. */
async function recordWorkspaceCreation(
  root: string,
  record: WorkspaceRecord
): Promise<void> {
  await writeWorkspaceRecord(root, record);
  await appendEvent(root, {
    timestamp: isoNow(),
    type: "workspace_created",
    agentId: record.agentId,
    branch: record.branch,
    summary: `Created ${record.agentId} on ${record.branch}`
  });
}

/** Deliver every queued steering message once Codex regains the terminal. */
async function flushQueuedSteeringMessages(
  root: string,
  record: WorkspaceRecord
): Promise<void> {
  if (!record.queuedSteeringMessages || record.queuedSteeringMessages.length === 0) {
    return;
  }

  if (!(await tmuxSessionExists(record.tmuxSession))) {
    return;
  }

  if (!(await workspaceRunsCodex(record))) {
    return;
  }

  for (const message of record.queuedSteeringMessages) {
    await deliverSteeringMessage(record, message);
  }

  delete record.queuedSteeringMessages;
  delete record.lastError;
  await writeWorkspaceRecord(root, record);
}

/** Persist one steering message until the workspace is back in Codex. */
async function queueSteeringMessage(
  root: string,
  record: WorkspaceRecord,
  message: string
): Promise<void> {
  record.queuedSteeringMessages = [...(record.queuedSteeringMessages ?? []), message];
  await writeWorkspaceRecord(root, record);
}

/** Type one steering message into the active Codex pane. */
async function deliverSteeringMessage(
  record: WorkspaceRecord,
  message: string
): Promise<void> {
  await runCommand([
    "tmux",
    "send-keys",
    "-t",
    `${record.tmuxSession}:0`,
    message,
    "Enter"
  ]);
}

/** Reset one workspace pane to a clean login shell before launching Codex. */
async function resetWorkspacePane(record: WorkspaceRecord): Promise<void> {
  const shell = process.env.SHELL ?? "/bin/sh";
  await runCommand([
    "tmux",
    "respawn-pane",
    "-k",
    "-t",
    `${record.tmuxSession}:0`,
    "-c",
    record.repoPath,
    shell,
    "-l"
  ]);
}

/** Stop one workspace tmux session without hiding real tmux failures. */
async function stopWorkspaceSession(record: WorkspaceRecord): Promise<void> {
  if (!(await tmuxSessionExists(record.tmuxSession))) {
    return;
  }

  await runCommand(["tmux", "kill-session", "-t", record.tmuxSession]);
}

/** Persist one workspace state transition plus its matching runtime event. */
async function persistWorkspaceTransition(
  root: string,
  record: WorkspaceRecord,
  transition: {
    state: WorkspaceRecord["state"];
    summary: string;
    type: "workspace_started" | "workspace_stopped";
  }
): Promise<void> {
  record.state = transition.state;
  delete record.lastError;
  await writeWorkspaceRecord(root, record);
  await appendEvent(root, {
    timestamp: isoNow(),
    type: transition.type,
    agentId: record.agentId,
    branch: record.branch,
    summary: transition.summary
  });
}
