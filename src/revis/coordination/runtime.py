"""Persist bounded local runtime state for status and monitor views."""

from __future__ import annotations

import json
import tomllib
from dataclasses import asdict
from pathlib import Path

import tomli_w

from revis.core.models import AgentRuntimeRecord, AgentState, AgentType, RuntimeRegistry, SandboxProvider
from revis.core.util import append_jsonl, ensure_dir, read_json, write_json


# Runtime files back the monitor and status views; they are intentionally local-only.
RUNTIME_DIR = Path(".revis/runtime")


def _compact(value):
    """Recursively drop `None` values before serialization.

    Args:
        value: Nested runtime payload.

    Returns:
        object: Payload with `None` values removed from mappings.
    """
    if isinstance(value, dict):
        return {key: _compact(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_compact(item) for item in value]
    return value


def runtime_dir(root: Path) -> Path:
    """Return the root runtime directory.

    Args:
        root: Repository root.

    Returns:
        Path: `.revis/runtime` directory path.
    """
    return root / RUNTIME_DIR


def agents_dir(root: Path) -> Path:
    """Return the directory containing per-agent runtime records.

    Args:
        root: Repository root.

    Returns:
        Path: Runtime agents directory.
    """
    return ensure_dir(runtime_dir(root) / "agents")


def metrics_dir(root: Path) -> Path:
    """Return the directory containing per-agent metric series.

    Args:
        root: Repository root.

    Returns:
        Path: Runtime metrics directory.
    """
    return ensure_dir(runtime_dir(root) / "metrics")


def events_path(root: Path) -> Path:
    """Return the live runtime event log path.

    Args:
        root: Repository root.

    Returns:
        Path: `events.jsonl` path.
    """
    return runtime_dir(root) / "events.jsonl"


def registry_path(root: Path) -> Path:
    """Return the swarm registry path.

    Args:
        root: Repository root.

    Returns:
        Path: `registry.toml` path.
    """
    return runtime_dir(root) / "registry.toml"


def agent_path(root: Path, agent_id: str) -> Path:
    """Return the runtime record path for one agent.

    Args:
        root: Repository root.
        agent_id: Stable Revis agent identifier.

    Returns:
        Path: Per-agent runtime record path.
    """
    return agents_dir(root) / f"{agent_id}.toml"


def ensure_runtime(root: Path) -> Path:
    """Create the runtime root directory when needed.

    Args:
        root: Repository root.

    Returns:
        Path: Runtime root directory.
    """
    return ensure_dir(root / RUNTIME_DIR)


def write_registry(root: Path, registry: RuntimeRegistry) -> None:
    """Persist the swarm-level runtime registry.

    Args:
        root: Repository root.
        registry: Swarm-level runtime metadata to write.
    """
    ensure_runtime(root)
    registry_path(root).write_text(tomli_w.dumps(_compact(asdict(registry))))


def load_registry(root: Path) -> RuntimeRegistry | None:
    """Load the swarm-level runtime registry.

    Args:
        root: Repository root.

    Returns:
        RuntimeRegistry | None: Parsed registry when present.
    """
    path = registry_path(root)
    if not path.exists():
        return None
    data = tomllib.loads(path.read_text())
    return RuntimeRegistry(
        swarm_id=data["swarm_id"],
        provider=SandboxProvider(data["provider"]),
        started_at=data["started_at"],
        objective_hash=data["objective_hash"],
        trunk_branch=data["trunk_branch"],
        findings_branch=data["findings_branch"],
        config_path=data["config_path"],
    )


def write_agent_record(root: Path, record: AgentRuntimeRecord) -> None:
    """Persist one agent runtime record.

    Args:
        root: Repository root.
        record: Per-agent runtime record to write.
    """
    agents_dir(root)
    agent_path(root, record.agent_id).write_text(tomli_w.dumps(_compact(asdict(record))))


def load_agent_record(root: Path, agent_id: str) -> AgentRuntimeRecord | None:
    """Load one agent runtime record.

    Args:
        root: Repository root.
        agent_id: Stable Revis agent identifier.

    Returns:
        AgentRuntimeRecord | None: Parsed record when present.
    """
    path = agent_path(root, agent_id)
    if not path.exists():
        return None
    return _decode_agent_record(tomllib.loads(path.read_text()))


def load_all_agent_records(root: Path) -> list[AgentRuntimeRecord]:
    """Load all agent runtime records.

    Args:
        root: Repository root.

    Returns:
        list[AgentRuntimeRecord]: Records in stable filename order.
    """
    directory = agents_dir(root)
    records: list[AgentRuntimeRecord] = []
    for path in sorted(directory.glob("*.toml")):
        records.append(_decode_agent_record(tomllib.loads(path.read_text())))
    return records


def _decode_agent_record(data: dict[str, object]) -> AgentRuntimeRecord:
    """Decode TOML data into an `AgentRuntimeRecord`.

    Args:
        data: Parsed TOML mapping.

    Returns:
        AgentRuntimeRecord: Decoded runtime record.
    """
    return AgentRuntimeRecord(
        agent_id=str(data["agent_id"]),
        agent_type=AgentType(str(data["agent_type"])),
        provider=SandboxProvider(str(data["provider"])),
        state=AgentState(str(data["state"])),
        branch=str(data["branch"]),
        started_at=str(data["started_at"]),
        sandbox_path_or_id=str(data["sandbox_path_or_id"]),
        last_heartbeat=data.get("last_heartbeat"),
        last_sync_at=data.get("last_sync_at"),
        last_sync_result=data.get("last_sync_result"),
        last_finding_at=data.get("last_finding_at"),
        last_promotion_at=data.get("last_promotion_at"),
        last_error=data.get("last_error"),
        conflict_path=data.get("conflict_path"),
        attach_cmd=list(data.get("attach_cmd", [])),
        attach_label=data.get("attach_label"),
        worktree_path=data.get("worktree_path"),
        tmux_session=data.get("tmux_session"),
        daemon_pid=data.get("daemon_pid"),
        workspace_name=data.get("workspace_name"),
        workspace_url=data.get("workspace_url"),
    )


def append_event(root: Path, event: dict[str, object], *, retention_entries: int, retention_bytes: int, retention_archives: int) -> None:
    """Append one runtime event and enforce retention bounds.

    Args:
        root: Repository root.
        event: Runtime event payload to append.
        retention_entries: Maximum live entries before rotation.
        retention_bytes: Maximum live file size before rotation.
        retention_archives: Number of rotated archive files to keep.
    """
    ensure_runtime(root)
    path = events_path(root)
    append_jsonl(path, event)
    rotate_events(path, retention_entries=retention_entries, retention_bytes=retention_bytes, retention_archives=retention_archives)


def load_events(root: Path, *, limit: int | None = None) -> list[dict[str, object]]:
    """Load runtime events from disk.

    Args:
        root: Repository root.
        limit: Optional maximum number of newest events to return.

    Returns:
        list[dict[str, object]]: Decoded runtime events.
    """
    path = events_path(root)
    if not path.exists():
        return []
    lines = path.read_text().splitlines()
    if limit is not None:
        lines = lines[-limit:]
    return [json.loads(line) for line in lines if line.strip()]


def rotate_events(path: Path, *, retention_entries: int, retention_bytes: int, retention_archives: int) -> None:
    """Rotate the live event log into bounded archives.

    Args:
        path: Live event log path.
        retention_entries: Maximum live entries before rotation.
        retention_bytes: Maximum live file size before rotation.
        retention_archives: Number of rotated archive files to keep.
    """
    if not path.exists():
        return
    lines = path.read_text().splitlines()
    size = path.stat().st_size
    if len(lines) <= retention_entries and size <= retention_bytes:
        return
    archive_dir = ensure_dir(path.parent / "events")
    for index in range(retention_archives - 1, -1, -1):
        current = archive_dir / f"events.{index}.jsonl"
        if not current.exists():
            continue
        if index + 1 >= retention_archives:
            current.unlink()
        else:
            current.rename(archive_dir / f"events.{index + 1}.jsonl")
    keep = lines[-retention_entries:]
    path.rename(archive_dir / "events.0.jsonl")
    path.write_text("".join(f"{line}\n" for line in keep))


def metric_path(root: Path, agent_id: str) -> Path:
    """Return the metric-series path for one agent.

    Args:
        root: Repository root.
        agent_id: Stable Revis agent identifier.

    Returns:
        Path: Per-agent metric file path.
    """
    return metrics_dir(root) / f"{agent_id}.json"


def load_metrics(root: Path, agent_id: str) -> list[dict[str, object]]:
    """Load metric samples for one agent.

    Args:
        root: Repository root.
        agent_id: Stable Revis agent identifier.

    Returns:
        list[dict[str, object]]: Stored metric samples.
    """
    path = metric_path(root, agent_id)
    if not path.exists():
        return []
    data = read_json(path)
    return data if isinstance(data, list) else []


def append_metric(root: Path, agent_id: str, sample: dict[str, object], *, max_points: int) -> None:
    """Append a metric sample while truncating the series.

    Args:
        root: Repository root.
        agent_id: Stable Revis agent identifier.
        sample: Metric sample payload.
        max_points: Maximum number of samples to retain.
    """
    series = load_metrics(root, agent_id)
    series.append(sample)
    if len(series) > max_points:
        series = series[-max_points:]
    write_json(metric_path(root, agent_id), series)
