/** JSON-backed runtime and session persistence for local Revis state. */

import { randomBytes } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type {
  DaemonRecord,
  RuntimeEvent,
  SessionMeta,
  SessionParticipant,
  SessionSummary,
  WorkspaceRecord
} from "../core/models";
import { RevisError } from "../core/error";
import {
  appendJsonl,
  ensureDir,
  pathExists,
  readJson,
  writeJson
} from "../core/files";
import { isoNow } from "../core/time";

const RUNTIME_DIR = join(".revis", "runtime");
const SESSIONS_DIR = join(".revis", "sessions");
const ACTIVITY_LINE_LIMIT = 200;
const ACTIVITY_BYTE_LIMIT = 128_000;

/** Return the runtime root directory. */
export function runtimeDir(root: string): string {
  return join(root, RUNTIME_DIR);
}

/** Return the session archive root. */
export function sessionsDir(root: string): string {
  return join(root, SESSIONS_DIR);
}

/** Return the session index path. */
export function sessionsIndexPath(root: string): string {
  return join(sessionsDir(root), "index.json");
}

/** Return one archived session directory. */
export function sessionDir(root: string, sessionId: string): string {
  return join(sessionsDir(root), sessionId);
}

/** Return one session metadata path. */
export function sessionMetaPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "meta.json");
}

/** Return one session event-log path. */
export function sessionEventsPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "events.jsonl");
}

/** Return the workspace runtime directory. */
export function workspacesDir(root: string): string {
  return join(runtimeDir(root), "workspaces");
}

/** Return the host-side activity directory. */
export function activityDir(root: string): string {
  return join(runtimeDir(root), "activity");
}

/** Return the live event log path. */
export function eventsPath(root: string): string {
  return join(runtimeDir(root), "events.jsonl");
}

/** Return the daemon runtime record path. */
export function daemonRecordPath(root: string): string {
  return join(runtimeDir(root), "daemon.json");
}

/** Return one workspace runtime record path. */
export function workspaceRecordPath(root: string, agentId: string): string {
  return join(workspacesDir(root), `${agentId}.json`);
}

/** Return the activity snapshot path for one workspace. */
export function activityPath(root: string, agentId: string): string {
  return join(activityDir(root), `${agentId}.log`);
}

/** Ensure the live runtime directories exist. */
export async function ensureRuntime(root: string): Promise<void> {
  await ensureDir(runtimeDir(root));
  await ensureDir(workspacesDir(root));
  await ensureDir(activityDir(root));
}

/** Ensure the session archive root exists. */
export async function ensureSessionsRoot(root: string): Promise<void> {
  await ensureDir(sessionsDir(root));
  if (!(await pathExists(sessionsIndexPath(root)))) {
    await writeJson(sessionsIndexPath(root), []);
  }
}

/** Persist one workspace runtime record. */
export async function writeWorkspaceRecord(
  root: string,
  record: WorkspaceRecord
): Promise<void> {
  await writeRuntimeJson(root, workspaceRecordPath(root, record.agentId), record);
}

/** Load one workspace runtime record. */
export async function loadWorkspaceRecord(
  root: string,
  agentId: string
): Promise<WorkspaceRecord | null> {
  const record = await loadRuntimeJsonOrNull<WorkspaceRecord | LegacyWorkspaceRecord>(
    workspaceRecordPath(root, agentId)
  );
  return record ? normalizeWorkspaceRecord(record) : null;
}

/** Load every workspace runtime record. */
export async function loadWorkspaceRecords(root: string): Promise<WorkspaceRecord[]> {
  const directory = workspacesDir(root);
  if (!(await pathExists(directory))) {
    return [];
  }

  const entries = await readdir(directory);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map(async (entry) =>
        normalizeWorkspaceRecord(
          await readJson<WorkspaceRecord | LegacyWorkspaceRecord>(join(directory, entry))
        )
      )
  );
  return records;
}

/** Persist daemon runtime state. */
export async function writeDaemonRecord(
  root: string,
  record: DaemonRecord
): Promise<void> {
  await writeRuntimeJson(root, daemonRecordPath(root), record);
}

/** Load daemon runtime state. */
export async function loadDaemonRecord(root: string): Promise<DaemonRecord | null> {
  return loadRuntimeJsonOrNull(daemonRecordPath(root));
}

/** Remove persisted daemon runtime state. */
export async function deleteDaemonRecord(root: string): Promise<void> {
  await rm(daemonRecordPath(root), { force: true });
}

