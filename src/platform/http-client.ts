/** Effect-native HTTP helpers shared by CLI and daemon transport code. */

import assert from "node:assert/strict";

import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "@effect/platform";
import type * as PlatformHttpClient from "@effect/platform/HttpClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export type ServerSentEventFrame =
  | { readonly _tag: "Event"; readonly payload: string }
  | { readonly _tag: "Ignore" }
  | { readonly _tag: "Retry"; readonly millis: number };

const noStoreHeaders = {
  "Cache-Control": "no-store"
} as const;

/** Decode one JSON response body from an HTTP GET request. */
export function getJson<A, I, E>(
  url: string,
  schema: Schema.Schema<A, I>,
  onError: (error: unknown) => E
): Effect.Effect<A, E, PlatformHttpClient.HttpClient> {
  return HttpClientRequest.get(url, {
    acceptJson: true,
    headers: noStoreHeaders
  }).pipe(
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.mapError(onError)
  );
}

/** Execute one JSON POST request and return the raw response. */
export function postJson<E>(
  url: string,
  payload: Record<string, unknown>,
  onError: (error: unknown) => E
): Effect.Effect<HttpClientResponse.HttpClientResponse, E, PlatformHttpClient.HttpClient> {
  return HttpClientRequest.post(url, { headers: noStoreHeaders }).pipe(
    HttpClientRequest.bodyJson(payload),
    Effect.flatMap(HttpClient.execute),
    Effect.mapError(onError)
  );
}

/** Stream parsed SSE frames from one endpoint. */
export function streamServerSentEvents<E>(
  url: string,
  onError: (error: unknown) => E
): Stream.Stream<ServerSentEventFrame, E, PlatformHttpClient.HttpClient> {
  return HttpClientResponse.stream(
    HttpClientRequest.get(url, {
      headers: {
        ...noStoreHeaders,
        Accept: "text/event-stream"
      }
    }).pipe(
      HttpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(onError)
    )
  ).pipe(
    // Decode incrementally so chunk boundaries never leak into the SSE parser.
    Stream.decodeText(),
    Stream.mapAccum("", splitCompleteSseFrames),
    Stream.mapConcat((frames) => frames),
    Stream.mapEffect((frame) =>
      Effect.try({
        try: () => parseSseFrame(frame),
        catch: onError
      })
    ),
    Stream.mapError(onError)
  );
}

/** Split one decoded SSE text chunk into complete frames plus a remainder. */
function splitCompleteSseFrames(
  remainder: string,
  chunk: string
): readonly [string, ReadonlyArray<string>] {
  // Normalize CRLF here so the frame parser only has to handle one newline shape.
  const buffered = `${remainder}${chunk}`.replaceAll("\r", "");
  const frames = buffered.split("\n\n");
  const nextRemainder = frames.pop() ?? "";

  return [nextRemainder, frames.filter(Boolean)];
}

/** Parse one SSE frame into a small, explicit discriminated union. */
function parseSseFrame(frame: string): ServerSentEventFrame {
  const data: Array<string> = [];
  let retry: number | null = null;

  // Keep the accepted frame grammar intentionally tiny: Revis only emits `data:` payloads and
  // one initial `retry:` hint, so any other field should fail loudly instead of being ignored.
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
      continue;
    }

    if (line.startsWith("retry:")) {
      retry = Number.parseInt(line.slice("retry:".length).trim(), 10);
      assert(Number.isInteger(retry), `Invalid SSE retry line: ${line}`);
      continue;
    }

    throw new Error(`Unknown SSE frame line: ${line}`);
  }

  if (data.length > 0) {
    return { _tag: "Event", payload: data.join("\n") };
  }

  if (retry !== null) {
    return { _tag: "Retry", millis: retry };
  }

  return { _tag: "Ignore" };
}
