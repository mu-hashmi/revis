/** Orchestration tests for the global reconcile loop and burst scheduling behavior. */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/TestClock";

import { makeGlobalReconcile, scheduleBurstReconciliations } from "../../src/daemon/reconcile-loop";
import type { WorkspaceSignal } from "../../src/daemon/reconcile-loop";
import { asAgentId, asRevision } from "../../src/domain/models";
import { HostGit } from "../../src/git/host-git";
import { EventJournal } from "../../src/services/event-journal";
import { WorkspaceStore } from "../../src/services/workspace-store";
import { makeDaemonState, makeRestartPendingSnapshot } from "../support/factories";
import { makeOrchestrationHarness } from "../support/orchestration-harness";

describe("reconcile loop", () => {
  it.scoped("persists daemon sync metadata and fans out the latest target to each supervisor", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          const eventJournal = yield* EventJournal;
          const hostGit = yield* HostGit;
          const store = yield* WorkspaceStore;
          const signals = new Map<string, Queue.Queue<WorkspaceSignal>>();

          // Seed two workspaces and move the fake remote target forward so the reconcile loop has
          // real state to fan out.
          yield* harness.controls.seedWorkspace(
            makeRestartPendingSnapshot(harness.paths.root, {
              agentId: asAgentId("agent-1")
            })
          );
          yield* harness.controls.seedWorkspace(
            makeRestartPendingSnapshot(harness.paths.root, {
              agentId: asAgentId("agent-2")
            })
          );
          yield* harness.controls.setDaemonState(makeDaemonState());
          yield* harness.controls.setRemoteRef(
            "revis-local",
            harness.syncBranch,
            asRevision("cccccccccccccccccccccccccccccccccccccccc")
          );

          const reconcile = makeGlobalReconcile({
            config: {
              coordinationRemote: "revis-local",
              trunkBase: "main"
            },
            eventJournal,
            ensureSupervisor: (agentId) =>
              Effect.gen(function* () {
                const queue = signals.get(agentId) ?? (yield* Queue.unbounded<WorkspaceSignal>());
                signals.set(agentId, queue);

                return {
                  queue,
                  fiber: yield* Effect.forkScoped(Effect.never)
                };
              }),
            hostGit,
            operatorSlug: "operator-1",
            paths: harness.paths,
            store,
            syncBranch: harness.syncBranch
          });

          // One reconcile should persist daemon metadata and signal every active supervisor with
          // the same latest target SHA.
          yield* reconcile("spawn");

          const daemonState = yield* store.daemonState;
          expect(Option.isSome(daemonState)).toBe(true);
          if (Option.isNone(daemonState)) {
            return yield* Effect.dieMessage("Expected reconcile to persist daemon state");
          }
          expect(daemonState.value.lastSyncTargetSha).toBe("cccccccccccccccccccccccccccccccccccccccc");
          expect(yield* Queue.take(signals.get("agent-1")!)).toStrictEqual({
            reason: "spawn",
            syncTargetSha: "cccccccccccccccccccccccccccccccccccccccc"
          });
          expect(yield* Queue.take(signals.get("agent-2")!)).toStrictEqual({
            reason: "spawn",
            syncTargetSha: "cccccccccccccccccccccccccccccccccccccccc"
          });
          expect((yield* eventJournal.loadEvents()).at(-1)?._tag).toBe("RemoteSynced");
        }).pipe(Effect.provide(harness.layer))
      )
    )
  );

  it.scoped("queues two delayed follow-up reconciliations after an interactive trigger", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<"startup" | "poll" | "spawn" | "promote" | "manual">();
      // The helper now forks into an explicit parent scope, so the test captures its own scope
      // before advancing the TestClock.
      const scope = yield* Effect.scope;

      // Interactive actions schedule two follow-up reconciles at one-second spacing so the daemon
      // quickly re-checks state after workspace mutations.
      yield* scheduleBurstReconciliations(queue, "spawn", scope);
      expect(Array.from(yield* Queue.takeUpTo(queue, 10))).toHaveLength(0);

      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(queue)).toBe("spawn");

      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(queue)).toBe("spawn");
    })
  );
});
