/** Operator-facing status snapshots derived from Effect services. */

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { StatusSnapshot, StatusWorkspace } from "../domain/models";
import { ProjectConfig } from "../services/project-config";
import { ProjectPaths } from "../services/project-paths";
import { EventJournal } from "../services/event-journal";
import { WorkspaceProvider } from "../providers/contract";
import { HostGit } from "../git/host-git";
import { remoteTrackingRef, syncTargetBranch } from "../git/branch-names";
import { workspaceCommitCountSinceRef, workspaceHeadSubject } from "../git/workspace-ops";
import { WorkspaceStore } from "../services/workspace-store";

export interface LoadStatusOptions {
  readonly eventLimit?: number;
  readonly includeGitDetails?: boolean;
}

/** Build one fresh status snapshot for the current repository. */
export function loadStatusSnapshot(options: LoadStatusOptions = {}) {
  const { eventLimit = 12, includeGitDetails = true } = options;

  return Effect.gen(function* () {
    // Load the services and project context needed for one status render.
    const configService = yield* ProjectConfig;
    const eventJournal = yield* EventJournal;
    const hostGit = yield* HostGit;
    const paths = yield* ProjectPaths;
    const provider = yield* WorkspaceProvider;
    const store = yield* WorkspaceStore;
    const config = yield* configService.load;
    const operatorSlug = yield* hostGit.deriveOperatorSlug(paths.root);
    const syncBranch = syncTargetBranch(config.coordinationRemote, config.trunkBase);
    const snapshots = yield* store.list;

    // Enrich workspace snapshots with git details when the caller wants the full operator view.
    const workspaces = includeGitDetails
      ? yield* Effect.forEach(
          snapshots,
          (snapshot) =>
            Effect.gen(function* () {
              return StatusWorkspace.make({
                snapshot,
                aheadCount: yield* workspaceCommitCountSinceRef(
                  provider,
                  snapshot,
                  remoteTrackingRef(config.coordinationRemote, syncBranch)
                ),
                lastCommitSubject: yield* workspaceHeadSubject(provider, snapshot)
              });
            }),
          { concurrency: "unbounded" }
        )
      : snapshots.map((snapshot) =>
          StatusWorkspace.make({
            snapshot,
            aheadCount: 0,
            lastCommitSubject: ""
          })
        );

    // Assemble the final CLI/dashboard-facing snapshot from the composed services.
    return StatusSnapshot.make({
      root: paths.root,
      config,
      operatorSlug,
      syncBranch,
      daemon: Option.match(yield* store.daemonState, {
        onNone: () => null,
        onSome: (daemonState) => daemonState
      }),
      workspaces,
      events: yield* eventJournal.loadEvents(eventLimit)
    });
  });
}
