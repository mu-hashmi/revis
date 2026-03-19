/** Local detached-process workspace provider. */

import { spawn } from "node:child_process";

import { FileSystem } from "@effect/platform";
import * as CommandExecutor from "@effect/platform/CommandExecutor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  workspaceActivityError,
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
  processAlive,
  runCommandWith,
  shellJoin
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
    const fs = yield* FileSystem.FileSystem;
    const hostGit = yield* HostGit;
    const paths = yield* ProjectPaths;

    /** Provision one fresh local workspace clone plus its runtime files. */
    const provision = Effect.fn("WorkspaceProvider.local.provision")(function* (
      params: ProvisionWorkspaceParams
    ) {
      const workspaceDir = paths.workspaceRuntimeDir(params.agentId);
      const repoPath = paths.workspaceRepoDir(params.agentId);
      const logPath = paths.workspaceLogFile(params.agentId);

      // Re-provisioning should start from a clean runtime directory so stale logs, exit files, or
      // detached process artifacts never bleed into the new workspace.
      yield* fs.remove(workspaceDir, { recursive: true, force: true }).pipe(
        Effect.mapError((error) => workspaceProvisionError("local", error.message))
      );

      // Clone from the coordination remote first, then switch to the workspace branch and stamp a
      // distinct identity so later commits are attributable to this specific agent workspace.
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
      yield* fs.writeFileString(logPath, "").pipe(
        Effect.mapError((error) => workspaceProvisionError("local", error.message))
      );

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
      const logPath = paths.workspaceLogFile(snapshot.agentId);
      const exitPath = paths.workspaceExitFile(snapshot.agentId);
      const shell = process.env.SHELL ?? "/bin/sh";

      // Reset the runtime files that the daemon uses to inspect detached process state.
      yield* resetLocalIterationFiles(fs, logPath, exitPath);

      return yield* Effect.scoped(
        Effect.gen(function* () {
          // Keep the append handle scoped to startup so Node owns one stable fd for the detached
          // child, but the parent still closes its copy immediately after spawn succeeds.
          const logFile = yield* fs.open(logPath, { flag: "a" }).pipe(
            Effect.mapError((error) => workspaceStartError("local", error.message))
          );

          return yield* spawnDetachedIteration(
            snapshot,
            shell,
            exitPath,
            workspaceIteration(snapshot) + 1,
            Number(logFile.fd)
          );
        })
      );
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
        return yield* workspaceInspectError("local", `Invalid local pid for ${snapshot.agentId}`);
      }

      const exitPath = paths.workspaceExitFile(snapshot.agentId);

      // Trust the persisted exit file before probing the pid. The child can exit and be reaped
      // before `kill(pid, 0)` becomes authoritative, but the wrapper still leaves behind the final
      // session status that the daemon needs.
      const exitCode = yield* readLocalExitCode(fs, exitPath);
      if (exitCode !== null) {
        return Number.isFinite(exitCode)
          ? ({ phase: "exited", exitCode } satisfies WorkspaceSessionStatus)
          : ({ phase: "exited" } satisfies WorkspaceSessionStatus);
      }

      if (processAlive(pid)) {
        return { phase: "running" } satisfies WorkspaceSessionStatus;
      }

      return { phase: "missing" } satisfies WorkspaceSessionStatus;
    });

    /** Tail the persisted local session log into a bounded list of activity lines. */
    const captureActivity = Effect.fn("WorkspaceProvider.local.captureActivity")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      const logPath = paths.workspaceLogFile(snapshot.agentId);
      if (
        !(yield* pathExists(fs, logPath, (error) =>
          workspaceActivityError("local", error.message)
        ))
      ) {
        return [];
      }

      // Activity is just the bounded tail of the persisted session log; the daemon can call this
      // repeatedly without worrying about growing unbounded output in memory.
      const payload = yield* fs.readFileString(logPath).pipe(
        Effect.mapError((error) => workspaceActivityError("local", error.message))
      );

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
        return yield* workspaceInterruptError("local", `Invalid local pid for ${snapshot.agentId}`);
      }

      yield* stopLocalProcess(pid);
    });

    /** Tear down the local workspace runtime directory after stopping its process. */
    const destroyWorkspace = Effect.fn("WorkspaceProvider.local.destroyWorkspace")(function* (
      snapshot: WorkspaceSnapshot
    ) {
      // Shutdown should best-effort stop the detached process first, then remove the entire
      // runtime directory tree so the next provision starts from a blank slate.
      yield* interruptIteration(snapshot).pipe(
        Effect.catchTag("WorkspaceInterruptError", () => Effect.void)
      );

      yield* fs.remove(paths.workspaceRuntimeDir(snapshot.agentId), {
        recursive: true,
        force: true
      }).pipe(Effect.mapError((error) => workspaceDestroyError("local", error.message)));
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
function pathExists<E>(
  fs: FileSystem.FileSystem,
  path: string,
  onError: (error: { readonly message: string }) => E
): Effect.Effect<boolean, E> {
  return fs.exists(path).pipe(Effect.mapError(onError));
}

/** Reset the log and exit files that describe one detached local iteration. */
function resetLocalIterationFiles(
  fs: FileSystem.FileSystem,
  logPath: string,
  exitPath: string
) {
  return Effect.all(
    [
      fs.writeFileString(logPath, "").pipe(
        Effect.mapError((error) => workspaceStartError("local", error.message))
      ),
      fs.remove(exitPath, { force: true }).pipe(
        Effect.mapError((error) => workspaceStartError("local", error.message))
      )
    ],
    { concurrency: "unbounded" }
  ).pipe(Effect.asVoid);
}

/** Spawn one detached shell iteration and return its pid-backed session id. */
function spawnDetachedIteration(
  snapshot: WorkspaceSnapshot,
  shell: string,
  exitPath: string,
  iteration: number,
  logFd: number
) {
  return Effect.gen(function* () {
    // Spawn one detached shell so the workspace can keep running after the CLI exits. The
    // wrapper persists the final exit code because the daemon may observe the session after
    // the original CLI process is already gone.
    const child = spawn(
      shell,
      ["-lc", localWrapperScript(snapshot.spec.execCommand, exitPath, iteration)],
      {
        cwd: snapshot.spec.workspaceRoot,
        detached: true,
        env: process.env,
        stdio: ["ignore", logFd, logFd]
      }
    );

    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          child.once("spawn", () => resolve());
          child.once("error", reject);
        }),
      catch: (error) => workspaceStartError("local", String(error))
    });

    child.unref();

    if (!child.pid) {
      return yield* workspaceStartError("local", `No pid returned for ${snapshot.agentId}`);
    }

    return asWorkspaceSessionId(String(child.pid));
  });
}

