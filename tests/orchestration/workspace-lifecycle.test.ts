/** Workflow tests for workspace creation, deletion, and agent-id allocation rules. */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FastCheck from "effect/FastCheck";

import { WorkspaceStopped } from "../../src/domain/models";
import { EventJournal } from "../../src/services/event-journal";
import { WorkspaceStore } from "../../src/services/workspace-store";
import {
  createWorkspaces,
  stopWorkspace
} from "../../src/workflows/workspace-lifecycle";
import {
  makeOrchestrationHarness
} from "../support/orchestration-harness";
import { makeRestartPendingSnapshot } from "../support/factories";

describe("workspace lifecycle workflows", () => {
  it.scoped("allocates the lowest unused agent ids and records provision events", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          // Leave a gap at agent-1 so the workflow has to allocate around an existing workspace.
          yield* harness.controls.seedWorkspace(
            makeRestartPendingSnapshot(harness.paths.root, {
              agentId: "agent-2" as never
            })
          );

          // Creating two workspaces should fill the lowest unused ids and persist the resulting
          // snapshots and provision events.
          const created = yield* createWorkspaces(2, "echo test");
          const events = yield* harness.controls.currentEvents;
          const snapshots = yield* WorkspaceStore.pipe(Effect.flatMap((store) => store.list));

          expect(created.map((snapshot) => snapshot.agentId)).toStrictEqual([
            "agent-1",
            "agent-3"
          ]);
          expect(snapshots.map((snapshot) => snapshot.agentId)).toStrictEqual([
            "agent-1",
            "agent-2",
            "agent-3"
          ]);
          expect(events.filter((event) => event._tag === "WorkspaceProvisioned")).toHaveLength(2);
        }).pipe(Effect.provide(harness.layer))
      )
    )
  );

  it.scoped("stops and removes one workspace while appending the stop event", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          // Stop the workspace through the workflow, not through the test controls, so the event
          // journal and store updates come from the real operator-facing code path.
          const created = (yield* createWorkspaces(1, "echo test"))[0]!;
          const stopped = yield* stopWorkspace(created.agentId);
          const store = yield* WorkspaceStore;
          const events = yield* EventJournal.pipe(Effect.flatMap((journal) => journal.loadEvents()));

          expect(stopped?.agentId).toBe(created.agentId);
          expect(yield* store.get(created.agentId)).toBeNull();
          expect(events.at(-1)).toBeInstanceOf(WorkspaceStopped);
        }).pipe(Effect.provide(harness.layer))
      )
    )
  );

  it.effect.prop(
    "fills gaps from the lowest unused agent id upward",
    {
      used: FastCheck.uniqueArray(FastCheck.integer({ min: 1, max: 8 }), {
        maxLength: 5
      }),
      count: FastCheck.integer({ min: 1, max: 3 })
    },
    ({ used, count }) =>
      makeOrchestrationHarness().pipe(
        Effect.flatMap((harness) =>
          Effect.gen(function* () {
            // Seed a sparse set of used agent ids, then assert the workflow allocates from the
            // lowest remaining ids upward regardless of insertion order.
            for (const index of used) {
              yield* harness.controls.seedWorkspace(
                makeRestartPendingSnapshot(harness.paths.root, {
                  agentId: `agent-${index}` as never
                })
              );
            }

            const created = yield* createWorkspaces(count, "echo test");
            const expected = nextUnusedAgentIds(used, count);

            expect(created.map((snapshot) => snapshot.agentId)).toStrictEqual(expected);
            return true;
          }).pipe(Effect.provide(harness.layer))
        )
      ),
    {
      fastCheck: {
        numRuns: 25
      }
    }
  );
});

/** Compute the next `agent-N` ids using the same low-gap allocation rule the workflow promises. */
function nextUnusedAgentIds(used: ReadonlyArray<number>, count: number): ReadonlyArray<string> {
  const seen = new Set(used);
  const ids: Array<string> = [];
  let candidate = 1;

  while (ids.length < count) {
    if (!seen.has(candidate)) {
      ids.push(`agent-${candidate}`);
    }
    candidate += 1;
  }

  return ids;
}
