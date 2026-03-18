/** HTTP transport, SSE streaming, and daemon-control client helpers. */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, relative, resolve } from "node:path";

import { HttpServerResponse } from "@effect/platform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  CommandError,
  DaemonUnavailableError,
  StorageError,
  storageError
} from "../domain/errors";
import { EventJournal } from "../services/event-journal";
import { DaemonState } from "../domain/models";

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
  return Effect.promise(() => readFile(path)).pipe(
    Effect.map((payload) =>
      HttpServerResponse.uint8Array(payload, {
        contentType,
        headers: {
          "Cache-Control": "no-store"
        }
      })
    )
  );
}

/** Resolve one dashboard asset path and reject traversal attempts. */
export function resolveSafePath(baseDir: string, unsafePath: string): string {
  const candidate = resolve(baseDir, `./${unsafePath}`);
  const relativePath = relative(baseDir, candidate);

  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`Invalid dashboard path: ${unsafePath}`);
  }

  return candidate;
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
export function daemonApiReady(apiBaseUrl: string): Effect.Effect<boolean> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${apiBaseUrl}/health`, { cache: "no-store" });
      return response.ok;
    },
    catch: (error) =>
      DaemonUnavailableError.make({ message: error instanceof Error ? error.message : String(error) })
  }).pipe(
    // Readiness probes answer a yes/no question; callers decide whether to retry or clear state.
    Effect.catchAll(() => Effect.succeed(false))
  );
}

/** Post one daemon control payload. */
export function postControl(
  apiBaseUrl: string,
  path: string,
  payload: Record<string, unknown>
): Effect.Effect<void, CommandError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      // Bubble the daemon's response body up into the command error so callers can show the
      // transport-level validation failure directly.
      if (!response.ok) {
        throw new Error(await response.text());
      }
    },
    catch: (error) =>
      CommandError.make({
        command: `POST ${path}`,
        message: error instanceof Error ? error.message : String(error)
      })
  });
}

/** Wait until the daemon has persisted a ready state and started serving. */
export function waitForDaemonState(
  daemonStateFile: string,
  timeoutMs: number
): Effect.Effect<DaemonState, CommandError | StorageError> {
  function pollUntilReady(): Effect.Effect<DaemonState, StorageError> {
    return Effect.gen(function* () {
      // Keep the startup probe on Effect's own sleep/timeout operators so tests can control time
      // with TestClock instead of depending on wall-clock `Date.now()` loops.
      const daemon = yield* loadDaemonState(daemonStateFile);
      if (daemon && (yield* daemonApiReady(daemon.apiBaseUrl))) {
        return daemon;
      }

      yield* Effect.sleep("100 millis");
      return yield* pollUntilReady();
    });
  }

  return pollUntilReady().pipe(
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
function loadDaemonState(path: string): Effect.Effect<DaemonState | null, StorageError> {
  return Effect.tryPromise({
    try: async () => {
      // Startup races legitimately hit ENOENT before the daemon writes its first ready snapshot.
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }

        throw storageError(path, error instanceof Error ? error.message : String(error));
      }
    },
    catch: (error) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "StorageError"
        ? (error as StorageError)
        : storageError(path, error instanceof Error ? error.message : String(error))
  }).pipe(
    Effect.flatMap((payload) =>
      payload === null
        ? Effect.succeed(null)
        : Schema.decodeUnknown(Schema.parseJson(DaemonState))(payload).pipe(
            // Parse failures mean the daemon wrote an invalid snapshot; surface that as storage
            // corruption instead of silently retrying forever.
            Effect.mapError((error) => storageError(path, String(error)))
          )
    )
  );
}
