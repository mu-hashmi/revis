/** Append-only runtime journal with live fan-out and session archive projection. */

import { FileSystem } from "@effect/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ProjectPaths, type ProjectPathsApi } from "./project-paths";
import {
  appendJsonLine,
  ensureDirectory,
  readJsonFile,
  readJsonFileIfExists,
  readJsonLines,
  writeJsonFile
} from "../platform/storage";
import { StorageError } from "../domain/errors";
import {
  RuntimeEventSchema,
  SessionId,
  SessionMeta,
  SessionParticipant,
  SessionSummary,
  Timestamp,
  type RuntimeEvent,
  type WorkspaceSnapshot
} from "../domain/models";
import { isoNow } from "../platform/time";

export interface EventJournalApi {
  readonly ensureActiveSession: (options: {
    coordinationRemote: string;
    trunkBase: string;
    operatorSlug: string;
  }) => Effect.Effect<SessionMeta, StorageError>;
  readonly syncParticipants: (
    snapshots: ReadonlyArray<WorkspaceSnapshot>
  ) => Effect.Effect<Option.Option<SessionMeta>, StorageError>;
  readonly activeSession: Effect.Effect<Option.Option<SessionMeta>, StorageError>;
  readonly closeActiveSession: Effect.Effect<Option.Option<SessionMeta>, StorageError>;
  readonly append: (event: RuntimeEvent) => Effect.Effect<void, StorageError>;
  readonly loadEvents: (limit?: number) => Effect.Effect<ReadonlyArray<RuntimeEvent>, StorageError>;
  readonly stream: Stream.Stream<RuntimeEvent>;
  readonly listSessions: Effect.Effect<ReadonlyArray<SessionSummary>, StorageError>;
  readonly loadSessionMeta: (
    sessionId: string
  ) => Effect.Effect<Option.Option<SessionMeta>, StorageError>;
  readonly loadSessionEvents: (
    sessionId: string,
    limit?: number
  ) => Effect.Effect<ReadonlyArray<RuntimeEvent>, StorageError>;
}

interface EventJournalState {
  readonly currentSession: Option.Option<SessionMeta>;
  readonly summaries: ReadonlyArray<SessionSummary>;
}

/** Append-only event log plus archive/session projections for daemon and UI consumers. */
export class EventJournal extends Context.Tag("@revis/EventJournal")<
  EventJournal,
  EventJournalApi
>() {}

