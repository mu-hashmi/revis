/** Workspace provisioning and runtime snapshot helpers. */

import { runInteractive } from "../core/process";
import type { RevisConfig, WorkspaceRecord } from "../core/models";
import { isoNow } from "../core/time";
import {
  writeActivitySnapshot,
} from "./runtime";
import { loadRuntimeStore } from "./runtime-access";
import {
  createWorkspaceProvider,
  createWorkspaceProviderForKind,
  type WorkspaceProvider
} from "./provider";
import {
  deriveOperatorSlug,
  remoteUrl,
  syncTargetBranch,
  workspaceBranch
} from "./repo";

/** Allocate the next available agent ids, reusing gaps left by stopped workspaces. */
export async function allocateAgentIds(
  root: string,
  count: number,
  _config: RevisConfig
): Promise<string[]> {
  const runtime = await loadRuntimeStore(root);
  const used = new Set(
    (await runtime.loadWorkspaceRecords()).flatMap((record) => {
      const match = /^agent-(\d+)$/.exec(record.agentId);
      return match ? [Number(match[1])] : [];
    })
  );

  const agentIds: string[] = [];
  for (let value = 1; agentIds.length < count; value += 1) {
    if (used.has(value)) {
      continue;
    }

    agentIds.push(`agent-${value}`);
  }

  return agentIds;
}

/** Create `count` new workspaces and return their runtime records. */
export async function createWorkspaces(
  root: string,
  config: RevisConfig,
  count: number,
  execCommand: string
): Promise<WorkspaceRecord[]> {
  const provider = createWorkspaceProvider(config);
  const remoteName = config.coordinationRemote;
  const remoteUrlValue = await remoteUrl(root, remoteName);
  const operatorSlug = await deriveOperatorSlug(root);
  const syncBranch = syncTargetBranch(remoteName, config.trunkBase);
  const agentIds = await allocateAgentIds(root, count, config);
  const runtime = await loadRuntimeStore(root);

  await runtime.ensureLiveSession({
    coordinationRemote: config.coordinationRemote,
    trunkBase: config.trunkBase,
    operatorSlug
  });

  const created: WorkspaceRecord[] = [];
  for (const agentId of agentIds) {
    const coordinationBranch = workspaceBranch(operatorSlug, agentId);
    const provisioned = await provider.createWorkspace({
      root,
      remoteName,
      remoteUrl: remoteUrlValue,
      syncBranch,
      operatorSlug,
      agentId,
      coordinationBranch,
      execCommand
    });

    const record: WorkspaceRecord = {
      agentId,
      operatorSlug,
      coordinationBranch,
      localBranch: provisioned.localBranch,
      workspaceRoot: provisioned.workspaceRoot,
      execCommand,
      sandboxProvider: provider.kind,
      state: "starting",
      createdAt: isoNow(),
      iteration: 0,
      lastCommitSha: provisioned.lastCommitSha,
      lastSeenRemoteSha: provisioned.lastCommitSha,
      lastRebasedOntoSha: provisioned.lastCommitSha,
      ...(provisioned.attachCmd ? { attachCmd: provisioned.attachCmd } : {}),
      ...(provisioned.attachLabel ? { attachLabel: provisioned.attachLabel } : {}),
      ...(provisioned.sandboxId ? { sandboxId: provisioned.sandboxId } : {})
    };

    await runtime.writeWorkspaceRecord(record);
    await runtime.appendEvent({
      timestamp: isoNow(),
      type: "workspace_created",
      agentId: record.agentId,
      branch: record.coordinationBranch,
      summary: `Created ${record.agentId} on ${record.coordinationBranch}`
    });
    created.push(record);
  }

  await runtime.registerSessionParticipants(created);
  return created;
}

/** Stop workspace sessions, delete clones/sandboxes, and clear runtime state. */
export async function stopWorkspaces(
  root: string,
  records: WorkspaceRecord[]
): Promise<void> {
  const runtime = await loadRuntimeStore(root);

  for (const record of records) {
    await createWorkspaceProviderForKind(record.sandboxProvider).stopWorkspace(record);
    record.state = "stopped";
    record.lastExitedAt = isoNow();
    delete record.currentSessionId;

    await runtime.writeWorkspaceRecord(record);
    await runtime.appendEvent({
      timestamp: isoNow(),
      type: "workspace_stopped",
      agentId: record.agentId,
      branch: record.coordinationBranch,
      summary: `Stopped ${record.agentId}`
    });

    await runtime.markSessionParticipantStopped(record);
    await runtime.deleteWorkspaceRecord(record.agentId);
    await runtime.deleteActivitySnapshot(record.agentId);
  }
}

/** Refresh activity snapshots for a workspace set. */
export async function refreshWorkspaceSnapshots(
  root: string,
  records: WorkspaceRecord[]
): Promise<WorkspaceRecord[]> {
  for (const record of records) {
    await captureWorkspaceActivity(root, record);
  }

  return records;
}

/** Capture recent terminal output for a workspace. */
export async function captureWorkspaceActivity(
  root: string,
  record: WorkspaceRecord,
  provider?: WorkspaceProvider
): Promise<string[]> {
  const lines = await (provider ?? createWorkspaceProviderForKind(record.sandboxProvider))
    .captureActivity(record);
  await writeActivitySnapshot(root, record.agentId, lines);
  return lines;
}

/** Attach the current terminal to one workspace session. */
export async function attachWorkspace(record: WorkspaceRecord): Promise<void> {
  if (!record.attachCmd) {
    return;
  }

  await runInteractive(record.attachCmd);
}
