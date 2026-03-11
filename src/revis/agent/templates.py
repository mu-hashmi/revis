"""Template renderers for sandbox protocol files and Codex bootstrap text."""

from __future__ import annotations


def protocol_body(*, objective_text: str, daemon_interval_minutes: int) -> str:
    """Render the shared sandbox protocol document.

    The objective is embedded here as well as written to `.revis/objective.md`
    so `.revis/protocol.md` stays self-contained when an agent opens only that
    one file.

    Args:
        objective_text: Effective research objective text.
        daemon_interval_minutes: Configured daemon sync interval.

    Returns:
        str: Markdown protocol document.
    """
    return f"""# Revis Protocol

You are one of several agents working on the same research objective in parallel.
Coordinate through the findings ledger and the shared trunk branch.

## Workflow

1. Read `.revis/latest-findings.md` and `.revis/source-index.md` before picking a direction.
2. After every experiment, run `revis log "what you tried and what happened"`.
3. Before deep source or paper reading, log a claim:
   `revis log --kind claim --source "<paper-or-topic>" "I am reading this source now."`
4. After reading a source, log the result:
   `revis log --kind literature --source "<paper-or-topic>" "summary and implications"`
5. When you prove an improvement, commit it and run `revis promote`.
6. Re-read `.revis/latest-findings.md` periodically. Other agents may invalidate your next step.
7. If `.revis/sync-conflict` exists, resolve the conflict, delete the file, and continue.

## Automatic Coordination

- `.revis/latest-findings.md` is refreshed about every {daemon_interval_minutes} minutes.
- Your branch is rebased onto `revis/trunk` on that cadence when the worktree is clean.
- Rebase conflicts are written to `.revis/sync-conflict`.

## Commands

- `revis findings --last 20`
- `revis sync`
- `revis log --kind result "message"`
- `revis log --kind claim --source "source-id" "claim message"`
- `revis log --kind literature --source "source-id" "summary"`
- `revis promote`

## Objective

{objective_text.strip()}
"""


def codex_skill_body() -> str:
    """Render the sandbox-local Codex skill body.

    Returns:
        str: Skill markdown installed into sandbox-local `CODEX_HOME`.
    """
    return """---
name: revis
description: Use the Revis coordination protocol inside a swarm sandbox. Read the shared protocol, consult latest findings, log every experiment, and promote proven improvements.
---

# Revis

Read `.revis/protocol.md` first, then follow it exactly.

When working in a Revis sandbox:

1. Read `.revis/latest-findings.md` and `.revis/source-index.md` before planning.
2. Log every experiment with `revis log`.
3. Use `revis log --kind claim --source ...` before deep source reading.
4. Use `revis promote` only for proven wins on your current branch.
5. If `.revis/sync-conflict` exists, resolve it before continuing.
"""


def bootstrap_block(*, skill_ref: str) -> str:
    """Render the thin bootstrap block inserted into `AGENTS.md`.

    Args:
        skill_ref: Skill name that the bootstrap should point at.

    Returns:
        str: Revis-managed bootstrap block.
    """
    return f"""<!-- revis:start -->
## Revis

This sandbox is part of a Revis swarm.

- Use the `{skill_ref}` skill first.
- Read `.revis/protocol.md` for the full workflow.
- Read `.revis/objective.md` for the research objective.
<!-- revis:end -->
"""


def startup_prompt(*, agent_id: str) -> str:
    """Render the first user prompt for a spawned Codex session.

    Args:
        agent_id: Stable Revis agent identifier.

    Returns:
        str: Initial prompt text.
    """
    return f"""You are `{agent_id}` in a Revis multi-agent swarm.

Use the `revis` skill immediately, then read `.revis/protocol.md` and `.revis/objective.md`.

This sandbox runs Codex. Work autonomously, log every experiment, and promote only proven improvements.
"""
