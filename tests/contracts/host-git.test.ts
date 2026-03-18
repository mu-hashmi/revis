/** Behavioral contract tests for `HostGit` against real temporary git repositories. */

import { join } from "node:path";

import * as NodeContext from "@effect/platform-node/NodeContext";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { TRUNK_BRANCH } from "../../src/git/branch-names";
import { HostGit, hostGitLayer } from "../../src/git/host-git";
import {
  assertSuccess,
  gitCommit,
  initGitRepo,
  runGit
} from "../support/git";
import { makeTempDirScoped } from "../support/helpers";

describe("HostGit", () => {
  it.scoped("prefers revis-local when a repo has no remotes and bootstraps managed trunk", () =>
    withHostGit("revis-host-git-empty-", (root) =>
      Effect.gen(function* () {
        const hostGit = yield* HostGit;

        // A fresh repo should default to the managed local coordination remote and bootstrap the
        // synthetic trunk branch into that bare repo.
        expect(yield* hostGit.determineRemoteName(root)).toBe("revis-local");

        const remotePath = yield* hostGit.ensureCoordinationRemote(root);
        yield* hostGit.bootstrapCoordinationRemote(root, "revis-local", remotePath, "main");

        expect(remotePath).toBe(join(root, ".revis", "coordination.git"));
        expect(yield* hostGit.remoteBranchExists(root, "revis-local", TRUNK_BRANCH)).toBe(true);
      })
    )
  );

  it.scoped("prefers origin when origin exists", () =>
    withHostGit("revis-host-git-origin-", (root) =>
      Effect.gen(function* () {
        const remotePath = join(root, "origin.git");

        // `determineRemoteName` is an operator-facing policy choice, so exercise it with the real
        // git config instead of a fake remote list.
        yield* Effect.promise(() =>
          runGit(root, ["remote", "add", "origin", remotePath])
        ).pipe(Effect.orDie);

        expect(yield* HostGit.pipe(Effect.flatMap((hostGit) => hostGit.determineRemoteName(root)))).toBe("origin");
      })
    )
  );

  it.scoped("reports remote branch existence after a push", () =>
    withHostGit("revis-host-git-remote-branch-", (root) =>
      Effect.gen(function* () {
        const hostGit = yield* HostGit;
        const remotePath = `${root}-remote.git`;

        // Build a real bare remote and push trunk once so the branch existence checks go through
        // git's real remote-ref machinery.
        yield* Effect.promise(async () => {
          await assertSuccess(await runGit(root, ["init", "--bare", remotePath]));
          await assertSuccess(await runGit(root, ["remote", "add", "origin", remotePath]));
          await gitCommit(root, "Initial commit");
          await assertSuccess(await runGit(root, ["push", "-u", "origin", "main"]));
        }).pipe(Effect.orDie);

        expect(yield* hostGit.remoteBranchExists(root, "origin", "missing")).toBe(false);
        expect(yield* hostGit.remoteBranchExists(root, "origin", "main")).toBe(true);
      })
    )
  );

  it.scoped("clones a workspace repo, checks out the requested branch, and sets git identity", () =>
    withHostGit("revis-host-git-clone-", (root) =>
      Effect.gen(function* () {
        const hostGit = yield* HostGit;
        const remotePath = `${root}-remote.git`;
        const clonePath = join(root, "workspace");

        // Seed the remote with trunk first, then exercise the full clone/create-branch/set-identity
        // flow exactly the way the local provider does it during provisioning.
        yield* Effect.promise(async () => {
          await assertSuccess(await runGit(root, ["init", "--bare", remotePath]));
          await assertSuccess(await runGit(root, ["remote", "add", "origin", remotePath]));
          await gitCommit(root, "Initial commit");
          await assertSuccess(await runGit(root, ["push", "-u", "origin", "main"]));
        }).pipe(Effect.orDie);

        yield* hostGit.cloneWorkspaceRepo(remotePath, "origin", "main", clonePath);
        yield* hostGit.createBranchFromRemote(
          clonePath,
          "origin",
          "revis/operator-1/agent-1/work",
          "main"
        );
        yield* hostGit.setGitIdentity(clonePath, "operator-1-agent-1", "operator-1+agent-1@revis.local");

        const branch = yield* Effect.promise(() =>
          runGit(clonePath, ["rev-parse", "--abbrev-ref", "HEAD"])
        ).pipe(Effect.orDie);
        const email = yield* Effect.promise(() =>
          runGit(clonePath, ["config", "user.email"])
        ).pipe(Effect.orDie);

        expect(branch.stdout.trim()).toBe("revis/operator-1/agent-1/work");
        expect(email.stdout.trim()).toBe("operator-1+agent-1@revis.local");
      })
    )
  );
});

/** Build one real git repo and provide the live `HostGit` layer for the test body. */
function withHostGit(
  prefix: string,
  run: (root: string) => Effect.Effect<void, unknown, HostGit | Scope.Scope>
) {
  return makeTempDirScoped(prefix).pipe(
    Effect.flatMap((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => initGitRepo(root)).pipe(Effect.orDie);
        return yield* run(root).pipe(Effect.provide(makeHostGitLayer()));
      })
    )
  );
}

/** HostGit depends only on the Node platform services in these contract tests. */
function makeHostGitLayer() {
  return hostGitLayer.pipe(Layer.provide(NodeContext.layer));
}
