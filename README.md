# Revis

Revis is a passive coordination layer for parallel coding-agent workspaces.

It does three things:

1. creates isolated local clones with stable coordination refs like `revis/alice/agent-3/work`
2. runs a daemon that pushes those coordination refs, fetches everyone else's `revis/*` refs, and relays commit summaries into your local tmux sessions
3. lets the operator promote a chosen workspace into trunk or into a pull request

## Install

```bash
npx revis --help
```

Or:

```bash
npm install -g revis
```

## Requirements

- Node 20+
- `git`
- `tmux`
- `gh` on your `PATH` if you want PR-based promotion against a GitHub remote

## Commands

```bash
revis init
revis spawn 4
revis spawn 4 --exec 'codex --yolo'
revis status
revis monitor
revis promote agent-2
revis stop agent-2
revis stop --all
revis version
```

## Quick Start

```bash
revis init
revis spawn 4 --exec 'codex --yolo'
revis status
revis monitor
```

If you only want the workspaces and daemon, use `revis spawn N`.

If you want Revis to also start something inside each workspace, use `revis spawn N --exec '<command>'`. Revis does not care whether that command is Codex, Claude, or anything else that makes sense in a tmux pane.

## How It Works

`revis init` chooses a coordination remote:

- prefer `origin`
- otherwise use the only configured remote
- otherwise create a local bare remote at `.revis/coordination.git` and use managed trunk mode with `revis/trunk`

It also writes `.revis/config.json` with:

- `coordinationRemote`
- `trunkBase`
- `remotePollSeconds`

`revis spawn N` creates `N` local clones under `.revis/workspaces/agent-N/repo`, creates a tmux session per workspace, installs a `post-commit` hook, writes workspace runtime metadata, and ensures the daemon is running.

`revis spawn N --exec '<command>'` does the same setup and starts that command inside each workspace tmux pane.

`revis stop <agent-id>` stops one workspace. `revis stop --all` tears down every workspace plus the daemon.

The daemon listens on a Unix domain socket on Unix-like systems and on a named pipe on Windows. Every workspace `post-commit` hook notifies the daemon immediately with the workspace id and new commit SHA. The daemon then:

- baselines current workspace heads and visible remote refs when it starts, so old history is not replayed
- pushes each workspace's new `HEAD` commits to its owned `revis/<operator>/agent-*/work` coordination ref
- fetches remote `revis/*/agent-*/work` refs
- relays newly seen commit summaries into your local tmux sessions
- rebases owned workspaces onto the current sync target when trunk advances

For local `revis-local` coordination, the sync target is `revis/trunk`. For a real shared remote, the sync target is the configured base branch.

## Branch Model

Each workspace has two branch concepts:

- a stable coordination ref owned by Revis:

```text
revis/<operator>/agent-<n>/work
```

- the workspace repo's current local branch, which the agent may change freely

Revis always publishes the workspace's current `HEAD` to that stable coordination ref. That means repo-specific workflows can use their own local branch names without breaking Revis relay behavior.

The operator slug comes from local git identity:

- first `git config user.email` local-part
- then `git config user.name`
- slugified to lowercase alphanumeric and hyphen

This lets multiple operators share the same remote without colliding.

## Promotion

`revis promote <agent-id>` is operator-only.

Before promotion, Revis pushes the workspace's current `HEAD` to its stable coordination ref.

- In managed-trunk mode (`revis-local`), Revis merges that coordination ref into `revis/trunk`, then the daemon rebases the other local workspaces onto the new trunk head.
- Against a real shared remote, Revis pushes the coordination ref and opens or reuses a GitHub pull request targeting the configured base branch.

## Runtime Files

Revis keeps local runtime state under `.revis/`:

```text
.revis/
  config.json
  coordination.git/        # only in revis-local mode
  runtime/
    daemon.json
    relays.json
    events.jsonl
    workspaces/
    activity/
  workspaces/
    agent-1/
      repo/
        .revis/
          agent.json
          last-relayed-sha
          hook-client.cjs
```

These files are local operator state. `revis init` adds the local runtime paths to `.gitignore`.

## Status And Monitor

`revis status` prints a compact table with:

- workspace name
- current `[idle]` or `[active]` state
- the `tmux attach ...` command

`revis monitor` opens an Ink TUI with:

- a workspace sidebar
- a detail pane for the selected workspace
- switchable activity and events views
- direct attach and refresh keybindings

Use `Enter` or `a` to attach to a workspace tmux session, `j`/`k` to move, `Tab` or `1`/`2` to switch panes, `r` to refresh, and `q` to quit.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
