"""Project setup helpers used during `revis init`."""

from __future__ import annotations

from pathlib import Path

from revis.coordination.repo import (
    ensure_coordination_remote,
    remote_url,
    uses_managed_trunk,
)
from revis.core.util import RevisError, run


def determine_remote_name(root: Path) -> str:
    """Choose the coordination remote name."""

    remotes = run(["git", "remote"], cwd=root).stdout.splitlines()

    # Prefer `origin` when present because it is the least surprising remote for
    # both Daytona clones and GitHub-backed promotion.
    if "origin" in remotes:
        return "origin"
    if len(remotes) == 1:
        return remotes[0]
    if not remotes:
        # No remote means Revis needs a private local coordination surface.
        return "revis-local"
    raise RevisError(
        "Revis could not choose a coordination remote. Set `origin` or leave only one git remote configured."
    )


def configure_coordination_remote(root: Path, remote_name: str) -> str:
    """Resolve or create the coordination remote target URL/path."""

    # Coordination ownership is keyed off the remote name, not the provider:
    # local sandboxes may still coordinate through GitHub, while `revis-local`
    # means Revis owns the whole trunk/findings remote itself.
    if uses_managed_trunk(remote_name=remote_name):
        return str(ensure_coordination_remote(root))
    return remote_url(root, remote_name)


def ensure_gitignore(root: Path) -> None:
    """Append Revis runtime paths to `.gitignore` when missing."""

    path = root / ".gitignore"
    existing = path.read_text() if path.exists() else ""
    lines = [
        "# Revis runtime state stays untracked because it is ephemeral local monitor data.",
        ".revis/runtime/",
        "# Local sandboxes are disposable working clones, not part of the source tree.",
        ".revis/agents/",
        "# The local coordination remote is an implementation detail for local-mode swarms.",
        ".revis/coordination.git/",
    ]
    with path.open("a", encoding="utf-8") as handle:
        for line in lines:
            if line not in existing:
                handle.write(f"{line}\n")
