"""Promotion helpers for managed-trunk merges and GitHub PRs."""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from revis.core.models import FindingEntry
from revis.coordination.repo import (
    TRUNK_BRANCH,
    normalize_http_remote,
    with_branch_worktree,
)
from revis.core.util import RevisError, run


@dataclass(slots=True)
class PullRequestRef:
    """Minimal PR metadata returned from GitHub CLI lookups."""

    number: int
    url: str
    title: str
    created: bool


def promote_branch(repo: Path, *, remote_name: str, current_branch_name: str) -> str:
    """Merge the current agent branch into trunk and push the update."""

    with with_branch_worktree(repo, remote_name=remote_name, branch=TRUNK_BRANCH) as worktree:
        result = run(
            ["git", "merge", "--no-ff", "--no-edit", current_branch_name],
            cwd=worktree,
            check=False,
        )
        if result.returncode != 0:
            run(["git", "merge", "--abort"], cwd=worktree, check=False)
            raise RevisError(result.stderr.strip() or "merge failed")
        run(["git", "push", remote_name, f"HEAD:refs/heads/{TRUNK_BRANCH}"], cwd=worktree)
        summary = run(["git", "log", "-1", "--pretty=%s"], cwd=worktree).stdout.strip()
        return summary


def ensure_github_cli_ready(repo: Path) -> None:
    """Fail fast when GitHub CLI is unavailable for PR-based promotion."""

    if shutil.which("gh") is None:
        raise RevisError("GitHub CLI is not installed. Install `gh` before using PR-based promotion.")

    # Prefer explicit tokens in CI because `gh auth status` depends on a
    # developer-local login state that remote sandboxes typically do not share.
    if os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"):
        return

    result = run(["gh", "auth", "status", "--hostname", "github.com"], cwd=repo, check=False)
    if result.returncode != 0:
        raise RevisError("GitHub CLI is not authenticated. Set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`.")


def ensure_github_remote(url: str) -> str:
    """Validate that a remote points at GitHub and return its HTTPS form."""

    normalized = normalize_http_remote(url)
    hostname = urlparse(normalized).hostname
    if hostname != "github.com":
        raise RevisError(f"GitHub PR promotion requires a github.com remote, got: {url}")
    return normalized


def github_repo_name(url: str) -> str:
    """Return the `OWNER/REPO` slug for a GitHub remote."""

    normalized = ensure_github_remote(url)
    path = urlparse(normalized).path.removeprefix("/").removesuffix(".git")
    parts = path.split("/")
    if len(parts) < 2:
        raise RevisError(f"Could not determine OWNER/REPO from remote URL: {url}")
    return f"{parts[0]}/{parts[1]}"


def push_branch_for_pr(repo: Path, *, remote_name: str, branch: str) -> None:
    """Push an agent branch so GitHub can open or update a PR for it."""

    # Agents own their work branches outright, so force-with-lease preserves the
    # "one branch per agent" workflow without clobbering unrelated remote state.
    run(["git", "push", "--force-with-lease", "-u", remote_name, f"{branch}:{branch}"], cwd=repo)


def find_open_pull_request(
    repo: Path,
    *,
    repo_name: str,
    base_branch: str,
    head_branch: str,
) -> PullRequestRef | None:
    """Return the open PR for one branch pair, if it exists."""

    # Ask GitHub whether this agent branch already has an open promotion PR.
    result = run(
        [
            "gh",
            "pr",
            "list",
            "--repo",
            repo_name,
            "--state",
            "open",
            "--base",
            base_branch,
            "--head",
            head_branch,
            "--json",
            "number,url,title",
        ],
        cwd=repo,
    )
    payload = json.loads(result.stdout)
    if not payload:
        return None
    pr = payload[0]
    return PullRequestRef(
        number=int(pr["number"]),
        url=str(pr["url"]),
        title=str(pr["title"]),
        created=False,
    )


def create_or_reuse_pull_request(
    repo: Path,
    *,
    repo_name: str,
    base_branch: str,
    head_branch: str,
    title: str,
    body: str,
) -> PullRequestRef:
    """Create a PR for the current branch pair or return the existing open one."""

    # Reuse an existing promotion PR when one already tracks this branch pair.
    existing = find_open_pull_request(
        repo,
        repo_name=repo_name,
        base_branch=base_branch,
        head_branch=head_branch,
    )
    if existing is not None:
        # Revis treats promotion as "maintain the candidate PR for this agent
        # branch", not "open a fresh PR every time the agent makes progress".
        return existing

    # Create the promotion PR when this branch pair has not been promoted yet.
    run(
        [
            "gh",
            "pr",
            "create",
            "--repo",
            repo_name,
            "--base",
            base_branch,
            "--head",
            head_branch,
            "--title",
            title,
            "--body",
            body,
        ],
        cwd=repo,
    )
    created = find_open_pull_request(
        repo,
        repo_name=repo_name,
        base_branch=base_branch,
        head_branch=head_branch,
    )
    if created is None:
        raise RevisError("GitHub CLI did not return the created pull request.")
    created.created = True
    return created


def latest_promotion_finding(
    entries: list[FindingEntry],
    *,
    agent_id: str,
) -> FindingEntry | None:
    """Return the newest agent finding that can seed a promotion PR."""

    preferred = {"result", "literature", "warning"}

    # Prefer findings that describe actual work over previous promotion records.
    for entry in entries:
        if entry.agent == agent_id and entry.kind in preferred:
            return entry

    # Fall back to any non-promotion finding if nothing preferred exists yet.
    for entry in entries:
        if entry.agent == agent_id and entry.kind != "promotion":
            return entry
    return None


def build_promotion_title(*, branch_name: str, finding: FindingEntry | None) -> str:
    """Build a PR title with the required Revis prefix."""

    summary = branch_name
    if finding is not None:
        summary = finding.title or first_non_empty_line(finding.body)
    if summary.startswith("[Revis] "):
        return summary
    return f"[Revis] {summary}"


def build_promotion_body(
    *,
    branch_name: str,
    base_branch: str,
    finding: FindingEntry | None,
) -> str:
    """Render the initial PR body from the latest finding context."""

    lines = [
        "Automated promotion candidate from Revis.",
        "",
        f"- Base branch: `{base_branch}`",
        f"- Agent branch: `{branch_name}`",
    ]
    if finding is not None:
        summary = finding.title or first_non_empty_line(finding.body)
        lines.append(f"- Finding: {summary}")
        excerpt = first_non_empty_line(finding.body)
        if excerpt != summary:
            lines.append(f"- Excerpt: {excerpt}")
        if finding.url:
            lines.append(f"- URL: {finding.url}")
    return "\n".join(lines)


def first_non_empty_line(body: str) -> str:
    """Return the first non-empty line from a markdown body."""

    for line in body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    raise RevisError("Finding body is empty.")
