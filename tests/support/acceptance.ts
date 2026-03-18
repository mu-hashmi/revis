/** Shared helpers for real CLI acceptance tests against temporary git repos. */

import { existsSync } from "node:fs";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import {
  RuntimeEventSchema,
  WorkspaceSnapshot
} from "../../src/domain/models";
import { makeProjectPaths } from "./factories";
import { gitCommit, initGitRepo } from "./git";
import { parseWorkspaceStatuses, runCli, type ParsedWorkspaceStatus } from "./cli";
import {
  makeTempDirScoped,
  readJsonFile,
  readJsonLines,
  waitUntil
} from "./helpers";

export interface AcceptanceProject {
  readonly paths: ReturnType<typeof makeProjectPaths>;
  readonly root: string;
}

/** Create one real git repo, register scoped daemon cleanup, and run one acceptance case. */
export function withAcceptanceProject(
  prefix: string,
  run: (project: AcceptanceProject) => Effect.Effect<void, unknown, Scope.Scope>
) {
  return makeTempDirScoped(prefix).pipe(
    Effect.flatMap((root) =>
      Effect.gen(function* () {
        // Acceptance tests own a real git repo because the CLI contracts are repo-shaped.
        yield* Effect.promise(async () => {
          await initGitRepo(root);
          await gitCommit(root, "Initial commit");
        }).pipe(Effect.orDie);

        // Always stop the daemon on scope close so failed acceptance cases do not leak background
        // processes into later tests or local development sessions.
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            const paths = makeProjectPaths(root);
            if (existsSync(paths.daemonStateFile)) {
              await runCli(["stop", "--all"], { allowFailure: true, cwd: root });
            }
          }).pipe(Effect.ignoreLogged)
        );

        return yield* run({
          root,
          paths: makeProjectPaths(root)
        });
      })
    )
  );
}

/** Poll `revis status` until the current workspace rows satisfy one predicate. */
export function waitForStatuses(
  root: string,
  predicate: (statuses: ReadonlyArray<ParsedWorkspaceStatus>) => ReadonlyArray<ParsedWorkspaceStatus> | null,
  timeoutMs = 15_000
) {
  return Effect.promise(() =>
    waitUntil(async () => {
      // Poll the real CLI output so acceptance tests assert the operator-visible contract instead
      // of reading store files directly.
      const status = await runCli(["status"], { cwd: root });
      const parsed = parseWorkspaceStatuses(status.stdout);

      return predicate(parsed);
    }, { timeoutMs, intervalMs: 200 })
  ).pipe(Effect.orDie);
}

/** Decode one persisted workspace snapshot from disk. */
export function loadWorkspaceSnapshot(path: string) {
  return Effect.promise(async () => {
    const payload = await readJsonFile<unknown>(path);
    return Schema.decodeUnknownSync(WorkspaceSnapshot)(payload);
  }).pipe(Effect.orDie);
}

/** Decode the live journal into typed runtime events. */
export function loadLiveEvents(path: string) {
  return Effect.promise(async () => {
    const payload = await readJsonLines<unknown>(path);
    const decode = Schema.decodeUnknownSync(RuntimeEventSchema);

    return payload.map((event) => decode(event));
  }).pipe(Effect.orDie);
}

/** Return whether one local process id still exists. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
