# Instructions for coding agents working on this codebase

Revis is a passive coordination CLI for sandboxed coding agent workspaces.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `npx effect-solutions list` to see available guides
2. Run `npx effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `.reference/effect/` for real implementations; the Effect repo is already cloned locally for reference

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->

## Local Effect Source

The Effect repository is cloned to `.reference/effect/` for local reference.

## Scope

Revis owns three things:

- creating isolated local workspace clones on namespaced git branches
- running a host daemon that pushes/fetches branch updates and relays commit summaries into local or Daytona-backed sandboxes
- promoting one chosen workspace branch into trunk or into a pull request

Do not reintroduce findings ledgers, agent protocols, AGENTS injection, or any other agent-facing coordination layer unless explicitly requested.

## Architecture

The code lives under `src/`:

- `src/domain/`
  - immutable schemas, tagged unions, branded types, and tagged errors
- `src/services/`
  - persistent project services: project paths, config, workspace store, and event journal
- `src/git/`
  - host-repo operations, branch naming, managed-trunk bootstrap, and workspace git helpers
- `src/providers/`
  - workspace runtime boundary and concrete local/Daytona providers
- `src/daemon/`
  - daemon control, reconcile fan-out, workspace supervision, HTTP routes, and transport helpers
- `src/workflows/`
  - operator-facing use cases like init, spawn, and status loading
- `src/promotion/`
  - managed-trunk and pull-request promotion flows
- `src/app/`
  - top-level layer composition for project commands and daemon processes
- `src/platform/`
  - explicit Node/platform boundaries such as subprocesses, browser opening, storage helpers, and small text/time utilities
- `src/cli/`
  - `@effect/cli` command wiring and shared status formatting
  - keep entrypoints thin and delegate to workflows/services
- `src/bin/`
  - CLI entrypoint with the executable shebang

Current important modules:

- `src/services/project-paths.ts`
  - owns the `.revis/` path layout for state, journal, archive, workspaces, and dashboard assets
- `src/services/project-config.ts`
  - owns `.revis/config.json`
- `src/services/workspace-store.ts`
  - persisted daemon/workspace snapshots plus live change streams
- `src/services/event-journal.ts`
  - append-only live journal plus session archive projection
- `src/git/host-git.ts`
  - host-side git service for repo discovery, fetch/push, summaries, and identity
- `src/providers/local.ts`
  - local clone and detached-session provider
- `src/providers/daytona.ts`
  - Daytona-backed workspace provider
- `src/daemon/control.ts`
  - daemon lifecycle control plus the in-process daemon program
- `src/daemon/reconcile-loop.ts`
  - global reconcile scheduling and fan-out
- `src/daemon/workspace-supervisor.ts`
  - one supervisor fiber per active workspace
- `src/daemon/routes.ts`
  - daemon HTTP/SSE routes and dashboard asset serving
- `src/workflows/workspace-lifecycle.ts`
  - workspace provisioning helpers
- `src/promotion/service.ts`
  - operator-facing promotion orchestration for managed trunk and GitHub PR flows

## Product invariants

- Workspace coordination refs are always `revis/<operator>/agent-<n>/work`.
- A workspace's checked-out local branch may differ from its coordination ref.
- The operator slug comes from local git identity.
- `revis init` prefers `origin`, otherwise the sole remote, otherwise creates `.revis/coordination.git` as `revis-local`.
- Local workspaces live under `.revis/workspaces/agent-<n>/repo`.
- `revis spawn` is the only public command that creates workspaces; `--exec` is required and agent-agnostic.
- The daemon is event-driven for local commits and poll-driven for remote discovery.
- The daemon baselines current local and remote heads on startup; only newer commits should be pushed or relayed.
- Promotion is operator-only.
- Agents do not run `revis` commands inside their sessions.

If a change would violate one of these, stop and verify that the product change is intentional.

## Conventions

- Use JSDoc-style module/function comments on public functions and on non-trivial internal helpers.
- Add blank lines between logical phases inside functions.
- Prefer loud failures over silent fallbacks. If state is corrupted, surface it.
- Keep ownership clear:
  - generic git helpers in `src/git/host-git.ts` and nearby `src/git/*` modules
  - provider-specific sandbox behavior in the relevant provider module
  - promotion workflow logic in `src/promotion/*`
  - CLI output formatting in `src/cli/status-presenter.ts`

## Validation

Prefer the existing Node suite and build checks over ad-hoc validation.

Primary commands:

- `npm run typecheck`
  - strict TypeScript check
- `npm test`
  - Vitest suite covering Effect-native daemon/runtime behavior
- `npm run build`
  - production bundle via `tsdown`

Current test files:

- `tests/effect-runtime.test.ts`
  - workspace store/event journal persistence and daemon scheduling helpers
- `tests/project-config.test.ts`
  - project path ownership and config roundtrip
- `tests/host-git.test.ts`
  - managed-trunk bootstrap against a real temporary git repo

## Live smokes

Keep these as opt-in manual checks, not normal suite tests:

- `revis init`, `revis spawn N --exec '<command>'`, `revis status --watch`, and `revis events` against a real agent environment
- automatic restart behavior in live workspaces
- shared-remote multi-operator sync against a real git remote
- `revis promote <agent-id>` against a real GitHub remote and `gh`
- dashboard SSE updates in a real browser

Use those smokes when changing detached-session wiring, daemon IPC, remote sync behavior, or GitHub promotion behavior.
