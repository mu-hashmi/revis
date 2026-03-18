/** Workspace provisioning and teardown helpers. */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EventJournal } from "../services/event-journal";
import { WorkspaceProvider } from "../providers/contract";
import { HostGit } from "../git/host-git";
import { syncTargetBranch, usesManagedTrunk, workspaceBranch } from "../git/branch-names";
import { WorkspaceStore } from "../services/workspace-store";
import { ProjectConfig } from "../services/project-config";
import { ProjectPaths } from "../services/project-paths";
import {
  RestartPendingState,
  WorkspaceProvisioned,
  WorkspaceSnapshot,
  WorkspaceSpec,
  WorkspaceStopped,
  asAgentId
} from "../domain/models";
import { isoNow } from "../platform/time";

/** Create and register a batch of new workspaces. */
export function createWorkspaces(count: number, execCommand: string) {
  return Effect.gen(function* () {
    // Load project configuration and resolve the shared coordination target for this batch.
    const configService = yield* ProjectConfig;
    const config = yield* configService.load;
    const hostGit = yield* HostGit;
    const journal = yield* EventJournal;
    const provider = yield* WorkspaceProvider;
    const store = yield* WorkspaceStore;
    const paths = yield* ProjectPaths;
    const projectRoot = paths.root;

    const operatorSlug = yield* hostGit.deriveOperatorSlug(projectRoot);
    const syncBranch = syncTargetBranch(config.coordinationRemote, config.trunkBase);
    const remoteUrl = usesManagedTrunk(config.coordinationRemote)
      ? yield* hostGit.ensureCoordinationRemote(projectRoot)
      : yield* hostGit.remoteUrl(projectRoot, config.coordinationRemote);
    const existing = yield* store.list;

    /** Provision, persist, and announce one new workspace. */
    const createWorkspace = (agentId: ReturnType<typeof asAgentId>) =>
      Effect.gen(function* () {
        const coordinationBranch = workspaceBranch(operatorSlug, agentId);
        const provisioned = yield* provider.provision({
          root: projectRoot,
          remoteName: config.coordinationRemote,
          remoteUrl,
          syncBranch,
          operatorSlug,
          agentId,
          coordinationBranch,
          execCommand
        });
        const createdAt = isoNow();
        const snapshot = WorkspaceSnapshot.make({
          spec: WorkspaceSpec.make({
            agentId,
            operatorSlug,
            coordinationBranch,
            localBranch: provisioned.localBranch,
            workspaceRoot: provisioned.workspaceRoot,
            execCommand,
            sandboxProvider: config.sandboxProvider,
            createdAt,
            attachCmd: provisioned.attachCmd ? [...provisioned.attachCmd] : undefined,
            attachLabel: provisioned.attachLabel,
            sandboxId: provisioned.sandboxId
          }),
          state: RestartPendingState.make({
            iteration: 0,
            lastCommitSha: provisioned.head,
            lastRebasedOntoSha: provisioned.head
          })
        });

        yield* store.upsert(snapshot);
        yield* journal.append(
          WorkspaceProvisioned.make({
            timestamp: createdAt,
            agentId,
            branch: coordinationBranch,
            summary: `Provisioned ${agentId}`
          })
        );

        return snapshot;
      });

    // Allocate agent ids first, then provision each workspace in parallel.
    return yield* Effect.forEach(
      allocateAgentIds(existing, count),
      createWorkspace,
      { concurrency: "unbounded" }
    );
  });
}

/** Stop and remove one workspace. */
export function stopWorkspace(agentId: string) {
  return Effect.gen(function* () {
    const journal = yield* EventJournal;
    const provider = yield* WorkspaceProvider;
    const store = yield* WorkspaceStore;
    const snapshot = yield* store.get(agentId);
    if (Option.isNone(snapshot)) {
      return null;
    }

    const current = snapshot.value;

    // Remove the runtime first so the persisted store and the operator-facing event agree on
    // the workspace no longer existing.
    yield* provider.destroyWorkspace(current);
    yield* store.remove(current.agentId);
    yield* journal.append(
      WorkspaceStopped.make({
        timestamp: isoNow(),
        agentId: current.agentId,
        branch: current.spec.coordinationBranch,
        summary: `Stopped ${current.agentId}`
      })
    );

    return current;
  });
}

/** Stop and remove every currently registered workspace. */
export function stopAllWorkspaces() {
  return Effect.gen(function* () {
    const store = yield* WorkspaceStore;
    const snapshots = yield* store.list;

    return yield* Effect.forEach(
      snapshots,
      (snapshot) => stopWorkspace(snapshot.agentId),
      { concurrency: "unbounded" }
    );
  });
}

/** Allocate the next `count` workspace ids using the lowest unused `agent-N` values. */
function allocateAgentIds(
  snapshots: ReadonlyArray<WorkspaceSnapshot>,
  count: number
): ReadonlyArray<ReturnType<typeof asAgentId>> {
  const used = new Set(
    snapshots.map((snapshot) => Number.parseInt(snapshot.agentId.replace(/^agent-/, ""), 10))
  );
  const result: Array<ReturnType<typeof asAgentId>> = [];

  let candidate = 1;
  while (result.length < count) {
    // Fill gaps first so workspace numbering remains compact and predictable for operators.
    if (!used.has(candidate)) {
      result.push(asAgentId(`agent-${candidate}`));
    }
    candidate += 1;
  }

  return result;
}
