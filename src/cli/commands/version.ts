/** `revis version` command. */

import { Command } from "@effect/cli";
import * as Effect from "effect/Effect";

import { packageVersion } from "../../platform/runtime";
import { writeLine, type CliWriters } from "../runtime";

/** Build the `version` command. */
export function makeVersionCommand(io: CliWriters) {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));

  return Command.make("version", {}, () =>
    packageVersion().pipe(Effect.flatMap((version) => writeLine(writeOut, version)))
  ).pipe(Command.withDescription("Print the installed Revis version."));
}
