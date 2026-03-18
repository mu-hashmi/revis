/** Fake `ProjectConfig` service backed by the orchestration model state. */

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProjectConfigApi } from "../../../src/services/project-config";
import type { OrchestrationState } from "./model";

/** Build the config service for one orchestration test harness. */
export function buildProjectConfigService(
  state: OrchestrationState
): ProjectConfigApi {
  return {
    exists: Effect.succeed(true),
    load: Ref.get(state.configRef),
    save: (nextConfig) =>
      Ref.set(state.configRef, nextConfig).pipe(Effect.as(state.paths.configFile))
  };
}
