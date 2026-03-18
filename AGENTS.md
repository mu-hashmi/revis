# Instructions for coding agents working on this codebase

Revis is a coordination CLI for sandboxed coding agent workspaces. See README.md for more details.

## Rules

- NEVER change wording in README.md unless explicitly requested. You may only update the installation/usage/requirements if those change. If the product/functionality/behavior ever changes such that the README (or any docs) are now obsolete, surface this immediately. 

## Effect Best Practices

**IMPORTANT:** Use the official Effect docs index at [https://effect.website/llms.txt](https://effect.website/llms.txt) and the local Effect source mirror before writing or reviewing Effect code.

1. Read `https://effect.website/llms.txt` to find the relevant official docs pages for the API or pattern you need
2. Use the linked `effect.website` docs as the primary documentation source
3. Search `.reference/effect/` for real implementations and exact API behavior; the Effect repo is already cloned locally for reference (if it isn't, clone it there: https://github.com/Effect-TS/effect)
4. When the docs are ambiguous, verify the current installed API against `node_modules/effect/` before changing code

Never guess at Effect patterns - check the official docs and local source first.

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
