/** Host daemon for iteration lifecycle, remote sync, and workspace rebasing. */

import net from "node:net";
import process from "node:process";

import type { DaemonRecord, DaemonRequest, RevisConfig, WorkspaceRecord } from "../core/models";
import { configExists, loadConfig } from "../core/config";
import { RevisError } from "../core/error";
import { daemonSocketPath, removeSocketPath } from "../core/ipc";
import {
  currentRevisCommand,
  processAlive,
  sleep,
  spawnReadyProcess
} from "../core/process";
import { isoNow } from "../core/time";
import {
  appendEvent,
  deleteDaemonRecord,
  ensureRuntime,
  loadDaemonRecord,
  loadWorkspaceRecords,
  writeDaemonRecord,
  writeWorkspaceRecord
} from "./runtime";
import { createWorkspaceProvider, type WorkspaceProvider } from "./provider";
import {
  fetchCoordinationRefs,
  gitClient,
  syncTargetBranch
} from "./repo";
import {
  fetchWorkspaceCoordinationRefs,
  pushWorkspaceHead,
  rebaseWorkspaceOntoSyncTarget,
  workspaceCurrentBranch,
  workspaceHeadSubject,
  workspaceHeadSha,
  workspaceWorkingTreeDirty
} from "./workspace-git";
import { captureWorkspaceActivity } from "./workspaces";

const START_TIMEOUT_MS = 10_000;
const DAYTONA_START_TIMEOUT_MS = 60_000;
const SOCKET_CONNECT_TIMEOUT_MS = 400;
const SOCKET_REQUEST_TIMEOUT_MS = 5_000;
const SOCKET_SHUTDOWN_REQUEST_TIMEOUT_MS = 1_000;
const PROCESS_STOP_TIMEOUT_MS = 1_000;
const DAEMON_READY_LINE = "REVIS_DAEMON_READY";
const EXPECTED_SOCKET_CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "ENOTSOCK"
]);

export interface DaemonCycleReason {
  request: DaemonRequest;
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
  if (!record.pid) {
    return false;
  }

  return processAlive(record.pid);
}

/** Start the daemon when it is not already running. */
export async function ensureDaemonRunning(root: string): Promise<DaemonRecord> {
  const socketPath = daemonSocketPath(root);
  const config = await loadConfig(root);

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

  if (existing?.socketPath) {
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
    timeoutMs:
      config.sandboxProvider === "daytona" ? DAYTONA_START_TIMEOUT_MS : START_TIMEOUT_MS
  });

  const record = await loadDaemonRecord(root);
  if (!record) {
    throw new RevisError("Daemon failed to persist its runtime record");
  }

  return record;
}

/** Ask the daemon to run an immediate reconcile cycle. */
export async function notifyDaemon(
  root: string,
  request: DaemonRequest
): Promise<void> {
  const socketPath = daemonSocketPath(root);
  if (!(await daemonSocketReady(socketPath))) {
    await ensureDaemonRunning(root);
  }

  await sendDaemonRequest(socketPath, request);
}

/** Stop the daemon process when it is running. */
export async function stopDaemon(root: string): Promise<void> {
  if (!(await configExists(root))) {
    return;
  }

  const record = await loadDaemonRecord(root);
  if (!record) {
    await removeSocketPath(daemonSocketPath(root));
    return;
  }

  if (record.socketPath && (await daemonSocketReady(record.socketPath))) {
    try {
      await sendDaemonRequest(
        record.socketPath,
        {
          type: "shutdown",
          reason: "stop"
        },
        SOCKET_SHUTDOWN_REQUEST_TIMEOUT_MS
      );
      await waitForDaemonShutdown(record);
      await removeSocketPath(record.socketPath);
      await deleteDaemonRecord(root);
      return;
    } catch {
      if (!daemonProcessAlive(record)) {
        if (record.socketPath) {
          await removeSocketPath(record.socketPath);
        }
        await deleteDaemonRecord(root);
        return;
      }

      await terminateDaemonProcess(record.pid!);
    }
  }

  if (daemonProcessAlive(record)) {
    await terminateDaemonProcess(record.pid!);
  }

  if (record.socketPath) {
    await removeSocketPath(record.socketPath);
  }
  await deleteDaemonRecord(root);
}

