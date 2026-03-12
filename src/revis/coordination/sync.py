"""Branch sync helpers for sandbox rebases."""

from __future__ import annotations

from pathlib import Path

from revis.coordination.repo import (
    TRUNK_BRANCH,
    fetch_remote_branch,
    uses_managed_trunk,
    working_tree_dirty,
)
from revis.core.util import run


def sync_branch(repo: Path, *, remote_name: str, branch: str) -> None:
    """Fetch and rebase the current branch onto a remote branch."""

    fetch_remote_branch(repo, remote_name=remote_name, branch=branch)
    run(["git", "rebase", f"{remote_name}/{branch}"], cwd=repo)


def try_sync_branch(
    repo: Path,
    *,
    remote_name: str,
    branch: str,
    conflict_path: Path,
) -> tuple[bool, str]:
    """Attempt a rebase onto the provider-selected sync branch and classify the outcome."""

    if working_tree_dirty(repo):
        # Auto-rebasing over an in-progress experiment would hide exactly the
        # local edits the agent still needs to reason about, so dirty trees are
        # surfaced as "skip and try later" instead of being forced through git.
        return False, "dirty"

    # Attempt the rebase against the active coordination target.
    fetch_remote_branch(repo, remote_name=remote_name, branch=branch)
    result = run(["git", "rebase", f"{remote_name}/{branch}"], cwd=repo, check=False)
    if result.returncode == 0:
        if conflict_path.exists():
            conflict_path.unlink()
        return True, "rebased"

    conflicts = run(
        ["git", "diff", "--name-only", "--diff-filter=U"],
        cwd=repo,
        check=False,
    ).stdout.strip()
    # Conflicts are written into the sandbox itself because the agent is already
    # operating there; the monitor only needs a breadcrumb to point the human at
    # the repo-local conflict artifact.
    conflict_path.write_text((conflicts or result.stderr.strip() or "rebase conflict") + "\n")

    # Reset back to the pre-rebase state once the conflict has been surfaced.
    run(["git", "rebase", "--abort"], cwd=repo, check=False)
    return False, "conflict"


def sync_target_branch(*, remote_name: str, base_branch: str) -> str:
    """Return the branch each coordination mode should rebase agents onto."""

    if uses_managed_trunk(remote_name=remote_name):
        return TRUNK_BRANCH
    return base_branch
