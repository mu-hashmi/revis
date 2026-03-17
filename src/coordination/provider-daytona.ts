/** Daytona-backed headless workspace provider. */

import { posix as pathPosix } from "node:path";

import { Daytona, type Sandbox } from "@daytonaio/sdk";

import type { WorkspaceRecord } from "../core/models";
import { RevisError } from "../core/error";
import { shellJoin, type CompletedCommand } from "../core/process";
import { sha256Text } from "../core/text";
import { workspaceEmail } from "./repo";
import type {
  CreateWorkspaceParams,
  CreatedWorkspaceState,
  WorkspaceCommandOptions,
  WorkspaceProvider,
  WorkspaceSessionStatus
} from "./provider";

const ACTIVITY_LINE_LIMIT = 200;
const TERM_ENV = {
  LANG: "en_US.UTF-8",
  TERM: "xterm-256color"
} as const;

/** Build the Daytona workspace provider. */
export function createDaytonaWorkspaceProvider(): WorkspaceProvider {
  let daytona: Daytona | undefined;

  return {
    kind: "daytona",

    async createWorkspace(params: CreateWorkspaceParams): Promise<CreatedWorkspaceState> {
      assertRemoteUrlSupported(params.remoteUrl);

      const sandbox = await getDaytona().create({
        name: `revis-${params.operatorSlug}-${params.agentId}`,
        labels: daytonaWorkspaceLabels(
          params.root,
          params.operatorSlug,
          params.agentId
        ),
        autoStopInterval: 0,
        autoDeleteInterval: -1,
        ephemeral: false
      });

      await sandbox.setAutostopInterval(0);

      const workDir = await requireSandboxWorkspaceRoot(sandbox);
      const workspaceRoot = pathPosix.join(workDir, "revis", params.agentId, "repo");
      const parentDir = pathPosix.dirname(workspaceRoot);

      await sandbox.process.executeCommand(
        shellJoin(["mkdir", "-p", parentDir]),
        undefined,
        undefined,
        0
      );
      await sandbox.git.clone(params.remoteUrl, workspaceRoot, params.syncBranch);
      await sandbox.process.executeCommand(
        shellJoin([
          "git",
          "checkout",
          "-B",
          params.coordinationBranch,
          `${params.remoteName}/${params.syncBranch}`
        ]),
        workspaceRoot,
        undefined,
        0
      );
      await sandbox.process.executeCommand(
        shellJoin(["git", "config", "user.name", `${params.operatorSlug}-${params.agentId}`]),
        workspaceRoot,
        undefined,
        0
      );
      await sandbox.process.executeCommand(
        shellJoin([
          "git",
          "config",
          "user.email",
          workspaceEmail(params.operatorSlug, params.agentId)
        ]),
        workspaceRoot,
        undefined,
        0
      );

      return {
        workspaceRoot,
        localBranch: await sandboxCurrentBranch(sandbox, workspaceRoot),
        lastCommitSha: await sandboxHeadSha(sandbox, workspaceRoot),
        attachLabel: `daytona:${sandbox.id}`,
        sandboxId: sandbox.id
      };
    },

    async startSession(record: WorkspaceRecord): Promise<string> {
      const sandbox = await getSandbox(record);
      await sandbox.start(60);

      const sessionId = `${record.agentId}-iter-${record.iteration + 1}-${Date.now()}`;
      await sandbox.process.createSession(sessionId);
      await sandbox.process.executeSessionCommand(
        sessionId,
        {
          command: shellJoin([
            "env",
            ...daytonaTermEnv(),
            "sh",
            "-lc",
            `cd ${shellJoin([record.workspaceRoot])} && exec ${record.execCommand}`
          ]),
          runAsync: true
        },
        0
      );

      return sessionId;
    },

    async inspectSession(record: WorkspaceRecord): Promise<WorkspaceSessionStatus> {
      if (!record.currentSessionId) {
        return { phase: "missing" };
      }

      const command = await latestSessionCommand(record);

      if (command.exitCode === undefined) {
        return { phase: "running" };
      }

      return {
        phase: "exited",
        exitCode: command.exitCode
      };
    },

    async captureActivity(record: WorkspaceRecord): Promise<string[]> {
      if (!record.currentSessionId) {
        return [];
      }

      const sandbox = await getSandbox(record);
      const command = await latestSessionCommand(record);

      const logs = await sandbox.process.getSessionCommandLogs(
        record.currentSessionId,
        command.id
      );

      return `${logs.stdout ?? ""}${logs.stderr ?? ""}`
        .replaceAll("\r", "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-ACTIVITY_LINE_LIMIT);
    },

    async runCommand(
      record: WorkspaceRecord,
      argv: string[],
      options: WorkspaceCommandOptions = {}
    ): Promise<CompletedCommand> {
      const sandbox = await getSandbox(record);
      const response = await sandbox.process.executeCommand(
        shellJoin(argv),
        options.cwd ?? record.workspaceRoot,
        nodeEnvToStringMap(options.env),
        0
      );

      const completed = {
        stdout: response.result,
        stderr: "",
        exitCode: response.exitCode
      };
      if ((options.check ?? true) && completed.exitCode !== 0) {
        throw new RevisError(completed.stdout.trim() || "command failed");
      }

      return completed;
    },

    async stopWorkspace(record: WorkspaceRecord): Promise<void> {
      const sandbox = await getSandbox(record);
      if (record.currentSessionId) {
        await sandbox.process.deleteSession(record.currentSessionId);
      }

      await sandbox.delete();
    }
  };

  async function getSandbox(record: WorkspaceRecord): Promise<Sandbox> {
    if (!record.sandboxId) {
      throw new RevisError(`Missing Daytona sandbox metadata for ${record.agentId}`);
    }

    return getDaytona().get(record.sandboxId);
  }

  function getDaytona(): Daytona {
    if (!daytona) {
      daytona = new Daytona();
    }

    return daytona;
  }

  /** Return the most recent command entry for one Daytona session. */
  async function latestSessionCommand(
    record: WorkspaceRecord
  ): Promise<{ id: string; exitCode?: number }> {
    const sandbox = await getSandbox(record);
    const session = await sandbox.process.getSession(record.currentSessionId!);
    const command = session.commands?.at(-1);
    if (!command) {
      throw new RevisError(`Daytona session ${record.currentSessionId} has no command history`);
    }

    return command;
  }
}

/** Return the deterministic project id used to label Daytona workspaces. */
function daytonaProjectId(root: string): string {
  return sha256Text(root).slice(0, 16);
}

/** Return the labels used to discover Daytona workspaces for one repo. */
function daytonaWorkspaceLabels(
  root: string,
  operatorSlug: string,
  agentId: string
): Record<string, string> {
  return {
    "revis-project": daytonaProjectId(root),
    "revis-operator": operatorSlug,
    "revis-role": "workspace",
    "revis-agent-id": agentId
  };
}

/** Return environment exports used for headless Daytona sessions. */
function daytonaTermEnv(): string[] {
  return Object.entries(TERM_ENV).map(([key, value]) => `${key}=${value}`);
}

/** Return the root directory Revis should use inside one Daytona sandbox. */
async function requireSandboxWorkspaceRoot(sandbox: Sandbox): Promise<string> {
  const workDir = (await sandbox.getWorkDir()) ?? (await sandbox.getUserHomeDir());
  if (!workDir) {
    throw new RevisError(`Daytona sandbox ${sandbox.id} did not report a work directory`);
  }

  return workDir;
}

/** Fail loudly when a Daytona sandbox cannot reach the configured remote. */
function assertRemoteUrlSupported(remoteUrl: string): void {
  if (remoteUrl.startsWith("/") || remoteUrl.startsWith(".")) {
    throw new RevisError(
      "Daytona workspaces require a network-accessible git remote. Local revis-local paths are not supported."
    );
  }
}

/** Convert a partial Node environment into a string-only sandbox env map. */
function nodeEnvToStringMap(
  env: NodeJS.ProcessEnv | undefined
): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

/** Return the current HEAD SHA inside one Daytona sandbox checkout. */
async function sandboxHeadSha(sandbox: Sandbox, workspaceRoot: string): Promise<string> {
  const response = await sandbox.process.executeCommand(
    shellJoin(["git", "rev-parse", "HEAD"]),
    workspaceRoot,
    undefined,
    0
  );
  if (response.exitCode !== 0) {
    throw new RevisError(response.result.trim() || "git rev-parse failed");
  }

  return response.result.trim();
}

/** Return the current checked-out branch inside one Daytona sandbox checkout. */
async function sandboxCurrentBranch(sandbox: Sandbox, workspaceRoot: string): Promise<string> {
  const response = await sandbox.process.executeCommand(
    shellJoin(["git", "rev-parse", "--abbrev-ref", "HEAD"]),
    workspaceRoot,
    undefined,
    0
  );
  if (response.exitCode !== 0) {
    throw new RevisError(response.result.trim() || "git branch probe failed");
  }

  const branch = response.result.trim();
  if (!branch || branch === "HEAD") {
    throw new RevisError("could not determine current branch");
  }

  return branch;
}
