/** Load and persist `.revis/config.json`. */

import { join } from "node:path";

import type { RevisConfig } from "./models";
import { RevisError } from "./error";
import { pathExists, readJson, writeJson } from "./files";

export const CONFIG_DIR = ".revis";
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DEFAULT_REMOTE_POLL_SECONDS = 5;

/** Return whether a Revis config file already exists. */
export async function configExists(root: string): Promise<boolean> {
  return pathExists(join(root, CONFIG_PATH));
}

/** Load project configuration from disk. */
export async function loadConfig(root: string): Promise<RevisConfig> {
  const path = join(root, CONFIG_PATH);
  if (!(await pathExists(path))) {
    throw new RevisError(`Missing config: ${path}`);
  }

  const data = await readJson<Partial<RevisConfig>>(path);
  return {
    coordinationRemote: requiredString(data.coordinationRemote, "coordinationRemote"),
    trunkBase: requiredString(data.trunkBase, "trunkBase"),
    remotePollSeconds: requiredPositiveInteger(
      data.remotePollSeconds,
      "remotePollSeconds"
    )
  };
}

/** Persist project configuration. */
export async function saveConfig(
  root: string,
  config: RevisConfig
): Promise<string> {
  const path = join(root, CONFIG_PATH);
  await writeJson(path, config);
  return path;
}

/** Require one non-empty string config value. */
function requiredString(value: string | undefined, name: string): string {
  if (!value) {
    throw new RevisError(`Config is missing ${name}`);
  }

  return value;
}

/** Require one positive integer config value. */
function requiredPositiveInteger(
  value: number | undefined,
  name: string
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RevisError(`Config is missing valid ${name}`);
  }

  return value;
}
