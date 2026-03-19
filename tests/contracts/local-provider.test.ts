/** Behavioral contract tests for the live local `WorkspaceProvider`. */

import { access } from "node:fs/promises";

import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import {
  RestartPendingState,
  RunningState,
  WorkspaceSnapshot,
  WorkspaceSpec,
  asAgentId,
  asBranchName,
  asOperatorSlug,
  asRevision,
  asTimestamp,
  asWorkspaceSessionId
} from "../../src/domain/models";
import { TRUNK_BRANCH, workspaceBranch, workspaceEmail } from "../../src/git/branch-names";
import { HostGit, hostGitLayer } from "../../src/git/host-git";
import { localWorkspaceProviderLayer } from "../../src/providers/local";
import { WorkspaceProvider } from "../../src/providers/contract";
import { ProjectPaths, projectPathsLayer } from "../../src/services/project-paths";
import { assertSuccess, initGitRepo, runGit } from "../support/git";
import { makeTempDirScoped, waitUntilEffect } from "../support/helpers";

interface TestRuntimeFailure {
  readonly _tag: "TestRuntimeFailure";
  readonly message: string;
}

function toRuntimeFailure(error: unknown): TestRuntimeFailure {
  return {
    _tag: "TestRuntimeFailure",
    message: error instanceof Error ? error.message : String(error)
  };
}

describe("local WorkspaceProvider", () => {
  it.scopedLive("provisions a local clone on the expected branch with the workspace identity", () =>
    withLocalProvider("revis-local-provider-provision-", "printf 'hello\\n' && exit 0", (root) =>
      Effect.gen(function* () {
        const hostGit = yield* HostGit;
        const paths = yield* ProjectPaths;
        const provider = yield* WorkspaceProvider;
        const remoteUrl = yield* hostGit.ensureCoordinationRemote(root);

        yield* hostGit.bootstrapCoordinationRemote(root, "revis-local", remoteUrl, "main");

        // Provision through the real provider so the assertions cover clone layout, branch
        // creation, and workspace git identity together.
        const provisioned = yield* provider.provision({
          root,
          remoteName: "revis-local",
          remoteUrl,
          syncBranch: TRUNK_BRANCH,
          operatorSlug: asOperatorSlug("operator-1"),
          agentId: asAgentId("agent-1"),
          coordinationBranch: workspaceBranch("operator-1", asAgentId("agent-1")),
          execCommand: "printf 'hello\\n' && exit 0"
        });

        expect(provisioned.workspaceRoot).toBe(paths.workspaceRepoDir("agent-1"));
        expect(provisioned.localBranch).toBe(asBranchName("revis/operator-1/agent-1/work"));

        const branch = yield* Effect.tryPromise({
          try: () => runGit(provisioned.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
          catch: toRuntimeFailure
        }).pipe(Effect.orDie);
        const email = yield* Effect.tryPromise({
          try: () => runGit(provisioned.workspaceRoot, ["config", "user.email"]),
          catch: toRuntimeFailure
        }).pipe(Effect.orDie);

        // Verify the user-visible branch shape and the git identity that later commits will carry.
        expect(branch.stdout.trim()).toBe("revis/operator-1/agent-1/work");
        expect(email.stdout.trim()).toBe(workspaceEmail("operator-1", asAgentId("agent-1")));
      })
    )
  );

  it.scopedLive("reports a running session, then an exited session with its exit code", () =>
    withLocalProvider("revis-local-provider-session-", "printf 'hello\\n' && sleep 0.2 && exit 7", (root) =>
      Effect.gen(function* () {
        const snapshot = yield* provisionWorkspaceSnapshot(root, "printf 'hello\\n' && sleep 0.2 && exit 7");
        const provider = yield* WorkspaceProvider;
        const sessionId = yield* provider.startIteration(snapshot);
        const running = runningSnapshot(snapshot, sessionId);

        // Poll for the transient running state first so the test proves the provider does not jump
        // straight from start to exit.
        const runningStatus = yield* waitUntilEffect(
          provider.inspectSession(running),
          (status) => (status.phase === "running" ? status : null),
          { timeoutMs: 2_000, intervalMs: 25 }
        );

        // Then keep polling until the wrapper writes the exit file and the provider surfaces the
        // final status code.
        const exitedStatus = yield* waitUntilEffect(
          provider.inspectSession(running),
          (status) => (status.phase === "exited" ? status : null),
          { timeoutMs: 5_000, intervalMs: 50 }
        );

        expect(runningStatus.phase).toBe("running");
        expect(exitedStatus).toStrictEqual({ phase: "exited", exitCode: 7 });
      })
    )
  );

  it.scopedLive("captures activity lines and destroys the workspace runtime", () =>
    withLocalProvider(
      "revis-local-provider-activity-",
      "printf 'line-one\\nline-two\\n' && sleep 5",
      (root) =>
        Effect.gen(function* () {
          const snapshot = yield* provisionWorkspaceSnapshot(
            root,
            "printf 'line-one\\nline-two\\n' && sleep 5"
          );
          const provider = yield* WorkspaceProvider;
          const paths = yield* ProjectPaths;
          const sessionId = yield* provider.startIteration(snapshot);
          const running = runningSnapshot(snapshot, sessionId);

          // Wait for the second line so the log tail assertion exercises the persisted session log,
          // not a race against process startup.
          yield* waitUntilEffect(
            provider.captureActivity(running),
            (lines) => (lines.includes("line-two") ? lines : null),
            { timeoutMs: 2_000, intervalMs: 25 }
          );

          const activity = yield* provider.captureActivity(running);
          yield* provider.destroyWorkspace(running);

          // Destroying the workspace should remove the entire runtime tree after interrupting the
          // detached process.
          const runtimeRemoved = yield* Effect.tryPromise({
            try: async () => {
              try {
                await access(paths.workspaceRuntimeDir(snapshot.agentId));
                return false;
              } catch {
                return true;
              }
            },
            catch: toRuntimeFailure
          }).pipe(Effect.orDie);

          expect(activity).toEqual(expect.arrayContaining(["line-one", "line-two"]));
          expect(runtimeRemoved).toBe(true);
        })
    )
  );
});

/** Build one live local-provider stack inside a temporary git repo. */
function withLocalProvider(
  prefix: string,
  execCommand: string,
  run: (
    root: string
  ) => Effect.Effect<void, unknown, HostGit | ProjectPaths | WorkspaceProvider | Scope.Scope>
) {
  return makeTempDirScoped(prefix).pipe(
    Effect.flatMap((root) => {
      const layer = makeLocalProviderLayer(root, execCommand);

      return Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: async () => {
            await initGitRepo(root);
            await assertSuccess(
              await runGit(root, ["commit", "--allow-empty", "-m", "Initial commit"])
            );
          },
          catch: toRuntimeFailure
        }).pipe(Effect.orDie);

        const hostGit = yield* HostGit;
        const remoteUrl = yield* hostGit.ensureCoordinationRemote(root);

        yield* hostGit.bootstrapCoordinationRemote(root, "revis-local", remoteUrl, "main");

        return yield* run(root).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(layer));
    })
  );
}

