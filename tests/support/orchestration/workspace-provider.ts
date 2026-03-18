/** Fake `WorkspaceProvider` service backed by the orchestration model state. */

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { providerError } from "../../../src/domain/errors";
import {
  type AgentId,
  type Revision,
  asWorkspaceSessionId
} from "../../../src/domain/models";
import { remoteTrackingRef } from "../../../src/git/branch-names";
import type {
  WorkspaceProviderApi,
  WorkspaceSessionStatus
} from "../../../src/providers/contract";
import {
  currentWorkspaceRuntime,
  type OrchestrationState,
  requireWorkspace,
  setRemoteRef,
  setWorkspaceState
} from "./model";

/** Build the workspace provider service for one orchestration test harness. */
export function buildWorkspaceProviderService(
  state: OrchestrationState
): WorkspaceProviderApi {
  return {
    kind: "local",
    provision: (params) =>
      Effect.gen(function* () {
        // Provisioning creates only the runtime model; the workflow under test is responsible for
        // persisting the resulting snapshot into the workspace store.
        const workspaceRoot = state.paths.workspaceRepoDir(params.agentId);
        const remoteRefs = yield* Ref.get(state.remoteRefsRef);
        const syncSha = remoteRefs.get(params.remoteName)?.get(params.syncBranch);

        if (!syncSha) {
          return yield* providerError(
            "local",
            "provision",
            `Missing ${params.remoteName}/${params.syncBranch}`
          );
        }

        yield* Ref.update(state.workspaceRef, (current) => {
          const next = new Map(current);

          next.set(params.agentId, {
            agentId: params.agentId,
            workspaceRoot,
            coordinationBranch: params.coordinationBranch,
            currentBranch: params.coordinationBranch,
            head: syncSha,
            subject: `Provisioned ${params.agentId}`,
            dirty: false,
            destroyed: false,
            sessions: [],
            activityLines: [],
            rebasePlan: null,
            aheadCounts: new Map(),
            remoteTrackingRefs: new Map([
              [remoteTrackingRef(params.remoteName, params.syncBranch), syncSha]
            ])
          });

          return next;
        });

        return {
          workspaceRoot,
          localBranch: params.coordinationBranch,
          head: syncSha,
          attachCmd: ["tail", "-f", state.paths.workspaceLogFile(params.agentId)],
          attachLabel: state.paths.workspaceLogFile(params.agentId)
        };
      }),
    startIteration: (snapshot) =>
      Effect.gen(function* () {
        // Session ids stay deterministic so tests can reason about restart order.
        const workspace = yield* requireWorkspace(state, snapshot.agentId);
        const sessionId = asWorkspaceSessionId(
          `${snapshot.agentId}-session-${workspace.sessions.length + 1}`
        );

        yield* setWorkspaceState(state, snapshot.agentId, (current) => ({
          ...current,
          sessions: [
            ...current.sessions,
            {
              id: sessionId,
              phase: "running"
            }
          ]
        }));

        return sessionId;
      }),
    inspectSession: (snapshot) =>
      currentWorkspaceRuntime(state, snapshot.agentId).pipe(
        Effect.map((workspace) => {
          const currentState = snapshot.state;

          // Mirror the real provider contract: only running snapshots have an inspectable session.
          if (currentState._tag !== "Running") {
            return { phase: "missing" } satisfies WorkspaceSessionStatus;
          }

          if (!workspace) {
            return { phase: "missing" } satisfies WorkspaceSessionStatus;
          }

          const session = workspace.sessions.find(
            (current) => current.id === currentState.sessionId
          );

          if (!session) {
            return { phase: "missing" } satisfies WorkspaceSessionStatus;
          }

          return session.phase === "running"
            ? ({ phase: "running" } satisfies WorkspaceSessionStatus)
            : session.exitCode === undefined
              ? ({ phase: "exited" } satisfies WorkspaceSessionStatus)
              : ({
                  phase: "exited",
                  exitCode: session.exitCode
                } satisfies WorkspaceSessionStatus);
        })
      ),
    captureActivity: (snapshot) =>
      currentWorkspaceRuntime(state, snapshot.agentId).pipe(
        Effect.map((workspace) => workspace?.activityLines ?? [])
      ),
    runInWorkspace: (snapshot, argv) =>
      Effect.gen(function* () {
        const workspace = yield* requireWorkspace(state, snapshot.agentId);

        // Fail loudly on unknown commands so production git-flow changes break tests immediately
        // instead of silently taking an unrealistic happy path.
        if (argv[0] !== "git") {
          return yield* providerError(
            "local",
            "run command",
            `Unsupported command: ${argv.join(" ")}`
          );
        }

        switch (argv.join("\u0000")) {
          // Read-only probes used by status loading and reconcile bookkeeping.
          case "git\u0000rev-parse\u0000HEAD":
            return {
              stdout: `${workspace.head}\n`,
              stderr: "",
              exitCode: 0
            };
          case "git\u0000rev-parse\u0000--abbrev-ref\u0000HEAD":
            return {
              stdout: `${workspace.currentBranch}\n`,
              stderr: "",
              exitCode: 0
            };
          case "git\u0000status\u0000--porcelain":
            return {
              stdout: workspace.dirty ? " M file.txt\n" : "",
              stderr: "",
              exitCode: 0
            };
          case "git\u0000log\u0000-1\u0000--pretty=%s\u0000HEAD":
            return {
              stdout: `${workspace.subject}\n`,
              stderr: "",
              exitCode: 0
            };
        }

        if (argv[1] === "fetch" && argv[2] === "--prune" && argv[3] !== undefined) {
          // Fetch copies the remote view into the workspace-local tracking refs.
          const remoteName = argv[3];
          const refs = yield* Ref.get(state.remoteRefsRef);
          const fetchedEntries = [...(refs.get(remoteName) ?? new Map<string, Revision>()).entries()]
            .map(
              ([branch, sha]): readonly [string, Revision] => [
                remoteTrackingRef(remoteName, branch),
                sha
              ]
            );

          yield* setWorkspaceState(state, snapshot.agentId, (current) => ({
            ...current,
            remoteTrackingRefs: new Map([
              ...current.remoteTrackingRefs.entries(),
              ...fetchedEntries
            ])
          }));

          return {
            stdout: "",
            stderr: "",
            exitCode: 0
          };
        }

        if (argv[1] === "push" && argv.at(-2) && argv.at(-1)?.startsWith("HEAD:refs/heads/")) {
          // Publishing updates both the remote branch store and the workspace's tracking ref.
          const remoteName = argv.at(-2)!;
          const branch = argv.at(-1)!.replace("HEAD:refs/heads/", "");

          yield* setRemoteRef(state, remoteName, branch, workspace.head);
          yield* setWorkspaceState(state, snapshot.agentId, (current) => ({
            ...current,
            remoteTrackingRefs: new Map(current.remoteTrackingRefs).set(
              remoteTrackingRef(remoteName, branch),
              current.head
            )
          }));

          return {
            stdout: "",
            stderr: "",
            exitCode: 0
          };
        }

        if (argv[1] === "rebase" && argv[2] === "--abort") {
          return {
            stdout: "",
            stderr: "",
            exitCode: 0
          };
        }

        if (argv[1] === "rebase" && argv[2]) {
          // Rebase uses the configured plan so tests can force success or conflict deterministically.
          const targetRef = remoteTrackingRef(
            argv[2].split("/")[0]!,
            argv[2].split("/").slice(1).join("/")
          );
          const targetSha = workspace.remoteTrackingRefs.get(targetRef);

          if (!targetSha) {
            return {
              stdout: "",
              stderr: `Missing ${targetRef}`,
              exitCode: 1
            };
          }

          if (workspace.rebasePlan?._tag === "conflict") {
            return {
              stdout: "",
              stderr: workspace.rebasePlan.detail,
              exitCode: 1
            };
          }

          const nextHead =
            workspace.rebasePlan?._tag === "success" && workspace.rebasePlan.head
              ? workspace.rebasePlan.head
              : targetSha;

          yield* setWorkspaceState(state, snapshot.agentId, (current) => ({
            ...current,
            head: nextHead,
            subject: `Rebased ${snapshot.agentId}`,
            dirty: false,
            rebasePlan: null
          }));

          return {
            stdout: "",
            stderr: "",
            exitCode: 0
          };
        }

        if (argv[1] === "rev-list" && argv[2] === "--count" && argv[3]?.endsWith("..HEAD")) {
          // Tests can override ahead counts explicitly, but default to a simple head comparison.
          const baseRef = argv[3].replace(/\.\.HEAD$/, "");
          const explicit = workspace.aheadCounts.get(baseRef);
          const baseSha = workspace.remoteTrackingRefs.get(baseRef);
          const count = explicit ?? (baseSha === workspace.head ? 0 : 1);

          return {
            stdout: `${count}\n`,
            stderr: "",
            exitCode: 0
          };
        }

        return yield* providerError(
          "local",
          "run command",
          `Unsupported git argv: ${argv.join(" ")}`
        );
      }),
    interruptIteration: (snapshot) =>
      setWorkspaceState(state, snapshot.agentId, (workspace) => ({
        ...workspace,
        sessions: workspace.sessions.map((session, index) =>
          index === workspace.sessions.length - 1
            ? {
                ...session,
                phase: "exited",
                exitCode: 130
              }
            : session
        )
      })).pipe(
        // Interrupt is best-effort in the live provider too, so missing workspaces should not
        // derail higher-level shutdown tests.
        Effect.catchAllCause(() => Effect.void)
      ),
    destroyWorkspace: (snapshot) =>
      setWorkspaceState(state, snapshot.agentId, (workspace) => ({
        ...workspace,
        destroyed: true,
        sessions: workspace.sessions.map((session, index) =>
          index === workspace.sessions.length - 1 && session.phase === "running"
            ? {
                ...session,
                phase: "exited",
                exitCode: 143
              }
            : session
        )
      }))
  };
}
