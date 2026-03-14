/** Git and branch helpers for passive workspace coordination. */

import { join } from "node:path";

import { simpleGit, type SimpleGit } from "simple-git";

import type { CommitSummary, RemoteBranchHead } from "../core/models";
import { RevisError } from "../core/error";
import { ensureDir, pathExists, withTempDir } from "../core/files";
import { runCommand } from "../core/process";
import { slugify } from "../core/text";

export const TRUNK_BRANCH = "revis/trunk";
const REVIS_BRANCH_PATTERN = /^revis\/([^/]+)\/(agent-\d+)\/work$/;

/** Return a configured simple-git client. */
export function gitClient(baseDir: string): SimpleGit {
  return simpleGit({
    baseDir,
    maxConcurrentProcesses: 1,
    trimmed: false
  });
}

/** Return whether coordination uses the local bare remote workflow. */
export function usesManagedTrunk(remoteName: string): boolean {
  return remoteName === "revis-local";
}

/** Resolve the git repository root that contains `cwd`. */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  const result = await probeRepoRoot(cwd);
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }

  const message = result.stderr.trim() || result.stdout.trim();
  if (message.includes("not a git repository")) {
    throw new RevisError("revis must run inside a git repository");
  }

  throw new RevisError(message || "git rev-parse failed");
}

