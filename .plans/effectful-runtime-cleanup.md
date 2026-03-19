# Make Revis More Effectful

## Summary
- Fix the five flagged Effect gaps without broad cleanup or API churn.
- Keep the current `Context.Tag` service style. Do not convert the repo to `Effect.Service`.
- Treat `HttpClient` and `FileSystem` as real platform dependencies, not globals hidden behind `fetch` or `node:fs/promises`.
- Use explicit, opinionated queue semantics with no new config knobs: reconcile is `latest wins`, live streams are bounded by `PubSub.sliding(64)`.
- Keep code small and skimmable: no compatibility shims, no optional override bags, no new generic abstraction layer beyond one thin HTTP helper module.

## Key Changes
- Queue semantics:
  - Change the daemon reconcile queue in `src/daemon/control.ts` from `Queue.unbounded` to `Queue.sliding(1)`.
  - Change the live `PubSub` instances in `src/services/event-journal.ts` and `src/services/workspace-store.ts` from `unbounded` to `sliding(64)`.
  - Keep these capacities inline and fixed. Do not make them configurable.
  - Rationale: the source of truth is already persisted state, and live consumers should never be able to grow memory without bound or stall the daemon.

- HTTP runtime:
  - Add one small internal helper module for daemon HTTP calls and SSE consumption, built on stable `@effect/platform/HttpClient`, `HttpClientResponse.filterStatusOk`, `HttpClientResponse.schemaBodyJson`, and `HttpClientResponse.stream`.
  - Replace raw `fetch` usage in `src/cli/runtime.ts`, `src/daemon/http.ts`, and `src/cli/commands/events.ts` with that helper.
  - Rewrite the SSE client in `revis events --follow` as an Effect stream pipeline instead of an `async` reader loop.
  - Parse SSE frames into a tiny discriminated union such as `event | retry | ignore`, and exhaustively switch on `_tag`. Unknown frame shapes should fail loudly.
  - Keep existing daemon endpoints and payload shapes unchanged.

- FileSystem migration:
  - Inject `FileSystem` into `src/providers/local.ts` and replace direct `open`, `readFile`, `writeFile`, `rm`, and `access` usage with `FileSystem.open`, `readFileString`, `writeFileString`, `remove`, and `exists`.
  - Keep the current local-provider behavior exactly the same: append log file, persisted exit file, detached child process, and full runtime-dir removal on destroy.
  - Replace direct file reads in `src/daemon/http.ts` with `FileSystem` for static dashboard assets and daemon-state polling.
  - Replace direct file reads in `src/platform/runtime.ts` with `FileSystem.readFileString`; `packageVersion` should become Effectful over `FileSystem` instead of doing Node I/O internally.
  - Remove any now-unused Promise sleep or fs helpers that become dead after this refactor.

- Daemon supervision and instrumentation:
  - Add `Effect.annotateLogs` around daemon background loops with stable fields like `service`, `agentId`, and `reason`.
  - Add `Effect.tapErrorCause(Effect.logError)` before any loop swallows or converts failures.
  - Keep the existing persisted daemon/workspace error recording, but log before swallowing so failures are visible immediately.
  - Treat the HTTP serve fiber as fatal: fork it, then race daemon shutdown against `Fiber.join(serverFiber)` so the daemon exits if serving dies.
  - Keep the reconcile worker and workspace supervisors non-failing by handling and logging inside the loop body rather than letting child fibers silently die.
  - Keep route behavior simple: validation errors still return `400`, unexpected failures still return plain `500`, but the full cause is logged first.

- Local shutdown timing:
  - Rewrite `stopLocalProcess` in `src/providers/local.ts` to use `Effect.sleep`, `Effect.repeat`/`until`, and `Effect.timeout` instead of `Date.now()` plus Promise sleep.
  - Preserve the current behavior exactly: send `SIGTERM`, wait up to `PROCESS_STOP_TIMEOUT_MS`, then send `SIGKILL` once if the process is still alive.
  - Do not add retries, fallback exit states, or extra flags.

## Interface Changes
- Extend the platform environment types to include `HttpClient.HttpClient` anywhere CLI and daemon code now depend on HTTP.
- Provide `NodeHttpClient.layerUndici` at the runtime edge in `src/bin/revis.ts` and in every test layer/harness that currently only provides `NodeContext.layer`.
- Expand the local provider layer requirement to include `FileSystem.FileSystem`.
- Let `packageVersion` require `FileSystem.FileSystem`; keep its return type and command output unchanged.
- Do not add any new public CLI flags, env vars, config fields, or user-facing daemon routes.

## Validation
- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run build`.
- Run `npm run test:acceptance` because this touches CLI, daemon transport, and runtime wiring.
- Add two static checks to the implementation checklist:
  - `rg "fetch\\(" src/cli src/daemon` should return no remaining raw HTTP usage in the refactored paths.
  - `rg "node:fs/promises" src/providers/local.ts src/daemon/http.ts src/platform/runtime.ts` should return no remaining direct file I/O in the refactored paths.
- Do not add or modify test files unless you explicitly decide to override the repo rule later; this plan assumes validation is done with the existing suite.

## Assumptions And Defaults
- Queue policy is locked to `Latest Wins`: `Queue.sliding(1)` for reconcile and `PubSub.sliding(64)` for journal/store live streams.
- This refactor is intentionally narrow. It does not convert every raw Node API in the repo, only the exact areas covered by the five findings.
- `Context.Tag` remains the service pattern for this repo.
- Buffer sizes and timeouts stay hard-coded and opinionated; no new configuration surface is added.
