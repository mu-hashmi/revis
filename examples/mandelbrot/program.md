# Revis Mandelbrot Speedrun Program

You are running an autonomous optimization loop inside a Revis workspace. Your goal is to make the fixed Mandelbrot benchmark faster without changing the output bytes.

---

## 1. Goal

- Optimize `render.py` so `uv run python benchmark.py` gets as fast as possible.
- The only metric is `elapsed_seconds` from `benchmark.py`.
- Correctness is binary. `correct=true` is required. Any checksum mismatch is a failed experiment.
- The visual image must stay identical. Only speed may change.

---

## 2. In-Scope Files

| File | Role | You may modify it? |
|------|------|--------------------|
| `render.py` | The Mandelbrot implementation | YES |
| `benchmark.py` | Fixed benchmark and correctness harness | NO |
| `reference.png` | Human-facing reference image | NO |
| `reference.sha256` | Exact correctness target | NO |
| `results.tsv` | Local experiment log | YES, but do not commit changes |
| `notes.md` | Local notebook | YES, but do not commit changes |
| `program.md` | This file | NO |
| `README.md` | Operator docs | NO |

You are optimizing code, not redefining the task. Do not touch files outside this directory unless the human explicitly asks.

---

## 3. Revis-Specific Workflow

Revis will relay commit summaries from other agents into your tmux pane. Those relays look like this:

```text
[revis] 1a2b3c4d alice/agent-2: bench: 4.821s | symmetry | exploit horizontal symmetry (+12 -4)
```

When you see a promising relay:

1. Compare the relayed time to your current best.
2. Inspect the change with `git show <sha> -- render.py`.
3. If needed, inspect nearby history with `git log --decorate --oneline --all -- render.py`.
4. Factor the useful idea into your next hypothesis instead of repeating the same experiment.

---

## 4. Anti-Cheating Rules

These are hard constraints, not suggestions.

- No hardcoding the reference output.
- No reading `reference.png` or `reference.sha256` to synthesize the answer.
- No caching rendered output to disk, memory-mapped files, or temp files between benchmark runs.
- No changing `benchmark.py`, `reference.png`, `reference.sha256`, `README.md`, or `program.md`.
- No reducing image size, iteration count, viewport, or fidelity unless the output bytes remain exactly identical.
- No shortcut logic whose only purpose is to game the benchmark harness.
- No dependency changes. This example is stdlib-only.

If an optimization changes the checksum, it failed.

---

## 5. Commit Convention

Every benchmarked render.py change gets a commit with this exact subject shape:

```text
bench: 4.821s | symmetry | exploit horizontal symmetry
```

Rules:

- Put the measured time first after `bench:`.
- Use one short category in the middle field.
- End with a concise description of what changed.
- Commit only `render.py`.
- Do not rely on commit bodies for provenance.
- The initial baseline benchmark may reuse the existing `HEAD` commit if you have
  not changed `render.py` yet. Log that baseline in `results.tsv` and `notes.md`
  instead of creating a no-op commit.

This format is what makes Revis relays instantly scannable.

---

## 6. Local Log Format

Append every experiment to `results.tsv` as tab-separated data:

```text
commit	elapsed_seconds	status	description
```

Statuses:

- `keep` means this is your new best-known implementation.
- `discard` means it benchmarked correctly but lost to your current best.
- `crash` means the benchmark failed or produced `correct=false`.

Use `notes.md` to track:

- your current best commit and time
- ideas worth retrying
- relay SHAs or brief reminders worth combining
- failure patterns to avoid

Do not commit `results.tsv` or `notes.md`.
Do not copy another agent's benchmark ledger into your local files. `results.tsv`
must contain only experiments you ran in this workspace. `notes.md` may mention
relay SHAs as prompts for future work, but do not transcribe another agent's
time/category/description unless you reran that idea locally.

---

## 7. The Loop

Read this as an exact operating procedure.

```text
LOOP FOREVER:
  1. Read results.tsv and notes.md to reconstruct your current best commit and time.
  2. Read recent Revis relays in the pane. If one looks useful, inspect it before choosing your next move.
  3. Form one hypothesis. State why it should reduce elapsed_seconds.
  4. Restore the best-known implementation into render.py if your working tree is not already based on it.
  5. Modify ONE lever in render.py.
  6. Run: uv run python benchmark.py
  7. If correct=false or the command crashes:
       - log a crash row
       - diagnose briefly
       - return render.py to the best-known commit
       - continue
  8. If correct=true:
       - if this run changed render.py relative to the best-known baseline, commit it with the required bench: subject
       - if this run is only the initial baseline benchmark of the current HEAD, do not create a no-op commit
       - append a row to results.tsv
       - update notes.md
  9. If the experiment beat your best time:
       - mark it keep
       - treat this commit as the new baseline for future work
  10. If it did not beat your best time:
       - mark it discard
       - before the next hypothesis, restore render.py from the best-known commit
  NEVER STOP
```

Do not rewrite history just to discard a slower idea. The git log is part of the demo.
