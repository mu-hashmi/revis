import { loadEvents, loadWorkspaceRecords } from "../src/coordination/runtime";
import { promoteWorkspace } from "../src/coordination/promotion";
import { createWorkspaces } from "../src/coordination/workspaces";
import { daemonSocketPath } from "../src/core/ipc";
import { runCommand } from "../src/core/process";
import { createFakeGh } from "./cli-helpers";
import {
  cleanupRepo,
  commitWorkspaceChange,
  createCleanupStack,
  createWorkspaceHarness,
  createSharedRemote,
  initializeRevis,
  waitFor
} from "./helpers";

describe("promotion flows", () => {
  const cleanups = createCleanupStack();

  afterEach(cleanups.drain);

  test("promote merges into managed trunk and rebases other clean workspaces", async () => {
    const { config, daemon, root, workspaces } = await createWorkspaceHarness({
      count: 2,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    await commitWorkspaceChange(workspaces[0]!.repoPath, "agent one update");
    await waitFor(async () => {
      const records = await loadWorkspaceRecords(root);
      return (
        records
          .find((record) => record.agentId === "agent-2")
          ?.queuedSteeringMessages?.some((line) => line.includes("agent one update"))
          ?? false
      );
    });

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

    await waitFor(async () => {
      const records = await loadWorkspaceRecords(root);
      return (
        records.find((record) => record.agentId === "agent-2")?.lastRebasedOntoSha ===
        trunkSha
      );
    });

    await waitFor(async () => {
      const events = await loadEvents(root);
      return events.some(
        (event) =>
          event.type === "workspace_rebased" &&
          event.agentId === "agent-2" &&
          event.summary.includes(trunkSha.slice(0, 8))
      );
    });
  });

  test("dirty workspaces are marked pending when trunk advances", async () => {
    const { config, daemon, root, workspaces } = await createWorkspaceHarness({
      count: 2,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    await runCommand(["sh", "-lc", "printf 'dirty\\n' >> README.md"], {
      cwd: workspaces[1]!.repoPath
    });
    await commitWorkspaceChange(workspaces[0]!.repoPath, "promote dirty pending");
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

    await waitFor(async () => {
      const records = await loadWorkspaceRecords(root);
      return (
        records.find((record) => record.agentId === "agent-2")?.rebaseRequiredSha ===
        trunkSha
      );
    });

    const records = await loadWorkspaceRecords(root);
    expect(
      records
        .find((record) => record.agentId === "agent-2")
        ?.queuedSteeringMessages?.some((line) => line.includes("rebase is pending"))
    ).toBe(true);
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
      daemonSocketPath(aliceRoot)
    );
    cleanups.add(async () => {
      await cleanupRepo(aliceRoot);
      await cleanupRepo(bobRoot);
      await cleanupRepo(remotePath);
    });

    await commitWorkspaceChange(workspaces[0]!.repoPath, "open remote pr");
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
