# Instructions for coding agents working on this codebase

Revis is a passive coordination CLI for tmux-backed coding agent workspaces. Agents inside those workspaces are not supposed to know Revis exists.

## Scope

Revis owns three things:

- creating isolated local workspace clones on namespaced git branches
- running a host daemon that pushes/fetches branch updates and relays commit summaries into local tmux sessions
- promoting one chosen workspace branch into trunk or into a pull request

Do not reintroduce findings ledgers, agent protocols, AGENTS injection, Daytona, or any other agent-facing coordination layer unless explicitly requested.

## Architecture

The code lives under `src/`:

- `src/core/`
  - shared models, config loading, filesystem helpers, IPC helpers, process helpers, and string/time utilities
  - keep these focused on reusable primitives; avoid pushing orchestration logic down here
- `src/coordination/`
  - git-backed domain logic: repository setup, workspace creation, daemon sync/relay, runtime persistence, status snapshots, and promotion
  - this is where the real product behavior belongs
- `src/cli/`
  - Commander command wiring, shared status formatting, and the Ink monitor
  - keep entrypoints thin and delegate to `coordination/`
- `src/bin/`
  - CLI entrypoint with the executable shebang

Current important modules:

- `src/coordination/workspaces.ts`
  - creates clones, tmux sessions, hooks, and workspace runtime records
- `src/coordination/daemon.ts`
  - owns the daemon IPC server, push/fetch loop, relay logic, and automatic rebases
- `src/coordination/promotion.ts`
  - operator-facing promotion orchestration
- `src/coordination/promotion-local.ts`
  - managed-trunk local merges
- `src/coordination/promotion-github.ts`
  - GitHub CLI PR flows
- `src/coordination/runtime.ts`
  - JSON runtime state and activity/event persistence
- `src/cli/monitor.tsx`
  - Ink UI components only
- `src/cli/monitor-session.ts`
  - attach-aware monitor loop outside the view layer

## Product invariants

- Workspace coordination refs are always `revis/<operator>/agent-<n>/work`.
- A workspace's checked-out local branch may differ from its coordination ref.
- The operator slug comes from local git identity.
- `revis init` prefers `origin`, otherwise the sole remote, otherwise creates `.revis/coordination.git` as `revis-local`.
- Local workspaces live under `.revis/workspaces/agent-<n>/repo`.
- Workspace `post-commit` hooks notify the daemon over local IPC.
- `revis spawn` is the only public command that creates workspaces; `--exec` is optional and agent-agnostic.
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
  - generic git helpers in `repo.ts`
  - promotion-backend-specific logic in the relevant promotion module
  - monitor rendering in `monitor.tsx`, attach/session control elsewhere

## Validation

Prefer the existing Node suite and build checks over ad-hoc validation.

Primary commands:

- `npm run typecheck`
  - strict TypeScript check
- `npm test`
  - Vitest suite covering workspace creation, daemon relay behavior, promotion flows, and UI/CLI behavior
- `npm run build`
  - production bundle via `tsdown`

Current test files:

- `tests/coordination.test.ts`
  - workspace creation, local-branch switching, daemon relay, cross-operator sync
- `tests/promotion.test.ts`
  - managed-trunk promotion, rebase propagation, GitHub PR reuse flow
- `tests/ui.test.tsx`
  - `status`, `monitor`, `spawn`, and `stop`

## Live smokes

Keep these as opt-in manual checks, not normal suite tests:

- `revis init`, `revis spawn N`, and `revis spawn N --exec '<command>'` against a real tmux/agent environment
- commit-hook relay into live agent sessions
- shared-remote multi-operator sync against a real git remote
- `revis promote <agent-id>` against a real GitHub remote and `gh`
- monitor attach behavior in a real terminal

Use those smokes when changing tmux wiring, daemon IPC, remote sync behavior, or GitHub promotion behavior.