export const eventJournalLayer = Layer.scoped(
  EventJournal,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* ProjectPaths;

    // Prepare the on-disk journal and archive layout.
    yield* ensureDirectory(fs, paths.journalDir);
    yield* ensureDirectory(fs, paths.archiveDir);
    yield* ensureDirectory(fs, paths.sessionsDir);

    // Keep the active session pointer and summary index in one synchronized state cell so archive
    // writes and in-memory views cannot drift apart under concurrent updates.
    const summaries = yield* loadSessionSummaries(fs, paths);
    const currentSession = yield* recoverCurrentSession(fs, paths, summaries);
    const stateRef = yield* SynchronizedRef.make<EventJournalState>({
      currentSession: Option.fromNullable(currentSession),
      summaries: [...summaries].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    });
    const pubsub = yield* Effect.acquireRelease(
      PubSub.sliding<RuntimeEvent>(64),
      (events) => PubSub.shutdown(events)
    );

    /** Ensure the current daemon lifetime has one writable archive session. */
    const ensureActiveSession = (options: {
      coordinationRemote: string;
      trunkBase: string;
      operatorSlug: string;
    }) =>
      SynchronizedRef.modifyEffect(stateRef, (state) =>
        Option.match(state.currentSession, {
          onSome: (existing) => Effect.succeed([existing, state] as const),
          onNone: () =>
            Effect.gen(function* () {
              const session = SessionMeta.make({
                id: SessionId.make(`sess-${crypto.randomUUID()}`),
                startedAt: isoNow() as Timestamp,
                endedAt: null,
                coordinationRemote: options.coordinationRemote,
                trunkBase: options.trunkBase,
                operatorSlug: options.operatorSlug as SessionMeta["operatorSlug"],
                participants: [],
                participantCount: 0
              });

              yield* ensureDirectory(fs, paths.sessionDir(session.id));
              yield* writeJsonFile(fs, paths.sessionMetaFile(session.id), SessionMeta, session);
              yield* fs.writeFileString(paths.liveJournalFile, "").pipe(
                Effect.mapError((error) =>
                  StorageError.make({
                    path: paths.liveJournalFile,
                    message: error.message
                  })
                )
              );

              return [
                session,
                {
                  currentSession: Option.some(session),
                  summaries: upsertSessionSummary(state.summaries, session)
                }
              ] as const;
            })
        })
      );

    /** Refresh the active session participant list from the current workspace snapshots. */
    const syncParticipants = (snapshots: ReadonlyArray<WorkspaceSnapshot>) =>
      SynchronizedRef.modifyEffect(stateRef, (state) =>
        Option.match(state.currentSession, {
          onNone: () => Effect.succeed([Option.none<SessionMeta>(), state] as const),
          onSome: (current) =>
            Effect.gen(function* () {
              // Rebuild the participant model from the latest workspace snapshots.
              const now = isoNow() as Timestamp;
              const activeAgentIds = new Set(snapshots.map((snapshot) => snapshot.agentId));
              const nextParticipants = new Map(
                current.participants.map((participant) => [participant.agentId, participant])
              );

              for (const snapshot of snapshots) {
                const existing = nextParticipants.get(snapshot.agentId);
                if (existing) {
                  nextParticipants.set(
                    snapshot.agentId,
                    SessionParticipant.make({
                      ...existing,
                      coordinationBranch: snapshot.spec.coordinationBranch,
                      stoppedAt: null
                    })
                  );
                  continue;
                }

                nextParticipants.set(
                  snapshot.agentId,
                  SessionParticipant.make({
                    agentId: snapshot.agentId,
                    coordinationBranch: snapshot.spec.coordinationBranch,
                    startedAt: now,
                    stoppedAt: null
                  })
                );
              }

              for (const participant of current.participants) {
                if (activeAgentIds.has(participant.agentId) || participant.stoppedAt !== null) {
                  continue;
                }

                nextParticipants.set(
                  participant.agentId,
                  SessionParticipant.make({
                    ...participant,
                    stoppedAt: now
                  })
                );
              }

              const next = SessionMeta.make({
                ...current,
                participants: [...nextParticipants.values()],
                participantCount: [...nextParticipants.values()].filter(
                  (participant) => participant.stoppedAt === null
                ).length
              });

              // Persist the archive first, then publish the matching in-memory state.
              yield* writeJsonFile(fs, paths.sessionMetaFile(next.id), SessionMeta, next);

              return [
                Option.some(next),
                {
                  currentSession: Option.some(next),
                  summaries: upsertSessionSummary(state.summaries, next)
                }
              ] as const;
            })
        })
      );

    /** Mark the active session as ended and persist the final session summary view. */
    const closeActiveSession = SynchronizedRef.modifyEffect(stateRef, (state) =>
      Option.match(state.currentSession, {
        onNone: () => Effect.succeed([Option.none<SessionMeta>(), state] as const),
        onSome: (current) => {
          if (current.endedAt !== null) {
            return Effect.succeed([Option.some(current), state] as const);
          }

          return Effect.gen(function* () {
            const ended = SessionMeta.make({
              ...current,
              endedAt: isoNow() as Timestamp
            });

            // Write the final archive snapshot before clearing the live-session pointer.
            yield* writeJsonFile(fs, paths.sessionMetaFile(ended.id), SessionMeta, ended);

            return [
              Option.some(ended),
              {
                currentSession: Option.none<SessionMeta>(),
                summaries: upsertSessionSummary(state.summaries, ended)
              }
            ] as const;
          });
        }
      })
    );

    /** Append one runtime event to the live log, active archive, and in-process stream. */
    const append = (event: RuntimeEvent) =>
      Effect.gen(function* () {
        // Serialize archive writes against session transitions so an event cannot race with close
        // or participant updates and land in inconsistent on-disk state.
        yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
          Effect.gen(function* () {
            yield* appendJsonLine(fs, paths.liveJournalFile, RuntimeEventSchema, event);

            if (Option.isSome(state.currentSession)) {
              yield* appendJsonLine(
                fs,
                paths.sessionEventsFile(state.currentSession.value.id),
                RuntimeEventSchema,
                event
              );
            }

            return [undefined, state] as const;
          })
        );

        yield* PubSub.publish(pubsub, event);
      });

    // Expose the journal API on top of the recovered refs and pubsub stream.
    return EventJournal.of({
      ensureActiveSession,
      syncParticipants,
      activeSession: SynchronizedRef.get(stateRef).pipe(Effect.map((state) => state.currentSession)),
      closeActiveSession,
      append,
      loadEvents: (limit) => readJsonLines(fs, paths.liveJournalFile, RuntimeEventSchema, limit),
      stream: Stream.fromPubSub(pubsub),
      listSessions: SynchronizedRef.get(stateRef).pipe(Effect.map((state) => state.summaries)),
      loadSessionMeta: (sessionId) => readJsonFileIfExists(fs, paths.sessionMetaFile(sessionId), SessionMeta),
      loadSessionEvents: (sessionId, limit) =>
        readJsonLines(fs, paths.sessionEventsFile(sessionId), RuntimeEventSchema, limit)
    });
  })
);

