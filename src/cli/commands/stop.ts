/** `revis stop` command. */

import { Args, Command, Options } from "@effect/cli";
import * as Effect from "effect/Effect";

import { DaemonControl } from "../../daemon/control";
import { ValidationError } from "../../domain/errors";
import { WorkspaceStore } from "../../services/workspace-store";
import { reportErrors, withProject, writeLine, type CliWriters } from "../runtime";

/** Build the `stop` command. */
export function makeStopCommand(io: CliWriters) {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const agentId = Args.text({ name: "agent-id" });
  const optionalAgentId = agentId.pipe(Args.optional);
  const all = Options.boolean("all");

  return Command.make("stop", { agentId: optionalAgentId, all }, ({ agentId, all }) =>
    reportErrors(
      withProject(() =>
        Effect.gen(function* () {
          const daemon = yield* DaemonControl;

          if (all) {
            // The daemon treats an empty target list as "stop every tracked workspace."
            yield* daemon.stopWorkspaces([]);
            yield* daemon.shutdown;
            yield* writeLine(writeOut, "Stopped all workspaces and the daemon");
            return;
          }

          const id = agentId._tag === "Some" ? agentId.value : null;
          if (!id) {
            return yield* ValidationError.make({
              message: "Specify a workspace or use `revis stop --all`."
            });
          }

          const store = yield* WorkspaceStore;
          const snapshot = yield* store.get(id);
          if (!snapshot) {
            return yield* ValidationError.make({ message: `Unknown workspace ${id}` });
          }

          yield* daemon.stopWorkspaces([id]);
          yield* writeLine(writeOut, `Stopped ${snapshot.agentId}`);
        })
      ),
      writeErr
    )
  ).pipe(Command.withDescription("Stop one workspace or every workspace."));
}
