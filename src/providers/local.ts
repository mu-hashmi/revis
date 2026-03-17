/** Local detached-process workspace provider. */

import { spawn } from "node:child_process";
import { access, open, readFile, rm, writeFile } from "node:fs/promises";

import * as CommandExecutor from "@effect/platform/CommandExecutor";
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
  processAlive,
  runCommandWith,
  shellJoin,
  sleep,
  type CommandFailure
} from "../platform/process";
import { ProjectPaths } from "../services/project-paths";
import { HostGit } from "../git/host-git";
import { workspaceEmail } from "../git/branch-names";
import type {
  ProvisionWorkspaceParams,
  ProvisionedWorkspace,
  WorkspaceProviderApi,
  WorkspaceSessionStatus
} from "./contract";
import { WorkspaceProvider } from "./contract";

const ACTIVITY_LINE_LIMIT = 200;
const PROCESS_STOP_TIMEOUT_MS = 1_000;

export const localWorkspaceProviderLayer = Layer.effect(
  WorkspaceProvider,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const hostGit = yield* HostGit;
    const paths = yield* ProjectPaths;

    /** Provision one fresh local workspace clone plus its runtime files. */
    const provision = Effect.fn("WorkspaceProvider.local.provision")(function* (
      params: ProvisionWorkspaceParams
    ) {
      const workspaceDir = paths.workspaceRuntimeDir(params.agentId);
      const repoPath = paths.workspaceRepoDir(params.agentId);
      const logPath = paths.workspaceLogFile(params.agentId);

      yield* Effect.tryPromise({
        try: () => rm(workspaceDir, { recursive: true, force: true }),
        catch: (error) => providerError("local", "remove workspace", String(error))
      });

      yield* hostGit.cloneWorkspaceRepo(
        params.remoteUrl,
        params.remoteName,
        params.syncBranch,
        repoPath
      );
      yield* hostGit.createBranchFromRemote(
        repoPath,
        params.remoteName,
        params.coordinationBranch,
        params.syncBranch
      );
      yield* hostGit.setGitIdentity(
        repoPath,
        `${params.operatorSlug}-${params.agentId}`,
        workspaceEmail(params.operatorSlug, params.agentId)
      );
      yield* Effect.tryPromise({
        try: () => writeFile(logPath, "", "utf8"),
        catch: (error) => providerError("local", "initialize log", String(error))
      });

      return {
        workspaceRoot: repoPath,
        localBranch: asBranchName(yield* hostGit.currentBranch(repoPath)),
        head: asRevision(yield* hostGit.currentHeadSha(repoPath)),
        attachCmd: ["tail", "-f", logPath],
        attachLabel: logPath
      } satisfies ProvisionedWorkspace;
    });

    /** Start the next detached local iteration and return the child PID as the session id. */
    const startIteration = Effect.fn("WorkspaceProvider.local.startIteration")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      // Reset the runtime files that the daemon uses to inspect detached process state.
      const logPath = paths.workspaceLogFile(snapshot.agentId);
      const exitPath = paths.workspaceExitFile(snapshot.agentId);
      const shell = process.env.SHELL ?? "/bin/sh";

      yield* Effect.tryPromise({
        try: () => Promise.all([writeFile(logPath, "", "utf8"), rm(exitPath, { force: true })]),
        catch: (error) => providerError("local", "prepare iteration", String(error))
      });

      const logHandle = yield* Effect.tryPromise({
        try: () => open(logPath, "a"),
        catch: (error) => providerError("local", "open iteration log", String(error))
      });

      // Spawn one detached shell so the workspace can keep running after the CLI exits.
      const child = spawn(
        shell,
        [
          "-lc",
          localWrapperScript(
            snapshot.spec.execCommand,
            exitPath,
            workspaceIteration(snapshot) + 1
          )
        ],
        {
          cwd: snapshot.spec.workspaceRoot,
          detached: true,
          env: process.env,
          stdio: ["ignore", logHandle.fd, logHandle.fd]
        }
      );

      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            child.once("spawn", () => resolve());
            child.once("error", reject);
          }),
        catch: (error) => providerError("local", "start iteration", String(error))
      });

      yield* Effect.tryPromise({
        try: () => logHandle.close(),
        catch: (error) => providerError("local", "close iteration log", String(error))
      });

      child.unref();

      if (!child.pid) {
        return yield* providerError(
          "local",
          "start iteration",
          `No pid returned for ${snapshot.agentId}`
        );
      }

      return asWorkspaceSessionId(String(child.pid));
    });

    /** Inspect the currently recorded detached process for one local workspace. */
    const inspectSession = Effect.fn("WorkspaceProvider.local.inspectSession")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sessionId = workspaceCurrentSessionId(snapshot);
      if (!sessionId) {
        return { phase: "missing" } satisfies WorkspaceSessionStatus;
      }

      const pid = Number.parseInt(sessionId, 10);
      if (!Number.isInteger(pid)) {
        return yield* providerError(
          "local",
          "inspect session",
          `Invalid local pid for ${snapshot.agentId}`
        );
      }

      if (processAlive(pid)) {
        return { phase: "running" } satisfies WorkspaceSessionStatus;
      }

      const exitPath = paths.workspaceExitFile(snapshot.agentId);
      if (!(yield* pathExists(exitPath))) {
        return { phase: "missing" } satisfies WorkspaceSessionStatus;
      }

      const payload = yield* Effect.tryPromise({
        try: () => readFile(exitPath, "utf8"),
        catch: (error) => providerError("local", "read exit code", String(error))
      });
      const exitCode = Number.parseInt(payload.trim(), 10);

      return Number.isFinite(exitCode)
        ? ({ phase: "exited", exitCode } satisfies WorkspaceSessionStatus)
        : ({ phase: "exited" } satisfies WorkspaceSessionStatus);
    });

    /** Tail the persisted local session log into a bounded list of activity lines. */
    const captureActivity = Effect.fn("WorkspaceProvider.local.captureActivity")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const logPath = paths.workspaceLogFile(snapshot.agentId);
      if (!(yield* pathExists(logPath))) {
        return [];
      }

      const payload = yield* Effect.tryPromise({
        try: () => readFile(logPath, "utf8"),
        catch: (error) => providerError("local", "read activity", String(error))
      });

      return payload
        .replaceAll("\r", "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-ACTIVITY_LINE_LIMIT);
    });

    /** Run one command directly inside the local workspace checkout. */
    const runInWorkspace = Effect.fn("WorkspaceProvider.local.runInWorkspace")(function* (
      snapshot: WorkspaceSnapshot,
      argv: ReadonlyArray<string>,
      options = {}
    ) {
      return yield* runCommandWith(executor, [...argv], {
        ...options,
        cwd: options.cwd ?? snapshot.spec.workspaceRoot
      });
    });

    /** Interrupt the detached local iteration process, if one is still running. */
    const interruptIteration = Effect.fn("WorkspaceProvider.local.interruptIteration")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const sessionId = workspaceCurrentSessionId(snapshot);
      if (!sessionId) {
        return;
      }

      const pid = Number.parseInt(sessionId, 10);
      if (!Number.isInteger(pid)) {
        return yield* providerError(
          "local",
          "interrupt iteration",
          `Invalid local pid for ${snapshot.agentId}`
        );
      }

      yield* stopLocalProcess(pid);
    });

    /** Tear down the local workspace runtime directory after stopping its process. */
    const destroyWorkspace = Effect.fn("WorkspaceProvider.local.destroyWorkspace")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      yield* interruptIteration(snapshot).pipe(
        Effect.catchAll((error) =>
          error.action === "interrupt iteration" ? Effect.void : Effect.fail(error)
        )
      );

      yield* Effect.tryPromise({
        try: () => rm(paths.workspaceRuntimeDir(snapshot.agentId), { recursive: true, force: true }),
        catch: (error) => providerError("local", "destroy workspace", String(error))
      });
    });

    const service: WorkspaceProviderApi = {
      kind: "local",
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

/** Return whether one file exists on disk. */
function pathExists(path: string): Effect.Effect<boolean, never> {
  return Effect.promise(async () => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }

      throw error;
    }
  });
}

