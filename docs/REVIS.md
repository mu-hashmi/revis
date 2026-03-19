# How Revis Works

## Coordination loop

Revis now does 3 things:

1. It provisions one isolated branch and workspace per participant.
2. It starts one Sandbox Agent SDK session per participant and watches session events in the foreground.
3. It turns completed turns into short relay prompts for the other participants.

The coordination loop looks like this:

```text
┌──────────────────────┐   session events   ┌──────────────────────┐   prompt relays   ┌──────────────────────┐
│ participant sandbox  │ ─────────────────► │ revis coordinator    │ ─────────────────► │ other participant    │
│ git repo + agent run │ ◄───────────────── │ foreground process   │ ◄───────────────── │ sandboxes + sessions │
└──────────────────────┘    sdk prompts     └──────────────────────┘    idle session    └──────────────────────┘
```

Each participant starts with the shared task prompt. When a prompt completes, Revis:

- reads the new session events
- extracts the latest assistant output
- inspects the participant workspace for changed files
- pushes the participant branch if `HEAD` moved
- sends a short relay prompt to every other participant

Permissions are auto-approved through the SDK so unattended runs do not stall. Questions are treated as blocking state and surfaced in run status instead of being auto-answered.

There is no background daemon, no git-ref reconcile loop, and no branch rebasing between participants.

## Branch model

Each participant gets one stable branch:

- `revis/<operator>/<run-id>/agent-<n>`

The operator slug comes from local git identity:

- first `git config user.name`
- then `USER` / `USERNAME`
- slugified to lowercase alphanumeric and hyphen

Participants work directly on their own branch. Git is still used for normal repo work, branch isolation, and PR promotion, but it is no longer the transport for coordination.

## Promotion

`revis promote <agent-id>` is operator-only.

Promotion is remote-first:

- the participant workspace must be clean
- Revis pushes the participant branch to the configured remote
- Revis opens or reuses a GitHub pull request targeting the configured base branch

There is no managed trunk mode and no local `revis-local` coordination remote.

## Runtime files

Revis keeps local runtime state under `.revis/`:

```text
.revis/
  config.json
  active-run
  runs/
    <run-id>/
      run.json
      revis-events.jsonl
      agents/
        agent-1.json
      sessions/
        <session-id>.json
      events/
        <session-id>.jsonl
      worktrees/              # local sandbox only
        agent-1/
```

`config.json` stores repo defaults. `active-run` points at the current run. Each run keeps its own participant state, SDK session persistence, and high-level Revis event log. Local sandboxes also keep git worktrees under the run directory.
