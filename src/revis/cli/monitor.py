"""Textual monitor UI for live Revis swarm state and attach actions."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import DataTable, Footer, Header, RichLog, Static

from revis.core.config import load_config
from revis.coordination.runtime import load_all_agent_records, load_events, load_metrics, load_registry, write_agent_record
from revis.sandbox import get_provider


# Unicode blocks used to render compact per-agent activity sparklines.
SPARK_CHARS = "▁▂▃▄▅▆▇█"


def sparkline(values: list[float]) -> str:
    """Render a compact Unicode sparkline from numeric samples.

    Args:
        values: Numeric series to visualize.

    Returns:
        str: Sparkline string using block characters.
    """
    if not values:
        return ""
    low = min(values)
    high = max(values)
    if low == high:
        return SPARK_CHARS[0] * len(values)
    scale = len(SPARK_CHARS) - 1
    return "".join(SPARK_CHARS[int((value - low) / (high - low) * scale)] for value in values)


class RevisMonitor(App[None]):
    """Textual monitor for live swarm state, events, and attach actions.

    Attributes:
        project_root: Repository root for the monitored project.
        agent_rows: Mapping of agent IDs to runtime records shown in the table.
        last_probe_at: Monotonic timestamp of the last provider health probe.
        provider: Sandbox provider instance used for health probes and attach.
        config: Loaded Revis config used for polling cadence.
    """
    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("r", "refresh", "Refresh"),
        Binding("enter", "attach", "Attach"),
    ]

    CSS = """
    Screen {
      layout: vertical;
    }
    #top {
      height: 8;
    }
    #bottom {
      height: 1fr;
    }
    #summary, #detail {
      width: 1fr;
      padding: 1 2;
      border: solid $panel;
    }
    #agents, #events {
      width: 1fr;
      height: 1fr;
      border: solid $panel;
    }
    """

    def __init__(self, project_root: Path):
        """Initialize monitor state for one Revis project.

        Args:
            project_root: Repository root to monitor.
        """
        super().__init__()
        self.project_root = project_root
        self.agent_rows: dict[str, object] = {}
        self.last_probe_at = 0.0
        self.provider = None
        self.config = None

    def compose(self) -> ComposeResult:
        """Build the Textual widget tree.

        Returns:
            ComposeResult: Widgets composing the monitor screen.
        """
        yield Header()
        with Horizontal(id="top"):
            yield Static(id="summary")
            yield Static(id="detail")
        with Horizontal(id="bottom"):
            yield DataTable(id="agents")
            yield RichLog(id="events", highlight=True, wrap=True, markup=False)
        yield Footer()

    def on_mount(self) -> None:
        """Load config/provider state and start periodic refreshes."""
        # Initialize the table schema and provider state once.
        table = self.query_one("#agents", DataTable)
        table.add_columns("Agent", "Type", "State", "Heartbeat", "Findings", "Promotions", "Sync", "Activity")
        table.cursor_type = "row"
        self.config = load_config(self.project_root)
        self.provider = get_provider(self.project_root, self.config)
        self.refresh_view()
        self.set_interval(self.config.monitor.refresh_seconds, self.refresh_view)

    def action_refresh(self) -> None:
        """Refresh the monitor immediately."""
        self.refresh_view()

    def action_attach(self) -> None:
        """Suspend the TUI and attach to the selected agent session."""
        # Resolve the currently highlighted agent row.
        table = self.query_one("#agents", DataTable)
        if table.cursor_row is None or table.cursor_row >= len(self.agent_rows):
            return
        agent_id = list(self.agent_rows.keys())[table.cursor_row]
        record = self.agent_rows[agent_id]
        if not getattr(record, "attach_cmd", None):
            return

        # Suspend the UI while the user attaches to the live session.
        with self.suspend():
            subprocess.run(record.attach_cmd, check=False)
        self.refresh_view()

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        """Update the detail pane when the selected table row changes.

        Args:
            event: Textual row-highlight event.
        """
        row_key = str(event.row_key.value) if event.row_key is not None else None
        if row_key:
            self.update_detail(row_key)

    def refresh_view(self) -> None:
        """Refresh provider health, the agent table, and the event log."""
        if self.provider and self.config and time.time() - self.last_probe_at >= self.config.monitor.health_probe_seconds:
            # Provider probes can be much more expensive than a pure UI repaint,
            # so liveness checks are throttled on their own cadence.
            for record in load_all_agent_records(self.project_root):
                try:
                    updated = self.provider.probe(record)
                except Exception as exc:
                    record.last_error = str(exc)
                    updated = record
                write_agent_record(self.project_root, updated)
            self.last_probe_at = time.time()

        # Reload the latest runtime snapshots from disk.
        registry = load_registry(self.project_root)
        records = load_all_agent_records(self.project_root)
        records.sort(key=lambda record: record.agent_id)
        self.agent_rows = {record.agent_id: record for record in records}

        # Refresh the summary pane.
        summary = self.query_one("#summary", Static)
        if registry:
            active = sum(1 for record in records if getattr(record.state, "value", record.state) == "active")
            summary.update(
                "\n".join(
                    [
                        f"Swarm: {registry.swarm_id}",
                        f"Provider: {registry.provider}",
                        f"Started: {registry.started_at}",
                        f"Agents: {len(records)} total / {active} active",
                    ]
                )
            )
        else:
            summary.update("No runtime registry found.")

        # Rebuild the agent table from the latest metrics and events.
        table = self.query_one("#agents", DataTable)
        table.clear(columns=False)
        for record in records:
            metrics = load_metrics(self.project_root, record.agent_id)
            samples = [1.0 if sample.get("sync_ok") else 0.0 for sample in metrics]
            # Count against a bounded recent event window so long-lived swarms do
            # not make every UI refresh scan an unbounded history.
            findings = sum(1 for event in load_events(self.project_root, limit=200) if event.get("agent_id") == record.agent_id and event.get("type") == "finding_logged")
            promotions = sum(1 for event in load_events(self.project_root, limit=200) if event.get("agent_id") == record.agent_id and event.get("type") == "promotion")
            table.add_row(
                record.agent_id,
                record.agent_type,
                record.state,
                record.last_heartbeat or "-",
                str(findings),
                str(promotions),
                record.last_sync_result or "-",
                sparkline(samples[-20:]),
                key=record.agent_id,
            )
        if records:
            self.update_detail(records[0].agent_id if not table.cursor_coordinate else list(self.agent_rows.keys())[table.cursor_row])

        # Refresh the recent event log pane.
        events_widget = self.query_one("#events", RichLog)
        events_widget.clear()
        for event in load_events(self.project_root, limit=40):
            timestamp = event.get("timestamp", "")
            kind = event.get("type", "")
            agent_id = event.get("agent_id", "-")
            status = event.get("status") or event.get("message") or event.get("summary") or ""
            events_widget.write(f"{timestamp}  {kind}  {agent_id}  {status}".strip())

    def update_detail(self, agent_id: str) -> None:
        """Render the detail pane for one selected agent.

        Args:
            agent_id: Selected agent identifier.
        """
        detail = self.query_one("#detail", Static)
        record = self.agent_rows.get(agent_id)
        if not record:
            detail.update("No agent selected.")
            return

        # Start with the always-present identity and branch details.
        lines = [
            f"Agent: {record.agent_id}",
            f"Branch: {record.branch}",
        ]
        if record.starting_direction:
            lines.append(f"Starting direction: {record.starting_direction}")

        # Add sandbox attachment details next.
        lines.extend(
            [
                f"Sandbox: {record.sandbox_path_or_id}",
                f"Attach: {' '.join(record.attach_cmd) if record.attach_cmd else '-'}",
            ]
        )

        # Append any optional error or workspace metadata.
        if record.last_error:
            lines.append(f"Error: {record.last_error}")
        if record.conflict_path:
            lines.append(f"Conflict: {record.conflict_path}")
        if record.workspace_url:
            lines.append(f"Workspace: {record.workspace_url}")
        detail.update("\n".join(lines))


def run_monitor(project_root: Path) -> None:
    """Launch the Textual monitor for a project.

    Args:
        project_root: Repository root to monitor.
    """
    RevisMonitor(project_root).run()
