/** Managed-trunk bootstrap helpers for seeding a coordination remote. */

import type * as PlatformFileSystem from "@effect/platform/FileSystem";
import type * as PlatformPath from "@effect/platform/Path";
import * as Effect from "effect/Effect";

import { CommandError } from "../domain/errors";
import type { CommandFailure } from "../platform/process";
import { TRUNK_BRANCH } from "./branch-names";

interface BootstrapOptions {
  readonly root: string;
  readonly remoteName: string;
  readonly targetUrl: string;
}

type RunCommand = (
  argv: string[],
  options?: { check?: boolean; cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string }
) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, CommandFailure>;

/** Seed the managed trunk branch when the host repository has no commits yet. */
export function bootstrapManagedTrunkRemote(
  run: RunCommand,
  options: BootstrapOptions,
  hasCommits: (root: string) => Effect.Effect<boolean, CommandFailure>,
  fs: PlatformFileSystem.FileSystem,
  _path: PlatformPath.Path
): Effect.Effect<void, CommandFailure | CommandError> {
  return Effect.gen(function* () {
    const repositoryHasCommits = yield* hasCommits(options.root);

    if (repositoryHasCommits) {
      yield* run(["git", "push", "--force", options.remoteName, `HEAD:refs/heads/${TRUNK_BRANCH}`], {
        cwd: options.root
      });
      return;
    }

    yield* Effect.scoped(
      Effect.gen(function* () {
        // Seed an empty managed trunk via a temporary repo because git cannot push a branch that
        // has no commits at all from the host repository.
        const tempRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "revis-seed-trunk-"
        }).pipe(
          Effect.mapError((error) =>
            CommandError.make({
              command: "makeTempDirectory",
              message: String(error)
            })
          )
        );

        yield* run(["git", "init"], { cwd: tempRoot });
        yield* run(["git", "config", "user.name", "Revis"], { cwd: tempRoot });
        yield* run(["git", "config", "user.email", "revis@localhost"], { cwd: tempRoot });
        yield* run(["git", "checkout", "-b", TRUNK_BRANCH], { cwd: tempRoot });
        yield* run(["git", "commit", "--allow-empty", "-m", "Initialize revis trunk"], {
          cwd: tempRoot
        });
        yield* run(["git", "remote", "add", "origin", options.targetUrl], { cwd: tempRoot });
        yield* run(["git", "push", "--force", "origin", `${TRUNK_BRANCH}:refs/heads/${TRUNK_BRANCH}`], {
          cwd: tempRoot
        });
      })
    );
  });
}
