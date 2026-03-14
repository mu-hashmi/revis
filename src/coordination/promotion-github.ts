/** GitHub CLI-backed promotion helpers for remote PR workflows. */

import type { PullRequestRef, RevisConfig } from "../core/models";
import { RevisError } from "../core/error";
import { runCommand } from "../core/process";
import { githubRepoName } from "./promotion-git";

/** Ensure the GitHub CLI is ready for PR-based promotion. */
export async function ensureGithubCliReady(root: string): Promise<void> {
  await runCommand(["gh", "--version"]);

  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    return;
  }

  const status = await runCommand(
    ["gh", "auth", "status", "--hostname", "github.com"],
    {
      cwd: root,
      check: false
    }
  );
  if (status.exitCode !== 0) {
    throw new RevisError(
      "GitHub CLI is not authenticated. Set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`."
    );
  }
}

/** Return the open PR for one branch pair, when it already exists. */
export async function findOpenPullRequest(
  root: string,
  repoName: string,
  baseBranch: string,
  headBranch: string
): Promise<PullRequestRef | null> {
  const result = await runCommand(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repoName,
      "--state",
      "open",
      "--base",
      baseBranch,
      "--head",
      headBranch,
      "--json",
      "number,url,title"
    ],
    { cwd: root }
  );
  const payload = JSON.parse(result.stdout) as Array<{
    number: number;
    url: string;
    title: string;
  }>;
  if (payload.length === 0) {
    return null;
  }

  return {
    ...payload[0]!,
    created: false
  };
}

/** Create a PR or reuse the existing one for the same base/head pair. */
export async function createOrReusePullRequest(
  root: string,
  config: RevisConfig,
  headBranch: string,
  baseBranch: string,
  latestSubject: string
): Promise<PullRequestRef> {
  await ensureGithubCliReady(root);
  const repoName = await githubRepoName(root, config.coordinationRemote);
  const existing = await findOpenPullRequest(
    root,
    repoName,
    baseBranch,
    headBranch
  );
  if (existing) {
    return existing;
  }

  const title = `[Revis] ${headBranch}: ${latestSubject}`;
  const body = [
    "Automated promotion candidate from Revis.",
    "",
    `- Base branch: \`${baseBranch}\``,
    `- Agent branch: \`${headBranch}\``,
    `- Latest commit: ${latestSubject}`
  ].join("\n");

  const result = await runCommand(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      repoName,
      "--base",
      baseBranch,
      "--head",
      headBranch,
      "--title",
      title,
      "--body",
      body
    ],
    { cwd: root }
  );
  const url = parseCreatedPullRequestUrl(result.stdout);

  return {
    number: Number(url.split("/").at(-1)!),
    url,
    title,
    created: true
  };
}

/** Parse the pull-request URL printed by `gh pr create`. */
function parseCreatedPullRequestUrl(output: string): string {
  const url = output.trim();
  if (!url) {
    throw new RevisError("GitHub CLI did not print the created pull request URL.");
  }

  return url;
}
