/** Small text-file helpers for append/update flows that must stay readable. */

import { appendFile, readFile } from "node:fs/promises";

/**
 * Read a text file when it exists.
 *
 * Missing files return an empty string; other filesystem failures surface.
 */
export async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

/** Append lines that are not already present in a text file. */
export async function appendMissingLines(
  path: string,
  lines: string[]
): Promise<void> {
  const existing = await readTextIfExists(path);
  const missing = lines.filter((line) => !existing.includes(line));
  if (missing.length === 0) {
    return;
  }

  const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  await appendFile(path, `${prefix}${missing.join("\n")}\n`, "utf8");
}
