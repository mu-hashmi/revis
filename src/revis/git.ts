/** Git helpers for repo discovery, worktrees, publication, and promotion. */

import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ValidationError } from "../domain/errors";
import {
  asBranchName,
  asOperatorSlug,
  asRevision,
  type BranchName,
  type OperatorSlug,
  type Revision,
  type RunId
} from "../domain/models";
import { runCommand } from "./process";

/** Convert an arbitrary user or git name into a stable branch-safe slug. */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

/** Resolve the repository root for the current working directory. */
export function resolveProjectRoot(cwd: string) {
  return Effect.gen(function* () {
    const result = yield* runCommand("git", ["rev-parse", "--show-toplevel"], {
      check: false,
      cwd
    });

    if (result.exitCode !== 0) {
      return yield* new ValidationError({
        detail: "revis must run inside a git repository"
      });
    }

    return result.stdout.trim();
  });
}

/** Return the checked-out branch name. */
export function currentBranch(root: string) {
  return Effect.gen(function* () {
    const branch = (yield* runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })).stdout.trim();

    if (branch === "HEAD" || branch.length === 0) {
      return yield* new ValidationError({
        detail: "revis requires a checked-out branch"
      });
    }

    return branch;
  });
}

/** Choose the remote Revis should treat as canonical. */
export function detectRemoteName(root: string) {
  return Effect.gen(function* () {
    const remotes = collectLines((yield* runCommand("git", ["remote"], { cwd: root })).stdout);

    if (remotes.includes("origin")) {
      return "origin";
    }

    if (remotes.length === 1) {
      return remotes[0]!;
    }

    if (remotes.length === 0) {
      return yield* new ValidationError({
        detail: "revis requires a git remote for SDK-native runs"
      });
    }

    return yield* new ValidationError({
      detail: "multiple git remotes are configured; set origin or pass --remote"
    });
  });
}

/** Return the URL configured for one remote. */
export function remoteUrl(root: string, remoteName: string) {
  return Effect.map(
    runCommand("git", ["remote", "get-url", remoteName], { cwd: root }),
    (result) => result.stdout.trim()
  );
}

/** Derive a stable operator slug for branch naming. */
export function operatorSlug(root: string) {
  return Effect.gen(function* () {
    const configuredName = (
      yield* runCommand("git", ["config", "user.name"], {
        check: false,
        cwd: root
      })
    ).stdout.trim();

    // Fall back to the local login name when the repo has no explicit author name yet.
    const candidate = configuredName || process.env.USER || process.env.USERNAME || "operator";
    const slug = slugify(candidate);

    if (slug.length === 0) {
      return yield* new ValidationError({
        detail: "could not derive an operator slug"
      });
    }

    return asOperatorSlug(slug);
  });
}

/** Build one participant branch name. */
export function participantBranchName(
  branchPrefix: string,
  operator: OperatorSlug,
  runId: RunId,
  agentNumber: number
): BranchName {
  return asBranchName(`${branchPrefix}/${operator}/${runId}/agent-${agentNumber}`);
}

/** Ensure one repo has an identity for commits. */
export function ensureGitIdentity(repoPath: string) {
  return Effect.gen(function* () {
    const name = (
      yield* runCommand("git", ["config", "user.name"], {
        check: false,
        cwd: repoPath
      })
    ).stdout.trim();
    const email = (
      yield* runCommand("git", ["config", "user.email"], {
        check: false,
        cwd: repoPath
      })
    ).stdout.trim();

    if (name.length === 0) {
      yield* runCommand("git", ["config", "user.name", "Revis"], { cwd: repoPath });
    }

    if (email.length === 0) {
      yield* runCommand("git", ["config", "user.email", "revis@localhost"], { cwd: repoPath });
    }
  });
}

/** Create or reset one local worktree on the target branch. */
export function createWorktree(
  root: string,
  worktreePath: string,
  branch: BranchName,
  baseRef: string
) {
  return Effect.gen(function* () {
    yield* runCommand("git", ["worktree", "add", "--force", "-B", branch, worktreePath, baseRef], {
      cwd: root
    });

    yield* ensureGitIdentity(worktreePath);
  });
}

/** Remove one local worktree. */
export function removeWorktree(root: string, worktreePath: string) {
  return runCommand("git", ["worktree", "remove", "--force", worktreePath], {
    check: false,
    cwd: root
  }).pipe(Effect.asVoid);
}

/** Return the current commit at HEAD. */
export function currentHeadSha(repoPath: string) {
  return Effect.map(
    runCommand("git", ["rev-parse", "HEAD"], { cwd: repoPath }),
    (result) => asRevision(result.stdout.trim())
  );
}

/** Return whether the working tree has local changes. */
export function workingTreeDirty(repoPath: string) {
  return Effect.map(
    runCommand("git", ["status", "--short", "--untracked-files=all"], {
      cwd: repoPath
    }),
    (result) => result.stdout.trim().length > 0
  );
}

/** Return every changed file since one baseline commit, including untracked files. */
export function changedFilesSince(repoPath: string, baseSha: Revision | null) {
  const fromRef = baseSha ?? asRevision("HEAD");

  return Effect.gen(function* () {
    const [tracked, untracked] = yield* Effect.all([
      runCommand("git", ["diff", "--name-only", fromRef, "--"], {
        cwd: repoPath
      }),
      runCommand("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: repoPath
      })
    ]);

    return [...new Set([...collectLines(tracked.stdout), ...collectLines(untracked.stdout)])].sort();
  });
}

/** Push one branch to the configured remote and set upstream on first push. */
export function pushBranch(repoPath: string, remoteName: string, branch: BranchName) {
  return Effect.gen(function* () {
    yield* runCommand("git", ["push", "--set-upstream", remoteName, branch], { cwd: repoPath });
    return yield* currentHeadSha(repoPath);
  });
}

/** Extract `owner/repo` from a GitHub remote URL. */
export function githubRepoName(url: string) {
  const normalized = url
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");

  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(normalized);
  if (!match) {
    return Effect.fail(new ValidationError({
      detail: `GitHub PR promotion requires a github.com remote, got: ${url}`
    }));
  }

  return Effect.succeed(match[1]!);
}

/** Open or reuse a pull request for one participant branch. */
export function openOrReusePullRequest(input: {
  readonly baseBranch: string;
  readonly body: string;
  readonly headBranch: BranchName;
  readonly remoteUrl: string;
  readonly root: string;
  readonly title: string;
}) {
  const PullRequestListSchema = Schema.Array(Schema.Struct({
    url: Schema.NonEmptyString
  }));

  return Effect.gen(function* () {
    const repo = yield* githubRepoName(input.remoteUrl);

    // Prefer reusing the existing PR so repeated promotions stay idempotent.
    const existing = yield* runCommand(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--base",
        input.baseBranch,
        "--head",
        input.headBranch,
        "--json",
        "url"
      ],
      { cwd: input.root }
    );
    const parsed = yield* Schema.decodeUnknown(Schema.parseJson(PullRequestListSchema))(existing.stdout);

    if (parsed.length > 0) {
      return parsed[0]!.url;
    }

    return (
      yield* runCommand(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          repo,
          "--base",
          input.baseBranch,
          "--head",
          input.headBranch,
          "--title",
          input.title,
          "--body",
          input.body
        ],
        { cwd: input.root }
      )
    ).stdout.trim();
  });
}

/** Return the repository name used when cloning into remote sandboxes. */
export function repositoryDirectoryName(root: string): string {
  return basename(root);
}

/** Split newline-delimited git output into clean lines. */
function collectLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
