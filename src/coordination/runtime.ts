/** JSON-backed runtime state for status and monitor views. */

import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

import type {
  DaemonRecord,
  RelayRegistry,
  RuntimeEvent,
  WorkspaceRecord
} from "../core/models";
import {
  appendJsonl,
  ensureDir,
  pathExists,
  readJson,
  writeJson
} from "../core/files";

const RUNTIME_DIR = join(".revis", "runtime");
const EVENT_LIMIT = 500;
const ACTIVITY_LINE_LIMIT = 200;
const ACTIVITY_BYTE_LIMIT = 128_000;

/** Return the runtime root directory. */
export function runtimeDir(root: string): string {
  return join(root, RUNTIME_DIR);
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

/** Return the relay registry path. */
export function relayRegistryPath(root: string): string {
  return join(runtimeDir(root), "relays.json");
}

/** Return one workspace runtime record path. */
export function workspaceRecordPath(root: string, agentId: string): string {
  return join(workspacesDir(root), `${agentId}.json`);
}

/** Return the activity snapshot path for one workspace. */
export function activityPath(root: string, agentId: string): string {
  return join(activityDir(root), `${agentId}.log`);
}

/** Ensure the runtime root exists. */
export async function ensureRuntime(root: string): Promise<void> {
  await ensureDir(runtimeDir(root));
  await ensureDir(workspacesDir(root));
  await ensureDir(activityDir(root));
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

  const { readdir } = await import("node:fs/promises");
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

/** Persist relay dedupe state. */
export async function writeRelayRegistry(
  root: string,
  registry: RelayRegistry
): Promise<void> {
  await writeRuntimeJson(root, relayRegistryPath(root), registry);
}

/** Load relay dedupe state. */
export async function loadRelayRegistry(root: string): Promise<RelayRegistry> {
  const registry = await loadRuntimeJsonOrNull<RelayRegistry>(relayRegistryPath(root));
  if (!registry) {
    return { byBranch: {} };
  }

  return registry;
}

/** Remove relay dedupe state. */
export async function deleteRelayRegistry(root: string): Promise<void> {
  await rm(relayRegistryPath(root), { force: true });
}

/** Append one runtime event and enforce a bounded live log. */
export async function appendEvent(
  root: string,
  event: RuntimeEvent
): Promise<void> {
  await ensureRuntime(root);
  const path = eventsPath(root);
  await appendJsonl(path, event as unknown as Record<string, unknown>);

  const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  if (lines.length > EVENT_LIMIT) {
    const keep = lines.slice(-EVENT_LIMIT);
    await writeFile(path, `${keep.join("\n")}\n`, "utf8");
  }
}

/** Load recent runtime events. */
export async function loadEvents(
  root: string,
  limit?: number
): Promise<RuntimeEvent[]> {
  const path = eventsPath(root);
  if (!(await pathExists(path))) {
    return [];
  }

  let lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  if (limit !== undefined) {
    lines = lines.slice(-limit);
  }

  return lines.map((line) => JSON.parse(line) as RuntimeEvent);
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

interface LegacyWorkspaceRecord extends Omit<WorkspaceRecord, "coordinationBranch" | "localBranch"> {
  branch: string;
}

/** Normalize persisted workspace records across branch-model changes. */
function normalizeWorkspaceRecord(
  record: WorkspaceRecord | LegacyWorkspaceRecord
): WorkspaceRecord {
  if ("coordinationBranch" in record && "localBranch" in record) {
    return record;
  }

  return {
    ...record,
    coordinationBranch: record.branch,
    localBranch: record.branch
  };
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
