"""Persist sandbox-local metadata that identifies a spawned agent repo."""

from __future__ import annotations

import tomllib
from pathlib import Path

import tomli_w

from revis.core.models import AgentType, SandboxProvider
from revis.core.util import RevisError, ensure_dir


META_PATH = Path(".revis/agent.toml")


def write_sandbox_meta(
    root: Path,
    *,
    agent_id: str,
    session_id: str | None = None,
    agent_type: AgentType,
    provider: SandboxProvider,
    project_root: str | None = None,
) -> Path:
    """Write the sandbox-local metadata file.

    Args:
        root: Sandbox repo root.
        agent_id: Stable Revis agent identifier.
        session_id: Stable Revis session identifier.
        agent_type: Agent type running in the sandbox.
        provider: Sandbox provider backing the sandbox.
        project_root: Optional original project root used for local runtime
            updates.

    Returns:
        Path: Path to the written metadata file.
    """
    path = root / META_PATH
    ensure_dir(path.parent)
    payload = {
        "agent_id": agent_id,
        "agent_type": agent_type.value,
        "provider": provider.value,
    }
    if session_id is not None:
        payload["session_id"] = session_id
    if project_root is not None:
        payload["project_root"] = project_root
    path.write_text(tomli_w.dumps(payload))
    return path


def load_sandbox_meta(root: Path) -> dict[str, str]:
    """Load sandbox-local metadata for the current repo.

    Args:
        root: Sandbox repo root.

    Returns:
        dict[str, str]: Parsed sandbox metadata.

    Raises:
        RevisError: If the metadata file is missing.
    """
    path = root / META_PATH
    if not path.exists():
        raise RevisError(f"Missing sandbox metadata: {path}")
    return tomllib.loads(path.read_text())
