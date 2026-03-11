"""Typer CLI entrypoints for initializing, running, and monitoring Revis."""

from __future__ import annotations

import os
import re
import uuid
from collections import Counter
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from revis import __version__
from revis.core.config import CONFIG_PATH, default_codex_template, load_config, save_config
from revis.agent.credentials import ensure_agent_cli_ready
from revis.coordination.daemon import conflict_path, run_daemon_loop
from revis.coordination.findings import filter_findings, render_findings
from revis.coordination.git import (
    FINDINGS_BRANCH,
    TRUNK_BRANCH,
    bootstrap_remote,
    current_branch,
    is_git_repo,
    promote_branch,
    read_findings,
    resolve_repo_root,
    trunk_head,
    try_sync_branch,
    working_tree_dirty,
    write_findings_entry,
)
from revis.agent.instructions import revis_ignore_patterns
from revis.core.models import (
    AgentRuntimeRecord,
    AgentState,
    AgentType,
    MonitorConfig,
    ObjectiveConfig,
    RetentionConfig,
    RevisConfig,
    RuntimeRegistry,
    SandboxProvider,
)
from revis.cli.monitor import run_monitor
from revis.coordination.runtime import (
    append_event,
    append_metric,
    load_agent_record,
    load_all_agent_records,
    load_registry,
    write_agent_record,
    write_registry,
)
from revis.sandbox import get_provider
from revis.coordination.sandbox_meta import load_sandbox_meta
from revis.core.util import RevisError, iso_now, sha256_text


app = typer.Typer(add_completion=False, no_args_is_help=True)
console = Console()


@app.callback()
def main() -> None:
    """Revis: multi-agent research coordination CLI."""


@app.command()
def version() -> None:
    """Print the installed Revis version."""
    console.print(__version__)


@app.command()
def init() -> None:
    """Interactively initialize Revis in the current repository."""
    root = Path.cwd()
    if not is_git_repo(root):
        raise typer.BadParameter("revis init must run inside an existing git repository")
    root = resolve_repo_root(root)
    provider = prompt_provider()
    console.print("Supported coding agents: codex")
    console.print("Default coding agent: codex")
    objective_value = typer.prompt("Research objective (inline text or path to a markdown file)").strip()
    daemon_interval = typer.prompt("Daemon interval in minutes", default="15").strip()
    objective = parse_objective(root, objective_value)
    branch = current_branch(root)
    remote_name = determine_remote_name(root, provider)
    if provider == SandboxProvider.LOCAL:
        console.print("[yellow]Local mode creates one full clone per agent and launches agents with full permissions inside those clones.[/yellow]")
    else:
        validate_daytona_support()
        console.print(
            "[yellow]Daytona mode keeps sandboxes isolated, but agent and git credentials must be provided at spawn time via environment variables. "
            "Revis does not store those secrets in config.[/yellow]"
        )
    validate_agent_launch(AgentType.CODEX, provider, require_daytona_credentials=False)
    if working_tree_dirty(root):
        console.print("[yellow]Warning:[/yellow] spawn uses committed git state. Uncommitted project changes will not be present in sandboxes.")

    config = RevisConfig(
        provider=provider,
        default_agent=AgentType.CODEX,
        codex_template=default_codex_template(),
        coordination_remote=remote_name,
        trunk_base=branch,
        daemon_interval_minutes=int(daemon_interval),
        objective=objective,
        retention=RetentionConfig(),
        monitor=MonitorConfig(),
    )
    save_config(root, config)
    ensure_gitignore(root)
    target_url = configure_coordination_remote(root, provider, remote_name)
    bootstrap_remote(root, remote_name=remote_name, target_url=target_url, trunk_base_branch=branch)
    console.print(f"Initialized Revis in {root}")
    console.print(f"Provider: {provider.value}")
    console.print(f"Default agent: {AgentType.CODEX.value}")
    console.print(f"Coordination remote: {remote_name}")