/** Long-running daemon process used by the hidden CLI command. */
export class RevisDaemon {
  readonly root: string;
  readonly config: RevisConfig;
  readonly provider: WorkspaceProvider;
  readonly socketPath: string;
  readonly syncBranch: string;

  private readonly pendingRequests: DaemonRequest[] = [];
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
    this.provider = createWorkspaceProvider(config);
    this.socketPath = daemonSocketPath(root);
    this.syncBranch = syncTargetBranch(config.coordinationRemote, config.trunkBase);
  }

  /** Start serving control requests and periodic reconcile cycles. */
  async start(): Promise<void> {
    await ensureRuntime(this.root);
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

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    this.running = true;

    await writeDaemonRecord(this.root, {
      sandboxProvider: this.config.sandboxProvider,
      syncTargetBranch: this.syncBranch,
      startedAt: isoNow(),
      pid: process.pid,
      socketPath: this.socketPath
    });
    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "daemon_started",
      summary: `Daemon listening on ${this.socketPath}`
    });

    await this.baselineStartupState();

    this.pendingRequests.push({
      type: "reconcile",
      reason: "startup"
    });
    this.queueSync();
    await this.waitForIdle();

    if (process.env.REVIS_DAEMON_READY_STDOUT === "1") {
      process.stdout.write(`${DAEMON_READY_LINE}\n`);
    }

    this.interval = setInterval(() => {
      this.pendingRequests.push({
        type: "reconcile",
        reason: "poll"
      });
      this.queueSync();
    }, this.config.remotePollSeconds * 1000);
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

  /** Parse control socket messages and dispatch them to the right control path. */
  private async handleSocketMessages(socket: net.Socket, buffer: string): Promise<void> {
    try {
      const messages = parseSocketRequests(buffer);

      if (messages.some((message) => message.type === "shutdown")) {
        await this.stop();
        socket.end("stopped\n", () => {
          process.exit(0);
        });
        return;
      }

      for (const message of messages) {
        this.pendingRequests.push(message);
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
    if (!this.syncInFlight && this.pendingRequests.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleResolver = resolve;
    });
  }

  /** Drain the coalesced sync queue until no more work remains. */
  private async drainSyncQueue(): Promise<void> {
    try {
      while (this.pendingRequests.length > 0) {
        await this.processRequest(this.pendingRequests.shift()!);
        if (!this.syncQueued && this.pendingRequests.length === 0) {
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

  /** Run one queued request and persist daemon failures when it crashes. */
  private async processRequest(request: DaemonRequest): Promise<void> {
    try {
      await this.runSyncCycle({ request });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unknown daemon error: ${String(error)}`;
      await this.recordCycleFailure(message);
    }
  }

  /** Run one full daemon cycle. */
  private async runSyncCycle(reason: DaemonCycleReason): Promise<void> {
    const cycle = await this.loadCycleState();

    for (const record of cycle.workspaces) {
      await this.reconcileWorkspace(record, cycle.targetSha);
    }

    await this.recordSuccessfulCycle(cycle.daemonRecord, reason);
  }

  /** Snapshot current workspace git state so the daemon starts from truth, not assumptions. */
  private async baselineStartupState(): Promise<void> {
    const workspaces = await loadWorkspaceRecords(this.root);
    for (const record of workspaces) {
      if (record.state === "stopped") {
        continue;
      }

      await this.refreshWorkspaceGitState(record);
      const status = await this.provider.inspectSession(record);
      record.state = status.phase === "running" ? "active" : "starting";
      await writeWorkspaceRecord(this.root, record);
      await captureWorkspaceActivity(this.root, record, this.provider);
    }

    await fetchCoordinationRefs(
      this.root,
      this.config.coordinationRemote,
      this.syncBranch
    );

    const daemonRecord = await this.requireDaemonRecord();
    daemonRecord.lastSyncTargetSha = await this.currentSyncTargetSha();
    await writeDaemonRecord(this.root, daemonRecord);
  }

  /** Load the data needed for one daemon sync cycle. */
  private async loadCycleState(): Promise<{
    daemonRecord: DaemonRecord;
    targetSha: string;
    workspaces: WorkspaceRecord[];
  }> {
    const daemonRecord = await this.requireDaemonRecord();
    const workspaces = await loadWorkspaceRecords(this.root);

    await fetchCoordinationRefs(
      this.root,
      this.config.coordinationRemote,
      this.syncBranch
    );

    return {
      daemonRecord,
      targetSha: await this.currentSyncTargetSha(),
      workspaces
    };
  }

  /** Reconcile one workspace against the current iteration lifecycle rules. */
  private async reconcileWorkspace(
    record: WorkspaceRecord,
    targetSha: string
  ): Promise<void> {
    if (record.state === "stopped") {
      return;
    }

    const sessionStatus = await this.inspectWorkspaceSession(record);
    if (sessionStatus.phase === "running") {
      await this.reconcileRunningWorkspace(record);
      return;
    }

    await this.prepareWorkspaceForRestart(record, sessionStatus.exitCode);

    const rebaseBlocked = await this.syncWorkspaceBeforeRestart(record, targetSha);
    if (rebaseBlocked) {
      return;
    }

    await this.startNextIteration(record);
  }

  /** Persist one exited iteration before the next sync/restart step begins. */
  private async recordIterationExit(
    record: WorkspaceRecord,
    exitCode?: number
  ): Promise<void> {
    record.lastExitedAt = isoNow();
    if (exitCode === undefined) {
      delete record.lastExitCode;
    } else {
      record.lastExitCode = exitCode;
    }
    record.state = "starting";
    delete record.currentSessionId;
    delete record.lastError;
    await writeWorkspaceRecord(this.root, record);

    const codeSuffix = exitCode === undefined ? "unknown exit status" : `exit ${exitCode}`;
    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "iteration_exited",
      agentId: record.agentId,
      branch: record.coordinationBranch,
      summary: `${record.agentId} iteration ${record.iteration} exited with ${codeSuffix}`,
      ...(exitCode === undefined ? {} : { metadata: { exitCode } })
    });
  }

  /** Capture activity and inspect the current workspace session. */
  private async inspectWorkspaceSession(record: WorkspaceRecord) {
    const sessionStatus = await this.provider.inspectSession(record);
    await captureWorkspaceActivity(this.root, record, this.provider);
    return sessionStatus;
  }

  /** Keep runtime metadata aligned with an actively running workspace. */
  private async reconcileRunningWorkspace(record: WorkspaceRecord): Promise<void> {
    await this.refreshWorkspaceGitState(record);
    record.state = "active";
    delete record.lastError;
    await writeWorkspaceRecord(this.root, record);
  }

  /** Persist exit or blocked-start state before the next sync step. */
  private async prepareWorkspaceForRestart(
    record: WorkspaceRecord,
    exitCode?: number
  ): Promise<void> {
    if (record.currentSessionId) {
      await this.recordIterationExit(record, exitCode);
      return;
    }

    record.state = record.rebaseRequiredSha ? "failed" : "starting";
    await writeWorkspaceRecord(this.root, record);
  }

  /** Refresh the workspace's current branch and HEAD SHA from its repository. */
  private async refreshWorkspaceGitState(record: WorkspaceRecord): Promise<void> {
    record.localBranch = await workspaceCurrentBranch(this.provider, record);
    record.lastCommitSha = await workspaceHeadSha(this.provider, record);
  }

  /** Refresh git state, publish HEAD, and fetch refs before the next restart. */
  private async syncWorkspaceBeforeRestart(
    record: WorkspaceRecord,
    targetSha: string
  ): Promise<boolean> {
    await this.refreshWorkspaceGitState(record);
    await this.publishWorkspaceHead(record);
    await this.fetchWorkspaceRefs(record);
    return this.reconcileWorkspaceRebase(record, targetSha);
  }

  /** Push the current workspace HEAD to its coordination ref when needed. */
  private async publishWorkspaceHead(record: WorkspaceRecord): Promise<void> {
    const pushedSha = await pushWorkspaceHead(
      this.provider,
      record,
      this.config.coordinationRemote
    );
    const changed = record.lastPushedSha !== pushedSha;

    record.lastPushedSha = pushedSha;
    record.lastCommitSha = pushedSha;
    await writeWorkspaceRecord(this.root, record);

    if (!changed) {
      return;
    }

    const subject = await workspaceHeadSubject(this.provider, record);
    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "branch_pushed",
      agentId: record.agentId,
      branch: record.coordinationBranch,
      sha: pushedSha,
      summary: `${record.agentId} pushed ${pushedSha.slice(0, 8)}: ${subject}`
    });
  }

  /** Fetch sync-target and coordination refs into the workspace before restart. */
  private async fetchWorkspaceRefs(record: WorkspaceRecord): Promise<void> {
    await fetchWorkspaceCoordinationRefs(
      this.provider,
      record,
      this.config.coordinationRemote,
      this.syncBranch
    );

    record.lastSeenRemoteSha = await this.currentSyncTargetSha();
    await writeWorkspaceRecord(this.root, record);
  }

  /** Rebase between iterations, blocking restart when the workspace is dirty or conflicted. */
  private async reconcileWorkspaceRebase(
    record: WorkspaceRecord,
    targetSha: string
  ): Promise<boolean> {
    const needsRebase =
      record.rebaseRequiredSha !== undefined || record.lastRebasedOntoSha !== targetSha;
    if (!needsRebase) {
      return false;
    }

    if (await workspaceWorkingTreeDirty(this.provider, record)) {
      record.rebaseRequiredSha = targetSha;
      record.state = "failed";
      delete record.lastError;
      await writeWorkspaceRecord(this.root, record);
      await appendEvent(this.root, {
        timestamp: isoNow(),
        type: "workspace_rebase_pending",
        agentId: record.agentId,
        branch: record.coordinationBranch,
        summary: `${record.agentId} needs rebase onto ${this.syncBranch} ${targetSha.slice(0, 8)}`
      });
      return true;
    }

    const rebaseError = await rebaseWorkspaceOntoSyncTarget(
      this.provider,
      record,
      this.config.coordinationRemote,
      this.syncBranch
    );
    if (rebaseError) {
      record.rebaseRequiredSha = targetSha;
      record.state = "failed";
      record.lastError = rebaseError;
      await writeWorkspaceRecord(this.root, record);
      await appendEvent(this.root, {
        timestamp: isoNow(),
        type: "workspace_rebase_failed",
        agentId: record.agentId,
        branch: record.coordinationBranch,
        summary: `${record.agentId} failed to rebase onto ${this.syncBranch}`
      });
      return true;
    }

    record.lastCommitSha = await workspaceHeadSha(this.provider, record);
    record.lastRebasedOntoSha = targetSha;
    delete record.rebaseRequiredSha;
    delete record.lastError;
    await writeWorkspaceRecord(this.root, record);
    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "workspace_rebased",
      agentId: record.agentId,
      branch: record.coordinationBranch,
      summary: `${record.agentId} rebased onto ${this.syncBranch} ${targetSha.slice(0, 8)}`
    });
    return false;
  }

  /** Start the next agent session after sync and pre-restart rebase complete. */
  private async startNextIteration(record: WorkspaceRecord): Promise<void> {
    record.state = "starting";
    await writeWorkspaceRecord(this.root, record);

    const nextIteration = record.iteration + 1;
    const sessionId = await this.provider.startSession(record);
    record.iteration = nextIteration;
    record.currentSessionId = sessionId;
    record.lastStartedAt = isoNow();
    delete record.lastError;

    if (nextIteration > 1) {
      await appendEvent(this.root, {
        timestamp: isoNow(),
        type: "workspace_restarted",
        agentId: record.agentId,
        branch: record.coordinationBranch,
        summary: `${record.agentId} restarted iteration ${nextIteration}`
      });
    }

    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "iteration_started",
      agentId: record.agentId,
      branch: record.coordinationBranch,
        summary: `${record.agentId} started iteration ${nextIteration}`
    });

    record.state = "active";
    await writeWorkspaceRecord(this.root, record);
  }

  /** Persist daemon success markers once one sync cycle completes. */
  private async recordSuccessfulCycle(
    daemonRecord: DaemonRecord,
    reason: DaemonCycleReason
  ): Promise<void> {
    daemonRecord.lastFetchAt = isoNow();
    daemonRecord.lastEventAt = isoNow();
    daemonRecord.lastSyncTargetSha = await this.currentSyncTargetSha();
    delete daemonRecord.lastError;
    await writeDaemonRecord(this.root, daemonRecord);

    await appendEvent(this.root, {
      timestamp: isoNow(),
      type: "remote_refs_fetched",
      summary: `Daemon cycle completed (${describeRequest(reason.request)})`
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
      type: "remote_refs_fetched",
      summary: `Daemon cycle failed: ${message}`
    });
  }

  /** Load the persisted daemon record or fail loudly when it is missing. */
  private async requireDaemonRecord(): Promise<DaemonRecord> {
    const record = await loadDaemonRecord(this.root);
    if (!record) {
      throw new RevisError("Daemon runtime record is missing");
    }

    return record;
  }

  /** Return the current fetched sync-target SHA from the operator root. */
  private async currentSyncTargetSha(): Promise<string> {
    return (await gitClient(this.root).revparse([`${this.config.coordinationRemote}/${this.syncBranch}`])).trim();
  }
}

/** Start the background daemon in the current process. */
export async function runDaemonProcess(root: string): Promise<void> {
  const daemon = new RevisDaemon(root, await loadConfig(root));
  await daemon.runForever();
}

/** Send one request to the daemon and wait for its socket response. */
async function sendDaemonRequest(
  socketPath: string,
  request: DaemonRequest,
  timeoutMs = SOCKET_REQUEST_TIMEOUT_MS
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(socketPath, () => {
      socket.end(`${JSON.stringify(request)}\n`);
    });

    let response = "";

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    socket.setTimeout(timeoutMs, () => {
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

/** Parse every newline-delimited daemon request from one socket payload. */
function parseSocketRequests(buffer: string): DaemonRequest[] {
  return buffer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => validateRequest(JSON.parse(line) as DaemonRequest));
}

/** Validate one daemon request instead of normalizing malformed payloads. */
function validateRequest(request: DaemonRequest): DaemonRequest {
  if (request.type === "reconcile" || request.type === "shutdown") {
    if (!request.reason) {
      throw new RevisError(`${request.type} requests must include reason`);
    }

    return request;
  }

  throw new RevisError(`Unsupported daemon request type: ${String(request.type)}`);
}

/** Describe one validated daemon request for the event log. */
function describeRequest(request: DaemonRequest): string {
  return request.reason!;
}

/** Terminate one daemon process when graceful shutdown is unavailable. */
async function terminateDaemonProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
    return;
  }

  const termStartedAt = Date.now();
  while (Date.now() - termStartedAt < PROCESS_STOP_TIMEOUT_MS) {
    if (!processAlive(pid)) {
      return;
    }

    await sleep(50);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
    return;
  }

  const killStartedAt = Date.now();
  while (Date.now() - killStartedAt < PROCESS_STOP_TIMEOUT_MS) {
    if (!processAlive(pid)) {
      return;
    }

    await sleep(50);
  }
}

/** Wait briefly for one daemon process to release its socket and exit. */
async function waitForDaemonShutdown(record: DaemonRecord): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < PROCESS_STOP_TIMEOUT_MS) {
    const socketReady = record.socketPath
      ? await daemonSocketReady(record.socketPath)
      : false;
    if (!socketReady && !daemonProcessAlive(record)) {
      return;
    }

    await sleep(50);
  }

  if (record.pid && daemonProcessAlive(record)) {
    await terminateDaemonProcess(record.pid);
  }
}
