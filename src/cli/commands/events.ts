/** `revis events` command. */

import { Command, Options } from "@effect/cli";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectAppServices } from "../../app/project-layer";
import { DaemonControl } from "../../daemon/control";
import { ValidationError } from "../../domain/errors";
import { RuntimeEventSchema } from "../../domain/models";
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

    yield* Effect.tryPromise({
      try: async (signal) => {
        // Connect to the daemon-owned event stream.
        const response = await fetch(`${state.apiBaseUrl}/api/events/stream`, {
          cache: "no-store",
          signal
        });
        if (!response.ok || !response.body) {
          throw new Error(await response.text());
        }

        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";

        while (true) {
          // Buffer fetch chunks until a full SSE frame is available.
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          while (true) {
            // SSE frames are delimited by a blank line, and fetch chunk boundaries are arbitrary.
            const marker = buffer.indexOf("\n\n");
            if (marker === -1) {
              break;
            }

            const frame = buffer.slice(0, marker);
            buffer = buffer.slice(marker + 2);

            // Parse each data line into the runtime event payload the CLI renders.
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) {
                continue;
              }

              const event = Schema.decodeUnknownSync(RuntimeEventSchema)(JSON.parse(line.slice(6)));
              writeOut(`${event.timestamp} ${event.summary}\n`);
            }
          }
        }
      },
      catch: (error) =>
        ValidationError.make({
          message: error instanceof Error ? error.message : String(error)
        })
    });
  });

  return Command.make("events", { follow, limit }, ({ follow, limit }) =>
    reportErrors(
      withProject(
        (): Effect.Effect<void, unknown, ProjectAppServices> =>
          follow
            ? followEvents()
            : Effect.gen(function* () {
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
