/** Filesystem and JSON helpers shared across Revis modules. */

import {
  access,
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Ensure a directory exists and return its path. */
export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

/** Return whether a path exists. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

/** Read JSON from disk. */
export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Write stable JSON to disk. */
export async function writeJson(path: string, payload: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

/** Append one JSON object to a JSONL file. */
export async function appendJsonl(
  path: string,
  payload: Record<string, unknown>
): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, `${JSON.stringify(payload)}\n`, "utf8");
}

/** Create a temporary directory and clean it up afterward. */
export async function withTempDir<T>(
  prefix: string,
  fn: (path: string) => Promise<T>
): Promise<T> {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
