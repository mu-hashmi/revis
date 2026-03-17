/** Daemon lifecycle control and the in-process daemon program. */

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { daemonLayer } from "../app/daemon-layer";
import {
  CommandError,
  ConfigError,
  DaemonUnavailableError,
  StorageError
} from "../domain/errors";
import {
  DaemonStarted,
  DaemonState,
  DaemonStopped,
  type WorkspaceSnapshot
} from "../domain/models";
import { syncTargetBranch } from "../git/branch-names";
import { HostGit } from "../git/host-git";
import {
  currentRevisCommand,
  processAlive,
  spawnReadyProcess
} from "../platform/process";
import { isoNow } from "../platform/time";
import { WorkspaceProvider } from "../providers/contract";
import { EventJournal, type EventJournalApi } from "../services/event-journal";
import { ProjectConfig } from "../services/project-config";
import { ProjectPaths } from "../services/project-paths";
import { WorkspaceStore, type WorkspaceStoreApi } from "../services/workspace-store";
import {
  daemonApiReady,
  makeDaemonServer,
  postControl,
  waitForDaemonState
} from "./http";
import {
  makeGlobalReconcile,
  scheduleBurstReconciliations,
  type ReconcileReason
} from "./reconcile-loop";
import { daemonRouter } from "./routes";
import { makeWorkspaceSupervisors } from "./workspace-supervisor";

const START_TIMEOUT_MS = 10_000;
const DAYTONA_START_TIMEOUT_MS = 60_000;
const DAEMON_READY_LINE = "REVIS_DAEMON_READY";

export type DaemonControlError =
  | CommandError
  | ConfigError
  | DaemonUnavailableError
  | StorageError;

export interface DaemonControlApi {
  readonly ensureRunning: Effect.Effect<DaemonState, DaemonControlError>;
  readonly reconcile: (
    reason: Exclude<ReconcileReason, "startup" | "poll">
  ) => Effect.Effect<void, DaemonControlError>;
  readonly stopWorkspaces: (
    agentIds: ReadonlyArray<string>
  ) => Effect.Effect<void, DaemonControlError>;
  readonly shutdown: Effect.Effect<void, DaemonControlError>;
}

export class DaemonControl extends Context.Tag("@revis/DaemonControl")<
  DaemonControl,
  DaemonControlApi
>() {}

export const daemonControlLayer = Layer.effect(
  DaemonControl,
  Effect.gen(function* () {
    const configService = yield* ProjectConfig;
    const paths = yield* ProjectPaths;
    const store = yield* WorkspaceStore;

    const ensureRunning: Effect.Effect<DaemonState, DaemonControlError> = Effect.gen(function* () {
      const existing = yield* store.daemonState;

      if (existing && (yield* daemonApiReady(existing.apiBaseUrl))) {
        return existing;
      }

      if (existing && processAlive(existing.pid)) {
        return yield* DaemonUnavailableError.make({
          message: `Daemon process ${existing.pid} is alive but ${existing.apiBaseUrl} is unavailable`
        });
      }

      const config = yield* configService.load;
      const argv = [...currentRevisCommand(), "_daemon-run", "--root", paths.root];

      yield* spawnReadyProcess(argv, {
        cwd: paths.root,
        env: {
          ...process.env,
          REVIS_DAEMON_READY_STDOUT: "1"
        },
        readyLine: DAEMON_READY_LINE,
        timeoutMs:
          config.sandboxProvider === "daytona" ? DAYTONA_START_TIMEOUT_MS : START_TIMEOUT_MS
      });

      return yield* waitForDaemonState(
        store,
        config.sandboxProvider === "daytona" ? DAYTONA_START_TIMEOUT_MS : START_TIMEOUT_MS
      );
    });

    const reconcile = (
      reason: Exclude<ReconcileReason, "startup" | "poll">
    ): Effect.Effect<void, DaemonControlError> =>
      Effect.gen(function* () {
        const daemon = yield* ensureRunning;
        yield* postControl(daemon.apiBaseUrl, "/api/control/reconcile", { reason });
      });

    const stopWorkspaces = (agentIds: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const daemon = yield* ensureRunning;
        yield* postControl(daemon.apiBaseUrl, "/api/control/stop", { agentIds });
      });

    const shutdown = Effect.gen(function* () {
      const existing = yield* store.daemonState;
      if (!existing) {
        return;
      }

      if (!(yield* daemonApiReady(existing.apiBaseUrl))) {
        yield* store.clearDaemonState;
        return;
      }

      yield* postControl(existing.apiBaseUrl, "/api/control/shutdown", { reason: "stop" });
    });

    return DaemonControl.of({
      ensureRunning,
      reconcile,
      stopWorkspaces,
      shutdown
    });
  })
);

