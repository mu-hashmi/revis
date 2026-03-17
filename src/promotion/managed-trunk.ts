/** Managed-trunk promotion flow for locally owned coordination remotes. */

import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as PlatformFileSystem from "@effect/platform/FileSystem";
import type * as PlatformPath from "@effect/platform/Path";
import * as Effect from "effect/Effect";

import { CommandError } from "../domain/errors";
import type { WorkspaceSnapshot } from "../domain/models";
import type { HostGitApi, HostGitError } from "../git/host-git";
import { remoteTrackingRef, TRUNK_BRANCH } from "../git/branch-names";
import { runCommandWith, type CommandFailure } from "../platform/process";
import type { PromotionResult } from "./service";

export type ManagedTrunkPromotionError = CommandError | CommandFailure | HostGitError;

/** Merge one owned branch into the managed trunk branch on the coordination remote. */
export function promoteManagedWorkspace(
  root: string,
  config: { coordinationRemote: string },
  snapshot: WorkspaceSnapshot,
  hostGit: HostGitApi,
  executor: CommandExecutor.CommandExecutor,
  fs: PlatformFileSystem.FileSystem,
  path: PlatformPath.Path
): Effect.Effect<PromotionResult, ManagedTrunkPromotionError> {
  return Effect.gen(function* () {
    const coordinationUrl = yield* hostGit.remoteUrl(root, config.coordinationRemote);

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const tempRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "revis-promote-"
        }).pipe(
          Effect.mapError((error) =>
            CommandError.make({
              command: "makeTempDirectory",
              message: error.message
            })
          )
        );
        const repoPath = path.join(tempRoot, "repo");

        yield* hostGit.cloneWorkspaceRepo(
          coordinationUrl,
          config.coordinationRemote,
          TRUNK_BRANCH,
          repoPath
        );
        yield* hostGit.fetchRemoteRefs(repoPath, config.coordinationRemote, [
          snapshot.spec.coordinationBranch
        ]);

        const mergeTarget = remoteTrackingRef(
          config.coordinationRemote,
          snapshot.spec.coordinationBranch
        );
        const mergeResult = yield* runCommandWith(
          executor,
          ["git", "merge", "--no-ff", "--no-edit", mergeTarget],
          {
            cwd: repoPath,
            check: false
          }
        );

        if (mergeResult.exitCode !== 0) {
          yield* runCommandWith(executor, ["git", "merge", "--abort"], {
            cwd: repoPath,
            check: false
          }).pipe(Effect.ignore);

          return yield* mergeResultToFailure(mergeResult);
        }

        yield* hostGit.pushBranch(repoPath, config.coordinationRemote, "HEAD", TRUNK_BRANCH, {
          force: true,
          setUpstream: false
        });

        return {
          mode: "local" as const,
          summary: `Promoted ${snapshot.spec.coordinationBranch} into ${TRUNK_BRANCH}`
        };
      })
    );
  });
}

function mergeResultToFailure(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}): Effect.Effect<never, CommandFailure> {
  return CommandError.make({
    command: "git merge --no-ff --no-edit",
    message: result.stderr.trim() || result.stdout.trim() || "merge failed"
  });
}
