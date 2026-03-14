/** Host daemon for commit relay, remote sync, and workspace rebasing. */

import net from "node:net";
import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";

import type {
  CommitNotification,
  CommitSummary,
  DaemonRecord,
  RelayRegistry,
  RevisConfig,
  WorkspaceRecord
} from "../core/models";
import { loadConfig } from "../core/config";
import { RevisError } from "../core/error";
import { pathExists } from "../core/files";
import { daemonSocketPath, removeSocketPath } from "../core/ipc";
import {
  currentRevisCommand,
  runCommand,
  spawnReadyProcess
} from "../core/process";
import { isoNow } from "../core/time";
import {
  appendEvent,
  deleteDaemonRecord,
  loadDaemonRecord,
  loadRelayRegistry,
  loadWorkspaceRecords,
  writeDaemonRecord,
  writeRelayRegistry,
  writeWorkspaceRecord
} from "./runtime";
import {
  commitSummaryForRef,
  currentHeadSha,
  deriveOperatorSlug,
  fetchCoordinationRefs,
  fetchRemoteRefs,
  gitClient,
  listRemoteWorkspaceHeads,
  pushBranch,
  remoteTrackingRef,
  syncTargetBranch
} from "./repo";
import {
  refreshWorkspaceSnapshots,
  sendSteeringMessage,
  readLastRelayedSha,
  writeLastRelayedSha
} from "./workspaces";

const START_TIMEOUT_MS = 10_000;
const SOCKET_CONNECT_TIMEOUT_MS = 400;
const DAEMON_READY_LINE = "REVIS_DAEMON_READY";
const EXPECTED_SOCKET_CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "ENOTSOCK"
]);

export interface DaemonCycleReason {
  notification: CommitNotification;
}

/** Return whether a daemon IPC endpoint already accepts connections. */
export async function daemonSocketReady(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);

    const done = (ready: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };

    socket.setTimeout(SOCKET_CONNECT_TIMEOUT_MS, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && EXPECTED_SOCKET_CONNECT_ERRORS.has(code)) {
        done(false);
        return;
      }

      socket.removeAllListeners();
      socket.destroy();
      reject(error);
    });
  });
}

/** Return whether the persisted daemon record still points at a live process. */
export function daemonProcessAlive(record: DaemonRecord): boolean {
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }

    throw error;
  }
}

/** Start the host daemon when it is not already running. */
export async function ensureDaemonRunning(root: string): Promise<DaemonRecord> {
  const socketPath = daemonSocketPath(root);

  if (await daemonSocketReady(socketPath)) {
    const existing = await loadDaemonRecord(root);
    if (!existing) {
      throw new RevisError(
        `Revis daemon socket ${socketPath} is live but daemon.json is missing`
      );
    }

    return existing;
  }

  const existing = await loadDaemonRecord(root);
  if (existing && daemonProcessAlive(existing)) {
    throw new RevisError(
      `Revis daemon process ${existing.pid} is alive but socket ${existing.socketPath} is unavailable`
    );
  }

  if (existing) {
    await removeSocketPath(existing.socketPath);
    await deleteDaemonRecord(root);
  }

  const argv = [...currentRevisCommand(), "_daemon-run", "--root", root];
  await spawnReadyProcess(argv, {
    cwd: root,
    env: {
      ...process.env,
      REVIS_DAEMON_READY_STDOUT: "1"
    },
    readyLine: DAEMON_READY_LINE,
    timeoutMs: START_TIMEOUT_MS
  });
  return (await loadDaemonRecord(root))!;
}

/** Send one request to the daemon and wait for its socket response. */
async function sendDaemonRequest(
  socketPath: string,
  notification: CommitNotification
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(socketPath, () => {
      socket.end(`${JSON.stringify(notification)}\n`);
    });

    let response = "";

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    socket.setTimeout(SOCKET_CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      settle(() =>
        reject(new RevisError(`Timed out writing to daemon socket ${socketPath}`))
      );
    });

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });

    socket.on("error", (error) => {
      settle(() => reject(error));
    });

    socket.on("close", () => {
      settle(() => resolve(response.trim()));
    });
  });
}

