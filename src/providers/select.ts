/** Provider layer selection for the configured sandbox runtime. */

import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Layer from "effect/Layer";

import type { SandboxProvider } from "../domain/models";
import type { ProjectPaths } from "../services/project-paths";
import type { HostGit } from "../git/host-git";
import { daytonaWorkspaceProviderLayer } from "./daytona";
import { localWorkspaceProviderLayer } from "./local";
import { WorkspaceProvider } from "./contract";

export function workspaceProviderLayer(
  kind: SandboxProvider
): Layer.Layer<WorkspaceProvider, never, HostGit | ProjectPaths | CommandExecutor.CommandExecutor> {
  switch (kind) {
    case "local":
      return localWorkspaceProviderLayer;
    case "daytona":
      return daytonaWorkspaceProviderLayer;
  }
}
