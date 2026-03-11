"""Background daemon that refreshes findings and syncs sandboxes to trunk."""

from __future__ import annotations

import time
from pathlib import Path

from revis.core.config import load_config
from revis.coordination.findings import write_dashboard_files
from revis.coordination.git import FINDINGS_BRANCH, TRUNK_BRANCH, current_branch, read_findings, try_sync_branch
from revis.coordination.runtime import append_event, append_metric, load_agent_record, write_agent_record
from revis.coordination.sandbox_meta import load_sandbox_meta
from revis.core.util import RevisError, iso_now


def daemon_log_path(repo: Path) -> Path:
    """Return the daemon log file path.

    Args:
        repo: Sandbox repo root.

    Returns:
        Path: `.revis/daemon.log` path.
    """
    return repo / ".revis" / "daemon.log"


def heartbeat_path(repo: Path) -> Path:
    """Return the daemon heartbeat path.

    Args:
        repo: Sandbox repo root.

    Returns:
        Path: `.revis/last-daemon-sync` path.
    """
    return repo / ".revis" / "last-daemon-sync"


def conflict_path(repo: Path) -> Path:
    """Return the path used to surface auto-sync conflicts.

    Args:
        repo: Sandbox repo root.

    Returns:
        Path: `.revis/sync-conflict` path.
    """
    return repo / ".revis" / "sync-conflict"


def append_daemon_log(repo: Path, message: str) -> None:
    """Append one timestamped line to the daemon log.

    Args:
        repo: Sandbox repo root.
        message: Log message to append.
    """
    path = daemon_log_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"[{iso_now()}] {message}\n")


def run_daemon_cycle(repo: Path) -> None:
    """Run one daemon cycle for a sandbox.

    Args:
        repo: Sandbox repo root.
    """
    config = load_config(repo)
    meta = load_sandbox_meta(repo)
    entries = read_findings(repo, remote_name=config.coordination_remote)
    write_dashboard_files(repo, entries)

    project_root = Path(meta["project_root"]) if meta.get("project_root") else None
    agent_id = meta["agent_id"]
    ok, result = try_sync_branch(
        repo,
        remote_name=config.coordination_remote,
        branch=TRUNK_BRANCH,
        conflict_path=conflict_path(repo),
    )
    timestamp = iso_now()
    heartbeat_path(repo).write_text(timestamp + "\n")

    if project_root:
        record = load_agent_record(project_root, agent_id)
        if record:
            record.last_heartbeat = timestamp
            record.last_sync_at = timestamp
            record.last_sync_result = result
            record.conflict_path = str(conflict_path(repo)) if conflict_path(repo).exists() else None
            write_agent_record(project_root, record)
            append_event(
                project_root,
                {
                    "timestamp": timestamp,
                    "type": "daemon_sync",
                    "agent_id": agent_id,
                    "status": result,
                },
                retention_entries=config.retention.max_event_entries,
                retention_bytes=config.retention.max_event_bytes,
                retention_archives=config.retention.max_event_archives,
            )
            append_metric(
                project_root,
                agent_id,
                {
                    "timestamp": timestamp,
                    "sync_ok": ok,
                    "last_sync_result": result,
                },
                max_points=config.retention.max_metric_points,
            )


def run_daemon_loop(repo: Path) -> None:
    """Run daemon cycles forever using the configured interval.

    Args:
        repo: Sandbox repo root.
    """
    config = load_config(repo)
    interval_seconds = max(config.daemon_interval_minutes, 1) * 60
    while True:
        try:
            run_daemon_cycle(repo)
        except Exception as exc:
            append_daemon_log(repo, f"cycle failed: {exc}")
            try:
                meta = load_sandbox_meta(repo)
                project_root = Path(meta["project_root"]) if meta.get("project_root") else None
                if project_root:
                    record = load_agent_record(project_root, meta["agent_id"])
                    if record:
                        record.last_error = str(exc)
                        write_agent_record(project_root, record)
            except Exception as nested_exc:
                append_daemon_log(repo, f"failed to persist runtime error: {nested_exc}")
        time.sleep(interval_seconds)
