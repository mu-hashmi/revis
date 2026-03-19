# Instructions for coding agents working on this codebase

## Project Snapshot

Revis is a coordination CLI for sandboxed coding agent workspaces. See README.md for more details.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged. For all intents and purposes, the current state of the codebase is merely a snapshot of a product that is being heavily iterated on. **Nothing** should be treated as "finalized" unless explicitly stated.

## MANDATORY Rules

- NEVER change wording in README.md unless explicitly requested. You may only update the installation/usage/requirements if those change. If the product/functionality/behavior ever changes such that the README (or any docs) are now obsolete, surface this immediately. 

## Effect Best Practices

**IMPORTANT:** Use the official Effect docs index at [https://effect.website/llms.txt](https://effect.website/llms.txt) and the local Effect source mirror before writing or reviewing Effect code.

1. Read `https://effect.website/llms.txt` to find the relevant official docs pages for the API or pattern you need
2. Use the linked `effect.website` docs as the primary documentation source
3. Search `.reference/effect/` for real implementations and exact API behavior. `.reference/` is backed by git submodules, so if these paths are missing in a fresh clone, run `git submodule update --init --recursive .reference/effect .reference/discord-bot .reference/dfx`
4. When the Effect docs are ambiguous, verify the current installed API against `node_modules/effect/` before changing code.

Use the monorepo in `.reference/effect/` as the canonical reference. Every package within it (@effect/platform, @effect/sql, @effect/ai, @effect/cli, @effect/cluster) demonstrates idiomatic patterns because the core team wrote them. The @effect/platform package is especially instructive; it shows the full Service → Layer → Runtime pattern across Node/Bun/Browser with proper dependency injection, typed errors, and resource management.

Use `.reference/discord-bot/` as the best small real-world application reference. It shows service boundaries, Layer wiring, runtime setup, and production-style error handling in a deployed Effect app maintained by the core team.

Use `.reference/dfx/` as the library-design reference. It is the idiomatic example for building a framework on top of Effect with clean services, Config usage, registries, and `Effect.gen`-driven APIs.

NEVER guess at Effect patterns - check the official docs and local source first.

## Code Conventions (IMPORTANT)

- Use JSDoc-style module/function comments on public functions and on non-trivial internal helpers.
- Add blank lines between logical phases inside functions.
- ALWAYS do loud failures over silent fallbacks. If state is corrupted, surface it.
- Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

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