/** Start the live daemon inside the current process. */
export function runDaemonProcess(root: string) {
  return daemonServerProgram.pipe(Effect.provide(daemonLayer(root)));
}

/** Run the live daemon supervisor and HTTP API inside one scoped runtime. */
export const daemonServerProgram = Effect.scoped(
  Effect.gen(function* () {
    const configService = yield* ProjectConfig;
    const config = yield* configService.load;
    const eventJournal = yield* EventJournal;
    const hostGit = yield* HostGit;
    const paths = yield* ProjectPaths;
    const provider = yield* WorkspaceProvider;
    const store = yield* WorkspaceStore;
    const operatorSlug = yield* hostGit.deriveOperatorSlug(paths.root);
    const syncBranch = syncTargetBranch(config.coordinationRemote, config.trunkBase);
    const shutdown = yield* Deferred.make<void>();
    const reconcileQueue = yield* Queue.unbounded<ReconcileReason>();
    const server = yield* makeDaemonServer();

    if (server.address._tag !== "TcpAddress") {
      return yield* Effect.dieMessage("Daemon server did not bind a TCP address");
    }

    const apiBaseUrl = `http://${server.address.hostname}:${server.address.port}`;
    const daemonState = DaemonState.make({
      sandboxProvider: config.sandboxProvider,
      syncTargetBranch: syncBranch,
      startedAt: isoNow(),
      pid: process.pid,
      socketPath: paths.socketPath,
      apiBaseUrl
    });
    const supervisors = yield* makeWorkspaceSupervisors({
      config: {
        coordinationRemote: config.coordinationRemote
      },
      eventJournal,
      provider,
      store,
      syncBranch
    });
    const globalReconcile = makeGlobalReconcile({
      config,
      eventJournal,
      ensureSupervisor: supervisors.ensureSupervisor,
      hostGit,
      operatorSlug,
      paths,
      store,
      syncBranch
    });

    const router = daemonRouter({
      dashboardRoot: paths.dashboardRoot,
      onReconcile: (reason) =>
        Queue.offer(reconcileQueue, reason).pipe(
          Effect.zipRight(scheduleBurstReconciliations(reconcileQueue, reason)),
          Effect.asVoid
        ),
      onShutdown: (reason) =>
        eventJournal.append(
          DaemonStopped.make({
            timestamp: isoNow(),
            summary: `Daemon stopping (${reason})`
          })
        ).pipe(
          Effect.zipRight(Deferred.succeed(shutdown, undefined)),
          Effect.asVoid
        ),
      onStop: supervisors.stopWorkspaces
    });

    yield* store.setDaemonState(daemonState);
    yield* eventJournal.ensureActiveSession({
      coordinationRemote: config.coordinationRemote,
      trunkBase: config.trunkBase,
      operatorSlug
    });
    yield* eventJournal.append(
      DaemonStarted.make({
        timestamp: daemonState.startedAt,
        summary: "Daemon started"
      })
    );
    yield* syncParticipants(eventJournal, store);

    yield* Effect.forkScoped(server.serve(router));
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(`${config.remotePollSeconds} seconds`).pipe(
          Effect.zipRight(Queue.offer(reconcileQueue, "poll"))
        )
      )
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(reconcileQueue).pipe(Effect.flatMap(globalReconcile))
      )
    );

    if (process.env.REVIS_DAEMON_READY_STDOUT === "1") {
      yield* Effect.sync(() => {
        process.stdout.write(`${DAEMON_READY_LINE}\n`);
      });
    }

    yield* Queue.offer(reconcileQueue, "startup");
    yield* Deferred.await(shutdown);
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const eventJournal = yield* EventJournal;
        const store = yield* WorkspaceStore;

        yield* eventJournal.closeActiveSession;
        yield* store.clearDaemonState;
      }).pipe(Effect.ignore)
    )
  )
);

function syncParticipants(
  eventJournal: EventJournalApi,
  store: WorkspaceStoreApi
): Effect.Effect<void, StorageError> {
  return store.list.pipe(
    Effect.flatMap((snapshots: ReadonlyArray<WorkspaceSnapshot>) =>
      eventJournal.syncParticipants(snapshots).pipe(Effect.asVoid)
    )
  );
}
