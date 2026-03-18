/** Daytona-backed workspace provider. */

import { posix as pathPosix } from "node:path";

import { Daytona, type Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  workspaceActivityError,
  workspaceCommandError,
  workspaceDestroyError,
  workspaceInspectError,
  workspaceInterruptError,
  workspaceProvisionError,
  workspaceStartError
} from "../domain/errors";
import {
  asBranchName,
  asRevision,
  asWorkspaceSessionId,
  workspaceCurrentSessionId,
  workspaceIteration,
  type WorkspaceSnapshot
} from "../domain/models";
import {
  shellJoin,
  type CompletedCommand,
  type RunCommandOptions
} from "../platform/process";
import { sha256Text } from "../platform/text";
import { workspaceEmail } from "../git/branch-names";
import type {
  ProvisionWorkspaceParams,
  ProvisionedWorkspace,
  WorkspaceProviderApi,
  WorkspaceSessionStatus
} from "./contract";
import { WorkspaceProvider } from "./contract";

const ACTIVITY_LINE_LIMIT = 200;
const TERM_ENV = {
  LANG: "en_US.UTF-8",
  TERM: "xterm-256color"
} as const;

const daytonaProvisionError = (message: string) => workspaceProvisionError("daytona", message);
const daytonaStartError = (message: string) => workspaceStartError("daytona", message);
const daytonaInspectError = (message: string) => workspaceInspectError("daytona", message);
const daytonaActivityError = (message: string) => workspaceActivityError("daytona", message);
const daytonaCommandError = (message: string) => workspaceCommandError("daytona", message);
const daytonaInterruptError = (message: string) => workspaceInterruptError("daytona", message);
const daytonaDestroyError = (message: string) => workspaceDestroyError("daytona", message);

