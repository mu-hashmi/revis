# Instructions for coding agents working on this codebase

Revis is a coordination CLI for sandboxed coding agent workspaces. See README.md for more details.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `npx effect-solutions list` to see available guides
2. Run `npx effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `.reference/effect/` for real implementations; the Effect repo is already cloned locally for reference (if it isn't, clone it there: https://github.com/kitlangton/effect-solutions)

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

For Effect best practices, always use the skill and references in .agents/skills/effect-best-practices
<!-- effect-solutions:end -->

## Conventions

- Use JSDoc-style module/function comments on public functions and on non-trivial internal helpers.
- Add blank lines between logical phases inside functions.
- ALWAYS do loud failures over silent fallbacks. If state is corrupted, surface it.

## Validation

Prefer the existing Node suite and build checks over ad-hoc validation.

Primary commands:

- `npm run typecheck`
  - strict TypeScript check
- `npm test`
  - fast Vitest projects for contracts, transport, and orchestration
- `npm run test:acceptance`
  - built-CLI acceptance suite against a real local git repo
- `npm run build`
  - production bundle via `tsdown`

## Live smokes

Keep these as opt-in manual checks, not normal suite tests:

- `revis init`, `revis spawn N --exec '<command>'`, `revis status --watch`, and `revis events` against a real agent environment
- automatic restart behavior in live workspaces
- shared-remote multi-operator sync against a real git remote
- `revis promote <agent-id>` against a real GitHub remote and `gh`
- dashboard SSE updates in a real browser

Use those smokes when changing detached-session wiring, daemon IPC, remote sync behavior, or GitHub promotion behavior.
