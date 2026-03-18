/** Backward-compatible re-export for the split orchestration harness modules. */

export { makeOrchestrationHarness } from "./orchestration/harness";
export type {
  HarnessOptions,
  OrchestrationControls,
  OrchestrationHarness,
  WorkspaceRuntimeState
} from "./orchestration/types";
