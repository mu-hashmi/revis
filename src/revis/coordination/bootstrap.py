"""Bootstrap shared coordination branches on the chosen remote."""

from __future__ import annotations

import shutil
from pathlib import Path

from revis.coordination.repo import (
    FINDINGS_BRANCH,
    TRUNK_BRANCH,
    add_or_update_remote,
    has_commits,
    set_git_identity,
)
from revis.core.util import ensure_dir, iso_now, run, temp_dir


def bootstrap_remote(
    root: Path,
    *,
    remote_name: str,
    target_url: str,
    trunk_base_branch: str,
    manage_trunk: bool,
) -> None:
    """Initialize findings and, when needed, trunk branches on the coordination remote."""

    add_or_update_remote(root, remote_name, target_url)
    # Only the fallback `revis-local` remote owns a Revis-managed trunk. When
    # coordinating through a real remote, Revis leaves the user's branch layout
    # intact and limits itself to the findings ledger plus PR-based promotion.

    # Seed the shared code branch only when Revis owns trunk management.
    if manage_trunk:
        if has_commits(root):
            run(
                ["git", "push", "--force", remote_name, f"HEAD:refs/heads/{TRUNK_BRANCH}"],
                cwd=root,
            )
        else:
            seed_empty_trunk(target_url)

    # Seed the findings ledger in every coordination mode.
    seed_findings_branch(
        target_url,
        source_branch=TRUNK_BRANCH if manage_trunk else trunk_base_branch,
    )
    if manage_trunk and target_url.endswith(".git") and Path(target_url).exists():
        run(
            ["git", "--git-dir", target_url, "symbolic-ref", "HEAD", f"refs/heads/{TRUNK_BRANCH}"],
            cwd=root,
            check=False,
        )


def seed_empty_trunk(remote_url_value: str) -> None:
    """Seed `revis/trunk` with an empty root commit."""

    with temp_dir("revis-seed-trunk-") as temp_root:
        run(["git", "init"], cwd=temp_root)
        set_git_identity(temp_root, name="Revis", email="revis@localhost")
        run(["git", "checkout", "-b", TRUNK_BRANCH], cwd=temp_root)
        run(["git", "commit", "--allow-empty", "-m", "Initialize revis trunk"], cwd=temp_root)
        run(["git", "remote", "add", "origin", remote_url_value], cwd=temp_root)
        run(["git", "push", "--force", "origin", f"{TRUNK_BRANCH}:refs/heads/{TRUNK_BRANCH}"], cwd=temp_root)


def seed_findings_branch(remote_url_value: str, *, source_branch: str) -> None:
    """Seed the orphan findings branch with a bootstrap finding."""

    with temp_dir("revis-seed-findings-") as temp_root:
        # Clone any existing branch only to get a valid repository we can orphan
        # from. The findings ledger intentionally has no shared history with code
        # branches so collaboration data never pollutes normal repo history.
        run(["git", "clone", "--branch", source_branch, remote_url_value, str(temp_root / "repo")], cwd=temp_root)
        repo = temp_root / "repo"
        set_git_identity(repo, name="Revis", email="revis@localhost")

        # Replace the working tree with the minimal findings bootstrap state.
        run(["git", "checkout", "--orphan", FINDINGS_BRANCH], cwd=repo)
        for child in repo.iterdir():
            if child.name == ".git":
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

        ensure_dir(repo / "findings")
        seed = repo / "findings" / "bootstrap.md"
        seed.write_text(
            "---\n"
            f"agent: revis\ntimestamp: {iso_now()}\nkind: claim\n"
            "---\n"
            "Revis findings ledger initialized.\n"
        )
        run(["git", "add", "findings/bootstrap.md"], cwd=repo)
        run(["git", "commit", "-m", "Initialize revis findings"], cwd=repo)
        run(["git", "push", "--force", "origin", f"{FINDINGS_BRANCH}:refs/heads/{FINDINGS_BRANCH}"], cwd=repo)
