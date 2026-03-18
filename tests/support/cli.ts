/** Helpers for invoking the built Revis CLI and parsing its operator-facing status output. */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCommand, type CommandResult } from "./git";

export interface RunCliOptions {
  readonly allowFailure?: boolean;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ParsedWorkspaceStatus {
  readonly agentId: string;
  readonly state: string;
  readonly iteration: number;
  readonly aheadCount: number;
  readonly head?: string;
  readonly subject?: string;
  readonly raw: string;
}

/** Return the built Revis CLI entrypoint used by acceptance tests. */
export function revisExecutable(): string {
  return join(process.cwd(), "dist", "bin", "revis.js");
}

/** Run the built Revis CLI and capture stdout, stderr, and exit code. */
export async function runCli(
  args: ReadonlyArray<string>,
  options: RunCliOptions
): Promise<CommandResult> {
  const executable = revisExecutable();
  if (!existsSync(executable)) {
    throw new Error(`Missing built CLI at ${executable}`);
  }

  const env = {
    ...process.env,
    ...options.env,
    REVIS_EXECUTABLE: executable
  };

  // Run the bundled CLI with the current Node executable so acceptance tests exercise the same
  // entrypoint developers and CI use after `npm run build`.
  const result = await runCommand(process.execPath, [executable, ...args], {
    cwd: options.cwd,
    env
  });

  if (!options.allowFailure && result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "revis command failed");
  }

  return result;
}

/** Parse workspace rows from `revis status`. */
export function parseWorkspaceStatuses(output: string): ReadonlyArray<ParsedWorkspaceStatus> {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("  agent-"))
    .map((line) => {
      // Status rows are formatted as fixed columns separated by repeated spaces, so split on two
      // or more spaces rather than single whitespace.
      const fields = line.trim().split(/\s{2,}/);
      const iterationField = fields.find((field) => field.startsWith("iter="));
      const aheadField = fields.find((field) => field.startsWith("ahead="));
      const headField = fields.find((field) => field.startsWith("head="));
      const subjectIndex = fields.findIndex((field) => field.startsWith("ahead="));

      return {
        agentId: fields[0]!,
        state: fields[1]!,
        iteration: Number.parseInt(iterationField?.slice("iter=".length) ?? "0", 10),
        aheadCount: Number.parseInt(aheadField?.slice("ahead=".length) ?? "0", 10),
        ...(headField ? { head: headField.slice("head=".length) } : {}),
        ...(subjectIndex >= 0 && subjectIndex + 2 < fields.length
          ? { subject: fields.slice(subjectIndex + 2).join("  ") }
          : {}),
        raw: line
      } satisfies ParsedWorkspaceStatus;
    });
}
