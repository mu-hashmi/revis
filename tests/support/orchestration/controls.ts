/** Imperative test controls for steering the orchestration harness. */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";

import { type AgentId, type DaemonState, type Revision, asRevision } from "../../../src/domain/models";
import { remoteTrackingRef } from "../../../src/git/branch-names";
import type { OrchestrationControls } from "./types";
import {
  currentConfig,
  currentEvents,
  currentSnapshots,
  currentWorkspaceRuntime,
  type OrchestrationState,
  setRemoteRef,
  setWorkspaceState
} from "./model";

/** Build the imperative control surface used by orchestration and transport tests. */
export function buildOrchestrationControls(
  state: OrchestrationState
): OrchestrationControls {
  const seedWorkspace = (snapshot: Parameters<OrchestrationControls["seedWorkspace"]>[0]) =>
    Effect.gen(function* () {
      // Seed both the mutable runtime model and the persisted snapshot view together so tests can
      // start from any lifecycle state without going through the provisioning workflow.
      yield* Ref.update(state.workspaceRef, (current) => {
        const next = new Map(current);

        next.set(snapshot.agentId, {
          agentId: snapshot.agentId,
          workspaceRoot: snapshot.spec.workspaceRoot,
          coordinationBranch: snapshot.spec.coordinationBranch,
          currentBranch: snapshot.spec.localBranch,
          head:
            snapshot.state.lastCommitSha ??
            asRevision("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
          subject: "seed",
          dirty: false,
          destroyed: false,
          sessions:
            snapshot.state._tag === "Running"
              ? [
                  {
                    id: snapshot.state.sessionId,
                    phase: "running"
                  }
                ]
              : [],
          activityLines: [],
          rebasePlan: null,
          aheadCounts: new Map(),
          remoteTrackingRefs: new Map([
            [
              remoteTrackingRef(state.config.coordinationRemote, state.syncBranch),
              state.initialSyncSha
            ]
          ])
        });

        return next;
      });

      yield* Ref.update(state.snapshotsRef, (current) => {
        const next = new Map(current);
        next.set(snapshot.agentId, snapshot);
        return next;
      });

      yield* PubSub.publish(state.storeChanges, {
        _tag: "WorkspaceUpserted",
        snapshot
      });
    });

  // Session and workspace mutation controls let tests steer the fake provider deterministically.
  const latestSessionId = (agentId: AgentId | string) =>
    currentWorkspaceRuntime(state, agentId).pipe(
      Effect.map((workspace) =>
        Option.match(workspace, {
          onNone: () => Option.none<string>(),
          onSome: (current) => Option.fromNullable(current.sessions.at(-1)?.id)
        })
      )
    );

  const exitSession = (agentId: AgentId | string, exitCode = 0) =>
    setWorkspaceState(state, agentId, (workspace) => ({
      ...workspace,
      sessions: workspace.sessions.map((session, index) =>
        index === workspace.sessions.length - 1
          ? {
              ...session,
              phase: "exited",
              exitCode
            }
          : session
      )
    })).pipe(Effect.orDie);

  const setWorkspaceHead = (
    agentId: AgentId | string,
    sha: Revision,
    subject = "updated"
  ) =>
    setWorkspaceState(state, agentId, (workspace) => ({
      ...workspace,
      head: sha,
      subject
    })).pipe(Effect.orDie);

  const setWorkspaceDirty = (agentId: AgentId | string, dirty: boolean) =>
    setWorkspaceState(state, agentId, (workspace) => ({
      ...workspace,
      dirty
    })).pipe(Effect.orDie);

  const setRebaseConflict = (agentId: AgentId | string, detail: string) =>
    setWorkspaceState(state, agentId, (workspace) => ({
      ...workspace,
      rebasePlan: {
        _tag: "conflict",
        detail
      }
    })).pipe(Effect.orDie);

  const setRebaseSuccess = (agentId: AgentId | string, head?: Revision) =>
    setWorkspaceState(state, agentId, (workspace) => ({
      ...workspace,
      rebasePlan: head
        ? {
            _tag: "success",
            head
          }
        : {
            _tag: "success"
          }
    })).pipe(Effect.orDie);

  const setActivityLines = (agentId: AgentId | string, lines: ReadonlyArray<string>) =>
    setWorkspaceState(state, agentId, (workspace) => ({
      ...workspace,
      activityLines: [...lines]
    })).pipe(Effect.orDie);

  const setAheadCount = (agentId: AgentId | string, baseRef: string, count: number) =>
    setWorkspaceState(state, agentId, (workspace) => ({
      ...workspace,
      aheadCounts: new Map(workspace.aheadCounts).set(baseRef, count)
    })).pipe(Effect.orDie);

  // Daemon and remote controls exist so global reconcile tests can move host-side state forward
  // independently of the workspace runtime model.
  const setDaemonState = (nextState: DaemonState | null) =>
    Effect.gen(function* () {
      yield* Ref.set(state.daemonStateRef, nextState);
      yield* PubSub.publish(state.storeChanges, {
        _tag: "DaemonUpdated",
        state: nextState
      });
    });

  return {
    currentConfig: currentConfig(state),
    currentEvents: currentEvents(state),
    currentSnapshots: currentSnapshots(state),
    currentWorkspaceRuntime: (agentId) => currentWorkspaceRuntime(state, agentId),
    exitSession,
    latestSessionId,
    seedWorkspace,
    setActivityLines,
    setAheadCount,
    setDaemonState,
    setRemoteRef: (remoteName, branch, sha) => setRemoteRef(state, remoteName, branch, sha),
    setRebaseConflict,
    setRebaseSuccess,
    setWorkspaceDirty,
    setWorkspaceHead
  };
}
