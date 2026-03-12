"""Generate sandbox-local protocol files, skills, and bootstrap instructions."""

from __future__ import annotations

import os
from pathlib import Path

from revis.core.models import AgentType
from revis.agent.templates import bootstrap_block, codex_skill_body, protocol_body, startup_prompt
from revis.core.util import RevisError, ensure_dir

# These markers bound the Revis-managed block so repeated spawns can replace the
# block in-place without disturbing any user-authored AGENTS.md content nearby.
REVIS_BLOCK_START = "<!-- revis:start -->"
REVIS_BLOCK_END = "<!-- revis:end -->"
# Revis inherits the user's existing Codex defaults from the local config and
# appends a sandbox-specific trusted-project entry for the sandbox worktree.
LOCAL_CODEX_CONFIG_PATH = Path.home() / ".codex" / "config.toml"


def render_startup_prompt(*, agent_id: str, agent_type: AgentType) -> str:
    """Render the first prompt passed to a spawned agent session.

    Args:
        agent_id: Stable Revis agent identifier.
        agent_type: Agent type running in the sandbox.

    Returns:
        str: Startup prompt text for the agent CLI.

    Raises:
        RevisError: If the agent type is unsupported.
    """

    if agent_type != AgentType.CODEX:
        raise RevisError("Unsupported agent type.")
    return startup_prompt(agent_id=agent_id)


def render_objective_text(*, objective_text: str, starting_direction: str | None = None) -> str:
    """Render the effective per-agent objective document.

    Args:
        objective_text: Shared research objective text.
        starting_direction: Optional advisory starting direction for this agent.

    Returns:
        str: Markdown content for `.revis/objective.md`.
    """

    base = objective_text.strip()
    if not starting_direction:
        return base + "\n"
    direction = starting_direction.strip()
    return (
        base
        + "\n\n## Starting Direction\n\n"
        + f"Suggested starting direction: {direction}\n\n"
        + "This is an initial suggestion, not a constraint. Follow stronger evidence from the findings ledger if it points elsewhere.\n"
    )


def write_shared_protocol(
    root: Path,
    *,
    objective_text: str,
    protocol_objective_text: str,
    daemon_interval_minutes: int,
) -> None:
    """Write the shared protocol and objective files into a sandbox.

    Args:
        root: Sandbox repo root.
        objective_text: Effective per-agent objective text.
        protocol_objective_text: Shared research objective text.
        daemon_interval_minutes: Configured daemon sync interval.
    """

    revis_dir = ensure_dir(root / ".revis")
    (revis_dir / "objective.md").write_text(objective_text)
    # `objective.md` may diverge per agent once seeded directions are applied,
    # but the protocol file stays shared so the coordination rules remain
    # identical across the swarm.
    (revis_dir / "protocol.md").write_text(
        protocol_body(
            objective_text=protocol_objective_text,
            daemon_interval_minutes=daemon_interval_minutes,
        )
    )


def install_sandbox_instructions(
    root: Path,
    *,
    agent_type: AgentType,
    objective_text: str,
    protocol_objective_text: str,
    daemon_interval_minutes: int,
    codex_home: Path | None = None,
    trusted_project_path: str | None = None,
) -> None:
    """Install Revis bootstrap files into a sandbox clone.

    Args:
        root: Sandbox repo root.
        agent_type: Agent type running in the sandbox.
        objective_text: Effective research objective text.
        protocol_objective_text: Shared objective text for the protocol document.
        daemon_interval_minutes: Configured daemon sync interval.
        codex_home: Optional sandbox-local Codex home directory override.
        trusted_project_path: Optional path that should be marked trusted in the
            sandbox-local Codex config.

    Raises:
        RevisError: If the agent type is unsupported.
    """

    if agent_type != AgentType.CODEX:
        raise RevisError("Unsupported agent type.")
    write_shared_protocol(
        root,
        objective_text=objective_text,
        protocol_objective_text=protocol_objective_text,
        daemon_interval_minutes=daemon_interval_minutes,
    )
    ensure_sandbox_bootstraps(root)
    install_codex_skill(
        root,
        codex_home=codex_home or (root / ".revis/codex-home"),
        trusted_project_path=trusted_project_path or str(root),
    )


