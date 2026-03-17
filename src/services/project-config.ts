/** Project config service owning `.revis/config.json`. */

import { FileSystem } from "@effect/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ConfigError } from "../domain/errors";
import { RevisConfig } from "../domain/models";
import { ProjectPaths } from "./project-paths";

export const DEFAULT_REMOTE_POLL_SECONDS = 5;

export interface ProjectConfigApi {
  readonly exists: Effect.Effect<boolean, ConfigError>;
  readonly load: Effect.Effect<RevisConfig, ConfigError>;
  readonly save: (config: RevisConfig) => Effect.Effect<string, ConfigError>;
}

export class ProjectConfig extends Context.Tag("@revis/ProjectConfig")<
  ProjectConfig,
  ProjectConfigApi
>() {}

export const projectConfigLayer = Layer.effect(
  ProjectConfig,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* ProjectPaths;

    const exists = fs.exists(paths.configFile).pipe(
      Effect.mapError((error) =>
        ConfigError.make({
          path: paths.configFile,
          message: error.message
        })
      )
    );

    const load = fs.readFileString(paths.configFile).pipe(
      Effect.mapError((error) =>
        ConfigError.make({
          path: paths.configFile,
          message: error.message
        })
      ),
      Effect.flatMap((payload) =>
        Schema.decodeUnknown(Schema.parseJson(RevisConfig))(payload).pipe(
          Effect.mapError((error) =>
            ConfigError.make({
              path: paths.configFile,
              message: String(error)
            })
          )
        )
      )
    );

    const save = (config: RevisConfig) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(paths.revisDir, { recursive: true }).pipe(
          Effect.mapError((error) =>
            ConfigError.make({
              path: paths.revisDir,
              message: error.message
            })
          )
        );

        const encoded = yield* Schema.encode(Schema.parseJson(RevisConfig))(config).pipe(
          Effect.mapError((error) =>
            ConfigError.make({
              path: paths.configFile,
              message: String(error)
            })
          )
        );

        yield* fs.writeFileString(paths.configFile, `${encoded}\n`).pipe(
          Effect.mapError((error) =>
            ConfigError.make({
              path: paths.configFile,
              message: error.message
            })
          )
        );

        return paths.configFile;
      });

    return ProjectConfig.of({
      exists,
      load,
      save
    });
  })
);