/** Return whether a path is inside a git repository. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await probeRepoRoot(cwd);
  if (result.exitCode === 0) {
    return true;
  }

  const message = result.stderr.trim();
  if (message.includes("not a git repository")) {
    return false;
  }

  throw new RevisError(message || "git rev-parse failed");
}

/** Return whether the repository already has a commit. */
export async function hasCommits(root: string): Promise<boolean> {
  const result = await runCommand(
    ["git", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    {
      cwd: root,
      check: false
    }
  );
  if (result.exitCode === 0) {
    return true;
  }

  if (result.exitCode === 1) {
    return false;
  }

  const message = result.stderr.trim() || result.stdout.trim() || "git rev-parse failed";
  throw new RevisError(message);
}

/** Return the current checked-out branch. */
export async function currentBranch(root: string): Promise<string> {
  const branch = (await gitClient(root).revparse(["--abbrev-ref", "HEAD"])).trim();
  if (!branch || branch === "HEAD") {
    throw new RevisError("could not determine current branch");
  }

  return branch;
}

/** Return the configured URL for a git remote. */
export async function remoteUrl(root: string, remoteName: string): Promise<string> {
  return (await gitClient(root).raw(["remote", "get-url", remoteName])).trim();
}

/** Choose the coordination remote for `init`. */
export async function determineRemoteName(root: string): Promise<string> {
  const remotes = (await gitClient(root).getRemotes(true)).map((remote) => remote.name);
  if (remotes.includes("origin")) {
    return "origin";
  }

  if (remotes.length === 1) {
    return remotes[0]!;
  }

  if (remotes.length === 0) {
    return "revis-local";
  }

  throw new RevisError(
    "Revis could not choose a coordination remote. Set `origin` or leave only one git remote configured."
  );
}

/** Ensure the local bare coordination remote exists. */
export async function ensureCoordinationRemote(root: string): Promise<string> {
  const target = join(root, ".revis", "coordination.git");
  if (!(await pathExists(target))) {
    await ensureDir(join(root, ".revis"));
    await simpleGit().raw(["init", "--bare", target]);
  }

  return target;
}

/** Create or update a remote definition. */
export async function addOrUpdateRemote(
  root: string,
  remoteName: string,
  url: string
): Promise<void> {
  const git = gitClient(root);
  const remotes = (await git.getRemotes(true)).map((remote) => remote.name);
  if (remotes.includes(remoteName)) {
    await git.remote(["set-url", remoteName, url]);
    return;
  }

  await git.addRemote(remoteName, url);
}

/** Bootstrap the coordination remote for local or shared use. */
export async function bootstrapCoordinationRemote(
  root: string,
  remoteName: string,
  targetUrl: string,
  trunkBaseBranch: string
): Promise<void> {
  await addOrUpdateRemote(root, remoteName, targetUrl);

  if (usesManagedTrunk(remoteName)) {
    await bootstrapManagedTrunkRemote(root, remoteName, targetUrl);
    return;
  }

  await assertSharedRemoteBaseBranch(root, remoteName, trunkBaseBranch);
}

/** Return whether a remote branch exists. */
export async function remoteBranchExists(
  root: string,
  remoteName: string,
  branch: string
): Promise<boolean> {
  const result = await runCommand(
    ["git", "ls-remote", "--exit-code", "--heads", remoteName, branch],
    {
      cwd: root,
      check: false
    }
  );
  if (result.exitCode === 0) {
    return true;
  }

  if (result.exitCode === 2) {
    return false;
  }

  const message = result.stderr.trim() || result.stdout.trim() || "git ls-remote failed";
  throw new RevisError(message);
}

/** Return the branch each coordination mode syncs against. */
export function syncTargetBranch(remoteName: string, baseBranch: string): string {
  return usesManagedTrunk(remoteName) ? TRUNK_BRANCH : baseBranch;
}

/** Clone the coordination remote into a workspace. */
export async function cloneWorkspaceRepo(
  remoteUrlValue: string,
  remoteName: string,
  branch: string,
  destination: string
): Promise<void> {
  await ensureDir(join(destination, ".."));
  await simpleGit().clone(remoteUrlValue, destination, [
    "-o",
    remoteName,
    "--branch",
    branch
  ]);
}

/** Create or reset a branch from a fetched base branch. */
export async function createBranchFromRemote(
  repoPath: string,
  remoteName: string,
  branch: string,
  baseBranch: string
): Promise<void> {
  await fetchRemoteRefs(repoPath, remoteName, [baseBranch]);
  await gitClient(repoPath).raw([
    "checkout",
    "-B",
    branch,
    `${remoteName}/${baseBranch}`
  ]);
}

/** Set the git identity used inside a workspace. */
export async function setGitIdentity(
  repoPath: string,
  name: string,
  email: string
): Promise<void> {
  const git = gitClient(repoPath);
  await git.addConfig("user.name", name);
  await git.addConfig("user.email", email);
}

/** Return whether the working tree is dirty. */
export async function workingTreeDirty(repoPath: string): Promise<boolean> {
  const status = await gitClient(repoPath).status();
  return !status.isClean();
}

/** Return the current commit SHA for the checked-out branch. */
export async function currentHeadSha(repoPath: string): Promise<string> {
  return (await gitClient(repoPath).revparse(["HEAD"])).trim();
}

/** Return a git-identity-derived operator slug. */
export async function deriveOperatorSlug(root: string): Promise<string> {
  const emailResult = await runCommand(["git", "config", "user.email"], {
    cwd: root,
    check: false
  });
  const email = emailResult.stdout.trim();
  const emailSlug = email ? slugify(email.split("@")[0]!) : "";
  if (emailSlug) {
    return emailSlug;
  }

  const nameResult = await runCommand(["git", "config", "user.name"], {
    cwd: root,
    check: false
  });
  const name = nameResult.stdout.trim();
  const nameSlug = name ? slugify(name) : "";
  if (nameSlug) {
    return nameSlug;
  }

  if (emailResult.exitCode !== 0 && emailResult.stderr.trim()) {
    throw new RevisError(emailResult.stderr.trim());
  }

  if (nameResult.exitCode !== 0 && nameResult.stderr.trim()) {
    throw new RevisError(nameResult.stderr.trim());
  }

  throw new RevisError(
    "Could not derive an operator slug from git identity. Set `git config user.email` or `git config user.name`."
  );
}

/** Return the full branch name for one operator/agent pair. */
export function workspaceBranch(operatorSlug: string, agentId: string): string {
  return `revis/${operatorSlug}/${agentId}/work`;
}

/** Parse a Revis workspace branch into operator and agent identifiers. */
export function parseWorkspaceBranch(
  branch: string
): { operatorSlug: string; agentId: string } | null {
  const match = REVIS_BRANCH_PATTERN.exec(branch);
  if (!match) {
    return null;
  }

  return {
    operatorSlug: match[1]!,
    agentId: match[2]!
  };
}

/** Fetch the sync target plus all Revis workspace refs. */
export async function fetchCoordinationRefs(
  root: string,
  remoteName: string,
  syncBranch: string
): Promise<void> {
  await gitClient(root).raw([
    "fetch",
    "--prune",
    remoteName,
    `+refs/heads/${syncBranch}:refs/remotes/${remoteName}/${syncBranch}`,
    `+refs/heads/*:refs/remotes/${remoteName}/*`
  ]);
}

/** Fetch one or more remote branches into tracking refs. */
export async function fetchRemoteRefs(
  repoPath: string,
  remoteName: string,
  branches: string[]
): Promise<void> {
  const refspecs = branches.map(
    (branch) => `+refs/heads/${branch}:refs/remotes/${remoteName}/${branch}`
  );
  await gitClient(repoPath).raw(["fetch", "--prune", remoteName, ...refspecs]);
}

/** Return the tracking ref name for one fetched remote branch. */
export function remoteTrackingRef(remoteName: string, branch: string): string {
  return `refs/remotes/${remoteName}/${branch}`;
}

/** Return the current remote branch head SHA and subject. */
export async function branchHead(
  root: string,
  remoteName: string,
  branch: string
): Promise<{ sha: string; subject: string }> {
  await fetchRemoteRefs(root, remoteName, [branch]);
  const git = gitClient(root);
  return {
    sha: (await git.revparse([`${remoteName}/${branch}`])).trim(),
    subject: (await git.raw(["log", "-1", "--pretty=%s", `${remoteName}/${branch}`])).trim()
  };
}

/** List all fetched remote Revis workspace branches. */
export async function listRemoteWorkspaceHeads(
  root: string,
  remoteName: string
): Promise<RemoteBranchHead[]> {
  const output = await gitClient(root).raw([
    "for-each-ref",
    "--format=%(refname:strip=3) %(objectname)",
    `refs/remotes/${remoteName}/revis/*/agent-*/work`
  ]);

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [branch, sha] = line.split(/\s+/, 2);
      return { branch: branch!, sha: sha! };
    });
}