/** Remove one persisted workspace runtime record. */
export async function deleteWorkspaceRecord(
  root: string,
  agentId: string
): Promise<void> {
  await rm(workspaceRecordPath(root, agentId), { force: true });
}

/** Ensure one live session exists and return its metadata. */
export async function ensureLiveSession(
  root: string,
  session: {
    coordinationRemote: string;
    trunkBase: string;
    operatorSlug: string;
  }
): Promise<SessionMeta> {
  await ensureSessionsRoot(root);

  const existing = await loadLiveSession(root);
  if (existing) {
    await pointRuntimeEventsToSession(root, existing.id);
    return existing;
  }

  const meta: SessionMeta = {
    id: `sess-${randomBytes(4).toString("hex")}`,
    startedAt: isoNow(),
    endedAt: null,
    coordinationRemote: session.coordinationRemote,
    trunkBase: session.trunkBase,
    operatorSlug: session.operatorSlug,
    participants: [],
    participantCount: 0
  };

  await writeSessionMeta(root, meta);
  await pointRuntimeEventsToSession(root, meta.id);
  return meta;
}

/** Load every session summary in newest-first order. */
export async function loadSessionIndex(root: string): Promise<SessionSummary[]> {
  if (!(await pathExists(sessionsIndexPath(root)))) {
    return [];
  }

  return readJson<SessionSummary[]>(sessionsIndexPath(root));
}

/** Load one session metadata record. */
export async function loadSessionMeta(
  root: string,
  sessionId: string
): Promise<SessionMeta | null> {
  return loadRuntimeJsonOrNull(sessionMetaPath(root, sessionId));
}

/** Load the sole live session, if present. */
export async function loadLiveSession(root: string): Promise<SessionMeta | null> {
  const index = await loadSessionIndex(root);
  const live = index.filter((session) => session.endedAt === null);
  if (live.length === 0) {
    return null;
  }

  if (live.length > 1) {
    throw new RevisError("Session index is corrupted: multiple live sessions found");
  }

  const meta = await loadSessionMeta(root, live[0]!.id);
  if (!meta) {
    throw new RevisError(
      `Session index is corrupted: missing meta for ${live[0]!.id}`
    );
  }

  return meta;
}

/** Load one session's events from disk. */
export async function loadSessionEvents(
  root: string,
  sessionId: string,
  limit?: number
): Promise<RuntimeEvent[]> {
  return readEventLog(sessionEventsPath(root, sessionId), limit);
}

/** Register new or revived participants on the current live session. */
export async function registerSessionParticipants(
  root: string,
  records: WorkspaceRecord[]
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const session = await requireLiveSession(root);
  const participants = [...session.participants];

  for (const record of records) {
    const existingIndex = participants.findIndex(
      (participant) => participant.agentId === record.agentId
    );
    if (existingIndex === -1) {
      participants.push({
        agentId: record.agentId,
        coordinationBranch: record.coordinationBranch,
        startedAt: record.createdAt,
        stoppedAt: null
      });
      continue;
    }

    participants[existingIndex] = {
      ...participants[existingIndex]!,
      coordinationBranch: record.coordinationBranch,
      stoppedAt: null
    };
  }

  await writeSessionMeta(root, {
    ...session,
    participants: sortParticipants(participants),
    participantCount: participants.length
  });
}

/** Mark one participant as stopped inside the live session metadata. */
export async function markSessionParticipantStopped(
  root: string,
  record: Pick<WorkspaceRecord, "agentId" | "coordinationBranch" | "createdAt">,
  stoppedAt = isoNow()
): Promise<void> {
  const session = await requireLiveSession(root);
  const participants = [...session.participants];
  const existingIndex = participants.findIndex(
    (participant) => participant.agentId === record.agentId
  );

  if (existingIndex === -1) {
    participants.push({
      agentId: record.agentId,
      coordinationBranch: record.coordinationBranch,
      startedAt: record.createdAt,
      stoppedAt
    });
  } else {
    participants[existingIndex] = {
      ...participants[existingIndex]!,
      coordinationBranch: record.coordinationBranch,
      stoppedAt
    };
  }

  await writeSessionMeta(root, {
    ...session,
    participants: sortParticipants(participants),
    participantCount: participants.length
  });
}

