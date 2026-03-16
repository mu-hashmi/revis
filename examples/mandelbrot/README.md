# Mandelbrot

This is the canonical Revis demo: four coordinated agents race to optimize a deliberately naive Mandelbrot renderer, and Revis relays their benchmark commits across tmux workspaces in real time.

The point is not just that the code gets faster. The point is that orthogonal ideas compound. One agent finds symmetry. Another cuts Python overhead. A third sees both relays, combines them, and jumps past either one alone. That is the demo.

## Fast Path

From a local Revis clone:

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

The loop itself is agent-neutral. Revis just starts tmux-backed workspaces and relays commit summaries.

## What The Benchmark Guarantees

- `benchmark.py` is the fixed harness.
- It times only the `render.py` call.
- It requires an exact SHA-256 match against the committed reference output.
- It prints fixed sample pixel values for quick spot-checking.
- It exits non-zero on any mismatch.

Agents may optimize `render.py`. They may not change the task.

If you want the current renderer as an image:

```bash
uv run python benchmark.py --write-png rendered.png
```

## Reference Artifacts

- `reference.png` is the human-facing image.
- `reference.sha256` is the correctness oracle.
- `results.tsv` and `notes.md` are local lab notes for each workspace.

Read [`program.md`](./program.md) before starting an agent manually.
