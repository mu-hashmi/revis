/** HTTP transport, SSE streaming, and daemon-control client helpers. */

import { createServer } from "node:http";
import { extname, relative, resolve } from "node:path";

import {
  FileSystem,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerResponse
} from "@effect/platform";
import type * as PlatformFileSystem from "@effect/platform/FileSystem";
import type * as PlatformHttpClient from "@effect/platform/HttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  CommandError,
  DaemonUnavailableError,
  StorageError,
  ValidationError,
  storageError
} from "../domain/errors";
import { EventJournal } from "../services/event-journal";
import { DaemonState } from "../domain/models";
import { postJson } from "../platform/http-client";
import { readJsonFileIfExists } from "../platform/storage";

/** Bind the daemon HTTP server to an ephemeral localhost port. */
export function makeDaemonServer() {
  return NodeHttpServer.make(() => createServer(), {
    host: "127.0.0.1",
    port: 0
  });
}

/** Stream the current live event log over server-sent events. */
export function streamLiveEvents() {
  return Effect.gen(function* () {
    const eventJournal = yield* EventJournal;
    const backlog = yield* eventJournal.loadEvents(50);
    const encoder = new TextEncoder();

    // Send one retry hint and the recent backlog first so new dashboard clients can render the
    // current state immediately before they start consuming the live tail.
    const initial = Stream.fromIterable([
      encoder.encode("retry: 1000\n\n"),
      ...backlog.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    ]);

    const updates = eventJournal.stream.pipe(
      Stream.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    );

    return HttpServerResponse.stream(Stream.concat(initial, updates), {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8"
      }
    });
  });
}

/** Serve one static dashboard asset from disk. */
export function respondStaticFile(path: string, contentType: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const payload = yield* fs.readFile(path).pipe(
      Effect.mapError((error) => storageError(path, error.message))
    );

    return HttpServerResponse.uint8Array(payload, {
      contentType,
      headers: {
        "Cache-Control": "no-store"
      }
    });
  });
}

/** Resolve one dashboard asset path and reject traversal attempts. */
export function resolveSafePath(
  baseDir: string,
  unsafePath: string
): Effect.Effect<string, ValidationError> {
  return Effect.gen(function* () {
    const candidate = resolve(baseDir, `./${unsafePath}`);
    const relativePath = relative(baseDir, candidate);

    if (relativePath.startsWith("..") || relativePath === "") {
      return yield* ValidationError.make({ message: `Invalid dashboard path: ${unsafePath}` });
    }

    return candidate;
  });
}

/** Return a static content type for one dashboard asset path. */
export function contentTypeForPath(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/** Return whether one daemon API base URL is responding. */
export function daemonApiReady(
  apiBaseUrl: string
): Effect.Effect<boolean, never, PlatformHttpClient.HttpClient> {
  return HttpClientRequest.get(`${apiBaseUrl}/health`, {
    headers: {
      "Cache-Control": "no-store"
    }
  }).pipe(
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.as(true),
    Effect.mapError((error) =>
      DaemonUnavailableError.make({
        message: error instanceof Error ? error.message : String(error)
      })
    ),
    // Readiness probes answer a yes/no question; callers decide whether to retry or clear state.
    Effect.catchAll(() => Effect.succeed(false))
  );
}

/** Post one daemon control payload. */
export function postControl(
  apiBaseUrl: string,
  path: string,
  payload: Record<string, unknown>
): Effect.Effect<void, CommandError, PlatformHttpClient.HttpClient> {
  const command = `POST ${path}`;

  return postJson(`${apiBaseUrl}${path}`, payload, (error) =>
    CommandError.make({
      command,
      message: error instanceof Error ? error.message : String(error)
    })
  ).pipe(
    Effect.flatMap((response) => {
      // Successful control endpoints do not return a meaningful body.
      if (response.status >= 200 && response.status < 300) {
        return Effect.void;
      }

      // Bubble the daemon's response body up into the command error so callers can show the
      // transport-level validation failure directly.
      return response.text.pipe(
        Effect.mapError((error) =>
          CommandError.make({
            command,
            message: error instanceof Error ? error.message : String(error)
          })
        ),
        Effect.flatMap((message) =>
          CommandError.make({
            command,
            message
          })
        )
      );
    })
  );
}

/** Wait until the daemon has persisted a ready state and started serving. */
export function waitForDaemonState(
  daemonStateFile: string,
  timeoutMs: number
): Effect.Effect<
  DaemonState,
  CommandError | StorageError,
  PlatformFileSystem.FileSystem | PlatformHttpClient.HttpClient
> {
  const pollUntilReady = Effect.gen(function* () {
    // Keep disk polling and readiness checks on Effect operators so tests can drive time with
    // TestClock instead of wall-clock loops.
    const daemon = yield* loadDaemonState(daemonStateFile);
    if (Option.isSome(daemon) && (yield* daemonApiReady(daemon.value.apiBaseUrl))) {
      return daemon;
    }

    yield* Effect.sleep("100 millis");
    return Option.none<DaemonState>();
  }).pipe(
    Effect.repeat({
      until: Option.isSome
    }),
    Effect.map((daemon) => {
      // `Effect.repeat(... until: Option.isSome)` guarantees this branch, but keeping the unwrap
      // inline makes the steady-state poll read top-to-bottom without an extra helper.
      if (Option.isNone(daemon)) {
        throw new Error("Daemon state missing after readiness poll");
      }

      return daemon.value;
    })
  );

  return pollUntilReady.pipe(
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () =>
        CommandError.make({
          command: "_daemon-run",
          message: "Daemon did not persist a ready state in time"
        })
    })
  );
}

/** Read the persisted daemon state directly from disk so cross-process startup can observe it. */
function loadDaemonState(
  path: string
): Effect.Effect<Option.Option<DaemonState>, StorageError, PlatformFileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* readJsonFileIfExists(fs, path, DaemonState);
  });
}
