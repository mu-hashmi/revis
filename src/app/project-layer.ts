/** Layer composition for operator-facing Revis commands. */

import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as PlatformFileSystem from "@effect/platform/FileSystem";
import type * as PlatformPath from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DaemonControl, daemonControlLayer } from "../daemon/control";
import { hostGitLayer, HostGit, type HostGitError } from "../git/host-git";
import { PromotionService, promotionServiceLayer } from "../promotion/service";
import { workspaceProviderLayer } from "../providers/select";
import { WorkspaceProvider } from "../providers/contract";
import { eventJournalLayer, EventJournal } from "../services/event-journal";
import { ProjectConfig, projectConfigLayer } from "../services/project-config";
import { ProjectPaths, projectPathsLayer } from "../services/project-paths";
import { workspaceStoreLayer, WorkspaceStore } from "../services/workspace-store";

export type ProjectBootstrapServices = HostGit | ProjectConfig | ProjectPaths;

export type ProjectAppServices =
  | DaemonControl
  | EventJournal
  | HostGit
  | ProjectConfig
  | ProjectPaths
  | PromotionService
  | WorkspaceProvider
  | WorkspaceStore;

/** Build the minimal layer needed before `.revis/config.json` exists. */
export function projectBootstrapLayer(root: string): Layer.Layer<
  ProjectBootstrapServices,
  unknown,
  CommandExecutor.CommandExecutor | PlatformFileSystem.FileSystem | PlatformPath.Path
> {
  const pathsLayer = projectPathsLayer(root);

  return Layer.mergeAll(
    pathsLayer,
    hostGitLayer,
    projectConfigLayer.pipe(Layer.provide(pathsLayer))
  );
}

/** Build the live app layer used by operator-facing commands. */
export function projectLayer(root: string): Layer.Layer<
  ProjectAppServices,
  unknown,
  CommandExecutor.CommandExecutor | PlatformFileSystem.FileSystem | PlatformPath.Path
> {
  const pathsLayer = projectPathsLayer(root);
  const configLayer = projectConfigLayer.pipe(Layer.provide(pathsLayer));
  const storeLayer = workspaceStoreLayer.pipe(Layer.provide(pathsLayer));
  const journalLayer = eventJournalLayer.pipe(Layer.provide(pathsLayer));
  const foundationLayer = Layer.mergeAll(
    pathsLayer,
    hostGitLayer,
    configLayer,
    storeLayer,
    journalLayer
  );
  const providerLayer = Layer.unwrapEffect(
    ProjectConfig.pipe(
      Effect.flatMap((service) => service.load),
      Effect.map((config) => workspaceProviderLayer(config.sandboxProvider)),
      Effect.provide(foundationLayer)
    )
  ).pipe(Layer.provide(foundationLayer));
  const promotionLayer = promotionServiceLayer.pipe(
    Layer.provide(Layer.merge(foundationLayer, providerLayer))
  );
  const daemonLayer = daemonControlLayer.pipe(Layer.provide(foundationLayer));

  return Layer.mergeAll(foundationLayer, providerLayer, promotionLayer, daemonLayer);
}

/** Resolve the repository root for the current working directory. */
export function resolveProjectRoot(cwd: string): Effect.Effect<string, HostGitError, HostGit> {
  return Effect.gen(function* () {
    const hostGit = yield* HostGit;
    return yield* hostGit.resolveRepoRoot(cwd);
  });
}
