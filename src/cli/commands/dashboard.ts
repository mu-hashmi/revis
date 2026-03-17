/** `revis dashboard` command. */

import { Command, Options } from "@effect/cli";
import * as Effect from "effect/Effect";

import { DaemonControl } from "../../daemon/control";
import { presentUrl } from "../../platform/browser";
import { reportErrors, withProject, type CliWriters } from "../runtime";

/** Build the `dashboard` command. */
export function makeDashboardCommand(io: CliWriters) {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const noOpen = Options.boolean("no-open");

  return Command.make("dashboard", { noOpen }, ({ noOpen }) =>
    reportErrors(
      withProject(() =>
        Effect.gen(function* () {
          const daemon = yield* DaemonControl;
          const state = yield* daemon.ensureRunning;

          yield* presentUrl(`${state.apiBaseUrl}/`, {
            noOpen,
            stderr: writeErr,
            stdout: writeOut
          });
        })
      ),
      writeErr
    )
  ).pipe(Command.withDescription("Open the daemon-hosted dashboard."));
}
