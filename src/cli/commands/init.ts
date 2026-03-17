/** `revis init` command. */

import { Command } from "@effect/cli";
import * as Effect from "effect/Effect";

import { initializeProject } from "../../workflows/init-project";
import { reportErrors, resolveCurrentProjectRoot, withProjectBootstrap, writeLine, type CliWriters } from "../runtime";

/** Build the `init` command. */
export function makeInitCommand(io: CliWriters) {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));

  return Command.make("init", {}, () =>
    reportErrors(
      Effect.gen(function* () {
        const root = yield* resolveCurrentProjectRoot();
        const config = yield* withProjectBootstrap(root, () => initializeProject(root));

        yield* writeLine(writeOut, `Initialized Revis in ${root}`);
        yield* writeLine(writeOut, `Remote: ${config.coordinationRemote}`);
        yield* writeLine(writeOut, `Base branch: ${config.trunkBase}`);
        yield* writeLine(writeOut, `Daemon poll seconds: ${config.remotePollSeconds}`);
        yield* writeLine(writeOut, "Next: revis spawn 1 --exec '<command>'");
      }),
      writeErr
    )
  ).pipe(Command.withDescription("Set up Revis in the current repository."));
}