/** Ask the daemon to run an immediate sync cycle. */
export async function notifyDaemon(
  root: string,
  notification: CommitNotification
): Promise<void> {
  const socketPath = daemonSocketPath(root);
  if (!(await daemonSocketReady(socketPath))) {
    await ensureDaemonRunning(root);
  }

  await sendDaemonRequest(socketPath, notification);
}

/** Stop the daemon process when it is running. */
export async function stopDaemon(root: string): Promise<void> {
  const record = await loadDaemonRecord(root);
  if (!record) {
    await removeSocketPath(daemonSocketPath(root));
    return;
  }

  if (await daemonSocketReady(record.socketPath)) {
    await sendDaemonRequest(record.socketPath, {
      type: "shutdown",
      reason: "stop"
    });
    return;
  }

  if (daemonProcessAlive(record)) {
    throw new RevisError(
      `Revis daemon process ${record.pid} is alive but socket ${record.socketPath} is unavailable`
    );
  }

  await removeSocketPath(record.socketPath);
  await deleteDaemonRecord(root);
}

/** Long-running daemon process used by the hidden CLI command. */
export class RevisDaemon {
  readonly root: string;
  readonly config: RevisConfig;
  readonly socketPath: string;
  readonly syncBranch: string;

  private readonly operatorSlugPromise: Promise<string>;
  private readonly pendingNotifications: CommitNotification[] = [];
  private server: net.Server | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private syncInFlight = false;
  private syncQueued = false;
  private idleResolver: (() => void) | null = null;

  /** Build a daemon instance for one initialized project. */
  constructor(root: string, config: RevisConfig) {
    this.root = root;
    this.config = config;
    this.socketPath = daemonSocketPath(root);
    this.syncBranch = syncTargetBranch(
      config.coordinationRemote,
      config.trunkBase
    );
    this.operatorSlugPromise = deriveOperatorSlug(root);
  }

