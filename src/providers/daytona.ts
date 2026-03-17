/** Daytona-backed workspace provider. */

import { posix as pathPosix } from "node:path";

import { Daytona, type Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { providerError } from "../domain/errors";
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

    const provision = Effect.fn("WorkspaceProvider.daytona.provision")(function* (
      params: ProvisionWorkspaceParams
    ) {
      yield* assertRemoteUrlSupported(params.remoteUrl);

      const sandbox = yield* Effect.tryPromise({
        try: () =>
          getDaytona().create({
            name: `revis-${params.operatorSlug}-${params.agentId}`,
            labels: daytonaWorkspaceLabels(params.root, params.operatorSlug, params.agentId),
            autoStopInterval: 0,
            autoDeleteInterval: -1,
            ephemeral: false
          }),
        catch: (error) => providerError("daytona", "create sandbox", String(error))
      });

      yield* Effect.tryPromise({
        try: () => sandbox.setAutostopInterval(0),
        catch: (error) => providerError("daytona", "disable autostop", String(error))
      });

      const workDir = yield* requireSandboxWorkspaceRoot(sandbox);
      const workspaceRoot = pathPosix.join(workDir, "revis", params.agentId, "repo");
      const parentDir = pathPosix.dirname(workspaceRoot);

      yield* runSandboxCommand(sandbox, shellJoin(["mkdir", "-p", parentDir]), undefined);
      yield* Effect.tryPromise({
        try: () => sandbox.git.clone(params.remoteUrl, workspaceRoot, params.syncBranch),
        catch: (error) => providerError("daytona", "clone workspace", String(error))
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
        workspaceRoot
      );
      yield* runSandboxCommand(
        sandbox,
        shellJoin(["git", "config", "user.name", `${params.operatorSlug}-${params.agentId}`]),
        workspaceRoot
      );
      yield* runSandboxCommand(
        sandbox,
        shellJoin([
          "git",
          "config",
          "user.email",
          workspaceEmail(params.operatorSlug, params.agentId)
        ]),
        workspaceRoot
      );

      return {
        workspaceRoot,
        localBranch: asBranchName(yield* sandboxCurrentBranch(sandbox, workspaceRoot)),
        head: asRevision(yield* sandboxHeadSha(sandbox, workspaceRoot)),
        attachLabel: `daytona:${sandbox.id}`,
        sandboxId: sandbox.id
      } satisfies ProvisionedWorkspace;
    });

    const startIteration = Effect.fn("WorkspaceProvider.daytona.startIteration")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sandbox = yield* getSandbox(getDaytona, snapshot);

      yield* Effect.tryPromise({
        try: () => sandbox.start(60),
        catch: (error) => providerError("daytona", "start sandbox", String(error))
      });

      const sessionId = asWorkspaceSessionId(
        `${snapshot.agentId}-iter-${workspaceIteration(snapshot) + 1}-${Date.now()}`
      );

      yield* Effect.tryPromise({
        try: () => sandbox.process.createSession(sessionId),
        catch: (error) => providerError("daytona", "create session", String(error))
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
        catch: (error) => providerError("daytona", "start iteration", String(error))
      });

      return sessionId;
    });

    const inspectSession = Effect.fn("WorkspaceProvider.daytona.inspectSession")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sessionId = workspaceCurrentSessionId(snapshot);
      if (!sessionId) {
        return { phase: "missing" } satisfies WorkspaceSessionStatus;
      }

      const command = yield* latestSessionCommand(getDaytona, snapshot);
      if (command.exitCode === undefined) {
        return { phase: "running" } satisfies WorkspaceSessionStatus;
      }

      return {
        phase: "exited",
        exitCode: command.exitCode
      } satisfies WorkspaceSessionStatus;
    });

    const captureActivity = Effect.fn("WorkspaceProvider.daytona.captureActivity")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sessionId = workspaceCurrentSessionId(snapshot);
      if (!sessionId) {
        return [];
      }

      const sandbox = yield* getSandbox(getDaytona, snapshot);
      const command = yield* latestSessionCommand(getDaytona, snapshot);
      const logs = yield* Effect.tryPromise({
        try: () => sandbox.process.getSessionCommandLogs(sessionId, command.id),
        catch: (error) => providerError("daytona", "read activity", String(error))
      });

      return `${logs.stdout ?? ""}${logs.stderr ?? ""}`
        .replaceAll("\r", "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-ACTIVITY_LINE_LIMIT);
    });

    const runInWorkspace = Effect.fn("WorkspaceProvider.daytona.runInWorkspace")(function* (
      snapshot: WorkspaceSnapshot,
      argv: ReadonlyArray<string>,
      options: RunCommandOptions = {}
    ) {
      const sandbox = yield* getSandbox(getDaytona, snapshot);
      const response = yield* Effect.tryPromise({
        try: () =>
          sandbox.process.executeCommand(
            shellJoin(argv),
            options.cwd ?? snapshot.spec.workspaceRoot,
            nodeEnvToStringMap(options.env),
            0
          ),
        catch: (error) => providerError("daytona", "run command", String(error))
      });

      const completed: CompletedCommand = {
        stdout: response.result,
        stderr: "",
        exitCode: response.exitCode
      };

      if ((options.check ?? true) && completed.exitCode !== 0) {
        return yield* providerError(
          "daytona",
          "run command",
          completed.stdout.trim() || "command failed"
        );
      }

      return completed;
    });

    const interruptIteration = Effect.fn("WorkspaceProvider.daytona.interruptIteration")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sessionId = workspaceCurrentSessionId(snapshot);
      if (!sessionId) {
        return;
      }

      const sandbox = yield* getSandbox(getDaytona, snapshot);
      yield* Effect.tryPromise({
        try: () => sandbox.process.deleteSession(sessionId),
        catch: (error) => providerError("daytona", "interrupt iteration", String(error))
      });
    });

    const destroyWorkspace = Effect.fn("WorkspaceProvider.daytona.destroyWorkspace")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sandbox = yield* getSandbox(getDaytona, snapshot);

      yield* interruptIteration(snapshot).pipe(
        Effect.catchAll((error) =>
          error.action === "interrupt iteration" ? Effect.void : Effect.fail(error)
        )
      );
      yield* Effect.tryPromise({
        try: () => sandbox.delete(),
        catch: (error) => providerError("daytona", "destroy workspace", String(error))
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
function requireSandboxWorkspaceRoot(
  sandbox: Sandbox
): Effect.Effect<string, ReturnType<typeof providerError>> {
  return Effect.tryPromise({
    try: async () => {
      const workDir = (await sandbox.getWorkDir()) ?? (await sandbox.getUserHomeDir());
      if (!workDir) {
        throw new Error(`Daytona sandbox ${sandbox.id} did not report a work directory`);
      }

      return workDir;
    },
    catch: (error) => providerError("daytona", "resolve workdir", String(error))
  });
}

/** Fail loudly when the configured remote is not reachable from Daytona. */
function assertRemoteUrlSupported(
  remoteUrl: string
): Effect.Effect<void, ReturnType<typeof providerError>> {
  if (remoteUrl.startsWith("/") || remoteUrl.startsWith(".")) {
    return Effect.fail(
      providerError(
        "daytona",
        "validate remote",
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
function sandboxHeadSha(
  sandbox: Sandbox,
  workspaceRoot: string
): Effect.Effect<string, ReturnType<typeof providerError>> {
  return runSandboxCommand(sandbox, shellJoin(["git", "rev-parse", "HEAD"]), workspaceRoot).pipe(
    Effect.map((response) => response.stdout.trim())
  );
}

/** Return the current checked-out branch inside one sandbox checkout. */
function sandboxCurrentBranch(
  sandbox: Sandbox,
  workspaceRoot: string
): Effect.Effect<string, ReturnType<typeof providerError>> {
  return runSandboxCommand(
    sandbox,
    shellJoin(["git", "rev-parse", "--abbrev-ref", "HEAD"]),
    workspaceRoot
  ).pipe(
    Effect.flatMap((response) => {
      const branch = response.stdout.trim();
      if (branch && branch !== "HEAD") {
        return Effect.succeed(branch);
      }

      return Effect.fail(
        providerError("daytona", "read branch", "Could not determine current branch")
      );
    })
  );
}

/** Resolve one Daytona sandbox from snapshot metadata. */
function getSandbox(
  getDaytona: () => Daytona,
  snapshot: WorkspaceSnapshot
): Effect.Effect<Sandbox, ReturnType<typeof providerError>> {
  if (!snapshot.spec.sandboxId) {
    return Effect.fail(
      providerError(
        "daytona",
        "resolve sandbox",
        `Missing sandbox metadata for ${snapshot.agentId}`
      )
    );
  }

  return Effect.tryPromise({
    try: () => getDaytona().get(snapshot.spec.sandboxId!),
    catch: (error) => providerError("daytona", "resolve sandbox", String(error))
  });
}

/** Return the latest command entry for one Daytona session. */
function latestSessionCommand(
  getDaytona: () => Daytona,
  snapshot: WorkspaceSnapshot
): Effect.Effect<{ readonly id: string; readonly exitCode?: number }, ReturnType<typeof providerError>> {
  return Effect.gen(function* () {
    const sessionId = workspaceCurrentSessionId(snapshot);
    if (!sessionId) {
      return yield* providerError(
        "daytona",
        "inspect session",
        `Missing session metadata for ${snapshot.agentId}`
      );
    }

    const sandbox = yield* getSandbox(getDaytona, snapshot);
    const session = yield* Effect.tryPromise({
      try: () => sandbox.process.getSession(sessionId),
      catch: (error) => providerError("daytona", "inspect session", String(error))
    });
    const command = session.commands?.at(-1);

    if (!command) {
      return yield* providerError(
        "daytona",
        "inspect session",
        `Session ${sessionId} has no command history`
      );
    }

    return command;
  });
}

/** Execute one synchronous sandbox command and surface failures loudly. */
function runSandboxCommand(
  sandbox: Sandbox,
  command: string,
  cwd: string | undefined
): Effect.Effect<CompletedCommand, ReturnType<typeof providerError>> {
  return Effect.tryPromise({
    try: () => sandbox.process.executeCommand(command, cwd, undefined, 0),
    catch: (error) => providerError("daytona", "run command", String(error))
  }).pipe(
    Effect.flatMap((response) => {
      const completed: CompletedCommand = {
        stdout: response.result,
        stderr: "",
        exitCode: response.exitCode
      };

      if (completed.exitCode !== 0) {
        return Effect.fail(
          providerError("daytona", "run command", completed.stdout.trim() || "command failed")
        );
      }

      return Effect.succeed(completed);
    })
  );
}
