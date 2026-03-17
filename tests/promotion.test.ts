import { loadEvents, loadWorkspaceRecords } from "../src/coordination/runtime";
import { notifyDaemon } from "../src/coordination/daemon";
import { promoteWorkspace } from "../src/coordination/promotion";
import { createWorkspaces } from "../src/coordination/workspaces";
import { runCommand } from "../src/core/process";
import { createFakeGh } from "./cli-helpers";
import {
  cleanupRepo,
  commitWorkspaceChange,
  createCleanupStack,
  createSharedRemote,
  createWorkspaceHarness,
  exitWorkspaceSession,
  initializeRevis,
  killWorkspaceSession,
  waitFor,
  waitForWorkspaceRecord
} from "./helpers";

const LONG_RUNNING_EXEC = "sleep 30";

describe("promotion flows", () => {
  const cleanups = createCleanupStack();

  afterEach(cleanups.drain);

  test("promote merges into managed trunk and rebases clean siblings before restart", async () => {
    const { config, daemon, root, workspaces } = await createWorkspaceHarness({
      count: 2,
      execCommand: LONG_RUNNING_EXEC,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    const sibling = await waitForWorkspaceRecord(
      root,
      "agent-2",
      (record) => record.iteration === 1 && record.state === "active"
    );

    await commitWorkspaceChange(workspaces[0]!.workspaceRoot, "agent one update");

    const result = await promoteWorkspace(root, config, "agent-1");
    expect(result.mode).toBe("local");

    const trunkSha = (
      await runCommand([
        "git",
        "--git-dir",
        `${root}/.revis/coordination.git`,
        "rev-parse",
        "revis/trunk"
      ])
    ).stdout.trim();

    await killWorkspaceSession(sibling);

    await waitForWorkspaceRecord(
      root,
      "agent-2",
      (record) =>
        record.iteration >= 2 &&
        record.state === "active" &&
        record.lastRebasedOntoSha === trunkSha &&
        record.currentSessionId !== undefined,
      15_000
    );

    await waitFor(async () => {
      const events = await loadEvents(root);
      return events.some(
        (event) =>
          event.type === "workspace_rebased" &&
          event.agentId === "agent-2" &&
          event.summary.includes(trunkSha.slice(0, 8))
      );
    }, 15_000);
  });

  test("dirty workspaces are blocked until they are cleaned and reconciled", async () => {
    const { config, daemon, root, workspaces } = await createWorkspaceHarness({
      count: 2,
      execCommand: LONG_RUNNING_EXEC,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    const sibling = await waitForWorkspaceRecord(
      root,
      "agent-2",
      (record) => record.iteration === 1 && record.state === "active"
    );

    await runCommand(["sh", "-lc", "printf 'dirty\\n' >> README.md"], {
      cwd: workspaces[1]!.workspaceRoot
    });
    await commitWorkspaceChange(workspaces[0]!.workspaceRoot, "promote dirty pending");
    await promoteWorkspace(root, config, "agent-1");

    const trunkSha = (
      await runCommand([
        "git",
        "--git-dir",
        `${root}/.revis/coordination.git`,
        "rev-parse",
        "revis/trunk"
      ])
    ).stdout.trim();

    await exitWorkspaceSession(sibling);

    const blocked = await waitForWorkspaceRecord(
      root,
      "agent-2",
      (record) =>
        record.state === "failed" &&
        record.iteration === 1 &&
        record.rebaseRequiredSha === trunkSha &&
        record.currentSessionId === undefined,
      15_000
    );

    expect(blocked.lastError).toBeUndefined();

    await waitFor(async () => {
      const events = await loadEvents(root);
      return events.some(
        (event) =>
          event.type === "workspace_rebase_pending" && event.agentId === "agent-2"
      );
    }, 15_000);

    await runCommand(["git", "checkout", "--", "README.md"], {
      cwd: workspaces[1]!.workspaceRoot
    });
    await notifyDaemon(root, {
      type: "reconcile",
      reason: "manual-clean"
    });

    await waitForWorkspaceRecord(
      root,
      "agent-2",
      (record) =>
        record.iteration >= 2 &&
        record.state === "active" &&
        record.lastRebasedOntoSha === trunkSha &&
        record.rebaseRequiredSha === undefined &&
        record.currentSessionId !== undefined,
      15_000
    );
  });

  test("reuses GitHub pull requests for remote-backed promotion", async () => {
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
    const config = await initializeRevis(aliceRoot);
    const workspaces = await createWorkspaces(
      aliceRoot,
      config,
      1,
      LONG_RUNNING_EXEC
    );
    cleanups.add(async () => {
      await cleanupRepo(aliceRoot);
      await cleanupRepo(bobRoot);
      await cleanupRepo(remotePath);
    });

    await commitWorkspaceChange(workspaces[0]!.workspaceRoot, "open remote pr");
    await runCommand(
      ["git", "remote", "set-url", "origin", "https://github.com/example/revis.git"],
      {
        cwd: aliceRoot
      }
    );
    await runCommand(
      ["git", "remote", "set-url", "--push", "origin", remotePath],
      {
        cwd: aliceRoot
      }
    );

    const { binDir, statePath } = await createFakeGh(aliceRoot);
    const originalPath = process.env.PATH;
    const originalToken = process.env.GH_TOKEN;
    const originalState = process.env.REVIS_GH_STATE;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    process.env.REVIS_GH_STATE = statePath;

    try {
      const first = await promoteWorkspace(aliceRoot, config, "agent-1");
      const second = await promoteWorkspace(aliceRoot, config, "agent-1");

      expect(first.mode).toBe("pull_request");
      expect(first.pullRequest?.created).toBe(true);
      expect(second.pullRequest?.created).toBe(false);
      expect(second.pullRequest?.number).toBe(first.pullRequest?.number);
    } finally {
      process.env.PATH = originalPath;
      process.env.GH_TOKEN = originalToken;
      process.env.REVIS_GH_STATE = originalState;
    }
  });
});
