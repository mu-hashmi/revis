/** Persisted workspace and daemon state store with in-process change streams. */

import { FileSystem } from "@effect/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProjectPaths, type ProjectPathsApi } from "./project-paths";
import {
  ensureDirectory,
  readJsonFileIfExists,
  removeFile,
  writeJsonFile
} from "../platform/storage";
import { StorageError } from "../domain/errors";
import {
  AgentId,
  DaemonState,
  WorkspaceSnapshot
} from "../domain/models";

export type WorkspaceStoreChange =
  | { readonly _tag: "WorkspaceUpserted"; readonly snapshot: WorkspaceSnapshot }
  | { readonly _tag: "WorkspaceRemoved"; readonly agentId: AgentId | string }
  | { readonly _tag: "DaemonUpdated"; readonly state: DaemonState | null };

export interface WorkspaceStoreApi {
  readonly list: Effect.Effect<ReadonlyArray<WorkspaceSnapshot>, StorageError>;
  readonly get: (
    agentId: AgentId | string
  ) => Effect.Effect<Option.Option<WorkspaceSnapshot>, StorageError>;
  readonly upsert: (
    snapshot: WorkspaceSnapshot
  ) => Effect.Effect<WorkspaceSnapshot, StorageError>;
  readonly remove: (agentId: AgentId | string) => Effect.Effect<void, StorageError>;
  readonly daemonState: Effect.Effect<Option.Option<DaemonState>, StorageError>;
  readonly setDaemonState: (state: DaemonState) => Effect.Effect<DaemonState, StorageError>;
  readonly clearDaemonState: Effect.Effect<void, StorageError>;
  readonly changes: Stream.Stream<WorkspaceStoreChange>;
}

/** Persisted source of truth for daemon state and workspace snapshots. */
export class WorkspaceStore extends Context.Tag("@revis/WorkspaceStore")<
  WorkspaceStore,
  WorkspaceStoreApi
>() {}

export const workspaceStoreLayer = Layer.scoped(
  WorkspaceStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* ProjectPaths;

    // Prepare the on-disk state directories.
    yield* ensureDirectory(fs, paths.stateDir);
    yield* ensureDirectory(fs, paths.workspaceStateDir);

    // Recover persisted daemon and workspace state into in-memory refs.
    const snapshots = yield* loadWorkspaceSnapshots(fs, paths);
    const daemonState = yield* readJsonFileIfExists(fs, paths.daemonStateFile, DaemonState);
    const snapshotsRef = yield* Ref.make(
      new Map(snapshots.map((snapshot) => [snapshot.agentId, snapshot]))
    );
    const daemonRef = yield* Ref.make(daemonState);
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<WorkspaceStoreChange>(),
      (changes) => PubSub.shutdown(changes)
    );

    // Expose CRUD operations plus a lightweight change stream for in-process consumers.
    const list = Ref.get(snapshotsRef).pipe(
      Effect.map((current) =>
        [...current.values()].sort((left, right) =>
          compareAgentIds(left.agentId, right.agentId)
        )
      )
    );

    const get = (agentId: AgentId | string) =>
      Ref.get(snapshotsRef).pipe(
        Effect.map((current) => Option.fromNullable(current.get(agentId as AgentId)))
      );

    const upsert = (snapshot: WorkspaceSnapshot) =>
      Effect.gen(function* () {
        yield* writeJsonFile(fs, paths.workspaceStateFile(snapshot.agentId), WorkspaceSnapshot, snapshot);
        yield* Ref.update(snapshotsRef, (current) => {
          const next = new Map(current);
          next.set(snapshot.agentId, snapshot);
          return next;
        });
        yield* PubSub.publish(pubsub, { _tag: "WorkspaceUpserted", snapshot });
        return snapshot;
      });

    const remove = (agentId: AgentId | string) =>
      Effect.gen(function* () {
        yield* removeFile(fs, paths.workspaceStateFile(agentId));
        yield* Ref.update(snapshotsRef, (current) => {
          const next = new Map(current);
          next.delete(agentId as AgentId);
          return next;
        });
        yield* PubSub.publish(pubsub, { _tag: "WorkspaceRemoved", agentId });
      });

    const setDaemonState = (state: DaemonState) =>
      Effect.gen(function* () {
        yield* writeJsonFile(fs, paths.daemonStateFile, DaemonState, state);
        yield* Ref.set(daemonRef, Option.some(state));
        yield* PubSub.publish(pubsub, { _tag: "DaemonUpdated", state });
        return state;
      });

    const clearDaemonState = Effect.gen(function* () {
      yield* removeFile(fs, paths.daemonStateFile);
      // Model daemon absence with `Option.none()` end-to-end instead of reintroducing `null` into
      // the service state itself.
      yield* Ref.set(daemonRef, Option.none());
      yield* PubSub.publish(pubsub, { _tag: "DaemonUpdated", state: null });
    });

    return WorkspaceStore.of({
      list,
      get,
      upsert,
      remove,
      daemonState: Ref.get(daemonRef),
      setDaemonState,
      clearDaemonState,
      changes: Stream.fromPubSub(pubsub)
    });
  })
);

/** Load every persisted workspace snapshot from the state directory. */
function loadWorkspaceSnapshots(
  fs: FileSystem.FileSystem,
  paths: ProjectPathsApi
): Effect.Effect<ReadonlyArray<WorkspaceSnapshot>, StorageError> {
  return fs.readDirectory(paths.workspaceStateDir).pipe(
    Effect.catchTag("SystemError", (error) =>
      error.reason === "NotFound" ? Effect.succeed([]) : Effect.fail(error)
    ),
    Effect.mapError((error) =>
      StorageError.make({
        path: paths.workspaceStateDir,
        message: error.message
      })
    ),
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries.filter((entry) => entry.endsWith(".json")).sort(),
        (entry) =>
          readJsonFileIfExists(
            fs,
            `${paths.workspaceStateDir}/${entry}`,
            WorkspaceSnapshot
          ),
        { concurrency: "unbounded" }
      )
    ),
    Effect.map((entries) => entries.filter(Option.isSome).map((entry) => entry.value))
  );
}

/** Sort `agent-N` ids numerically so operator-facing views stay in stable human order. */
function compareAgentIds(left: AgentId | string, right: AgentId | string): number {
  const leftValue = Number.parseInt(String(left).replace(/^agent-/, ""), 10);
  const rightValue = Number.parseInt(String(right).replace(/^agent-/, ""), 10);

  if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
    return leftValue - rightValue;
  }

  return String(left).localeCompare(String(right));
}
