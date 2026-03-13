"""Persist the latest promotable finding inside one sandbox.

This local seed lets `revis promote` use the exact finding an agent just logged
without racing the shared findings branch push.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from revis.core.models import FindingEntry
from revis.core.util import RevisError, ensure_dir


PROMOTION_SEED_PATH = Path(".revis/promotion-seed.json")
PROMOTION_SEED_KINDS = {"result", "literature", "warning"}


def promotion_seedable_kind(kind: str | None) -> bool:
    """Return whether a finding kind should seed the next promotion."""

    return kind in PROMOTION_SEED_KINDS


def write_promotion_seed(
    root: Path,
    *,
    finding: FindingEntry,
    branch_name: str,
    head_sha: str,
) -> Path:
    """Persist the latest promotable finding for the current branch head."""

    path = root / PROMOTION_SEED_PATH
    ensure_dir(path.parent)
    payload = {
        "path": finding.path,
        "agent": finding.agent,
        "session_id": finding.session_id,
        "timestamp": finding.timestamp,
        "body": finding.body,
        "kind": finding.kind,
        "source": finding.source,
        "title": finding.title,
        "url": finding.url,
        "branch_name": branch_name,
        "head_sha": head_sha,
    }
    temp_path = path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    temp_path.replace(path)
    return path


def load_promotion_seed(
    root: Path,
    *,
    agent_id: str,
    session_id: str | None,
    branch_name: str,
    head_sha: str,
) -> FindingEntry | None:
    """Load the sandbox-local promotion seed when it matches the current head."""

    path = root / PROMOTION_SEED_PATH
    if not path.exists():
        return None

    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise RevisError(f"Invalid promotion seed: {path}") from exc
    if not isinstance(payload, dict):
        raise RevisError(f"Invalid promotion seed: {path}")

    if payload.get("agent") != agent_id:
        return None
    if payload.get("session_id") != session_id:
        return None
    if payload.get("branch_name") != branch_name:
        return None
    if payload.get("head_sha") != head_sha:
        return None

    return FindingEntry(
        path=str(payload.get("path") or path),
        agent=str(payload["agent"]),
        session_id=_optional_str(payload.get("session_id")),
        timestamp=str(payload["timestamp"]),
        body=str(payload["body"]),
        kind=_optional_str(payload.get("kind")),
        source=_optional_str(payload.get("source")),
        title=_optional_str(payload.get("title")),
        url=_optional_str(payload.get("url")),
    )


def wait_for_promotion_seed(
    root: Path,
    *,
    agent_id: str,
    session_id: str | None,
    branch_name: str,
    head_sha: str,
    timeout_seconds: float = 1.5,
    poll_seconds: float = 0.05,
) -> FindingEntry | None:
    """Poll briefly for a matching seed so `log` and `promote` can overlap."""

    deadline = time.monotonic() + timeout_seconds
    while True:
        finding = load_promotion_seed(
            root,
            agent_id=agent_id,
            session_id=session_id,
            branch_name=branch_name,
            head_sha=head_sha,
        )
        if finding is not None:
            return finding
        if time.monotonic() >= deadline:
            return None
        time.sleep(poll_seconds)


def _optional_str(value: object) -> str | None:
    """Normalize optional JSON scalars into strings."""

    if value is None:
        return None
    return str(value)
