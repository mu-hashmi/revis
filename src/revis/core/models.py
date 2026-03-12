"""Shared enums and dataclasses used across the Revis package."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path


class SandboxProvider(StrEnum):
    """Supported sandbox backends for agent execution.

    Attributes:
        LOCAL: Runs agents in local disposable clones managed by tmux.
        DAYTONA: Runs agents in Daytona-hosted remote sandboxes.
    """

    LOCAL = "local"
    DAYTONA = "daytona"


class AgentType(StrEnum):
    """Supported coding agent families.

    Attributes:
        CODEX: OpenAI Codex CLI sessions.
    """

    CODEX = "codex"


class AgentState(StrEnum):
    """Lifecycle states tracked for spawned agents.

    Attributes:
        STARTING: Sandbox has been requested but is not fully ready.
        ACTIVE: Agent session is running normally.
        STOPPING: A stop request is in progress.
        STOPPED: Sandbox has been torn down.
        FAILED: Spawn or health checks reported a hard failure.
    """

    STARTING = "starting"
    ACTIVE = "active"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


class FindingKind(StrEnum):
    """Common finding categories used in the shared ledger.

    Attributes:
        RESULT: Routine experiment outcome.
        CLAIM: Advisory claim on a source or direction.
        LITERATURE: Summary derived from a paper or external source.
        PROMOTION: Record of a local trunk merge or remote PR promotion.
        WARNING: Cautionary note for other agents.
    """

    RESULT = "result"
    CLAIM = "claim"
    LITERATURE = "literature"
    PROMOTION = "promotion"
    WARNING = "warning"


@dataclass(slots=True)
class ObjectiveConfig:
    """Configures how the research objective is stored.

    Attributes:
        text: Inline objective text stored directly in config.
        file: Repo-relative path to a markdown file containing the objective.
    """

    text: str | None = None
    file: str | None = None


@dataclass(slots=True)
class RetentionConfig:
    """Bounds local runtime files used by status and monitor views.

    Attributes:
        max_event_entries: Number of live event entries to keep before rotation.
        max_event_bytes: Maximum size of the live event log before rotation.
        max_event_archives: Number of archived event files to retain.
        max_metric_points: Number of per-agent metric samples to retain.
    """

    max_event_entries: int = 500
    max_event_bytes: int = 512_000
    max_event_archives: int = 3
    max_metric_points: int = 120


@dataclass(slots=True)
class MonitorConfig:
    """Controls polling cadence for the monitor UI.

    Attributes:
        refresh_seconds: How often the UI refreshes from runtime files.
        health_probe_seconds: How often provider health probes run.
    """

    refresh_seconds: float = 1.0
    health_probe_seconds: float = 5.0


@dataclass(slots=True)
class AgentTemplate:
    """Stores the argv template used to launch an agent CLI.

    Attributes:
        argv: Command template with placeholders such as `{prompt}`.
    """

    argv: list[str]


@dataclass(slots=True)
class RevisConfig:
    """Top-level persisted project configuration for Revis.

    Attributes:
        provider: Selected sandbox provider.
        default_agent: Default agent type used by `revis spawn --n`.
        codex_template: Launch template for Codex sessions.
        coordination_remote: Git remote used for findings, sync, and promotion.
        trunk_base: User branch used as the sync and PR target when coordination
            runs against a real git remote.
        daemon_interval_minutes: Background sync cadence.
        objective: Objective source configuration.
        retention: Retention settings for local runtime artifacts.
        monitor: Polling settings for the monitor UI.
    """

    provider: SandboxProvider
    default_agent: AgentType
    codex_template: AgentTemplate
    coordination_remote: str
    trunk_base: str
    daemon_interval_minutes: int
    objective: ObjectiveConfig
    retention: RetentionConfig = field(default_factory=RetentionConfig)
    monitor: MonitorConfig = field(default_factory=MonitorConfig)


@dataclass(slots=True)
class AgentRuntimeRecord:
    """Persists provider and activity state for a single spawned agent.

    Attributes:
        agent_id: Stable Revis agent identifier.
        agent_type: Agent family used for the sandbox.
        provider: Sandbox provider that owns the sandbox.
        state: Current lifecycle state.
        branch: Agent work branch name.
        started_at: ISO-8601 timestamp when the agent was created.
        sandbox_path_or_id: Local path or provider-specific sandbox identifier.
        last_heartbeat: Latest daemon heartbeat timestamp.
        last_sync_at: Latest daemon sync timestamp.
        last_sync_result: Summary of the latest sync attempt.
        last_finding_at: Timestamp of the latest logged finding.
        last_promotion_at: Timestamp of the latest promotion.
        last_error: Most recent provider or daemon error.
        conflict_path: Path to a surfaced sync-conflict file, if any.
        attach_cmd: Command used by the monitor to attach to the session.
        attach_label: Human-facing attach label such as a tmux session name.
        starting_direction: Optional seeded starting direction collected at spawn.
        worktree_path: Local sandbox repo path when applicable.
        tmux_session: Tmux session name for local sandboxes.
        daemon_pid: Local daemon PID when tracked.
        workspace_name: Provider-facing workspace name.
        workspace_url: Provider dashboard URL.
    """

    agent_id: str
    agent_type: AgentType
    provider: SandboxProvider
    state: AgentState
    branch: str
    started_at: str
    sandbox_path_or_id: str
    last_heartbeat: str | None = None
    last_sync_at: str | None = None
    last_sync_result: str | None = None
    last_finding_at: str | None = None
    last_promotion_at: str | None = None
    last_error: str | None = None
    conflict_path: str | None = None
    attach_cmd: list[str] = field(default_factory=list)
    attach_label: str | None = None
    starting_direction: str | None = None
    worktree_path: str | None = None
    tmux_session: str | None = None
    daemon_pid: int | None = None
    workspace_name: str | None = None
    workspace_url: str | None = None


@dataclass(slots=True)
class RuntimeRegistry:
    """Persists swarm-level runtime metadata for monitor and status views.

    Attributes:
        swarm_id: Stable swarm identifier for the current project run.
        provider: Sandbox provider used by the swarm.
        started_at: ISO-8601 timestamp when runtime tracking began.
        objective_hash: Hash of the effective objective text.
        trunk_branch: Active sync target branch for the current provider.
        findings_branch: Shared findings branch name.
        config_path: Absolute path to the project config file.
    """

    swarm_id: str
    provider: SandboxProvider
    started_at: str
    objective_hash: str
    trunk_branch: str
    findings_branch: str
    config_path: str


@dataclass(slots=True)
class FindingEntry:
    """Represents one parsed finding from the ledger branch.

    Attributes:
        path: Repository path of the markdown finding file.
        agent: Agent identifier that wrote the finding.
        timestamp: ISO-8601 timestamp from finding frontmatter.
        body: Free-form markdown body.
        kind: Optional finding category.
        source: Optional source or paper identifier.
        title: Optional title or summary line.
        url: Optional supporting URL.
    """

    path: str
    agent: str
    timestamp: str
    body: str
    kind: str | None = None
    source: str | None = None
    title: str | None = None
    url: str | None = None


@dataclass(slots=True)
class InitChoices:
    """Captures interactive answers gathered during `revis init`.

    Attributes:
        provider: Selected sandbox provider.
        default_agent: Selected default agent type.
        objective_text: Inline objective text, if provided.
        objective_file: Objective file path, if provided.
        daemon_interval_minutes: Selected daemon interval.
    """

    provider: SandboxProvider
    default_agent: AgentType
    objective_text: str | None
    objective_file: str | None
    daemon_interval_minutes: int


@dataclass(slots=True)
class SpawnRequest:
    """Describes a spawn request before it is expanded into agent IDs.

    Attributes:
        codex_count: Number of explicit Codex agents requested.
        default_count: Number of default-agent spawns requested.
        resume: Whether this spawn is resuming previous work.
    """

    codex_count: int = 0
    default_count: int = 0
    resume: bool = False


@dataclass(slots=True)
class SandboxHandle:
    """Returns the provider-specific handle for a spawned sandbox.

    Attributes:
        agent_id: Stable Revis agent identifier.
        agent_type: Agent type running in the sandbox.
        root: Sandbox repo root path as seen from the provider context.
        branch: Checked-out work branch inside the sandbox.
        attach_cmd: Command used to attach interactively to the session.
        attach_label: Human-facing attach label.
        provider_id: Provider-specific sandbox identifier.
        workspace_url: Optional provider dashboard URL.
    """

    agent_id: str
    agent_type: AgentType
    root: Path
    branch: str
    attach_cmd: list[str]
    attach_label: str
    provider_id: str | None = None
    workspace_url: str | None = None
