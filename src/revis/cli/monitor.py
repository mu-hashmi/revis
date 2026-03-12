"""Textual monitor UI for live Revis swarm state and attach actions."""

from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.css.query import NoMatches
from textual.widgets import DataTable, Footer, Header, RichLog, Static

from revis.core.config import RevisConfig, load_config
from revis.core.models import AgentRuntimeRecord, RuntimeRegistry
from revis.coordination.runtime import (
    load_activity,
    load_all_agent_records,
    load_events,
    load_metrics,
    load_registry,
    write_activity_snapshot,
    write_agent_record,
)
from revis.sandbox import get_provider


# Unicode blocks used to render compact per-agent activity sparklines.
SPARK_CHARS = "▁▂▃▄▅▆▇█"
CODEX_FOOTER_RE = re.compile(r"^gpt-[^·]+·")
CODEX_PROMPT_RE = re.compile(r"^\s*›\s")


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
    return "".join(
        SPARK_CHARS[int((value - low) / (high - low) * scale)]
        for value in values
    )


def filter_activity_lines(lines: list[str]) -> list[str]:
    """Drop Codex footer/helper lines that don't add useful monitor signal."""

    filtered = [
        line for line in lines
        if not CODEX_PROMPT_RE.match(line) and not CODEX_FOOTER_RE.match(line)
    ]
    if not filtered:
        return lines
    return filtered


