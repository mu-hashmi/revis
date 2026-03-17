/** Workspace state transition helpers used by daemon supervision. */

import {
  AwaitingRebaseState,
  ProviderFailedState,
  ProvisioningState,
  RebaseConflictState,
  RestartPendingState,
  RunningState,
  StoppedState,
  WorkspaceSnapshot,
  type Revision,
  type Timestamp,
  type WorkspaceState
} from "../domain/models";

interface TrackingOverrides {
  readonly iteration?: number;
  readonly lastCommitSha?: Revision;
  readonly lastPushedSha?: Revision;
  readonly lastSeenRemoteSha?: Revision;
  readonly lastRebasedOntoSha?: Revision;
  readonly lastExitCode?: number;
  readonly lastExitedAt?: Timestamp;
}

/** Extract reusable tracking fields from one workspace state. */
export function trackingFields(
  snapshot: WorkspaceSnapshot,
  overrides: TrackingOverrides = {}
) {
  const state = snapshot.state;

  return compact({
    iteration: overrides.iteration ?? state.iteration,
    lastCommitSha: overrides.lastCommitSha ?? state.lastCommitSha,
    lastPushedSha: overrides.lastPushedSha ?? state.lastPushedSha,
    lastSeenRemoteSha: overrides.lastSeenRemoteSha ?? state.lastSeenRemoteSha,
    lastRebasedOntoSha: overrides.lastRebasedOntoSha ?? state.lastRebasedOntoSha,
    lastExitCode: overrides.lastExitCode ?? state.lastExitCode,
    lastExitedAt: overrides.lastExitedAt ?? state.lastExitedAt
  });
}

/** Rebuild one workspace snapshot with updated tracking fields. */
export function withTracking(
  snapshot: WorkspaceSnapshot,
  overrides: TrackingOverrides
): WorkspaceSnapshot {
  const state = snapshot.state;

  switch (state._tag) {
    case "Provisioning":
      return withState(snapshot, ProvisioningState.make(trackingFields(snapshot, overrides)));
    case "Running":
      return withState(
        snapshot,
        RunningState.make({
          ...trackingFields(snapshot, overrides),
          sessionId: state.sessionId,
          startedAt: state.startedAt
        })
      );
    case "RestartPending":
      return withState(snapshot, RestartPendingState.make(trackingFields(snapshot, overrides)));
    case "AwaitingRebase":
      return withState(
        snapshot,
        AwaitingRebaseState.make({
          ...trackingFields(snapshot, overrides),
          requiredTarget: state.requiredTarget,
          detail: state.detail
        })
      );
    case "RebaseConflict":
      return withState(
        snapshot,
        RebaseConflictState.make({
          ...trackingFields(snapshot, overrides),
          requiredTarget: state.requiredTarget,
          detail: state.detail
        })
      );
    case "ProviderFailed":
      return withState(
        snapshot,
        ProviderFailedState.make({
          ...trackingFields(snapshot, overrides),
          detail: state.detail
        })
      );
    case "Stopped":
      return withState(snapshot, StoppedState.make(trackingFields(snapshot, overrides)));
  }
}

/** Replace the state union inside one snapshot. */
export function withState(snapshot: WorkspaceSnapshot, state: WorkspaceState): WorkspaceSnapshot {
  return WorkspaceSnapshot.make({
    spec: snapshot.spec,
    state
  });
}

/** Return a best-effort tag name for operator-facing diagnostics. */
export function errorTag(error: unknown): string {
  if (typeof error === "object" && error && "_tag" in error) {
    return String((error as { readonly _tag: string })._tag);
  }

  return "UnknownError";
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}
