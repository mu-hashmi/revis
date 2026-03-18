/** Fake `EventJournal` service backed by the orchestration model state. */

import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  SessionMeta,
  SessionParticipant,
  SessionSummary,
  asOperatorSlug,
  asSessionId,
  asTimestamp
} from "../../../src/domain/models";
import type { EventJournalApi } from "../../../src/services/event-journal";
import { currentEvents, type OrchestrationState } from "./model";

/** Build the event journal service for one orchestration test harness. */
export function buildEventJournalService(
  state: OrchestrationState
): EventJournalApi {
  return {
    ensureActiveSession: (options) =>
      Effect.gen(function* () {
        // Session creation is idempotent so repeated global reconciles all append into the same
        // archive view until the daemon shuts down.
        const existing = yield* Ref.get(state.currentSessionRef);
        if (existing) {
          return existing;
        }

        const counter = yield* Ref.updateAndGet(state.sessionCounterRef, (current) => current + 1);
        const session = SessionMeta.make({
          id: asSessionId(`sess-${counter}`),
          startedAt: asTimestamp(
            `2026-03-18T00:00:${String(counter).padStart(2, "0")}.000Z`
          ),
          endedAt: null,
          coordinationRemote: options.coordinationRemote,
          trunkBase: options.trunkBase,
          operatorSlug: asOperatorSlug(options.operatorSlug),
          participants: [],
          participantCount: 0
        });

        yield* Ref.set(state.currentSessionRef, session);
        yield* Ref.update(state.sessionsRef, (current) => new Map(current).set(session.id, session));

        return session;
      }),
    syncParticipants: (snapshots) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state.currentSessionRef);
        if (!current) {
          return null;
        }

        // Mirror the live workspace registry into the archived participant list.
        const now = asTimestamp(
          `2026-03-18T01:00:${String(snapshots.length).padStart(2, "0")}.000Z`
        );
        const activeAgentIds = new Set(snapshots.map((snapshot) => snapshot.agentId));
        const participants = new Map(
          current.participants.map((participant) => [participant.agentId, participant])
        );

        for (const snapshot of snapshots) {
          const existing = participants.get(snapshot.agentId);

          participants.set(
            snapshot.agentId,
            SessionParticipant.make({
              agentId: snapshot.agentId,
              coordinationBranch: snapshot.spec.coordinationBranch,
              startedAt: existing?.startedAt ?? now,
              stoppedAt: null
            })
          );
        }

        for (const participant of current.participants) {
          if (activeAgentIds.has(participant.agentId) || participant.stoppedAt !== null) {
            continue;
          }

          participants.set(
            participant.agentId,
            SessionParticipant.make({
              ...participant,
              stoppedAt: now
            })
          );
        }

        const next = SessionMeta.make({
          ...current,
          participants: [...participants.values()],
          participantCount: [...participants.values()].filter(
            (participant) => participant.stoppedAt === null
          ).length
        });

        yield* Ref.set(state.currentSessionRef, next);
        yield* Ref.update(state.sessionsRef, (currentSessions) =>
          new Map(currentSessions).set(next.id, next)
        );

        return next;
      }),
    activeSession: Ref.get(state.currentSessionRef),
    closeActiveSession: Effect.gen(function* () {
      const current = yield* Ref.get(state.currentSessionRef);
      if (!current) {
        return null;
      }

      // Closing the session clears only the "active" pointer; historical meta stays available.
      const ended = SessionMeta.make({
        ...current,
        endedAt: asTimestamp("2026-03-18T02:00:00.000Z")
      });

      yield* Ref.set(state.currentSessionRef, null);
      yield* Ref.update(state.sessionsRef, (all) => new Map(all).set(ended.id, ended));

      return ended;
    }),
    append: (event) =>
      Effect.gen(function* () {
        yield* Ref.update(state.liveEventsRef, (current) => [...current, event]);
        yield* PubSub.publish(state.eventPubSub, event);
      }),
    loadEvents: (limit) =>
      currentEvents(state).pipe(
        Effect.map((events) =>
          limit === undefined || limit <= 0 ? events : events.slice(-limit)
        )
      ),
    stream: Stream.fromPubSub(state.eventPubSub),
    listSessions: Ref.get(state.sessionsRef).pipe(
      Effect.map((sessions) =>
        [...sessions.values()]
          .map((session) =>
            SessionSummary.make({
              id: session.id,
              startedAt: session.startedAt,
              endedAt: session.endedAt,
              coordinationRemote: session.coordinationRemote,
              trunkBase: session.trunkBase,
              operatorSlug: session.operatorSlug,
              participantCount: session.participantCount
            })
          )
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      )
    ),
    loadSessionMeta: (sessionId) =>
      Ref.get(state.sessionsRef).pipe(
        Effect.map((sessions) => sessions.get(sessionId) ?? null)
      ),
    loadSessionEvents: (_sessionId, limit) =>
      currentEvents(state).pipe(
        Effect.map((events) =>
          limit === undefined || limit <= 0 ? events : events.slice(-limit)
        )
      )
  };
}
