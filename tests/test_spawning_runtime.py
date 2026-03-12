"""Tests for spawn planning and runtime persistence."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from revis.coordination.runtime import load_all_agent_records, load_events, load_registry
from revis.coordination.spawning import plan_agent_spawns, spawn_planned_agents
from revis.core.models import AgentState, AgentType, SandboxHandle, SandboxProvider

from tests.helpers import FakeProvider, bootstrap_local_project, make_agent_record


def test_plan_agent_spawns_uses_next_available_suffix() -> None:
    """Agent IDs should continue from the highest existing suffix."""

    existing = [
        make_agent_record(agent_id="codex-1"),
        make_agent_record(agent_id="codex-3"),
    ]

    planned = plan_agent_spawns(existing, Counter({AgentType.CODEX: 2}))

    assert [item.agent_id for item in planned] == ["codex-4", "codex-5"]
    assert [item.branch for item in planned] == ["revis/codex-4/work", "revis/codex-5/work"]


def test_spawn_planned_agents_persists_runtime_and_events(tmp_path: Path) -> None:
    """Successful spawns should write runtime records and start events."""

    root = tmp_path / "project"
    config, _ = bootstrap_local_project(root)
    provider = FakeProvider(
        spawn_handle=SandboxHandle(
            agent_id="codex-1",
            agent_type=AgentType.CODEX,
            root=root / ".revis" / "agents" / "codex-1" / "repo",
            branch="revis/codex-1/work",
            attach_cmd=["tmux", "attach", "-t", "revis-codex-1"],
            attach_label="revis-codex-1",
        )
    )

    planned = plan_agent_spawns([], Counter({AgentType.CODEX: 1}))
    spawned = spawn_planned_agents(
        root,
        config=config,
        provider=provider,
        objective_text="Test objective",
        planned_agents=planned,
        starting_directions={"codex-1": "investigate the regression"},
        resume=False,
    )

    records = load_all_agent_records(root)
    events = load_events(root)
    registry = load_registry(root)

    assert len(spawned) == 1
    assert registry is not None
    assert records[0].state == AgentState.ACTIVE
    assert records[0].attach_label == "revis-codex-1"
    assert records[0].starting_direction == "investigate the regression"
    assert events[-1]["type"] == "agent_started"


def test_spawn_planned_agents_records_failure_before_reraising(tmp_path: Path) -> None:
    """Spawn failures should be persisted onto the runtime record."""

    root = tmp_path / "project"
    config, _ = bootstrap_local_project(root)
    provider = FakeProvider(spawn_error=RuntimeError("spawn failed"))
    planned = plan_agent_spawns([], Counter({AgentType.CODEX: 1}))

    with pytest.raises(RuntimeError, match="spawn failed"):
        spawn_planned_agents(
            root,
            config=config,
            provider=provider,
            objective_text="Test objective",
            planned_agents=planned,
            starting_directions={},
            resume=False,
        )

    records = load_all_agent_records(root)
    assert records[0].state == AgentState.FAILED
    assert records[0].last_error == "spawn failed"
