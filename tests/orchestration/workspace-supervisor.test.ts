/** Orchestration tests for per-workspace reconcile and restart state transitions. */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import { makeWorkspaceSupervisors } from "../../src/daemon/workspace-supervisor";
import {
  AwaitingRebaseState,
  RebaseConflictState,
  RunningState,
  asAgentId,
  asRevision,
  type WorkspaceSnapshot
} from "../../src/domain/models";
import { EventJournal } from "../../src/services/event-journal";
import { WorkspaceStore } from "../../src/services/workspace-store";
import { WorkspaceProvider } from "../../src/providers/contract";
import {
  makeRestartPendingSnapshot,
  makeRunningSnapshot
} from "../support/factories";
import { makeOrchestrationHarness } from "../support/orchestration-harness";
import { waitUntilEffect } from "../support/helpers";

describe("workspace supervisors", () => {
  it.scoped("restarts a workspace after its running session exits", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          const store = yield* WorkspaceStore;
          const provider = yield* WorkspaceProvider;
          const eventJournal = yield* EventJournal;
          const running = makeRunningSnapshot(harness.paths.root, {
            sessionId: "agent-1-session-1",
            iteration: 1
          });

          // Seed one running workspace, then mark its session exited so the supervisor has to
          // record the exit and start a new iteration.
          yield* harness.controls.seedWorkspace(running);
          yield* harness.controls.exitSession(running.agentId, 0);

          const supervisors = yield* makeWorkspaceSupervisors({
            config: {
              coordinationRemote: "revis-local"
            },
            eventJournal,
            provider,
            store,
            syncBranch: harness.syncBranch
          });
          const handle = yield* supervisors.ensureSupervisor(running.agentId);

          // Drive the supervisor with the same queue signal shape the global reconcile loop uses.
          yield* Queue.offer(handle.queue, {
            reason: "spawn",
            syncTargetSha: running.state.lastRebasedOntoSha!
          });

          const updated = yield* waitUntilEffect(
            store.get(running.agentId).pipe(
              Effect.map((snapshot) =>
                Option.match(snapshot, {
                  onNone: () => null,
                  onSome: (current) => current
                })
              )
            ),
            (snapshot) =>
              snapshot?.state._tag === "Running" && snapshot.state.iteration === 2
                ? snapshot
                : null,
            { timeoutMs: 2_000, intervalMs: 10 }
          );

          // Assert the behavioral contract: the workspace is running again and the event journal
          // recorded the exit/restart/start sequence.
          const tags = (yield* harness.controls.currentEvents).map((event) => event._tag);

          expect(updated.state._tag).toBe("Running");
          expect(updated.state.iteration).toBe(2);
          expect(tags).toEqual(
            expect.arrayContaining([
              "IterationExited",
              "WorkspaceRestarted",
              "IterationStarted"
            ])
          );
        }).pipe(Effect.provide(harness.layer))
      )
    )
  );

  it.scoped("moves a dirty workspace into AwaitingRebase instead of starting a new iteration", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          const store = yield* WorkspaceStore;
          const provider = yield* WorkspaceProvider;
          const eventJournal = yield* EventJournal;
          const snapshot = makeRestartPendingSnapshot(harness.paths.root);

          // Dirty worktrees must block the rebase path even when the sync target moved forward.
          yield* harness.controls.seedWorkspace(snapshot);
          yield* harness.controls.setWorkspaceDirty(snapshot.agentId, true);
          yield* harness.controls.setRemoteRef(
            "revis-local",
            harness.syncBranch,
            asRevision("dddddddddddddddddddddddddddddddddddddddd")
          );

          const supervisors = yield* makeWorkspaceSupervisors({
            config: {
              coordinationRemote: "revis-local"
            },
            eventJournal,
            provider,
            store,
            syncBranch: harness.syncBranch
          });
          const handle = yield* supervisors.ensureSupervisor(snapshot.agentId);

          yield* Queue.offer(handle.queue, {
            reason: "manual",
            syncTargetSha: asRevision("dddddddddddddddddddddddddddddddddddddddd")
          });

          const updated = yield* waitUntilEffect(
            store.get(snapshot.agentId).pipe(
              Effect.map((current) =>
                Option.match(current, {
                  onNone: () => null,
                  onSome: (value) => value
                })
              )
            ),
            awaitingRebaseSnapshot,
            { timeoutMs: 2_000, intervalMs: 10 }
          );

          expect(updated.state._tag).toBe("AwaitingRebase");
          expect(updated.state.requiredTarget).toBe(
            "dddddddddddddddddddddddddddddddddddddddd"
          );
        }).pipe(Effect.provide(harness.layer))
      )
    )
  );

  it.scoped("records a rebase conflict when the provider cannot rebase cleanly", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          const store = yield* WorkspaceStore;
          const provider = yield* WorkspaceProvider;
          const eventJournal = yield* EventJournal;
          const snapshot = makeRestartPendingSnapshot(harness.paths.root);

          // Configure the fake provider to fail the rebase with a conflict detail the supervisor
          // should preserve for operator visibility.
          yield* harness.controls.seedWorkspace(snapshot);
          yield* harness.controls.setRemoteRef(
            "revis-local",
            harness.syncBranch,
            asRevision("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
          );
          yield* harness.controls.setRebaseConflict(snapshot.agentId, "merge conflict");

          const supervisors = yield* makeWorkspaceSupervisors({
            config: {
              coordinationRemote: "revis-local"
            },
            eventJournal,
            provider,
            store,
            syncBranch: harness.syncBranch
          });
          const handle = yield* supervisors.ensureSupervisor(snapshot.agentId);

          yield* Queue.offer(handle.queue, {
            reason: "manual",
            syncTargetSha: asRevision("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
          });

          const updated = yield* waitUntilEffect(
            store.get(snapshot.agentId).pipe(
              Effect.map((current) =>
                Option.match(current, {
                  onNone: () => null,
                  onSome: (value) => value
                })
              )
            ),
            rebaseConflictSnapshot,
            { timeoutMs: 2_000, intervalMs: 10 }
          );

          expect(updated.state._tag).toBe("RebaseConflict");
          expect(updated.state.detail).toContain("merge conflict");
        }).pipe(Effect.provide(harness.layer))
      )
    )
  );

  it.scoped("rebases onto the new target and starts a fresh iteration when the workspace is clean", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          const store = yield* WorkspaceStore;
          const provider = yield* WorkspaceProvider;
          const eventJournal = yield* EventJournal;
          const snapshot = makeRestartPendingSnapshot(harness.paths.root);

          // A clean workspace with a successful rebase plan should move back into Running on the
          // next iteration and track both the new target and the rebased head.
          yield* harness.controls.seedWorkspace(snapshot);
          yield* harness.controls.setRemoteRef(
            "revis-local",
            harness.syncBranch,
            asRevision("ffffffffffffffffffffffffffffffffffffffff")
          );
          yield* harness.controls.setRebaseSuccess(
            snapshot.agentId,
            asRevision("9999999999999999999999999999999999999999")
          );

          const supervisors = yield* makeWorkspaceSupervisors({
            config: {
              coordinationRemote: "revis-local"
            },
            eventJournal,
            provider,
            store,
            syncBranch: harness.syncBranch
          });
          const handle = yield* supervisors.ensureSupervisor(snapshot.agentId);

          yield* Queue.offer(handle.queue, {
            reason: "manual",
            syncTargetSha: asRevision("ffffffffffffffffffffffffffffffffffffffff")
          });

          const updated = yield* waitUntilEffect(
            store.get(snapshot.agentId).pipe(
              Effect.map((current) =>
                Option.match(current, {
                  onNone: () => null,
                  onSome: (value) => value
                })
              )
            ),
            (current) => {
              const running = runningSnapshot(current);
              return running?.state.lastRebasedOntoSha ===
                asRevision("ffffffffffffffffffffffffffffffffffffffff")
                ? running
                : null;
            },
            { timeoutMs: 2_000, intervalMs: 10 }
          );

          expect(updated.state._tag).toBe("Running");
          expect(updated.state.iteration).toBe(1);
          expect(updated.state.lastCommitSha).toBe(
            "9999999999999999999999999999999999999999"
          );
        }).pipe(Effect.provide(harness.layer))
      )
    )
  );

  it.scoped("reconciles workspaces independently so one failure does not block another", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          const store = yield* WorkspaceStore;
          const provider = yield* WorkspaceProvider;
          const eventJournal = yield* EventJournal;
          const first = makeRestartPendingSnapshot(harness.paths.root, {
            agentId: asAgentId("agent-1")
          });
          const second = makeRestartPendingSnapshot(harness.paths.root, {
            agentId: asAgentId("agent-2")
          });

          // Give the two workspaces divergent rebase outcomes so the test proves each supervisor
          // runs independently.
          yield* harness.controls.seedWorkspace(first);
          yield* harness.controls.seedWorkspace(second);
          yield* harness.controls.setRemoteRef(
            "revis-local",
            harness.syncBranch,
            asRevision("abababababababababababababababababababab")
          );
          yield* harness.controls.setRebaseConflict(first.agentId, "conflict");
          yield* harness.controls.setRebaseSuccess(
            second.agentId,
            asRevision("1212121212121212121212121212121212121212")
          );

          const supervisors = yield* makeWorkspaceSupervisors({
            config: {
              coordinationRemote: "revis-local"
            },
            eventJournal,
            provider,
            store,
            syncBranch: harness.syncBranch
          });
          const firstHandle = yield* supervisors.ensureSupervisor(first.agentId);
          const secondHandle = yield* supervisors.ensureSupervisor(second.agentId);

          yield* Queue.offer(firstHandle.queue, {
            reason: "manual",
            syncTargetSha: asRevision("abababababababababababababababababababab")
          });
          yield* Queue.offer(secondHandle.queue, {
            reason: "manual",
            syncTargetSha: asRevision("abababababababababababababababababababab")
          });

          const failed = yield* waitUntilEffect(
            store.get(first.agentId).pipe(
              Effect.map((current) =>
                Option.match(current, {
                  onNone: () => null,
                  onSome: (value) => value
                })
              )
            ),
            rebaseConflictSnapshot,
            { timeoutMs: 2_000, intervalMs: 10 }
          );
          const succeeded = yield* waitUntilEffect(
            store.get(second.agentId).pipe(
              Effect.map((current) =>
                Option.match(current, {
                  onNone: () => null,
                  onSome: (value) => value
                })
              )
            ),
            runningSnapshot,
            { timeoutMs: 2_000, intervalMs: 10 }
          );

          expect(failed.state._tag).toBe("RebaseConflict");
          expect(succeeded.state._tag).toBe("Running");
        }).pipe(Effect.provide(harness.layer))
      )
    )
  );
});

/** Narrow one nullable snapshot to the running state used in assertions. */
function runningSnapshot(snapshot: WorkspaceSnapshot | null) {
  return snapshot?.state._tag === "Running"
    ? (snapshot as WorkspaceSnapshot & { readonly state: RunningState })
    : null;
}

/** Narrow one nullable snapshot to the awaiting-rebase state used in assertions. */
function awaitingRebaseSnapshot(snapshot: WorkspaceSnapshot | null) {
  return snapshot?.state._tag === "AwaitingRebase"
    ? (snapshot as WorkspaceSnapshot & { readonly state: AwaitingRebaseState })
    : null;
}

/** Narrow one nullable snapshot to the rebase-conflict state used in assertions. */
function rebaseConflictSnapshot(snapshot: WorkspaceSnapshot | null) {
  return snapshot?.state._tag === "RebaseConflict"
    ? (snapshot as WorkspaceSnapshot & { readonly state: RebaseConflictState })
    : null;
}
