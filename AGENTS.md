# Instructions for coding agents working on this codebase

NEVER add tests, unless explicitly requested. Instead, use the CLI yourself and/or create one-off in-line scripts to test your implementation.

## Architecture

Revis is a multi-agent research coordination CLI. The layers are:
- `core/` — Data models, config, utilities. No I/O beyond file read/write.
- `coordination/` — Git-backed coordination (findings, sync, runtime state). Domain logic lives here.
- `sandbox/` — Provider abstraction for spawning sandboxes (local tmux, Daytona).
- `agent/` — Agent bootstrap: credentials, instructions, templates.
- `cli/` — Typer commands. Thin layer that calls into coordination/sandbox.

## Conventions

- Docstrings are required on all public functions and any internal function whose purpose isn't immediately obvious from its name and signature.

## Validation

When tests exist, prefer the suite before ad-hoc scripts. Tests should check intent, not implementation details.

### Commands

- `uv run pytest`
  - Runs the full automated suite under `tests/`.
  - Covers repo-backed findings ledger behavior, sync/rebase flows, daemon cycle behavior, promotion helpers, PR creation/reuse flow via a fake `gh`, spawn/runtime persistence, CLI command behavior, and the Textual monitor UI.

- `uv run pytest tests/test_ledger.py`
  - Focuses on findings write/read roundtrips and concurrent ledger writes against a real bare git remote.

- `uv run pytest tests/test_sync_and_daemon.py`
  - Covers `try_sync_branch(...)` dirty/conflict behavior and daemon-cycle materialization of findings/runtime state.

- `uv run pytest tests/test_promotion.py`
  - Covers managed-trunk promotion and GitHub-style PR promotion behavior without touching the real GitHub API.

- `uv run pytest tests/test_cli.py`
  - Covers operator-facing CLI flows that can be validated locally: `findings`, `status`, and `stop`.

- `uv run pytest tests/test_monitor.py`
  - Covers the monitor’s headless Textual rendering and attach action dispatch.

- `uv run pytest tests/test_spawning_runtime.py`
  - Covers spawn planning, runtime registry creation, event logging, and failure persistence.

### Gated Live Smokes

These should stay as opt-in live smokes instead of normal suite tests because they depend on real external systems, real credentials, or real long-lived process behavior:

- Local tmux-backed sandbox spawn with a real Codex session.
- Daytona workspace lifecycle against the real Daytona API.
- Dirty-worktree wheel install into Daytona sandboxes.
- Real GitHub PR creation/reuse against an actual GitHub repo.
- End-to-end attach/debug flows that require a real terminal session.

Use those live smokes when changing provider wiring, auth handling, sandbox bootstrap, or GitHub/Daytona integration behavior. The suite should catch local regressions first; the live smokes confirm the external seams still behave in reality.
