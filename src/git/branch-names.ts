/** Pure naming helpers for Revis coordination branches and refs. */

import type { AgentId, BranchName, OperatorSlug } from "../domain/models";
import { asBranchName, asOperatorSlug } from "../domain/models";

export const TRUNK_BRANCH = asBranchName("revis/trunk");

const REVIS_BRANCH_PATTERN = /^revis\/([^/]+)\/(agent-\d+)\/work$/;

/** Return whether coordination uses the local bare remote workflow. */
export function usesManagedTrunk(remoteName: string): boolean {
  return remoteName === "revis-local";
}

/** Return the branch each coordination mode syncs against. */
export function syncTargetBranch(remoteName: string, baseBranch: string): BranchName {
  return usesManagedTrunk(remoteName) ? TRUNK_BRANCH : asBranchName(baseBranch);
}

/** Return the stable coordination branch name for one workspace. */
export function workspaceBranch(operatorSlug: string, agentId: AgentId | string): BranchName {
  return asBranchName(`revis/${operatorSlug}/${agentId}/work`);
}

/** Parse a Revis workspace branch into operator and agent identifiers. */
export function parseWorkspaceBranch(
  branch: string
): { operatorSlug: OperatorSlug; agentId: AgentId } | null {
  const match = REVIS_BRANCH_PATTERN.exec(branch);
  if (!match) {
    return null;
  }

  return {
    operatorSlug: asOperatorSlug(match[1]!),
    agentId: match[2]! as AgentId
  };
}

/** Return the fetched remote-tracking ref for one branch. */
export function remoteTrackingRef(remoteName: string, branch: string): string {
  return `refs/remotes/${remoteName}/${branch}`;
}

/** Return a branch-safe email identity for one operator/agent workspace. */
export function workspaceEmail(operatorSlug: string, agentId: AgentId | string): string {
  return `${operatorSlug}+${agentId}@revis.local`;
}
