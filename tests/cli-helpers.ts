/** CLI-specific helpers for the Revis Vitest suite. */

import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCli } from "../src/cli/app";
import { ensureDir } from "../src/core/files";
import { runCommand } from "../src/core/process";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const builtCliPath = fileURLToPath(new URL("../dist/bin/revis.js", import.meta.url));

let builtCliReady: Promise<string> | null = null;

/** Run the Commander CLI in-process and capture stdout/stderr. */
export async function runCli(
  root: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const cwd = process.cwd();
  const originalExecutable = process.env.REVIS_EXECUTABLE;
  const originalExit = process.exit;
  let stdout = "";
  let stderr = "";

  process.chdir(root);
  process.env.REVIS_EXECUTABLE = await ensureBuiltCli();
  process.exit = ((code?: number) => {
    throw new Error(
      stderr.trim() || stdout.trim() || `process.exit unexpectedly called with "${code ?? 0}"`
    );
  }) as typeof process.exit;

  try {
    const program = buildCli({
      stderr(text) {
        stderr += text;
      },
      stdout(text) {
        stdout += text;
      }
    }).exitOverride();

    await program.parseAsync(args, {
      from: "user"
    });
  } finally {
    process.exit = originalExit;
    process.env.REVIS_EXECUTABLE = originalExecutable;
    process.chdir(cwd);
  }

  return { stdout, stderr };
}

/** Build the packaged Revis CLI once so detached daemon tests use the real bin entrypoint. */
async function ensureBuiltCli(): Promise<string> {
  if (!builtCliReady) {
    builtCliReady = (async () => {
      await runCommand(["npm", "run", "build"], { cwd: repoRoot });
      return builtCliPath;
    })();
  }

  return builtCliReady;
}

/** Create a Node-based fake `gh` executable for promotion tests. */
export async function createFakeGh(binRoot: string): Promise<{
  binDir: string;
  statePath: string;
}> {
  const binDir = join(binRoot, "fake-bin");
  const statePath = join(binRoot, "gh-state.json");
  const ghPath = join(binDir, "gh");
  const fixturePath = new URL("./fixtures/fake-gh.cjs", import.meta.url);

  await ensureDir(binDir);
  await writeFile(ghPath, await readFile(fixturePath, "utf8"), "utf8");
  await chmod(ghPath, 0o755);

  return { binDir, statePath };
}