class RevisMonitor(App[None]):
    """Textual monitor for live Revis swarm state and attach actions.

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
        Binding("enter", "attach", "Attach selected agent", priority=True),
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
    #summary {
      width: 1fr;
      padding: 1 2;
      border: solid $panel;
    }
    #agents, #activity {
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
        self.agent_rows: dict[str, AgentRuntimeRecord] = {}
        self.last_probe_at = 0.0
        self.provider = None
        self.config: RevisConfig | None = None
        self.selected_agent_id: str | None = None

    def compose(self) -> ComposeResult:
        """Build the Textual widget tree.

        Returns:
            ComposeResult: Widgets composing the monitor screen.
        """
        yield Header()
        yield Static(id="summary")
        with Horizontal(id="bottom"):
            yield DataTable(id="agents")
            yield RichLog(id="activity", highlight=False, wrap=True, markup=False)
        yield Footer()

    def on_mount(self) -> None:
        """Load config/provider state and start periodic refreshes."""
        # Initialize the table schema and provider state once.
        table = self.query_one("#agents", DataTable)
        table.add_columns(
            "Agent",
            "Type",
            "State",
            "Heartbeat",
            "Findings",
            "Promotions",
            "Sync",
            "Activity",
        )
        table.cursor_type = "row"
        table.focus()
        self.config = load_config(self.project_root)
        self.provider = get_provider(self.project_root, self.config)
        self.refresh_view()
        self.set_interval(self.config.monitor.refresh_seconds, self.refresh_view)

    def action_refresh(self) -> None:
        """Refresh the monitor immediately."""
        self.refresh_view()

    def action_attach(self) -> None:
        """Suspend the TUI and attach to the selected agent session."""
        if self.selected_agent_id is None:
            return
        record = self.agent_rows.get(self.selected_agent_id)
        if record is None:
            return
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
            self.selected_agent_id = row_key
            registry = load_registry(self.project_root)
            if registry is not None:
                self.refresh_summary(registry)
            self.refresh_activity(row_key)

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Attach when the operator presses Enter on a table row.

        Args:
            event: Textual row-selected event emitted by DataTable.
        """
        row_key = str(event.row_key.value) if event.row_key is not None else None
        if row_key:
            self.selected_agent_id = row_key
            self.action_attach()

    def refresh_summary(self, registry: RuntimeRegistry) -> None:
        """Render the swarm summary block, including selected-agent details."""

        records = list(self.agent_rows.values())
        active = sum(
            1
            for record in records
            if getattr(record.state, "value", record.state) == "active"
        )
        lines = [
            f"Swarm: {registry.swarm_id}",
            f"Provider: {registry.provider}",
            f"Started: {registry.started_at}",
            f"Agents: {len(records)} total / {active} active",
        ]
        if self.selected_agent_id and self.selected_agent_id in self.agent_rows:
            record = self.agent_rows[self.selected_agent_id]
            lines.extend(
                [
                    "",
                    f"Selected: {record.agent_id}",
                    f"Branch: {record.branch}",
                ]
            )
            if record.starting_direction:
                lines.append(f"Direction: {record.starting_direction}")
            attach = " ".join(record.attach_cmd) if record.attach_cmd else "-"
            lines.append(f"Attach: {attach}")
            lines.append("Press Enter to attach to the selected agent session.")
        self.query_one("#summary", Static).update("\n".join(lines))

    def refresh_view(self) -> None:
        """Refresh provider health, the agent table, and activity snapshots."""
        if not self.screen_stack:
            return

        if (
            self.provider
            and self.config
            and time.time() - self.last_probe_at
            >= self.config.monitor.health_probe_seconds
        ):
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
        try:
            summary = self.query_one("#summary", Static)
            table = self.query_one("#agents", DataTable)
            activity_widget = self.query_one("#activity", RichLog)
        except NoMatches:
            # The refresh timer can tick while Textual is tearing the screen down.
            return
        if registry:
            self.refresh_summary(registry)
        else:
            summary.update("No runtime registry found.")

        # Rebuild the agent table from the latest metrics and events.
        selected_agent_id = self.selected_agent_id
        recent_events = load_events(self.project_root, limit=200)
        findings_by_agent = {record.agent_id: 0 for record in records}
        promotions_by_agent = {record.agent_id: 0 for record in records}
        for event in recent_events:
            agent_id = event.get("agent_id")
            if agent_id not in self.agent_rows:
                continue
            if event.get("type") == "finding_logged":
                findings_by_agent[agent_id] += 1
            if event.get("type") == "promotion":
                promotions_by_agent[agent_id] += 1
        table.clear(columns=False)
        for record in records:
            metrics = load_metrics(self.project_root, record.agent_id)
            samples = [1.0 if sample.get("sync_ok") else 0.0 for sample in metrics]
            table.add_row(
                record.agent_id,
                record.agent_type,
                record.state,
                record.last_heartbeat or "-",
                str(findings_by_agent[record.agent_id]),
                str(promotions_by_agent[record.agent_id]),
                record.last_sync_result or "-",
                sparkline(samples[-20:]),
                key=record.agent_id,
            )
        if not records:
            self.selected_agent_id = None
            activity_widget.clear()
            return

        if selected_agent_id not in self.agent_rows:
            selected_agent_id = records[0].agent_id
        self.selected_agent_id = selected_agent_id
        self.persist_activity_snapshot(selected_agent_id)
        selected_index = next(
            index
            for index, record in enumerate(records)
            if record.agent_id == selected_agent_id
        )
        table.move_cursor(row=selected_index, column=0, animate=False, scroll=False)
        self.refresh_activity(selected_agent_id)

    def persist_activity_snapshot(self, agent_id: str) -> None:
        """Capture and store the latest provider-backed activity snapshot."""

        if self.provider is None:
            return
        record = self.agent_rows.get(agent_id)
        if record is None:
            return
        try:
            lines = self.provider.capture_activity(record)
        except Exception as exc:
            lines = [f"Activity capture failed: {exc}"]
        write_activity_snapshot(self.project_root, agent_id, lines)

    def refresh_activity(self, agent_id: str) -> None:
        """Render live activity for the selected agent."""

        activity_widget = self.query_one("#activity", RichLog)
        activity_widget.clear()
        record = self.agent_rows.get(agent_id)
        if record is None:
            activity_widget.write("No agent selected.")
            return
        lines = load_activity(self.project_root, agent_id)
        if not lines:
            activity_widget.write("No runtime activity yet.")
            return
        for line in filter_activity_lines(lines):
            activity_widget.write(line)


def run_monitor(project_root: Path) -> None:
    """Launch the Textual monitor for a project.

    Args:
        project_root: Repository root to monitor.
    """
    RevisMonitor(project_root).run()
