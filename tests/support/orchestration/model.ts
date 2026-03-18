/** Shared state model backing the in-memory orchestration harness. */

import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";

import { ProviderError } from "../../../src/domain/errors";
import {
  type AgentId,
  type BranchName,
  type DaemonState,
  type OperatorSlug,
  type RevisConfig,
  type Revision,
  type RuntimeEvent,
  type WorkspaceSnapshot,
  SessionMeta,
  asOperatorSlug,
  asRevision
} from "../../../src/domain/models";
import { remoteTrackingRef, syncTargetBranch } from "../../../src/git/branch-names";
import type { WorkspaceStoreChange } from "../../../src/services/workspace-store";
import { makeConfig, makeProjectPaths } from "../factories";
import type { HarnessOptions, WorkspaceRuntimeState } from "./types";

export interface OrchestrationState {
  readonly root: string;
  readonly paths: ReturnType<typeof makeProjectPaths>;
  readonly config: RevisConfig;
  readonly operatorSlug: OperatorSlug;
  readonly syncBranch: BranchName;
  readonly initialSyncSha: Revision;
  readonly configRef: Ref.Ref<RevisConfig>;
  readonly daemonStateRef: Ref.Ref<DaemonState | null>;
  readonly remoteUrlsRef: Ref.Ref<Map<string, string>>;
  readonly remoteRefsRef: Ref.Ref<Map<string, Map<string, Revision>>>;
  readonly hostFetchedRefsRef: Ref.Ref<Map<string, Revision>>;
  readonly workspaceRef: Ref.Ref<Map<AgentId, WorkspaceRuntimeState>>;
  readonly snapshotsRef: Ref.Ref<Map<AgentId, WorkspaceSnapshot>>;
  readonly storeChanges: PubSub.PubSub<WorkspaceStoreChange>;
  readonly liveEventsRef: Ref.Ref<ReadonlyArray<RuntimeEvent>>;
  readonly sessionsRef: Ref.Ref<Map<string, SessionMeta>>;
  readonly currentSessionRef: Ref.Ref<SessionMeta | null>;
  readonly sessionCounterRef: Ref.Ref<number>;
  readonly eventPubSub: PubSub.PubSub<RuntimeEvent>;
}

