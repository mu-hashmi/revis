/** Fake `WorkspaceStore` service backed by the orchestration model state. */

import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { AgentId } from "../../../src/domain/models";
import type { WorkspaceStoreApi } from "../../../src/services/workspace-store";
import { currentSnapshots, type OrchestrationState } from "./model";

/** Build the workspace store service for one orchestration test harness. */
export function buildWorkspaceStoreService(
  state: OrchestrationState
): WorkspaceStoreApi {
  return {
    list: currentSnapshots(state),
    get: (agentId) =>
      Ref.get(state.snapshotsRef).pipe(
        Effect.map((snapshots) => snapshots.get(agentId as AgentId) ?? null)
      ),
    upsert: (snapshot) =>
      Effect.gen(function* () {
        // Publish the same change events as the real store so reconcile and route tests can
        // observe updates through the live stream, not just direct reads.
        yield* Ref.update(state.snapshotsRef, (current) => {
          const next = new Map(current);
          next.set(snapshot.agentId, snapshot);
          return next;
        });
        yield* PubSub.publish(state.storeChanges, {
          _tag: "WorkspaceUpserted",
          snapshot
        });
        return snapshot;
      }),
    remove: (agentId) =>
      Effect.gen(function* () {
        // Removing a workspace clears both persisted snapshot state and runtime state.
        yield* Ref.update(state.snapshotsRef, (current) => {
          const next = new Map(current);
          next.delete(agentId as AgentId);
          return next;
        });
        yield* Ref.update(state.workspaceRef, (current) => {
          const next = new Map(current);
          next.delete(agentId as AgentId);
          return next;
        });
        yield* PubSub.publish(state.storeChanges, {
          _tag: "WorkspaceRemoved",
          agentId
        });
      }),
    daemonState: Ref.get(state.daemonStateRef),
    setDaemonState: (daemonState) =>
      Effect.gen(function* () {
        yield* Ref.set(state.daemonStateRef, daemonState);
        yield* PubSub.publish(state.storeChanges, {
          _tag: "DaemonUpdated",
          state: daemonState
        });
        return daemonState;
      }),
    clearDaemonState: Effect.gen(function* () {
      yield* Ref.set(state.daemonStateRef, null);
      yield* PubSub.publish(state.storeChanges, {
        _tag: "DaemonUpdated",
        state: null
      });
    }),
    changes: Stream.fromPubSub(state.storeChanges)
  };
}