/** Finalize the current live session and freeze its metadata. */
export async function finalizeLiveSession(
  root: string,
  endedAt = isoNow()
): Promise<SessionMeta | null> {
  const session = await loadLiveSession(root);
  if (!session) {
    return null;
  }

  const participants = session.participants.map((participant) => ({
    ...participant,
    stoppedAt: participant.stoppedAt ?? endedAt
  }));

  const finalized = {
    ...session,
    endedAt,
    participants,
    participantCount: participants.length
  };
  await writeSessionMeta(root, finalized);
  return finalized;
}

/** Append one runtime event to the active session log. */
export async function appendEvent(
  root: string,
  event: RuntimeEvent
): Promise<void> {
  const session = await requireLiveSession(root);

  await ensureRuntime(root);
  await pointRuntimeEventsToSession(root, session.id);
  await appendJsonl(
    sessionEventsPath(root, session.id),
    event as unknown as Record<string, unknown>
  );
}

/** Load recent runtime events from the live log symlink. */
export async function loadEvents(
  root: string,
  limit?: number
): Promise<RuntimeEvent[]> {
  return readEventLog(eventsPath(root), limit);
}

/** Persist a bounded activity snapshot for one workspace. */
export async function writeActivitySnapshot(
  root: string,
  agentId: string,
  lines: string[]
): Promise<void> {
  await ensureRuntime(root);
  const bounded = trimActivityToByteLimit(lines);
  const payload = bounded.length > 0 ? `${bounded.join("\n")}\n` : "";
  await writeFile(activityPath(root, agentId), payload, "utf8");
}

/** Load the latest activity snapshot for one workspace. */
export async function loadActivity(
  root: string,
  agentId: string
): Promise<string[]> {
  const path = activityPath(root, agentId);
  if (!(await pathExists(path))) {
    return [];
  }

  return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
}

/** Remove one persisted workspace activity snapshot. */
export async function deleteActivitySnapshot(
  root: string,
  agentId: string
): Promise<void> {
  await rm(activityPath(root, agentId), { force: true });
}

/** Remove all persisted runtime state. */
export async function clearRuntime(root: string): Promise<void> {
  await rm(runtimeDir(root), { recursive: true, force: true });
}

/** Persist one JSON runtime record after ensuring the runtime directory exists. */
async function writeRuntimeJson(
  root: string,
  path: string,
  value: unknown
): Promise<void> {
  await ensureRuntime(root);
  await writeJson(path, value);
}

/** Load one optional JSON runtime record from disk. */
async function loadRuntimeJsonOrNull<T>(path: string): Promise<T | null> {
  if (!(await pathExists(path))) {
    return null;
  }

  return readJson<T>(path);
}

/** Persist one session metadata file and refresh the session index summary. */
async function writeSessionMeta(root: string, meta: SessionMeta): Promise<void> {
  await ensureSessionsRoot(root);
  await writeJson(sessionMetaPath(root, meta.id), meta);

  const index = await loadSessionIndex(root);
  const nextIndex = index.filter((session) => session.id !== meta.id);
  nextIndex.push({
    id: meta.id,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    coordinationRemote: meta.coordinationRemote,
    trunkBase: meta.trunkBase,
    operatorSlug: meta.operatorSlug,
    participantCount: meta.participantCount
  });

  nextIndex.sort(
    (left, right) =>
      new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()
  );
  await writeJson(sessionsIndexPath(root), nextIndex);
}

/** Read one JSONL event log from disk. */
async function readEventLog(
  path: string,
  limit?: number
): Promise<RuntimeEvent[]> {
  if (!(await pathExists(path))) {
    return [];
  }

  let lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  if (limit !== undefined) {
    lines = lines.slice(-limit);
  }

  return lines.map((line) => JSON.parse(line) as RuntimeEvent);
}

/** Require that one and only one live session exists. */
async function requireLiveSession(root: string): Promise<SessionMeta> {
  const session = await loadLiveSession(root);
  if (!session) {
    throw new RevisError("No live Revis session exists");
  }

  return session;
}

/** Point the runtime event-log path at the current session archive. */
async function pointRuntimeEventsToSession(
  root: string,
  sessionId: string
): Promise<void> {
  await ensureRuntime(root);
  await ensureDir(sessionDir(root, sessionId));
  await writeFile(sessionEventsPath(root, sessionId), "", {
    encoding: "utf8",
    flag: "a"
  });

  const linkPath = eventsPath(root);
  if (await pathExists(linkPath) || (await runtimeEntryExists(linkPath))) {
    await rm(linkPath, { force: true });
  }

  const targetPath = relative(dirname(linkPath), sessionEventsPath(root, sessionId));
  await symlink(targetPath, linkPath);
}