export const daytonaWorkspaceProviderLayer = Layer.effect(
  WorkspaceProvider,
  Effect.gen(function* () {
    let daytona: Daytona | undefined;

    const getDaytona = () => {
      if (!daytona) {
        daytona = new Daytona();
      }

      return daytona;
    };

    /** Provision one Daytona sandbox and clone the workspace checkout into it. */
    const provision = Effect.fn("WorkspaceProvider.daytona.provision")(function* (
      params: ProvisionWorkspaceParams
    ) {
      yield* assertRemoteUrlSupported(params.remoteUrl, daytonaProvisionError);

      const sandbox = yield* Effect.tryPromise({
        try: () =>
          getDaytona().create({
            name: `revis-${params.operatorSlug}-${params.agentId}`,
            labels: daytonaWorkspaceLabels(params.root, params.operatorSlug, params.agentId),
            // Revis workspaces are long-lived coordination sandboxes, not ephemeral preview envs.
            autoStopInterval: 0,
            autoDeleteInterval: -1,
            ephemeral: false
          }),
        catch: (error) => daytonaProvisionError(String(error))
      });

      yield* Effect.tryPromise({
        try: () => sandbox.setAutostopInterval(0),
        catch: (error) => daytonaProvisionError(String(error))
      });

      const workDir = yield* requireSandboxWorkspaceRoot(sandbox, daytonaProvisionError);
      const workspaceRoot = pathPosix.join(workDir, "revis", params.agentId, "repo");
      const parentDir = pathPosix.dirname(workspaceRoot);

      yield* runSandboxCommand(
        sandbox,
        shellJoin(["mkdir", "-p", parentDir]),
        undefined,
        daytonaProvisionError
      );
      yield* Effect.tryPromise({
        try: () => sandbox.git.clone(params.remoteUrl, workspaceRoot, params.syncBranch),
        catch: (error) => daytonaProvisionError(String(error))
      });
      yield* runSandboxCommand(
        sandbox,
        shellJoin([
          "git",
          "checkout",
          "-B",
          params.coordinationBranch,
          `${params.remoteName}/${params.syncBranch}`
        ]),
        workspaceRoot,
        daytonaProvisionError
      );
      yield* runSandboxCommand(
        sandbox,
        shellJoin(["git", "config", "user.name", `${params.operatorSlug}-${params.agentId}`]),
        workspaceRoot,
        daytonaProvisionError
      );
      yield* runSandboxCommand(
        sandbox,
        shellJoin([
          "git",
          "config",
          "user.email",
          workspaceEmail(params.operatorSlug, params.agentId)
        ]),
        workspaceRoot,
        daytonaProvisionError
      );

      return {
        workspaceRoot,
        localBranch: asBranchName(
          yield* sandboxCurrentBranch(sandbox, workspaceRoot, daytonaProvisionError)
        ),
        head: asRevision(yield* sandboxHeadSha(sandbox, workspaceRoot, daytonaProvisionError)),
        attachLabel: `daytona:${sandbox.id}`,
        sandboxId: sandbox.id
      } satisfies ProvisionedWorkspace;
    });

    /** Start the next asynchronous Daytona session inside one provisioned sandbox. */
    const startIteration = Effect.fn("WorkspaceProvider.daytona.startIteration")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sandbox = yield* getSandbox(getDaytona, snapshot, daytonaStartError);

      yield* Effect.tryPromise({
        try: () => sandbox.start(60),
        catch: (error) => daytonaStartError(String(error))
      });

      const sessionId = asWorkspaceSessionId(
        `${snapshot.agentId}-iter-${workspaceIteration(snapshot) + 1}-${Date.now()}`
      );

      yield* Effect.tryPromise({
        try: () => sandbox.process.createSession(sessionId),
        catch: (error) => daytonaStartError(String(error))
      });
      yield* Effect.tryPromise({
        try: () =>
          sandbox.process.executeSessionCommand(
            sessionId,
            {
              command: shellJoin([
                "env",
                ...daytonaTermEnv(),
                `REVIS_ITERATION=${workspaceIteration(snapshot) + 1}`,
                "sh",
                "-lc",
                `cd ${shellJoin([snapshot.spec.workspaceRoot])} && exec ${snapshot.spec.execCommand}`
              ]),
              runAsync: true
            },
            0
          ),
        catch: (error) => daytonaStartError(String(error))
      });

      return sessionId;
    });

    /** Inspect the last command recorded for the current Daytona session. */
    const inspectSession = Effect.fn("WorkspaceProvider.daytona.inspectSession")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sessionId = workspaceCurrentSessionId(snapshot);
      if (!sessionId) {
        return { phase: "missing" } satisfies WorkspaceSessionStatus;
      }

      const command = yield* latestSessionCommand(getDaytona, snapshot, daytonaInspectError);
      if (command.exitCode === undefined) {
        return { phase: "running" } satisfies WorkspaceSessionStatus;
      }

      return {
        phase: "exited",
        exitCode: command.exitCode
      } satisfies WorkspaceSessionStatus;
    });

    /** Capture the latest bounded activity log for one Daytona session. */
    const captureActivity = Effect.fn("WorkspaceProvider.daytona.captureActivity")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sessionId = workspaceCurrentSessionId(snapshot);
      if (!sessionId) {
        return [];
      }

      const sandbox = yield* getSandbox(getDaytona, snapshot, daytonaActivityError);
      const command = yield* latestSessionCommand(getDaytona, snapshot, daytonaActivityError);
      const logs = yield* Effect.tryPromise({
        try: () => sandbox.process.getSessionCommandLogs(sessionId, command.id),
        catch: (error) => daytonaActivityError(String(error))
      });

      return `${logs.stdout ?? ""}${logs.stderr ?? ""}`
        .replaceAll("\r", "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-ACTIVITY_LINE_LIMIT);
    });

    /** Run one synchronous command inside the Daytona sandbox checkout. */
    const runInWorkspace = Effect.fn("WorkspaceProvider.daytona.runInWorkspace")(function* (
      snapshot: WorkspaceSnapshot,
      argv: ReadonlyArray<string>,
      options: RunCommandOptions = {}
    ) {
      const sandbox = yield* getSandbox(getDaytona, snapshot, daytonaCommandError);
      const response = yield* Effect.tryPromise({
        try: () =>
          sandbox.process.executeCommand(
            shellJoin(argv),
            options.cwd ?? snapshot.spec.workspaceRoot,
            nodeEnvToStringMap(options.env),
            0
          ),
        catch: (error) => daytonaCommandError(String(error))
      });

      const completed: CompletedCommand = {
        stdout: response.result,
        stderr: "",
        exitCode: response.exitCode
      };

      if ((options.check ?? true) && completed.exitCode !== 0) {
        return yield* daytonaCommandError(completed.stdout.trim() || "command failed");
      }

      return completed;
    });

    /** Delete the currently tracked Daytona session, if one exists. */
    const interruptIteration = Effect.fn("WorkspaceProvider.daytona.interruptIteration")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sessionId = workspaceCurrentSessionId(snapshot);
      if (!sessionId) {
        return;
      }

      const sandbox = yield* getSandbox(getDaytona, snapshot, daytonaInterruptError);
      yield* Effect.tryPromise({
        try: () => sandbox.process.deleteSession(sessionId),
        catch: (error) => daytonaInterruptError(String(error))
      });
    });

    /** Destroy the backing Daytona sandbox after stopping its active session. */
    const destroyWorkspace = Effect.fn("WorkspaceProvider.daytona.destroyWorkspace")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sandbox = yield* getSandbox(getDaytona, snapshot, daytonaDestroyError);

      yield* interruptIteration(snapshot).pipe(
        Effect.catchTag("WorkspaceInterruptError", () => Effect.void)
      );
      yield* Effect.tryPromise({
        try: () => sandbox.delete(),
        catch: (error) => daytonaDestroyError(String(error))
      });
    });

    const service: WorkspaceProviderApi = {
      kind: "daytona",
      provision,
      startIteration,
      inspectSession,
      captureActivity,
      runInWorkspace,
      interruptIteration,
      destroyWorkspace
    };

    return WorkspaceProvider.of(service);
  })
);

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

