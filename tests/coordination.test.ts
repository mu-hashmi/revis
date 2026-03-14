import { pathExists } from "../src/core/files";
import { daemonSocketPath } from "../src/core/ipc";
import { daemonSocketReady } from "../src/coordination/daemon";
import { loadWorkspaceRecords } from "../src/coordination/runtime";
import { loadStatusSnapshot } from "../src/coordination/status";
import { createWorkspaces, tmuxSessionExists } from "../src/coordination/workspaces";
import {
  cleanupRepo,
  commitWorkspaceChange,
  createCleanupStack,
  createRepo,
  createWorkspaceHarness,
  createSharedRemote,
  initializeRevis,
  startTestDaemon,
  waitFor
} from "./helpers";

describe("workspace coordination", () => {
  const cleanups = createCleanupStack();

  afterEach(cleanups.drain);

  test("creates namespaced branches, hooks, tmux sessions, and a daemon socket", async () => {
    const { daemon, root, workspaces } = await createWorkspaceHarness({
      count: 2,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    expect(workspaces.map((workspace) => workspace.branch)).toEqual([
      "revis/alice/agent-1/work",
      "revis/alice/agent-2/work"
    ]);
    expect(
      await pathExists(`${workspaces[0]!.repoPath}/.git/hooks/post-commit`)
    ).toBe(true);
    expect(await tmuxSessionExists(workspaces[0]!.tmuxSession)).toBe(true);
    expect(await daemonSocketReady(daemon!.socketPath)).toBe(true);
  });

  test("relays local post-commit updates to the other workspace", async () => {
    const { daemon, root, workspaces } = await createWorkspaceHarness({
      count: 2,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    const sha = await commitWorkspaceChange(
      workspaces[0]!.repoPath,
      "agent one update"
    );

    await waitFor(async () => {
      const records = await loadWorkspaceRecords(root);
      return (
        records
          .find((record) => record.agentId === "agent-2")
          ?.queuedSteeringMessages?.some(
            (line) =>
              line.includes(sha.slice(0, 8)) && line.includes("agent one update")
          ) ?? false
      );
    });

    const records = await loadWorkspaceRecords(root);
    expect(records.find((record) => record.agentId === "agent-1")?.lastRelayedSha).toBe(
      sha
    );
  });

  test("fetches and relays remote operator branches through the shared namespace", async () => {
    const { remotePath, aliceRoot, bobRoot } = await createSharedRemote(
      {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      },
      {
        userName: "Bob Example",
        userEmail: "bob@example.com"
      }
    );

    const aliceConfig = await initializeRevis(aliceRoot, 1);
    const bobConfig = await initializeRevis(bobRoot, 1);
    const aliceWorkspaces = await createWorkspaces(
      aliceRoot,
      aliceConfig,
      1,
      daemonSocketPath(aliceRoot)
    );
    await createWorkspaces(
      bobRoot,
      bobConfig,
      1,
      daemonSocketPath(bobRoot)
    );

    const aliceDaemon = await startTestDaemon(aliceRoot);
    const bobDaemon = await startTestDaemon(bobRoot);
    cleanups.add(async () => {
      await cleanupRepo(aliceRoot, aliceDaemon);
      await cleanupRepo(bobRoot, bobDaemon);
      await cleanupRepo(remotePath);
    });

    const sha = await commitWorkspaceChange(
      aliceWorkspaces[0]!.repoPath,
      "alice remote update"
    );

    await waitFor(async () => {
      const records = await loadWorkspaceRecords(bobRoot);
      return (
        records[0]?.queuedSteeringMessages?.some(
          (line) =>
            line.includes(sha.slice(0, 8)) && line.includes("alice/agent-1")
        ) ?? false
      );
    }, 12_000);
  });
});
