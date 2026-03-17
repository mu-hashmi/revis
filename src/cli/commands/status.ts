/** `revis status` command. */

import { Command, Options } from "@effect/cli";
import * as Effect from "effect/Effect";

import type { ProjectAppServices } from "../../app/project-layer";
import { DaemonControl } from "../../daemon/control";
import type { StatusSnapshot } from "../../domain/models";
import { loadStatusSnapshot } from "../../workflows/load-status";
import { formatStatusSnapshot } from "../status-presenter";
import { fetchJson, reportErrors, withProject, writeLine, type CliWriters } from "../runtime";

/** Build the `status` command. */
export function makeStatusCommand(io: CliWriters) {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const watch = Options.boolean("watch");

  const renderStatus = () => Effect.gen(function* () {
    const snapshot = yield* loadStatusSnapshot();
    yield* writeLine(writeOut, formatStatusSnapshot(snapshot).trimEnd());
  });

  const watchStatus = () => Effect.gen(function* () {
    const daemon = yield* DaemonControl;
    const state = yield* daemon.ensureRunning;

    return yield* Effect.forever(
      Effect.gen(function* () {
        const snapshot = yield* fetchJson<StatusSnapshot>(`${state.apiBaseUrl}/api/status`);

        yield* Effect.sync(() => {
          writeOut("\u001bc");
        });
        yield* writeLine(writeOut, formatStatusSnapshot(snapshot).trimEnd());
        yield* Effect.sleep("1 second");
      })
    );
  });

  return Command.make("status", { watch }, ({ watch }) =>
    reportErrors(
      withProject(
        (): Effect.Effect<void, unknown, ProjectAppServices> =>
          watch ? watchStatus() : renderStatus()
      ),
      writeErr
    )
  ).pipe(Command.withDescription("Show daemon and workspace status."));
}
