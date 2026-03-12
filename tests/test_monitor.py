"""Tests for the Textual monitor UI."""

from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path

import pytest
from textual.widgets import DataTable, RichLog, Static

from revis.cli.monitor import RevisMonitor, sparkline
from revis.coordination.runtime import append_event, append_metric

from tests.helpers import FakeProvider, bootstrap_local_project, make_agent_record, write_runtime_state


def test_sparkline_handles_empty_and_constant_series() -> None:
    """Sparkline rendering should handle trivial numeric series."""

    assert sparkline([]) == ""
    assert sparkline([1.0, 1.0, 1.0]) == "▁▁▁"


@pytest.mark.asyncio
async def test_monitor_renders_runtime_rows_and_activity(tmp_path: Path, monkeypatch) -> None:
    """The monitor should render summary, rows, details, and activity."""

    root = tmp_path / "project"
    config, _ = bootstrap_local_project(root)
    record = make_agent_record(
        sandbox_path_or_id="sandbox-1",
        attach_cmd=["tmux", "attach", "-t", "revis-codex-1"],
        attach_label="revis-codex-1",
    )
    write_runtime_state(root, config=config, record=record)
    append_event(
        root,
        {
            "timestamp": "2026-03-12T00:00:00Z",
            "type": "finding_logged",
            "agent_id": "codex-1",
            "summary": "Logged",
        },
        retention_entries=config.retention.max_event_entries,
        retention_bytes=config.retention.max_event_bytes,
        retention_archives=config.retention.max_event_archives,
    )
    append_metric(
        root,
        "codex-1",
        {"timestamp": "2026-03-12T00:00:01Z", "sync_ok": True},
        max_points=config.retention.max_metric_points,
    )

    monkeypatch.setattr(
        "revis.cli.monitor.get_provider",
        lambda *_args, **_kwargs: FakeProvider(
            probe_calls=[],
            activity_lines=["agent line 1", "agent line 2"],
        ),
    )
    app = RevisMonitor(root)

    async with app.run_test() as pilot:
        await pilot.pause()

        summary = app.query_one("#summary", Static)
        table = app.query_one("#agents", DataTable)
        activity = app.query_one("#activity", RichLog)

        assert "Swarm: swarm-test" in str(summary.visual)
        assert table.row_count == 1
        assert "Selected: codex-1" in str(summary.visual)
        assert any("agent line 1" in str(line) for line in activity.lines)


@pytest.mark.asyncio
async def test_monitor_attach_runs_selected_command(tmp_path: Path, monkeypatch) -> None:
    """Pressing Enter should run the selected agent attach command."""

    root = tmp_path / "project"
    config, _ = bootstrap_local_project(root)
    record = make_agent_record(
        sandbox_path_or_id="sandbox-1",
        attach_cmd=["echo", "attach"],
        attach_label="sandbox-1",
    )
    write_runtime_state(root, config=config, record=record)

    calls: list[list[str]] = []

    def fake_run(argv: list[str], check: bool = False) -> None:
        del check
        calls.append(argv)

    monkeypatch.setattr(
        "revis.cli.monitor.get_provider",
        lambda *_args, **_kwargs: FakeProvider(probe_calls=[]),
    )
    monkeypatch.setattr("revis.cli.monitor.subprocess.run", fake_run)

    app = RevisMonitor(root)
    monkeypatch.setattr(app, "suspend", lambda: nullcontext())
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#agents", DataTable)
        table.move_cursor(row=0)
        app.action_attach()

    assert calls == [["echo", "attach"]]


@pytest.mark.asyncio
async def test_monitor_enter_key_attaches_selected_agent(tmp_path: Path, monkeypatch) -> None:
    """Pressing Enter in the table should attach to the selected agent."""

    root = tmp_path / "project"
    config, _ = bootstrap_local_project(root)
    record = make_agent_record(
        sandbox_path_or_id="sandbox-1",
        attach_cmd=["echo", "attach"],
        attach_label="sandbox-1",
    )
    write_runtime_state(root, config=config, record=record)

    calls: list[list[str]] = []

    def fake_run(argv: list[str], check: bool = False) -> None:
        del check
        calls.append(argv)

    monkeypatch.setattr(
        "revis.cli.monitor.get_provider",
        lambda *_args, **_kwargs: FakeProvider(
            probe_calls=[],
            activity_lines=["agent line 1"],
        ),
    )
    monkeypatch.setattr("revis.cli.monitor.subprocess.run", fake_run)

    app = RevisMonitor(root)
    monkeypatch.setattr(app, "suspend", lambda: nullcontext())
    async with app.run_test() as pilot:
        await pilot.pause()
        table = app.query_one("#agents", DataTable)
        table.focus()
        table.move_cursor(row=0)
        await pilot.press("enter")

    assert calls == [["echo", "attach"]]
