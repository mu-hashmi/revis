/** Operator-only promotion service that delegates to concrete promotion flows. */

import * as CommandExecutor from "@effect/platform/CommandExecutor";
import { FileSystem } from "@effect/platform";
import * as PlatformPath from "@effect/platform/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ConfigError, StorageError, ValidationError } from "../domain/errors";
import { Promoted, PullRequestRef, type WorkspaceSnapshot } from "../domain/models";
import { pushWorkspaceHead, type WorkspaceGitError } from "../git/workspace-ops";
import type { HostGitError } from "../git/host-git";
import { HostGit } from "../git/host-git";
import { isoNow } from "../platform/time";
import { WorkspaceProvider } from "../providers/contract";
import { EventJournal } from "../services/event-journal";
import { ProjectConfig } from "../services/project-config";
import { ProjectPaths } from "../services/project-paths";
import { WorkspaceStore, type WorkspaceStoreApi } from "../services/workspace-store";
import { promoteManagedWorkspace, type ManagedTrunkPromotionError } from "./managed-trunk";
import { promotePullRequestWorkspace, type PullRequestPromotionError } from "./pull-request";
import { usesManagedTrunk } from "../git/branch-names";

export interface PromotionResult {
  readonly mode: "local" | "pull_request";
  readonly summary: string;
  readonly pullRequest?: PullRequestRef;
}

export type PromotionError =
  | ConfigError
  | HostGitError
  | ManagedTrunkPromotionError
  | PullRequestPromotionError
  | StorageError
  | ValidationError
  | WorkspaceGitError;

export interface PromotionServiceApi {
  readonly promoteWorkspace: (agentId: string) => Effect.Effect<PromotionResult, PromotionError>;
}

/** Operator-only service that promotes one tracked workspace through the configured flow. */
export class PromotionService extends Context.Tag("@revis/PromotionService")<
  PromotionService,
  PromotionServiceApi
>() {}

export const promotionServiceLayer = Layer.effect(
  PromotionService,
  Effect.gen(function* () {
    const configService = yield* ProjectConfig;
    const eventJournal = yield* EventJournal;
    const executor = yield* CommandExecutor.CommandExecutor;
    const fs = yield* FileSystem.FileSystem;
    const hostGit = yield* HostGit;
    const path = yield* PlatformPath.Path;
    const paths = yield* ProjectPaths;
    const provider = yield* WorkspaceProvider;
    const store = yield* WorkspaceStore;

    const promoteWorkspace = Effect.fn("PromotionService.promoteWorkspace")(function* (
      agentId: string
    ) {
      // Load the promotion target and current project policy.
      const config = yield* configService.load;
      const snapshot = yield* requirePromotionWorkspace(store, agentId);

      // Always publish the latest workspace HEAD before choosing a promotion path so managed trunk
      // and pull-request flows operate on the same remote-visible branch state.
      yield* pushWorkspaceHead(provider, snapshot, config.coordinationRemote);

      let result: PromotionResult;
      if (usesManagedTrunk(config.coordinationRemote)) {
        result = yield* promoteManagedWorkspace(
          paths.root,
          config,
          snapshot,
          hostGit,
          executor,
          fs,
          path
        );
      } else {
        result = yield* promotePullRequestWorkspace(
          paths.root,
          config,
          snapshot,
          hostGit,
          provider,
          executor
        );
      }

      yield* eventJournal.append(
        Promoted.make({
          timestamp: isoNow(),
          agentId: snapshot.agentId,
          branch: snapshot.spec.coordinationBranch,
          mode: result.mode,
          summary: result.summary
        })
      );

      return result;
    });

    return PromotionService.of({
      promoteWorkspace
    });
  })
);

/** Resolve one existing workspace or fail with an operator-facing validation error. */
function requirePromotionWorkspace(
  store: WorkspaceStoreApi,
  agentId: string
): Effect.Effect<WorkspaceSnapshot, ValidationError | StorageError> {
  return store.get(agentId).pipe(
    Effect.flatMap((snapshot) =>
      Option.match(snapshot, {
        onNone: () => Effect.fail(ValidationError.make({ message: `Unknown workspace ${agentId}` })),
        onSome: Effect.succeed
      })
    )
  );
}