@app.command()
def spawn(
    codex: int = typer.Option(0, "--codex"),
    n: int = typer.Option(0, "--n"),
    resume: bool = typer.Option(False, "--resume"),
) -> None:
    """Spawn one or more Codex agents using the configured sandbox provider.

    Args:
        codex: Number of explicit Codex agents to spawn.
        n: Number of default-agent spawns to add.
        resume: Whether this spawn should resume prior work.
    """
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    objective_text = load_objective_text(root, config)
    provider = get_provider(root, config)
    counts = Counter()
    counts[AgentType.CODEX] += codex
    if n:
        counts[config.default_agent] += n
    total = sum(counts.values())
    if total <= 0:
        raise typer.BadParameter("Pass --codex or --n")
    for agent_type, count in counts.items():
        if count <= 0:
            continue
        validate_agent_launch(agent_type, config.provider, config=config, require_daytona_credentials=True)
    registry = load_registry(root)
    if registry is None:
        registry = RuntimeRegistry(
            swarm_id=uuid.uuid4().hex[:12],
            provider=config.provider,
            started_at=iso_now(),
            objective_hash=sha256_text(objective_text),
            trunk_branch=TRUNK_BRANCH,
            findings_branch=FINDINGS_BRANCH,
            config_path=str(root / CONFIG_PATH),
        )
        write_registry(root, registry)
    existing = load_all_agent_records(root)
    next_numbers = next_agent_numbers(existing)
    spawned: list[AgentRuntimeRecord] = []
    for agent_type, count in counts.items():
        for _ in range(count):
            number = next_numbers[agent_type]
            next_numbers[agent_type] += 1
            agent_id = f"codex-{number}"
            branch = f"revis/{agent_id}/work"
            record = AgentRuntimeRecord(
                agent_id=agent_id,
                agent_type=agent_type,
                provider=config.provider,
                state=AgentState.STARTING,
                branch=branch,
                started_at=iso_now(),
                sandbox_path_or_id="",
            )
            write_agent_record(root, record)
            try:
                handle = provider.spawn(agent_id=agent_id, agent_type=agent_type, objective_text=objective_text, resume=resume)
            except Exception as exc:
                record.state = AgentState.FAILED
                record.last_error = str(exc)
                write_agent_record(root, record)
                raise
            record.state = AgentState.ACTIVE
            record.sandbox_path_or_id = handle.provider_id or str(handle.root)
            record.attach_cmd = handle.attach_cmd
            record.attach_label = handle.attach_label
            record.worktree_path = str(handle.root) if config.provider == SandboxProvider.LOCAL else None
            record.tmux_session = handle.attach_label if config.provider == SandboxProvider.LOCAL else None
            record.workspace_name = handle.attach_label if config.provider == SandboxProvider.DAYTONA else None
            record.workspace_url = handle.workspace_url
            write_agent_record(root, record)
            append_event(
                root,
                {
                    "timestamp": iso_now(),
                    "type": "agent_started",
                    "agent_id": agent_id,
                    "summary": handle.attach_label,
                },
                retention_entries=config.retention.max_event_entries,
                retention_bytes=config.retention.max_event_bytes,
                retention_archives=config.retention.max_event_archives,
            )
            spawned.append(record)
    table = Table(title="Spawned Agents")
    table.add_column("Agent")
    table.add_column("Type")
    table.add_column("Attach")
    for record in spawned:
        table.add_row(record.agent_id, record.agent_type.value, " ".join(record.attach_cmd))
    console.print(table)


@app.command()
def log(
    message: str,
    kind: str = typer.Option("result", "--kind"),
    source: str | None = typer.Option(None, "--source"),
    title: str | None = typer.Option(None, "--title"),
    url: str | None = typer.Option(None, "--url"),
) -> None:
    """Append one finding to the shared findings ledger.

    Args:
        message: Finding body markdown.
        kind: Finding kind to store in frontmatter.
        source: Optional source identifier.
        title: Optional title or summary line.
        url: Optional supporting URL.
    """
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    meta = load_sandbox_meta(root)
    write_findings_entry(
        root,
        remote_name=config.coordination_remote,
        agent_id=meta["agent_id"],
        message=message,
        kind=kind,
        source=source,
        title=title,
        url=url,
    )
    update_root_runtime_from_env(
        config=config,
        agent_id=meta["agent_id"],
        event_type="finding_logged",
        summary=message.splitlines()[0],
    )
    console.print("Logged finding.")


