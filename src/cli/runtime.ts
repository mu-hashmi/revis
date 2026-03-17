/** Shared CLI runtime helpers for project resolution, output, and error reporting. */

import type * as CommandExecutor from "@effect/platform/CommandExecutor";
import type * as PlatformFileSystem from "@effect/platform/FileSystem";
import type * as PlatformPath from "@effect/platform/Path";
import * as Effect from "effect/Effect";

import {
  projectBootstrapLayer,
  projectLayer,
  type ProjectAppServices,
  type ProjectBootstrapServices,
  resolveProjectRoot
} from "../app/project-layer";
import { formatDomainError, ValidationError } from "../domain/errors";
import { hostGitLayer, type HostGitError } from "../git/host-git";

export interface CliWriters {
  readonly stderr?: (text: string) => void;
  readonly stdout?: (text: string) => void;
}

export type CliPlatform =
  | CommandExecutor.CommandExecutor
  | PlatformFileSystem.FileSystem
  | PlatformPath.Path;

/** Write one line to the provided stream. */
export function writeLine(
  write: (text: string) => void,
  text: string
): Effect.Effect<void> {
  return Effect.sync(() => {
    write(`${text}\n`);
  });
}

/** Resolve the current working directory to the enclosing repository root. */
export function resolveCurrentProjectRoot(): Effect.Effect<string, HostGitError, CliPlatform> {
  return resolveProjectRoot(process.cwd()).pipe(Effect.provide(hostGitLayer));
}

/** Run one effect against the full project layer for the current repository. */
export function withProject<A, E, R extends ProjectAppServices | CliPlatform>(
  run: () => Effect.Effect<A, E, R>
): Effect.Effect<A, E | HostGitError, CliPlatform> {
  return Effect.gen(function* () {
    const root = yield* resolveCurrentProjectRoot();
    return yield* (run().pipe(
      Effect.provide(projectLayer(root))
    ) as Effect.Effect<A, E | HostGitError, CliPlatform>);
  });
}

/** Run one effect against the bootstrap layer used before config exists. */
export function withProjectBootstrap<A, E, R extends ProjectBootstrapServices | CliPlatform>(
  root: string,
  run: () => Effect.Effect<A, E, R>
): Effect.Effect<A, E, CliPlatform> {
  return run().pipe(Effect.provide(projectBootstrapLayer(root))) as Effect.Effect<A, E, CliPlatform>;
}

/** Fetch one JSON payload from the daemon and fail with a typed validation error. */
export function fetchJson<A>(url: string): Effect.Effect<A, ValidationError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await response.text());
      }

      return (await response.json()) as A;
    },
    catch: (error) =>
      ValidationError.make({
        message: error instanceof Error ? error.message : String(error)
      })
  });
}

/** Print one formatted domain error and set the process exit code. */
export function reportErrors<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  writeErr: (text: string) => void
): Effect.Effect<A | void, never, R> {
  return effect.pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.exitCode = 1;
        writeErr(`${formatDomainError(error)}\n`);
      })
    )
  );
}
