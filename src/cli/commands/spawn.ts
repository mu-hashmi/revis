/** `revis spawn` command. */

import { Args, Command, Options } from "@effect/cli";
import * as Effect from "effect/Effect";

import { DaemonControl } from "../../daemon/control";
import { createWorkspaces } from "../../workflows/workspace-lifecycle";
import { reportErrors, withProject, writeLine, type CliWriters } from "../runtime";

/** Build the `spawn` command. */
export function makeSpawnCommand(io: CliWriters) {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const count = Args.integer({ name: "count" });
  const execCommand = Options.text("exec");

  return Command.make("spawn", { count, execCommand }, ({ count, execCommand }) =>
    reportErrors(
      withProject(() =>
        Effect.gen(function* () {
          const daemon = yield* DaemonControl;

          yield* daemon.ensureRunning;
          const created = yield* createWorkspaces(count, execCommand);
          yield* daemon.reconcile("spawn");

          for (const snapshot of created) {
            yield* writeLine(
              writeOut,
              `${snapshot.agentId} ${snapshot.spec.localBranch} ${snapshot.spec.workspaceRoot}`
            );
          }
        })
      ),
      writeErr
    )
  ).pipe(Command.withDescription("Create isolated workspaces."));
}
