/** Commander application wiring for the Revis CLI. */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Command } from "commander";

import { loadConfig } from "../core/config";
import { RevisError } from "../core/error";
import type { WorkspaceRecord } from "../core/models";
import { runDashboardServer } from "../coordination/dashboard";
import { runDaemonProcess } from "../coordination/daemon";
import { promoteWorkspace } from "../coordination/promotion";
import { resolveRepoRoot } from "../coordination/repo";
import { initializeProject } from "../coordination/setup";
import { loadStatusSnapshot } from "../coordination/status";
import {
  prepareWorkspaceBatch,
  stopWorkspace,
  stopWorkspaceBatch
} from "../coordination/workspace-batch";
import { formatStatusTable } from "./status-presenter";

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
      "Passive distributed workspace coordination for tmux-backed agent sessions."
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
    writeOut(`Next: revis spawn 1 or revis spawn 1 --exec '<command>'\n`);
  });

  program
    .command("spawn")
    .description("Create isolated workspaces, start the daemon, and optionally run a command.")
    .argument("<count>", "number of workspaces to create")
    .option("--exec <command>", "shell command to run in each workspace")
    .action(async (countText: string, options: { exec?: string }) => {
      await runBatchCommand(parseCount(countText), options.exec, writeOut);
    });

  program.command("status").description("Show daemon and workspace status.").action(async () => {
    const { root } = await loadCommandContext();
    const snapshot = await loadStatusSnapshot(root, {
      refresh: true
    });

    if (snapshot.workspaces.length === 0) {
      writeOut("no workspaces\n");
      return;
    }

    for (const line of formatStatusTable(snapshot.workspaces)) {
      writeOut(`${line}\n`);
    }
  });

  program
    .command("dashboard")
    .description("Launch the local Revis dashboard.")
    .option("--port <port>", "bind to a specific localhost port")
    .option("--no-open", "do not open the dashboard in a browser")
    .action(async (options: { open?: boolean; port?: string }) => {
      const root = await requireInitializedRoot(process.cwd());
      await runDashboardServer(root, {
        noOpen: options.open === false,
        stderr: writeErr,
        stdout: writeOut,
        ...(options.port ? { port: parsePort(options.port) } : {})
      });
    });

  program
    .command("promote")
    .description("Promote one workspace.")
    .argument("<agent-id>", "workspace identifier")
    .action(async (agentId: string) => {
      const { config, root } = await loadCommandContext();
      const result = await promoteWorkspace(root, config, agentId);
      writeOut(`${result.summary}\n`);
      if (result.pullRequest) {
        writeOut(`${result.pullRequest.url}\n`);
      }
    });

  program
    .command("stop")
    .description("Stop one workspace or every workspace plus the daemon.")
    .argument("[agent-id]", "workspace identifier")
    .option("--all", "stop every workspace and the daemon")
    .action(async (agentId: string | undefined, options: { all?: boolean }) => {
      const root = await resolveRepoRoot(process.cwd());

      if (options.all) {
        if (agentId) {
          throw new RevisError("Use either `revis stop --all` or `revis stop <agent-id>`.");
        }

        writeOut(`Stopped ${await stopWorkspaceBatch(root)} workspaces\n`);
        return;
      }

      if (!agentId) {
        throw new RevisError(
          "Specify a workspace: run `revis stop --all` to stop everything or `revis stop <agent-id>` to stop one workspace."
        );
      }

      await stopWorkspace(root, agentId);
      writeOut(`Stopped ${agentId}\n`);
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

/** Parse one TCP port from the command line. */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RevisError(`Expected a TCP port between 0 and 65535, got: ${value}`);
  }

  return port;
}

/** Create a workspace batch and print the resulting sessions. */
async function runBatchCommand(
  count: number,
  execCommand: string | undefined,
  writeOut: (text: string) => void
): Promise<void> {
  const { config, root } = await loadCommandContext();
  const created = await prepareWorkspaceBatch(root, config, {
    count,
    ...(execCommand ? { execCommand } : {})
  });

  for (const workspace of created) {
    writeOut(`${formatBatchResult(workspace, execCommand)}\n`);
  }

  if (execCommand) {
    writeOut(
      "NOTE: the launched agent may still need confirmation before it begins working. Run `revis status` to confirm.\n"
    );
  }
}

/** Read the package version from the repository root. */
async function packageVersion(): Promise<string> {
  const path = new URL("../../package.json", import.meta.url);
  const payload = JSON.parse(await readFile(path, "utf8")) as { version: string };
  return payload.version;
}

/** Format one workspace line for the `spawn` command. */
function formatBatchResult(
  workspace: WorkspaceRecord,
  execCommand: string | undefined
): string {
  const prefix = execCommand
    ? `${workspace.agentId} launched`
    : `${workspace.agentId} ${workspace.coordinationBranch}`;
  return `${prefix} local=${workspace.localBranch} ${workspace.attachCmd.join(" ")}`;
}
