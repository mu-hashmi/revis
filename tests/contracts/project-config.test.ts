/** Contract tests for project paths and persisted config ownership under `.revis/`. */

import { mkdir, writeFile } from "node:fs/promises";

import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ConfigError } from "../../src/domain/errors";
import { RevisConfig } from "../../src/domain/models";
import { ProjectConfig, projectConfigLayer } from "../../src/services/project-config";
import { ProjectPaths, projectPathsLayer } from "../../src/services/project-paths";
import { makeTempDirScoped } from "../support/helpers";

describe("ProjectConfig", () => {
  it.scoped("owns the .revis layout and round-trips config", () =>
    makeTempDirScoped("revis-project-config-").pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          const paths = yield* ProjectPaths;
          const configService = yield* ProjectConfig;
          const config = RevisConfig.make({
            coordinationRemote: "origin",
            trunkBase: "main",
            remotePollSeconds: 7,
            sandboxProvider: "local"
          });

          // The paths service is part of the contract here too; these locations are referenced by
          // the rest of the daemon and CLI workflows.
          expect(paths.configFile).toBe(`${root}/.revis/config.json`);
          expect(paths.daemonStateFile).toBe(`${root}/.revis/state/daemon.json`);
          expect(paths.liveJournalFile).toBe(`${root}/.revis/journal/live.jsonl`);
          expect(yield* configService.exists).toBe(false);

          // Saving the config should make it visible through the same service without any manual
          // filesystem reads.
          yield* configService.save(config);

          expect(yield* configService.exists).toBe(true);
          expect(yield* configService.load).toStrictEqual(config);
        }).pipe(Effect.provide(makeProjectConfigLayer(root)))
      )
    )
  );

  it.scoped("fails loudly when config payload is invalid", () =>
    makeTempDirScoped("revis-project-config-invalid-").pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          const paths = yield* ProjectPaths;

          // Write an invalid payload directly so the service has to surface a schema failure rather
          // than quietly coercing it.
          yield* Effect.tryPromise(() => mkdir(paths.revisDir, { recursive: true })).pipe(Effect.orDie);
          yield* Effect.tryPromise(() => writeFile(paths.configFile, '{"coordinationRemote": true}\n')).pipe(
            Effect.orDie
          );

          const error = yield* Effect.flip(
            ProjectConfig.pipe(Effect.flatMap((config) => config.load))
          );

          expect(error).toBeInstanceOf(ConfigError);
          expect(error.path).toBe(paths.configFile);
        }).pipe(Effect.provide(makeProjectConfigLayer(root)))
      )
    )
  );
});

/** Compose the real project-paths and config services for one temp-root test. */
function makeProjectConfigLayer(root: string) {
  const platformLayer = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layerUndici);
  const pathsLayer = projectPathsLayer(root).pipe(Layer.provide(platformLayer));
  const configLayer = projectConfigLayer.pipe(
    Layer.provide(Layer.merge(platformLayer, pathsLayer))
  );

  return Layer.mergeAll(platformLayer, pathsLayer, configLayer);
}
