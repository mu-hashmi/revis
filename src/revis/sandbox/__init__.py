"""Sandbox provider selection and provider package exports."""

from __future__ import annotations

from pathlib import Path

from revis.core.models import RevisConfig, SandboxProvider as SandboxProviderType
from revis.sandbox.base import SandboxProvider
from revis.sandbox.daytona import DaytonaSandboxProvider
from revis.sandbox.local import LocalSandboxProvider


def get_provider(project_root: Path, config: RevisConfig) -> SandboxProvider:
    """Instantiate the sandbox provider configured for a project.

    Args:
        project_root: Repository root on the host machine.
        config: Loaded project configuration.

    Returns:
        SandboxProvider: Concrete provider instance.

    Raises:
        ValueError: If the config references an unsupported provider.
    """
    if config.provider == SandboxProviderType.LOCAL:
        return LocalSandboxProvider(project_root, config)
    if config.provider == SandboxProviderType.DAYTONA:
        return DaytonaSandboxProvider(project_root, config)
    raise ValueError(f"Unsupported provider: {config.provider}")
