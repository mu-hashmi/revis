"""CLI tests for operator-facing commands."""

from __future__ import annotations

from pathlib import Path

from revis.cli.main import app
from revis.coordination.ledger import write_findings_entry
from revis.core.models import AgentState

from tests.helpers import (
    FakeProvider,
    bootstrap_local_project,
    make_agent_record,
    write_runtime_state,
)


def test_findings_command_filters_entries(tmp_path: Path, runner, monkeypatch) -> None:
    """`revis findings` should honor basic agent and kind filters."""

    root = tmp_path / "project"
    _, _ = bootstrap_local_project(root)
    write_findings_entry(
        root,
        remote_name="revis-local",
        agent_id="codex-1",
        message="first finding",
        kind="result",
        source=None,
        title="First",
        url=None,
    )
    write_findings_entry(
        root,
        remote_name="revis-local",
        agent_id="codex-2",
        message="second finding",
        kind="warning",
        source=None,
        title="Second",
        url=None,
    )

    monkeypatch.chdir(root)
    result = runner.invoke(app, ["findings", "--agent", "codex-1", "--kind", "result"])

    assert result.exit_code == 0, result.output
    assert "first finding" in result.output
    assert "second finding" not in result.output


def test_status_command_renders_swarm_summary(tmp_path: Path, runner, monkeypatch) -> None:
    """`revis status` should render runtime state and finding counts."""

    root = tmp_path / "project"
    config, _ = bootstrap_local_project(root)

    write_findings_entry(
        root,
        remote_name="revis-local",
        agent_id="codex-1",
        message="useful result",
        kind="result",
        source=None,
        title="Useful",
        url=None,
    )

    record = make_agent_record(
        sandbox_path_or_id=str(root / ".revis" / "agents" / "codex-1" / "repo"),
        attach_cmd=["tmux", "attach", "-t", "revis-codex-1"],
        attach_label="revis-codex-1",
    )
    write_runtime_state(root, config=config, record=record)

    provider = FakeProvider(probe_calls=[])
    monkeypatch.chdir(root)
    monkeypatch.setattr("revis.coordination.runtime_ops.get_provider", lambda *_args, **_kwargs: provider)

    result = runner.invoke(app, ["status"])

    assert result.exit_code == 0, result.output
    assert "Revis Status" in result.output
    assert "Findings" in result.output
    assert "codex-1" in result.output
    assert provider.probe_calls == ["codex-1"]


def test_stop_command_marks_agents_stopped_and_logs_events(tmp_path: Path, runner, monkeypatch) -> None:
    """`revis stop` should update runtime records and append stop events."""

    root = tmp_path / "project"
    config, _ = bootstrap_local_project(root)

    record = make_agent_record(
        sandbox_path_or_id=str(root / ".revis" / "agents" / "codex-1" / "repo"),
        attach_cmd=["tmux", "attach", "-t", "revis-codex-1"],
        attach_label="revis-codex-1",
    )
    write_runtime_state(root, config=config, record=record)

    provider = FakeProvider(stop_calls=[])
    monkeypatch.chdir(root)
    monkeypatch.setattr("revis.cli.main.get_provider", lambda *_args, **_kwargs: provider)

    result = runner.invoke(app, ["stop", "--force"])

    assert result.exit_code == 0, result.output
    assert "Stopped all agents." in result.output
    assert provider.stop_calls == [("codex-1", True)]
