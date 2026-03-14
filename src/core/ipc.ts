/** IPC path helpers for the local Revis daemon. */

import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { pathExists } from "./files";
import { sha256Text } from "./text";

/** Return a deterministic socket path for the project root. */
export function daemonSocketPath(root: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\revis-${sha256Text(root).slice(0, 20)}`;
  }

  return join(root, ".revis", "runtime", "daemon.sock");
}

/** Remove a Unix socket path when it exists. */
export async function removeSocketPath(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  if (await pathExists(path)) {
    await unlink(path);
  }
}
