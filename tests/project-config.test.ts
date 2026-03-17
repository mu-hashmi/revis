import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RevisConfig } from "../src/domain/models";
import { isoNow } from "../src/platform/time";
import { ProjectConfig, projectConfigLayer } from "../src/services/project-config";
import { ProjectPaths, projectPathsLayer } from "../src/services/project-paths";

class TestFileError extends Schema.TaggedError<TestFileError>()("TestFileError", {
  message: Schema.String
}) {}

it.effect("project paths own the revis layout and config round-trips through the service", () =>
  withTempRoot((root) => {
    const pathsLayer = projectPathsLayer(root);
    const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);
    const configuredPathsLayer = pathsLayer.pipe(Layer.provide(platformLayer));
    const configLayer = projectConfigLayer.pipe(
      Layer.provide(Layer.merge(platformLayer, configuredPathsLayer))
    );
    const appLayer = Layer.mergeAll(platformLayer, configuredPathsLayer, configLayer);

    return Effect.gen(function* () {
      const paths = yield* ProjectPaths;
      const configService = yield* ProjectConfig;
      const config = RevisConfig.make({
        coordinationRemote: "origin",
        trunkBase: "main",
        remotePollSeconds: 7,
        sandboxProvider: "local"
      });

      expect(paths.configFile).toBe(join(root, ".revis", "config.json"));
      expect(paths.daemonStateFile).toBe(join(root, ".revis", "state", "daemon.json"));
      expect(paths.liveJournalFile).toBe(join(root, ".revis", "journal", "live.jsonl"));

      yield* configService.save(config);

      const loaded = yield* configService.load;
      expect(loaded.coordinationRemote).toBe(config.coordinationRemote);
      expect(loaded.trunkBase).toBe(config.trunkBase);
      expect(loaded.remotePollSeconds).toBe(config.remotePollSeconds);
      expect(loaded.sandboxProvider).toBe(config.sandboxProvider);

      const marker = isoNow();
      expect(marker.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(appLayer));
  })
);

function withTempRoot<A, E, R>(run: (root: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "revis-config-test-")),
      catch: (error) => TestFileError.make({ message: String(error) })
    }),
    run,
    (root) =>
      Effect.tryPromise({
        try: () => rm(root, { recursive: true, force: true }),
        catch: () => TestFileError.make({ message: "cleanup failed" })
      }).pipe(Effect.ignore)
  );
}
