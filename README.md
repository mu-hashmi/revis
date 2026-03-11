# Revis

Revis is the coordination layer that enables multiple coding agents to collaborate on the same research problem[^1]. Run N coding agents on your repo simultaneously with `revis spawn --codex N`. Agents independently explore different ideas, share findings in real-time, and submit candidate improvements through a git-native protocol. Agents can run locally or on cloud sandboxes via Daytona.

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
# Log neutral fact-only findings
revis log "Set weight decay to 0.3. T4 pass rate changed from 35% to 41% over 200 eval samples."

# Read what other agents have found (also auto-refreshed to .revis/latest-findings.md)
revis findings

# Submit a candidate improvement
revis promote

# Rebase onto the current sync target (also runs automatically via daemon)
revis sync
```

## How It Works

Each agent gets its own sandbox with a full git clone of your repo and
a dedicated working branch `revis/<agent-id>/work`. Agents share insights via the shared `revis/findings` branch, and
promote progress by opening/updating PRs. 

### Coordination Protocol

**`revis/findings`** - An append-only orphan branch (no shared commit history with main) where every agent commits a short
markdown file after each experiment or source-reading pass, describing only
what it tried or read and what happened concretely (i.e. an experiment
ledger). A background daemon fetches this branch periodically and writes the
latest entries to a local file in each sandbox, so every agent always has access
to everyone else's work. Failures get logged too:
`tried X. Error rate increased from 2% to 15%.`

The wording boundary matters. **An agent that already holds a hypothesis will
read its own results through that lens, so its interpretation is the least
independent one available and risks anchoring every other agent that syncs it.** 
`Error rate increased from 2% to 15%` is a factual finding. `Error rate jumped to 15%`
adds interpretation through connotation. Literature findings follow the same rule: 
they may summarize source claims and include one neutral sentence of relevance framing 
such as `Read while investigating retrieval-heavy architectures.`, 
but they should not add implications such as `this suggests we should adopt...`.

**Agent branch promotion** - When an agent believes it has a candidate improvement (i.e. a commit or series of commits
that moves a metric, fixes a failure, or otherwise advances the objective), it runs `revis promote`. This pushes the agent 
branch and opens or updates a GitHub PR against the configured base branch.

A daemon runs inside each sandbox on a configurable interval, handling the
git fetch/rebase cycle deterministically. Agents don't need to remember to
sync, they just read files and run experiments. The fallback `revis-local`
remote rebases onto `revis/trunk`; any real git remote rebases onto the
configured base branch.

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
│   ├── daemon.py           # Background sync loop (findings fetch, provider-specific rebase, heartbeat)
│   ├── findings.py         # Ledger append, read, render to latest-findings.md
│   ├── git.py              # Findings branch, sync targets, merges, and PR helpers
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
