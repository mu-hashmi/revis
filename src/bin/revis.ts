#!/usr/bin/env node

/** CLI bin entrypoint for Revis. */

import { buildCli } from "../cli/app";

const program = buildCli();

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
