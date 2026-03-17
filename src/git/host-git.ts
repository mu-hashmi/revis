/** Git service implementation for Revis host-side coordination operations. */

import { FileSystem } from "@effect/platform";
import * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as PlatformPath from "@effect/platform/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CommandError, ValidationError } from "../domain/errors";
import type {
  AgentId,
  BranchName,
  CommitSummary,
  OperatorSlug,
  RemoteBranchHead
} from "../domain/models";
import {
  asBranchName,
  asOperatorSlug,
  asRevision,
  CommitSummary as CommitSummarySchema,
  RemoteBranchHead as RemoteBranchHeadSchema
} from "../domain/models";
import {
  type CommandFailure,
  runCommandWith
} from "../platform/process";
import { slugify } from "../platform/text";
import {
  parseWorkspaceBranch,
  remoteTrackingRef,
  TRUNK_BRANCH,
  usesManagedTrunk
} from "./branch-names";
import { bootstrapManagedTrunkRemote } from "./bootstrap";

export type HostGitError = CommandFailure | ValidationError;

export interface HostGitApi {
  readonly resolveRepoRoot: (cwd: string) => Effect.Effect<string, HostGitError>;
  readonly isGitRepo: (cwd: string) => Effect.Effect<boolean, CommandFailure>;
  readonly hasCommits: (root: string) => Effect.Effect<boolean, CommandFailure>;
  readonly currentBranch: (root: string) => Effect.Effect<BranchName, HostGitError>;
  readonly remoteUrl: (root: string, remoteName: string) => Effect.Effect<string, HostGitError>;
  readonly determineRemoteName: (root: string) => Effect.Effect<string, HostGitError>;
  readonly ensureCoordinationRemote: (root: string) => Effect.Effect<string, CommandFailure | CommandError>;
  readonly addOrUpdateRemote: (
    root: string,
    remoteName: string,
    url: string
  ) => Effect.Effect<void, HostGitError>;
  readonly bootstrapCoordinationRemote: (
    root: string,
    remoteName: string,
    targetUrl: string,
    trunkBaseBranch: string
  ) => Effect.Effect<void, HostGitError | CommandError>;
  readonly remoteBranchExists: (
    root: string,
    remoteName: string,
    branch: string
  ) => Effect.Effect<boolean, CommandFailure>;
  readonly fetchCoordinationRefs: (
    root: string,
    remoteName: string,
    syncBranch: string
  ) => Effect.Effect<void, CommandFailure>;
  readonly fetchRemoteRefs: (
    repoPath: string,
    remoteName: string,
    branches: ReadonlyArray<string>
  ) => Effect.Effect<void, CommandFailure>;
  readonly cloneWorkspaceRepo: (
    remoteUrlValue: string,
    remoteName: string,
    branch: string,
    destination: string
  ) => Effect.Effect<void, HostGitError | CommandError>;
  readonly createBranchFromRemote: (
    repoPath: string,
    remoteName: string,
    branch: string,
    baseBranch: string
  ) => Effect.Effect<void, HostGitError>;
  readonly setGitIdentity: (
    repoPath: string,
    name: string,
    email: string
  ) => Effect.Effect<void, CommandFailure>;
  readonly workingTreeDirty: (repoPath: string) => Effect.Effect<boolean, CommandFailure>;
  readonly currentHeadSha: (
    repoPath: string
  ) => Effect.Effect<ReturnType<typeof asRevision>, CommandFailure>;
  readonly resolveRefSha: (
    repoPath: string,
    ref: string
  ) => Effect.Effect<ReturnType<typeof asRevision>, HostGitError>;
  readonly currentHeadSubject: (repoPath: string) => Effect.Effect<string, CommandFailure>;
  readonly commitCountSinceRef: (
    repoPath: string,
    baseRef: string
  ) => Effect.Effect<number, HostGitError>;
  readonly deriveOperatorSlug: (root: string) => Effect.Effect<OperatorSlug, HostGitError>;
  readonly listRemoteWorkspaceHeads: (
    root: string,
    remoteName: string
  ) => Effect.Effect<ReadonlyArray<RemoteBranchHead>, CommandFailure>;
  readonly commitSummaryForRef: (
    root: string,
    ref: string,
    branch: string
  ) => Effect.Effect<CommitSummary, HostGitError>;
  readonly pushBranch: (
    repoPath: string,
    remoteName: string,
    sourceRef: string,
    destinationBranch?: string,
    options?: { force?: boolean; setUpstream?: boolean }
  ) => Effect.Effect<string, CommandFailure>;
  readonly showCommit: (root: string, sha: string) => Effect.Effect<string, HostGitError>;
}

/** Host-side git capability used by setup, daemon reconcile, and promotion flows. */
export class HostGit extends Context.Tag("@revis/HostGit")<HostGit, HostGitApi>() {}

