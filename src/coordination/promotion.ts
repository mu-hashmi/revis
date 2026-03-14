/** Operator-only promotion orchestration. */

import type { PullRequestRef, RevisConfig } from "../core/models";
import { RevisError } from "../core/error";
import { isoNow } from "../core/time";
import { appendEvent, loadWorkspaceRecord } from "./runtime";
import {
  TRUNK_BRANCH,
  pushBranch,
  usesManagedTrunk,
  deriveOperatorSlug,
  workspaceBranch
} from "./repo";
import { ensureDaemonRunning, notifyDaemon } from "./daemon";
import { createOrReusePullRequest } from "./promotion-github";
import { latestCommitSubject } from "./promotion-git";
import { mergeIntoManagedTrunk } from "./promotion-local";

export interface PromotionResult {
  mode: "local" | "pull_request";
  summary: string;
  pullRequest?: PullRequestRef;
}

interface PromotionTarget {
  agentId: string;
  coordinationBranch: string;
  repoPath: string;
}

/** Promote one owned workspace branch. */
export async function promoteWorkspace(
  root: string,
  config: RevisConfig,
  agentId: string
): Promise<PromotionResult> {
  const target = await loadPromotionTarget(root, agentId);
  await pushBranch(
    target.repoPath,
    config.coordinationRemote,
    "HEAD",
    target.coordinationBranch
  );

  if (usesManagedTrunk(config.coordinationRemote)) {
    return promoteManagedWorkspace(root, config, target);
  }

  return promotePullRequestWorkspace(root, config, target);
}

/** Load and validate the owned workspace that is being promoted. */
async function loadPromotionTarget(
  root: string,
  agentId: string
): Promise<PromotionTarget> {
  const operatorSlug = await deriveOperatorSlug(root);
  const branch = workspaceBranch(operatorSlug, agentId);
  const workspace = await loadWorkspaceRecord(root, agentId);
  if (!workspace) {
    throw new RevisError(`Unknown workspace ${agentId}`);
  }

  if (workspace.coordinationBranch !== branch) {
    throw new RevisError(
      `Workspace ${agentId} belongs to ${workspace.operatorSlug}, not ${operatorSlug}`
    );
  }

  return {
    agentId,
    coordinationBranch: branch,
    repoPath: workspace.repoPath
  };
}

/** Merge one owned branch into the local managed trunk and wake the daemon. */
async function promoteManagedWorkspace(
  root: string,
  config: RevisConfig,
  target: PromotionTarget
): Promise<PromotionResult> {
  const summary = await mergeIntoManagedTrunk(
    root,
    config.coordinationRemote,
    target.coordinationBranch
  );
  await appendPromotedEvent(
    root,
    target,
    `Promoted ${target.coordinationBranch} into ${TRUNK_BRANCH}`
  );
  await ensureDaemonRunning(root);
  await notifyDaemon(root, {
    type: "sync",
    reason: "promote"
  });
  return {
    mode: "local",
    summary
  };
}

/** Open or reuse a pull request for one owned workspace branch. */
async function promotePullRequestWorkspace(
  root: string,
  config: RevisConfig,
  target: PromotionTarget
): Promise<PromotionResult> {
  const pr = await createOrReusePullRequest(
    root,
    config,
    target.coordinationBranch,
    config.trunkBase,
    await latestCommitSubject(target.repoPath)
  );
  await appendPromotedEvent(
    root,
    target,
    `${pr.created ? "Opened" : "Reused"} PR #${pr.number} for ${target.coordinationBranch}`
  );
  return {
    mode: "pull_request",
    summary: pr.created
      ? `Opened PR #${pr.number} ${pr.url}`
      : `Reused PR #${pr.number} ${pr.url}`,
    pullRequest: pr
  };
}

/** Append one operator-facing promotion event for the chosen workspace. */
async function appendPromotedEvent(
  root: string,
  target: PromotionTarget,
  summary: string
): Promise<void> {
  await appendEvent(root, {
    timestamp: isoNow(),
    type: "promoted",
    agentId: target.agentId,
    branch: target.coordinationBranch,
    summary
  });
}
