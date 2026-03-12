"""Non-interactive agent spawning workflow."""

from __future__ import annotations

import uuid
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from revis.agent.instructions import render_objective_text
from revis.coordination.repo import FINDINGS_BRANCH
from revis.coordination.runtime import append_event, load_registry, write_agent_record, write_registry
from revis.coordination.sync import sync_target_branch
from revis.core.config import CONFIG_PATH
from revis.core.models import AgentRuntimeRecord, AgentState, AgentType, RevisConfig, RuntimeRegistry
from revis.core.util import iso_now, sha256_text
from revis.sandbox.base import SandboxProvider as SandboxBackend


@dataclass(slots=True)
class PlannedSpawn:
    """Captures the stable identifiers allocated for one future spawn."""

    agent_type: AgentType
    agent_id: str
    branch: str


def next_agent_numbers(records: list[AgentRuntimeRecord]) -> dict[AgentType, int]:
    """Compute the next numeric suffix to use for each agent type."""

    import re

    numbers = {AgentType.CODEX: 1}
    pattern = re.compile(r"^codex-(\d+)$")
    for record in records:
        match = pattern.match(record.agent_id)
        if not match:
            continue
        numbers[AgentType.CODEX] = max(numbers[AgentType.CODEX], int(match.group(1)) + 1)
    return numbers


def plan_agent_spawns(
    existing_records: list[AgentRuntimeRecord],
    counts: Counter[AgentType],
) -> list[PlannedSpawn]:
    """Allocate agent IDs and branch names for a spawn batch."""

    next_numbers = next_agent_numbers(existing_records)
    planned_agents: list[PlannedSpawn] = []

    # Allocate IDs up front so interactive seeded directions can target stable
    # agent/branch identities before any provider-side work starts.
    for agent_type, count in counts.items():
        for _ in range(count):
            number = next_numbers[agent_type]
            next_numbers[agent_type] += 1
            agent_id = f"{agent_type.value}-{number}"
            planned_agents.append(
                PlannedSpawn(
                    agent_type=agent_type,
                    agent_id=agent_id,
                    branch=f"revis/{agent_id}/work",
                )
            )
    return planned_agents


def spawn_planned_agents(
    root: Path,
    *,
    config: RevisConfig,
    provider: SandboxBackend,
    objective_text: str,
    planned_agents: list[PlannedSpawn],
    starting_directions: dict[str, str | None],
    resume: bool,
) -> list[AgentRuntimeRecord]:
    """Spawn a planned batch of agents and persist their runtime state."""

    _ensure_runtime_registry(root, config=config, objective_text=objective_text)

    spawned: list[AgentRuntimeRecord] = []

    # Spawn each agent and persist its runtime metadata as it comes online.
    for plan in planned_agents:
        starting_direction = starting_directions.get(plan.agent_id)
        effective_objective = render_objective_text(
            objective_text=objective_text,
            starting_direction=starting_direction,
        )

        # Write the starting record before launch so failed spawns still show up
        # in runtime history with the direction they attempted.
        record = AgentRuntimeRecord(
            agent_id=plan.agent_id,
            agent_type=plan.agent_type,
            provider=config.provider,
            state=AgentState.STARTING,
            branch=plan.branch,
            started_at=iso_now(),
            sandbox_path_or_id="",
            starting_direction=starting_direction,
        )
        write_agent_record(root, record)

        try:
            handle = provider.spawn(
                agent_id=plan.agent_id,
                agent_type=plan.agent_type,
                objective_text=effective_objective,
                protocol_objective_text=objective_text,
                resume=resume,
            )
        except Exception as exc:
            record.state = AgentState.FAILED
            record.last_error = str(exc)
            write_agent_record(root, record)
            raise

        # Persist the live attach metadata once the provider reports success.
        record.state = AgentState.ACTIVE
        record.sandbox_path_or_id = handle.provider_id or str(handle.root)
        record.attach_cmd = handle.attach_cmd
        record.attach_label = handle.attach_label
        record.worktree_path = (
            str(handle.root) if config.provider.value == "local" else None
        )
        record.tmux_session = (
            handle.attach_label if config.provider.value == "local" else None
        )
        record.workspace_name = (
            handle.attach_label if config.provider.value == "daytona" else None
        )
        record.workspace_url = handle.workspace_url
        write_agent_record(root, record)
        append_event(
            root,
            {
                "timestamp": iso_now(),
                "type": "agent_started",
                "agent_id": plan.agent_id,
                "summary": handle.attach_label,
            },
            retention_entries=config.retention.max_event_entries,
            retention_bytes=config.retention.max_event_bytes,
            retention_archives=config.retention.max_event_archives,
        )
        spawned.append(record)

    return spawned


def _ensure_runtime_registry(root: Path, *, config: RevisConfig, objective_text: str) -> None:
    """Create the swarm registry on the first spawn for a project."""

    if load_registry(root) is not None:
        return

    registry = RuntimeRegistry(
        swarm_id=uuid.uuid4().hex[:12],
        provider=config.provider,
        started_at=iso_now(),
        objective_hash=sha256_text(objective_text),
        trunk_branch=sync_target_branch(
            remote_name=config.coordination_remote,
            base_branch=config.trunk_base,
        ),
        findings_branch=FINDINGS_BRANCH,
        config_path=str(root / CONFIG_PATH),
    )
    write_registry(root, registry)
