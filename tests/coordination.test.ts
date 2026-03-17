import { join } from "node:path";

import { pathExists } from "../src/core/files";
import { runCommand } from "../src/core/process";
import { daemonSocketReady, notifyDaemon } from "../src/coordination/daemon";
import { createWorkspaces, stopWorkspaces } from "../src/coordination/workspaces";
import { loadEvents } from "../src/coordination/runtime";
import {
  cleanupRepo,
  commitWorkspaceChange,
  createCleanupStack,
  createSharedRemote,
  createWorkspaceHarness,
  exitWorkspaceSession,
  initializeRevis,
  killWorkspaceSession,
  readText,
  requireWorkspaceRecord,
  startTestDaemon,
  waitFor,
  waitForWorkspaceRecord
} from "./helpers";

const LONG_RUNNING_EXEC = "sleep 30";
const STARTUP_REMOTE_SHA_FILE = ".startup-remote-sha";
const BOB_REMOTE_PROBE_EXEC = [
  `git rev-parse --verify --quiet origin/revis/alice/agent-1/work > ${STARTUP_REMOTE_SHA_FILE} 2>/dev/null || true`,
  "sleep 30"
].join("; ");

describe("workspace coordination", () => {
  const cleanups = createCleanupStack();

  afterEach(cleanups.drain);

  test("creates namespaced branches, persists exec commands, and starts iteration 1", async () => {
    const { daemon, root, workspaces } = await createWorkspaceHarness({
      count: 2,
      execCommand: LONG_RUNNING_EXEC,
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
    expect(workspaces.map((workspace) => workspace.execCommand)).toEqual([
      LONG_RUNNING_EXEC,
      LONG_RUNNING_EXEC
    ]);

    const record = await waitForWorkspaceRecord(
      root,
      "agent-1",
      (workspace) =>
        workspace.iteration === 1 &&
        workspace.state === "active" &&
        workspace.currentSessionId !== undefined
    );

    expect(record.execCommand).toBe(LONG_RUNNING_EXEC);
    expect(await pathExists(join(record.workspaceRoot, "..", "session.log"))).toBe(true);
    expect(await daemonSocketReady(daemon!.socketPath)).toBe(true);
  });

  test(
    "normal session exit pushes HEAD and starts the next iteration",
    async () => {
    const { daemon, root, workspaces } = await createWorkspaceHarness({
      count: 1,
      execCommand: LONG_RUNNING_EXEC,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    const initial = await waitForWorkspaceRecord(
      root,
      "agent-1",
      (workspace) => workspace.iteration === 1 && workspace.state === "active"
    );
    const sha = await commitWorkspaceChange(workspaces[0]!.workspaceRoot, "normal exit push");

    await exitWorkspaceSession(initial);

    const restarted = await waitForWorkspaceRecord(
      root,
      "agent-1",
      (workspace) =>
        workspace.iteration >= 2 &&
        workspace.state === "active" &&
        workspace.lastPushedSha === sha &&
        workspace.lastExitedAt !== undefined &&
        workspace.currentSessionId !== undefined &&
        workspace.currentSessionId !== initial.currentSessionId,
      15_000
    );

    expect(restarted.lastCommitSha).toBe(sha);

    const events = await loadEvents(root);
    expect(events.some((event) => event.type === "iteration_exited")).toBe(true);
    expect(
      events.some((event) => event.type === "branch_pushed" && event.sha === sha)
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "workspace_restarted" && event.agentId === "agent-1"
      )
    ).toBe(true);
    },
    15_000
  );

  test(
    "externally killed sessions follow the same push and restart path",
    async () => {
    const { daemon, root, workspaces } = await createWorkspaceHarness({
      count: 1,
      execCommand: LONG_RUNNING_EXEC,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    const initial = await waitForWorkspaceRecord(
      root,
      "agent-1",
      (workspace) => workspace.iteration === 1 && workspace.state === "active"
    );
    const sha = await commitWorkspaceChange(workspaces[0]!.workspaceRoot, "killed session push");

    await killWorkspaceSession(initial);

    const restarted = await waitForWorkspaceRecord(
      root,
      "agent-1",
      (workspace) =>
        workspace.iteration >= 2 &&
        workspace.state === "active" &&
        workspace.lastPushedSha === sha &&
        workspace.lastExitedAt !== undefined &&
        workspace.currentSessionId !== undefined &&
        workspace.currentSessionId !== initial.currentSessionId,
      15_000
    );

    expect(restarted.lastExitCode).toBeUndefined();
    },
    15_000
  );

  test("keeps publishing through the stable coordination branch after a local branch switch", async () => {
    const { daemon, root, workspaces } = await createWorkspaceHarness({
      count: 1,
      execCommand: LONG_RUNNING_EXEC,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    const initial = await waitForWorkspaceRecord(
      root,
      "agent-1",
      (workspace) => workspace.iteration === 1 && workspace.state === "active"
    );

    await runCommand(["git", "checkout", "-b", "autoresearch/mar14"], {
      cwd: workspaces[0]!.workspaceRoot
    });
    const sha = await commitWorkspaceChange(
      workspaces[0]!.workspaceRoot,
      "switched local branch"
    );

    await killWorkspaceSession(initial);

    const record = await waitForWorkspaceRecord(
      root,
      "agent-1",
      (workspace) =>
        workspace.iteration >= 2 &&
        workspace.localBranch === "autoresearch/mar14" &&
        workspace.lastPushedSha === sha,
      15_000
    );

    const coordinationHead = (
      await runCommand([
        "git",
        "--git-dir",
        `${root}/.revis/coordination.git`,
        "rev-parse",
        record.coordinationBranch
      ])
    ).stdout.trim();

    expect(coordinationHead).toBe(sha);
  });

  test(
    "reused agent ids replace stale remote coordination refs",
    async () => {
      const { config, daemon, root, workspaces } = await createWorkspaceHarness({
        count: 1,
        execCommand: LONG_RUNNING_EXEC,
        user: {
          userName: "Alice Example",
          userEmail: "alice@example.com"
        }
      });
      cleanups.add(() => cleanupRepo(root, daemon));

      const initial = await waitForWorkspaceRecord(
        root,
        "agent-1",
        (workspace) => workspace.iteration === 1 && workspace.state === "active"
      );
      const firstSha = await commitWorkspaceChange(
        workspaces[0]!.workspaceRoot,
        "initial coordination publish"
      );

      await exitWorkspaceSession(initial);
      const published = await waitForWorkspaceRecord(
        root,
        "agent-1",
        (workspace) =>
          workspace.iteration >= 2 &&
          workspace.state === "active" &&
          workspace.lastPushedSha === firstSha,
        15_000
      );

      await stopWorkspaces(root, [published]);

      const replacement = await createWorkspaces(root, config, 1, LONG_RUNNING_EXEC);
      expect(replacement[0]!.agentId).toBe("agent-1");

      await notifyDaemon(root, {
        type: "reconcile",
        reason: "test-reused-agent"
      });

      const restarted = await waitForWorkspaceRecord(
        root,
        "agent-1",
        (workspace) => workspace.iteration === 1 && workspace.state === "active",
        15_000
      );
      const secondSha = await commitWorkspaceChange(
        replacement[0]!.workspaceRoot,
        "replacement coordination publish"
      );

      await exitWorkspaceSession(restarted);

      const replacementRecord = await waitForWorkspaceRecord(
        root,
        "agent-1",
        (workspace) =>
          workspace.iteration >= 2 &&
          workspace.state === "active" &&
          workspace.lastPushedSha === secondSha,
        15_000
      );

      expect(replacementRecord.lastPushedSha).toBe(secondSha);

      const coordinationHead = (
        await runCommand([
          "git",
          "--git-dir",
          `${root}/.revis/coordination.git`,
          "rev-parse",
          replacementRecord.coordinationBranch
        ])
      ).stdout.trim();

      expect(coordinationHead).toBe(secondSha);
    },
    20_000
  );

  test(
    "fetches other operators' refs before starting the next iteration",
    async () => {
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
        LONG_RUNNING_EXEC
      );
      const bobWorkspaces = await createWorkspaces(
        bobRoot,
        bobConfig,
        1,
        BOB_REMOTE_PROBE_EXEC
      );

      const aliceDaemon = await startTestDaemon(aliceRoot);
      const bobDaemon = await startTestDaemon(bobRoot);
      cleanups.add(async () => {
        await cleanupRepo(aliceRoot, aliceDaemon);
        await cleanupRepo(bobRoot, bobDaemon);
        await cleanupRepo(remotePath);
      });

      const aliceInitial = await waitForWorkspaceRecord(
        aliceRoot,
        "agent-1",
        (workspace) => workspace.iteration === 1 && workspace.state === "active"
      );
      const bobInitial = await waitForWorkspaceRecord(
        bobRoot,
        "agent-1",
        (workspace) => workspace.iteration === 1 && workspace.state === "active"
      );

      const aliceSha = await commitWorkspaceChange(
        aliceWorkspaces[0]!.workspaceRoot,
        "alice remote update"
      );
      await killWorkspaceSession(aliceInitial);

      await waitForWorkspaceRecord(
        aliceRoot,
        "agent-1",
        (workspace) =>
          workspace.iteration >= 2 && workspace.lastPushedSha === aliceSha,
        15_000
      );

      await killWorkspaceSession(bobInitial);

      await waitForWorkspaceRecord(
        bobRoot,
        "agent-1",
        (workspace) => workspace.iteration >= 2 && workspace.state === "active",
        15_000
      );

      const startupShaPath = join(
        bobWorkspaces[0]!.workspaceRoot,
        STARTUP_REMOTE_SHA_FILE
      );
      await waitFor(
        async () => (await pathExists(startupShaPath)) && (await readText(startupShaPath)).trim() === aliceSha,
        15_000
      );
    },
    20_000
  );

  test(
    "daemon startup baselines existing remote refs before iteration 1 starts",
    async () => {
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
        LONG_RUNNING_EXEC
      );
      await createWorkspaces(
        bobRoot,
        bobConfig,
        1,
        BOB_REMOTE_PROBE_EXEC
      );

      const aliceDaemon = await startTestDaemon(aliceRoot);
      let bobDaemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
      cleanups.add(async () => {
        await cleanupRepo(aliceRoot, aliceDaemon);
        await cleanupRepo(bobRoot, bobDaemon);
        await cleanupRepo(remotePath);
      });

      const aliceInitial = await waitForWorkspaceRecord(
        aliceRoot,
        "agent-1",
        (workspace) => workspace.iteration === 1 && workspace.state === "active"
      );
      const aliceSha = await commitWorkspaceChange(
        aliceWorkspaces[0]!.workspaceRoot,
        "alice startup baseline"
      );
      await killWorkspaceSession(aliceInitial);

      await waitForWorkspaceRecord(
        aliceRoot,
        "agent-1",
        (workspace) =>
          workspace.iteration >= 2 && workspace.lastPushedSha === aliceSha,
        15_000
      );

      await waitFor(async () => {
        const result = await runCommand(
          ["git", "ls-remote", "--heads", "origin", "revis/alice/agent-1/work"],
          { cwd: bobRoot, check: false }
        );
        return result.exitCode === 0 && result.stdout.includes(aliceSha);
      }, 15_000);

      bobDaemon = await startTestDaemon(bobRoot);

      const bobRecord = await waitForWorkspaceRecord(
        bobRoot,
        "agent-1",
        (workspace) => workspace.iteration === 1 && workspace.state === "active",
        15_000
      );
      const startupShaPath = join(bobRecord.workspaceRoot, STARTUP_REMOTE_SHA_FILE);
      await waitFor(
        async () => (await pathExists(startupShaPath)) && (await readText(startupShaPath)).trim() === aliceSha,
        15_000
      );

      expect(await requireWorkspaceRecord(bobRoot, "agent-1")).toMatchObject({
        iteration: 1,
        state: "active"
      });
      expect((await loadEvents(bobRoot)).some((event) => event.type === "workspace_restarted")).toBe(false);
    },
    20_000
  );
});
