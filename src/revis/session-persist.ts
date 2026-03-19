/** File-backed Sandbox Agent session persistence for one Revis run. */

import type * as FileSystem from "@effect/platform/FileSystem";
import type * as Path from "@effect/platform/Path";
import { join } from "node:path";

import { Effect, Runtime, Schema } from "effect";
import type {
  ListEventsRequest,
  ListPage,
  ListPageRequest,
  SessionEvent,
  SessionPersistDriver,
  SessionRecord
} from "sandbox-agent";

import { pathExists, readDirectory, readJsonFile, readJsonLines, writeJsonFile, appendJsonLine } from "./files";

const SessionRecordSchema = Schema.Struct({
  id: Schema.String,
  agent: Schema.String,
  agentSessionId: Schema.String,
  lastConnectionId: Schema.String,
  createdAt: Schema.Number,
  destroyedAt: Schema.optionalWith(Schema.Number, { nullable: true }),
  sandboxId: Schema.optionalWith(Schema.String, { nullable: true }),
  sessionInit: Schema.optional(Schema.Unknown),
  configOptions: Schema.optional(Schema.Array(Schema.Unknown)),
  modes: Schema.optional(Schema.Unknown)
});

const SessionEventSchema = Schema.Struct({
  id: Schema.String,
  eventIndex: Schema.Number,
  sessionId: Schema.String,
  createdAt: Schema.Number,
  connectionId: Schema.String,
  sender: Schema.Literal("client", "agent"),
  payload: Schema.Unknown
});

/** Persist SDK session state inside `.revis/runs/<run-id>/`. */
export class FileSessionPersistDriver implements SessionPersistDriver {
  /** Build a driver backed by the current Effect runtime services. */
  static make(paths: { readonly eventsDir: string; readonly sessionsDir: string }) {
    return Effect.map(
      Effect.runtime<FileSystem.FileSystem | Path.Path>(),
      (runtime) => new FileSessionPersistDriver(runtime, paths)
    );
  }

  readonly eventsDir: string;
  readonly runtime: Runtime.Runtime<FileSystem.FileSystem | Path.Path>;
  readonly sessionsDir: string;

  constructor(
    runtime: Runtime.Runtime<FileSystem.FileSystem | Path.Path>,
    paths: { readonly eventsDir: string; readonly sessionsDir: string }
  ) {
    this.eventsDir = paths.eventsDir;
    this.runtime = runtime;
    this.sessionsDir = paths.sessionsDir;
  }

  /** Load one session record when it exists. */
  getSession(id: string): Promise<SessionRecord | undefined> {
    return Runtime.runPromise(this.runtime, this.getSessionEffect(id));
  }

  /** Load one session record from disk inside the ambient Effect runtime. */
  getSessionEffect(id: string) {
    const path = this.sessionPath(id);

    return Effect.gen(function* () {
      if (!(yield* pathExists(path))) {
        return undefined;
      }

      return (yield* readJsonFile(path, SessionRecordSchema)) as SessionRecord;
    });
  }

  /** List persisted sessions in creation order. */
  listSessions(request: ListPageRequest = {}): Promise<ListPage<SessionRecord>> {
    return Runtime.runPromise(this.runtime, this.listSessionsEffect(request));
  }

  /** List every persisted session in stable creation order. */
  listSessionsEffect(request: ListPageRequest = {}) {
    const self = this;

    return Effect.gen(function* () {
      if (!(yield* pathExists(self.sessionsDir))) {
        return { items: [] };
      }

      const names = (yield* readDirectory(self.sessionsDir))
        .filter((name) => name.endsWith(".json"))
        .sort();
      const items = yield* Effect.forEach(
        names,
        (name) => Effect.map(
          readJsonFile(join(self.sessionsDir, name), SessionRecordSchema),
          (item) => item as SessionRecord
        )
      );

      return paginate(
        items.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
        request
      );
    });
  }

  /** Upsert one session record. */
  updateSession(session: SessionRecord): Promise<void> {
    return Runtime.runPromise(this.runtime, this.updateSessionEffect(session));
  }

  /** Persist one full session snapshot. */
  updateSessionEffect(session: SessionRecord) {
    return writeJsonFile(this.sessionPath(session.id), SessionRecordSchema, session);
  }

  /** List persisted events for one session in event-index order. */
  listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    return Runtime.runPromise(this.runtime, this.listEventsEffect(request));
  }

  /** List persisted events for one session in stable event-index order. */
  listEventsEffect(request: ListEventsRequest) {
    const path = this.eventsPath(request.sessionId);

    return Effect.gen(function* () {
      if (!(yield* pathExists(path))) {
        return { items: [] };
      }

      const items = (yield* readJsonLines(path, SessionEventSchema)) as SessionEvent[];
      items.sort((left, right) => left.eventIndex - right.eventIndex || left.id.localeCompare(right.id));
      return paginate(items, request);
    });
  }

  /** Append one event to the session log. */
  insertEvent(_sessionId: string, event: SessionEvent): Promise<void> {
    return Runtime.runPromise(this.runtime, this.insertEventEffect(event));
  }

  /** Append one session event to the JSONL log. */
  insertEventEffect(event: SessionEvent) {
    return appendJsonLine(this.eventsPath(event.sessionId), SessionEventSchema, event);
  }

  /** Resolve the on-disk session record path. */
  private sessionPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  /** Resolve the on-disk session event path. */
  private eventsPath(sessionId: string): string {
    return join(this.eventsDir, `${sessionId}.jsonl`);
  }
}

/** Apply cursor/limit pagination to an already materialized item list. */
function paginate<T>(items: readonly T[], request: ListPageRequest): ListPage<T> {
  const offset = request.cursor ? Number(request.cursor) : 0;
  const limit = request.limit ?? 100;
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    ...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
    items: [...page]
  };
}
