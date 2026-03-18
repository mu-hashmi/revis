/** Composition entrypoint for the split in-memory orchestration harness. */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { EventJournal } from "../../../src/services/event-journal";
import { HostGit } from "../../../src/git/host-git";
import { ProjectConfig } from "../../../src/services/project-config";
import { ProjectPaths } from "../../../src/services/project-paths";
import { WorkspaceProvider } from "../../../src/providers/contract";
import { WorkspaceStore } from "../../../src/services/workspace-store";
import { buildOrchestrationControls } from "./controls";
import { buildEventJournalService } from "./event-journal";
import { buildHostGitService } from "./host-git";
import { createOrchestrationState } from "./model";
import { buildProjectConfigService } from "./project-config";
import type { HarnessOptions, OrchestrationHarness } from "./types";
import { buildWorkspaceProviderService } from "./workspace-provider";
import { buildWorkspaceStoreService } from "./workspace-store";

/** Build one fresh in-memory harness for orchestration and workflow tests. */
export function makeOrchestrationHarness(
  options: HarnessOptions = {}
): Effect.Effect<OrchestrationHarness, never, never> {
  return Effect.gen(function* () {
    const state = yield* createOrchestrationState(options);

    // Keep composition here thin so the service-specific modules own behavior and this file just
    // wires the fake services into the same tags as the production runtime.
    return {
      controls: buildOrchestrationControls(state),
      layer: Layer.mergeAll(
        Layer.succeed(ProjectPaths, state.paths),
        Layer.succeed(ProjectConfig, buildProjectConfigService(state)),
        Layer.succeed(WorkspaceStore, buildWorkspaceStoreService(state)),
        Layer.succeed(EventJournal, buildEventJournalService(state)),
        Layer.succeed(HostGit, buildHostGitService(state)),
        Layer.succeed(WorkspaceProvider, buildWorkspaceProviderService(state))
      ),
      paths: state.paths,
      syncBranch: state.syncBranch
    };
  });
}
