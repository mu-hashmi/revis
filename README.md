# revis — distributed + multiplexed autoresearch

**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)** · **[License](#license)**

*Run parallel experiment loops across agents and machines. Commits relay to other agents in real time.*

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). This is the [next step](https://x.com/karpathy/status/2030705271627284816).

---

![Revis terminal demo](https://raw.githubusercontent.com/mu-hashmi/revis/main/assets/revis-terminal.gif)

---

Revis is **not** an orchestrator, framework, or harness. Revis has no opinions about how your agents work. It just makes sure they can see each other's work and build on it.

## Demo

The fastest way to see Revis in action is the Mandelbrot speedrun source under [`examples/mandelbrot`](./examples/mandelbrot/README.md).

Export it into its own lightweight repo before you run Revis so workspace clones contain only the demo, not the full Revis source tree.

```bash
/bin/sh ./examples/mandelbrot/export-demo.sh ~/mandelbrot-demo
cd ~/mandelbrot-demo
revis init
revis spawn 4 --exec 'codex --yolo "Read program.md and begin the loop."'
```

Claude example:

```bash
/bin/sh ./examples/mandelbrot/export-demo.sh ~/mandelbrot-demo
cd ~/mandelbrot-demo
revis init
revis spawn 4 --exec 'claude --dangerously-skip-permissions "Read program.md and begin the loop."'
```

## How it works

Revis does 3 things:

1. It creates isolated local clones with stable coordination refs like `revis/alice/agent-3/work`.
2. It runs a daemon that pushes those refs, fetches everyone else's `revis/*` refs, and relays commit summaries into local tmux sessions.
3. It promotes one chosen workspace into managed trunk or into a pull request.

The coordination loop looks like this:

```text
┌───────────────────────┐   post-commit    ┌──────────────────────┐   push / fetch    ┌─────────────────────────┐
│ workspace clone       │ ───────────────► │ revis daemon         │ ◄──────────────►  │ revis/*/agent-*/work    │
│ tmux session + agent  │ ◄──── relay ──── │ local runtime state  │ ── rebase sync ─► │ remote coordination refs│
└───────────────────────┘                  └──────────────────────┘                   └─────────────────────────┘
```

Every workspace installs a `post-commit` hook that notifies the daemon immediately. The daemon baselines current local and remote heads on startup, so old history is not replayed, then it:

- pushes each owned workspace `HEAD` to `revis/<operator>/agent-<n>/work`
- fetches remote `revis/*/agent-*/work` refs
- relays newly seen commit summaries into local tmux sessions
- rebases owned workspaces onto the current sync target when trunk advances

For local `revis-local` coordination, that sync target is `revis/trunk`. For a real shared remote, it is the configured base branch.

### Branch model

Each workspace has two branch concepts:

- the stable coordination ref owned by Revis: `revis/<operator>/agent-<n>/work`
- the workspace repo's current local branch, which the agent may change freely

Revis always publishes the workspace's current `HEAD` to the stable coordination ref. That keeps relay behavior consistent without forcing repo-specific branch naming.

The operator slug comes from local git identity:

- first `git config user.email` local-part
- then `git config user.name`
- slugified to lowercase alphanumeric and hyphen

That lets multiple operators share one remote without colliding.

### Promotion

`revis promote <agent-id>` is operator-only.

Before promotion, Revis pushes the workspace's current `HEAD` to its stable coordination ref.

- In managed-trunk mode (`revis-local`), Revis merges that coordination ref into `revis/trunk`, then the daemon rebases other local workspaces onto the new trunk head.
- Against a real shared remote, Revis pushes the coordination ref and opens or reuses a GitHub pull request targeting the configured base branch.

### Runtime files

Revis keeps its local runtime state under `.revis/`:

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

---

## Install

```bash
npm install -g revis-cli
```

Or run it directly:

```bash
npx revis-cli --help
```

After install, the command is still:

```bash
revis --help
```

<details>
<summary>From a local clone</summary>

```bash
npm install
npm run build
npm link
```

</details>

### Requirements

- Node 20+
- `git`
- `tmux`
- `gh` on your `PATH` if you want PR-based promotion against a GitHub remote

---

## Usage

### 1. Initialize coordination

```bash
revis init
```

`revis init` prefers `origin`, otherwise uses the only configured remote, otherwise creates `.revis/coordination.git` as a local bare coordination remote.

### 2. Spawn workspaces

```bash
revis spawn 4 --exec 'codex --yolo'
```

Use `revis spawn N` if you only want the workspaces and daemon. Use `--exec '<command>'` when you also want Revis to start something inside each workspace tmux pane.

Revis does not care whether that command is Codex, Claude, or anything else that makes sense in a tmux session.

### 3. Inspect and attach

- `revis status` prints a compact table with workspace state and attach commands.
- Attach directly with the printed `tmux attach -t ...` command for the workspace you want to inspect.

---

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

---

## License

[MIT](LICENSE)
