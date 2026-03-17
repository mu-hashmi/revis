import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/TestClock";

import { scheduleBurstReconciliations } from "../src/daemon/reconcile-loop";
import { eventJournalLayer, EventJournal } from "../src/services/event-journal";
import { workspaceStoreLayer, WorkspaceStore } from "../src/services/workspace-store";
import {
  DaemonState,
  DaemonStarted,
  RestartPendingState,
  WorkspaceProvisioned,
  WorkspaceSnapshot,
  WorkspaceSpec,
  asAgentId,
  asBranchName,
  asOperatorSlug,
  asRevision
} from "../src/domain/models";
import { projectPathsLayer } from "../src/services/project-paths";
import { isoNow } from "../src/platform/time";

class TestFileError extends Schema.TaggedError<TestFileError>()("TestFileError", {
  message: Schema.String
}) {}

it.effect("workspace store persists snapshots and daemon state", () =>
  withTempRoot((root) => {
    const pathsLayer = projectPathsLayer(root);
    const storeLayer = workspaceStoreLayer.pipe(
      Layer.provide(pathsLayer),
      Layer.provideMerge(NodeFileSystem.layer),
      Layer.provideMerge(NodePath.layer)
    );

    return Effect.gen(function* () {
      const store = yield* WorkspaceStore;
      const snapshot = makeSnapshot(root, "agent-1");

      yield* store.upsert(snapshot);
      yield* store.setDaemonState(
        DaemonState.make({
          sandboxProvider: "local",
          syncTargetBranch: asBranchName("main"),
          startedAt: isoNow(),
          pid: process.pid,
          socketPath: "/tmp/revis.sock",
          apiBaseUrl: "http://127.0.0.1:4000"
        })
      );

      const loaded = yield* store.get(snapshot.agentId);
      const daemon = yield* store.daemonState;

      expect(loaded?.spec.workspaceRoot).toBe(snapshot.spec.workspaceRoot);
      expect(daemon?.apiBaseUrl).toBe("http://127.0.0.1:4000");
    }).pipe(Effect.provide(storeLayer));
  })
);

it.effect("event journal persists live events and session archives", () =>
  withTempRoot((root) => {
    const pathsLayer = projectPathsLayer(root);
    const journalLayer = eventJournalLayer.pipe(
      Layer.provide(pathsLayer),
      Layer.provideMerge(NodeFileSystem.layer),
      Layer.provideMerge(NodePath.layer)
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const journal = yield* EventJournal;
        const streamFiber = yield* Effect.forkScoped(
          Stream.runCollect(journal.stream.pipe(Stream.take(1)))
        );

        const session = yield* journal.ensureActiveSession({
          coordinationRemote: "origin",
          trunkBase: "main",
          operatorSlug: "operator-1"
        });
        const event = DaemonStarted.make({
          timestamp: isoNow(),
          summary: "Daemon started"
        });

        yield* journal.append(event);

        const liveEvents = yield* journal.loadEvents();
        const sessionEvents = yield* journal.loadSessionEvents(session.id);
        const streamed = Array.from(yield* Fiber.join(streamFiber));

        expect(liveEvents).toHaveLength(1);
        expect(sessionEvents).toHaveLength(1);
        expect(streamed[0]?._tag).toBe("DaemonStarted");
      }).pipe(Effect.provide(journalLayer))
    );
  })
);

it.effect("burst reconcile scheduling starts after one second and repeats once", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<"startup" | "poll" | "spawn" | "promote" | "manual">();

    yield* scheduleBurstReconciliations(queue, "spawn");
    expect(Array.from(yield* Queue.takeUpTo(queue, 10))).toHaveLength(0);

    yield* TestClock.adjust("1 second");
    expect(yield* Queue.take(queue)).toBe("spawn");

    yield* TestClock.adjust("1 second");
    expect(yield* Queue.take(queue)).toBe("spawn");
  })
);

function makeSnapshot(root: string, agentIdValue: string): WorkspaceSnapshot {
  const agentId = asAgentId(agentIdValue);
  const branch = asBranchName(`revis/operator-1/${agentId}/work`);

  return WorkspaceSnapshot.make({
    spec: WorkspaceSpec.make({
      agentId,
      operatorSlug: asOperatorSlug("operator-1"),
      coordinationBranch: branch,
      localBranch: branch,
      workspaceRoot: join(root, ".revis", "workspaces", agentId, "repo"),
      execCommand: "echo test",
      sandboxProvider: "local",
      createdAt: isoNow()
    }),
    state: RestartPendingState.make({
      iteration: 0,
      lastCommitSha: asRevision("0123456789abcdef")
    })
  });
}

function withTempRoot<A, E, R>(run: (root: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "revis-effect-test-")),
      catch: (error) => TestFileError.make({ message: String(error) })
    }),
    run,
    (root) =>
      Effect.tryPromise({
        try: () => rm(root, { recursive: true, force: true }),
        catch: () => TestFileError.make({ message: "cleanup failed" })
      }).pipe(Effect.ignore)
  );
}
