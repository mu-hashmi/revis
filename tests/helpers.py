"""Shared helpers for git-backed Revis tests."""

from __future__ import annotations

import json
import os
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path

from revis.coordination.bootstrap import bootstrap_remote
from revis.coordination.repo import ensure_coordination_remote
from revis.coordination.runtime import write_agent_record, write_registry
from revis.coordination.setup import ensure_gitignore
from revis.core.config import default_codex_template, save_config
from revis.core.models import (
    AgentRuntimeRecord,
    AgentState,
    AgentType,
    MonitorConfig,
    ObjectiveConfig,
    RetentionConfig,
    RevisConfig,
    RuntimeRegistry,
    SandboxHandle,
    SandboxProvider,
)
from revis.core.util import iso_now, sha256_text


def run_cmd(
    argv: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run a subprocess and optionally fail with captured output."""

    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)

    completed = subprocess.run(
        argv,
        cwd=cwd,
        env=merged_env,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and completed.returncode != 0:
        raise RuntimeError(
            f"{' '.join(argv)} failed with code {completed.returncode}\n"
            f"stdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )
    return completed


def init_repo(path: Path, *, branch: str = "main") -> Path:
    """Initialize a git repo with a stable test identity."""

    path.mkdir(parents=True, exist_ok=True)
    run_cmd(["git", "init", "-b", branch], cwd=path)
    run_cmd(["git", "config", "user.name", "Test User"], cwd=path)
    run_cmd(["git", "config", "user.email", "test@example.com"], cwd=path)
    return path


def create_bare_remote(path: Path) -> Path:
    """Create a bare git remote for integration tests."""

    run_cmd(["git", "init", "--bare", str(path)], cwd=path.parent)
    return path


def commit_file(repo: Path, relative_path: str, content: str, message: str) -> str:
    """Write one file, commit it, and return the new commit SHA."""

    target = repo / relative_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)

    run_cmd(["git", "add", relative_path], cwd=repo)
    run_cmd(["git", "commit", "-m", message], cwd=repo)
    return run_cmd(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()


def clone_repo(source: Path | str, dest: Path, *, branch: str = "main") -> Path:
    """Clone a repository for cross-repo integration tests."""

    run_cmd(["git", "clone", "--branch", branch, str(source), str(dest)], cwd=dest.parent)
    run_cmd(["git", "config", "user.name", "Test User"], cwd=dest)
    run_cmd(["git", "config", "user.email", "test@example.com"], cwd=dest)
    return dest


def make_config(
    *,
    provider: SandboxProvider,
    coordination_remote: str,
    trunk_base: str,
    objective_text: str = "Test objective",
) -> RevisConfig:
    """Build a standard Revis config for tests."""

    return RevisConfig(
        provider=provider,
        default_agent=AgentType.CODEX,
        codex_template=default_codex_template(),
        coordination_remote=coordination_remote,
        trunk_base=trunk_base,
        daemon_interval_minutes=1,
        objective=ObjectiveConfig(text=objective_text),
        retention=RetentionConfig(
            max_event_entries=10,
            max_event_bytes=512_000,
            max_event_archives=2,
            max_metric_points=10,
        ),
        monitor=MonitorConfig(refresh_seconds=0.1, health_probe_seconds=0.1),
    )


def bootstrap_local_project(root: Path) -> tuple[RevisConfig, Path]:
    """Create a project using the local managed coordination remote."""

    init_repo(root)
    commit_file(root, "README.md", "local project\n", "init")

    config = make_config(
        provider=SandboxProvider.LOCAL,
        coordination_remote="revis-local",
        trunk_base="main",
    )
    save_config(root, config)
    ensure_gitignore(root)

    remote_path = ensure_coordination_remote(root)
    bootstrap_remote(
        root,
        remote_name="revis-local",
        target_url=str(remote_path),
        trunk_base_branch="main",
        manage_trunk=True,
    )
    return config, remote_path


def bootstrap_origin_project(root: Path, remote_path: Path) -> RevisConfig:
    """Create a project that coordinates through a real git remote."""

    init_repo(root)
    commit_file(root, "README.md", "origin project\n", "init")

    run_cmd(["git", "remote", "add", "origin", str(remote_path)], cwd=root)
    run_cmd(["git", "push", "-u", "origin", "main"], cwd=root)

    config = make_config(
        provider=SandboxProvider.LOCAL,
        coordination_remote="origin",
        trunk_base="main",
    )
    save_config(root, config)
    ensure_gitignore(root)
    bootstrap_remote(
        root,
        remote_name="origin",
        target_url=str(remote_path),
        trunk_base_branch="main",
        manage_trunk=False,
    )
    return config


def write_runtime_state(
    root: Path,
    *,
    config: RevisConfig,
    record: AgentRuntimeRecord,
    objective_text: str = "Test objective",
) -> AgentRuntimeRecord:
    """Persist a runtime registry and one agent record."""

    registry = RuntimeRegistry(
        swarm_id="swarm-test",
        provider=config.provider,
        started_at=iso_now(),
        objective_hash=sha256_text(objective_text),
        trunk_branch=config.trunk_base if config.coordination_remote == "origin" else "revis/trunk",
        findings_branch="revis/findings",
        config_path=str(root / ".revis" / "config.toml"),
        coordination_remote=config.coordination_remote,
    )
    write_registry(root, registry)
    write_agent_record(root, record)
    return record


def make_agent_record(
    *,
    agent_id: str = "codex-1",
    provider: SandboxProvider = SandboxProvider.LOCAL,
    state: AgentState = AgentState.ACTIVE,
    branch: str = "revis/codex-1/work",
    sandbox_path_or_id: str = "sandbox-id",
    session_id: str | None = "swarm-test",
    attach_cmd: list[str] | None = None,
    attach_label: str | None = None,
    workspace_url: str | None = None,
) -> AgentRuntimeRecord:
    """Create a standard runtime record for one agent."""

    return AgentRuntimeRecord(
        agent_id=agent_id,
        agent_type=AgentType.CODEX,
        provider=provider,
        state=state,
        branch=branch,
        session_id=session_id,
        started_at=iso_now(),
        sandbox_path_or_id=sandbox_path_or_id,
        attach_cmd=attach_cmd or [],
        attach_label=attach_label,
        workspace_url=workspace_url,
    )


@dataclass
class FakeProvider:
    """Simple provider double used for runtime and CLI tests."""

    spawn_handle: SandboxHandle | None = None
    spawn_error: Exception | None = None
    probe_state: AgentState = AgentState.ACTIVE
    stop_calls: list[tuple[str, bool]] | None = None
    probe_calls: list[str] | None = None

    def spawn(
        self,
        *,
        agent_id: str,
        session_id: str,
        agent_type: AgentType,
        objective_text: str,
        protocol_objective_text: str,
        resume: bool,
    ) -> SandboxHandle:
        """Return a configured handle or raise a configured error."""

        del agent_type
        del objective_text
        del protocol_objective_text
        del resume
        del session_id

        if self.spawn_error is not None:
            raise self.spawn_error
        if self.spawn_handle is None:
            raise AssertionError("spawn_handle must be configured for FakeProvider")
        return self.spawn_handle

    def probe(self, record: AgentRuntimeRecord) -> AgentRuntimeRecord:
        """Update the record with a deterministic probe state."""

        if self.probe_calls is not None:
            self.probe_calls.append(record.agent_id)
        record.state = self.probe_state
        return record

    def stop(self, record: AgentRuntimeRecord, *, force: bool) -> AgentRuntimeRecord:
        """Capture stop calls and mark the record stopped."""

        if self.stop_calls is not None:
            self.stop_calls.append((record.agent_id, force))
        record.state = AgentState.STOPPED
        record.attach_cmd = []
        record.attach_label = None
        return record


def install_fake_gh(bin_dir: Path, *, state_path: Path, log_path: Path) -> Path:
    """Install a fake `gh` executable that tracks PR state in JSON."""

    script = bin_dir / "gh"
    script.write_text(
        """#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


STATE_PATH = Path(os.environ["FAKE_GH_STATE"])
LOG_PATH = Path(os.environ["FAKE_GH_LOG"])


def parse_value(flag: str, argv: list[str]) -> str:
    index = argv.index(flag)
    return argv[index + 1]


def load_state() -> dict[str, object]:
    if not STATE_PATH.exists():
        return {}
    return json.loads(STATE_PATH.read_text())


def save_state(payload: dict[str, object]) -> None:
    STATE_PATH.write_text(json.dumps(payload))


def append_log(argv: list[str]) -> None:
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(argv) + "\\n")


def main() -> int:
    argv = sys.argv[1:]
    append_log(argv)

    if argv[:2] == ["auth", "status"]:
        print("Logged in to github.com")
        return 0

    if argv[:2] == ["pr", "list"]:
        state = load_state()
        base = parse_value("--base", argv)
        head = parse_value("--head", argv)
        if state.get("base") == base and state.get("head") == head:
            print(json.dumps([state]))
        else:
            print("[]")
        return 0

    if argv[:2] == ["pr", "create"]:
        title = parse_value("--title", argv)
        base = parse_value("--base", argv)
        head = parse_value("--head", argv)
        state = {
            "number": 1,
            "url": "https://github.com/example/revis/pull/1",
            "title": title,
            "base": base,
            "head": head,
        }
        save_state(state)
        print(state["url"])
        return 0

    raise SystemExit(f"unsupported gh invocation: {argv}")


if __name__ == "__main__":
    raise SystemExit(main())
"""
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script
