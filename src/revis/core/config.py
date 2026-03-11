"""Load and persist `.revis/config.toml` project configuration."""

from __future__ import annotations

import tomllib
from pathlib import Path

import tomli_w

from revis.core.models import (
    AgentTemplate,
    AgentType,
    MonitorConfig,
    ObjectiveConfig,
    RetentionConfig,
    RevisConfig,
    SandboxProvider,
)
from revis.core.util import RevisError, ensure_dir


CONFIG_DIR = Path(".revis")
CONFIG_PATH = CONFIG_DIR / "config.toml"


def default_codex_template() -> AgentTemplate:
    """Return the default Codex launch template.

    Returns:
        AgentTemplate: Default argv template for Codex sandboxes.
    """

    return AgentTemplate(
        argv=[
            "codex",
            "-c",
            'trust_level="trusted"',
            "--dangerously-bypass-approvals-and-sandbox",
            "--search",
            "{prompt}",
        ]
    )


def config_exists(root: Path) -> bool:
    """Return whether a Revis config file already exists.

    Args:
        root: Repository root.

    Returns:
        bool: True when `.revis/config.toml` exists.
    """

    return (root / CONFIG_PATH).exists()


def load_config(root: Path) -> RevisConfig:
    """Load project configuration from disk.

    Args:
        root: Repository root.

    Returns:
        RevisConfig: Decoded Revis project configuration.

    Raises:
        RevisError: If the config file is missing or contains an unsupported
            agent configuration.
    """

    path = root / CONFIG_PATH
    if not path.exists():
        raise RevisError(f"Missing config: {path}")
    data = tomllib.loads(path.read_text())
    default_agent = AgentType(data["agent"]["default"])
    if default_agent != AgentType.CODEX:
        raise RevisError("Unsupported agent.default in config. Re-run `revis init`.")
    return RevisConfig(
        provider=SandboxProvider(data["sandbox"]["provider"]),
        default_agent=default_agent,
        codex_template=AgentTemplate(list(data["agent"]["codex"]["argv"])),
        coordination_remote=data["repo"]["remote"],
        trunk_base=data["repo"]["trunk_base"],
        daemon_interval_minutes=int(data["daemon"]["interval_minutes"]),
        objective=ObjectiveConfig(
            text=data.get("objective", {}).get("text"),
            file=data.get("objective", {}).get("file"),
        ),
        retention=RetentionConfig(
            max_event_entries=int(data["runtime"]["max_event_entries"]),
            max_event_bytes=int(data["runtime"]["max_event_bytes"]),
            max_event_archives=int(data["runtime"]["max_event_archives"]),
            max_metric_points=int(data["runtime"]["max_metric_points"]),
        ),
        monitor=MonitorConfig(
            refresh_seconds=float(data["monitor"]["refresh_seconds"]),
            health_probe_seconds=float(data["monitor"]["health_probe_seconds"]),
        ),
    )


def save_config(root: Path, config: RevisConfig) -> Path:
    """Persist project configuration to `.revis/config.toml`.

    Args:
        root: Repository root.
        config: Configuration object to persist.

    Returns:
        Path: Path to the written config file.
    """

    ensure_dir(root / CONFIG_DIR)
    path = root / CONFIG_PATH
    payload = {
        "sandbox": {"provider": config.provider.value},
        "agent": {
            "default": config.default_agent.value,
            "codex": {"argv": config.codex_template.argv},
        },
        "repo": {
            "remote": config.coordination_remote,
            "trunk_base": config.trunk_base,
        },
        "daemon": {"interval_minutes": config.daemon_interval_minutes},
        "objective": {
            key: value
            for key, value in {
                "text": config.objective.text,
                "file": config.objective.file,
            }.items()
            if value is not None
        },
        "runtime": {
            "max_event_entries": config.retention.max_event_entries,
            "max_event_bytes": config.retention.max_event_bytes,
            "max_event_archives": config.retention.max_event_archives,
            "max_metric_points": config.retention.max_metric_points,
        },
        "monitor": {
            "refresh_seconds": config.monitor.refresh_seconds,
            "health_probe_seconds": config.monitor.health_probe_seconds,
        },
    }
    path.write_text(tomli_w.dumps(payload))
    return path
