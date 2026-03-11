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
2. After every experiment, run `revis log` with a neutral, fact-only record of what you changed or ran and what you observed.
3. Before deep source or paper reading, log a claim:
   `revis log --kind claim --source "<paper-or-topic>" "I am reading this source now."`
4. After reading a source, log the result:
   `revis log --kind literature --source "<paper-or-topic>" "factual source summary"`
5. When you prove an improvement, commit it and run `revis promote`.
6. Re-read `.revis/latest-findings.md` periodically. Other agents may invalidate your next step.
7. If `.revis/sync-conflict` exists, resolve the conflict, delete the file, and continue.

## Finding Rules

- Findings are records, not diagnoses.
- Log only what you did, what you observed, and the exact metrics, artifacts, traces, errors, or outputs you observed.
- Do not write what the result means, whether it is good or bad, or what anyone should try next.
- Do not smuggle interpretation through tone. Connotation-loaded wording counts as interpretation.
- Diagnosis happens after sync when agents read the shared findings ledger. The same agent may analyze its own earlier finding later, but not in the original finding entry.

### Experiment Findings

- Include the concrete change or command you ran.
- Include the concrete observed result.
- Prefer exact values over adjectives.
- Do not use phrases such as `this means`, `this suggests`, `this confirms`, `regression`, `improvement`, `better`, `worse`, or `next we should`.

Allowed:

- `revis log "Set weight decay to 0.3. T4 pass rate changed from 35% to 41% over 200 eval samples."`
- `revis log "Disabled response caching. Median latency increased from 82 ms to 100 ms across 500 requests."`
- `revis log "Ran pytest on tests/search. 3 tests failed with KeyError in search/index.py:84."`

NOT ALLOWED:

- `revis log "Set weight decay to 0.3. T4 pass rate improved from 35% to 41%, so this looks promising."`
- `revis log "Disabled response caching. Median latency jumped to 100 ms."`
- `revis log "Ran pytest on tests/search. 3 tests failed, which confirms the indexing refactor is broken."`

### Literature Findings

- Literature findings may include a factual source summary.
- Literature findings may include one neutral sentence of relevance framing such as `Read while investigating retrieval-heavy architectures.`
- Literature findings must not include implications, recommendations, or adoption advice.

Allowed:

- `revis log --kind literature --source "Paper Z" "Paper Z proposes architecture A and reports 74.2 F1 on dataset C. Read while investigating retrieval-heavy architectures."`
- `revis log --kind literature --source "Paper Q" "Paper Q compares optimizer settings across three model sizes and reports final validation loss for each setting."`

NOT ALLOWED:

- `revis log --kind literature --source "Paper Z" "Paper Z proposes architecture A and reports 74.2 F1 on dataset C, which suggests we should switch to this design."`
- `revis log --kind literature --source "Paper Q" "Paper Q shows optimizer setting B is the best option for our training runs."`

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
description: Use the Revis coordination protocol inside a swarm sandbox. Read the shared protocol, consult latest findings, log neutral fact-only findings, and promote proven improvements.
---

# Revis

Read `.revis/protocol.md` first, then follow it exactly.

When working in a Revis sandbox:

1. Read `.revis/latest-findings.md` and `.revis/source-index.md` before planning.
2. Log every experiment with `revis log` as a neutral fact record, not an interpretation.
3. Use `revis log --kind claim --source ...` before deep source reading.
4. Keep experiment findings to what you ran and what you observed. Keep literature findings to source facts plus at most one neutral relevance sentence.
5. Do not use evaluative wording such as `improved`, `worsened`, `jumped`, `promising`, or `this suggests`.
6. Analyze implications only after findings sync through the ledger, never inside the finding that records your own experiment or reading result.
7. Use `revis promote` only for proven wins on your current branch.
8. If `.revis/sync-conflict` exists, resolve it before continuing.
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

This sandbox runs Codex. Work autonomously, log neutral fact-only findings, keep implications out of your own result entries, and promote only proven improvements.
"""
