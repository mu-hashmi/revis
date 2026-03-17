/** Project initialization helpers for `revis init`. */

import { FileSystem } from "@effect/platform";
import * as Effect from "effect/Effect";

import { ProjectConfig, DEFAULT_REMOTE_POLL_SECONDS } from "../services/project-config";
import { ConfigError, StorageError } from "../domain/errors";
import { RevisConfig } from "../domain/models";
import { ProjectPaths } from "../services/project-paths";
import { HostGit, type HostGitError } from "../git/host-git";

export type InitializeProjectError = ConfigError | HostGitError | StorageError;

/** Build the default Revis config for one repository. */
export function buildDefaultConfig(root: string) {
  return Effect.gen(function* () {
    const hostGit = yield* HostGit;
    const remoteName = yield* hostGit.determineRemoteName(root);

    return RevisConfig.make({
      coordinationRemote: remoteName,
      trunkBase: yield* hostGit.currentBranch(root),
      remotePollSeconds: DEFAULT_REMOTE_POLL_SECONDS,
      sandboxProvider: "local"
    });
  });
}

/** Resolve or create the coordination remote URL/path. */
export function configureCoordinationRemote(root: string, remoteName: string) {
  return Effect.gen(function* () {
    const hostGit = yield* HostGit;

    if (remoteName === "revis-local") {
      return yield* hostGit.ensureCoordinationRemote(root);
    }

    return yield* hostGit.remoteUrl(root, remoteName);
  });
}

/** Initialize Revis inside the current repository. */
export function initializeProject(
  root: string
): Effect.Effect<RevisConfig, InitializeProjectError, ProjectConfig | HostGit | ProjectPaths | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const configService = yield* ProjectConfig;
    const hostGit = yield* HostGit;
    const config = yield* buildDefaultConfig(root);
    const targetUrl = yield* configureCoordinationRemote(root, config.coordinationRemote);

    yield* hostGit.bootstrapCoordinationRemote(
      root,
      config.coordinationRemote,
      targetUrl,
      config.trunkBase
    );
    yield* configService.save(config);
    yield* ensureGitignore;

    return config;
  });
}

/** Append the new Revis local-state paths to `.gitignore` when missing. */
export const ensureGitignore: Effect.Effect<void, StorageError, FileSystem.FileSystem | ProjectPaths> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* ProjectPaths;
    const gitignorePath = `${paths.root}/.gitignore`;

    const existing = yield* fs.readFileString(gitignorePath).pipe(
      Effect.catchTag("SystemError", (error) =>
        error.reason === "NotFound" ? Effect.succeed("") : Effect.fail(error)
      ),
      Effect.mapError((error) =>
        StorageError.make({
          path: gitignorePath,
          message: error.message
        })
      )
    );

    const lines = [
      "# Revis runtime state stays local.",
      ".revis/state/",
      ".revis/journal/",
      ".revis/archive/",
      ".revis/workspaces/",
      ".revis/coordination.git/"
    ];
    const missing = lines.filter((line) => !existing.includes(line));

    if (missing.length === 0) {
      return;
    }

    const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
    yield* fs.writeFileString(gitignorePath, `${existing}${prefix}${missing.join("\n")}\n`).pipe(
      Effect.mapError((error) =>
        StorageError.make({
          path: gitignorePath,
          message: error.message
        })
      )
    );
  });
