/** Transport-level tests for the daemon HTTP router and thin client helpers. */

import { TextDecoder } from "node:util";

import * as NodeContext from "@effect/platform-node/NodeContext";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  DaemonStarted,
  RuntimeEventSchema,
  WorkspaceProvisioned,
  asAgentId,
  asBranchName,
  asTimestamp
} from "../../src/domain/models";
import { daemonApiReady, makeDaemonServer, postControl } from "../../src/daemon/http";
import { daemonRouter } from "../../src/daemon/routes";
import { EventJournal } from "../../src/services/event-journal";
import { makeOrchestrationHarness } from "../support/orchestration-harness";

describe("daemon HTTP transport", () => {
  it.scopedLive("serves control endpoints through the router and the client helpers", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          // Capture handler invocations in Refs so the router can run against a real HTTP server
          // without depending on the live daemon supervisor.
          const reconcileReasonsRef = yield* Ref.make<ReadonlyArray<string>>([]);
          const shutdownReasonsRef = yield* Ref.make<ReadonlyArray<string>>([]);
          const stopRequestsRef = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
          const server = yield* makeDaemonServer();

          if (server.address._tag !== "TcpAddress") {
            return yield* Effect.dieMessage("Expected a TCP daemon address");
          }

          const baseUrl = `http://${server.address.hostname}:${server.address.port}`;
          const router = daemonRouter({
            dashboardRoot: harness.paths.root,
            onReconcile: (reason) =>
              Ref.update(reconcileReasonsRef, (current) => [...current, reason]).pipe(Effect.asVoid),
            onShutdown: (reason) =>
              Ref.update(shutdownReasonsRef, (current) => [...current, reason]).pipe(Effect.asVoid),
            onStop: (agentIds) =>
              Ref.update(stopRequestsRef, (current) => [...current, agentIds])
          });

          // Serve the real router so `daemonApiReady` and `postControl` exercise the transport
          // contract instead of calling handler functions directly.
          yield* Effect.forkScoped(server.serve(router));

          expect(yield* daemonApiReady(baseUrl)).toBe(true);

          yield* postControl(baseUrl, "/api/control/reconcile", { reason: "spawn" });
          yield* postControl(baseUrl, "/api/control/stop", { agentIds: ["agent-1", "agent-2"] });
          yield* postControl(baseUrl, "/api/control/shutdown", { reason: "stop" });

          expect(yield* Ref.get(reconcileReasonsRef)).toStrictEqual(["spawn"]);
          expect(yield* Ref.get(shutdownReasonsRef)).toStrictEqual(["stop"]);
          expect(yield* Ref.get(stopRequestsRef)).toStrictEqual([["agent-1", "agent-2"]]);

          // Drive one invalid request through raw fetch to prove the route-level schema check is
          // still visible over HTTP.
          const invalid = yield* Effect.tryPromise((signal) =>
            fetch(`${baseUrl}/api/control/reconcile`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ reason: "poll" }),
              signal
            })
          ).pipe(Effect.orDie);
          const text = yield* Effect.tryPromise(() => awaitText(invalid)).pipe(Effect.orDie);

          expect(invalid.status).toBe(400);
          expect(text).toContain("reason");
        }).pipe(Effect.provide(Layer.merge(NodeContext.layer, harness.layer)))
      )
    )
  );

  it.scopedLive("streams backlog first and live events after through SSE", () =>
    makeOrchestrationHarness().pipe(
      Effect.flatMap((harness) =>
        Effect.gen(function* () {
          const journal = yield* EventJournal;
          const server = yield* makeDaemonServer();

          if (server.address._tag !== "TcpAddress") {
            return yield* Effect.dieMessage("Expected a TCP daemon address");
          }

          const backlog = DaemonStarted.make({
            timestamp: asTimestamp("2026-03-18T00:00:00.000Z"),
            summary: "Daemon started"
          });
          const live = WorkspaceProvisioned.make({
            timestamp: asTimestamp("2026-03-18T00:00:01.000Z"),
            agentId: asAgentId("agent-1"),
            branch: asBranchName("revis/operator-1/agent-1/work"),
            summary: "Provisioned agent-1"
          });
          const router = daemonRouter({
            dashboardRoot: harness.paths.root,
            onReconcile: () => Effect.void,
            onShutdown: () => Effect.void,
            onStop: () => Effect.void
          });
          const baseUrl = `http://${server.address.hostname}:${server.address.port}`;

          // Seed one backlog event before the client subscribes, then append another one after the
          // stream is open to prove the SSE endpoint stitches backlog and live traffic together.
          yield* journal.append(backlog);
          yield* Effect.forkScoped(server.serve(router));

          const response = yield* Effect.tryPromise((signal) =>
            fetch(`${baseUrl}/api/events/stream`, {
              headers: {
                Accept: "text/event-stream"
              },
              signal
            })
          ).pipe(Effect.orDie);
          const reader = response.body?.getReader();

          if (!reader) {
            return yield* Effect.dieMessage("Missing SSE response body");
          }

          const backlogPayload = yield* Effect.tryPromise(() => readSseChunks(reader, 2)).pipe(
            Effect.orDie
          );

          yield* journal.append(live);

          const livePayload = yield* Effect.tryPromise(() => readSseChunks(reader, 1)).pipe(
            Effect.orDie
          );
          const payload = backlogPayload + livePayload;
          const events = parseSseEvents(payload);

          expect(response.headers.get("content-type")).toContain("text/event-stream");
          expect(payload).toContain("retry: 1000");
          expect(events).toStrictEqual([backlog, live]);

          yield* Effect.tryPromise(() => reader.cancel()).pipe(Effect.orDie);
        }).pipe(Effect.provide(Layer.merge(NodeContext.layer, harness.layer)))
      )
    )
  );
});

/** Read one HTTP response body into text for assertion. */
async function awaitText(response: Response): Promise<string> {
  return response.text();
}

/** Read a bounded number of SSE message chunks from one response stream. */
async function readSseChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: number
): Promise<string> {
  const decoder = new TextDecoder();
  let payload = "";

  while (countSseChunks(payload) < chunks) {
    const next = await readSseChunkWithTimeout(reader, 5_000);
    if (next.done) {
      break;
    }

    payload += decoder.decode(next.value, { stream: true });
  }

  return payload;
}

/** Count non-empty SSE message chunks separated by blank lines. */
function countSseChunks(payload: string): number {
  return payload.split("\n\n").filter(Boolean).length;
}

/** Decode the `data:` payloads in one SSE stream into typed runtime events. */
function parseSseEvents(payload: string) {
  const decodeEvent = Schema.decodeUnknownSync(Schema.parseJson(RuntimeEventSchema));

  return payload
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => decodeEvent(chunk.slice("data: ".length)));
}

/** Read one SSE chunk with a hard timeout so transport bugs fail promptly. */
function readSseChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
) {
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out while reading SSE")), timeoutMs);

    void reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
