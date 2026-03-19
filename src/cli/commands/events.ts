/** `revis events` command. */

import { Command, Options } from "@effect/cli";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DaemonControl } from "../../daemon/control";
import { ValidationError } from "../../domain/errors";
import { RuntimeEventSchema, type RuntimeEvent } from "../../domain/models";
import { streamServerSentEvents } from "../../platform/http-client";
import { EventJournal } from "../../services/event-journal";
import { reportErrors, withProject, writeLine, type CliWriters } from "../runtime";

/** Build the `events` command. */
export function makeEventsCommand(io: CliWriters) {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const limit = Options.integer("limit").pipe(Options.withDefault(20));
  const follow = Options.boolean("follow").pipe(Options.withDefault(true));

  /** Stream daemon SSE events to stdout until the connection closes. */
  const followEvents = () => Effect.gen(function* () {
    const daemon = yield* DaemonControl;
    const state = yield* daemon.ensureRunning;

    yield* Stream.runForEach(
      streamServerSentEvents(
        `${state.apiBaseUrl}/api/events/stream`,
        (error) =>
          ValidationError.make({
            message: error instanceof Error ? error.message : String(error)
          })
      ),
      (frame) => {
        switch (frame._tag) {
          case "Ignore":
            return Effect.void;
          case "Retry":
            // The daemon sends one reconnect hint for browser-style SSE clients. The CLI keeps
            // streaming on the current connection, so the hint is informational only here.
            return Effect.void;
          case "Event":
            return decodeRuntimeEvent(frame.payload).pipe(
              Effect.flatMap((event) => Effect.sync(() => writeOut(renderEventLine(event))))
            );
        }
      }
    );
  });

  return Command.make("events", { follow, limit }, ({ follow, limit }) =>
    reportErrors(
      withProject(() =>
        Effect.gen(function* () {
          if (follow) {
            yield* followEvents();
            return;
          }

          // Load the persisted backlog directly when watch mode is disabled.
          const journal = yield* EventJournal;
          const events = yield* journal.loadEvents(limit);

          for (const event of events) {
            yield* writeLine(writeOut, `${event.timestamp} ${event.summary}`);
          }
        })
      ),
      writeErr
    )
  ).pipe(Command.withDescription("Show or follow the runtime event stream."));
}

/** Decode one runtime event payload from an SSE `data:` line. */
function decodeRuntimeEvent(payload: string): Effect.Effect<RuntimeEvent, ValidationError> {
  return Schema.decodeUnknown(Schema.parseJson(RuntimeEventSchema))(payload).pipe(
    Effect.mapError((error) =>
      ValidationError.make({
        message: String(error)
      })
    )
  );
}

/** Render one runtime event in the CLI stream format. */
function renderEventLine(event: RuntimeEvent): string {
  return `${event.timestamp} ${event.summary}\n`;
}
