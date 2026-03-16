/** Local workspace creation, hook installation, and tmux management. */

import { basename, join } from "node:path";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";

import type { RevisConfig, WorkspaceRecord } from "../core/models";
import { RevisError } from "../core/error";
import { ensureDir, pathExists } from "../core/files";
import { runCommand, runInteractive, shellJoin, sleep } from "../core/process";
import { sha256Text } from "../core/text";
import { isoNow } from "../core/time";
import { appendMissingLines } from "../core/text-files";
import {
  appendEvent,
  deleteActivitySnapshot,
  deleteWorkspaceRecord,
  loadWorkspaceRecords,
  writeActivitySnapshot,
  writeWorkspaceRecord
} from "./runtime";
import { renderHookClientSource } from "./hook-client-source";
import {
  cloneWorkspaceRepo,
  currentBranch,
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
const CODEX_INTERRUPT_TIMEOUT_MS = 5_000;
const CODEX_INTERRUPT_POLL_MS = 250;
const CODEX_INTERRUPT_SETTLE_MS = 250;
const CODEX_POST_TYPE_SETTLE_MS = 150;
const CODEX_STATUS_TAIL_LINES = 8;

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

/** Allocate the next available agent ids, reusing gaps left by stopped workspaces. */
export async function allocateAgentIds(
  root: string,
  count: number
): Promise<string[]> {
  const used = new Set(
    (await loadWorkspaceRecords(root)).flatMap((record) => {
      const match = /^agent-(\d+)$/.exec(record.agentId);
      return match ? [Number(match[1])] : [];
    })
  );

  const agentIds: string[] = [];
  for (let value = 1; agentIds.length < count; value += 1) {
    if (used.has(value)) {
      continue;
    }

    agentIds.push(`agent-${value}`);
  }

  return agentIds;
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

/** Run one operator-supplied command in newly created tmux-backed workspaces. */
export async function runCommandInWorkspaces(
  root: string,
  records: WorkspaceRecord[],
  command: string
): Promise<void> {
  const expectedCommand = expectedPaneCommand(command);

  for (const record of records) {
    if (expectedCommand) {
      record.expectedPaneCommand = expectedCommand;
    } else {
      delete record.expectedPaneCommand;
    }
    await startWorkspaceCommand(record, command);
    await persistWorkspaceTransition(root, record, {
      state: "active",
      summary: `Started command in ${record.agentId}`,
      type: "workspace_started"
    });
  }
}

/** Stop tmux sessions, delete workspace clones, and clear runtime state. */
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
    await deleteWorkspaceRecord(root, record.agentId);
    await deleteActivitySnapshot(root, record.agentId);
  }
}

