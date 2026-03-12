"""Typer CLI entrypoints for initializing, running, and monitoring Revis."""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path
from textwrap import shorten

import typer
from rich.console import Console
from rich.table import Table

from revis import __version__
from revis.agent.credentials import ensure_agent_cli_ready
from revis.cli.monitor import run_monitor
from revis.cli.spawn_seed import collect_starting_directions
from revis.coordination.bootstrap import bootstrap_remote
from revis.coordination.daemon import conflict_path, run_daemon_loop
from revis.coordination.findings import filter_findings, render_findings
from revis.coordination.ledger import read_findings, write_findings_entry
from revis.coordination.promotion import (
    build_promotion_body,
    build_promotion_title,
    create_or_reuse_pull_request,
    ensure_github_cli_ready,
    ensure_github_remote,
    github_repo_name,
    latest_promotion_finding,
    promote_branch,
    push_branch_for_pr,
)
from revis.coordination.repo import (
    branch_head,
    current_branch,
    is_git_repo,
    remote_branch_exists,
    remote_url,
    resolve_repo_root,
    uses_managed_trunk,
    working_tree_dirty,
)
from revis.coordination.report import write_session_report
from revis.coordination.runtime import (
    append_event,
    load_all_agent_records,
    write_agent_record,
)
from revis.coordination.runtime_ops import refresh_runtime, update_root_runtime_from_env
from revis.coordination.sandbox_meta import load_sandbox_meta
from revis.coordination.setup import (
    configure_coordination_remote,
    determine_remote_name,
    ensure_gitignore,
)
from revis.coordination.spawning import plan_agent_spawns, spawn_planned_agents
from revis.coordination.sync import sync_target_branch, try_sync_branch
from revis.core.config import default_codex_template, load_config, save_config
from revis.core.models import (
    AgentState,
    AgentType,
    MonitorConfig,
    ObjectiveConfig,
    RetentionConfig,
    RevisConfig,
    SandboxProvider,
)
from revis.core.util import RevisError, iso_now
from revis.sandbox import get_provider

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
    # Resolve the target repository and gather the operator's choices.
    root = Path.cwd()
    if not is_git_repo(root):
        raise typer.BadParameter(
            "revis init must run inside an existing git repository"
        )
    root = resolve_repo_root(root)
    provider = prompt_provider()
    console.print("Supported coding agents: codex")
    console.print("Default coding agent: codex")
    objective_value = typer.prompt(
        "Research objective (inline text or path to a markdown file)"
    ).strip()
    daemon_interval = typer.prompt("Daemon interval in minutes", default="15").strip()
    objective = parse_objective(root, objective_value)
    branch = current_branch(root)
    remote_name = determine_remote_name(root)

    # Explain the provider tradeoffs before writing any project state.
    if provider == SandboxProvider.LOCAL:
        console.print(
            "[yellow]Local mode creates one full clone per agent and launches agents with full permissions inside those clones.[/yellow]"
        )
    else:
        validate_daytona_support()
        console.print(
            "[yellow]Daytona mode keeps sandboxes isolated, but agent and git credentials must be provided at spawn time via environment variables. "
            "Revis does not store those secrets in config.[/yellow]"
        )
    validate_agent_launch(AgentType.CODEX, provider, require_daytona_credentials=False)
    if working_tree_dirty(root):
        console.print(
            "[yellow]Warning:[/yellow] spawn uses committed git state. Uncommitted project changes will not be present in sandboxes."
        )

    # Persist the initial project configuration.
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

    # Verify the chosen coordination remote can actually support the workflow.
    if not uses_managed_trunk(remote_name=remote_name) and not remote_branch_exists(
        root, remote_name=remote_name, branch=branch
    ):
        raise RevisError(
            f"Remote branch {remote_name}/{branch} does not exist. "
            f"Push {branch} to {remote_name} before using remote-backed coordination."
        )

    # Bootstrap the shared coordination branches and report the result.
    target_url = configure_coordination_remote(root, remote_name)
    bootstrap_remote(
        root,
        remote_name=remote_name,
        target_url=target_url,
        trunk_base_branch=branch,
        manage_trunk=uses_managed_trunk(remote_name=remote_name),
    )
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
    # Load project state and compute how many agents to launch.
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

    # Fail fast if any requested agent type cannot launch in this environment.
    for agent_type, count in counts.items():
        if count <= 0:
            continue
        validate_agent_launch(
            agent_type, config.provider, config=config, require_daytona_credentials=True
        )

    # Allocate IDs before prompting so each seeded direction is attached to the
    # exact agent/branch it will influence at spawn time.
    planned_agents = plan_agent_spawns(load_all_agent_records(root), counts)
    starting_directions = prompt_starting_directions(
        [planned_agent.agent_id for planned_agent in planned_agents]
    )

    # Launch the planned batch once the operator has confirmed the divergence.
    spawned = spawn_planned_agents(
        root,
        config=config,
        provider=provider,
        objective_text=objective_text,
        planned_agents=planned_agents,
        starting_directions=starting_directions,
        resume=resume,
    )

    # Show attach commands once the whole batch is ready.
    table = Table(title="Spawned Agents")
    table.add_column("Agent")
    table.add_column("Type")
    table.add_column("Attach")
    for record in spawned:
        table.add_row(
            record.agent_id, record.agent_type.value, " ".join(record.attach_cmd)
        )
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
    # Append the finding inside the sandbox that produced it.
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    meta = load_sandbox_meta(root)
    write_findings_entry(
        root,
        remote_name=config.coordination_remote,
        agent_id=meta["agent_id"],
        session_id=sandbox_session_id(meta),
        message=message,
        kind=kind,
        source=source,
        title=title,
        url=url,
    )

    # Mirror the event back to host-side runtime state when available.
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
    # Load the shared ledger, then apply the requested query filters.
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    entries = read_findings(root, remote_name=config.coordination_remote)
    filtered = filter_findings(
        entries, since=since, agent=agent, last=last, kind=kind, source=source
    )
    console.print(render_findings(filtered))


