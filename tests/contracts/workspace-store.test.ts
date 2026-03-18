/** Behavioral contract tests for `WorkspaceStore` against the real filesystem layer. */

import * as NodeContext from "@effect/platform-node/NodeContext";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { asAgentId, asRevision } from "../../src/domain/models";
import { projectPathsLayer } from "../../src/services/project-paths";
import { WorkspaceStore, workspaceStoreLayer } from "../../src/services/workspace-store";
import {
  makeDaemonState,
  makeRestartPendingSnapshot
} from "../support/factories";
import { makeTempDirScoped } from "../support/helpers";

describe("WorkspaceStore", () => {
  it.scoped("round-trips workspace snapshots and daemon state", () =>
    withWorkspaceStore("revis-workspace-store-", (root) =>
      Effect.gen(function* () {
        const store = yield* WorkspaceStore;
        const snapshot = makeRestartPendingSnapshot(root);
        const daemonState = makeDaemonState({
          apiBaseUrl: "http://127.0.0.1:4310"
        });

        // Persist both workspace and daemon snapshots, then read them back through the same
        // contract to catch serialization drift.
        yield* store.upsert(snapshot);
        yield* store.setDaemonState(daemonState);

        expect(yield* store.get(snapshot.agentId)).toStrictEqual(snapshot);
        expect(yield* store.daemonState).toStrictEqual(daemonState);
      })
    )
  );

  it.scoped("lists workspaces in numeric agent order", () =>
    withWorkspaceStore("revis-workspace-store-order-", (root) =>
      Effect.gen(function* () {
        const store = yield* WorkspaceStore;

        // Store the snapshots out of order so the assertion exercises the service's sorting
        // contract instead of the insertion order of this test.
        yield* store.upsert(
          makeRestartPendingSnapshot(root, {
            agentId: asAgentId("agent-10")
          })
        );
        yield* store.upsert(
          makeRestartPendingSnapshot(root, {
            agentId: asAgentId("agent-2")
          })
        );
        yield* store.upsert(
          makeRestartPendingSnapshot(root, {
            agentId: asAgentId("agent-1")
          })
        );

        expect((yield* store.list).map((snapshot) => snapshot.agentId)).toStrictEqual([
          "agent-1",
          "agent-2",
          "agent-10"
        ]);
      })
    )
  );

  it.scoped("overwrites an existing snapshot and treats remove-missing as a no-op", () =>
    withWorkspaceStore("revis-workspace-store-mutate-", (root) =>
      Effect.gen(function* () {
        const store = yield* WorkspaceStore;
        const original = makeRestartPendingSnapshot(root);
        const updated = makeRestartPendingSnapshot(root, {
          iteration: 3,
          lastCommitSha: asRevision("3333333333333333333333333333333333333333")
        });

        // Upserting the same agent twice should replace the persisted snapshot, and deleting an
        // absent agent should stay silent.
        yield* store.upsert(original);
        yield* store.upsert(updated);
        yield* store.remove("agent-404");

        expect(yield* store.get(updated.agentId)).toStrictEqual(updated);
        expect(yield* store.list).toHaveLength(1);
      })
    )
  );

  it.scoped("emits one change event per mutation", () =>
    withWorkspaceStore("revis-workspace-store-stream-", (root) =>
      Effect.gen(function* () {
        const store = yield* WorkspaceStore;
        const snapshot = makeRestartPendingSnapshot(root);
        const daemonState = makeDaemonState();

        // Subscribe before mutating so the assertion covers the live change stream rather than
        // reconstructing expectations from final persisted state.
        const eventsFiber = yield* Effect.forkScoped(
          Stream.runCollect(store.changes.pipe(Stream.take(4)))
        );

        yield* store.upsert(snapshot);
        yield* store.setDaemonState(daemonState);
        yield* store.clearDaemonState;
        yield* store.remove(snapshot.agentId);

        const events = Array.from(yield* Fiber.join(eventsFiber));

        expect(events.map((event) => event._tag)).toStrictEqual([
          "WorkspaceUpserted",
          "DaemonUpdated",
          "DaemonUpdated",
          "WorkspaceRemoved"
        ]);
      })
    )
  );
});

/** Provide a fresh filesystem-backed workspace store inside one scoped temp directory. */
function withWorkspaceStore(
  prefix: string,
  run: (root: string) => Effect.Effect<void, unknown, WorkspaceStore | Scope.Scope>
) {
  return makeTempDirScoped(prefix).pipe(
    Effect.flatMap((root) => run(root).pipe(Effect.provide(makeWorkspaceStoreLayer(root))))
  );
}

/** Compose the real path and store layers used by the workspace-store contract tests. */
function makeWorkspaceStoreLayer(root: string) {
  const platformLayer = NodeContext.layer;
  const pathsLayer = projectPathsLayer(root).pipe(Layer.provide(platformLayer));
  const storeLayer = workspaceStoreLayer.pipe(
    Layer.provide(Layer.merge(platformLayer, pathsLayer))
  );

  return Layer.mergeAll(platformLayer, pathsLayer, storeLayer);
}