@app.command()
def findings(
    since: str | None = typer.Option(None, "--since"),
    agent: str | None = typer.Option(None, "--agent"),
    last: int | None = typer.Option(None, "--last"),
    kind: str | None = typer.Option(None, "--kind"),
    source: str | None = typer.Option(None, "--source"),
) -> None:
    """Print findings from the shared ledger with optional filters.

    Args:
        since: Optional ISO or relative cutoff expression.
        agent: Optional exact agent ID or prefix glob.
        last: Optional maximum number of newest findings to show.
        kind: Optional finding kind filter.
        source: Optional source identifier filter.
    """
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    entries = read_findings(root, remote_name=config.coordination_remote)
    filtered = filter_findings(entries, since=since, agent=agent, last=last, kind=kind, source=source)
    console.print(render_findings(filtered))


@app.command()
def sync() -> None:
    """Manually rebase the current sandbox branch onto the shared trunk."""
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    ok, result = try_sync_branch(
        root,
        remote_name=config.coordination_remote,
        branch=TRUNK_BRANCH,
        conflict_path=conflict_path(root),
    )
    if ok:
        console.print("Synced with trunk.")
        return
    if result == "conflict":
        raise typer.Exit(code=1)
    console.print("Skipped sync because the worktree is dirty.")


@app.command()
def promote() -> None:
    """Merge the current sandbox branch into the shared trunk."""
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    meta = load_sandbox_meta(root)
    summary = promote_branch(root, remote_name=config.coordination_remote, current_branch_name=current_branch(root))
    write_findings_entry(
        root,
        remote_name=config.coordination_remote,
        agent_id=meta["agent_id"],
        message=f"Promoted: {summary}",
        kind="promotion",
        source=None,
        title=summary,
        url=None,
    )
    update_root_runtime_from_env(
        config=config,
        agent_id=meta["agent_id"],
        event_type="promotion",
        summary=summary,
    )
    console.print(f"Promoted: {summary}")


@app.command()
def status() -> None:
    """Show a Rich snapshot of swarm, findings, and daemon state."""
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    refresh_runtime(root, config)
    records = load_all_agent_records(root)
    entries = read_findings(root, remote_name=config.coordination_remote)
    by_type = Counter(record.agent_type.value for record in records)
    active = sum(1 for record in records if record.state == AgentState.ACTIVE)
    promotions = sum(1 for entry in entries if entry.kind == "promotion")
    sha, subject = trunk_head(root, remote_name=config.coordination_remote)
    table = Table(title="Revis Status")
    table.add_column("Metric")
    table.add_column("Value")
    table.add_row("Agents", ", ".join(f"{count} {name}" for name, count in sorted(by_type.items())) or "0")
    table.add_row("Active", str(active))
    table.add_row("Findings", str(len(entries)))
    table.add_row("Promotions", str(promotions))
    table.add_row("Trunk", f"{sha[:8]} {subject}")
    console.print(table)
    agent_table = Table(title="Agents")
    agent_table.add_column("Agent")
    agent_table.add_column("State")
    agent_table.add_column("Last heartbeat")
    agent_table.add_column("Last sync")
    agent_table.add_column("Attach")
    for record in records:
        agent_table.add_row(
            record.agent_id,
            record.state.value,
            record.last_heartbeat or "-",
            record.last_sync_result or "-",
            " ".join(record.attach_cmd) if record.attach_cmd else "-",
        )
    console.print(agent_table)


@app.command()
def monitor() -> None:
    """Open the live Textual monitor for the current project."""
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    refresh_runtime(root, config)
    run_monitor(root)


