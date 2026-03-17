/** Internal daemon entrypoint command. */

import { Command, Options } from "@effect/cli";
import * as Effect from "effect/Effect";

import { runDaemonProcess } from "../../daemon/control";
import { reportErrors, type CliWriters } from "../runtime";

/** Build the hidden `_daemon-run` command. */
export function makeDaemonRunCommand(io: CliWriters) {
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const daemonRoot = Options.text("root").pipe(Options.optional);

  return Command.make("_daemon-run", { daemonRoot }, ({ daemonRoot }) =>
    reportErrors(
      Effect.gen(function* () {
        const root = daemonRoot._tag === "Some" ? daemonRoot.value : process.cwd();
        yield* runDaemonProcess(root);
      }),
      writeErr
    )
  ).pipe(Command.withDescription("Internal daemon entrypoint."));
}
