/** Git helpers executed inside provider-owned workspace repositories. */

import * as Effect from "effect/Effect";

import {
  ProviderError,
  RebaseConflictError,
  ValidationError
} from "../domain/errors";
import { asRevision, type Revision, type WorkspaceSnapshot } from "../domain/models";
import type { CommandFailure } from "../platform/process";
import type { WorkspaceProviderApi } from "../providers/contract";

export type WorkspaceGitError =
  | CommandFailure
  | ProviderError
  | RebaseConflictError
  | ValidationError;

/** Return the current checked-out branch for one workspace. */
export function workspaceCurrentBranch(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot
) {
  return provider
    .runInWorkspace(snapshot, ["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      check: false
    })
    .pipe(
      Effect.flatMap((result) => {
        const branch = result.stdout.trim();
        if (result.exitCode === 0 && branch && branch !== "HEAD") {
          return Effect.succeed(branch);
        }

        return Effect.fail(
          ValidationError.make({
            message: result.stderr.trim() || result.stdout.trim() || "git branch probe failed"
          })
        );
      })
    );
}

/** Return the current HEAD SHA for one workspace. */
export function workspaceHeadSha(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot
) {
  return provider.runInWorkspace(snapshot, ["git", "rev-parse", "HEAD"], { check: false }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(asRevision(result.stdout.trim()))
        : Effect.fail(
            ValidationError.make({
              message: result.stderr.trim() || result.stdout.trim() || "git rev-parse failed"
            })
          )
    )
  );
}

/** Return the current HEAD subject line for one workspace. */
export function workspaceHeadSubject(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot
) {
  return provider
    .runInWorkspace(snapshot, ["git", "log", "-1", "--pretty=%s", "HEAD"], { check: false })
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout.trim())
          : Effect.fail(
              ValidationError.make({
                message: result.stderr.trim() || result.stdout.trim() || "git log failed"
              })
            )
      )
    );
}

/** Return whether the workspace working tree has uncommitted changes. */
export function workspaceWorkingTreeDirty(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot
) {
  return provider.runInWorkspace(snapshot, ["git", "status", "--porcelain"], { check: false }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim().length > 0)
        : Effect.fail(
            ValidationError.make({
              message: result.stderr.trim() || result.stdout.trim() || "git status failed"
            })
          )
    )
  );
}

/** Fetch the sync target and all workspace refs into one workspace checkout. */
export function fetchWorkspaceCoordinationRefs(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot,
  remoteName: string,
  syncBranch: string
): Effect.Effect<void, CommandFailure | ProviderError> {
  return provider
    .runInWorkspace(snapshot, [
      "git",
      "fetch",
      "--prune",
      remoteName,
      `+refs/heads/${syncBranch}:refs/remotes/${remoteName}/${syncBranch}`,
      `+refs/heads/*:refs/remotes/${remoteName}/*`
    ])
    .pipe(
      Effect.asVoid
    );
}

/** Push the workspace HEAD to its stable coordination branch. */
export function pushWorkspaceHead(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot,
  remoteName: string
): Effect.Effect<Revision, CommandFailure | ProviderError | ValidationError> {
  return provider
    .runInWorkspace(snapshot, [
      "git",
      "push",
      // Coordination refs are daemon-owned mirrors of the workspace HEAD, not shared human
      // branches, so a force push is the correct publication policy here.
      "--force",
      "-u",
      remoteName,
      `HEAD:refs/heads/${snapshot.spec.coordinationBranch}`
    ])
    .pipe(
      Effect.flatMap(() => workspaceHeadSha(provider, snapshot))
    );
}

/** Rebase a clean workspace onto the fetched sync target ref. */
export function rebaseWorkspaceOntoSyncTarget(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot,
  remoteName: string,
  syncBranch: string,
  targetSha: Revision
): Effect.Effect<Revision, CommandFailure | ProviderError | RebaseConflictError | ValidationError> {
  return Effect.gen(function* () {
    const result = yield* provider.runInWorkspace(
      snapshot,
      ["git", "rebase", `${remoteName}/${syncBranch}`],
      {
        check: false
      }
    );

    if (result.exitCode === 0) {
      return yield* workspaceHeadSha(provider, snapshot);
    }

    const detail = result.stderr.trim() || result.stdout.trim() || "rebase failed";
    const abort = yield* provider
      .runInWorkspace(snapshot, ["git", "rebase", "--abort"], { check: false })
      // Rebase cleanup is best-effort; preserve both failures if abort itself also breaks.
      .pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1 })));

    return yield* RebaseConflictError.make({
      agentId: snapshot.agentId,
      target: targetSha,
      detail:
        abort.exitCode === 0
          ? detail
          : `${detail}; ${abort.stderr.trim() || abort.stdout.trim() || "git rebase --abort failed"}`
    });
  });
}

/** Return how many commits HEAD is ahead of one remote-tracking ref. */
export function workspaceCommitCountSinceRef(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot,
  baseRef: string
): Effect.Effect<number, CommandFailure | ProviderError | ValidationError> {
  return provider
    .runInWorkspace(snapshot, ["git", "rev-list", "--count", `${baseRef}..HEAD`], {
      check: false
    })
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(Number.parseInt(result.stdout.trim(), 10))
          : Effect.fail(
              ValidationError.make({
                message: result.stderr.trim() || result.stdout.trim() || "git rev-list failed"
              })
            )
      )
    );
}
