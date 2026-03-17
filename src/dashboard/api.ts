/** Browser-side fetch helpers for session archives and commit detail. */

import type { RuntimeEvent, SessionMeta, SessionSummary } from "../domain/models";

/** Load the archived/live session index. */
export async function fetchSessions(): Promise<SessionSummary[]> {
  const response = await fetch("/api/sessions", {
    cache: "no-store"
  });
  return expectJson<SessionSummary[]>(response);
}

/** Load one session metadata file. */
export async function fetchSessionMeta(sessionId: string): Promise<SessionMeta> {
  return expectJson<SessionMeta>(
    await fetch(`/api/sessions/${sessionId}/meta`, {
      cache: "no-store"
    })
  );
}

/** Load one session's archived event log. */
export async function fetchSessionEvents(sessionId: string): Promise<RuntimeEvent[]> {
  const response = await fetch(`/api/sessions/${sessionId}/events`, {
    cache: "no-store"
  });
  if (response.status === 404) {
    // A session can exist before any archived events have been written, so treat that as empty.
    return [];
  }

  return expectJson<RuntimeEvent[]>(response);
}

/** Load raw commit detail from local git. */
export async function fetchCommitDetail(sha: string): Promise<string> {
  const response = await fetch(`/api/git/show?sha=${encodeURIComponent(sha)}`, {
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
