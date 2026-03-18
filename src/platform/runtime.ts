/** Small runtime metadata helpers for the packaged CLI. */

import { readFile } from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CommandError } from "../domain/errors";

const PackageJson = Schema.Struct({
  version: Schema.String
});

/** Load the packaged Revis version from `package.json`. */
export function packageVersion(): Effect.Effect<string, CommandError> {
  const packageJsonUrl = new URL("../../package.json", import.meta.url);

  return Effect.tryPromise({
    try: async () => {
      // Read and decode the packaged manifest in one place so CLI version reporting stays aligned
      // with the built artifact, not the caller's working directory.
      const payload = Schema.decodeUnknownSync(Schema.parseJson(PackageJson))(
        await readFile(packageJsonUrl, "utf8")
      );
      return payload.version;
    },
    catch: (error) =>
      CommandError.make({
        command: "read package.json",
        message: error instanceof Error ? error.message : String(error)
      })
  });
}
