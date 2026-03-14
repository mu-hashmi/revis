# Revis

Revis is a passive coordination layer for parallel coding agent workspaces.

It does three things:

1. creates isolated local clones on namespaced branches like `revis/alice/agent-3/work`
2. runs a daemon that pushes local workspace branches, fetches everyone else's `revis/*` branches, and relays commit summaries into your local tmux sessions
3. lets the operator promote a chosen workspace branch

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
- `codex` on your `PATH` if you want `revis spawn --codex`
- `gh` on your `PATH` if you want PR-based promotion against a GitHub remote

## Commands

```bash
revis init
revis workspace 4
revis spawn --codex 4
revis status
revis monitor
revis promote agent-2
revis stop
revis version
```

## Quick Start

```bash
revis init
revis workspace 4
revis spawn --codex 4
revis status
revis monitor
```

If you only want the workspace shells and daemon, use `revis workspace N`. If you want Revis to also launch Codex in each tmux session, use `revis spawn --codex N`.

## How It Works

`revis init` chooses a coordination remote:

- prefer `origin`
- otherwise use the only configured remote
- otherwise create a local bare remote at `.revis/coordination.git` and use managed trunk mode with `revis/trunk`

It also writes `.revis/config.json` with:

- `coordinationRemote`
- `trunkBase`
- `codexTemplate`
- `remotePollSeconds`

`revis workspace N` creates `N` local clones under `.revis/workspaces/agent-N/repo`, creates a tmux session per workspace, installs a `post-commit` hook, writes workspace runtime metadata, and ensures the daemon is running.

`revis spawn --codex N` does the same setup and then launches the configured Codex command in each tmux session.

The daemon listens on a Unix domain socket on Unix-like systems and on a named pipe on Windows. Every workspace `post-commit` hook notifies the daemon immediately with the workspace id, branch, and new commit SHA. The daemon then:

- pushes your owned `revis/<operator>/agent-*/work` branches
- fetches remote `revis/*/agent-*/work` branches
- relays unseen commit summaries into your local tmux sessions
- rebases owned workspaces onto the current sync target when trunk advances

For local `revis-local` coordination, the sync target is `revis/trunk`. For a real shared remote, the sync target is the configured base branch.

## Branch Model

Workspace branches are always:

```text
revis/<operator>/agent-<n>/work
```

The operator slug comes from local git identity:

- first `git config user.email` local-part
- then `git config user.name`
- slugified to lowercase alphanumeric and hyphen

This means multiple operators can share the same remote without colliding. Revis treats the single-operator and multi-operator cases as the same code path.

## Promotion

`revis promote <agent-id>` is operator-only.

- In managed-trunk mode (`revis-local`), Revis merges that workspace branch into `revis/trunk`, then the daemon rebases the other local workspaces onto the new trunk head.
- Against a real shared remote, Revis pushes the branch and opens or reuses a GitHub pull request targeting the configured base branch.

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

`revis status` prints:

- daemon health and socket path
- operator slug, remote, and sync base
- one line per workspace with branch, state, recent SHAs, queued steering count, attach command, and latest activity

`revis monitor` opens an Ink TUI with:

- daemon and repo summary
- workspace list
- activity for the selected workspace
- recent runtime events

Use `Enter` or `a` to attach to a workspace tmux session, `j`/`k` to move, and `q` to quit.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
