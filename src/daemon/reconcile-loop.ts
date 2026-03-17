/** Global reconcile scheduling and fan-out helpers for the daemon. */

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";

import { DaemonState, RemoteSynced, type Revision } from "../domain/models";
import { formatDomainError } from "../domain/errors";
import { remoteTrackingRef } from "../git/branch-names";
import type { HostGitApi } from "../git/host-git";
import { isoNow } from "../platform/time";
import type { EventJournalApi } from "../services/event-journal";
import type { ProjectPathsApi } from "../services/project-paths";
import type { WorkspaceStoreApi } from "../services/workspace-store";
import type { SupervisorHandle } from "./workspace-supervisor";
import { errorTag } from "./state";

export type ReconcileReason = "startup" | "poll" | "spawn" | "promote" | "manual";

export interface WorkspaceSignal {
  readonly reason: ReconcileReason;
  readonly syncTargetSha: Revision;
}

interface GlobalReconcileOptions {
  readonly config: {
    coordinationRemote: string;
    trunkBase: string;
  };
  readonly eventJournal: EventJournalApi;
  readonly ensureSupervisor: (
    agentId: string
  ) => Effect.Effect<SupervisorHandle, never, Scope.Scope>;
  readonly hostGit: HostGitApi;
  readonly operatorSlug: string;
  readonly paths: ProjectPathsApi;
  readonly store: WorkspaceStoreApi;
  readonly syncBranch: string;
}

/** Build the global reconcile effect shared by startup, polling, and interactive triggers. */
export function makeGlobalReconcile(options: GlobalReconcileOptions) {
  return (reason: ReconcileReason) =>
    Effect.gen(function* () {
      // Ensure the current daemon lifetime is represented by one active session archive.
      yield* options.eventJournal.ensureActiveSession({
        coordinationRemote: options.config.coordinationRemote,
        trunkBase: options.config.trunkBase,
        operatorSlug: options.operatorSlug
      });

      // Refresh host-side refs before computing the new sync target.
      yield* options.hostGit.fetchCoordinationRefs(
        options.paths.root,
        options.config.coordinationRemote,
        options.syncBranch
      );

      const syncTargetSha = yield* options.hostGit.resolveRefSha(
        options.paths.root,
        remoteTrackingRef(options.config.coordinationRemote, options.syncBranch)
      );

      // Persist the latest remote state so CLI and dashboard consumers can render it immediately.
      const currentDaemon = yield* options.store.daemonState;
      if (currentDaemon) {
        yield* options.store.setDaemonState(
          DaemonState.make({
            ...currentDaemon,
            lastFetchAt: isoNow(),
            lastSyncTargetSha: syncTargetSha,
            lastEventAt: isoNow(),
            lastErrorMessage: undefined,
            lastErrorTag: undefined
          })
        );
      }

      // Record the sync event, then fan the new target out to every workspace supervisor.
      yield* options.eventJournal.append(
        RemoteSynced.make({
          timestamp: isoNow(),
          reason,
          summary: `Synced ${options.syncBranch} (${reason})`
        })
      );

      const snapshots = yield* options.store.list;

      for (const snapshot of snapshots) {
        const handle = yield* options.ensureSupervisor(snapshot.agentId);
        yield* Queue.offer(handle.queue, { reason, syncTargetSha });
      }

      yield* options.eventJournal.syncParticipants(snapshots);
    }).pipe(
      Effect.catchAll((error) =>
        // Persist the latest daemon error for operators, but keep the reconcile loop alive.
        options.store.daemonState.pipe(
          Effect.flatMap((current) =>
            current
              ? options.store.setDaemonState(
                  DaemonState.make({
                    ...current,
                    lastErrorTag: errorTag(error),
                    lastErrorMessage: formatDomainError(error)
                  })
                ).pipe(Effect.asVoid)
              : Effect.void
          )
        )
      )
    );
}

/** Schedule two short follow-up reconciliations after interactive mutations. */
export function scheduleBurstReconciliations(
  queue: Queue.Queue<ReconcileReason>,
  reason: Exclude<ReconcileReason, "startup" | "poll">
): Effect.Effect<void> {
  return Effect.fork(
    Effect.gen(function* () {
      // Interactive mutations can land follow-up refs shortly after the first push, so schedule
      // two delayed reconciles to catch that second wave without tightening the steady-state poll.
      yield* Effect.sleep("1 second");
      yield* Queue.offer(queue, reason);
      yield* Effect.sleep("1 second");
      yield* Queue.offer(queue, reason);
    }).pipe(Effect.asVoid)
  ).pipe(Effect.asVoid);
}