/** Refresh workspace health plus latest git state derived from tmux and the repo. */
export async function refreshWorkspaceRecord(
  root: string,
  record: WorkspaceRecord
): Promise<WorkspaceRecord> {
  await updateWorkspaceSessionState(record);

  if (await pathExists(record.repoPath)) {
    record.lastCommitSha = await currentHeadSha(record.repoPath);
    record.localBranch = await currentBranch(record.repoPath);

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

/** Return the current foreground command running inside one workspace pane. */
export async function workspacePaneCommand(record: WorkspaceRecord): Promise<string> {
  const output = await runCommand([
    "tmux",
    "display-message",
    "-p",
    "-t",
    `${record.tmuxSession}:0`,
    "#{pane_current_command}"
  ]);
  return output.stdout.trim();
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

  if (await workspaceAcceptsSteeringMessages(record)) {
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

  record.state = (await workspaceAcceptsSteeringMessages(record)) ? "active" : "idle";
}

/** Write one workspace's local metadata and commit hook files. */
async function installWorkspaceFiles(
  repoPath: string,
  agentId: string,
  coordinationBranch: string,
  socketPath: string
): Promise<void> {
  await ensureDir(join(repoPath, ".revis"));
  await writeFile(
    workspaceMetaPath(repoPath),
    `${JSON.stringify({ agentId, coordinationBranch }, null, 2)}\n`,
    "utf8"
  );
  await installHookClient(repoPath, agentId, socketPath);
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
  socketPath: string
): Promise<void> {
  const revisDir = join(repoPath, ".revis");
  const hookClientPath = join(revisDir, HOOK_CLIENT_NAME);
  const hookPath = join(repoPath, ".git", "hooks", "post-commit");
  await writeFile(
    hookClientPath,
    renderHookClientSource(agentId, socketPath),
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
  coordinationBranch: string;
  headSha: string;
  localBranch: string;
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
    prepared.coordinationBranch,
    prepared.localBranch,
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
  const coordinationBranch = workspaceBranch(operatorSlug, agentId);

  // Start from a fresh disposable clone every time this workspace is created.
  await rm(join(root, WORKSPACES_DIR, agentId), { recursive: true, force: true });

  // Recreate the clone and branch from the shared sync target.
  await cloneWorkspaceRepo(remoteUrlValue, remoteName, syncBranch, repoPath);
  await createBranchFromRemote(repoPath, remoteName, coordinationBranch, syncBranch);
  await setGitIdentity(
    repoPath,
    `${operatorSlug}-${agentId}`,
    workspaceEmail(operatorSlug, agentId)
  );

  // Install the commit hook and the owning tmux session.
  await installWorkspaceFiles(repoPath, agentId, coordinationBranch, socketPath);
  await startWorkspaceTmux(root, repoPath, agentId);

  const headSha = await currentHeadSha(repoPath);
  const localBranch = await currentBranch(repoPath);
  await writeLastRelayedSha(repoPath, headSha);

  return {
    coordinationBranch,
    headSha,
    localBranch,
    repoPath
  };
}

/** Build the persisted runtime record for one newly created workspace. */
function buildWorkspaceRecord(
  root: string,
  operatorSlug: string,
  agentId: string,
  coordinationBranch: string,
  localBranch: string,
  repoPath: string,
  headSha: string
): WorkspaceRecord {
  const tmuxSession = tmuxSessionName(root, agentId);
  return {
    agentId,
    operatorSlug,
    coordinationBranch,
    localBranch,
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
    branch: record.coordinationBranch,
    summary: `Created ${record.agentId} on ${record.coordinationBranch}`
  });
}

/** Deliver every queued steering message once the workspace is running a foreground program. */
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

  if (!(await workspaceAcceptsSteeringMessages(record))) {
    return;
  }

  for (const message of record.queuedSteeringMessages) {
    await deliverSteeringMessage(record, message);
  }

  delete record.queuedSteeringMessages;
  delete record.lastError;
  await writeWorkspaceRecord(root, record);
}

/** Persist one steering message until the workspace is ready to receive it. */
async function queueSteeringMessage(
  root: string,
  record: WorkspaceRecord,
  message: string
): Promise<void> {
  record.queuedSteeringMessages = [...(record.queuedSteeringMessages ?? []), message];
  await writeWorkspaceRecord(root, record);
}

/** Return whether the workspace pane is running something other than its login shell. */
async function workspaceAcceptsSteeringMessages(record: WorkspaceRecord): Promise<boolean> {
  const expected = record.expectedPaneCommand ?? (await inferredPaneCommand(record));
  if (!expected) {
    return false;
  }

  const commands = await workspaceProcessCommands(record);
  return commands.some((command) => commandLineMatchesExpected(command, expected));
}

/** Type one steering message into the active workspace pane. */
async function deliverSteeringMessage(
  record: WorkspaceRecord,
  message: string
): Promise<void> {
  await typeSteeringMessage(record, message);

  const agent = relayAgentAdapter(record);
  if (agent !== "codex") {
    await submitSteeringMessage(record, "Enter");
    return;
  }

  await sleep(CODEX_POST_TYPE_SETTLE_MS);

  const lines = await currentPaneLines(record);
  if (!codexNeedsQueuedMessage(lines)) {
    await submitSteeringMessage(record, "Enter");
    return;
  }

  if (await interruptCodexTurn(record)) {
    await sleep(CODEX_INTERRUPT_SETTLE_MS);
    await submitSteeringMessage(record, "Enter");
    return;
  }

  await submitSteeringMessage(record, "Tab");
}

/** Type one steering message into the active workspace pane without submitting it. */
async function typeSteeringMessage(
  record: WorkspaceRecord,
  message: string
): Promise<void> {
  await runCommand([
    "tmux",
    "send-keys",
    "-t",
    `${record.tmuxSession}:0`,
    "-l",
    message
  ]);
}

/** Submit the current steering message draft with one tmux keypress. */
async function submitSteeringMessage(
  record: WorkspaceRecord,
  submitKey: "Enter" | "Tab"
): Promise<void> {
  await runCommand([
    "tmux",
    "send-keys",
    "-t",
    `${record.tmuxSession}:0`,
    submitKey
  ]);
}

/** Interrupt Codex's current turn so a relay can land as a real user message. */
async function interruptCodexTurn(record: WorkspaceRecord): Promise<boolean> {
  const deadline = Date.now() + CODEX_INTERRUPT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await runCommand([
      "tmux",
      "send-keys",
      "-t",
      `${record.tmuxSession}:0`,
      "Escape"
    ]);

    await sleep(CODEX_INTERRUPT_POLL_MS);

    const lines = await currentPaneLines(record);
    if (!codexNeedsQueuedMessage(lines)) {
      return true;
    }
  }

  return false;
}

/** Start one operator command in a fresh pane that returns to a login shell on exit. */
async function startWorkspaceCommand(
  record: WorkspaceRecord,
  command: string
): Promise<void> {
  const shell = process.env.SHELL ?? "/bin/sh";
  const resumeShell = shellJoin([shell, "-l"]);
  await runCommand([
    "tmux",
    "respawn-pane",
    "-k",
    "-t",
    `${record.tmuxSession}:0`,
    "-c",
    record.repoPath,
    shell,
    "-lc",
    `${command}; exec ${resumeShell}`
  ]);
}

/** Infer the foreground command name tmux should report for one launched shell command. */
function expectedPaneCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  const tokens = trimmed.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  for (const token of tokens) {
    if (token === "exec") {
      continue;
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }

    return basename(token.replace(/^['"]|['"]$/g, ""));
  }

  return undefined;
}

/** Return the pane shell plus any descendant process command lines for one workspace. */
async function workspaceProcessCommands(record: WorkspaceRecord): Promise<string[]> {
  const panePid = await workspacePanePid(record);
  const descendantPids = await collectDescendantPids(panePid);
  const commands = [await workspacePaneCommand(record)];

  for (const pid of descendantPids) {
    commands.push(await processCommandLine(pid));
  }

  return commands;
}

/** Capture the visible pane text without mutating persisted activity snapshots. */
async function currentPaneLines(record: WorkspaceRecord): Promise<string[]> {
  const output = await runCommand([
    "tmux",
    "capture-pane",
    "-t",
    `${record.tmuxSession}:0`,
    "-p"
  ]);

  return output.stdout.replaceAll("\r", "").split(/\r?\n/).filter(Boolean);
}

/** Return the known relay adapter for the current pane command, if any. */
function relayAgentAdapter(record: WorkspaceRecord): "claude" | "codex" | undefined {
  switch (record.expectedPaneCommand) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    default:
      return undefined;
  }
}

/** Return whether the visible Codex UI expects Tab to queue a busy-session message. */
function codexNeedsQueuedMessage(lines: string[]): boolean {
  return lines
    .slice(-CODEX_STATUS_TAIL_LINES)
    .some((line) => line.toLowerCase().includes("tab to queue message"));
}

/** Return the tmux pane PID for one workspace session. */
async function workspacePanePid(record: WorkspaceRecord): Promise<number> {
  const output = await runCommand([
    "tmux",
    "display-message",
    "-p",
    "-t",
    `${record.tmuxSession}:0`,
    "#{pane_pid}"
  ]);
  return Number(output.stdout.trim());
}

/** Collect every descendant process pid rooted under one tmux pane shell. */
async function collectDescendantPids(parentPid: number): Promise<number[]> {
  const seen = new Set<number>();
  const queue = [parentPid];
  const descendants: number[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = await childPids(current);

    for (const child of children) {
      if (seen.has(child)) {
        continue;
      }

      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }

  return descendants;
}

/** Return the direct child pids for one process. */
async function childPids(parentPid: number): Promise<number[]> {
  const result = await runCommand(["pgrep", "-P", String(parentPid)], {
    check: false
  });
  if (result.exitCode === 1) {
    return [];
  }

  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "pgrep failed";
    throw new RevisError(message);
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => Number(line));
}

/** Return one process command line from the local process table. */
async function processCommandLine(pid: number): Promise<string> {
  const output = await runCommand(["ps", "-o", "command=", "-p", String(pid)], {
    check: false
  });
  if (output.exitCode !== 0) {
    return "";
  }

  return output.stdout.trim();
}

/** Return whether a process command line contains the launched program token. */
function commandLineMatchesExpected(commandLine: string, expected: string): boolean {
  if (commandLine === expected) {
    return true;
  }

  const tokens = commandLine.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  return tokens.some((token) => basename(token.replace(/^['"]|['"]$/g, "")) === expected);
}

/** Infer the launched pane command from tmux when runtime metadata is missing it. */
async function inferredPaneCommand(record: WorkspaceRecord): Promise<string | undefined> {
  return expectedPaneCommand(await workspaceLaunchCommand(record));
}

/** Return the command string Revis asked tmux to run for one pane, when recognizable. */
async function workspaceLaunchCommand(record: WorkspaceRecord): Promise<string> {
  const output = await runCommand([
    "tmux",
    "display-message",
    "-p",
    "-t",
    `${record.tmuxSession}:0`,
    "#{pane_start_command}"
  ]);
  const startCommand = output.stdout.trim();
  const shellIndex = startCommand.indexOf("-lc ");
  const resumeIndex = startCommand.lastIndexOf("; exec ");

  if (shellIndex < 0 || resumeIndex < 0 || resumeIndex <= shellIndex + 4) {
    return "";
  }

  return startCommand
    .slice(shellIndex + 4, resumeIndex)
    .trim()
    .replace(/^['"]|['"]$/g, "");
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
    branch: record.coordinationBranch,
    summary: transition.summary
  });
}