/** Return terminal exports used for headless Daytona sessions. */
function daytonaTermEnv(): string[] {
  return Object.entries(TERM_ENV).map(([key, value]) => `${key}=${value}`);
}

/** Return the root directory Revis should use inside one sandbox. */
function requireSandboxWorkspaceRoot<E>(
  sandbox: Sandbox,
  onError: (message: string) => E
) {
  return Effect.tryPromise({
    try: async () => {
      const workDir = (await sandbox.getWorkDir()) ?? (await sandbox.getUserHomeDir());
      if (!workDir) {
        throw new Error(`Daytona sandbox ${sandbox.id} did not report a work directory`);
      }

      return workDir;
    },
    catch: (error) => onError(String(error))
  });
}

/** Fail loudly when the configured remote is not reachable from Daytona. */
function assertRemoteUrlSupported<E>(
  remoteUrl: string,
  onError: (message: string) => E
) {
  if (remoteUrl.startsWith("/") || remoteUrl.startsWith(".")) {
    return Effect.fail(
      onError(
        "Daytona requires a network-accessible git remote. Local revis-local paths are not supported."
      )
    );
  }

  return Effect.void;
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

/** Return the current HEAD SHA inside one sandbox checkout. */
function sandboxHeadSha<E>(
  sandbox: Sandbox,
  workspaceRoot: string,
  onError: (message: string) => E
) {
  return runSandboxCommand(
    sandbox,
    shellJoin(["git", "rev-parse", "HEAD"]),
    workspaceRoot,
    onError
  ).pipe(Effect.map((response) => response.stdout.trim()));
}

/** Return the current checked-out branch inside one sandbox checkout. */
function sandboxCurrentBranch<E>(
  sandbox: Sandbox,
  workspaceRoot: string,
  onError: (message: string) => E
) {
  return runSandboxCommand(
    sandbox,
    shellJoin(["git", "rev-parse", "--abbrev-ref", "HEAD"]),
    workspaceRoot,
    onError
  ).pipe(
    Effect.flatMap((response) => {
      const branch = response.stdout.trim();
      if (branch && branch !== "HEAD") {
        return Effect.succeed(branch);
      }

      return Effect.fail(onError("Could not determine current branch"));
    })
  );
}

/** Resolve one Daytona sandbox from snapshot metadata. */
function getSandbox<E>(
  getDaytona: () => Daytona,
  snapshot: WorkspaceSnapshot,
  onError: (message: string) => E
) {
  if (!snapshot.spec.sandboxId) {
    return Effect.fail(onError(`Missing sandbox metadata for ${snapshot.agentId}`));
  }

  return Effect.tryPromise({
    try: () => getDaytona().get(snapshot.spec.sandboxId!),
    catch: (error) => onError(String(error))
  });
}

/** Return the latest command entry for one Daytona session. */
function latestSessionCommand<E>(
  getDaytona: () => Daytona,
  snapshot: WorkspaceSnapshot,
  onError: (message: string) => E
) {
  return Effect.gen(function* () {
    const sessionId = workspaceCurrentSessionId(snapshot);
    if (!sessionId) {
      return yield* Effect.fail(onError(`Missing session metadata for ${snapshot.agentId}`));
    }

    const sandbox = yield* getSandbox(getDaytona, snapshot, onError);
    const session = yield* Effect.tryPromise({
      try: () => sandbox.process.getSession(sessionId),
      catch: (error) => onError(String(error))
    });
    const command = session.commands?.at(-1);

    if (!command) {
      return yield* Effect.fail(onError(`Session ${sessionId} has no command history`));
    }

    return command;
  });
}

/** Execute one synchronous sandbox command and surface failures loudly. */
function runSandboxCommand<E>(
  sandbox: Sandbox,
  command: string,
  cwd: string | undefined,
  onError: (message: string) => E
) {
  return Effect.tryPromise({
    try: () => sandbox.process.executeCommand(command, cwd, undefined, 0),
    catch: (error) => onError(String(error))
  }).pipe(
    Effect.flatMap((response) => {
      const completed: CompletedCommand = {
        stdout: response.result,
        stderr: "",
        exitCode: response.exitCode
      };

      if (completed.exitCode !== 0) {
        return Effect.fail(onError(completed.stdout.trim() || "command failed"));
      }

      return Effect.succeed(completed);
    })
  );
}
