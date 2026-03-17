# revis — passive workspace coordination for coding agents

**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)** · **[License](#license)**

*Run parallel agent workspaces with a structured daemon, live event stream, and operator-controlled promotion.*

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). This is the [next step](https://x.com/karpathy/status/2030705271627284816).

---

![Revis terminal demo](https://raw.githubusercontent.com/mu-hashmi/revis/main/assets/revis-terminal.gif)

---

Revis is **not** an orchestrator, framework, or harness. It stays out of the agent loop and focuses on the coordination layer around it: isolated workspaces, restartable sessions, branch exchange, rebases, promotion, and operator visibility.

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
2. It runs an Effect-native daemon that reconciles workspaces in parallel, pushes owned refs, fetches everyone else's `revis/*` refs, and rebases before the next iteration starts.
3. It promotes one chosen workspace into managed trunk or into a pull request.

The coordination loop looks like this:

```text
┌────────────────────────┐   exit detected   ┌──────────────────────┐   push / fetch    ┌─────────────────────────┐
│ workspace repo         │ ───────────────►  │ revis daemon         │ ◄──────────────►  │ revis/*/agent-*/work    │
│ detached agent session │ ◄──── restart ─── │ Effect runtime       │ ── rebase sync ─► │ remote coordination refs│
└────────────────────────┘                   └──────────────────────┘                   └─────────────────────────┘
```

The daemon baselines current local and remote heads on startup, so old history is not replayed. Each workspace then runs in iterations:

- starts the workspace command from `revis spawn --exec '<command>'`
- waits for that bounded session to exit
- pushes the workspace `HEAD` to `revis/<operator>/agent-<n>/work`
- fetches remote `revis/*/agent-*/work` refs
- rebases the workspace onto the current sync target before the next iteration starts
- blocks restart when the workspace is dirty or the rebase conflicts

Workspace reconciliation runs in parallel fibers, so shutdown interrupts in-flight work cleanly instead of waiting for a hand-rolled queue to drain.

For local `revis-local` coordination, that sync target is `revis/trunk`. For a real shared remote, it is the configured base branch.

### Branch model

Each workspace has two branch concepts:

- the stable coordination ref owned by Revis: `revis/<operator>/agent-<n>/work`
- the workspace repo's current local branch, which the agent may change freely

Revis always publishes the workspace's current `HEAD` to the stable coordination ref. That keeps coordination stable without forcing repo-specific branch naming.

The operator slug comes from local git identity:

- first `git config user.email` local-part
- then `git config user.name`
- slugified to lowercase alphanumeric and hyphen

That lets multiple operators share one remote without colliding.

### Promotion

`revis promote <agent-id>` is operator-only.

Before promotion, Revis pushes the workspace's current `HEAD` to its stable coordination ref.

- In managed-trunk mode (`revis-local`), Revis merges that coordination ref into `revis/trunk`, then the daemon rebases other local workspaces before their next restart.
- Against a real shared remote, Revis pushes the coordination ref and opens or reuses a GitHub pull request targeting the configured base branch.

### Runtime files

Revis keeps its local runtime state under `.revis/`:

```text
.revis/
  config.json
  coordination.git/        # only in revis-local mode
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
  workspaces/
    agent-1/
      repo/
      session.log
      session.exit
```

The daemon appends every runtime event to the live journal and, when a live session exists, mirrors the same events into that session archive. `revis init` adds the state, journal, archive, and workspace paths to `.gitignore`.

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
- `gh` on your `PATH` if you want PR-based promotion against a GitHub remote
- Daytona credentials if you switch `.revis/config.json` to `"sandboxProvider": "daytona"`

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

`--exec` is required. Revis persists that command in workspace metadata and uses it to restart the next bounded iteration after every sync cycle.

Revis does not care whether that command is Codex, Claude, or anything else that makes sense in a headless workspace loop.

### 3. Inspect the runtime

- `revis dashboard` launches the local timeline dashboard in your browser.
- `revis status` prints a compact table with workspace state.
- `revis status --watch` redraws status whenever new runtime events arrive.
- `revis events` tails the live event stream with backlog replay.
- Inspect live output with `tail -f .revis/workspaces/agent-1/session.log`.

### 4. Stop and promote

- `revis stop agent-2` stops one workspace.
- `revis stop --all` stops every workspace and the daemon.
- `revis promote agent-2` promotes one workspace into trunk or a GitHub pull request, depending on the configured remote.

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
