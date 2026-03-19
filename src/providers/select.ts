/** Provider layer selection for the configured sandbox runtime. */

import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as PlatformFileSystem from "@effect/platform/FileSystem";
import * as Layer from "effect/Layer";

import type { SandboxProvider } from "../domain/models";
import type { ProjectPaths } from "../services/project-paths";
import type { HostGit } from "../git/host-git";
import { daytonaWorkspaceProviderLayer } from "./daytona";
import { localWorkspaceProviderLayer } from "./local";
import { WorkspaceProvider } from "./contract";

/** Select the concrete workspace provider layer for the project's configured runtime. */
export function workspaceProviderLayer(
  kind: SandboxProvider
): Layer.Layer<
  WorkspaceProvider,
  never,
  HostGit | ProjectPaths | CommandExecutor.CommandExecutor | PlatformFileSystem.FileSystem
> {
  switch (kind) {
    case "local":
      return localWorkspaceProviderLayer;
    case "daytona":
      return daytonaWorkspaceProviderLayer;
  }
}
