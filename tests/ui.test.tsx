import { pathExists } from "../src/core/files";
import { runCommand } from "../src/core/process";
import { loadWorkspaceRecords } from "../src/coordination/runtime";
import { promoteWorkspace } from "../src/coordination/promotion";
import { runCli } from "./cli-helpers";
import {
  cleanupRepo,
  commitWorkspaceChange,
  createCleanupStack,
  createRepo,
  createWorkspaceHarness,
  initializeRevis,
  killWorkspaceSession,
  readText,
  waitFor,
  waitForWorkspaceRecord,
  workspaceProcessAlive
} from "./helpers";

const LONG_RUNNING_EXEC = "sleep 30";

describe("operator status and spawn", () => {
  const cleanups = createCleanupStack();

  afterEach(cleanups.drain);

  test("status prints the daemon and workspace overview", async () => {
    const { daemon, root } = await createWorkspaceHarness({
      count: 1,
      execCommand: LONG_RUNNING_EXEC,
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
    expect(result.stdout).toContain("[active]");
    expect(result.stdout).not.toContain("ATTACH");
  });

  test("spawn requires --exec", async () => {
    const root = await createRepo({
      userName: "Alice Example",
      userEmail: "alice@example.com"
    });
    await initializeRevis(root);
    cleanups.add(() => cleanupRepo(root));

    await expect(runCli(root, ["spawn", "1"])).rejects.toThrow(
      "required option '--exec <command>' not specified"
    );
  });

  test("spawn creates workspaces and persists the iteration command", async () => {
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
      "printf 'hello-from-exec\\n'; sleep 30"
    ]);

    expect(result.stdout).toContain("agent-1 registered");

    const workspace = await waitForWorkspaceRecord(
      root,
      "agent-1",
      (record) => record.iteration === 1 && record.state === "active",
      15_000
    );
    expect(workspace.coordinationBranch).toBe("revis/alice/agent-1/work");
    expect(workspace.execCommand).toBe("printf 'hello-from-exec\\n'; sleep 30");

    await waitFor(async () => {
      return (
        (await readText(workspace.attachLabel!)).includes("hello-from-exec")
      );
    }, 15_000);
  });

  test(
    "status reports failed when the next iteration is blocked by a dirty rebase",
    async () => {
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
      await commitWorkspaceChange(workspaces[0]!.workspaceRoot, "status blocked");
      await promoteWorkspace(root, config, "agent-1");
      await killWorkspaceSession(sibling);

      await waitForWorkspaceRecord(
        root,
        "agent-2",
        (record) => record.state === "failed",
        15_000
      );

      const result = await runCli(root, ["status"]);
      expect(result.stdout).toContain("agent-2");
      expect(result.stdout).toContain("[failed]");
    },
    20_000
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

      await runCli(root, ["spawn", "2", "--exec", LONG_RUNNING_EXEC]);
      const workspaces = await Promise.all([
        waitForWorkspaceRecord(
          root,
          "agent-1",
          (record) => record.iteration === 1 && record.state === "active",
          15_000
        ),
        waitForWorkspaceRecord(
          root,
          "agent-2",
          (record) => record.iteration === 1 && record.state === "active",
          15_000
        )
      ]);
      expect(workspaces).toHaveLength(2);

      const firstPid = workspaces[0]!.currentSessionId;
      const secondPid = workspaces[1]!.currentSessionId;
      if (!firstPid || !secondPid) {
        throw new Error("Missing local process metadata");
      }

      const result = await runCli(root, ["stop", "agent-1"]);
      expect(result.stdout).toContain("Stopped agent-1");
      expect(workspaceProcessAlive(firstPid)).toBe(false);
      expect(
        (
          await waitForWorkspaceRecord(
            root,
            "agent-2",
            (record) => record.state === "active" && record.currentSessionId !== undefined,
            15_000
          )
        ).agentId
      ).toBe("agent-2");
      expect(workspaceProcessAlive(secondPid)).toBe(true);
      expect((await loadWorkspaceRecords(root)).map((record) => record.agentId)).toEqual([
        "agent-2"
      ]);
    },
    15_000
  );

  test(
    "stop --all tears down headless sessions and runtime state",
    async () => {
      const root = await createRepo({
        userName: "Alice Example",
        userEmail: "alice@example.com"
      });
      await initializeRevis(root);
      cleanups.add(() => cleanupRepo(root));

      await runCli(root, ["spawn", "1", "--exec", LONG_RUNNING_EXEC]);
      const workspace = await waitForWorkspaceRecord(
        root,
        "agent-1",
        (record) => record.iteration === 1 && record.state === "active",
        15_000
      );
      if (!workspace.currentSessionId) {
        throw new Error("Missing local process metadata");
      }

      expect(workspaceProcessAlive(workspace.currentSessionId)).toBe(true);

      const result = await runCli(root, ["stop", "--all"]);
      expect(result.stdout).toContain("Stopped 1 workspaces");
      expect(workspaceProcessAlive(workspace.currentSessionId)).toBe(false);
      expect(await pathExists(`${root}/.revis/runtime`)).toBe(false);
    },
    15_000
  );
});
