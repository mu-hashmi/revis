/** Revis CLI wiring. */

import { Command } from "@effect/cli";

import { makeDashboardCommand } from "./commands/dashboard";
import { makeDaemonRunCommand } from "./commands/daemon-run";
import { makeEventsCommand } from "./commands/events";
import { makeInitCommand } from "./commands/init";
import { makePromoteCommand } from "./commands/promote";
import { makeSpawnCommand } from "./commands/spawn";
import { makeStatusCommand } from "./commands/status";
import { makeStopCommand } from "./commands/stop";
import { makeVersionCommand } from "./commands/version";
import type { CliWriters } from "./runtime";

/** Build the top-level Revis CLI command tree. */
export function buildCli(io: CliWriters = {}) {
  return Command.make("revis").pipe(
    Command.withDescription("Passive git-backed workspace coordination."),
    Command.withSubcommands([
      makeInitCommand(io),
      makeSpawnCommand(io),
      makeStatusCommand(io),
      makeEventsCommand(io),
      makeDashboardCommand(io),
      makePromoteCommand(io),
      makeStopCommand(io),
      makeVersionCommand(io),
      makeDaemonRunCommand(io)
    ])
  );
}
