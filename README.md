# Revis

Revis is the coordination layer that enables multiple coding agents to collaborate on the same research problem[^1]. Run N coding agents on your repo simultaneously with `revis spawn --codex N`. Agents independently explore different ideas, share findings in real-time, and stack improvements automatically through a git-native protocol. Agents can run locally or on cloud sandboxes via Daytona.

## Install
```bash
uv tool install revis
```

## Usage

### You (the human)
```bash
# Initialize Revis in your repo
revis init

# Spawn 5 Codex agents
revis spawn --codex 5

# Check progress
revis status

# Live dashboard — hit Enter on any agent to attach to its session
revis monitor

# Read the latest findings yourself
revis findings --last 10

# Done — stop all agents, keep the results
revis stop
```

### The agents (called automatically inside each sandbox)
```bash
# Log what they tried and learned
revis log "increased weight decay to 0.3, T4 pass rate improved from 35% to 41%"

# Read what other agents have found (also auto-refreshed to .revis/latest-findings.md)
revis findings

# Merge an improvement into the shared trunk
revis promote

# Rebase onto latest trunk to pick up others' improvements (also runs automatically via daemon)
revis sync
```

You describe the objective during `revis init`. The agents handle everything
else: deciding what to explore, running experiments, logging results, and
promoting wins. You watch from `revis monitor` and merge `revis/trunk` back
into your branch when you're satisfied.

## How It Works

Each agent gets its own sandbox with a full git clone of your repo and
a dedicated working branch `revis/<agent-id>/work`. They coordinate through two shared git branches:

**`revis/findings`** - An append-only orphan branch (no shared commit history with main) where every agent commits a short
markdown file after each experiment, describing what it tried, what happened, and what it
learned (i.e. an experiment ledger). A background daemon fetches this branch periodically and writes the
latest entries to a local file in each sandbox, so every agent always has access
to what everyone else has discovered. Failures get logged too: "tried X, it
made things worse because Y" saves other agents from repeating dead ends.

**`revis/trunk`** - Fork of current branch, only moves forward. When an agent
proves an improvement, it merges its working branch into trunk and pushes. A
background daemon in every other sandbox automatically rebases onto the latest
trunk, so each agent's next experiment builds on top of every proven win.
Improvements compound across agents without any manual merging.

The daemon runs inside each sandbox on a configurable interval, handling the
git fetch/rebase cycle deterministically. Agents don't need to remember to
sync, they just read files and run experiments.

## Project Structure
```text
src/revis/
├── __init__.py
├── __main__.py
├── agent/
│   ├── credentials.py      # Auth detection for Codex CLI sessions
│   ├── instructions.py     # Skill and protocol file generation per sandbox
│   └── templates.py        # AGENTS.md, protocol.md, objective.md templates
├── coordination/
│   ├── daemon.py           # Background sync loop (findings fetch, trunk rebase, heartbeat)
│   ├── findings.py         # Ledger append, read, render to latest-findings.md
│   ├── git.py              # Branch creation, merge, rebase, push-with-retry
│   ├── runtime.py          # Agent registry, event log, daemon health tracking
│   └── sandbox_meta.py     # Per-sandbox state (agent ID, branch, attach command)
├── core/
│   ├── config.py           # Read/write .revis/config.toml
│   ├── models.py           # Shared data models (AgentInfo, Finding, etc.)
│   └── util.py             # Subprocess helpers, timestamp formatting
├── sandbox/
│   ├── base.py             # Abstract SandboxProvider interface
│   ├── daytona.py          # Daytona workspace lifecycle adapter
│   └── local.py            # Local git clone + tmux session adapter
└── cli/
    ├── main.py             # Typer commands (init, spawn, log, findings, sync, promote, status, stop)
    └── monitor.py          # Textual TUI (live dashboard, agent attach)
```

[^1]: "Research problem" here just means any loop where you change something, measure the result, and decide what to try next. Training an ML model and checking if validation loss improved, tuning a codebase and benchmarking if it got faster, adjusting reward functions and evaluating if your agent performs better, the list goes on. Revis makes this loop parallel and collaborative; instead of one agent iterating serially, N agents explore different directions at once, and when one finds something, the rest learn from it immediately.