/** Load archived session summaries from disk for dashboard and daemon startup. */
function loadSessionSummaries(
  fs: FileSystem.FileSystem,
  paths: ProjectPathsApi
): Effect.Effect<ReadonlyArray<SessionSummary>, StorageError> {
  return fs.readDirectory(paths.sessionsDir).pipe(
    Effect.catchTag("SystemError", (error) =>
      error.reason === "NotFound" ? Effect.succeed([]) : Effect.fail(error)
    ),
    Effect.mapError((error) =>
      StorageError.make({
        path: paths.sessionsDir,
        message: error.message
      })
    ),
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries.sort(),
        (entry) =>
          readJsonFileIfExists(fs, paths.sessionMetaFile(entry), SessionMeta).pipe(
            Effect.map((meta) =>
              Option.match(meta, {
                onNone: () => Option.none<SessionSummary>(),
                onSome: (session) => Option.some(sessionSummary(session))
              })
            )
          ),
        { concurrency: "unbounded" }
      )
    ),
    Effect.map((entries) => entries.filter(Option.isSome).map((entry) => entry.value))
  );
}

/** Recover the one session that should continue receiving events after a daemon restart. */
function recoverCurrentSession(
  fs: FileSystem.FileSystem,
  paths: ProjectPathsApi,
  summaries: ReadonlyArray<SessionSummary>
): Effect.Effect<SessionMeta | null, StorageError> {
  return Effect.gen(function* () {
    const liveSummaries = summaries
      .filter((summary) => summary.endedAt === null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    if (liveSummaries.length === 0) {
      return null;
    }

    // If multiple live sessions survived a crash, prefer the newest one rather than guessing
    // how to merge overlapping archives.
    return yield* readJsonFile(fs, paths.sessionMetaFile(liveSummaries[0]!.id), SessionMeta);
  });
}

/** Project one session metadata record into the dashboard/session index summary shape. */
function sessionSummary(session: SessionMeta): SessionSummary {
  return SessionSummary.make({
    id: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    coordinationRemote: session.coordinationRemote,
    trunkBase: session.trunkBase,
    operatorSlug: session.operatorSlug,
    participantCount: session.participantCount
  });
}

/** Insert or replace one session summary while keeping newest sessions first. */
function upsertSessionSummary(
  summaries: ReadonlyArray<SessionSummary>,
  session: SessionMeta
): ReadonlyArray<SessionSummary> {
  return [sessionSummary(session), ...summaries.filter((summary) => summary.id !== session.id)].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt)
  );
}
