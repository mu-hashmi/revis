/** Local managed-trunk promotion helpers. */

import { join } from "node:path";

import { simpleGit } from "simple-git";

import { RevisError } from "../core/error";
import { withTempDir } from "../core/files";
import { runCommand } from "../core/process";
import {
  TRUNK_BRANCH,
  fetchRemoteRefs,
  remoteTrackingRef,
  remoteUrl
} from "./repo";
import { latestCommitSubject } from "./promotion-git";

/** Merge a remote workspace branch into the managed trunk branch. */
export async function mergeIntoManagedTrunk(
  root: string,
  remoteName: string,
  branch: string
): Promise<string> {
  const coordinationUrl = await remoteUrl(root, remoteName);

  return withTempDir("revis-promote-", async (tempRoot) => {
    const worktreePath = join(tempRoot, "tree");
    await simpleGit().clone(coordinationUrl, worktreePath, [
      "-o",
      remoteName,
      "--branch",
      TRUNK_BRANCH
    ]);
    await fetchRemoteRefs(worktreePath, remoteName, [branch]);

    const mergeTarget = remoteTrackingRef(remoteName, branch);
    const result = await runCommand(
      ["git", "merge", "--no-ff", "--no-edit", mergeTarget],
      {
        cwd: worktreePath,
        check: false
      }
    );

    if (result.exitCode !== 0) {
      await runCommand(["git", "merge", "--abort"], {
        cwd: worktreePath,
        check: false
      });
      throw new RevisError(result.stderr.trim() || result.stdout.trim() || "merge failed");
    }

    await runCommand(
      [
        "git",
        "push",
        remoteName,
        `HEAD:refs/heads/${TRUNK_BRANCH}`
      ],
      { cwd: worktreePath }
    );

    return latestCommitSubject(worktreePath);
  });
}
