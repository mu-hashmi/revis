/** Sandbox Agent SDK integration for provider selection and repo bootstrap. */

import { join } from "node:path";

import { Effect, Schema } from "effect";
import {
  SandboxAgent,
  buildInspectorUrl,
  type ProcessRunResponse,
  type SandboxProvider,
  type Session
} from "sandbox-agent";

import { SandboxError, detailFromUnknown } from "../domain/errors";
import { type ParticipantRecord, type RevisConfig, type SandboxConfig } from "../domain/models";
import { unreachable } from "./assert";
import { repositoryDirectoryName } from "./git";
import { FileSessionPersistDriver } from "./session-persist";

/** Connected Sandbox Agent SDK handle plus the provider-specific metadata Revis needs. */
export interface SandboxHandle {
  readonly baseUrl: string;
  readonly fetcher: typeof fetch;
  readonly inspectorUrl: string;
  readonly provider: SandboxProvider;
  readonly rawSandboxId: string;
  readonly sandboxId: string;
  readonly sdk: SandboxAgent;
}

/** One question currently blocking a sandbox session. */
export interface PendingQuestion {
  readonly id: string;
  readonly options: string[];
  readonly prompt: string;
  readonly sessionId: string;
}

const PendingQuestionResponseSchema = Schema.Array(
  Schema.Struct({
    id: Schema.NonEmptyString,
    session_id: Schema.NonEmptyString,
    questions: Schema.NonEmptyArray(
      Schema.Struct({
        options: Schema.Array(
          Schema.Struct({
            label: Schema.NonEmptyString
          })
        ),
        question: Schema.NonEmptyString
      })
    )
  })
);

/** Start or reconnect one sandbox for a participant. */
export function startSandbox(
  config: SandboxConfig,
  persist: FileSessionPersistDriver,
  sandboxId: string | null
) {
  const sandbox = sandboxId ?? config.kind;

  return Effect.acquireRelease(
    Effect.gen(function* () {
      // Connect the provider first so sandbox creation and reconnection share one path.
      const provider = yield* createProvider(config, sandbox);
      const sdk = yield* Effect.tryPromise({
        try: () =>
          SandboxAgent.start(
            sandboxId
              ? {
                  persist,
                  sandbox: provider,
                  sandboxId
                }
              : {
                  persist,
                  sandbox: provider
                }
          ),
        catch: (cause) =>
          new SandboxError({
            detail: detailFromUnknown(cause),
            sandbox
          })
      });
      const prefixedSandboxId = sdk.sandboxId;

      if (!prefixedSandboxId) {
        return yield* new SandboxError({
          detail: "sandbox agent did not return a sandbox id",
          sandbox
        });
      }

      const rawSandboxId = parseRawSandboxId(prefixedSandboxId);

      // Prefer provider-native URLs and fetchers when they exist.
      const baseUrl = provider.getUrl
        ? yield* Effect.tryPromise({
            try: () => provider.getUrl!(rawSandboxId),
            catch: (cause) =>
              new SandboxError({
                detail: detailFromUnknown(cause),
                sandbox: prefixedSandboxId
              })
          })
        : stripInspectorSuffix(sdk.inspectorUrl);
      const fetcher = provider.getFetch
        ? yield* Effect.tryPromise({
            try: () => provider.getFetch!(rawSandboxId),
            catch: (cause) =>
              new SandboxError({
                detail: detailFromUnknown(cause),
                sandbox: prefixedSandboxId
              })
          })
        : fetch;
      const token = yield* providerToken(provider, rawSandboxId, prefixedSandboxId);

      return {
        baseUrl,
        fetcher,
        inspectorUrl: token ? buildInspectorUrl({ baseUrl, token }) : sdk.inspectorUrl,
        provider,
        rawSandboxId,
        sandboxId: prefixedSandboxId,
        sdk
      } satisfies SandboxHandle;
    }),
    (handle) =>
      Effect.orDie(
        // Sandbox disposal is best-effort cleanup at scope exit.
        Effect.promise(() => handle.sdk.dispose())
      )
  );
}

/** Create or resume one SDK session inside the sandbox. */
export function loadSession(
  handle: SandboxHandle,
  config: RevisConfig,
  participant: ParticipantRecord
) {
  return Effect.tryPromise({
    try: () =>
      participant.sessionId
        ? handle.sdk.resumeSession(participant.sessionId)
        : handle.sdk.createSession(sessionRequest(config, participant.workspaceRoot)),
    catch: (cause) =>
      new SandboxError({
        detail: detailFromUnknown(cause),
        sandbox: handle.sandboxId
      })
  });
}

