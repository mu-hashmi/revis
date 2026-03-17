/** Per-workspace daemon supervision and restart/rebase state transitions. */

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import { formatDomainError } from "../domain/errors";
import {
  AwaitingRebaseState,
  BranchPublished,
  IterationExited,
  IterationStarted,
  ProviderFailedState,
  RebaseConflictState,
  RestartPendingState,
  RunningState,
  WorkspaceRebaseAwaiting,
  WorkspaceRebaseFailed,
  WorkspaceRebased,
  WorkspaceRestarted,
  type WorkspaceSnapshot
} from "../domain/models";
import {
  fetchWorkspaceCoordinationRefs,
  pushWorkspaceHead,
  rebaseWorkspaceOntoSyncTarget,
  workspaceHeadSha,
  workspaceWorkingTreeDirty
} from "../git/workspace-ops";
import { isoNow } from "../platform/time";
import type { WorkspaceProviderApi } from "../providers/contract";
import type { EventJournalApi } from "../services/event-journal";
import type { WorkspaceStoreApi } from "../services/workspace-store";
import { trackingFields, withState, withTracking } from "./state";
import type { WorkspaceSignal } from "./reconcile-loop";

export interface SupervisorHandle {
  readonly queue: Queue.Queue<WorkspaceSignal>;
  readonly fiber: Fiber.RuntimeFiber<void, unknown>;
}

interface WorkspaceSupervisorOptions {
  readonly config: {
    coordinationRemote: string;
  };
  readonly eventJournal: EventJournalApi;
  readonly provider: WorkspaceProviderApi;
  readonly store: WorkspaceStoreApi;
  readonly syncBranch: string;
}

export interface WorkspaceSupervisors {
  readonly ensureSupervisor: (
    agentId: string
  ) => Effect.Effect<SupervisorHandle, never, Scope.Scope>;
  readonly removeSupervisor: (agentId: string) => Effect.Effect<void, unknown>;
  readonly stopWorkspaces: (agentIds: ReadonlyArray<string>) => Effect.Effect<void, unknown>;
}