@app.command()
def report(
    session: str | None = typer.Option(None, "--session"),
    output: Path | None = typer.Option(None, "--output"),
) -> None:
    """Write a raw markdown report for one Revis session."""
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    target = write_session_report(
        root,
        remote_name=config.coordination_remote,
        output_path=output,
        session_id=session,
    )
    console.print(str(target))


@app.command()
def sync() -> None:
    """Manually rebase the current sandbox branch onto the active sync target."""
    # Resolve the active sync target for this coordination mode.
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    branch = sync_target_branch(
        remote_name=config.coordination_remote, base_branch=config.trunk_base
    )

    # Attempt the sync and report the user-visible outcome.
    ok, result = try_sync_branch(
        root,
        remote_name=config.coordination_remote,
        branch=branch,
        conflict_path=conflict_path(root),
    )
    if ok:
        if uses_managed_trunk(remote_name=config.coordination_remote):
            console.print("Synced with trunk.")
        else:
            console.print(f"Synced with base branch {config.trunk_base}.")
        return
    if result == "conflict":
        raise typer.Exit(code=1)
    console.print("Skipped sync because the worktree is dirty.")


@app.command()
def promote() -> None:
    """Promote the current sandbox branch using the provider-specific flow."""
    # Load the current sandbox and decide which promotion path applies.
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    meta = load_sandbox_meta(root)
    branch_name = current_branch(root)
    # Promotion mode is chosen by the coordination remote, not the sandbox
    # provider. Local tmux sandboxes can still promote through GitHub when the
    # swarm is coordinating against a real remote.
    if uses_managed_trunk(remote_name=config.coordination_remote):
        summary = promote_branch(
            root,
            remote_name=config.coordination_remote,
            current_branch_name=branch_name,
        )
        message = f"Promoted: {summary}"
        title = summary
        url = None
    else:
        repo_remote = remote_url(root, config.coordination_remote)
        ensure_github_remote(repo_remote)
        ensure_github_cli_ready(root)
        repo_name = github_repo_name(repo_remote)
        push_branch_for_pr(
            root, remote_name=config.coordination_remote, branch=branch_name
        )
        entries = read_findings(root, remote_name=config.coordination_remote)
        finding = latest_promotion_finding(entries, agent_id=meta["agent_id"])
        title = build_promotion_title(branch_name=branch_name, finding=finding)
        body = build_promotion_body(
            branch_name=branch_name, base_branch=config.trunk_base, finding=finding
        )
        pull_request = create_or_reuse_pull_request(
            root,
            repo_name=repo_name,
            base_branch=config.trunk_base,
            head_branch=branch_name,
            title=title,
            body=body,
        )
        action = "Opened" if pull_request.created else "Updated"
        message = f"{action} PR #{pull_request.number} against {config.trunk_base}.\n{pull_request.url}"
        title = pull_request.title
        url = pull_request.url
        summary = pull_request.title

    # Record the promotion in the shared ledger and local runtime state.
    write_findings_entry(
        root,
        remote_name=config.coordination_remote,
        agent_id=meta["agent_id"],
        session_id=sandbox_session_id(meta),
        message=message,
        kind="promotion",
        source=None,
        title=title,
        url=url,
    )
    update_root_runtime_from_env(
        config=config,
        agent_id=meta["agent_id"],
        event_type="promotion",
        summary=summary,
    )
    console.print(message)


