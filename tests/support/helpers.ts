/** Generic temp-root, polling, and JSON helpers shared by the behavioral test suite. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/TestClock";

/** Create one temporary directory under the system temp root. */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Remove one directory tree without failing when it is already gone. */
export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

interface TestRuntimeFailure {
  readonly _tag: "TestRuntimeFailure";
  readonly message: string;
}

/** Normalize raw promise failures into one small tagged shape for helper effects. */
function toRuntimeFailure(error: unknown): TestRuntimeFailure {
  return {
    _tag: "TestRuntimeFailure",
    message: error instanceof Error ? error.message : String(error)
  };
}

/** Acquire a temporary directory inside an Effect scope. */
export function makeTempDirScoped(prefix: string): Effect.Effect<string, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => makeTempDir(prefix),
      catch: toRuntimeFailure
    }).pipe(Effect.orDie),
    (path) =>
      Effect.tryPromise({
        try: () => removeTree(path),
        catch: toRuntimeFailure
      }).pipe(Effect.ignoreLogged, Effect.orDie)
  );
}

/** Read and parse one JSON file. */
export async function readJsonFile<A>(path: string): Promise<A> {
  return JSON.parse(await readFile(path, "utf8")) as A;
}

/** Read and parse one JSONL file into an ordered list of entries. */
export async function readJsonLines<A>(path: string): Promise<ReadonlyArray<A>> {
  const payload = await readFile(path, "utf8");

  return payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as A);
}

export interface WaitUntilOptions {
  readonly timeoutMs: number;
  readonly intervalMs?: number;
}

/** Poll one predicate until it returns a truthy value or times out. */
export async function waitUntil<A>(
  predicate: () => Promise<A | null | undefined | false>,
  options: WaitUntilOptions
): Promise<A> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 100;

  while (Date.now() < deadline) {
    // Treat any truthy return as success so callers can return the matched value directly.
    const result = await predicate();
    if (result) {
      return result;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${options.timeoutMs}ms`);
}

/** Poll one Effect until it yields a matching value or times out. */
export function waitUntilEffect<A, B extends A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => B | null,
  options: WaitUntilOptions
): Effect.Effect<B, E, R> {
  const intervalMs = options.intervalMs ?? 100;

  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + options.timeoutMs;
    const testClock = yield* Effect.serviceOption(TestClock.TestClock);

    const loop = (): Effect.Effect<B, E, R> =>
      Effect.gen(function* () {
        // Run the effect first so the predicate always sees the freshest observable state.
        const value = yield* effect;
        const match = predicate(value);
        if (match) {
          return match;
        }

        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* Effect.dieMessage(`Timed out after ${options.timeoutMs}ms`);
        }

        // Scoped Effect tests can advance virtual time; live acceptance helpers still need a real
        // sleep branch so the same helper works in both environments.
        if (Option.isSome(testClock)) {
          yield* TestClock.adjust(intervalMs);
        } else {
          yield* Effect.sleep(intervalMs);
        }

        return yield* loop();
      });

    return yield* loop();
  });
}

/** Sleep for a bounded amount of real time. */
export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