/** Compose the Node platform, project paths, host git, and local provider layers for one test. */
function makeLocalProviderLayer(root: string, _execCommand: string) {
  const platformLayer = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layerUndici);
  const pathsLayer = projectPathsLayer(root).pipe(Layer.provide(platformLayer));
  const hostLayer = hostGitLayer.pipe(Layer.provide(platformLayer));
  const foundationLayer = Layer.mergeAll(platformLayer, pathsLayer, hostLayer);
  const providerLayer = localWorkspaceProviderLayer.pipe(Layer.provide(foundationLayer));

  return Layer.mergeAll(foundationLayer, providerLayer);
}

/** Provision one workspace and express it as the snapshot shape the daemon uses. */
function provisionWorkspaceSnapshot(root: string, execCommand: string) {
  return Effect.gen(function* () {
    const hostGit = yield* HostGit;
    const provider = yield* WorkspaceProvider;
    const remoteUrl = yield* hostGit.ensureCoordinationRemote(root);
    const provisioned = yield* provider.provision({
      root,
      remoteName: "revis-local",
      remoteUrl,
      syncBranch: TRUNK_BRANCH,
      operatorSlug: asOperatorSlug("operator-1"),
      agentId: asAgentId("agent-1"),
      coordinationBranch: workspaceBranch("operator-1", asAgentId("agent-1")),
      execCommand
    });

    return WorkspaceSnapshot.make({
      spec: WorkspaceSpec.make({
        agentId: asAgentId("agent-1"),
        operatorSlug: asOperatorSlug("operator-1"),
        coordinationBranch: workspaceBranch("operator-1", asAgentId("agent-1")),
        localBranch: provisioned.localBranch,
        workspaceRoot: provisioned.workspaceRoot,
        execCommand,
        sandboxProvider: "local",
        createdAt: asTimestamp("2026-03-18T00:00:00.000Z"),
        attachCmd: provisioned.attachCmd ? [...provisioned.attachCmd] : undefined,
        attachLabel: provisioned.attachLabel
      }),
      state: RestartPendingState.make({
        iteration: 0,
        lastCommitSha: provisioned.head,
        lastRebasedOntoSha: provisioned.head
      })
    });
  });
}

/** Promote one restart-pending snapshot into a running snapshot with the provided session id. */
function runningSnapshot(
  snapshot: WorkspaceSnapshot,
  sessionId: ReturnType<typeof asWorkspaceSessionId>
) {
  return WorkspaceSnapshot.make({
    spec: snapshot.spec,
    state: RunningState.make({
      iteration: 1,
      sessionId,
      startedAt: asTimestamp("2026-03-18T00:00:01.000Z"),
      lastCommitSha: snapshot.state.lastCommitSha ?? asRevision("1111111111111111111111111111111111111111"),
      lastRebasedOntoSha:
        snapshot.state.lastRebasedOntoSha ??
        snapshot.state.lastCommitSha ??
        asRevision("1111111111111111111111111111111111111111")
    })
  });
}