/** Build a short commit summary for a local or remote ref. */
export async function commitSummaryForRef(
  root: string,
  ref: string,
  branch: string
): Promise<CommitSummary> {
  const parsed = parseWorkspaceBranch(branch);
  if (!parsed) {
    throw new RevisError(`Not a Revis workspace branch: ${branch}`);
  }

  const git = gitClient(root);
  const sha = (await git.revparse([ref])).trim();
  const subject = (await git.raw(["log", "-1", "--pretty=%s", ref])).trim();
  const shortstat = normalizeShortstat(
    await git.raw(["show", "--shortstat", "--format=", ref])
  );

  return {
    sha,
    shortSha: sha.slice(0, 8),
    subject,
    shortstat,
    branch,
    operatorSlug: parsed.operatorSlug,
    agentId: parsed.agentId
  };
}

/** Push one local ref to a named coordination branch on the remote. */
export async function pushBranch(
  repoPath: string,
  remoteName: string,
  sourceRef: string,
  destinationBranch = sourceRef
): Promise<string> {
  await gitClient(repoPath).raw([
    "push",
    "--force-with-lease",
    "-u",
    remoteName,
    `${sourceRef}:refs/heads/${destinationBranch}`
  ]);
  return currentHeadSha(repoPath);
}

/** Run a callback inside a detached worktree rooted at a fetched remote branch. */
export async function withDetachedWorktree<T>(
  root: string,
  remoteName: string,
  branch: string,
  fn: (worktreePath: string) => Promise<T>
): Promise<T> {
  await fetchRemoteRefs(root, remoteName, [branch]);
  return withTempDir(`revis-${branch.replaceAll("/", "-")}-`, async (tempRoot) => {
    const worktreePath = join(tempRoot, "tree");
    const git = gitClient(root);
    await git.raw([
      "worktree",
      "add",
      "--detach",
      worktreePath,
      `refs/remotes/${remoteName}/${branch}`
    ]);

    try {
      return await fn(worktreePath);
    } finally {
      await git.raw(["worktree", "remove", "--force", worktreePath]);
    }
  });
}

/** Return a branch-safe email identity for one operator/agent workspace. */
export function workspaceEmail(operatorSlug: string, agentId: string): string {
  return `${operatorSlug}+${agentId}@revis.local`;
}

/** Normalize git shortstat output into one compact operator-facing line. */
function normalizeShortstat(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "no diffstat";
}

/** Probe git for the repository root without hiding non-repo failures. */
async function probeRepoRoot(cwd: string) {
  return runCommand(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    check: false
  });
}

/** Push or seed the managed trunk branch inside the local coordination remote. */
async function bootstrapManagedTrunkRemote(
  root: string,
  remoteName: string,
  targetUrl: string
): Promise<void> {
  if (await hasCommits(root)) {
    await gitClient(root).raw([
      "push",
      "--force",
      remoteName,
      `HEAD:refs/heads/${TRUNK_BRANCH}`
    ]);
    return;
  }

  await seedManagedTrunk(targetUrl);
}

/** Seed a brand-new managed trunk with one empty initial commit. */
async function seedManagedTrunk(targetUrl: string): Promise<void> {
  await withTempDir("revis-seed-trunk-", async (tempRoot) => {
    const tempGit = gitClient(tempRoot);
    await tempGit.init();
    await tempGit.addConfig("user.name", "Revis");
    await tempGit.addConfig("user.email", "revis@localhost");
    await tempGit.checkoutLocalBranch(TRUNK_BRANCH);
    await tempGit.commit("Initialize revis trunk", undefined, {
      "--allow-empty": null
    });
    await tempGit.addRemote("origin", targetUrl);
    await tempGit.raw([
      "push",
      "--force",
      "origin",
      `${TRUNK_BRANCH}:refs/heads/${TRUNK_BRANCH}`
    ]);
  });
}

/** Ensure a shared remote already exposes the configured base branch. */
async function assertSharedRemoteBaseBranch(
  root: string,
  remoteName: string,
  trunkBaseBranch: string
): Promise<void> {
  if (await remoteBranchExists(root, remoteName, trunkBaseBranch)) {
    return;
  }

  throw new RevisError(
    `Remote branch ${remoteName}/${trunkBaseBranch} does not exist. Push ${trunkBaseBranch} before using Revis.`
  );
}