/** Read the persisted local exit code when the wrapper already wrote one. */
function readLocalExitCode(fs: FileSystem.FileSystem, exitPath: string) {
  return Effect.gen(function* () {
    const exitFileExists = yield* pathExists(fs, exitPath, (error) =>
      workspaceInspectError("local", error.message)
    );
    if (!exitFileExists) {
      return null;
    }

    const payload = yield* fs.readFileString(exitPath).pipe(
      Effect.mapError((error) => workspaceInspectError("local", error.message))
    );

    return Number.parseInt(payload.trim(), 10);
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
    // Run the operator command in a subshell so explicit `exit` calls still flow back through
    // the wrapper and persist a final session status for the daemon.
    "(",
    execCommand,
    ")",
    // Keep the wrapper's status variable out of the operator shell namespace because some shells,
    // including zsh, reserve `status` for their own read-only process state.
    "revis_status=$?",
    'write_exit "$revis_status"',
    'exit "$revis_status"'
  ].join("\n");
}

/** Send TERM first, then KILL if the detached process refuses to exit. */
function stopLocalProcess(pid: number) {
  return Effect.gen(function* () {
    if (!processAlive(pid)) {
      return;
    }

    // Ask the process to exit cleanly first so agent commands can flush logs and finish any final
    // shell traps before the provider escalates to SIGKILL.
    yield* Effect.try({
      try: () => process.kill(pid, "SIGTERM"),
      catch: (error) => workspaceInterruptError("local", String(error))
    });

    // Poll for a short window before escalating so detached children have a chance to flush logs
    // and run their shell traps before the provider falls back to SIGKILL.
    yield* Effect.gen(function* () {
      // Return `true` while we are still waiting so `Effect.repeat` keeps polling, then `false`
      // once the process is gone so the repeat loop stops immediately.
      if (!processAlive(pid)) {
        return false;
      }

      yield* Effect.sleep("50 millis");
      return true;
    }).pipe(
      Effect.repeat({
        until: (waiting) => waiting === false
      }),
      Effect.timeoutOption(`${PROCESS_STOP_TIMEOUT_MS} millis`)
    );

    if (processAlive(pid)) {
      yield* Effect.try({
        try: () => process.kill(pid, "SIGKILL"),
        catch: (error) => workspaceInterruptError("local", String(error))
      });
    }
  });
}
