/** Shared git helpers used by multiple promotion backends. */

import { RevisError } from "../core/error";
import { gitClient, remoteUrl } from "./repo";

/** Return the latest commit subject for one repository checkout. */
export async function latestCommitSubject(repoPath: string): Promise<string> {
  const git = gitClient(repoPath);
  return (await git.raw(["log", "-1", "--pretty=%s"])).trim();
}

/** Return the configured GitHub repo slug from a remote URL. */
export async function githubRepoName(
  root: string,
  remoteName: string
): Promise<string> {
  const url = await remoteUrl(root, remoteName);
  const normalized = url
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");

  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(normalized);
  if (!match) {
    throw new RevisError(`GitHub PR promotion requires a github.com remote, got: ${url}`);
  }

  return match[1]!;
}
