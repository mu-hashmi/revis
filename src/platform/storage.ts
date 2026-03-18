/** Shared JSON and JSONL persistence helpers for Effect Platform file storage. */

import type * as PlatformFileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { StorageError, storageError } from "../domain/errors";

/** Create one directory tree and surface filesystem failures as `StorageError`. */
export function ensureDirectory(
  fs: PlatformFileSystem.FileSystem,
  path: string
): Effect.Effect<void, StorageError> {
  return fs.makeDirectory(path, { recursive: true }).pipe(
    Effect.mapError((error) => storageError(path, error.message))
  );
}

/** Remove one file path without failing when it is already absent. */
export function removeFile(
  fs: PlatformFileSystem.FileSystem,
  path: string
): Effect.Effect<void, StorageError> {
  return fs.remove(path, { force: true }).pipe(
    Effect.mapError((error) => storageError(path, error.message))
  );
}

/** Read and decode one JSON file through the provided schema. */
export function readJsonFile<A, I>(
  fs: PlatformFileSystem.FileSystem,
  path: string,
  schema: Schema.Schema<A, I>
): Effect.Effect<A, StorageError> {
  return fs.readFileString(path).pipe(
    Effect.mapError((error) => storageError(path, error.message)),
    Effect.flatMap((payload) =>
      Schema.decodeUnknown(Schema.parseJson(schema))(payload).pipe(
        Effect.mapError((error) => storageError(path, String(error)))
      )
    )
  );
}

/** Read and decode one JSON file when present, or return `Option.none()` when absent. */
export function readJsonFileIfExists<A, I>(
  fs: PlatformFileSystem.FileSystem,
  path: string,
  schema: Schema.Schema<A, I>
): Effect.Effect<Option.Option<A>, StorageError> {
  return fs.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catchTag("SystemError", (error) =>
      error.reason === "NotFound" ? Effect.succeed(Option.none<string>()) : Effect.fail(error)
    ),
    Effect.mapError((error) => storageError(path, error.message)),
    Effect.flatMap((payload) =>
      // Preserve file absence as `Option.none()` at the storage boundary so callers do not need
      // to round-trip through ad-hoc `null` sentinels.
      Option.match(payload, {
        onNone: () => Effect.succeed(Option.none<A>()),
        onSome: (json) =>
          Schema.decodeUnknown(Schema.parseJson(schema))(json).pipe(
            Effect.map(Option.some),
            Effect.mapError((error) => storageError(path, String(error)))
          )
      })
    )
  );
}

/** Encode and atomically replace one JSON file. */
export function writeJsonFile<A, I>(
  fs: PlatformFileSystem.FileSystem,
  path: string,
  schema: Schema.Schema<A, I>,
  payload: A
): Effect.Effect<void, StorageError> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  return Effect.gen(function* () {
    const encoded = yield* Schema.encode(Schema.parseJson(schema))(payload).pipe(
      Effect.mapError((error) => storageError(path, String(error)))
    );

    // Write to a temp file first so readers never observe a truncated JSON document.
    yield* fs.writeFileString(tempPath, `${encoded}\n`).pipe(
      Effect.mapError((error) => storageError(tempPath, error.message))
    );

    yield* fs.rename(tempPath, path).pipe(
      Effect.mapError((error) => storageError(path, error.message))
    );
  });
}

/** Read, decode, and optionally tail-limit a JSONL file. */
export function readJsonLines<A, I>(
  fs: PlatformFileSystem.FileSystem,
  path: string,
  schema: Schema.Schema<A, I>,
  limit?: number
): Effect.Effect<ReadonlyArray<A>, StorageError> {
  return fs.readFileString(path).pipe(
    Effect.catchTag("SystemError", (error) =>
      error.reason === "NotFound" ? Effect.succeed("") : Effect.fail(error)
    ),
    Effect.catchTag("BadArgument", (error) =>
      Effect.fail(storageError(path, error.message))
    ),
    Effect.mapError((error) => storageError(path, error.message)),
    Effect.flatMap((payload) =>
      Effect.forEach(
        payload
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
        (line) =>
          Schema.decodeUnknown(Schema.parseJson(schema))(line).pipe(
            Effect.mapError((error) => storageError(path, String(error)))
          ),
        { concurrency: "unbounded" }
      )
    ),
    Effect.map((entries) =>
      limit === undefined || limit <= 0 ? entries : entries.slice(-limit)
    )
  );
}

/** Append one schema-encoded entry to a JSONL file. */
export function appendJsonLine<A, I>(
  fs: PlatformFileSystem.FileSystem,
  path: string,
  schema: Schema.Schema<A, I>,
  payload: A
): Effect.Effect<void, StorageError> {
  return Effect.gen(function* () {
    const encoded = yield* Schema.encode(Schema.parseJson(schema))(payload).pipe(
      Effect.mapError((error) => storageError(path, String(error)))
    );

    yield* fs.writeFileString(path, `${encoded}\n`, { flag: "a" }).pipe(
      Effect.mapError((error) => storageError(path, error.message))
    );
  });
}
