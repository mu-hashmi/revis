"""Agent credential and launcher validation helpers."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from revis.core.models import AgentType, SandboxProvider
from revis.core.util import RevisError, ensure_dir, run

# Codex stores its local login session here; sandbox bootstrapping copies this file
# into a sandbox-local `CODEX_HOME` so remote sessions can reuse the user's auth.
CODEX_AUTH_FILE = Path.home() / ".codex" / "auth.json"


def template_executable(argv: list[str]) -> str:
    """Return the executable name from a launch template.

    Args:
        argv: Launch argv template.

    Returns:
        str: Basename of the executable in the template.

    Raises:
        RevisError: If the template is empty.
    """

    if not argv:
        raise RevisError("Agent command template cannot be empty")
    return Path(argv[0]).name


def ensure_agent_cli_ready(
    *,
    agent_type: AgentType,
    provider: SandboxProvider,
    argv: list[str],
    require_daytona_credentials: bool = True,
) -> None:
    """Validate that the configured agent launcher is usable locally.

    Args:
        agent_type: Agent type being validated.
        provider: Sandbox provider the agent will run under.
        argv: Launch argv template.
        require_daytona_credentials: Reserved flag for future provider-specific
            credential checks.

    Raises:
        RevisError: If the agent type or executable is unsupported, or if Codex
            is not installed and logged in.
    """

    del provider
    del require_daytona_credentials
    if agent_type != AgentType.CODEX:
        raise RevisError("Unsupported agent type.")
    executable = template_executable(argv)
    if executable != "codex":
        raise RevisError(f"Unsupported agent executable: {executable}. Revis v1 only supports Codex.")
    ensure_codex_ready()


def ensure_codex_ready() -> None:
    """Fail fast when the local Codex CLI cannot be reused for spawning.

    Raises:
        RevisError: If Codex is missing, logged out, or lacks a reusable auth
            file in the standard local location.
    """

    if shutil.which("codex") is None:
        raise RevisError("Codex CLI is not installed. Install it and run `codex login`, then retry.")
    result = run(["codex", "login", "status"], check=False)
    output = result.stdout + result.stderr
    if result.returncode != 0 or "Logged in" not in output:
        raise RevisError("Codex CLI is not logged in. Run `codex login` on this machine and retry.")
    if not CODEX_AUTH_FILE.exists():
        raise RevisError(f"Codex appears logged in, but {CODEX_AUTH_FILE} is missing.")


def codex_home_auth_path(codex_home: Path) -> Path:
    """Return the auth file path inside a sandbox-local `CODEX_HOME`.

    Args:
        codex_home: Sandbox-local Codex home directory.

    Returns:
        Path: Path where the copied auth file should live.
    """

    return codex_home / "auth.json"


def copy_codex_auth(codex_home: Path) -> Path:
    """Copy the local Codex login session into a sandbox-local home.

    Args:
        codex_home: Sandbox-local Codex home directory.

    Returns:
        Path: Destination auth file path inside the sandbox-local home.
    """

    ensure_dir(codex_home)
    target = codex_home_auth_path(codex_home)
    shutil.copy2(CODEX_AUTH_FILE, target)
    return target


def daytona_agent_env(*, agent_type: AgentType) -> dict[str, str]:
    """Build provider environment overrides for a Daytona sandbox.

    Args:
        agent_type: Agent type running in the sandbox.

    Returns:
        dict[str, str]: Environment variables that should be injected into the
        remote sandbox.

    Raises:
        RevisError: If the agent type is unsupported.
    """

    if agent_type != AgentType.CODEX:
        raise RevisError("Unsupported agent type.")
    env: dict[str, str] = {}
    for name in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "GH_TOKEN", "GITHUB_TOKEN"):
        value = os.environ.get(name)
        if value:
            env[name] = value
    return env
