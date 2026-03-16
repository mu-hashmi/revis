import { pathExists } from "../src/core/files";
import { runCommand } from "../src/core/process";
import { loadWorkspaceRecords } from "../src/coordination/runtime";
import { tmuxSessionExists } from "../src/coordination/workspaces";
import { runCli } from "./cli-helpers";
import {
  cleanupRepo,
  createCleanupStack,
  createRepo,
  createWorkspaceHarness,
  initializeRevis,
  waitFor
} from "./helpers";

describe("operator status and spawn", () => {
  const cleanups = createCleanupStack();

  afterEach(cleanups.drain);

  test("status prints the daemon and workspace overview", async () => {
    const { daemon, root } = await createWorkspaceHarness({
      count: 1,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    const result = await runCli(root, ["status"]);
    expect(result.stdout).toContain("AGENT");
    expect(result.stdout).toContain("STATE");
    expect(result.stdout).toContain("COMMITS");
    expect(result.stdout).toContain("LAST COMMIT");
    expect(result.stdout).toContain("agent-1");
    expect(result.stdout).toContain("[idle]");
    expect(result.stdout).not.toContain("ATTACH");
  });

  test("spawn creates workspaces and can run a supplied command", async () => {
    const root = await createRepo({
      userName: "Alice Example",
      userEmail: "alice@example.com"
    });
    await initializeRevis(root);
    cleanups.add(() => cleanupRepo(root));

    const result = await runCli(root, [
      "spawn",
      "1",
      "--exec",
      "printf 'hello-from-exec\\n'"
    ]);

    expect(result.stdout).toContain("agent-1 launched");
    expect(result.stdout).toContain(
      "NOTE: the launched agent may still need confirmation before it begins working. Run `revis status` to confirm."
    );

    await waitFor(async () => (await loadWorkspaceRecords(root)).length === 1);
    const [workspace] = await loadWorkspaceRecords(root);
    expect(workspace?.coordinationBranch).toBe("revis/alice/agent-1/work");

    await waitFor(async () => {
      const pane = await runCommand([
        "tmux",
        "capture-pane",
        "-t",
        `${workspace!.tmuxSession}:0`,
        "-p"
      ]);
      return pane.stdout.includes("hello-from-exec");
    });
  });

  test(
    "status reports active when a launched command is still running under the pane shell",
    async () => {
      const root = await createRepo({
        userName: "Alice Example",
        userEmail: "alice@example.com"
      });
    await initializeRevis(root);
    cleanups.add(() => cleanupRepo(root));

    await runCli(root, ["spawn", "1", "--exec", "sleep 30"]);

    await waitFor(async () => {
      const result = await runCli(root, ["status"]);
      return result.stdout.includes("agent-1") && result.stdout.includes("[active]");
    });
    },
    15_000
  );

  test("stop errors without a target", async () => {
    const root = await createRepo({
      userName: "Alice Example",
      userEmail: "alice@example.com"
    });
    await initializeRevis(root);
    cleanups.add(() => cleanupRepo(root));

    await expect(runCli(root, ["stop"])).rejects.toThrow(
      "Specify a workspace: run `revis stop --all` to stop everything or `revis stop <agent-id>` to stop one workspace."
    );
  });

  test(
    "stop can tear down one workspace without stopping the others",
    async () => {
      const root = await createRepo({
        userName: "Alice Example",
        userEmail: "alice@example.com"
      });
      await initializeRevis(root);
      cleanups.add(() => cleanupRepo(root));

      await runCli(root, ["spawn", "2"]);
      const workspaces = await loadWorkspaceRecords(root);
      expect(workspaces).toHaveLength(2);

      const result = await runCli(root, ["stop", "agent-1"]);
      expect(result.stdout).toContain("Stopped agent-1");
      expect(await tmuxSessionExists(workspaces[0]!.tmuxSession)).toBe(false);
      expect(await tmuxSessionExists(workspaces[1]!.tmuxSession)).toBe(true);
      expect((await loadWorkspaceRecords(root)).map((record) => record.agentId)).toEqual([
        "agent-2"
      ]);
    },
    15_000
  );

  test(
    "stop --all tears down tmux sessions and runtime state",
    async () => {
      const root = await createRepo({
        userName: "Alice Example",
        userEmail: "alice@example.com"
      });
      await initializeRevis(root);
      cleanups.add(() => cleanupRepo(root));

      await runCli(root, ["spawn", "1"]);
      const [workspace] = await loadWorkspaceRecords(root);

      expect(await tmuxSessionExists(workspace!.tmuxSession)).toBe(true);

      const result = await runCli(root, ["stop", "--all"]);
      expect(result.stdout).toContain("Stopped 1 workspaces");
      expect(await tmuxSessionExists(workspace!.tmuxSession)).toBe(false);
      expect(await pathExists(`${root}/.revis/runtime`)).toBe(false);
    },
    15_000
  );
});
