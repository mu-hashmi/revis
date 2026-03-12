"""Filter and render findings for CLI output and sandbox dashboards."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from revis.core.models import FindingEntry
from revis.core.util import parse_iso, parse_since_expression


def filter_findings(
    entries: list[FindingEntry],
    *,
    since: str | None = None,
    agent: str | None = None,
    last: int | None = None,
    kind: str | None = None,
    source: str | None = None,
) -> list[FindingEntry]:
    """Filter findings by the supported CLI query fields.

    Args:
        entries: Parsed finding entries in newest-first order.
        since: Optional ISO or relative cutoff expression.
        agent: Optional exact agent ID or simple prefix glob such as `codex-*`.
        last: Optional maximum number of results to keep.
        kind: Optional finding kind filter.
        source: Optional source identifier filter.

    Returns:
        list[FindingEntry]: Filtered findings, preserving input order.
    """
    filtered = entries

    # Apply time-based filtering first.
    if since:
        threshold = parse_since_expression(since)
        filtered = [entry for entry in filtered if parse_iso(entry.timestamp) >= threshold]

    # Apply agent/source metadata filters next.
    if agent:
        if "*" in agent:
            prefix = agent.split("*", 1)[0]
            filtered = [entry for entry in filtered if entry.agent.startswith(prefix)]
        else:
            filtered = [entry for entry in filtered if entry.agent == agent]
    if kind:
        filtered = [entry for entry in filtered if entry.kind == kind]
    if source:
        filtered = [entry for entry in filtered if entry.source == source]

    # Trim the result set only after all other filters have run.
    if last is not None:
        filtered = filtered[:last]
    return filtered


def render_findings(entries: list[FindingEntry]) -> str:
    """Render findings as plain-text CLI output.

    Args:
        entries: Findings to render.

    Returns:
        str: Human-readable findings output.
    """
    if not entries:
        return "No findings.\n"

    # Render one plain-text block per finding.
    blocks: list[str] = []
    for entry in entries:
        title = f"{entry.timestamp}  {entry.agent}"
        meta: list[str] = []
        if entry.kind:
            meta.append(entry.kind)
        if entry.source:
            meta.append(entry.source)
        if entry.title:
            meta.append(entry.title)
        blocks.append("\n".join([title, " | ".join(meta) if meta else "", entry.body]).strip())
    return "\n\n".join(blocks) + "\n"


def render_latest_findings(entries: list[FindingEntry]) -> str:
    """Render the daemon-maintained latest findings document.

    Args:
        entries: Findings to render.

    Returns:
        str: Markdown document written to `.revis/latest-findings.md`.
    """
    header = "# Latest Findings\n\n"
    return header + render_findings(entries)


def render_source_index(entries: list[FindingEntry]) -> str:
    """Render the daemon-maintained source index.

    Args:
        entries: Findings that include source metadata.

    Returns:
        str: Markdown document summarizing the latest entry per source.
    """
    by_source: dict[str, list[FindingEntry]] = defaultdict(list)
    for entry in entries:
        if entry.source:
            by_source[entry.source].append(entry)
    lines = ["# Source Index", ""]
    if not by_source:
        return "\n".join(lines + ["No claimed or summarized sources yet.", ""]) 
    for source, source_entries in sorted(by_source.items()):
        # The source index is meant to answer "who last touched this source and
        # what did they say?" quickly, not to duplicate the full findings history.
        latest = max(source_entries, key=lambda item: parse_iso(item.timestamp))
        lines.append(f"## {source}")
        lines.append(f"- Latest: {latest.timestamp} by {latest.agent}")
        if latest.kind:
            lines.append(f"- Kind: {latest.kind}")
        if latest.title:
            lines.append(f"- Title: {latest.title}")
        if latest.url:
            lines.append(f"- URL: {latest.url}")
        excerpt = latest.body.strip().splitlines()[0] if latest.body.strip() else ""
        if excerpt:
            lines.append(f"- Note: {excerpt}")
        lines.append("")
    return "\n".join(lines)


def write_dashboard_files(root: Path, entries: list[FindingEntry]) -> None:
    """Write dashboard markdown files into `.revis/`.

    Args:
        root: Sandbox repo root.
        entries: Findings used to render the dashboard files.
    """
    revis_dir = root / ".revis"
    revis_dir.mkdir(parents=True, exist_ok=True)
    # The shared dashboard intentionally mirrors raw findings rather than a
    # synthesized diagnosis because the protocol treats early interpretation as
    # anchoring bias for the rest of the swarm.
    (revis_dir / "latest-findings.md").write_text(render_latest_findings(entries))
    # The source index is for coordination around papers/topics/PRs. Routine
    # experiment result spam would drown out that higher-signal view.
    interesting = [entry for entry in entries if entry.kind in {"claim", "literature", "promotion"}]
    (revis_dir / "source-index.md").write_text(render_source_index(interesting))