/** Build the live host git service on top of Effect Platform command and filesystem services. */
const makeHostGit = Effect.gen(function* () {
  // Shared platform services and command runner.
  const executor = yield* CommandExecutor.CommandExecutor;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* PlatformPath.Path;
  const run = (argv: string[], options: Parameters<typeof runCommandWith>[2] = {}) =>
    runCommandWith(executor, argv, options);

  // Repository discovery and coordination remote selection.
  const resolveRepoRoot = Effect.fn("HostGit.resolveRepoRoot")(function* (cwd: string) {
    const result = yield* run(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      check: false
    });
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }

    const message = result.stderr.trim() || result.stdout.trim() || "git rev-parse failed";
    if (message.includes("not a git repository")) {
      return yield* ValidationError.make({
        message: "revis must run inside a git repository"
      });
    }

    return yield* CommandError.make({
      command: "git rev-parse --show-toplevel",
      message
    });
  });

  const isGitRepo = Effect.fn("HostGit.isGitRepo")(function* (cwd: string) {
    const result = yield* run(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      check: false
    });
    if (result.exitCode === 0) {
      return true;
    }

    const message = result.stderr.trim() || result.stdout.trim();
    if (message.includes("not a git repository")) {
      return false;
    }

    return yield* CommandError.make({
      command: "git rev-parse --show-toplevel",
      message: message || "git rev-parse failed"
    });
  });

  const hasCommits = Effect.fn("HostGit.hasCommits")(function* (root: string) {
    const result = yield* run(["git", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      cwd: root,
      check: false
    });
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }

    return yield* CommandError.make({
      command: "git rev-parse --verify --quiet HEAD^{commit}",
      message: result.stderr.trim() || result.stdout.trim() || "git rev-parse failed"
    });
  });

  const currentBranch = Effect.fn("HostGit.currentBranch")(function* (root: string) {
    const result = yield* run(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      check: false
    });
    const branch = result.stdout.trim();
    if (result.exitCode === 0 && branch && branch !== "HEAD") {
      return asBranchName(branch);
    }

    return yield* ValidationError.make({
      message: result.stderr.trim() || result.stdout.trim() || "could not determine current branch"
    });
  });

  const remoteUrl = Effect.fn("HostGit.remoteUrl")(function* (root: string, remoteName: string) {
    const result = yield* run(["git", "remote", "get-url", remoteName], {
      cwd: root,
      check: false
    });
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }

    return yield* ValidationError.make({
      message: result.stderr.trim() || result.stdout.trim() || `Remote ${remoteName} is not configured`
    });
  });

  const determineRemoteName = Effect.fn("HostGit.determineRemoteName")(function* (root: string) {
    const result = yield* run(["git", "remote"], { cwd: root });
    const remotes = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    // Prefer origin, then the only configured remote, and only then create a repo-local remote.
    if (remotes.includes("origin")) {
      return "origin";
    }
    if (remotes.length === 1) {
      return remotes[0]!;
    }
    if (remotes.length === 0) {
      return "revis-local";
    }

    return yield* ValidationError.make({
      message:
        "Revis could not choose a coordination remote. Set `origin` or leave only one git remote configured."
    });
  });

  // Remote bootstrapping and fetch helpers.
  const ensureCoordinationRemote = Effect.fn("HostGit.ensureCoordinationRemote")(function* (root: string) {
    const target = path.join(root, ".revis", "coordination.git");
    const exists = yield* fs.exists(target).pipe(
      Effect.mapError((error) =>
        CommandError.make({
          command: "exists",
          message: String(error)
        })
      )
    );

    if (!exists) {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
        Effect.mapError((error) =>
          CommandError.make({
            command: "makeDirectory",
            message: String(error)
          })
        )
      );
      yield* run(["git", "init", "--bare", target], { cwd: root });
    }

    return target;
  });

  const addOrUpdateRemote = Effect.fn("HostGit.addOrUpdateRemote")(function* (
    root: string,
    remoteName: string,
    url: string
  ) {
    const remotes = yield* run(["git", "remote"], { cwd: root });
    const names = remotes.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (names.includes(remoteName)) {
      yield* run(["git", "remote", "set-url", remoteName, url], { cwd: root });
      return;
    }

    yield* run(["git", "remote", "add", remoteName, url], { cwd: root });
  });

  const remoteBranchExists = Effect.fn("HostGit.remoteBranchExists")(function* (
    root: string,
    remoteName: string,
    branch: string
  ) {
    const result = yield* run(["git", "ls-remote", "--exit-code", "--heads", remoteName, branch], {
      cwd: root,
      check: false
    });
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 2) {
      return false;
    }

    return yield* CommandError.make({
      command: "git ls-remote --exit-code --heads",
      message: result.stderr.trim() || result.stdout.trim() || "git ls-remote failed"
    });
  });

  const bootstrapCoordinationRemote = Effect.fn("HostGit.bootstrapCoordinationRemote")(function* (
    root: string,
    remoteName: string,
    targetUrl: string,
    trunkBaseBranch: string
  ) {
    yield* addOrUpdateRemote(root, remoteName, targetUrl);

    if (usesManagedTrunk(remoteName)) {
      yield* bootstrapManagedTrunkRemote(run, { root, remoteName, targetUrl }, hasCommits, fs, path);
      return;
    }

    const exists = yield* remoteBranchExists(root, remoteName, trunkBaseBranch);
    if (!exists) {
      return yield* ValidationError.make({
      message: `Remote branch ${remoteName}/${trunkBaseBranch} does not exist. Push ${trunkBaseBranch} before using Revis.`
      });
    }
  });

  // Workspace clone/setup helpers and common ref inspection utilities.
  const fetchCoordinationRefs = Effect.fn("HostGit.fetchCoordinationRefs")(function* (
    root: string,
    remoteName: string,
    syncBranch: string
  ) {
    yield* run(
      [
        "git",
        "fetch",
        "--prune",
        remoteName,
        `+refs/heads/${syncBranch}:refs/remotes/${remoteName}/${syncBranch}`,
        `+refs/heads/*:refs/remotes/${remoteName}/*`
      ],
      { cwd: root }
    );
  });

  const fetchRemoteRefs = Effect.fn("HostGit.fetchRemoteRefs")(function* (
    repoPath: string,
    remoteName: string,
    branches: ReadonlyArray<string>
  ) {
    const refspecs = branches.map(
      (branch) => `+refs/heads/${branch}:refs/remotes/${remoteName}/${branch}`
    );
    yield* run(["git", "fetch", "--prune", remoteName, ...refspecs], { cwd: repoPath });
  });

  const cloneWorkspaceRepo = Effect.fn("HostGit.cloneWorkspaceRepo")(function* (
    remoteUrlValue: string,
    remoteName: string,
    branch: string,
    destination: string
  ) {
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
      Effect.mapError((error) =>
        CommandError.make({
          command: "makeDirectory",
          message: String(error)
        })
      )
    );

    yield* run(
      ["git", "clone", "-o", remoteName, "--branch", branch, remoteUrlValue, destination],
      { check: true }
    );
  });

  const createBranchFromRemote = Effect.fn("HostGit.createBranchFromRemote")(function* (
    repoPath: string,
    remoteName: string,
    branch: string,
    baseBranch: string
  ) {
    yield* fetchRemoteRefs(repoPath, remoteName, [baseBranch]);
    yield* run(["git", "checkout", "-B", branch, `${remoteName}/${baseBranch}`], {
      cwd: repoPath
    });
  });

  const setGitIdentity = Effect.fn("HostGit.setGitIdentity")(function* (
    repoPath: string,
    name: string,
    email: string
  ) {
    yield* run(["git", "config", "user.name", name], { cwd: repoPath });
    yield* run(["git", "config", "user.email", email], { cwd: repoPath });
  });

  const workingTreeDirty = Effect.fn("HostGit.workingTreeDirty")(function* (repoPath: string) {
    const result = yield* run(["git", "status", "--porcelain"], {
      cwd: repoPath,
      check: false
    });
    return result.stdout.trim().length > 0;
  });

  const currentHeadSha = Effect.fn("HostGit.currentHeadSha")(function* (repoPath: string) {
    const result = yield* run(["git", "rev-parse", "HEAD"], { cwd: repoPath });
    return asRevision(result.stdout.trim());
  });

  const resolveRefSha = Effect.fn("HostGit.resolveRefSha")(function* (repoPath: string, ref: string) {
    const result = yield* run(["git", "rev-parse", ref], {
      cwd: repoPath,
      check: false
    });
    if (result.exitCode === 0) {
      return asRevision(result.stdout.trim());
    }

    return yield* ValidationError.make({
      message: result.stderr.trim() || result.stdout.trim() || `Could not resolve git ref ${ref}`
    });
  });

  const currentHeadSubject = Effect.fn("HostGit.currentHeadSubject")(function* (repoPath: string) {
    const result = yield* run(["git", "log", "-1", "--pretty=%s", "HEAD"], {
      cwd: repoPath
    });
    return result.stdout.trim();
  });

  const commitCountSinceRef = Effect.fn("HostGit.commitCountSinceRef")(function* (
    repoPath: string,
    baseRef: string
  ) {
    const result = yield* run(["git", "rev-list", "--count", `${baseRef}..HEAD`], {
      cwd: repoPath,
      check: false
    });
    if (result.exitCode !== 0) {
      return yield* ValidationError.make({
        message: result.stderr.trim() || result.stdout.trim() || "git rev-list failed"
      });
    }

    return Number.parseInt(result.stdout.trim(), 10);
  });

  const deriveOperatorSlug = Effect.fn("HostGit.deriveOperatorSlug")(function* (root: string) {
    const emailResult = yield* run(["git", "config", "user.email"], {
      cwd: root,
      check: false
    });
    const emailSlug = slugify((emailResult.stdout.trim().split("@")[0] ?? "").trim());
    if (emailSlug) {
      return asOperatorSlug(emailSlug);
    }

    // Prefer email because it is usually unique and stable across machines; fall back to git
    // user.name only when email is missing or unusable.
    const nameResult = yield* run(["git", "config", "user.name"], {
      cwd: root,
      check: false
    });
    const nameSlug = slugify(nameResult.stdout.trim());
    if (nameSlug) {
      return asOperatorSlug(nameSlug);
    }

    return yield* ValidationError.make({
      message:
        "Could not derive an operator slug from git identity. Set `git config user.email` or `git config user.name`."
    });
  });

  // Remote branch summaries, promotion helpers, and raw commit inspection.
  const listRemoteWorkspaceHeads = Effect.fn("HostGit.listRemoteWorkspaceHeads")(function* (
    root: string,
    remoteName: string
  ) {
    const result = yield* run(
      [
        "git",
        "for-each-ref",
        "--format=%(refname:strip=3) %(objectname)",
        `refs/remotes/${remoteName}/revis/*/agent-*/work`
      ],
      { cwd: root }
    );

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [branch, sha] = line.split(/\s+/, 2);
        return RemoteBranchHeadSchema.make({
          branch: asBranchName(branch!),
          sha: asRevision(sha!)
        });
      });
  });

  const commitSummaryForRef = Effect.fn("HostGit.commitSummaryForRef")(function* (
    root: string,
    ref: string,
    branch: string
  ) {
    const parsed = parseWorkspaceBranch(branch);
    if (!parsed) {
      return yield* ValidationError.make({
        message: `Not a Revis workspace branch: ${branch}`
      });
    }

    const sha = (yield* run(["git", "rev-parse", ref], { cwd: root })).stdout.trim();
    const subject = (yield* run(["git", "log", "-1", "--pretty=%s", ref], { cwd: root })).stdout.trim();
    const shortstat = normalizeShortstat(
      (yield* run(["git", "show", "--shortstat", "--format=", ref], { cwd: root })).stdout
    );

    return CommitSummarySchema.make({
      sha: asRevision(sha),
      shortSha: sha.slice(0, 8),
      subject,
      shortstat,
      branch: asBranchName(branch),
      operatorSlug: parsed.operatorSlug,
      agentId: parsed.agentId
    });
  });

  const pushBranch = Effect.fn("HostGit.pushBranch")(function* (
    repoPath: string,
    remoteName: string,
    sourceRef: string,
    destinationBranch = sourceRef,
    options: { force?: boolean; setUpstream?: boolean } = {}
  ) {
    const argv = [
      "git",
      "push",
      ...(options.force === true ? ["--force"] : ["--force-with-lease"]),
      ...(options.setUpstream !== false ? ["-u"] : []),
      remoteName,
      `${sourceRef}:refs/heads/${destinationBranch}`
    ];

    yield* run(argv, { cwd: repoPath });
    return yield* currentHeadSha(repoPath);
  });

  const showCommit = Effect.fn("HostGit.showCommit")(function* (root: string, sha: string) {
    const result = yield* run(["git", "show", "--stat", "--format=fuller", sha], {
      cwd: root,
      check: false
    });
    if (result.exitCode === 0) {
      return result.stdout;
    }

    return yield* ValidationError.make({
      message: result.stderr.trim() || result.stdout.trim() || "git show failed"
    });
  });

  return HostGit.of({
    resolveRepoRoot,
    isGitRepo,
    hasCommits,
    currentBranch,
    remoteUrl,
    determineRemoteName,
    ensureCoordinationRemote,
    addOrUpdateRemote,
    bootstrapCoordinationRemote,
    remoteBranchExists,
    fetchCoordinationRefs,
    fetchRemoteRefs,
    cloneWorkspaceRepo,
    createBranchFromRemote,
    setGitIdentity,
    workingTreeDirty,
    currentHeadSha,
    resolveRefSha,
    currentHeadSubject,
    commitCountSinceRef,
    deriveOperatorSlug,
    listRemoteWorkspaceHeads,
    commitSummaryForRef,
    pushBranch,
    showCommit
  });
});

export const hostGitLayer = Layer.effect(HostGit, makeHostGit);

/** Normalize git shortstat output into one compact operator-facing line. */
function normalizeShortstat(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1) ?? "no diffstat";
}
