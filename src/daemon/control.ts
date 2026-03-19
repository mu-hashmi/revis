/** Daemon lifecycle control and the in-process daemon program. */

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { FileSystem, HttpClient } from "@effect/platform";

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

/** Operator-facing control surface for starting and steering the daemon process. */
export class DaemonControl extends Context.Tag("@revis/DaemonControl")<
  DaemonControl,
  DaemonControlApi
>() {}

export const daemonControlLayer = Layer.effect(
  DaemonControl,
  Effect.gen(function* () {
    const configService = yield* ProjectConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const paths = yield* ProjectPaths;
    const store = yield* WorkspaceStore;

    // Capture the platform services once at layer construction time so the exported control API
    // stays environment-free for CLI callers.
    const provideTransport = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(HttpClient.HttpClient, httpClient)
      );
    const spawnDaemon = (timeoutMs: number) =>
      spawnReadyProcess([...currentRevisCommand(), "_daemon-run", "--root", paths.root], {
        cwd: paths.root,
        env: {
          ...process.env,
          REVIS_DAEMON_READY_STDOUT: "1"
        },
        readyLine: DAEMON_READY_LINE,
        timeoutMs
      });

    const ensureRunning: Effect.Effect<DaemonState, DaemonControlError> = Effect.gen(function* () {
      const existing = yield* store.daemonState;

      if (
        Option.isSome(existing) &&
        (yield* provideTransport(daemonApiReady(existing.value.apiBaseUrl)))
      ) {
        return existing.value;
      }

      if (Option.isSome(existing) && processAlive(existing.value.pid)) {
        return yield* DaemonUnavailableError.make({
          message: `Daemon process ${existing.value.pid} is alive but ${existing.value.apiBaseUrl} is unavailable`
        });
      }

      const config = yield* configService.load;
      const timeoutMs = daemonStartTimeoutMs(config.sandboxProvider);

      yield* spawnDaemon(timeoutMs);
      return yield* provideTransport(waitForDaemonState(paths.daemonStateFile, timeoutMs));
    });

    const reconcile = (
      reason: Exclude<ReconcileReason, "startup" | "poll">
    ): Effect.Effect<void, DaemonControlError> =>
      Effect.gen(function* () {
        const daemon = yield* ensureRunning;
        yield* provideTransport(postControl(daemon.apiBaseUrl, "/api/control/reconcile", { reason }));
      });

    const stopWorkspaces = (agentIds: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const daemon = yield* ensureRunning;
        yield* provideTransport(postControl(daemon.apiBaseUrl, "/api/control/stop", { agentIds }));
      });

    const shutdown = Effect.gen(function* () {
      const existing = yield* store.daemonState;
      if (Option.isNone(existing)) {
        return;
      }

      if (!(yield* provideTransport(daemonApiReady(existing.value.apiBaseUrl)))) {
        yield* store.clearDaemonState;
        return;
      }

      yield* provideTransport(
        postControl(existing.value.apiBaseUrl, "/api/control/shutdown", { reason: "stop" })
      );
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
    // Load the project-scoped services and static daemon configuration.
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
    const reconcileQueue = yield* Queue.sliding<ReconcileReason>(1);
    const server = yield* makeDaemonServer();
    // Burst follow-up reconciles must outlive one HTTP request, but should still die with the
    // daemon process itself.
    const daemonScope = yield* Effect.scope;

    // Bind the API server and derive the persisted daemon snapshot from the bound address.
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
    const queueReconcile = (reason: Exclude<ReconcileReason, "startup" | "poll">) =>
      Queue.offer(reconcileQueue, reason).pipe(
        Effect.zipRight(scheduleBurstReconciliations(reconcileQueue, reason, daemonScope)),
        Effect.asVoid
      );
    const requestShutdown = (reason: string) =>
      // Record the stop event before completing the shutdown gate so the final journal state is
      // visible to operators even when the process exits immediately afterward.
      eventJournal.append(
        DaemonStopped.make({
          timestamp: isoNow(),
          summary: `Daemon stopping (${reason})`
        })
      ).pipe(
        Effect.zipRight(Deferred.succeed(shutdown, undefined)),
        Effect.asVoid
      );

    // Build the transport router after the runtime control callbacks exist.
    const router = daemonRouter({
      dashboardRoot: paths.dashboardRoot,
      onReconcile: queueReconcile,
      onShutdown: requestShutdown,
      onStop: supervisors.stopWorkspaces
    });

    // Persist daemon liveness and recover the active archive session before serving requests.
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

    // Start background fibers for HTTP serving, periodic polls, and queued reconciles.
    yield* Effect.forkScoped(
      server.serve(router).pipe(
        // On this platform, `server.serve(...)` installs the request handlers into the current
        // scope and then returns immediately. Forking it here still ties that registration to the
        // daemon lifetime, but joining the fiber would tear the daemon down at startup.
        Effect.annotateLogs({ service: "daemon-http-server" }),
        Effect.tapErrorCause((cause) => Effect.logError(cause))
      )
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(`${config.remotePollSeconds} seconds`).pipe(
          Effect.zipRight(Queue.offer(reconcileQueue, "poll"))
        )
      ).pipe(Effect.annotateLogs({ service: "daemon-poll-loop" }))
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(reconcileQueue).pipe(
          Effect.flatMap((reason) =>
            globalReconcile(reason).pipe(
              Effect.annotateLogs({ reason, service: "daemon-reconcile-loop" })
            )
          )
        )
      ).pipe(Effect.annotateLogs({ service: "daemon-reconcile-loop" }))
    );

    if (process.env.REVIS_DAEMON_READY_STDOUT === "1") {
      // The parent CLI waits for this sentinel so it does not race the daemon startup path.
      yield* Effect.sync(() => {
        process.stdout.write(`${DAEMON_READY_LINE}\n`);
      });
    }

    // Kick the initial reconcile, then stay alive until an explicit shutdown request arrives.
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

/** Mirror the current workspace registry into the active session participant list. */
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

/** Return the daemon startup timeout for the configured sandbox provider. */
function daemonStartTimeoutMs(provider: DaemonState["sandboxProvider"]): number {
  return provider === "daytona" ? DAYTONA_START_TIMEOUT_MS : START_TIMEOUT_MS;
}
