/** Local runtime-store wrapper shared by CLI and daemon modules. */

import type {
  DaemonRecord,
  RuntimeEvent,
  SessionMeta,
  SessionSummary,
  WorkspaceRecord
} from "../core/models";
import {
  appendEvent,
  clearRuntime,
  deleteActivitySnapshot,
  deleteDaemonRecord,
  deleteWorkspaceRecord,
  ensureLiveSession,
  finalizeLiveSession,
  loadActivity,
  loadDaemonRecord,
  loadEvents,
  loadLiveSession,
  loadSessionEvents,
  loadSessionIndex,
  loadSessionMeta,
  loadWorkspaceRecord,
  loadWorkspaceRecords,
  markSessionParticipantStopped,
  registerSessionParticipants,
  writeWorkspaceRecord
} from "./runtime";

export interface RuntimeStore {
  appendEvent(event: RuntimeEvent): Promise<void>;
  clearRuntime(): Promise<void>;
  deleteActivitySnapshot(agentId: string): Promise<void>;
  deleteDaemonRecord(): Promise<void>;
  deleteWorkspaceRecord(agentId: string): Promise<void>;
  ensureLiveSession(session: {
    coordinationRemote: string;
    trunkBase: string;
    operatorSlug: string;
  }): Promise<SessionMeta>;
  finalizeLiveSession(endedAt?: string): Promise<SessionMeta | null>;
  loadActivity(agentId: string): Promise<string[]>;
  loadDaemonRecord(): Promise<DaemonRecord | null>;
  loadEvents(limit?: number): Promise<RuntimeEvent[]>;
  loadLiveSession(): Promise<SessionMeta | null>;
  loadSessionEvents(sessionId: string, limit?: number): Promise<RuntimeEvent[]>;
  loadSessionIndex(): Promise<SessionSummary[]>;
  loadSessionMeta(sessionId: string): Promise<SessionMeta | null>;
  loadWorkspaceRecord(agentId: string): Promise<WorkspaceRecord | null>;
  loadWorkspaceRecords(): Promise<WorkspaceRecord[]>;
  markSessionParticipantStopped(
    record: Pick<WorkspaceRecord, "agentId" | "coordinationBranch" | "createdAt">,
    stoppedAt?: string
  ): Promise<void>;
  registerSessionParticipants(records: WorkspaceRecord[]): Promise<void>;
  writeWorkspaceRecord(record: WorkspaceRecord): Promise<void>;
}

/** Return the runtime store for one repository. */
export async function loadRuntimeStore(
  root: string
): Promise<RuntimeStore> {
  return {
    appendEvent(event) {
      return appendEvent(root, event);
    },
    clearRuntime() {
      return clearRuntime(root);
    },
    deleteActivitySnapshot(agentId) {
      return deleteActivitySnapshot(root, agentId);
    },
    deleteDaemonRecord() {
      return deleteDaemonRecord(root);
    },
    deleteWorkspaceRecord(agentId) {
      return deleteWorkspaceRecord(root, agentId);
    },
    ensureLiveSession(session) {
      return ensureLiveSession(root, session);
    },
    finalizeLiveSession(endedAt) {
      return finalizeLiveSession(root, endedAt);
    },
    loadActivity(agentId) {
      return loadActivity(root, agentId);
    },
    loadDaemonRecord() {
      return loadDaemonRecord(root);
    },
    loadEvents(limit) {
      return loadEvents(root, limit);
    },
    loadLiveSession() {
      return loadLiveSession(root);
    },
    loadSessionEvents(sessionId, limit) {
      return loadSessionEvents(root, sessionId, limit);
    },
    loadSessionIndex() {
      return loadSessionIndex(root);
    },
    loadSessionMeta(sessionId) {
      return loadSessionMeta(root, sessionId);
    },
    loadWorkspaceRecord(agentId) {
      return loadWorkspaceRecord(root, agentId);
    },
    loadWorkspaceRecords() {
      return loadWorkspaceRecords(root);
    },
    markSessionParticipantStopped(record, stoppedAt) {
      return markSessionParticipantStopped(root, record, stoppedAt);
    },
    registerSessionParticipants(records) {
      return registerSessionParticipants(root, records);
    },
    writeWorkspaceRecord(record) {
      return writeWorkspaceRecord(root, record);
    }
  };
}
