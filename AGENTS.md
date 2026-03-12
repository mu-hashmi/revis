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
