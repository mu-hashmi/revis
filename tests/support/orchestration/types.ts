/** Shared types for the in-memory orchestration harness. */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  AgentId,
  BranchName,
  DaemonState,
  RevisConfig,
  Revision,
  RuntimeEvent,
  WorkspaceSessionId,
  WorkspaceSnapshot
} from "../../../src/domain/models";
import { EventJournal } from "../../../src/services/event-journal";
import { HostGit } from "../../../src/git/host-git";
import { ProjectConfig } from "../../../src/services/project-config";
import { ProjectPaths, type ProjectPathsApi } from "../../../src/services/project-paths";
import { WorkspaceProvider } from "../../../src/providers/contract";
import { WorkspaceStore } from "../../../src/services/workspace-store";

export type RebasePlan =
  | { readonly _tag: "success"; readonly head?: Revision }
  | { readonly _tag: "conflict"; readonly detail: string };

/** One provider session record tracked inside the in-memory workspace model. */
export interface SessionRecord {
  readonly id: WorkspaceSessionId;
  readonly phase: "running" | "exited";
  readonly exitCode?: number;
}

/** Mutable runtime facts for one fake workspace checkout. */
export interface WorkspaceRuntimeState {
  readonly agentId: AgentId;
  readonly workspaceRoot: string;
  readonly coordinationBranch: BranchName;
  readonly currentBranch: BranchName;
  readonly head: Revision;
  readonly subject: string;
  readonly dirty: boolean;
  readonly destroyed: boolean;
  readonly sessions: ReadonlyArray<SessionRecord>;
  readonly activityLines: ReadonlyArray<string>;
  readonly rebasePlan: RebasePlan | null;
  readonly aheadCounts: ReadonlyMap<string, number>;
  readonly remoteTrackingRefs: ReadonlyMap<string, Revision>;
}

/** Optional overrides for one fresh harness instance. */
export interface HarnessOptions {
  readonly operatorSlug?: string;
  readonly remoteName?: string;
  readonly root?: string;
  readonly syncSha?: Revision;
}

/** Imperative controls used by orchestration and transport tests. */
export interface OrchestrationControls {
  readonly currentConfig: Effect.Effect<RevisConfig>;
  readonly currentEvents: Effect.Effect<ReadonlyArray<RuntimeEvent>>;
  readonly currentSnapshots: Effect.Effect<ReadonlyArray<WorkspaceSnapshot>>;
  readonly currentWorkspaceRuntime: (
    agentId: AgentId | string
  ) => Effect.Effect<WorkspaceRuntimeState | null>;
  readonly exitSession: (
    agentId: AgentId | string,
    exitCode?: number
  ) => Effect.Effect<void>;
  readonly latestSessionId: (agentId: AgentId | string) => Effect.Effect<string | null>;
  readonly seedWorkspace: (snapshot: WorkspaceSnapshot) => Effect.Effect<void>;
  readonly setActivityLines: (
    agentId: AgentId | string,
    lines: ReadonlyArray<string>
  ) => Effect.Effect<void>;
  readonly setAheadCount: (
    agentId: AgentId | string,
    baseRef: string,
    count: number
  ) => Effect.Effect<void>;
  readonly setDaemonState: (state: DaemonState | null) => Effect.Effect<void>;
  readonly setRemoteRef: (
    remoteName: string,
    branch: string,
    sha: Revision
  ) => Effect.Effect<void>;
  readonly setRebaseConflict: (
    agentId: AgentId | string,
    detail: string
  ) => Effect.Effect<void>;
  readonly setRebaseSuccess: (
    agentId: AgentId | string,
    head?: Revision
  ) => Effect.Effect<void>;
  readonly setWorkspaceDirty: (
    agentId: AgentId | string,
    dirty: boolean
  ) => Effect.Effect<void>;
  readonly setWorkspaceHead: (
    agentId: AgentId | string,
    sha: Revision,
    subject?: string
  ) => Effect.Effect<void>;
}

/** Fully composed test harness with both layers and direct mutation controls. */
export interface OrchestrationHarness {
  readonly controls: OrchestrationControls;
  readonly layer: Layer.Layer<
    EventJournal | HostGit | ProjectConfig | ProjectPaths | WorkspaceProvider | WorkspaceStore
  >;
  readonly paths: ProjectPathsApi;
  readonly syncBranch: BranchName;
}
