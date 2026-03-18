/** Daemon HTTP route definitions for status, events, control, and dashboard assets. */

import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { HostGit } from "../git/host-git";
import { loadStatusSnapshot } from "../workflows/load-status";
import { EventJournal } from "../services/event-journal";
import { ProjectPaths } from "../services/project-paths";
import { ValidationError } from "../domain/errors";
import {
  contentTypeForPath,
  resolveSafePath,
  respondStaticFile,
  streamLiveEvents
} from "./http";
import type { ReconcileReason } from "./reconcile-loop";

interface RouterOptions {
  readonly dashboardRoot: string;
  readonly onReconcile: (reason: Exclude<ReconcileReason, "startup" | "poll">) => Effect.Effect<void, unknown>;
  readonly onShutdown: (reason: string) => Effect.Effect<void, unknown>;
  readonly onStop: (agentIds: ReadonlyArray<string>) => Effect.Effect<void, unknown>;
}

const ReconcileRequest = Schema.Struct({
  reason: Schema.Literal("spawn", "promote", "manual")
});

const StopRequest = Schema.Struct({
  agentIds: Schema.Array(Schema.String)
});

const ShutdownRequest = Schema.Struct({
  reason: Schema.optional(Schema.String)
});

/** Build the daemon HTTP router. */
export function daemonRouter(options: RouterOptions) {
  return HttpRouter.empty.pipe(
    HttpRouter.get("*", handleGetRequest(options)),
    HttpRouter.post("*", handlePostRequest(options))
  );
}

/** Dispatch daemon GET routes for health, status, archives, git detail, and assets. */
function handleGetRequest(options: RouterOptions) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");

    // Health and live daemon status endpoints.
    if (url.pathname === "/health") {
      return HttpServerResponse.text("ok\n");
    }

    if (url.pathname === "/api/status") {
      const snapshot = yield* loadStatusSnapshot();
      return yield* HttpServerResponse.json(snapshot);
    }

    if (url.pathname === "/api/events") {
      const eventJournal = yield* EventJournal;
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);

      const events = yield* eventJournal.loadEvents(Number.isFinite(limit) ? limit : 20);
      return yield* HttpServerResponse.json(events);
    }

    if (url.pathname === "/api/events/stream") {
      return yield* streamLiveEvents();
    }

    // Archived session index and per-session payloads.
    if (url.pathname === "/api/sessions") {
      const eventJournal = yield* EventJournal;
      const sessions = yield* eventJournal.listSessions;
      return yield* HttpServerResponse.json(sessions);
    }

    if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/meta")) {
      const sessionId = url.pathname.slice("/api/sessions/".length, -"/meta".length);
      const eventJournal = yield* EventJournal;
      const meta = yield* eventJournal.loadSessionMeta(sessionId);

      if (Option.isSome(meta)) {
        return yield* HttpServerResponse.json(meta.value);
      }

      return HttpServerResponse.text("Not found\n", { status: 404 });
    }

    if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/events")) {
      const sessionId = url.pathname.slice("/api/sessions/".length, -"/events".length);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "0", 10);
      const eventJournal = yield* EventJournal;
      const events = yield* eventJournal.loadSessionEvents(
        sessionId,
        Number.isFinite(limit) && limit > 0 ? limit : undefined
      );

      return yield* HttpServerResponse.json(events);
    }

    // Raw git commit detail used by the dashboard event panel.
    if (url.pathname === "/api/git/show") {
      const sha = url.searchParams.get("sha");
      if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
        return HttpServerResponse.text("Expected a commit SHA\n", { status: 400 });
      }

      const hostGit = yield* HostGit;
      const paths = yield* ProjectPaths;

      const payload = yield* hostGit.showCommit(paths.root, sha);
      return HttpServerResponse.text(payload, {
        headers: { "Cache-Control": "no-store" }
      });
    }

    // Everything else is served from the packaged dashboard bundle.
    const assetPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safePath = yield* resolveSafePath(options.dashboardRoot, assetPath).pipe(Effect.either);
    if (Either.isLeft(safePath)) {
      return HttpServerResponse.text(`${safePath.left.message}\n`, { status: 400 });
    }

    return yield* respondStaticFile(
      safePath.right,
      contentTypeForPath(assetPath)
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed(
        HttpServerResponse.text(`${error instanceof Error ? error.message : String(error)}\n`, {
          status: 500
        })
      )
    )
  );
}

/** Dispatch daemon POST control routes for reconcile, stop, and shutdown actions. */
function handlePostRequest(options: RouterOptions) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");

    // Interactive reconcile requests from CLI commands.
    if (url.pathname === "/api/control/reconcile") {
      const body = yield* HttpServerRequest.schemaBodyJson(ReconcileRequest).pipe(
        Effect.mapError((error) =>
          ValidationError.make({ message: String(error) })
        ),
        Effect.either
      );
      if (Either.isLeft(body)) {
        return HttpServerResponse.text(`${body.left.message}\n`, { status: 400 });
      }

      yield* options.onReconcile(body.right.reason);
      return yield* HttpServerResponse.json({ ok: true });
    }

    // Workspace stop requests share one endpoint for targeted or stop-all operations.
    if (url.pathname === "/api/control/stop") {
      const body = yield* HttpServerRequest.schemaBodyJson(StopRequest).pipe(
        Effect.mapError((error) =>
          ValidationError.make({ message: String(error) })
        ),
        Effect.either
      );
      if (Either.isLeft(body)) {
        return HttpServerResponse.text(`${body.left.message}\n`, { status: 400 });
      }

      yield* options.onStop(body.right.agentIds);
      return yield* HttpServerResponse.json({ ok: true });
    }

    // Shutdown is separate so the daemon can flush final state before exiting.
    if (url.pathname === "/api/control/shutdown") {
      const body = yield* HttpServerRequest.schemaBodyJson(ShutdownRequest).pipe(
        Effect.mapError((error) =>
          ValidationError.make({ message: String(error) })
        ),
        Effect.either
      );
      if (Either.isLeft(body)) {
        return HttpServerResponse.text(`${body.left.message}\n`, { status: 400 });
      }

      yield* options.onShutdown(body.right.reason ?? "shutdown");
      return yield* HttpServerResponse.json({ ok: true });
    }

    return HttpServerResponse.text("Not found\n", { status: 404 });
  });
}
