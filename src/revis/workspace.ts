/** Uniform workspace operations for local worktrees and remote sandboxes. */

import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as FileSystem from "@effect/platform/FileSystem";
import { Effect } from "effect";

import { CommandError, SandboxError, StorageError } from "../domain/errors";
import { currentHeadSha, changedFilesSince, pushBranch, removeWorktree, workingTreeDirty } from "./git";
import { runSandboxCommand, type SandboxHandle } from "./sandbox";
import { removePath } from "./files";
import { asRevision, type BranchName, type Revision } from "../domain/models";

type WorkspaceEffect<A> = Effect.Effect<
  A,
  CommandError | SandboxError | StorageError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
>;

/** Git-oriented operations exposed by either a local worktree or remote sandbox clone. */
export interface WorkspaceOps {
  readonly root: string;
  changedFilesSince(baseSha: Revision | null): WorkspaceEffect<string[]>;
  currentHeadSha(): WorkspaceEffect<Revision>;
  destroy(): WorkspaceEffect<void>;
  pushBranch(remoteName: string, branch: BranchName): WorkspaceEffect<Revision>;
  workingTreeDirty(): WorkspaceEffect<boolean>;
}

/** Build workspace operations for one local git worktree. */
export function localWorkspaceOps(root: string, worktreeRoot: string): WorkspaceOps {
  return {
    root: worktreeRoot,
    changedFilesSince: (baseSha) => changedFilesSince(worktreeRoot, baseSha),
    currentHeadSha: () => currentHeadSha(worktreeRoot),
    destroy: () =>
      Effect.gen(function* () {
        yield* removeWorktree(root, worktreeRoot);
        yield* removePath(worktreeRoot, { force: true, recursive: true });
      }),
    pushBranch: (remoteName, branch) => pushBranch(worktreeRoot, remoteName, branch),
    workingTreeDirty: () => workingTreeDirty(worktreeRoot)
  };
}

/** Build workspace operations for one repository living inside a remote sandbox. */
export function remoteWorkspaceOps(handle: SandboxHandle, workspaceRoot: string): WorkspaceOps {
  return {
    root: workspaceRoot,
    changedFilesSince: (baseSha) =>
      Effect.gen(function* () {
        // Merge tracked and untracked paths so relays describe the full turn delta.
        const [tracked, untracked] = yield* Effect.all([
          runSandboxCommand(handle, {
            command: "git",
            args: ["diff", "--name-only", baseSha ?? "HEAD", "--"],
            cwd: workspaceRoot
          }),
          runSandboxCommand(handle, {
            command: "git",
            args: ["ls-files", "--others", "--exclude-standard"],
            cwd: workspaceRoot
          })
        ]);

        return [...new Set([...collectLines(tracked.stdout), ...collectLines(untracked.stdout)])].sort();
      }),
    currentHeadSha: () =>
      Effect.gen(function* () {
        const result = yield* runSandboxCommand(handle, {
          command: "git",
          args: ["rev-parse", "HEAD"],
          cwd: workspaceRoot
        });

        return asRevision(result.stdout.trim());
      }),
    destroy: () => Effect.void,
    pushBranch: (remoteName, branch) =>
      Effect.gen(function* () {
        yield* runSandboxCommand(handle, {
          command: "git",
          args: ["push", "--set-upstream", remoteName, branch],
          cwd: workspaceRoot
        });

        const result = yield* runSandboxCommand(handle, {
          command: "git",
          args: ["rev-parse", "HEAD"],
          cwd: workspaceRoot
        });

        return asRevision(result.stdout.trim());
      }),
    workingTreeDirty: () =>
      Effect.map(
        runSandboxCommand(handle, {
          command: "git",
          args: ["status", "--short", "--untracked-files=all"],
          cwd: workspaceRoot
        }),
        (result) => result.stdout.trim().length > 0
      )
  };
}

/** Split newline-delimited git output into clean path entries. */
function collectLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
