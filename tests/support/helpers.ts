/** Generic temp-root, polling, and JSON helpers shared by the behavioral test suite. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** Create one temporary directory under the system temp root. */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Remove one directory tree without failing when it is already gone. */
export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** Acquire a temporary directory inside an Effect scope. */
export function makeTempDirScoped(prefix: string): Effect.Effect<string, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.promise(() => makeTempDir(prefix)).pipe(Effect.orDie),
    (path) =>
      Effect.promise(() => removeTree(path)).pipe(Effect.ignoreLogged, Effect.orDie)
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
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 100;

  const loop = (): Effect.Effect<B, E, R> =>
    Effect.gen(function* () {
      const value = yield* effect;
      const match = predicate(value);
      if (match) {
        return match;
      }

      if (Date.now() >= deadline) {
        return yield* Effect.dieMessage(`Timed out after ${options.timeoutMs}ms`);
      }

      // Use a real sleep here because these helpers back live-process tests as well as in-memory
      // orchestration tests.
      yield* Effect.promise(() => sleep(intervalMs)).pipe(Effect.orDie);
      return yield* loop();
    });

  return loop();
}

/** Sleep for a bounded amount of real time. */
export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