/** Render the shell wrapper that writes the final exit code to disk. */
function localWrapperScript(execCommand: string, exitPath: string, iteration: number): string {
  const escapedExitPath = shellJoin([exitPath]);

  return [
    `export REVIS_ITERATION=${iteration}`,
    // Persist the final exit code because the detached child may outlive the daemon process.
    `write_exit() { printf '%s\\n' \"$1\" > ${escapedExitPath}; }`,
    "trap 'write_exit 130; exit 130' INT",
    "trap 'write_exit 143; exit 143' TERM",
    execCommand,
    "status=$?",
    'write_exit "$status"',
    'exit "$status"'
  ].join("\n");
}

/** Send TERM first, then KILL if the detached process refuses to exit. */
function stopLocalProcess(pid: number): Effect.Effect<void, ReturnType<typeof providerError>> {
  return Effect.gen(function* () {
    if (!processAlive(pid)) {
      return;
    }

    yield* Effect.try({
      try: () => process.kill(pid, "SIGTERM"),
      catch: (error) => providerError("local", "interrupt iteration", String(error))
    });

    const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS;
    while (processAlive(pid) && Date.now() < deadline) {
      yield* Effect.promise(() => sleep(50));
    }

    if (processAlive(pid)) {
      yield* Effect.try({
        try: () => process.kill(pid, "SIGKILL"),
        catch: (error) => providerError("local", "interrupt iteration", String(error))
      });
    }
  });
}
