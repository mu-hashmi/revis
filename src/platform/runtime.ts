/** Small runtime metadata helpers for the packaged CLI. */

import { readFile } from "node:fs/promises";

import * as Effect from "effect/Effect";

import { CommandError } from "../domain/errors";

/** Load the packaged Revis version from `package.json`. */
export function packageVersion(): Effect.Effect<string, CommandError> {
  const packageJsonUrl = new URL("../../package.json", import.meta.url);

  return Effect.tryPromise({
    try: async () => {
      const payload = JSON.parse(await readFile(packageJsonUrl, "utf8")) as { version: string };
      return payload.version;
    },
    catch: (error) =>
      CommandError.make({
        command: "read package.json",
        message: error instanceof Error ? error.message : String(error)
      })
  });
}