/** Build the one shared mutable state graph for a fresh orchestration test harness. */
export function createOrchestrationState(
  options: HarnessOptions = {}
): Effect.Effect<OrchestrationState, never, never> {
  return Effect.gen(function* () {
    // Derive one stable project shape first so every fake service sees the same paths/config.
    const root = options.root ?? "/test/revis";
    const paths = makeProjectPaths(root);
    const config = makeConfig({
      coordinationRemote: options.remoteName ?? "revis-local"
    });
    const operatorSlug = asOperatorSlug(options.operatorSlug ?? "operator-1");
    const syncBranch = syncTargetBranch(config.coordinationRemote, config.trunkBase);
    const initialSyncSha =
      options.syncSha ?? asRevision("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    // Keep remote refs and fetched refs separate so `fetchCoordinationRefs` materially changes
    // what later `resolveRefSha` calls can observe, just like the real host-side git service.
    return {
      root,
      paths,
      config,
      operatorSlug,
      syncBranch,
      initialSyncSha,
      configRef: yield* Ref.make(config),
      daemonStateRef: yield* Ref.make<DaemonState | null>(null),
      remoteUrlsRef: yield* Ref.make(
        new Map<string, string>([
          [config.coordinationRemote, `${root}/.revis/coordination.git`]
        ])
      ),
      remoteRefsRef: yield* Ref.make(
        new Map<string, Map<string, Revision>>([
          [config.coordinationRemote, new Map([[syncBranch, initialSyncSha]])]
        ])
      ),
      hostFetchedRefsRef: yield* Ref.make(
        new Map<string, Revision>([
          [remoteTrackingRef(config.coordinationRemote, syncBranch), initialSyncSha]
        ])
      ),
      workspaceRef: yield* Ref.make(new Map<AgentId, WorkspaceRuntimeState>()),
      snapshotsRef: yield* Ref.make(new Map<AgentId, WorkspaceSnapshot>()),
      storeChanges: yield* PubSub.unbounded<WorkspaceStoreChange>(),
      liveEventsRef: yield* Ref.make<ReadonlyArray<RuntimeEvent>>([]),
      sessionsRef: yield* Ref.make(new Map<string, SessionMeta>()),
      currentSessionRef: yield* Ref.make<SessionMeta | null>(null),
      sessionCounterRef: yield* Ref.make(0),
      eventPubSub: yield* PubSub.unbounded<RuntimeEvent>()
    };
  });
}

/** Read the current test config snapshot. */
export function currentConfig(state: OrchestrationState) {
  return Ref.get(state.configRef);
}

/** Read the current ordered event log. */
export function currentEvents(state: OrchestrationState) {
  return Ref.get(state.liveEventsRef);
}

/** Read the current ordered workspace snapshots. */
export function currentSnapshots(state: OrchestrationState) {
  return Ref.get(state.snapshotsRef).pipe(
    Effect.map((snapshots) => [...snapshots.values()].sort(compareSnapshots))
  );
}

/** Read one mutable workspace runtime record by agent id. */
export function currentWorkspaceRuntime(
  state: OrchestrationState,
  agentId: AgentId | string
) {
  return Ref.get(state.workspaceRef).pipe(
    Effect.map((workspaces) => workspaces.get(agentId as AgentId) ?? null)
  );
}

/** Update one remote branch ref in the fake remote store. */
export function setRemoteRef(
  state: OrchestrationState,
  remoteName: string,
  branch: string,
  sha: Revision
) {
  return Ref.update(state.remoteRefsRef, (current) => {
    const next = new Map(current);
    const refs = new Map(next.get(remoteName) ?? new Map<string, Revision>());

    refs.set(branch, sha);
    next.set(remoteName, refs);

    return next;
  });
}

/** Update one mutable workspace runtime record. */
export function setWorkspaceState(
  state: OrchestrationState,
  agentId: AgentId | string,
  update: (workspace: WorkspaceRuntimeState) => WorkspaceRuntimeState
) {
  return Ref.update(state.workspaceRef, (current) => {
    const workspace = current.get(agentId as AgentId);

    if (!workspace) {
      throw new Error(`Unknown workspace ${agentId}`);
    }

    const next = new Map(current);
    next.set(agentId as AgentId, update(workspace));

    return next;
  }).pipe(Effect.orDie);
}

/** Require one workspace runtime record and fail loudly when the test forgot to seed it. */
export function requireWorkspace(
  state: OrchestrationState,
  agentId: AgentId | string
) {
  return Ref.get(state.workspaceRef).pipe(
    Effect.flatMap((workspaces) => {
      const workspace = workspaces.get(agentId as AgentId);
      if (workspace) {
        return Effect.succeed(workspace);
      }

      return ProviderError.make({
        provider: "local",
        action: "workspace lookup",
        message: `Unknown workspace ${agentId}`
      });
    })
  );
}

/** Sort workspace snapshots in the same numeric agent order as the real store. */
export function compareSnapshots(left: WorkspaceSnapshot, right: WorkspaceSnapshot): number {
  return compareAgentIds(left.agentId, right.agentId);
}

/** Sort `agent-N` ids numerically rather than lexicographically. */
export function compareAgentIds(left: AgentId | string, right: AgentId | string): number {
  const leftValue = Number.parseInt(String(left).replace(/^agent-/, ""), 10);
  const rightValue = Number.parseInt(String(right).replace(/^agent-/, ""), 10);

  if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
    return leftValue - rightValue;
  }

  return String(left).localeCompare(String(right));
}
