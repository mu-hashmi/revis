/** `revis promote` command. */

import { Args, Command } from "@effect/cli";
import * as Effect from "effect/Effect";

import { DaemonControl } from "../../daemon/control";
import { PromotionService } from "../../promotion/service";
import { reportErrors, withProject, writeLine, type CliWriters } from "../runtime";

/** Build the `promote` command. */
export function makePromoteCommand(io: CliWriters) {
  const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const agentId = Args.text({ name: "agent-id" });

  return Command.make("promote", { agentId }, ({ agentId }) =>
    reportErrors(
      withProject(() =>
        Effect.gen(function* () {
          const daemon = yield* DaemonControl;
          const promotion = yield* PromotionService;
          const result = yield* promotion.promoteWorkspace(agentId);

          yield* daemon.reconcile("promote").pipe(Effect.ignore);
          yield* writeLine(writeOut, result.summary);
          if (result.pullRequest) {
            yield* writeLine(writeOut, result.pullRequest.url);
          }
        })
      ),
      writeErr
    )
  ).pipe(Command.withDescription("Promote one workspace."));
}
