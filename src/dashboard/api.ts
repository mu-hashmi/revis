/** Browser-side fetch helpers for session archives and commit detail. */

import * as Schema from "effect/Schema";

import { RuntimeEventSchema, SessionMeta, SessionSummary } from "../domain/models";

/** Load the archived/live session index. */
export async function fetchSessions(): Promise<SessionSummary[]> {
  const response = await fetch("/api/sessions", {
    cache: "no-store"
  });
  return [...(await expectJson(response, Schema.Array(SessionSummary)))];
}

/** Load one session metadata file. */
export async function fetchSessionMeta(sessionId: string): Promise<SessionMeta> {
  return expectJson(
    await fetch(`/api/sessions/${sessionId}/meta`, {
      cache: "no-store"
    }),
    SessionMeta
  );
}

/** Load one session's archived event log. */
export async function fetchSessionEvents(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/events`, {
    cache: "no-store"
  });
  if (response.status === 404) {
    // A session can exist before any archived events have been written, so treat that as empty.
    return [];
  }

  return [...(await expectJson(response, Schema.Array(RuntimeEventSchema)))];
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
async function expectJson<A, I>(response: Response, schema: Schema.Schema<A, I>): Promise<A> {
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return Schema.decodeUnknownSync(schema)(await response.json());
}
