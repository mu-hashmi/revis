import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import * as NodeContext from "@effect/platform-node/NodeContext";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { TRUNK_BRANCH } from "../src/git/branch-names";
import { HostGit, hostGitLayer } from "../src/git/host-git";

const execFileAsync = promisify(execFile);

class TestGitError extends Schema.TaggedError<TestGitError>()("TestGitError", {
  message: Schema.String
}) {}

it.effect("host git bootstraps a managed coordination remote for empty repos", () =>
  withTempRepo((root) =>
    Effect.gen(function* () {
      const hostGit = yield* HostGit;

      expect(yield* hostGit.determineRemoteName(root)).toBe("revis-local");

      const remotePath = yield* hostGit.ensureCoordinationRemote(root);
      yield* hostGit.bootstrapCoordinationRemote(root, "revis-local", remotePath, "main");

      expect(remotePath).toBe(join(root, ".revis", "coordination.git"));
      expect(yield* hostGit.remoteBranchExists(root, "revis-local", TRUNK_BRANCH)).toBe(true);
    }).pipe(Effect.provide(hostGitLayer.pipe(Layer.provide(NodeContext.layer))))
  )
);

function withTempRepo<A, E, R>(run: (root: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const root = await mkdtemp(join(tmpdir(), "revis-host-git-test-"));

        await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
        await execFileAsync("git", ["config", "user.name", "Revis Tester"], { cwd: root });
        await execFileAsync("git", ["config", "user.email", "tester@example.com"], { cwd: root });

        return root;
      },
      catch: (error) =>
        TestGitError.make({
          message: error instanceof Error ? error.message : String(error)
        })
    }),
    run,
    (root) =>
      Effect.tryPromise({
        try: () => rm(root, { recursive: true, force: true }),
        catch: () => TestGitError.make({ message: "cleanup failed" })
      }).pipe(Effect.ignore)
  );
}
