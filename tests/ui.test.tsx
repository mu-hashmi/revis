import React from "react";
import { render } from "ink-testing-library";

import { MonitorApp } from "../src/cli/monitor";
import { pathExists } from "../src/core/files";
import { tmuxSessionExists } from "../src/coordination/workspaces";
import { runCli } from "./cli-helpers";
import {
  cleanupRepo,
  createCleanupStack,
  createWorkspaceHarness,
  waitFor
} from "./helpers";

describe("operator status and monitor", () => {
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
    expect(result.stdout).toContain("daemon up");
    expect(result.stdout).toContain("agent-1");
    expect(result.stdout).toContain("revis/alice/agent-1/work");
  });

  test("monitor renders workspace state and exits on q", async () => {
    const { daemon, root } = await createWorkspaceHarness({
      count: 1,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root, daemon));

    let exitAction = "";
    const app = render(
      <MonitorApp
        root={root}
        onExit={(exit) => {
          exitAction = exit.action;
        }}
      />
    );

    await waitFor(async () => (app.lastFrame() ?? "").includes("agent-1"));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Workspaces");
    expect(frame).toContain("agent-1");

    app.stdin.write("q");
    await waitFor(async () => exitAction === "quit");
    app.unmount();
  });

  test("stop tears down tmux sessions and runtime state", async () => {
    const { root, workspaces } = await createWorkspaceHarness({
      count: 1,
      startDaemon: false,
      user: {
        userName: "Alice Example",
        userEmail: "alice@example.com"
      }
    });
    cleanups.add(() => cleanupRepo(root));

    expect(await tmuxSessionExists(workspaces[0]!.tmuxSession)).toBe(true);

    const result = await runCli(root, ["stop"]);
    expect(result.stdout).toContain("Stopped 1 workspaces");
    expect(await tmuxSessionExists(workspaces[0]!.tmuxSession)).toBe(false);
    expect(await pathExists(`${root}/.revis/runtime`)).toBe(false);
  });
});