def install_codex_skill(root: Path, *, codex_home: Path, trusted_project_path: str) -> Path:
    """Install the Revis Codex skill into a sandbox-local `CODEX_HOME`.

    Args:
        root: Sandbox repo root.
        codex_home: Sandbox-local Codex home directory.
        trusted_project_path: Repo path that should be marked trusted.

    Returns:
        Path: Directory containing the installed skill.
    """

    skill_dir = ensure_dir(codex_home / "skills" / "revis")
    (skill_dir / "SKILL.md").write_text(codex_skill_body())
    write_codex_home_config(codex_home, trusted_project_path=trusted_project_path)
    return skill_dir


def write_codex_home_config(codex_home: Path, *, trusted_project_path: str) -> None:
    """Write sandbox-local Codex config derived from the user's local config.

    Args:
        codex_home: Sandbox-local Codex home directory.
        trusted_project_path: Repo path that should be marked trusted.
    """

    config_path = codex_home / "config.toml"
    # Inherit the user's existing Codex defaults so sandbox behavior matches the
    # host as closely as possible, then add trust for the sandbox worktree's
    # distinct path.
    base = LOCAL_CODEX_CONFIG_PATH.read_text() if LOCAL_CODEX_CONFIG_PATH.exists() else ""
    suffix = "" if not base or base.endswith("\n") else "\n"
    config_path.write_text(base + suffix + f'[projects."{trusted_project_path}"]\ntrust_level = "trusted"\n')


def ensure_sandbox_bootstraps(root: Path) -> None:
    """Ensure sandbox bootstrap instruction files exist.

    Args:
        root: Sandbox repo root.
    """

    upsert_bootstrap(root / "AGENTS.md", skill_ref="revis")


def upsert_bootstrap(path: Path, *, skill_ref: str) -> None:
    """Insert or replace the Revis-managed bootstrap block in a file.

    Args:
        path: Instruction file to update.
        skill_ref: Skill reference the bootstrap should point to.
    """

    block = bootstrap_block(skill_ref=skill_ref)
    if not path.exists():
        path.write_text(block)
        return
    content = path.read_text()
    if REVIS_BLOCK_START in content and REVIS_BLOCK_END in content:
        # Replace only the Revis-owned region so any surrounding user-authored
        # AGENTS guidance survives repeated spawns untouched.
        start = content.index(REVIS_BLOCK_START)
        end = content.index(REVIS_BLOCK_END) + len(REVIS_BLOCK_END)
        path.write_text(content[:start].rstrip() + "\n\n" + block + "\n")
        return
    suffix = "" if content.endswith("\n") else "\n"
    path.write_text(content + suffix + "\n" + block)


def revis_ignore_patterns() -> list[str]:
    """Return sandbox-local paths that should stay untracked.

    Returns:
        list[str]: Git ignore patterns appended to `.git/info/exclude`.
    """

    return [
        ".revis/latest-findings.md",
        ".revis/source-index.md",
        ".revis/last-daemon-sync",
        ".revis/daemon.log",
        ".revis/sync-conflict",
        ".revis/agent.toml",
        ".revis/protocol.md",
        ".revis/objective.md",
        ".revis/codex-home/",
        "AGENTS.md",
    ]


def codex_home_env(root: Path) -> dict[str, str]:
    """Build an environment mapping for sandbox-local Codex state.

    Args:
        root: Sandbox repo root.

    Returns:
        dict[str, str]: Environment variables with `CODEX_HOME` pointed at the
        sandbox-local Codex directory.
    """

    codex_home = root / ".revis" / "codex-home"
    ensure_dir(codex_home / "skills")
    env = dict(os.environ)
    env["CODEX_HOME"] = str(codex_home)
    return env
