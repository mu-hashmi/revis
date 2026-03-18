# revis — distributed + multiplexed autoresearch loops

**[Install](#install)** · **[Usage](#usage)** · **[Examples](#examples)** · **[How it works](./docs/REVIS.md)** · **[License](#license)**

*Launch parallel autoresearch agents to run experiments at a massive scale, using Git to share findings between agents. Agents naturally build on each other's work and avoid redundant experiments or dead-ends through this coordination layer.*

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). This is the [next step](https://x.com/karpathy/status/2030705271627284816).

---

![Revis terminal demo](https://raw.githubusercontent.com/mu-hashmi/revis/main/assets/revis-terminal.gif)

---

Revis is **not** an orchestrator, framework, or harness. It stays out of the agent loop and solely handles the coordination around it: isolated workspaces, restartable sessions, branch exchange, promotion, and visibility.

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

### Requirements

- Node 20+
- `git`
- `gh` on your `PATH` if you want PR-based promotion against a GitHub remote
- Daytona credentials if you switch `.revis/config.json` to `"sandboxProvider": "daytona"`

## Usage

```bash
revis init                                      # initialize coordination in the current repo
revis spawn 4 --exec 'codex --yolo'             # start 4 coordinated workspaces with your agent command
revis status --watch                            # watch workspace state live
revis events                                    # tail the live event stream
revis dashboard                                 # open the local dashboard
revis promote agent-2                           # promote one workspace into trunk or a PR
revis stop agent-2                              # stop one workspace
revis stop --all                                # stop every workspace and the daemon
```

`revis init` prefers `origin`, otherwise uses the only configured remote, otherwise creates `.revis/coordination.git` as a local bare coordination remote. `--exec` is required for `revis spawn`. For the coordination model, branch layout, promotion behavior, and runtime files, see [docs/REVIS.md](./docs/REVIS.md).

## Examples

Try the example repos in [`examples/`](./examples), starting with [`examples/mandelbrot`](./examples/mandelbrot/README.md).

## License

[MIT](LICENSE)
