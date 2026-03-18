# How Revis Works

## Coordination loop

Revis does 3 things:

1. It provisions isolated workspaces with stable coordination refs like `revis/alice/agent-3/work`.
2. It runs a background daemon that reconciles workspaces in parallel, pushes owned refs, fetches everyone else's `revis/*` refs, and rebases before the next iteration starts.
3. It promotes one chosen workspace into managed trunk or into a pull request.

The coordination loop looks like this:

```text
┌────────────────────────┐   exit detected   ┌──────────────────────┐   push / fetch    ┌─────────────────────────┐
│ workspace repo         │ ───────────────►  │ revis daemon         │ ◄──────────────►  │ revis/*/agent-*/work    │
│ detached agent session │ ◄──── restart ─── │ Effect runtime       │ ── rebase sync ─► │ remote coordination refs│
└────────────────────────┘                   └──────────────────────┘                   └─────────────────────────┘
```

Each workspace snapshot tracks the last observed local head and last rebased sync target, so reconciles only act on new local or remote state. Each workspace then runs in iterations:

- starts the workspace command from `revis spawn --exec '<command>'`
- waits for that bounded session to exit
- pushes the workspace `HEAD` to `revis/<operator>/agent-<n>/work`
- fetches remote `revis/*/agent-*/work` refs
- rebases the workspace onto the current sync target before the next iteration starts
- blocks restart when the workspace is dirty or the rebase conflicts

Workspace reconciliation runs in parallel fibers, so the daemon can supervise every workspace concurrently without a hand-rolled queue.

For local `revis-local` coordination, that sync target is `revis/trunk`. For a real shared remote, it is the configured base branch.

## Branch model

Each workspace has two branch concepts:

- the stable coordination ref owned by Revis: `revis/<operator>/agent-<n>/work`
- the workspace repo's current local branch, which the agent may change freely

Revis always publishes the workspace's current `HEAD` to the stable coordination ref. That keeps coordination stable without forcing repo-specific branch naming.

The operator slug comes from local git identity:

- first `git config user.email` local-part
- then `git config user.name`
- slugified to lowercase alphanumeric and hyphen

That lets multiple operators share one remote without colliding.

## Promotion

`revis promote <agent-id>` is operator-only.

Before promotion, Revis pushes the workspace's current `HEAD` to its stable coordination ref.

- In managed-trunk mode (`revis-local`), Revis merges that coordination ref into `revis/trunk`, then the daemon rebases other tracked workspaces before their next restart.
- Against a real shared remote, Revis pushes the coordination ref and opens or reuses a GitHub pull request targeting the configured base branch.

## Runtime files

Revis keeps its local runtime state under `.revis/`:

```text
.revis/
  config.json
  state/
    daemon.json
    workspaces/
      agent-1.json
  journal/
    live.jsonl
  archive/
    sessions/
      sess-1234abcd/
        meta.json
        events.jsonl
  coordination.git/        # only in revis-local mode
  workspaces/              # local provider only
    agent-1/
      repo/
      session.log
      session.exit
```

`config.json`, `state/`, `journal/`, and `archive/` are always local. `coordination.git/` exists only in `revis-local` mode, and `workspaces/` is populated by the local provider. The daemon appends every runtime event to the live journal and, when a live session exists, mirrors the same events into that session archive. `revis init` adds the state, journal, archive, workspace, and coordination remote paths to `.gitignore`.
