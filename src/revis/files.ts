/** Shared filesystem helpers for config, run state, and session persistence. */

import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { Effect, Schema } from "effect";

import { StorageError, detailFromUnknown } from "../domain/errors";

/** Return whether one path currently exists. */
export function pathExists(path: string) {
  return Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path));
}

/** Ensure one directory exists. */
export function ensureDir(path: string) {
  return withStorageError(
    path,
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(path, { recursive: true }))
  );
}

/** Read one UTF-8 file and surface the path on failure. */
export function readTextFile(path: string) {
  return withStorageError(
    path,
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path))
  );
}

/** Write one UTF-8 file, creating parent directories first. */
export function writeTextFile(path: string, value: string) {
  return withStorageError(
    path,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathApi = yield* Path.Path;

      yield* fs.makeDirectory(pathApi.dirname(path), { recursive: true });
      yield* fs.writeFileString(path, value);
    })
  );
}

/** Append one UTF-8 file line, creating parent directories first. */
export function appendTextFile(path: string, value: string) {
  return withStorageError(
    path,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathApi = yield* Path.Path;

      yield* fs.makeDirectory(pathApi.dirname(path), { recursive: true });
      yield* fs.writeFileString(path, value, { flag: "a" });
    })
  );
}

/** Decode one JSON file with a schema. */
export function readJsonFile<A, I, R>(
  path: string,
  schema: Schema.Schema<A, I, R>
) {
  const jsonSchema = Schema.parseJson(schema);

  return withStorageError(
    path,
    Effect.flatMap(readTextFile(path), (text) => Schema.decodeUnknown(jsonSchema)(text))
  );
}

/** Encode one JSON file with a schema. */
export function writeJsonFile<A, I, R>(
  path: string,
  schema: Schema.Schema<A, I, R>,
  value: A
) {
  const jsonSchema = Schema.parseJson(schema);

  return withStorageError(
    path,
    Effect.gen(function* () {
      const text = yield* Schema.encode(jsonSchema)(value);
      yield* writeTextFile(path, `${text}\n`);
    })
  );
}

/** Append one JSONL record with schema validation. */
export function appendJsonLine<A, I, R>(
  path: string,
  schema: Schema.Schema<A, I, R>,
  value: A
) {
  const jsonSchema = Schema.parseJson(schema);

  return withStorageError(
    path,
    Effect.gen(function* () {
      const text = yield* Schema.encode(jsonSchema)(value);
      yield* appendTextFile(path, `${text}\n`);
    })
  );
}

/** Read a JSONL file into memory in insertion order. */
export function readJsonLines<A, I, R>(
  path: string,
  schema: Schema.Schema<A, I, R>
) {
  const jsonSchema = Schema.parseJson(schema);

  return withStorageError(
    path,
    Effect.gen(function* () {
      const text = yield* readTextFile(path);
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

      return yield* Effect.forEach(lines, (line) => Schema.decodeUnknown(jsonSchema)(line));
    })
  );
}

/** Read one directory and return the entry names. */
export function readDirectory(path: string) {
  return withStorageError(
    path,
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readDirectory(path))
  );
}

/** Remove one file or directory. */
export function removePath(
  path: string,
  options?: FileSystem.RemoveOptions
) {
  return withStorageError(
    path,
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(path, options))
  );
}

/** Re-tag arbitrary filesystem and codec failures with the path being operated on. */
function withStorageError<A, R>(
  path: string,
  effect: Effect.Effect<A, unknown, R>
): Effect.Effect<A, StorageError, R> {
  return Effect.mapError(
    effect,
    (cause) =>
      cause instanceof StorageError
        ? cause
        : new StorageError({
            path,
            detail: detailFromUnknown(cause)
          })
  );
}
