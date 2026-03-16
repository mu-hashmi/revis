/** Browser-side fetch helpers for session archives and commit detail. */

import type { RuntimeEvent, SessionMeta, SessionSummary } from "../core/models";

/** Load the archived/live session index. */
export async function fetchSessions(): Promise<SessionSummary[]> {
  const response = await fetch("/sessions/index.json", {
    cache: "no-store"
  });
  if (response.status === 404) {
    return [];
  }

  return expectJson<SessionSummary[]>(response);
}

/** Load one session metadata file. */
export async function fetchSessionMeta(sessionId: string): Promise<SessionMeta> {
  return expectJson<SessionMeta>(
    await fetch(`/sessions/${sessionId}/meta.json`, {
      cache: "no-store"
    })
  );
}

/** Load one session's full JSONL event log. */
export async function fetchSessionEvents(sessionId: string): Promise<RuntimeEvent[]> {
  const response = await fetch(`/sessions/${sessionId}/events.jsonl`, {
    cache: "no-store"
  });
  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return parseJsonl(await response.text());
}

/** Load raw commit detail from local git. */
export async function fetchCommitDetail(sha: string): Promise<string> {
  const response = await fetch(`/git/show?sha=${encodeURIComponent(sha)}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.text();
}

/** Parse one JSON response and surface HTTP failures loudly. */
async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as T;
}

/** Parse one runtime JSONL payload into events. */
function parseJsonl(payload: string): RuntimeEvent[] {
  return payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEvent);
}