/** Return whether a runtime path exists even when it is a symlink. */
async function runtimeEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

interface LegacyWorkspaceRecord
  extends Omit<
    WorkspaceRecord,
    | "coordinationBranch"
    | "execCommand"
    | "iteration"
    | "localBranch"
    | "sandboxProvider"
    | "workspaceRoot"
  > {
  branch: string;
  expectedPaneCommand?: string;
  lastRelayedSha?: string;
  queuedSteeringMessages?: string[];
  repoPath?: string;
  sandboxProvider?: WorkspaceRecord["sandboxProvider"];
  workspaceRoot?: string;
}

/** Validate one persisted workspace record and normalize its state field. */
function normalizeWorkspaceRecord(
  record: WorkspaceRecord | LegacyWorkspaceRecord
): WorkspaceRecord {
  return {
    ...record,
    coordinationBranch: requireWorkspaceString(record, "coordinationBranch"),
    execCommand: requireWorkspaceString(record, "execCommand"),
    iteration: requireWorkspaceIteration(record),
    localBranch: requireWorkspaceString(record, "localBranch"),
    sandboxProvider: requireSandboxProvider(record),
    state: normalizeAgentState(record.state),
    workspaceRoot: requireWorkspaceString(record, "workspaceRoot"),
    ...(record.attachCmd ? { attachCmd: record.attachCmd } : {}),
    ...(record.attachLabel ? { attachLabel: record.attachLabel } : {})
  };
}

/** Validate the persisted state against the current iteration lifecycle states. */
function normalizeAgentState(state: WorkspaceRecord["state"] | string): WorkspaceRecord["state"] {
  switch (state) {
    case "active":
    case "failed":
    case "starting":
    case "stopped":
      return state;
    default:
      throw new RevisError(`Workspace record is corrupted: invalid state ${String(state)}`);
  }
}

/** Require one non-empty string field on a persisted workspace record. */
function requireWorkspaceString(
  record: Partial<WorkspaceRecord>,
  field: "coordinationBranch" | "execCommand" | "localBranch" | "workspaceRoot"
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new RevisError(`Workspace record is corrupted: missing ${field}`);
  }

  return value;
}

/** Require one persisted workspace iteration counter. */
function requireWorkspaceIteration(record: Partial<WorkspaceRecord>): number {
  const { iteration } = record;
  if (typeof iteration !== "number" || !Number.isInteger(iteration) || iteration < 0) {
    throw new RevisError("Workspace record is corrupted: invalid iteration");
  }

  return iteration;
}

/** Require one valid persisted sandbox-provider value. */
function requireSandboxProvider(
  record: Partial<WorkspaceRecord>
): WorkspaceRecord["sandboxProvider"] {
  if (record.sandboxProvider === "local" || record.sandboxProvider === "daytona") {
    return record.sandboxProvider;
  }

  throw new RevisError("Workspace record is corrupted: invalid sandboxProvider");
}

/** Keep participants ordered in natural agent order for the dashboard lanes. */
function sortParticipants(participants: SessionParticipant[]): SessionParticipant[] {
  return participants
    .slice()
    .sort((left, right) => compareAgentIds(left.agentId, right.agentId));
}

/** Compare agent ids like `agent-2` numerically before lexical fallback. */
function compareAgentIds(left: string, right: string): number {
  const leftMatch = /^agent-(\d+)$/.exec(left);
  const rightMatch = /^agent-(\d+)$/.exec(right);
  if (leftMatch && rightMatch) {
    return Number(leftMatch[1]) - Number(rightMatch[1]);
  }

  return left.localeCompare(right);
}

/** Trim activity lines to the configured line and byte budgets. */
function trimActivityToByteLimit(lines: string[]): string[] {
  let bounded = lines.slice(-ACTIVITY_LINE_LIMIT);
  while (bounded.length > 0 && activityPayloadBytes(bounded) > ACTIVITY_BYTE_LIMIT) {
    bounded = bounded.slice(1);
  }

  return bounded;
}

/** Return the UTF-8 payload size for one persisted activity snapshot. */
function activityPayloadBytes(lines: string[]): number {
  return Buffer.byteLength(`${lines.join("\n")}\n`, "utf8");
}