@app.command()
def stop(force: bool = typer.Option(False, "--force")) -> None:
    """Stop every known agent sandbox for the current project.

    Args:
        force: Whether to force immediate teardown instead of graceful stop.
    """
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    provider = get_provider(root, config)
    records = load_all_agent_records(root)
    for record in records:
        record.state = AgentState.STOPPING
        write_agent_record(root, record)
        stopped = provider.stop(record, force=force)
        stopped.state = AgentState.STOPPED
        write_agent_record(root, stopped)
        append_event(
            root,
            {
                "timestamp": iso_now(),
                "type": "agent_stopped",
                "agent_id": record.agent_id,
                "summary": "force" if force else "graceful",
            },
            retention_entries=config.retention.max_event_entries,
            retention_bytes=config.retention.max_event_bytes,
            retention_archives=config.retention.max_event_archives,
        )
    console.print("Stopped all agents.")


@app.command(hidden=True, name="_daemon-run")
def daemon_run() -> None:
    """Run the background daemon loop inside a sandbox."""
    run_daemon_loop(resolve_repo_root(Path.cwd()))


def prompt_provider() -> SandboxProvider:
    """Prompt for the sandbox provider during interactive init.

    Returns:
        SandboxProvider: Selected sandbox provider enum value.

    Raises:
        typer.BadParameter: If the user enters an unsupported provider.
    """
    value = typer.prompt("Sandbox provider [local/daytona]", default="local").strip().lower()
    if value not in {"local", "daytona"}:
        raise typer.BadParameter("provider must be local or daytona")
    return SandboxProvider(value)


def parse_objective(root: Path, value: str) -> ObjectiveConfig:
    """Interpret objective input as inline text or a repo-relative file path.

    Args:
        root: Repository root.
        value: User-provided objective input.

    Returns:
        ObjectiveConfig: Parsed objective configuration.
    """
    candidate = Path(value)
    resolved = candidate if candidate.is_absolute() else (root / candidate)
    if resolved.exists():
        return ObjectiveConfig(file=str(resolved.relative_to(root)))
    return ObjectiveConfig(text=value)


def load_objective_text(root: Path, config: RevisConfig) -> str:
    """Load the effective objective text from config.

    Args:
        root: Repository root.
        config: Loaded project configuration.

    Returns:
        str: Effective objective text.

    Raises:
        RevisError: If the config does not contain an objective.
    """
    if config.objective.text:
        return config.objective.text
    if config.objective.file:
        return (root / config.objective.file).read_text()
    raise RevisError("Objective is missing from config")


def determine_remote_name(root: Path, provider: SandboxProvider) -> str:
    """Choose the coordination remote name for the selected provider.

    Args:
        root: Repository root.
        provider: Selected sandbox provider.

    Returns:
        str: Coordination remote name.

    Raises:
        RevisError: If Daytona mode cannot determine a usable user-owned remote.
    """
    if provider == SandboxProvider.LOCAL:
        return "revis-local"
    remotes = run_git(root, ["remote"]).splitlines()
    if "origin" in remotes:
        return "origin"
    if len(remotes) == 1:
        return remotes[0]
    raise RevisError("Daytona mode requires a configured git remote such as origin")


def configure_coordination_remote(root: Path, provider: SandboxProvider, remote_name: str) -> str:
    """Resolve or create the coordination remote target URL/path.

    Args:
        root: Repository root.
        provider: Selected sandbox provider.
        remote_name: Coordination remote name.

    Returns:
        str: Coordination remote URL or local bare path.
    """
    if provider == SandboxProvider.LOCAL:
        from revis.coordination.git import ensure_coordination_remote

        return str(ensure_coordination_remote(root))
    from revis.coordination.git import remote_url

    return remote_url(root, remote_name)


def ensure_gitignore(root: Path) -> None:
    """Append Revis runtime paths to `.gitignore` when missing.

    Args:
        root: Repository root.
    """
    path = root / ".gitignore"
    existing = path.read_text() if path.exists() else ""
    lines = [
        "# Revis runtime state stays untracked because it is ephemeral local monitor data.",
        ".revis/runtime/",
        "# Local sandboxes are disposable working clones, not part of the source tree.",
        ".revis/agents/",
        "# The local coordination remote is an implementation detail for local-mode swarms.",
        ".revis/coordination.git/",
    ]
    with path.open("a", encoding="utf-8") as handle:
        for line in lines:
            if line not in existing:
                handle.write(f"{line}\n")