  /** Start serving hook notifications and periodic fetch cycles. */
  async start(): Promise<void> {
    // Bind the local IPC endpoint before any workspace hooks can talk to us.
    await this.prepareSocket();

    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let buffer = "";

      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
      });
      socket.on("end", () => {
        void this.handleSocketMessages(socket, buffer);
      });
    });

    // Persist daemon liveness once the socket is definitely bound.
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    this.running = true;
    await writeDaemonRecord(this.root, {
      pid: process.pid,
      socketPath: this.socketPath,
      syncTargetBranch: this.syncBranch,
      startedAt: isoNow()
    });
    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "daemon_started",
      summary: `Daemon listening on ${this.socketPath}`
    });
    if (process.env.REVIS_DAEMON_READY_STDOUT === "1") {
      process.stdout.write(`${DAEMON_READY_LINE}\n`);
    }

    // Start the periodic fetch loop and immediately process startup recovery.
    this.interval = setInterval(() => {
      this.pendingNotifications.push({
        type: "sync",
        reason: "poll"
      });
      this.queueSync();
    }, this.config.remotePollSeconds * 1000);

    this.pendingNotifications.push({
      type: "sync",
      reason: "startup"
    });
    this.queueSync();
    await this.waitForIdle();
  }

  /** Stop accepting events and clean up the socket path. */
  async stop(): Promise<void> {
    this.running = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.server = null;
    }

    await this.waitForIdle();
    await removeSocketPath(this.socketPath);
    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "daemon_stopped",
      summary: "Daemon stopped"
    });
    await deleteDaemonRecord(this.root);
  }

  /** Run until the process is terminated. */
  async runForever(): Promise<void> {
    const shutdown = async (): Promise<void> => {
      if (!this.running) {
        process.exit(0);
      }

      await this.stop();
      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });

    await this.start();
    await new Promise<void>(() => undefined);
  }

  /** Ensure the socket endpoint can be bound before the server starts. */
  private async prepareSocket(): Promise<void> {
    if (process.platform !== "win32") {
      const ready = await daemonSocketReady(this.socketPath);
      if (ready) {
        throw new RevisError(`Revis daemon already running on ${this.socketPath}`);
      }
      await removeSocketPath(this.socketPath);
    }
  }

  /** Parse daemon socket messages and dispatch them to the right control path. */
  private async handleSocketMessages(
    socket: net.Socket,
    buffer: string
  ): Promise<void> {
    try {
      const messages = parseSocketNotifications(buffer);

      if (messages.some((message) => message.type === "shutdown")) {
        await this.stop();
        socket.end("stopped\n", () => {
          process.exit(0);
        });
        return;
      }

      for (const notification of messages) {
        this.pendingNotifications.push(notification);
        this.queueSync();
      }
      socket.end();
    } catch (error) {
      socket.destroy(error as Error);
    }
  }

  /** Coalesce concurrent daemon wakeups into one drain loop. */
  private queueSync(): void {
    if (this.syncInFlight) {
      this.syncQueued = true;
      return;
    }

    this.syncInFlight = true;
    void this.drainSyncQueue();
  }

  /** Wait until the daemon drains every pending sync request. */
  private async waitForIdle(): Promise<void> {
    if (!this.syncInFlight && this.pendingNotifications.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleResolver = resolve;
    });
  }

  /** Drain the coalesced sync queue until no more work remains. */
  private async drainSyncQueue(): Promise<void> {
    try {
      while (this.pendingNotifications.length > 0) {
        await this.processNotification(this.pendingNotifications.shift()!);
        if (!this.syncQueued && this.pendingNotifications.length === 0) {
          break;
        }
        this.syncQueued = false;
      }
    } finally {
      this.syncInFlight = false;
      this.idleResolver?.();
      this.idleResolver = null;
    }
  }

  /** Run one queued notification and persist daemon failures when it crashes. */
  private async processNotification(
    notification: CommitNotification
  ): Promise<void> {
    try {
      await this.runSyncCycle({ notification });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unknown daemon error: ${String(error)}`;
      await this.recordCycleFailure(message);
    }
  }

  /** Run one full daemon cycle: fetch, rebase, push, relay, persist. */
  private async runSyncCycle(reason: DaemonCycleReason): Promise<void> {
    const cycle = await this.loadCycleState();
    await this.syncOwnedBranches(cycle);
    await this.relayVisibleHeads(cycle);
    await this.recordSuccessfulCycle(cycle.daemonRecord, reason);
  }

  /** Refresh workspace records and pane snapshots before a sync cycle. */
  private async refreshWorkspaces(): Promise<WorkspaceRecord[]> {
    return refreshWorkspaceSnapshots(
      this.root,
      await loadWorkspaceRecords(this.root)
    );
  }

  /** Load the data needed for one daemon sync cycle. */
  private async loadCycleState(): Promise<{
    daemonRecord: DaemonRecord;
    operatorSlug: string;
    targetSha: string;
    workspaces: WorkspaceRecord[];
  }> {
    const daemonRecord = await this.requireDaemonRecord();
    const operatorSlug = await this.operatorSlugPromise;
    const workspaces = await this.refreshWorkspaces();

    await fetchCoordinationRefs(
      this.root,
      this.config.coordinationRemote,
      this.syncBranch
    );

    const targetSha = (
      await gitClient(this.root).revparse([
        remoteTrackingRef(this.config.coordinationRemote, this.syncBranch)
      ])
    ).trim();

    return {
      daemonRecord,
      operatorSlug,
      targetSha,
      workspaces
    };
  }

  /** Rebase owned workspaces and publish their branches for one sync cycle. */
  private async syncOwnedBranches(cycle: {
    daemonRecord: DaemonRecord;
    targetSha: string;
    workspaces: WorkspaceRecord[];
  }): Promise<void> {
    if (cycle.daemonRecord.lastSyncTargetSha !== cycle.targetSha) {
      await this.rebaseOwnedWorkspaces(cycle.workspaces, cycle.targetSha);
      cycle.daemonRecord.lastSyncTargetSha = cycle.targetSha;
    }

    await this.pushOwnedBranches(cycle.workspaces);
    await fetchCoordinationRefs(
      this.root,
      this.config.coordinationRemote,
      this.syncBranch
    );
  }

  /** Relay every unseen remote head into the relevant local workspaces. */
  private async relayVisibleHeads(cycle: {
    operatorSlug: string;
    workspaces: WorkspaceRecord[];
  }): Promise<void> {
    const registry = await loadRelayRegistry(this.root);
    const seededRegistry = await this.seedRegistryFromLocalState(
      registry,
      cycle.workspaces
    );
    await this.relayNewHeads(cycle.workspaces, seededRegistry, cycle.operatorSlug);
  }

  /** Persist daemon success markers once one sync cycle completes. */
  private async recordSuccessfulCycle(
    daemonRecord: DaemonRecord,
    reason: DaemonCycleReason
  ): Promise<void> {
    daemonRecord.lastFetchAt = isoNow();
    daemonRecord.lastEventAt = isoNow();
    delete daemonRecord.lastError;
    await writeDaemonRecord(this.root, daemonRecord);

    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "remote_branch_seen",
      summary: `Daemon cycle completed (${describeNotification(reason.notification)})`
    });
  }

  /** Persist the latest daemon-cycle failure for operator inspection. */
  private async recordCycleFailure(message: string): Promise<void> {
    const record = await this.requireDaemonRecord();
    record.lastError = message;
    record.lastEventAt = isoNow();
    await writeDaemonRecord(this.root, record);
    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "remote_branch_seen",
      summary: `Daemon cycle failed: ${message}`
    });
  }

  /** Rebase each owned workspace onto the current sync target when it advances. */
  private async rebaseOwnedWorkspaces(
    workspaces: WorkspaceRecord[],
    targetSha: string
  ): Promise<void> {
    for (const record of workspaces) {
      if (record.state === "stopped") {
        continue;
      }

      await assertWorkspaceRepoExists(record);
      const dirty = !(await gitClient(record.repoPath).status()).isClean();
      if (dirty) {
        await this.markWorkspaceRebasePending(record, targetSha);
        continue;
      }

      const rebaseError = await this.rebaseWorkspace(record);
      if (rebaseError) {
        await this.markWorkspaceRebaseFailed(record, targetSha, rebaseError);
        continue;
      }

      await this.markWorkspaceRebased(record, targetSha);
    }
  }

  /** Push each owned branch so other operators can see local commits. */
  private async pushOwnedBranches(workspaces: WorkspaceRecord[]): Promise<void> {
    for (const record of workspaces) {
      if (record.state === "stopped") {
        continue;
      }

      await assertWorkspaceRepoExists(record);
      const pushedSha = await pushBranch(
        record.repoPath,
        this.config.coordinationRemote,
        record.branch
      );
      record.lastPushedSha = pushedSha;
      record.lastCommitSha = pushedSha;
      delete record.lastError;
      await writeWorkspaceRecord(this.root, record);
      await appendEvent(this.root, {
        timestamp: isoNow(),
        type: "branch_pushed",
        agentId: record.agentId,
        branch: record.branch,
        summary: `Pushed ${record.branch} at ${pushedSha.slice(0, 8)}`
      });
    }
  }

  /** Seed relay dedupe state from the last relayed SHA stored in each workspace. */
  private async seedRegistryFromLocalState(
    registry: RelayRegistry,
    workspaces: WorkspaceRecord[]
  ): Promise<RelayRegistry> {
    const seeded: RelayRegistry = {
      byBranch: { ...registry.byBranch }
    };

    for (const record of workspaces) {
      if (seeded.byBranch[record.branch]) {
        continue;
      }

      if (!(await pathExists(record.repoPath))) {
        continue;
      }

      seeded.byBranch[record.branch] = await readLastRelayedSha(record.repoPath);
    }

    return seeded;
  }

  /** Relay unseen remote heads into local workspace sessions. */
  private async relayNewHeads(
    workspaces: WorkspaceRecord[],
    registry: RelayRegistry,
    operatorSlug: string
  ): Promise<void> {
    const heads = await listRemoteWorkspaceHeads(
      this.root,
      this.config.coordinationRemote
    );

    for (const head of heads) {
      await this.processRemoteHead(workspaces, registry, operatorSlug, head);
    }

    await writeRelayRegistry(this.root, registry);
  }

  /** Deliver one commit summary to the correct local workspace fan-out. */
  private async relayCommitSummary(
    workspaces: WorkspaceRecord[],
    summary: CommitSummary,
    localOperatorSlug: string
  ): Promise<void> {
    const localBranch = summary.operatorSlug === localOperatorSlug;
    const destinations = workspaces.filter((record) => {
      if (!localBranch) {
        return true;
      }

      return record.branch !== summary.branch;
    });

    const message = this.formatCommitRelay(summary);
    for (const record of destinations) {
      await sendSteeringMessage(this.root, record, message);
    }

    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "commit_relayed",
      agentId: summary.agentId,
      branch: summary.branch,
      summary: `Relayed ${summary.shortSha} from ${summary.operatorSlug}/${summary.agentId}`
    });
  }

  /** Format the single-line steering message for one commit. */
  private formatCommitRelay(summary: CommitSummary): string {
    return `[revis] ${summary.shortSha} ${summary.operatorSlug}/${summary.agentId}: ${summary.subject} (${summary.shortstat})`;
  }

  /** Rebase one clean workspace branch onto the fetched sync target. */
  private async rebaseWorkspace(record: WorkspaceRecord): Promise<string | null> {
    await fetchRemoteRefs(record.repoPath, this.config.coordinationRemote, [
      this.syncBranch
    ]);
    const result = await runCommand(
      [
        "git",
        "rebase",
        `${this.config.coordinationRemote}/${this.syncBranch}`
      ],
      {
        cwd: record.repoPath,
        check: false
      }
    );
    if (result.exitCode === 0) {
      return null;
    }

    const rebaseError = commandFailureMessage(result, "rebase failed");
    const abortError = await abortRebase(record.repoPath);
    if (!abortError) {
      return rebaseError;
    }

    return `${rebaseError}; ${abortError}`;
  }

  /** Persist and broadcast the pending-rebase state for one dirty workspace. */
  private async markWorkspaceRebasePending(
    record: WorkspaceRecord,
    targetSha: string
  ): Promise<void> {
    record.rebaseRequiredSha = targetSha;
    delete record.lastError;
    await this.persistRebaseOutcome(
      record,
      "workspace_rebase_pending",
      `${record.agentId} needs rebase onto ${this.syncBranch} ${targetSha.slice(0, 8)}`,
      `[revis] ${this.syncBranch} advanced to ${targetSha.slice(0, 8)}. Your workspace is dirty, so rebase is pending.`
    );
  }

  /** Persist and broadcast one automatic rebase failure. */
  private async markWorkspaceRebaseFailed(
    record: WorkspaceRecord,
    targetSha: string,
    message: string
  ): Promise<void> {
    record.rebaseRequiredSha = targetSha;
    record.lastError = message;
    await this.persistRebaseOutcome(
      record,
      "workspace_rebase_failed",
      `${record.agentId} failed to rebase onto ${this.syncBranch}`,
      `[revis] ${this.syncBranch} advanced to ${targetSha.slice(0, 8)}, but automatic rebase failed: ${record.lastError}`
    );
  }

  /** Persist and broadcast one successful automatic rebase. */
  private async markWorkspaceRebased(
    record: WorkspaceRecord,
    targetSha: string
  ): Promise<void> {
    record.lastCommitSha = await currentHeadSha(record.repoPath);
    record.lastRebasedOntoSha = targetSha;
    delete record.rebaseRequiredSha;
    delete record.lastError;
    await this.persistRebaseOutcome(
      record,
      "workspace_rebased",
      `${record.agentId} rebased onto ${this.syncBranch} ${targetSha.slice(0, 8)}`,
      `[revis] Rebasing complete. ${record.agentId} now sits on ${this.syncBranch} ${targetSha.slice(0, 8)}.`
    );
  }

  /** Persist and broadcast one rebase outcome after the record is updated in-memory. */
  private async persistRebaseOutcome(
    record: WorkspaceRecord,
    type:
      | "workspace_rebase_pending"
      | "workspace_rebase_failed"
      | "workspace_rebased",
    summary: string,
    message: string
  ): Promise<void> {
    await writeWorkspaceRecord(this.root, record);
    await appendEvent(this.root, {
      timestamp: isoNow(),
      type,
      agentId: record.agentId,
      branch: record.branch,
      summary
    });
    await sendSteeringMessage(this.root, record, message);
  }

  /** Load the persisted daemon record or fail loudly when it is missing. */
  private async requireDaemonRecord(): Promise<DaemonRecord> {
    const record = await loadDaemonRecord(this.root);
    if (!record) {
      throw new RevisError("Daemon runtime record is missing");
    }

    return record;
  }

  /** Sync one fetched remote head into local runtime state and relay fan-out. */
  private async processRemoteHead(
    workspaces: WorkspaceRecord[],
    registry: RelayRegistry,
    operatorSlug: string,
    head: { branch: string; sha: string }
  ): Promise<void> {
    const record = workspaces.find((workspace) => workspace.branch === head.branch);
    if (record) {
      record.lastSeenRemoteSha = head.sha;
      await writeWorkspaceRecord(this.root, record);
    }

    if (registry.byBranch[head.branch] === head.sha) {
      return;
    }

    const summary = await commitSummaryForRef(
      this.root,
      remoteTrackingRef(this.config.coordinationRemote, head.branch),
      head.branch
    );
    await this.relayCommitSummary(workspaces, summary, operatorSlug);

    registry.byBranch[head.branch] = head.sha;
    if (record) {
      record.lastRelayedSha = head.sha;
      await writeWorkspaceRecord(this.root, record);
      await writeLastRelayedSha(record.repoPath, head.sha);
    }
  }
}

/** Start the background daemon in the current process. */
export async function runDaemonProcess(root: string): Promise<void> {
  const daemon = new RevisDaemon(root, await loadConfig(root));
  await daemon.runForever();
}

/** Parse every newline-delimited daemon notification from one socket payload. */
function parseSocketNotifications(buffer: string): CommitNotification[] {
  return buffer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => validateNotification(JSON.parse(line) as CommitNotification));
}

/** Validate one daemon notification instead of normalizing malformed payloads. */
function validateNotification(notification: CommitNotification): CommitNotification {
  if (notification.type === "commit") {
    if (!notification.agentId || !notification.branch || !notification.sha) {
      throw new RevisError("Commit notifications must include agentId, branch, and sha");
    }

    return notification;
  }

  if (notification.type === "sync" || notification.type === "shutdown") {
    if (!notification.reason) {
      throw new RevisError(`${notification.type} notifications must include reason`);
    }

    return notification;
  }

  throw new RevisError(`Unsupported daemon notification type: ${String(notification.type)}`);
}

/** Describe one validated daemon notification for the event log. */
function describeNotification(notification: CommitNotification): string {
  if (notification.type === "commit") {
    return `${notification.agentId!} committed`;
  }

  return notification.reason!;
}

/** Require the on-disk workspace repo for one live runtime record. */
async function assertWorkspaceRepoExists(record: WorkspaceRecord): Promise<void> {
  if (await pathExists(record.repoPath)) {
    return;
  }

  throw new RevisError(
    `Workspace ${record.agentId} is ${record.state} but repo is missing: ${record.repoPath}`
  );
}

/** Convert one failed command into the operator-facing error text. */
function commandFailureMessage(
  result: { stderr: string; stdout: string },
  fallback: string
): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

/** Abort a failed rebase and surface cleanup errors when they happen. */
async function abortRebase(repoPath: string): Promise<string | null> {
  const abort = await runCommand(["git", "rebase", "--abort"], {
    cwd: repoPath,
    check: false
  });
  if (abort.exitCode === 0) {
    return null;
  }

  return commandFailureMessage(abort, "git rebase --abort failed");
}
