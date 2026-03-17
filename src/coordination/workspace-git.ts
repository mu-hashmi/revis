/** Provider-executed git helpers for workspace repositories. */

import { RevisError } from "../core/error";
import type { WorkspaceRecord } from "../core/models";
import type { WorkspaceProvider } from "./provider";

/** Return the current checked-out branch for one workspace. */
export async function workspaceCurrentBranch(
  provider: WorkspaceProvider,
  record: WorkspaceRecord
): Promise<string> {
  const result = await provider.runCommand(
    record,
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    { check: false }
  );
  const branch = result.stdout.trim();
  if (result.exitCode !== 0 || !branch || branch === "HEAD") {
    throw new RevisError(result.stderr.trim() || result.stdout.trim() || "git branch probe failed");
  }

  return branch;
}

/** Return the current HEAD SHA for one workspace. */
export async function workspaceHeadSha(
  provider: WorkspaceProvider,
  record: WorkspaceRecord
): Promise<string> {
  const result = await provider.runCommand(record, ["git", "rev-parse", "HEAD"], {
    check: false
  });
  if (result.exitCode !== 0) {
    throw new RevisError(result.stderr.trim() || result.stdout.trim() || "git rev-parse failed");
  }

  return result.stdout.trim();
}

/** Return the current HEAD subject line for one workspace. */
export async function workspaceHeadSubject(
  provider: WorkspaceProvider,
  record: WorkspaceRecord
): Promise<string> {
  const result = await provider.runCommand(
    record,
    ["git", "log", "-1", "--pretty=%s", "HEAD"],
    { check: false }
  );
  if (result.exitCode !== 0) {
    throw new RevisError(result.stderr.trim() || result.stdout.trim() || "git log failed");
  }

  return result.stdout.trim();
}

/** Return whether the workspace working tree has uncommitted changes. */
export async function workspaceWorkingTreeDirty(
  provider: WorkspaceProvider,
  record: WorkspaceRecord
): Promise<boolean> {
  const result = await provider.runCommand(record, ["git", "status", "--porcelain"], {
    check: false
  });
  if (result.exitCode !== 0) {
    throw new RevisError(result.stderr.trim() || result.stdout.trim() || "git status failed");
  }

  return result.stdout.trim().length > 0;
}

/** Fetch the sync target and all remote Revis refs into one workspace. */
export async function fetchWorkspaceCoordinationRefs(
  provider: WorkspaceProvider,
  record: WorkspaceRecord,
  remoteName: string,
  syncBranch: string
): Promise<void> {
  await provider.runCommand(record, [
    "git",
    "fetch",
    "--prune",
    remoteName,
    `+refs/heads/${syncBranch}:refs/remotes/${remoteName}/${syncBranch}`,
    `+refs/heads/*:refs/remotes/${remoteName}/*`
  ]);
}

/** Push the workspace HEAD to its stable coordination ref. */
export async function pushWorkspaceHead(
  provider: WorkspaceProvider,
  record: WorkspaceRecord,
  remoteName: string
): Promise<string> {
  // Each workspace owns its stable coordination ref. When an agent id is reused,
  // a fresh clone must replace any stale remote history for that ref.
  await provider.runCommand(record, [
    "git",
    "push",
    "--force",
    "-u",
    remoteName,
    `HEAD:refs/heads/${record.coordinationBranch}`
  ]);

  return workspaceHeadSha(provider, record);
}

/** Rebase a clean workspace onto the fetched sync target. */
export async function rebaseWorkspaceOntoSyncTarget(
  provider: WorkspaceProvider,
  record: WorkspaceRecord,
  remoteName: string,
  syncBranch: string
): Promise<string | null> {
  const result = await provider.runCommand(
    record,
    ["git", "rebase", `${remoteName}/${syncBranch}`],
    { check: false }
  );
  if (result.exitCode === 0) {
    return null;
  }

  const rebaseError = result.stderr.trim() || result.stdout.trim() || "rebase failed";
  const abort = await provider.runCommand(record, ["git", "rebase", "--abort"], {
    check: false
  });
  if (abort.exitCode === 0) {
    return rebaseError;
  }

  return `${rebaseError}; ${abort.stderr.trim() || abort.stdout.trim() || "git rebase --abort failed"}`;
}

/** Return how many commits HEAD is ahead of one remote-tracking ref. */
export async function workspaceCommitCountSinceRef(
  provider: WorkspaceProvider,
  record: WorkspaceRecord,
  baseRef: string
): Promise<number> {
  const result = await provider.runCommand(
    record,
    ["git", "rev-list", "--count", `${baseRef}..HEAD`],
    { check: false }
  );
  if (result.exitCode !== 0) {
    throw new RevisError(result.stderr.trim() || result.stdout.trim() || "git rev-list failed");
  }

  return Number.parseInt(result.stdout.trim(), 10);
}