/** Create the registry that owns one supervisor fiber per active workspace. */
export function makeWorkspaceSupervisors(
  options: WorkspaceSupervisorOptions
): Effect.Effect<WorkspaceSupervisors> {
  return Effect.gen(function* () {
    const supervisorsRef = yield* Ref.make(new Map<string, SupervisorHandle>());

    const persistSnapshot = (snapshot: WorkspaceSnapshot) => options.store.upsert(snapshot);

    /** Persist a provider failure state so operators can see the last failed reconcile. */
    const markProviderFailure = (snapshot: WorkspaceSnapshot, error: unknown) =>
      persistSnapshot(
        withState(
          snapshot,
          ProviderFailedState.make({
            ...trackingFields(snapshot),
            detail: formatDomainError(error)
          })
        )
      );

    /** Reconcile one workspace against the latest sync target and provider session state. */
    const reconcileWorkspace = (
      initial: WorkspaceSnapshot,
      signal: WorkspaceSignal
    ): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        // Persist the latest observed remote target before any other transitions.
        let snapshot = withTracking(initial, {
          lastSeenRemoteSha: signal.syncTargetSha
        });

        yield* persistSnapshot(snapshot);

        // Inspect the current provider session and refresh cached workspace HEAD metadata.
        const inspected = yield* options.provider.inspectSession(snapshot);
        const headSha = yield* workspaceHeadSha(options.provider, snapshot);

        if (snapshot.state.lastCommitSha !== headSha) {
          snapshot = withTracking(snapshot, { lastCommitSha: headSha });
          yield* persistSnapshot(snapshot);
        }

        // Publish newly created local commits back to the stable coordination branch.
        if (snapshot.state.lastPushedSha !== headSha) {
          const pushedSha = yield* pushWorkspaceHead(
            options.provider,
            snapshot,
            options.config.coordinationRemote
          );

          snapshot = withTracking(snapshot, {
            lastCommitSha: headSha,
            lastPushedSha: pushedSha
          });
          yield* persistSnapshot(snapshot);
          yield* options.eventJournal.append(
            BranchPublished.make({
              timestamp: isoNow(),
              agentId: snapshot.agentId,
              branch: snapshot.spec.coordinationBranch,
              sha: pushedSha,
              summary: `Published ${snapshot.agentId}`
            })
          );
        }

        // Refresh remote refs and decide whether the workspace needs to rebase.
        yield* fetchWorkspaceCoordinationRefs(
          options.provider,
          snapshot,
          options.config.coordinationRemote,
          options.syncBranch
        );

        if (snapshot.state.lastRebasedOntoSha !== signal.syncTargetSha) {
          const dirty = yield* workspaceWorkingTreeDirty(options.provider, snapshot);

          if (dirty) {
            snapshot = withState(
              snapshot,
              AwaitingRebaseState.make({
                ...trackingFields(snapshot),
                requiredTarget: signal.syncTargetSha,
                detail: `Workspace must rebase onto ${signal.syncTargetSha.slice(0, 8)}`
              })
            );
            yield* persistSnapshot(snapshot);
            yield* options.eventJournal.append(
              WorkspaceRebaseAwaiting.make({
                timestamp: isoNow(),
                agentId: snapshot.agentId,
                branch: snapshot.spec.coordinationBranch,
                target: signal.syncTargetSha,
                summary: `${snapshot.agentId} is waiting for a clean rebase`
              })
            );
            return;
          }

          if (inspected.phase === "running") {
            // Rebase only from a stopped checkout so agent work and git history are never
            // mutated concurrently inside the same workspace.
            yield* options.provider.interruptIteration(snapshot);
            yield* persistSnapshot(
              withState(snapshot, RestartPendingState.make(trackingFields(snapshot)))
            );
            return;
          }

          const rebasedSha = yield* rebaseWorkspaceOntoSyncTarget(
            options.provider,
            snapshot,
            options.config.coordinationRemote,
            options.syncBranch,
            signal.syncTargetSha
          ).pipe(
            Effect.catchTag("RebaseConflictError", (error) =>
              persistSnapshot(
                withState(
                  snapshot,
                  RebaseConflictState.make({
                    ...trackingFields(snapshot),
                    requiredTarget: signal.syncTargetSha,
                    detail: error.detail
                  })
                )
              ).pipe(
                Effect.zipRight(
                  options.eventJournal.append(
                    WorkspaceRebaseFailed.make({
                      timestamp: isoNow(),
                      agentId: snapshot.agentId,
                      branch: snapshot.spec.coordinationBranch,
                      target: signal.syncTargetSha,
                      detail: error.detail,
                      summary: `${snapshot.agentId} hit a rebase conflict`
                    })
                  )
                ),
                Effect.zipRight(Effect.fail(error))
              )
            )
          );

          snapshot = withState(
            snapshot,
            RestartPendingState.make({
              ...trackingFields(snapshot),
              lastCommitSha: rebasedSha,
              lastRebasedOntoSha: signal.syncTargetSha
            })
          );
          yield* persistSnapshot(snapshot);
          yield* options.eventJournal.append(
            WorkspaceRebased.make({
              timestamp: isoNow(),
              agentId: snapshot.agentId,
              branch: snapshot.spec.coordinationBranch,
              target: signal.syncTargetSha,
              summary: `${snapshot.agentId} rebased onto ${signal.syncTargetSha.slice(0, 8)}`
            })
          );
        }

        // Restart the workspace whenever the current iteration has ended or a rebase completed.
        if (inspected.phase === "running") {
          return;
        }

        if (inspected.phase === "exited" && initial.state._tag === "Running") {
          snapshot = withState(
            snapshot,
            RestartPendingState.make({
              ...trackingFields(snapshot),
              lastExitCode: inspected.exitCode,
              lastExitedAt: isoNow()
            })
          );
          yield* persistSnapshot(snapshot);
          yield* options.eventJournal.append(
            IterationExited.make({
              timestamp: isoNow(),
              agentId: snapshot.agentId,
              branch: snapshot.spec.coordinationBranch,
              exitCode: inspected.exitCode,
              summary: `${snapshot.agentId} iteration exited`
            })
          );
        }

        const sessionId = yield* options.provider.startIteration(snapshot);
        const nextIteration = snapshot.state.iteration + 1;
        const startedAt = isoNow();
        const restarted = nextIteration > 1 || inspected.phase === "exited";

        snapshot = withState(
          snapshot,
          RunningState.make({
            ...trackingFields(snapshot),
            iteration: nextIteration,
            sessionId,
            startedAt
          })
        );
        yield* persistSnapshot(snapshot);

        if (restarted) {
          yield* options.eventJournal.append(
            WorkspaceRestarted.make({
              timestamp: startedAt,
              agentId: snapshot.agentId,
              branch: snapshot.spec.coordinationBranch,
              summary: `Restarted ${snapshot.agentId}`
            })
          );
        }

        yield* options.eventJournal.append(
          IterationStarted.make({
            timestamp: startedAt,
            agentId: snapshot.agentId,
            branch: snapshot.spec.coordinationBranch,
            summary: `Started iteration ${nextIteration} for ${snapshot.agentId}`
          })
        );
      });

    /** Consume queued reconcile signals for one workspace until the daemon stops. */
    const workspaceSupervisor = (
      agentId: string,
      queue: Queue.Queue<WorkspaceSignal>
    ): Effect.Effect<void, unknown> =>
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((signal) =>
            options.store.get(agentId).pipe(
              Effect.flatMap((snapshot) =>
                snapshot
                  ? reconcileWorkspace(snapshot, signal).pipe(
                      Effect.catchAll((error) =>
                        // Persist the failure for operator visibility, then keep the supervisor
                        // alive so later reconcile signals can recover the workspace.
                        options.store.get(agentId).pipe(
                          Effect.flatMap((current) =>
                            current
                              ? markProviderFailure(current, error)
                              : Effect.void
                          )
                        )
                      )
                    )
                  : Effect.void
              )
            )
          )
        )
      );

    const ensureSupervisor = (agentId: string) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(supervisorsRef);
        const existing = current.get(agentId);
        if (existing) {
          return existing;
        }

        // Only the latest remote target matters while a workspace is already reconciling, so
        // coalesce bursts of signals into a single pending update.
        const queue = yield* Queue.sliding<WorkspaceSignal>(1);
        const fiber = yield* Effect.forkScoped(workspaceSupervisor(agentId, queue));
        const handle: SupervisorHandle = { queue, fiber };

        yield* Ref.update(supervisorsRef, (current) => {
          const next = new Map(current);
          next.set(agentId, handle);
          return next;
        });

        return handle;
      });

    const removeSupervisor = (agentId: string) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(supervisorsRef);
        const handle = current.get(agentId);
        if (!handle) {
          return;
        }

        yield* Fiber.interrupt(handle.fiber);
        yield* Ref.update(supervisorsRef, (current) => {
          const next = new Map(current);
          next.delete(agentId);
          return next;
        });
      });

    const stopWorkspaces = (agentIds: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const snapshots = yield* options.store.list;
        const targets =
          agentIds.length === 0
            ? snapshots
            : snapshots.filter((snapshot) => agentIds.includes(snapshot.agentId));

        yield* Effect.forEach(
          targets,
          (snapshot) =>
            removeSupervisor(snapshot.agentId).pipe(
              Effect.zipRight(options.provider.destroyWorkspace(snapshot)),
              Effect.zipRight(options.store.remove(snapshot.agentId))
            ),
          { concurrency: "unbounded" }
        );

        yield* options.eventJournal.syncParticipants(yield* options.store.list);
      });

    return {
      ensureSupervisor,
      removeSupervisor,
      stopWorkspaces
    };
  });
}
