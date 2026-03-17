/** Layer composition for the long-lived daemon process. */

import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as PlatformFileSystem from "@effect/platform/FileSystem";
import type * as PlatformPath from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { hostGitLayer, HostGit } from "../git/host-git";
import { workspaceProviderLayer } from "../providers/select";
import { WorkspaceProvider } from "../providers/contract";
import { eventJournalLayer, EventJournal } from "../services/event-journal";
import { ProjectConfig, projectConfigLayer } from "../services/project-config";
import { ProjectPaths, projectPathsLayer } from "../services/project-paths";
import { workspaceStoreLayer, WorkspaceStore } from "../services/workspace-store";

export type DaemonAppServices =
  | EventJournal
  | HostGit
  | ProjectConfig
  | ProjectPaths
  | WorkspaceProvider
  | WorkspaceStore;

/** Build the live app layer used by the daemon subprocess. */
export function daemonLayer(root: string): Layer.Layer<
  DaemonAppServices,
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

  return Layer.mergeAll(foundationLayer, providerLayer);
}
