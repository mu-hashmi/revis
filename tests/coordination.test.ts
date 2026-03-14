import { pathExists } from "../src/core/files";
import { daemonSocketPath } from "../src/core/ipc";
import { runCommand } from "../src/core/process";
import { daemonSocketReady } from "../src/coordination/daemon";
import { loadWorkspaceRecords } from "../src/coordination/runtime";
import { createWorkspaces, tmuxSessionExists } from "../src/coordination/workspaces";
import {
  cleanupRepo,
  commitWorkspaceChange,
  createCleanupStack,
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

    expect(workspaces.map((workspace) => workspace.coordinationBranch)).toEqual([
      "revis/alice/agent-1/work",
      "revis/alice/agent-2/work"
    ]);
    expect(workspaces.map((workspace) => workspace.localBranch)).toEqual([
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

  test("daemon startup ignores commits that existed before it began running", async () => {
    const { root, workspaces } = await createWorkspaceHarness({
      count: 1,
      startDaemon: false,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });

    const oldSha = await commitWorkspaceChange(
      workspaces[0]!.repoPath,
      "commit before daemon start"
    );

    const daemon = await startTestDaemon(root);
    cleanups.add(() => cleanupRepo(root, daemon));

    const missingRef = await runCommand(
      [
        "git",
        "--git-dir",
        `${root}/.revis/coordination.git`,
        "rev-parse",
        "revis/alice/agent-1/work"
      ],
      { check: false }
    );
    expect(missingRef.exitCode).not.toBe(0);

    const newSha = await commitWorkspaceChange(
      workspaces[0]!.repoPath,
      "commit after daemon start"
    );

    await waitFor(async () => {
      const result = await runCommand(
        [
          "git",
          "--git-dir",
          `${root}/.revis/coordination.git`,
          "rev-parse",
          "revis/alice/agent-1/work"
        ],
        { check: false }
      );
      return result.exitCode === 0 && result.stdout.trim() === newSha;
    });

    const records = await loadWorkspaceRecords(root);
    expect(records[0]?.lastPushedSha).toBe(newSha);
    expect(records[0]?.lastCommitSha).toBe(newSha);
    expect(records[0]?.lastPushedSha).not.toBe(oldSha);
  });

  test("keeps relaying through the stable coordination branch after a local branch switch", async () => {
    const { daemon, root, workspaces } = await createWorkspaceHarness({
      count: 2,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    await runCommand(["git", "checkout", "-b", "autoresearch/mar14"], {
      cwd: workspaces[0]!.repoPath
    });

    const sha = await commitWorkspaceChange(
      workspaces[0]!.repoPath,
      "switched local branch"
    );

    await waitFor(async () => {
      const records = await loadWorkspaceRecords(root);
      return records.find((record) => record.agentId === "agent-1")?.localBranch
        === "autoresearch/mar14";
    });

    await waitFor(async () => {
      const records = await loadWorkspaceRecords(root);
      return (
        records
          .find((record) => record.agentId === "agent-2")
          ?.queuedSteeringMessages?.some(
            (line) =>
              line.includes(sha.slice(0, 8)) && line.includes("switched local branch")
          ) ?? false
      );
    });

    await waitFor(async () => {
      const coordinationHead = (
        await runCommand([
          "git",
          "--git-dir",
          `${root}/.revis/coordination.git`,
          "rev-parse",
          "revis/alice/agent-1/work"
        ])
      ).stdout.trim();
      return coordinationHead === sha;
    });
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

  test("daemon startup baselines existing remote heads instead of replaying them", async () => {
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
    let bobDaemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    cleanups.add(async () => {
      await cleanupRepo(aliceRoot, aliceDaemon);
      await cleanupRepo(bobRoot, bobDaemon);
      await cleanupRepo(remotePath);
    });

    const oldSha = await commitWorkspaceChange(
      aliceWorkspaces[0]!.repoPath,
      "alice old remote update"
    );

    await waitFor(async () => {
      const result = await runCommand(
        ["git", "ls-remote", "--heads", "origin", "revis/alice/agent-1/work"],
        { cwd: bobRoot, check: false }
      );
      return result.exitCode === 0 && result.stdout.includes(oldSha);
    });

    bobDaemon = await startTestDaemon(bobRoot);

    await waitFor(async () => {
      const records = await loadWorkspaceRecords(bobRoot);
      return records.length === 1;
    });

    const afterStartup = await loadWorkspaceRecords(bobRoot);
    expect(afterStartup[0]?.queuedSteeringMessages).toBeUndefined();

    const newSha = await commitWorkspaceChange(
      aliceWorkspaces[0]!.repoPath,
      "alice new remote update"
    );

    await waitFor(async () => {
      const records = await loadWorkspaceRecords(bobRoot);
      return (
        records[0]?.queuedSteeringMessages?.some(
          (line) =>
            line.includes(newSha.slice(0, 8)) && line.includes("alice/agent-1")
        ) ?? false
      );
    }, 12_000);
  });
});
