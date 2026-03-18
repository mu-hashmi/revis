/** Product-level acceptance tests that run the built CLI against a real temporary git repo. */

import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RevisConfig, asAgentId, type WorkspaceSnapshot } from "../../src/domain/models";
import { TRUNK_BRANCH, workspaceBranch } from "../../src/git/branch-names";
import { runCli } from "../support/cli";
import {
  loadLiveEvents,
  loadWorkspaceSnapshot,
  processExists,
  waitForStatuses,
  withAcceptanceProject
} from "../support/acceptance";
import { commitAndExitFixture, writeAndSleepFixture } from "../support/fixtures";
import { runGit } from "../support/git";
import { readJsonFile, waitUntil } from "../support/helpers";

describe("Revis CLI acceptance", () => {
  it.scopedLive("initializes a fresh repo with the expected defaults and coordination remote", () =>
    withAcceptanceProject("revis-accept-init-", ({ root, paths }) =>
      Effect.gen(function* () {
        // Initialize Revis and collect the on-disk artifacts it is expected to own.
        const result = yield* Effect.tryPromise(() => runCli(["init"], { cwd: root })).pipe(
          Effect.orDie
        );
        const config = yield* Effect.tryPromise(async () => {
          const payload = await readJsonFile<unknown>(paths.configFile);
          return Schema.decodeUnknownSync(RevisConfig)(payload);
        }).pipe(Effect.orDie);
        const gitignore = yield* Effect.tryPromise(() =>
          readFile(`${root}/.gitignore`, "utf8")
        ).pipe(Effect.orDie);
        const expectedRemotePath = yield* Effect.tryPromise(() =>
          realpath(`${root}/.revis/coordination.git`)
        ).pipe(Effect.orDie);
        const remoteUrl = yield* Effect.tryPromise(() =>
          runGit(root, ["remote", "get-url", "revis-local"])
        ).pipe(Effect.orDie);
        const trunkHead = yield* Effect.tryPromise(() =>
          runGit(root, [
            "--git-dir",
            `${root}/.revis/coordination.git`,
            "rev-parse",
            `refs/heads/${TRUNK_BRANCH}`
          ])
        ).pipe(Effect.orDie);

        // Verify both the user-visible output and the actual repo/bootstrap state.
        awaitSuccess(remoteUrl);
        awaitSuccess(trunkHead);

        expect(result.stdout).toContain("Initialized Revis in ");
        expect(config).toStrictEqual(
          RevisConfig.make({
            coordinationRemote: "revis-local",
            trunkBase: "main",
            remotePollSeconds: 5,
            sandboxProvider: "local"
          })
        );
        expect(gitignore).toContain(".revis/state/");
        expect(gitignore).toContain(".revis/workspaces/");
        expect(remoteUrl.stdout.trim()).toBe(expectedRemotePath);
        expect(trunkHead.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
      })
    )
  );

  it.scopedLive("spawns two local workspaces and status reports both as running", () =>
    withAcceptanceProject("revis-accept-spawn-", ({ root }) =>
      Effect.gen(function* () {
        // Start a real daemon and two bounded local sessions.
        yield* Effect.tryPromise(() => runCli(["init"], { cwd: root })).pipe(Effect.orDie);
        yield* Effect.tryPromise(() =>
          runCli(["spawn", "--exec", writeAndSleepFixture(".revis-test/running.log", 3), "2"], {
            cwd: root
          })
        ).pipe(Effect.orDie);

        // Poll `revis status` instead of sleeping so the test follows the daemon's real timing.
        const statuses = yield* waitForStatuses(
          root,
          (current) =>
            current.length === 2 && current.every((workspace) => workspace.state === "Running")
              ? current
              : null
        );

        expect(statuses.map((workspace) => workspace.agentId)).toStrictEqual([
          "agent-1",
          "agent-2"
        ]);
        expect(statuses.every((workspace) => workspace.iteration >= 1)).toBe(true);
      })
    )
  );

  it.scopedLive("restarts an exited workspace and records the lifecycle events in order", () =>
    withAcceptanceProject("revis-accept-restart-", ({ root, paths }) =>
      Effect.gen(function* () {
        // Use a bounded commit-and-exit fixture so the daemon must observe one clean exit and one
        // restart without the test hanging on a long-lived process.
        yield* Effect.tryPromise(() => runCli(["init"], { cwd: root })).pipe(Effect.orDie);
        yield* Effect.tryPromise(() =>
          runCli(["spawn", "--exec", commitAndExitFixture("acceptance work"), "1"], { cwd: root })
        ).pipe(Effect.orDie);

        // The product contract here is visible through status and the persisted journal, not
        // through supervisor internals.
        const statuses = yield* waitForStatuses(
          root,
          (current) => {
            const workspace = current.find((entry) => entry.agentId === "agent-1");
            return workspace && workspace.iteration > 1 ? current : null;
          },
          15_000
        );
        const events = yield* loadLiveEvents(paths.liveJournalFile);

        expect(statuses.find((workspace) => workspace.agentId === "agent-1")?.iteration).toBeGreaterThan(1);

        const agentTags = events.flatMap((event) =>
          "agentId" in event && event.agentId === "agent-1" ? [event._tag] : []
        );
        const firstStart = agentTags.indexOf("IterationStarted");
        const firstExit = agentTags.indexOf("IterationExited");
        const restart = agentTags.indexOf("WorkspaceRestarted");
        const secondStart = agentTags.indexOf("IterationStarted", firstExit + 1);

        expect(firstStart).toBeGreaterThanOrEqual(0);
        expect(firstExit).toBeGreaterThan(firstStart);
        expect(restart).toBeGreaterThan(firstExit);
        expect(secondStart).toBeGreaterThan(restart);
      })
    )
  );

  it.scopedLive("stops the daemon, removes workspace runtimes, and leaves no tracked process behind", () =>
    withAcceptanceProject("revis-accept-stop-", ({ root, paths }) =>
      Effect.gen(function* () {
        // Start one long enough-lived workspace so `stop --all` has real runtime state to clean up.
        yield* Effect.tryPromise(() => runCli(["init"], { cwd: root })).pipe(Effect.orDie);
        yield* Effect.tryPromise(() =>
          runCli(["spawn", "--exec", writeAndSleepFixture(".revis-test/hold.log", 30), "1"], {
            cwd: root
          })
        ).pipe(Effect.orDie);

        yield* waitForStatuses(
          root,
          (current) =>
            current.length === 1 && current[0]?.state === "Running" ? current : null
        );

        const snapshot = yield* loadWorkspaceSnapshot(paths.workspaceStateFile("agent-1"));
        const pid = runningSessionPid(snapshot);

        // Verify shutdown by polling the persisted daemon/runtime state instead of relying on a
        // fixed sleep. The daemon can exit at slightly different times across machines.
        yield* Effect.tryPromise(() => runCli(["stop", "--all"], { cwd: root })).pipe(Effect.orDie);
        yield* Effect.tryPromise(() =>
          waitUntil(
            async () =>
              !existsSync(paths.daemonStateFile) &&
              !existsSync(paths.workspaceRuntimeDir("agent-1")) &&
              !processExists(pid)
                ? true
                : null,
            { timeoutMs: 10_000, intervalMs: 200 }
          )
        ).pipe(Effect.orDie);

        const status = yield* Effect.tryPromise(() => runCli(["status"], { cwd: root })).pipe(
          Effect.orDie
        );

        expect(status.stdout).toContain("Daemon: offline");
        expect(status.stdout).toContain("No workspaces.");
      })
    )
  );

  it.scopedLive("promotes a workspace branch into the local managed trunk", () =>
    withAcceptanceProject("revis-accept-promote-", ({ root, paths }) =>
      Effect.gen(function* () {
        const branch = workspaceBranch("tester", asAgentId("agent-1"));

        // Capture the managed trunk ref before any workspace work happens.
        yield* Effect.tryPromise(() => runCli(["init"], { cwd: root })).pipe(Effect.orDie);

        const trunkBefore = yield* Effect.tryPromise(() =>
          runGit(root, [
            "--git-dir",
            `${paths.revisDir}/coordination.git`,
            "rev-parse",
            `refs/heads/${TRUNK_BRANCH}`
          ])
        ).pipe(Effect.orDie);

        // Wait for the workspace branch to exist on the coordination remote before promoting it.
        yield* Effect.tryPromise(() =>
          runCli(["spawn", "--exec", commitAndExitFixture("promotion work"), "1"], { cwd: root })
        ).pipe(Effect.orDie);
        yield* waitForStatuses(
          root,
          (current) => {
            const workspace = current.find((entry) => entry.agentId === "agent-1");
            return workspace && workspace.iteration > 1 ? current : null;
          },
          15_000
        );
        yield* Effect.tryPromise(() =>
          waitUntil(async () => {
            const branchRef = await runGit(root, [
              "--git-dir",
              `${paths.revisDir}/coordination.git`,
              "rev-parse",
              `refs/heads/${branch}`
            ]);

            return branchRef.exitCode === 0 ? branchRef.stdout.trim() : null;
          }, { timeoutMs: 10_000, intervalMs: 200 })
        ).pipe(Effect.orDie);

        // Promotion should advance trunk and make the workspace branch an ancestor of it.
        const result = yield* Effect.tryPromise(() => runCli(["promote", "agent-1"], { cwd: root })).pipe(
          Effect.orDie
        );
        const trunkAfter = yield* Effect.tryPromise(() =>
          runGit(root, [
            "--git-dir",
            `${paths.revisDir}/coordination.git`,
            "rev-parse",
            `refs/heads/${TRUNK_BRANCH}`
          ])
        ).pipe(Effect.orDie);
        const ancestry = yield* Effect.tryPromise(() =>
          runGit(root, [
            "--git-dir",
            `${paths.revisDir}/coordination.git`,
            "merge-base",
            "--is-ancestor",
            `refs/heads/${branch}`,
            `refs/heads/${TRUNK_BRANCH}`
          ])
        ).pipe(Effect.orDie);

        awaitSuccess(trunkBefore);
        awaitSuccess(trunkAfter);

        expect(result.stdout).toContain(`Promoted ${branch} into ${TRUNK_BRANCH}`);
        expect(trunkAfter.stdout.trim()).not.toBe(trunkBefore.stdout.trim());
        expect(ancestry.exitCode).toBe(0);
      })
    )
  );
});

/** Extract the detached local pid from one running workspace snapshot. */
function runningSessionPid(snapshot: WorkspaceSnapshot): number {
  if (snapshot.state._tag !== "Running") {
    throw new Error(`Expected Running workspace, got ${snapshot.state._tag}`);
  }

  return Number.parseInt(snapshot.state.sessionId, 10);
}

/** Fail loudly when a helper git command did not succeed. */
function awaitSuccess(result: Awaited<ReturnType<typeof runGit>>): void {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(result.stderr.trim() || result.stdout.trim() || "command failed");
}
