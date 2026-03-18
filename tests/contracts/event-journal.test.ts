/** Behavioral contract tests for `EventJournal` against the real filesystem layer. */

import * as NodeContext from "@effect/platform-node/NodeContext";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  DaemonStarted,
  WorkspaceProvisioned,
  asAgentId,
  asBranchName,
  asOperatorSlug,
  asTimestamp
} from "../../src/domain/models";
import { eventJournalLayer, EventJournal } from "../../src/services/event-journal";
import { projectPathsLayer } from "../../src/services/project-paths";
import { makeRestartPendingSnapshot } from "../support/factories";
import { makeTempDirScoped } from "../support/helpers";

describe("EventJournal", () => {
  it.scoped("appends events to the live log and active session archive", () =>
    withEventJournal("revis-event-journal-", (root) =>
      Effect.gen(function* () {
        const journal = yield* EventJournal;

        // Start one active session, append one event, and assert both the live log and the
        // session-specific archive view observe the same append.
        const session = yield* journal.ensureActiveSession({
          coordinationRemote: "origin",
          trunkBase: "main",
          operatorSlug: "operator-1"
        });
        const event = DaemonStarted.make({
          timestamp: asTimestamp("2026-03-18T00:00:00.000Z"),
          summary: "Daemon started"
        });

        yield* journal.append(event);

        expect(yield* journal.loadEvents()).toStrictEqual([event]);
        expect(yield* journal.loadSessionEvents(session.id)).toStrictEqual([event]);
      })
    )
  );

  it.scoped("streams events to subscribers in order", () =>
    withEventJournal("revis-event-journal-stream-", () =>
      Effect.gen(function* () {
        const journal = yield* EventJournal;

        // Subscribe before appending so the stream assertion covers live delivery order rather
        // than replay from disk.
        const eventsFiber = yield* Effect.forkScoped(
          Stream.runCollect(journal.stream.pipe(Stream.take(2)))
        );
        const first = DaemonStarted.make({
          timestamp: asTimestamp("2026-03-18T00:00:00.000Z"),
          summary: "First"
        });
        const second = DaemonStarted.make({
          timestamp: asTimestamp("2026-03-18T00:00:01.000Z"),
          summary: "Second"
        });

        yield* journal.append(first);
        yield* journal.append(second);

        expect(Array.from(yield* Fiber.join(eventsFiber))).toStrictEqual([first, second]);
      })
    )
  );

  it.scoped("keeps ensureActiveSession idempotent and closeActiveSession finalizes it", () =>
    withEventJournal("revis-event-journal-session-", () =>
      Effect.gen(function* () {
        const journal = yield* EventJournal;

        // The same daemon session may ask for the active archive more than once. The service
        // should return the existing session until it is explicitly closed.
        const first = yield* journal.ensureActiveSession({
          coordinationRemote: "origin",
          trunkBase: "main",
          operatorSlug: "operator-1"
        });
        const second = yield* journal.ensureActiveSession({
          coordinationRemote: "origin",
          trunkBase: "main",
          operatorSlug: "operator-1"
        });
        const ended = yield* journal.closeActiveSession;

        expect(second.id).toBe(first.id);
        expect(ended?.id).toBe(first.id);
        expect(ended?.endedAt).not.toBeNull();
        expect(yield* journal.activeSession).toBeNull();
      })
    )
  );

  it.scoped("isolates events by session", () =>
    withEventJournal("revis-event-journal-isolation-", () =>
      Effect.gen(function* () {
        const journal = yield* EventJournal;

        // Close the first session before starting the second so the archive files should diverge
        // cleanly by session id.
        const firstSession = yield* journal.ensureActiveSession({
          coordinationRemote: "origin",
          trunkBase: "main",
          operatorSlug: "operator-1"
        });
        const firstEvent = DaemonStarted.make({
          timestamp: asTimestamp("2026-03-18T00:00:00.000Z"),
          summary: "First session"
        });

        yield* journal.append(firstEvent);
        yield* journal.closeActiveSession;

        const secondSession = yield* journal.ensureActiveSession({
          coordinationRemote: "origin",
          trunkBase: "main",
          operatorSlug: "operator-1"
        });
        const secondEvent = WorkspaceProvisioned.make({
          timestamp: asTimestamp("2026-03-18T00:01:00.000Z"),
          agentId: asAgentId("agent-1"),
          branch: asBranchName("revis/operator-1/agent-1/work"),
          summary: "Provisioned agent-1"
        });

        yield* journal.append(secondEvent);

        expect(firstSession.id).not.toBe(secondSession.id);
        expect(yield* journal.loadSessionEvents(firstSession.id)).toStrictEqual([firstEvent]);
        expect(yield* journal.loadSessionEvents(secondSession.id)).toStrictEqual([secondEvent]);
      })
    )
  );

  it.scoped("syncs participants by adding active workspaces and marking removed ones stopped", () =>
    withEventJournal("revis-event-journal-participants-", (root) =>
      Effect.gen(function* () {
        const journal = yield* EventJournal;
        const session = yield* journal.ensureActiveSession({
          coordinationRemote: "origin",
          trunkBase: "main",
          operatorSlug: "operator-1"
        });
        const first = makeRestartPendingSnapshot(root, {
          agentId: asAgentId("agent-1"),
          operatorSlug: asOperatorSlug("operator-1")
        });
        const second = makeRestartPendingSnapshot(root, {
          agentId: asAgentId("agent-2"),
          operatorSlug: asOperatorSlug("operator-1")
        });

        // The second sync removes agent-1 from the live participant list, so the archived session
        // metadata should retain the participant and mark it stopped.
        const initial = yield* journal.syncParticipants([first, second]);
        const updated = yield* journal.syncParticipants([second]);

        expect(initial?.participantCount).toBe(2);
        expect(updated?.participantCount).toBe(1);
        expect(updated?.participants.find((participant) => participant.agentId === first.agentId)?.stoppedAt).not.toBeNull();
        expect((yield* journal.loadSessionMeta(session.id))?.participantCount).toBe(1);
      })
    )
  );
});

/** Provide a fresh filesystem-backed event journal inside one scoped temp directory. */
function withEventJournal(
  prefix: string,
  run: (root: string) => Effect.Effect<void, unknown, EventJournal | Scope.Scope>
) {
  return makeTempDirScoped(prefix).pipe(
    Effect.flatMap((root) => run(root).pipe(Effect.provide(makeEventJournalLayer(root))))
  );
}

/** Compose the real path and journal layers used by the event-journal contract tests. */
function makeEventJournalLayer(root: string) {
  const platformLayer = NodeContext.layer;
  const pathsLayer = projectPathsLayer(root).pipe(Layer.provide(platformLayer));
  const journalLayer = eventJournalLayer.pipe(
    Layer.provide(Layer.merge(platformLayer, pathsLayer))
  );

  return Layer.mergeAll(platformLayer, pathsLayer, journalLayer);
}