/** Clone or refresh the repository inside one non-local sandbox. */
export function bootstrapRemoteWorkspace(input: {
  readonly baseBranch: string;
  readonly branch: string;
  readonly handle: SandboxHandle;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly root: string;
}) {
  const workspaceRoot = join("/workspace", repositoryDirectoryName(input.root));

  return Effect.gen(function* () {
    // Ensure the shared workspace root exists before we test or clone into it.
    yield* runSandboxCommand(input.handle, {
      command: "mkdir",
      args: ["-p", "/workspace"]
    });

    const exists = yield* runSandboxCommand(
      input.handle,
      {
        command: "test",
        args: ["-d", workspaceRoot]
      },
      { check: false }
    );

    if (exists.exitCode !== 0) {
      // Clone once, then keep reusing the sandbox-local repository on reconnect.
      yield* runSandboxCommand(input.handle, {
        command: "git",
        args: ["clone", "--origin", input.remoteName, input.remoteUrl, workspaceRoot]
      });
    }

    // Reset the branch to the current remote base so every reconnect starts clean.
    yield* runSandboxCommand(input.handle, {
      command: "git",
      args: ["fetch", input.remoteName, input.baseBranch],
      cwd: workspaceRoot
    });

    yield* runSandboxCommand(input.handle, {
      command: "git",
      args: ["checkout", "-B", input.branch, `${input.remoteName}/${input.baseBranch}`],
      cwd: workspaceRoot
    });

    yield* runSandboxCommand(input.handle, {
      command: "git",
      args: ["config", "user.name", "Revis"],
      cwd: workspaceRoot
    });

    yield* runSandboxCommand(input.handle, {
      command: "git",
      args: ["config", "user.email", "revis@localhost"],
      cwd: workspaceRoot
    });

    return workspaceRoot;
  });
}

/** List any pending questions currently blocking sessions in the sandbox. */
export function listPendingQuestions(handle: SandboxHandle) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => handle.fetcher(new URL("/opencode/question", handle.baseUrl)),
      catch: (cause) =>
        new SandboxError({
          detail: detailFromUnknown(cause),
          sandbox: handle.sandboxId
        })
    });

    if (!response.ok) {
      return yield* new SandboxError({
        detail: `question list failed with status ${response.status}`,
        sandbox: handle.sandboxId
      });
    }

    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        new SandboxError({
          detail: detailFromUnknown(cause),
          sandbox: handle.sandboxId
        })
    });
    const decoded = yield* Schema.decodeUnknown(PendingQuestionResponseSchema)(payload).pipe(
      Effect.mapError(
        (cause) =>
          new SandboxError({
            detail: detailFromUnknown(cause),
            sandbox: handle.sandboxId
          })
      )
    );

    // The endpoint can batch multiple question objects, but Revis only uses the first prompt/options pair.
    return decoded.map((item) => ({
      id: item.id,
      options: item.questions[0]!.options.map((option) => option.label),
      prompt: item.questions[0]!.question,
      sessionId: item.session_id
    } satisfies PendingQuestion));
  });
}

/** Run one process inside the sandbox and fail loudly on non-zero exit by default. */
export function runSandboxCommand(
  handle: SandboxHandle,
  request: {
    readonly args?: string[];
    readonly command: string;
    readonly cwd?: string;
    readonly env?: Record<string, string>;
  },
  options: { readonly check?: boolean } = {}
) {
  return Effect.gen(function* () {
    // Build the request explicitly so absent fields stay absent in the SDK payload.
    const response = yield* Effect.tryPromise({
      try: () =>
        handle.sdk.runProcess({
          ...(request.args ? { args: [...request.args] } : {}),
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.env ? { env: request.env } : {}),
          command: request.command
        }),
      catch: (cause) =>
        new SandboxError({
          detail: detailFromUnknown(cause),
          sandbox: handle.sandboxId
        })
    });

    // Timed out processes are operator-visible failures too.
    if (options.check !== false && (response.timedOut || response.exitCode !== 0)) {
      const detail = response.stderr.trim() || response.stdout.trim() || "sandbox command failed";

      return yield* new SandboxError({
        detail: `${request.command}: ${detail}`,
        sandbox: handle.sandboxId
      });
    }

    return response;
  });
}

/** Destroy one sandbox. */
export function destroySandbox(handle: SandboxHandle) {
  return Effect.tryPromise({
    try: () => handle.sdk.destroySandbox(),
    catch: (cause) =>
      new SandboxError({
        detail: detailFromUnknown(cause),
        sandbox: handle.sandboxId
      })
  });
}

