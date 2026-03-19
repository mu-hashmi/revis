/** Repository config loading, defaults, and `revis init` support. */

import { join } from "node:path";

import { Effect } from "effect";

import { ValidationError } from "../domain/errors";
import {
  ClaudeAgentConfig,
  CodexAgentConfig,
  CoordinationConfig,
  DockerSandboxConfig,
  E2BSandboxConfig,
  GitConfig,
  LocalSandboxConfig,
  OpenCodeAgentConfig,
  RevisConfig,
  DaytonaSandboxConfig,
  type AgentConfig,
  type AgentKind,
  type RevisConfig as RevisConfigType,
  type SandboxConfig,
  type SandboxKind
} from "../domain/models";
import { pathExists, readTextFile, writeTextFile } from "./files";
import { currentBranch, detectRemoteName } from "./git";
import { loadConfig, saveConfig } from "./store";

const DEFAULT_BRANCH_PREFIX = "revis";
const DEFAULT_DOCKER_IMAGE = "rivetdev/sandbox-agent:0.5.0-rc.1-full";

/** CLI-level overrides accepted by `revis init` and `revis spawn`. */
export interface ConfigOverrides {
  readonly agent?: AgentKind;
  readonly baseBranch?: string;
  readonly branchPrefix?: string;
  readonly env?: string[];
  readonly mode?: string;
  readonly model?: string;
  readonly remoteName?: string;
  readonly sandbox?: SandboxKind;
  readonly thought?: string;
}

/** Load the persisted config or create the same defaults `revis init` would write. */
export function loadOrCreateConfig(root: string, overrides: ConfigOverrides = {}) {
  return Effect.flatMap(
    loadConfig(root),
    // Once config exists, the repo defaults are authoritative for future runs.
    (existing) => (existing ? Effect.succeed(existing) : initConfig(root, overrides))
  );
}

/** Validate the repo, write config defaults, and update `.gitignore`. */
export function initConfig(root: string, overrides: ConfigOverrides = {}) {
  return Effect.gen(function* () {
    const remoteName = overrides.remoteName ?? (yield* detectRemoteName(root));
    const baseBranch = overrides.baseBranch ?? (yield* currentBranch(root));
    const branchPrefix = overrides.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    const env = [...(overrides.env ?? [])];
    const agent = yield* buildAgentConfig(overrides);

    const config = RevisConfig.make({
      version: 2,
      git: GitConfig.make({
        baseBranch,
        branchPrefix,
        remoteName
      }),
      sandbox: buildSandboxConfig(overrides.sandbox ?? "local", env),
      agent,
      coordination: CoordinationConfig.make({
        maxQueuedRelaysPerAgent: 8,
        maxRelayChars: 2_000,
        relayPolicy: "completed_turn"
      })
    });

    yield* saveConfig(root, config);
    yield* ensureGitignore(root);
    return config;
  });
}

/** Append `.revis/` to `.gitignore` when the project has not done so yet. */
export function ensureGitignore(root: string) {
  const path = join(root, ".gitignore");
  const entry = ".revis/";

  return Effect.gen(function* () {
    const text = (yield* pathExists(path)) ? yield* readTextFile(path) : "";

    if (text.split(/\r?\n/).includes(entry)) {
      return;
    }

    const next = text.length === 0 ? `${entry}\n` : `${text.replace(/\n?$/, "\n")}${entry}\n`;
    yield* writeTextFile(path, next);
  });
}

/** Build the sandbox config selected for this repository. */
function buildSandboxConfig(kind: SandboxKind, env: string[]): SandboxConfig {
  switch (kind) {
    case "local":
      return LocalSandboxConfig.make({ env, kind });
    case "daytona":
      return DaytonaSandboxConfig.make({ env, kind });
    case "e2b":
      return E2BSandboxConfig.make({ env, kind });
    case "docker":
      return DockerSandboxConfig.make({
        env,
        image: DEFAULT_DOCKER_IMAGE,
        kind
      });
  }
}

