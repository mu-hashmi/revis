/** Pull-request promotion flow for GitHub-backed coordination remotes. */

import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ValidationError, validationError } from "../domain/errors";
import { PullRequestRef, type WorkspaceSnapshot } from "../domain/models";
import type { HostGitApi, HostGitError } from "../git/host-git";
import { workspaceHeadSubject, type WorkspaceGitError } from "../git/workspace-ops";
import type { WorkspaceProviderApi } from "../providers/contract";
import { runCommandWith, type CommandFailure } from "../platform/process";
import type { PromotionResult } from "./service";

const GitHubPullRequestSummarySchema = Schema.Struct({
  number: Schema.Int.pipe(Schema.greaterThan(0)),
  url: Schema.NonEmptyString,
  title: Schema.NonEmptyString
});

export type PullRequestPromotionError =
  | CommandFailure
  | HostGitError
  | ValidationError
  | WorkspaceGitError;

/** Open or reuse a pull request for one owned workspace branch. */
export function promotePullRequestWorkspace(
  root: string,
  config: { coordinationRemote: string; trunkBase: string },
  snapshot: WorkspaceSnapshot,
  hostGit: HostGitApi,
  provider: WorkspaceProviderApi,
  executor: CommandExecutor.CommandExecutor
): Effect.Effect<PromotionResult, PullRequestPromotionError> {
  return Effect.gen(function* () {
    yield* ensureGithubCliReady(root, executor);

    const remoteUrl = yield* hostGit.remoteUrl(root, config.coordinationRemote);
    const latestSubject = yield* workspaceHeadSubject(provider, snapshot);
    const repoName = yield* githubRepoName(remoteUrl);
    const pullRequest = yield* createOrReusePullRequest(
      root,
      repoName,
      config.trunkBase,
      snapshot.spec.coordinationBranch,
      latestSubject,
      executor
    );

    return {
      mode: "pull_request" as const,
      summary: pullRequest.created
        ? `Opened PR #${pullRequest.number} ${pullRequest.url}`
        : `Reused PR #${pullRequest.number} ${pullRequest.url}`,
      pullRequest
    };
  });
}

/** Ensure `gh` is available and authenticated before PR promotion. */
function ensureGithubCliReady(
  root: string,
  executor: CommandExecutor.CommandExecutor
): Effect.Effect<void, CommandFailure | ValidationError> {
  return Effect.gen(function* () {
    yield* runCommandWith(executor, ["gh", "--version"], { cwd: root });

    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
      return;
    }

    const status = yield* runCommandWith(
      executor,
      ["gh", "auth", "status", "--hostname", "github.com"],
      {
        cwd: root,
        check: false
      }
    );

    if (status.exitCode !== 0) {
      return yield* ValidationError.make({
        message: "GitHub CLI is not authenticated. Set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`."
      });
    }
  });
}

/** Return the open PR for one base/head pair when it already exists. */
function findOpenPullRequest(
  root: string,
  repoName: string,
  baseBranch: string,
  headBranch: string,
  executor: CommandExecutor.CommandExecutor
): Effect.Effect<PullRequestRef | null, CommandFailure | ValidationError> {
  return Effect.gen(function* () {
    const result = yield* runCommandWith(
      executor,
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
    const payload = yield* Schema.decodeUnknown(
      Schema.parseJson(Schema.Array(GitHubPullRequestSummarySchema))
    )(result.stdout).pipe(
      Effect.mapError((error) =>
        validationError(String(error))
      )
    );

    if (payload.length === 0) {
      return null;
    }

    return PullRequestRef.make({
      ...payload[0]!,
      created: false
    });
  });
}

/** Create or reuse a pull request for one promoted coordination branch. */
function createOrReusePullRequest(
  root: string,
  repoName: string,
  baseBranch: string,
  headBranch: string,
  latestSubject: string,
  executor: CommandExecutor.CommandExecutor
): Effect.Effect<PullRequestRef, CommandFailure | ValidationError> {
  return Effect.gen(function* () {
    const existing = yield* findOpenPullRequest(
      root,
      repoName,
      baseBranch,
      headBranch,
      executor
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
    const result = yield* runCommandWith(
      executor,
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
    const url = yield* parseCreatedPullRequestUrl(result.stdout);

    return PullRequestRef.make({
      number: Number(url.split("/").at(-1)!),
      url,
      title,
      created: true
    });
  });
}

/** Parse the pull-request URL printed by `gh pr create`. */
function parseCreatedPullRequestUrl(output: string): Effect.Effect<string, ValidationError> {
  const url = output.trim();
  if (!url) {
    return validationError("GitHub CLI did not print the created pull request URL.");
  }

  return Effect.succeed(url);
}

/** Extract an owner/repository slug from one GitHub remote URL. */
function githubRepoName(remoteUrl: string): Effect.Effect<string, ValidationError> {
  const normalized = remoteUrl
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(normalized);

  if (!match) {
    return validationError(`GitHub PR promotion requires a github.com remote, got: ${remoteUrl}`);
  }

  return Effect.succeed(match[1]!);
}