/** Query one sandbox health snapshot. */
export function sandboxHealth(handle: SandboxHandle) {
  return Effect.tryPromise({
    try: () => handle.sdk.getHealth(),
    catch: (cause) =>
      new SandboxError({
        detail: detailFromUnknown(cause),
        sandbox: handle.sandboxId
      })
  });
}

/** Build the SDK session request for the configured agent kind. */
function sessionRequest(config: RevisConfig, cwd: string) {
  switch (config.agent.kind) {
    case "codex":
      return {
        agent: "codex",
        cwd,
        model: config.agent.model,
        mode: config.agent.mode,
        thoughtLevel: config.agent.thoughtLevel
      };
    case "claude":
      return {
        agent: "claude",
        cwd,
        model: config.agent.model,
        mode: config.agent.mode
      };
    case "opencode":
      return {
        agent: "opencode",
        cwd,
        model: config.agent.model,
        mode: config.agent.mode
      };
    default:
      return unreachable(config.agent);
  }
}

/** Lazily load the configured sandbox provider implementation. */
function createProvider(config: SandboxConfig, sandbox: string) {
  switch (config.kind) {
    case "local":
      return Effect.gen(function* () {
        const { local } = yield* Effect.tryPromise({
          try: () => import("sandbox-agent/local"),
          catch: (cause) =>
            new SandboxError({
              detail: detailFromUnknown(cause),
              sandbox
            })
        });

        return local({
          // Local sandboxes expect an object map, unlike Docker.
          env: yield* passthroughEnvObject(config.env, sandbox)
        });
      });
    case "daytona":
      return Effect.gen(function* () {
        const { daytona } = yield* Effect.tryPromise({
          try: () => import("sandbox-agent/daytona"),
          catch: (cause) =>
            new SandboxError({
              detail: detailFromUnknown(cause),
              sandbox
            })
        });
        return daytona();
      });
    case "e2b":
      return Effect.gen(function* () {
        const { e2b } = yield* Effect.tryPromise({
          try: () => import("sandbox-agent/e2b"),
          catch: (cause) =>
            new SandboxError({
              detail: detailFromUnknown(cause),
              sandbox
            })
        });
        return e2b();
      });
    case "docker":
      return Effect.gen(function* () {
        const { docker } = yield* Effect.tryPromise({
          try: () => import("sandbox-agent/docker"),
          catch: (cause) =>
            new SandboxError({
              detail: detailFromUnknown(cause),
              sandbox
            })
        });

        return docker({
          // Docker expects `NAME=value` pairs rather than an object map.
          env: yield* passthroughEnvList(config.env, sandbox),
          image: config.image
        });
      });
    default:
      return unreachable(config);
  }
}

/** Read required environment variables into the object form used by the local provider. */
function passthroughEnvObject(names: readonly string[], sandbox: string) {
  return Effect.gen(function* () {
    const env: Record<string, string> = {};

    for (const name of names) {
      const value = process.env[name];
      if (value === undefined) {
        return yield* new SandboxError({
          detail: `${name} is not set in the current environment`,
          sandbox
        });
      }

      env[name] = value;
    }

    return env;
  });
}

/** Read required environment variables into the `NAME=value` form used by Docker. */
function passthroughEnvList(names: readonly string[], sandbox: string) {
  return Effect.gen(function* () {
    const values: string[] = [];

    for (const name of names) {
      const value = process.env[name];
      if (value === undefined) {
        return yield* new SandboxError({
          detail: `${name} is not set in the current environment`,
          sandbox
        });
      }

      values.push(`${name}=${value}`);
    }

    return values;
  });
}

/** Read an optional provider auth token for building inspector URLs. */
function providerToken(provider: SandboxProvider, rawSandboxId: string, sandbox: string) {
  const tokenProvider = provider as SandboxProvider & {
    getToken?: (sandboxId: string) => Promise<string | undefined>;
  };

  if (!tokenProvider.getToken) {
    return Effect.sync(() => undefined as string | undefined);
  }

  return Effect.tryPromise({
    try: () => tokenProvider.getToken!(rawSandboxId),
    catch: (cause) =>
      new SandboxError({
        detail: detailFromUnknown(cause),
        sandbox
      })
  });
}

/** Strip the provider prefix from `provider/id` sandbox identifiers. */
function parseRawSandboxId(prefixedSandboxId: string): string {
  const slash = prefixedSandboxId.indexOf("/");
  if (slash < 0) {
    throw new Error("sandbox id is missing its provider prefix");
  }

  return prefixedSandboxId.slice(slash + 1);
}

/** Derive the base sandbox URL from inspector URLs that already include `/ui/`. */
function stripInspectorSuffix(url: string): string {
  return url.replace(/\/ui\/?$/, "");
}
