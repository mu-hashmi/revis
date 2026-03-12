"""Build raw session reports from the findings ledger."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import re

from revis.coordination.ledger import read_findings
from revis.coordination.runtime import (
    load_all_agent_records,
    load_registry,
    load_session_registry,
)
from revis.core.models import AgentRuntimeRecord, FindingEntry, RuntimeRegistry
from revis.core.util import RevisError, ensure_dir, iso_now, parse_iso


def write_session_report(
    root: Path,
    *,
    remote_name: str,
    output_path: Path | None = None,
    session_id: str | None = None,
) -> Path:
    """Render one session report and write it to disk.

    Args:
        root: Repository root.
        remote_name: Configured coordination remote name.
        output_path: Optional override for the destination markdown path.
        session_id: Optional explicit session ID to render.

    Returns:
        Path: Written markdown report path.
    """
    registry = resolve_session_registry(root, session_id=session_id)
    entries = session_findings(
        root,
        remote_name=remote_name,
        session_id=registry.swarm_id,
    )
    records = session_agent_records(root, session_id=registry.swarm_id)

    report = render_session_report(
        registry=registry,
        entries=entries,
        records=records,
    )

    target = resolve_report_path(root, session_id=registry.swarm_id, output_path=output_path)
    ensure_dir(target.parent)
    target.write_text(report)
    return target


def resolve_session_registry(root: Path, *, session_id: str | None) -> RuntimeRegistry:
    """Resolve the runtime registry for the requested session.

    Args:
        root: Repository root.
        session_id: Optional explicit session ID.

    Returns:
        RuntimeRegistry: Registry for the selected session.

    Raises:
        RevisError: If no matching runtime registry exists.
    """
    if session_id is not None:
        registry = load_session_registry(root, session_id)
        if registry is None:
            raise RevisError(f"Unknown session: {session_id}")
        return registry

    registry = load_registry(root)
    if registry is None:
        raise RevisError("No active Revis session found. Spawn agents before running `revis report`.")
    return registry


def session_findings(
    root: Path,
    *,
    remote_name: str,
    session_id: str,
) -> list[FindingEntry]:
    """Load all findings that belong to one explicit session.

    Args:
        root: Repository root.
        remote_name: Configured coordination remote name.
        session_id: Stable session identifier to filter on.

    Returns:
        list[FindingEntry]: Session findings in newest-first order.

    Raises:
        RevisError: If the session has no findings stamped with `session_id`.
    """
    entries = read_findings(root, remote_name=remote_name)
    session_entries = [entry for entry in entries if entry.session_id == session_id]
    if session_entries:
        return session_entries

    raise RevisError(
        "No session-scoped findings were found for "
        f"{session_id}. `revis report` only works for sessions logged after session tracking was added."
    )


def session_agent_records(root: Path, *, session_id: str) -> dict[str, AgentRuntimeRecord]:
    """Load agent runtime records for one session keyed by agent ID."""

    return {
        record.agent_id: record
        for record in load_all_agent_records(root)
        if record.session_id == session_id
    }


def resolve_report_path(root: Path, *, session_id: str, output_path: Path | None) -> Path:
    """Resolve the destination path for a session report."""

    if output_path is None:
        return root / ".revis" / "reports" / f"{session_id}.md"

    expanded = output_path.expanduser()
    if expanded.is_absolute():
        return expanded
    return (Path.cwd() / expanded).resolve()


def render_session_report(
    *,
    registry: RuntimeRegistry,
    entries: list[FindingEntry],
    records: dict[str, AgentRuntimeRecord],
) -> str:
    """Render a deterministic markdown report for one Revis session."""

    generated_at = iso_now()
    promotions = sorted(
        [entry for entry in entries if entry.kind == "promotion"],
        key=lambda entry: parse_iso(entry.timestamp),
    )
    remote_name = report_remote_name(registry)

    lines = [
        "# Revis Session Report",
        "",
        f"- Session ID: `{registry.swarm_id}`",
        f"- Generated At: `{generated_at}`",
        f"- Session Started: `{registry.started_at}`",
        f"- Coordination Remote: `{remote_name}`",
        f"- Target Branch: `{registry.trunk_branch}`",
        "",
        "## Promotion Links",
        "",
    ]

    if promotions:
        for entry in promotions:
            lines.append(_promotion_line(entry))
    else:
        lines.append("No promotion findings.")

    lines.extend(["", "## Agents", ""])

    by_agent: dict[str, list[FindingEntry]] = defaultdict(list)
    for entry in entries:
        by_agent[entry.agent].append(entry)

    for agent_id in sorted(by_agent, key=_agent_sort_key):
        record = records.get(agent_id)
        lines.extend(_render_agent_section(agent_id, by_agent[agent_id], record))

    return "\n".join(lines) + "\n"


def report_remote_name(registry: RuntimeRegistry) -> str:
    """Return the report-safe coordination remote name for a session."""

    if registry.coordination_remote is None:
        raise RevisError(
            f"Session registry {registry.swarm_id} is missing `coordination_remote`."
        )
    return registry.coordination_remote


def _promotion_line(entry: FindingEntry) -> str:
    """Render one raw promotion index line."""

    summary = _finding_summary(entry)
    if entry.url:
        return f"- `{entry.timestamp}` `{entry.agent}`: {summary} <{entry.url}>"
    return f"- `{entry.timestamp}` `{entry.agent}`: {summary}"


def _render_agent_section(
    agent_id: str,
    entries: list[FindingEntry],
    record: AgentRuntimeRecord | None,
) -> list[str]:
    """Render one agent section with chronological findings."""

    lines = [f"### `{agent_id}`"]

    # Surface only agent context that helps a later synthesis step place the
    # raw findings back onto the branch/direction that produced them.
    if record is not None:
        lines.append(f"- Branch: `{record.branch}`")
        if record.starting_direction:
            lines.append(f"- Starting direction: {record.starting_direction}")

    lines.append("")

    for entry in sorted(entries, key=lambda item: parse_iso(item.timestamp)):
        lines.extend(_render_finding(entry))

    return lines


def _render_finding(entry: FindingEntry) -> list[str]:
    """Render one finding block without interpretation."""

    lines = [f"#### `{entry.timestamp}`"]

    if entry.kind:
        lines.append(f"- Kind: `{entry.kind}`")
    if entry.source:
        lines.append(f"- Source: `{entry.source}`")
    if entry.title:
        lines.append(f"- Title: {entry.title}")
    if entry.url:
        lines.append(f"- URL: <{entry.url}>")

    lines.extend(["", entry.body, ""])
    return lines


def _finding_summary(entry: FindingEntry) -> str:
    """Return the best available one-line summary for a finding."""

    if entry.title:
        return entry.title

    for line in entry.body.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped

    return "Untitled finding"


def _agent_sort_key(agent_id: str) -> tuple[str, int, str]:
    """Return a deterministic numeric-aware sort key for agent IDs."""

    match = re.fullmatch(r"([a-z-]+)-(\d+)", agent_id)
    if not match:
        return (agent_id, -1, agent_id)
    return (match.group(1), int(match.group(2)), agent_id)
