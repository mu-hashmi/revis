/** Git helpers executed inside provider-owned workspace repositories. */

import * as Effect from "effect/Effect";

import {
  RebaseConflictError,
  ValidationError,
  WorkspaceCommandError
} from "../domain/errors";
import { asRevision, type Revision, type WorkspaceSnapshot } from "../domain/models";
import type { CommandFailure, CompletedCommand } from "../platform/process";
import type { WorkspaceProviderApi } from "../providers/contract";

export type WorkspaceGitError =
  | CommandFailure
  | RebaseConflictError
  | ValidationError
  | WorkspaceCommandError;

/** Return the current checked-out branch for one workspace. */
export function workspaceCurrentBranch(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot
) {
  return runWorkspaceProbe(provider, snapshot, ["git", "rev-parse", "--abbrev-ref", "HEAD"]).pipe(
    Effect.flatMap((result) => {
      const branch = result.stdout.trim();
      if (branch && branch !== "HEAD") {
        return Effect.succeed(branch);
      }

      return ValidationError.make({
        message: result.stderr.trim() || result.stdout.trim() || "git branch probe failed"
      });
    })
  );
}

/** Return the current HEAD SHA for one workspace. */
export function workspaceHeadSha(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot
) {
  return runWorkspaceProbe(provider, snapshot, ["git", "rev-parse", "HEAD"]).pipe(
    Effect.map((result) => asRevision(result.stdout.trim()))
  );
}

/** Return the current HEAD subject line for one workspace. */
export function workspaceHeadSubject(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot
) {
  return runWorkspaceProbe(provider, snapshot, ["git", "log", "-1", "--pretty=%s", "HEAD"]).pipe(
    Effect.map((result) => result.stdout.trim())
  );
}

/** Return whether the workspace working tree has uncommitted changes. */
export function workspaceWorkingTreeDirty(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot
) {
  return runWorkspaceProbe(provider, snapshot, ["git", "status", "--porcelain"]).pipe(
    Effect.map((result) => result.stdout.trim().length > 0)
  );
}

/** Fetch the sync target and all workspace refs into one workspace checkout. */
export function fetchWorkspaceCoordinationRefs(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot,
  remoteName: string,
  syncBranch: string
): Effect.Effect<void, CommandFailure | WorkspaceCommandError> {
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
): Effect.Effect<Revision, CommandFailure | WorkspaceCommandError | ValidationError> {
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
): Effect.Effect<
  Revision,
  CommandFailure | RebaseConflictError | ValidationError | WorkspaceCommandError
> {
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
): Effect.Effect<number, CommandFailure | ValidationError | WorkspaceCommandError> {
  return runWorkspaceProbe(provider, snapshot, ["git", "rev-list", "--count", `${baseRef}..HEAD`]).pipe(
    Effect.map((result) => Number.parseInt(result.stdout.trim(), 10))
  );
}

/** Run one git probe inside the workspace and require a successful exit status. */
function runWorkspaceProbe(
  provider: WorkspaceProviderApi,
  snapshot: WorkspaceSnapshot,
  argv: ReadonlyArray<string>
): Effect.Effect<CompletedCommand, CommandFailure | ValidationError | WorkspaceCommandError> {
  return provider.runInWorkspace(snapshot, argv, { check: false }).pipe(
    Effect.flatMap((result) => requireSuccessfulProbe(result, probeFailureMessage(argv[1] ?? "git")))
  );
}

/** Turn a non-zero git probe result into a loud validation failure. */
function requireSuccessfulProbe(
  result: CompletedCommand,
  fallbackMessage: string
): Effect.Effect<CompletedCommand, ValidationError> {
  if (result.exitCode === 0) {
    return Effect.succeed(result);
  }

  return ValidationError.make({
    message: result.stderr.trim() || result.stdout.trim() || fallbackMessage
  });
}

/** Return the operator-facing fallback message for a workspace git probe. */
function probeFailureMessage(command: string): string {
  switch (command) {
    case "rev-parse":
      return "git rev-parse failed";
    case "log":
      return "git log failed";
    case "status":
      return "git status failed";
    case "rev-list":
      return "git rev-list failed";
    default:
      return "git command failed";
  }
}
