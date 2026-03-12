"""Read and write the shared findings ledger branch."""

from __future__ import annotations

from pathlib import Path
import random
import time

import yaml

from revis.core.models import FindingEntry
from revis.coordination.repo import FINDINGS_BRANCH, fetch_remote_branch, with_branch_worktree
from revis.core.util import RevisError, iso_now, parse_iso, run


def write_findings_entry(
    repo: Path,
    *,
    remote_name: str,
    agent_id: str,
    message: str,
    kind: str | None,
    source: str | None,
    title: str | None,
    url: str | None,
) -> Path:
    """Write, commit, and push one findings entry on the findings branch."""

    with with_branch_worktree(repo, remote_name=remote_name, branch=FINDINGS_BRANCH) as worktree:
        timestamp = iso_now()

        # Timestamped filenames keep the ledger append-only and make raw branch
        # inspection readable even before frontmatter is parsed.
        filename = timestamp.replace(":", "-") + f"-{agent_id}.md"

        # Build the markdown finding payload.
        frontmatter = {
            key: value
            for key, value in {
                "agent": agent_id,
                "timestamp": timestamp,
                "kind": kind,
                "source": source,
                "title": title,
                "url": url,
            }.items()
            if value is not None
        }
        header = yaml.safe_dump(frontmatter, sort_keys=False).strip()
        path = worktree / "findings" / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"---\n{header}\n---\n\n{message.strip()}\n")

        # Commit the new finding onto the detached findings worktree.
        run(["git", "add", str(path.relative_to(worktree))], cwd=worktree)
        run(["git", "commit", "-m", f"finding: {agent_id} {timestamp}"], cwd=worktree)
        _push_findings_with_retry(worktree, remote_name=remote_name)
        return path


def _push_findings_with_retry(worktree: Path, *, remote_name: str) -> None:
    """Push one findings commit with optimistic retry under concurrent writers."""

    max_attempts = 8

    # Findings writes are append-only commits. When multiple agents race, the
    # correct response is to replay this one commit onto the newest remote tip,
    # not to introduce a separate lock service outside git.
    for attempt in range(1, max_attempts + 1):
        try:
            fetch_remote_branch(worktree, remote_name=remote_name, branch=FINDINGS_BRANCH)
            run(["git", "rebase", f"{remote_name}/{FINDINGS_BRANCH}"], cwd=worktree)
            run(["git", "push", remote_name, f"HEAD:refs/heads/{FINDINGS_BRANCH}"], cwd=worktree)
            return
        except RevisError as exc:
            run(["git", "rebase", "--abort"], cwd=worktree, check=False)
            if attempt >= max_attempts or not _is_retryable_findings_race(str(exc)):
                raise
            time.sleep(_retry_backoff_seconds(attempt))

    raise RevisError("Failed to push finding after exhausting retries.")


def _is_retryable_findings_race(message: str) -> bool:
    """Return whether a git failure message indicates a normal write race."""

    retryable_markers = (
        "non-fast-forward",
        "fetch first",
        "remote rejected",
        "incorrect old value provided",
        "failed to push some refs",
        "stale info",
    )
    lowered = message.lower()
    return any(marker in lowered for marker in retryable_markers)


def _retry_backoff_seconds(attempt: int) -> float:
    """Return bounded exponential backoff with jitter for a retry attempt."""

    base_delay = 0.05
    capped = min(base_delay * (2 ** (attempt - 1)), 1.0)
    return random.uniform(capped / 2, capped * 1.5)


def fetch_findings_tree(repo: Path, *, remote_name: str) -> list[Path]:
    """Return finding file paths from a temporary findings worktree."""

    with with_branch_worktree(repo, remote_name=remote_name, branch=FINDINGS_BRANCH) as worktree:
        return sorted((worktree / "findings").glob("*.md"))


def read_findings(repo: Path, *, remote_name: str) -> list[FindingEntry]:
    """Read and sort all findings from newest to oldest."""

    entries: list[FindingEntry] = []

    # Parse every finding file from the shared ledger snapshot.
    with with_branch_worktree(repo, remote_name=remote_name, branch=FINDINGS_BRANCH) as worktree:
        for path in sorted((worktree / "findings").glob("*.md")):
            entries.append(parse_finding(path))

    # Return newest-first so CLI consumers can slice without resorting.
    entries.sort(key=lambda entry: parse_iso(entry.timestamp), reverse=True)
    return entries


def parse_finding(path: Path) -> FindingEntry:
    """Parse one markdown finding file with YAML frontmatter."""

    content = path.read_text()
    frontmatter_text, body = _split_frontmatter(content, path=path)
    data = yaml.safe_load(frontmatter_text) or {}
    if not isinstance(data, dict):
        raise RevisError(f"Invalid finding frontmatter: {path}")

    try:
        return FindingEntry(
            path=str(path),
            agent=str(data["agent"]),
            timestamp=str(data["timestamp"]),
            body=body.strip(),
            kind=_optional_str(data.get("kind")),
            source=_optional_str(data.get("source")),
            title=_optional_str(data.get("title")),
            url=_optional_str(data.get("url")),
        )
    except KeyError as exc:
        raise RevisError(f"Missing required finding field {exc.args[0]!r}: {path}") from exc


def _split_frontmatter(content: str, *, path: Path) -> tuple[str, str]:
    """Split a markdown document into YAML frontmatter and body."""

    if not content.startswith("---\n"):
        raise RevisError(f"Invalid finding: {path}")
    try:
        _, frontmatter, body = content.split("---\n", 2)
    except ValueError as exc:
        raise RevisError(f"Invalid finding: {path}") from exc
    return frontmatter, body


def _optional_str(value: object) -> str | None:
    """Normalize optional frontmatter scalars into strings."""

    if value is None:
        return None
    return str(value)
