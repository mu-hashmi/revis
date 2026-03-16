/** Project setup helpers used by `revis init`. */

import { join } from "node:path";

import type { RevisConfig } from "../core/models";
import { saveConfig, DEFAULT_REMOTE_POLL_SECONDS } from "../core/config";
import { appendMissingLines } from "../core/text-files";
import {
  bootstrapCoordinationRemote,
  currentBranch,
  determineRemoteName,
  ensureCoordinationRemote,
  remoteUrl
} from "./repo";

/** Build the default config for one repository. */
export async function buildDefaultConfig(root: string): Promise<RevisConfig> {
  const remoteName = await determineRemoteName(root);
  return {
    coordinationRemote: remoteName,
    trunkBase: await currentBranch(root),
    remotePollSeconds: DEFAULT_REMOTE_POLL_SECONDS
  };
}

/** Resolve or create the coordination remote URL/path. */
export async function configureCoordinationRemote(
  root: string,
  remoteName: string
): Promise<string> {
  if (remoteName === "revis-local") {
    return ensureCoordinationRemote(root);
  }

  return remoteUrl(root, remoteName);
}

/** Initialize Revis in the current repository. */
export async function initializeProject(root: string): Promise<RevisConfig> {
  const config = await buildDefaultConfig(root);
  const targetUrl = await configureCoordinationRemote(root, config.coordinationRemote);
  await bootstrapCoordinationRemote(
    root,
    config.coordinationRemote,
    targetUrl,
    config.trunkBase
  );
  await saveConfig(root, config);
  await ensureGitignore(root);
  return config;
}

/** Append Revis runtime paths to `.gitignore` when missing. */
export async function ensureGitignore(root: string): Promise<void> {
  const path = join(root, ".gitignore");
  const lines = [
    "# Revis runtime state stays local because it only drives local status and dashboard views.",
    ".revis/runtime/",
    "# Session archives keep local run history for the dashboard.",
    ".revis/sessions/",
    "# Local workspaces are disposable clones, not project source.",
    ".revis/workspaces/",
    "# Local mode uses a hidden bare coordination remote as an implementation detail.",
    ".revis/coordination.git/"
  ];
  await appendMissingLines(path, lines);
}