/** Build the default agent profile, validating provider-specific flags as we go. */
function buildAgentConfig(overrides: ConfigOverrides) {
  const kind = overrides.agent ?? "codex";

  switch (kind) {
    case "codex":
      return Effect.gen(function* () {
        const mode = yield* parseCodexMode(overrides.mode);
        const thoughtLevel = yield* parseThoughtLevel(overrides.thought);

        return CodexAgentConfig.make({
          kind,
          mode,
          model: overrides.model ?? "gpt-5.3-codex",
          thoughtLevel
        });
      });
    case "claude":
      if (overrides.thought) {
        return Effect.fail(new ValidationError({
          detail: "Claude does not support --thought"
        }));
      }

      return Effect.gen(function* () {
        const mode = yield* parseClaudeMode(overrides.mode);
        const model = yield* parseClaudeModel(overrides.model);

        return ClaudeAgentConfig.make({
          kind,
          mode,
          model
        });
      });
    case "opencode":
      if (overrides.thought) {
        return Effect.fail(new ValidationError({
          detail: "OpenCode does not support --thought"
        }));
      }

      return Effect.gen(function* () {
        const mode = yield* parseOpenCodeMode(overrides.mode);

        return OpenCodeAgentConfig.make({
          kind,
          mode,
          model: overrides.model ?? "opencode/gemini-3-pro"
        });
      });
  }
}

/** Parse the Codex mode flag into the narrow runtime literal. */
function parseCodexMode(
  value: string | undefined
): Effect.Effect<"read-only" | "auto" | "full-access", ValidationError> {
  if (value === undefined) {
    return Effect.succeed("full-access" as const);
  }

  if (value === "read-only" || value === "auto" || value === "full-access") {
    return Effect.succeed(value);
  }

  return Effect.fail(new ValidationError({
    detail: `unsupported codex mode: ${value}`
  }));
}

/** Parse the Codex thought level flag into the narrow runtime literal. */
function parseThoughtLevel(
  value: string | undefined
): Effect.Effect<"low" | "medium" | "high" | "xhigh", ValidationError> {
  if (value === undefined) {
    return Effect.succeed("high" as const);
  }

  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return Effect.succeed(value);
  }

  return Effect.fail(new ValidationError({
    detail: `unsupported thought level: ${value}`
  }));
}

/** Parse the Claude model flag into the narrow runtime literal. */
function parseClaudeModel(
  value: string | undefined
): Effect.Effect<"default" | "sonnet" | "opus" | "haiku", ValidationError> {
  if (value === undefined) {
    return Effect.succeed("default" as const);
  }

  if (value === "default" || value === "sonnet" || value === "opus" || value === "haiku") {
    return Effect.succeed(value);
  }

  return Effect.fail(new ValidationError({
    detail: `unsupported claude model: ${value}`
  }));
}

/** Parse the Claude mode flag into the narrow runtime literal. */
function parseClaudeMode(
  value: string | undefined
): Effect.Effect<"default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions", ValidationError> {
  if (value === undefined) {
    return Effect.succeed("default" as const);
  }

  if (
    value === "default" ||
    value === "acceptEdits" ||
    value === "plan" ||
    value === "dontAsk" ||
    value === "bypassPermissions"
  ) {
    return Effect.succeed(value);
  }

  return Effect.fail(new ValidationError({
    detail: `unsupported claude mode: ${value}`
  }));
}

/** Parse the OpenCode mode flag into the narrow runtime literal. */
function parseOpenCodeMode(
  value: string | undefined
): Effect.Effect<"build" | "plan", ValidationError> {
  if (value === undefined) {
    return Effect.succeed("build" as const);
  }

  if (value === "build" || value === "plan") {
    return Effect.succeed(value);
  }

  return Effect.fail(new ValidationError({
    detail: `unsupported opencode mode: ${value}`
  }));
}
