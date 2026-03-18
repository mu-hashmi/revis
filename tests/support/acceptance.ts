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

interface TestRuntimeFailure {
  readonly _tag: "TestRuntimeFailure";
  readonly message: string;
}

/** Normalize raw promise failures into one small tagged shape for test helpers. */
function toRuntimeFailure(error: unknown): TestRuntimeFailure {
  return {
    _tag: "TestRuntimeFailure",
    message: error instanceof Error ? error.message : String(error)
  };
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
        yield* Effect.tryPromise({
          try: async () => {
            await initGitRepo(root);
            await gitCommit(root, "Initial commit");
          },
          catch: toRuntimeFailure
        }).pipe(Effect.orDie);

        // Always stop the daemon on scope close so failed acceptance cases do not leak background
        // processes into later tests or local development sessions.
        yield* Effect.addFinalizer(() =>
          Effect.tryPromise({
            try: async () => {
              const paths = makeProjectPaths(root);
              if (existsSync(paths.daemonStateFile)) {
                await runCli(["stop", "--all"], { allowFailure: true, cwd: root });
              }
            },
            catch: toRuntimeFailure
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
  return Effect.tryPromise({
    try: () =>
      waitUntil(async () => {
        // Poll the real CLI output so acceptance tests assert the operator-visible contract instead
        // of reading store files directly.
        const status = await runCli(["status"], { cwd: root });
        const parsed = parseWorkspaceStatuses(status.stdout);

        return predicate(parsed);
      }, { timeoutMs, intervalMs: 200 }),
    catch: toRuntimeFailure
  }).pipe(Effect.orDie);
}

/** Decode one persisted workspace snapshot from disk. */
export function loadWorkspaceSnapshot(path: string) {
  return Effect.tryPromise({
    try: () => readJsonFile<unknown>(path),
    catch: toRuntimeFailure
  }).pipe(
    Effect.flatMap((payload) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(WorkspaceSnapshot)(payload),
        catch: toRuntimeFailure
      })
    ),
    Effect.orDie
  );
}

/** Decode the live journal into typed runtime events. */
export function loadLiveEvents(path: string) {
  return Effect.tryPromise({
    try: () => readJsonLines<unknown>(path),
    catch: toRuntimeFailure
  }).pipe(
    Effect.flatMap((payload) =>
      Effect.try({
        try: () => {
          // Decode after the file read succeeds so parse failures point at the persisted journal
          // contents rather than being mixed into filesystem errors.
          const decode = Schema.decodeUnknownSync(RuntimeEventSchema);
          return payload.map((event) => decode(event));
        },
        catch: toRuntimeFailure
      })
    ),
    Effect.orDie
  );
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
