/** Small runtime metadata helpers for the packaged CLI. */

import { fileURLToPath } from "node:url";

import { FileSystem } from "@effect/platform";
import type * as PlatformFileSystem from "@effect/platform/FileSystem";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CommandError } from "../domain/errors";

const PackageJson = Schema.Struct({
  version: Schema.String
});

/** Load the packaged Revis version from `package.json`. */
export function packageVersion(): Effect.Effect<
  string,
  CommandError,
  PlatformFileSystem.FileSystem
> {
  const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // Read from the packaged manifest so `revis version` stays aligned with the built artifact
    // instead of the caller's current working tree.
    const payload = yield* fs.readFileString(packageJsonPath).pipe(
      Effect.mapError((error) =>
        CommandError.make({
          command: "read package.json",
          message: error.message
        })
      )
    );

    return yield* Schema.decodeUnknown(Schema.parseJson(PackageJson))(payload).pipe(
      Effect.map((manifest) => manifest.version),
      Effect.mapError((error) =>
        CommandError.make({
          command: "read package.json",
          message: String(error)
        })
      )
    );
  });
}
