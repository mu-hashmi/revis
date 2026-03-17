/** Daemon HTTP route definitions for status, events, control, and dashboard assets. */

import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform";
import * as Effect from "effect/Effect";

import { HostGit } from "../git/host-git";
import { loadStatusSnapshot } from "../workflows/load-status";
import { EventJournal } from "../services/event-journal";
import { ProjectPaths } from "../services/project-paths";
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

/** Build the daemon HTTP router. */
export function daemonRouter(options: RouterOptions) {
  return HttpRouter.empty.pipe(
    HttpRouter.get("*", handleGetRequest(options)),
    HttpRouter.post("*", handlePostRequest(options))
  );
}

function handleGetRequest(options: RouterOptions) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");

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

    if (url.pathname === "/api/sessions") {
      const eventJournal = yield* EventJournal;
      const sessions = yield* eventJournal.listSessions;
      return yield* HttpServerResponse.json(sessions);
    }

    if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/meta")) {
      const sessionId = url.pathname.slice("/api/sessions/".length, -"/meta".length);
      const eventJournal = yield* EventJournal;
      const meta = yield* eventJournal.loadSessionMeta(sessionId);

      return meta
        ? yield* HttpServerResponse.json(meta)
        : HttpServerResponse.text("Not found\n", { status: 404 });
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

    const assetPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);

    return yield* respondStaticFile(
      resolveSafePath(options.dashboardRoot, assetPath),
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

function handlePostRequest(options: RouterOptions) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const body = (yield* Effect.orDie(request.json)) as Record<string, unknown>;

    if (url.pathname === "/api/control/reconcile") {
      const reason = body.reason;
      if (reason !== "spawn" && reason !== "promote" && reason !== "manual") {
        return HttpServerResponse.text("Invalid reconcile reason\n", { status: 400 });
      }

      yield* options.onReconcile(reason);
      return yield* HttpServerResponse.json({ ok: true });
    }

    if (url.pathname === "/api/control/stop") {
      const agentIds = Array.isArray(body.agentIds)
        ? body.agentIds.map(String)
        : [];
      yield* options.onStop(agentIds);
      return yield* HttpServerResponse.json({ ok: true });
    }

    if (url.pathname === "/api/control/shutdown") {
      yield* options.onShutdown(typeof body.reason === "string" ? body.reason : "shutdown");
      return yield* HttpServerResponse.json({ ok: true });
    }

    return HttpServerResponse.text("Not found\n", { status: 404 });
  });
}
