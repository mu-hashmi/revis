/** CLI-specific helpers for the Revis Vitest suite. */

import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildCli } from "../src/cli/app";
import { ensureDir } from "../src/core/files";

/** Run the Commander CLI in-process and capture stdout/stderr. */
export async function runCli(
  root: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const cwd = process.cwd();
  let stdout = "";
  let stderr = "";

  process.chdir(root);

  try {
    await buildCli({
      stderr(text) {
        stderr += text;
      },
      stdout(text) {
        stdout += text;
      }
    }).parseAsync(args, {
      from: "user"
    });
  } finally {
    process.chdir(cwd);
  }

  return { stdout, stderr };
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