def validate_daytona_support() -> None:
    """Fail fast when the Daytona SDK is not configured for use.

    Raises:
        RevisError: If the Daytona SDK cannot create a client with local
            credentials and configuration.
    """
    from daytona import Daytona

    try:
        Daytona()
    except Exception as exc:
        raise RevisError(f"Daytona is not ready: {exc}") from exc


def next_agent_numbers(records: list[AgentRuntimeRecord]) -> dict[AgentType, int]:
    """Compute the next numeric suffix to use for each agent type.

    Args:
        records: Existing runtime records.

    Returns:
        dict[AgentType, int]: Next number to allocate per agent type.
    """
    numbers = {AgentType.CODEX: 1}
    pattern = re.compile(r"^codex-(\d+)$")
    for record in records:
        match = pattern.match(record.agent_id)
        if not match:
            continue
        raw_number = match.group(1)
        numbers[AgentType.CODEX] = max(numbers[AgentType.CODEX], int(raw_number) + 1)
    return numbers


def refresh_runtime(root: Path, config: RevisConfig) -> None:
    """Refresh persisted runtime records by probing live provider state.

    Args:
        root: Repository root.
        config: Loaded project configuration.
    """
    provider = get_provider(root, config)
    for record in load_all_agent_records(root):
        try:
            updated = provider.probe(record)
        except Exception as exc:
            record.last_error = str(exc)
            updated = record
        write_agent_record(root, updated)


def update_root_runtime_from_env(*, config: RevisConfig, agent_id: str, event_type: str, summary: str) -> None:
    """Write runtime updates back to the project root from inside a sandbox.

    Args:
        config: Loaded project configuration.
        agent_id: Agent identifier emitting the event.
        event_type: Runtime event type.
        summary: Short event summary.
    """
    project_root = os.environ.get("REVIS_PROJECT_ROOT")
    if not project_root:
        return
    root = Path(project_root)
    record = load_agent_record(root, agent_id)
    if not record:
        return
    timestamp = iso_now()
    if event_type == "finding_logged":
        record.last_finding_at = timestamp
    if event_type == "promotion":
        record.last_promotion_at = timestamp
    write_agent_record(root, record)
    append_event(
        root,
        {
            "timestamp": timestamp,
            "type": event_type,
            "agent_id": agent_id,
            "summary": summary,
        },
        retention_entries=config.retention.max_event_entries,
        retention_bytes=config.retention.max_event_bytes,
        retention_archives=config.retention.max_event_archives,
    )
    append_metric(
        root,
        agent_id,
        {"timestamp": timestamp, "event_type": event_type},
        max_points=config.retention.max_metric_points,
    )


def run_git(root: Path, argv: list[str]) -> str:
    """Run a git command in a repository and return stdout.

    Args:
        root: Repository root.
        argv: Git argv excluding the `git` executable itself.

    Returns:
        str: Command stdout.
    """
    from revis.core.util import run

    return run(["git", *argv], cwd=root).stdout


def validate_agent_launch(
    agent_type: AgentType,
    provider: SandboxProvider,
    *,
    config: RevisConfig | None = None,
    require_daytona_credentials: bool,
) -> None:
    """Validate that the configured agent launcher is usable on this machine.

    Args:
        agent_type: Agent type to validate.
        provider: Sandbox provider the agent will run under.
        config: Optional loaded project configuration.
        require_daytona_credentials: Whether provider-specific remote checks
            should be enforced.
    """
    template = config.codex_template if config else default_codex_template()
    ensure_agent_cli_ready(
        agent_type=agent_type,
        provider=provider,
        argv=template.argv,
        require_daytona_credentials=require_daytona_credentials,
    )
