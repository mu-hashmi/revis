"""Runtime update helpers that sit above the persistence layer."""

from __future__ import annotations

import os
from pathlib import Path

from revis.coordination.runtime import (
    append_event,
    append_metric,
    load_agent_record,
    load_all_agent_records,
    write_agent_record,
)
from revis.core.models import RevisConfig
from revis.core.util import iso_now
from revis.sandbox import get_provider


def refresh_runtime(root: Path, config: RevisConfig) -> None:
    """Refresh persisted runtime records by probing live provider state."""

    provider = get_provider(root, config)

    # Probe each live sandbox and persist the refreshed record.
    for record in load_all_agent_records(root):
        try:
            updated = provider.probe(record)
        except Exception as exc:
            # One broken sandbox should not stop `status` from reporting the
            # rest of the swarm, so probe failures are recorded onto that
            # specific runtime record instead of aborting the whole refresh.
            record.last_error = str(exc)
            updated = record
        write_agent_record(root, updated)


def update_root_runtime_from_env(
    *,
    config: RevisConfig,
    agent_id: str,
    event_type: str,
    summary: str,
) -> None:
    """Write runtime updates back to the project root from inside a sandbox."""

    project_root = os.environ.get("REVIS_PROJECT_ROOT")
    if not project_root:
        # Remote sandboxes do not share a writable host filesystem, so only
        # local mode can opportunistically mirror runtime updates back into
        # `.revis/runtime`.
        return

    # Load the host-side runtime record that matches this sandbox.
    root = Path(project_root)
    record = load_agent_record(root, agent_id)
    if not record:
        return

    # Update the per-agent timestamps first.
    timestamp = iso_now()
    if event_type == "finding_logged":
        record.last_finding_at = timestamp
    if event_type == "promotion":
        record.last_promotion_at = timestamp
    write_agent_record(root, record)

    # Append matching event and metric samples for the monitor UI.
    append_event(
        root,
        {
            "timestamp": timestamp,
            "type": event_type,
            "agent_id": agent_id,
            "summary": summary,
        },
        retention_entries=config.retention.max_event_entries,
        retention_bytes=config.retention.max_event_bytes,
        retention_archives=config.retention.max_event_archives,
    )
    append_metric(
        root,
        agent_id,
        {"timestamp": timestamp, "event_type": event_type},
        max_points=config.retention.max_metric_points,
    )