@app.command()
def status() -> None:
    """Show a Rich snapshot of swarm, findings, and daemon state."""
    # Refresh live runtime state before rendering any summary tables.
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    refresh_runtime(root, config)
    records = load_all_agent_records(root)
    entries = read_findings(root, remote_name=config.coordination_remote)
    by_type = Counter(record.agent_type.value for record in records)
    active = sum(1 for record in records if record.state == AgentState.ACTIVE)
    promotions = sum(1 for entry in entries if entry.kind == "promotion")
    target_branch = sync_target_branch(
        remote_name=config.coordination_remote, base_branch=config.trunk_base
    )
    sha, subject = branch_head(root, remote_name=config.coordination_remote, branch=target_branch)

    # Render a high-level swarm summary.
    table = Table(title="Revis Status")
    table.add_column("Metric")
    table.add_column("Value")
    table.add_row(
        "Agents",
        ", ".join(f"{count} {name}" for name, count in sorted(by_type.items())) or "0",
    )
    table.add_row("Active", str(active))
    table.add_row("Findings", str(len(entries)))
    table.add_row("Promotions", str(promotions))
    if uses_managed_trunk(remote_name=config.coordination_remote):
        table.add_row("Trunk", f"{sha[:8]} {subject}")
    else:
        table.add_row(f"Base ({config.trunk_base})", f"{sha[:8]} {subject}")
    console.print(table)

    # Render per-agent details beneath the swarm summary.
    agent_table = Table(title="Agents")
    agent_table.add_column("Agent")
    agent_table.add_column("State")
    agent_table.add_column("Last heartbeat")
    agent_table.add_column("Last sync")
    agent_table.add_column("Starting direction")
    agent_table.add_column("Attach")
    for record in records:
        agent_table.add_row(
            record.agent_id,
            record.state.value,
            record.last_heartbeat or "-",
            record.last_sync_result or "-",
            summarize_starting_direction(record.starting_direction),
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
    # Load the provider and current runtime records.
    root = resolve_repo_root(Path.cwd())
    config = load_config(root)
    provider = get_provider(root, config)
    records = load_all_agent_records(root)

    # Tear down each known sandbox and record the stop event.
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
    value = (
        typer.prompt("Sandbox provider [local/daytona]", default="local")
        .strip()
        .lower()
    )
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


def prompt_starting_directions(agent_ids: list[str]) -> dict[str, str | None]:
    """Collect optional starting directions for a spawn batch."""

    # Seeded divergence is intentionally interactive so operators make an
    # explicit choice per agent instead of accidentally reusing stale defaults
    # in non-interactive scripts.
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        console.print(
            "[red]revis spawn requires an interactive terminal for seeded divergence.[/red]"
        )
        raise typer.Exit(code=1)
    try:
        return collect_starting_directions(agent_ids)
    except KeyboardInterrupt:
        console.print("[yellow]Spawn cancelled.[/yellow]")
        raise typer.Exit(code=1)


def summarize_starting_direction(value: str | None) -> str:
    """Render a compact starting-direction summary for status tables."""

    if not value:
        return "-"
    return shorten(value, width=32, placeholder="...")


def sandbox_session_id(meta: dict[str, str]) -> str:
    """Return the sandbox session ID or fail with a migration error."""

    session_id = meta.get("session_id")
    if session_id is None:
        raise RevisError(
            "Sandbox metadata is missing `session_id`. Respawn this agent before logging findings or promoting changes."
        )
    return session_id


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
