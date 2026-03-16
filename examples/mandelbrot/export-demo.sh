#!/bin/sh

set -eu

# Materialize the canonical Mandelbrot example into a standalone git repo so
# Revis workspaces clone only the demo files, not the entire Revis repository.

SCRIPT_DIR=$(
  CDPATH= cd -- "$(dirname "$0")"
  pwd
)

if [ "$#" -gt 1 ]; then
  printf '%s\n' "usage: /bin/sh ./examples/mandelbrot/export-demo.sh [destination]" >&2
  exit 1
fi

DESTINATION=${1:-"$HOME/mandelbrot-demo"}

if [ -e "$DESTINATION" ]; then
  printf '%s\n' "destination already exists: $DESTINATION" >&2
  exit 1
fi

mkdir -p "$DESTINATION"

for path in \
  .gitignore \
  README.md \
  benchmark.py \
  notes.md \
  program.md \
  pyproject.toml \
  reference.png \
  reference.sha256 \
  render.py \
  results.tsv
do
  cp "$SCRIPT_DIR/$path" "$DESTINATION/$path"
done

git init -b main "$DESTINATION" >/dev/null
git -C "$DESTINATION" add .
git -C "$DESTINATION" commit -m "chore: initialize mandelbrot demo" >/dev/null

printf '%s\n' "Created standalone Mandelbrot demo repo at $DESTINATION"
printf '%s\n' "Next steps:"
printf '  %s\n' "cd $DESTINATION"
printf '  %s\n' "revis init"
printf '  %s\n' "revis spawn 4 --exec 'codex --yolo \"Read program.md and begin the loop.\"'"
