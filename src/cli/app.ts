/** Commander application wiring for the Revis CLI. */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Command } from "commander";

import { loadConfig } from "../core/config";
import { RevisError } from "../core/error";
import type { WorkspaceRecord } from "../core/models";
import { runDaemonProcess } from "../coordination/daemon";
import { promoteWorkspace } from "../coordination/promotion";
import { resolveRepoRoot } from "../coordination/repo";
import { initializeProject } from "../coordination/setup";
import { loadStatusSnapshot } from "../coordination/status";
import {
  prepareWorkspaceBatch,
  stopWorkspaceBatch
} from "../coordination/workspace-batch";
import {
  formatDaemonHealth,
  formatStatusContext,
  formatWorkspaceSummary
} from "./status-presenter";
import { runMonitor } from "./monitor-session";

export interface CliWriters {
  stderr?: (text: string) => void;
  stdout?: (text: string) => void;
}

interface CommandContext {
  config: Awaited<ReturnType<typeof loadConfig>>;
  root: string;
}

/** Build the Revis Commander application. */
export function buildCli(io: CliWriters = {}): Command {
  const program = new Command();
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));

  program
    .name("revis")
    .description(
      "Passive distributed workspace coordination for tmux-backed Codex sessions."
    )
    .configureOutput({
      writeErr,
      writeOut
    })
    .showHelpAfterError();

  program.command("init").description("Set up Revis in the current repository.").action(async () => {
    const root = await resolveRepoRoot(process.cwd());
    const config = await initializeProject(root);

    writeOut(`Initialized Revis in ${root}\n`);
    writeOut(`Remote: ${config.coordinationRemote}\n`);
    writeOut(`Base branch: ${config.trunkBase}\n`);
    writeOut(`Daemon poll seconds: ${config.remotePollSeconds}\n`);
  });

  program
    .command("workspace")
    .description("Create isolated workspaces and start the daemon.")
    .argument("<count>", "number of workspaces to create")
    .action(async (countText: string) => {
      await runBatchCommand(parseCount(countText), false, writeOut);
    });

  program
    .command("spawn")
    .description("Create workspaces and launch Codex in each one.")
    .requiredOption("--codex <count>", "number of Codex workspaces to launch")
    .action(async (options: { codex: string }) => {
      await runBatchCommand(parseCount(options.codex), true, writeOut);
    });

  program.command("status").description("Show daemon and workspace status.").action(async () => {
    const { root } = await loadCommandContext();
    const snapshot = await loadStatusSnapshot(root, {
      refresh: true
    });

    writeOut(`${formatDaemonHealth(snapshot)}\n`);
    writeOut(`${formatStatusContext(snapshot)}\n`);

    if (snapshot.workspaces.length === 0) {
      writeOut("no workspaces\n");
      return;
    }

    for (const workspace of snapshot.workspaces) {
      const activity = snapshot.activity[workspace.agentId]!;
      const activityLine = activity.at(-1) ?? "";
      writeOut(
        formatStatusWorkspaceLine(workspace, activityLine) + "\n"
      );
    }
  });

  program.command("monitor").description("Open the live Ink monitor.").action(async () => {
    const { root } = await loadCommandContext();
    await runMonitor(root);
  });

  program
    .command("promote")
    .description("Promote one workspace branch.")
    .argument("<agent-id>", "workspace identifier")
    .action(async (agentId: string) => {
      const { config, root } = await loadCommandContext();
      const result = await promoteWorkspace(root, config, agentId);
      writeOut(`${result.summary}\n`);
      if (result.pullRequest) {
        writeOut(`${result.pullRequest.url}\n`);
      }
    });

  program.command("stop").description("Stop the daemon and tear down workspaces.").action(async () => {
    const root = await resolveRepoRoot(process.cwd());
    writeOut(`Stopped ${await stopWorkspaceBatch(root)} workspaces\n`);
  });

  program.command("version").description("Print the installed Revis version.").action(async () => {
    writeOut(`${await packageVersion()}\n`);
  });

  program
    .command("_daemon-run", { hidden: true })
    .description("Internal daemon entrypoint.")
    .argument("[root]", "repository root")
    .option("--root <root>", "repository root")
    .action(async (rootArgument: string | undefined, options: { root?: string }) => {
      const root = resolve(options.root ?? rootArgument ?? process.cwd());
      await runDaemonProcess(root);
    });

  return program;
}

/** Resolve the repository root and require that Revis is initialized there. */
async function requireInitializedRoot(cwd: string): Promise<string> {
  return resolveRepoRoot(cwd);
}

/** Load the initialized repository root plus its persisted config. */
async function loadCommandContext(): Promise<CommandContext> {
  const root = await requireInitializedRoot(process.cwd());
  return {
    config: await loadConfig(root),
    root
  };
}

/** Parse a positive integer CLI argument. */
function parseCount(value: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) {
    throw new RevisError(`Expected a positive integer, got: ${value}`);
  }

  return count;
}

/** Create or spawn a workspace batch and print the resulting sessions. */
async function runBatchCommand(
  count: number,
  launchCodex: boolean,
  writeOut: (text: string) => void
): Promise<void> {
  const { config, root } = await loadCommandContext();
  const created = await prepareWorkspaceBatch(root, config, {
    count,
    launchCodex
  });

  for (const workspace of created) {
    writeOut(`${formatBatchResult(workspace, launchCodex)}\n`);
  }
}

/** Read the package version from the repository root. */
async function packageVersion(): Promise<string> {
  const path = new URL("../../package.json", import.meta.url);
  const payload = JSON.parse(await readFile(path, "utf8")) as { version: string };
  return payload.version;
}

/** Format one CLI status line for a workspace plus its operator-only extras. */
function formatStatusWorkspaceLine(
  workspace: WorkspaceRecord,
  activityLine: string
): string {
  const extras = [`attach=${workspace.attachCmd.join(" ")}`];
  if (activityLine) {
    extras.push(`activity=${activityLine}`);
  }

  return `${formatWorkspaceSummary(workspace)} | ${extras.join(" | ")}`;
}

/** Format one workspace line for the `workspace` and `spawn` commands. */
function formatBatchResult(
  workspace: WorkspaceRecord,
  launchCodex: boolean
): string {
  const prefix = launchCodex
    ? `${workspace.agentId} launched`
    : `${workspace.agentId} ${workspace.branch}`;
  return `${prefix} ${workspace.attachCmd.join(" ")}`;
}
