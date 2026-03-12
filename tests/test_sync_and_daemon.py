"""Tests for git sync logic and daemon cycles."""

from __future__ import annotations

import shutil
from pathlib import Path

from revis.coordination.daemon import run_daemon_cycle
from revis.coordination.ledger import write_findings_entry
from revis.coordination.repo import append_info_exclude, create_agent_branch, with_branch_worktree
from revis.coordination.runtime import load_agent_record, load_events, load_metrics
from revis.coordination.sandbox_meta import write_sandbox_meta
from revis.coordination.sync import try_sync_branch
from revis.agent.instructions import revis_ignore_patterns
from revis.core.config import save_config
from revis.core.models import AgentState, SandboxProvider

from tests.helpers import (
    bootstrap_local_project,
    clone_repo,
    commit_file,
    make_agent_record,
    run_cmd,
    write_runtime_state,
)


def test_try_sync_branch_skips_dirty_worktree(tmp_path: Path) -> None:
    """Dirty worktrees should skip auto-sync instead of rebasing."""

    root = tmp_path / "project"
    _, remote_path = bootstrap_local_project(root)

    sandbox = tmp_path / "sandbox"
    clone_repo(remote_path, sandbox, branch="revis/trunk")
    run_cmd(["git", "remote", "rename", "origin", "revis-local"], cwd=sandbox)
    create_agent_branch(sandbox, remote_name="revis-local", agent_branch="revis/codex-1/work")
    (sandbox / "README.md").write_text("dirty change\n")

    ok, result = try_sync_branch(
        sandbox,
        remote_name="revis-local",
        branch="revis/trunk",
        conflict_path=sandbox / ".revis" / "sync-conflict",
    )

    assert (ok, result) == (False, "dirty")
    assert not (sandbox / ".revis" / "sync-conflict").exists()


def test_try_sync_branch_records_conflict_and_aborts(tmp_path: Path) -> None:
    """Conflicting rebases should leave a surfaced conflict marker and abort cleanly."""

    remote_path = tmp_path / "origin.git"
    run_cmd(["git", "init", "--bare", str(remote_path)], cwd=tmp_path)

    main_repo = tmp_path / "main"
    clone = tmp_path / "work"
    for repo in (main_repo, clone):
        if repo.exists():
            shutil.rmtree(repo)

    run_cmd(["git", "clone", str(remote_path), str(main_repo)], cwd=tmp_path)
    run_cmd(["git", "config", "user.name", "Test User"], cwd=main_repo)
    run_cmd(["git", "config", "user.email", "test@example.com"], cwd=main_repo)
    run_cmd(["git", "checkout", "-b", "main"], cwd=main_repo)
    commit_file(main_repo, "shared.txt", "base\n", "base")
    run_cmd(["git", "push", "-u", "origin", "main"], cwd=main_repo)

    clone_repo(remote_path, clone)
    run_cmd(["git", "checkout", "-b", "revis/codex-1/work", "origin/main"], cwd=clone)
    commit_file(clone, "shared.txt", "local change\n", "local")

    commit_file(main_repo, "shared.txt", "remote change\n", "remote")
    run_cmd(["git", "push"], cwd=main_repo)

    conflict_path = clone / ".revis" / "sync-conflict"
    conflict_path.parent.mkdir(parents=True, exist_ok=True)
    ok, result = try_sync_branch(
        clone,
        remote_name="origin",
        branch="main",
        conflict_path=conflict_path,
    )

    assert (ok, result) == (False, "conflict")
    assert conflict_path.exists()
    assert "shared.txt" in conflict_path.read_text()

    rebase_dir = clone / ".git" / "rebase-merge"
    assert not rebase_dir.exists()


def test_run_daemon_cycle_updates_dashboards_and_runtime(tmp_path: Path) -> None:
    """One daemon cycle should materialize findings and mirror runtime state."""

    project_root = tmp_path / "project"
    config, remote_path = bootstrap_local_project(project_root)

    sandbox = tmp_path / "sandbox"
    clone_repo(remote_path, sandbox, branch="revis/trunk")
    run_cmd(["git", "remote", "rename", "origin", "revis-local"], cwd=sandbox)
    create_agent_branch(sandbox, remote_name="revis-local", agent_branch="revis/codex-1/work")

    save_config(sandbox, config)
    write_sandbox_meta(
        sandbox,
        agent_id="codex-1",
        agent_type=config.default_agent,
        provider=SandboxProvider.LOCAL,
        project_root=str(project_root),
    )
    append_info_exclude(sandbox, revis_ignore_patterns())

    record = make_agent_record(
        agent_id="codex-1",
        provider=SandboxProvider.LOCAL,
        state=AgentState.ACTIVE,
        branch="revis/codex-1/work",
        sandbox_path_or_id=str(sandbox),
        attach_cmd=["tmux", "attach", "-t", "revis-codex-1"],
        attach_label="revis-codex-1",
    )
    write_runtime_state(project_root, config=config, record=record)

    write_findings_entry(
        project_root,
        remote_name="revis-local",
        agent_id="codex-2",
        message="Consulted source index.",
        kind="claim",
        source="paper://test",
        title="Useful source",
        url=None,
    )

    with with_branch_worktree(project_root, remote_name="revis-local", branch="revis/trunk") as worktree:
        commit_file(worktree, "upstream.txt", "fresh upstream data\n", "upstream")
        run_cmd(["git", "push", "revis-local", "HEAD:refs/heads/revis/trunk"], cwd=worktree)

    run_daemon_cycle(sandbox)

    latest_findings = (sandbox / ".revis" / "latest-findings.md").read_text()
    source_index = (sandbox / ".revis" / "source-index.md").read_text()
    assert "Consulted source index." in latest_findings
    assert "paper://test" in source_index
    assert (sandbox / "upstream.txt").read_text() == "fresh upstream data\n"

    updated_record = load_agent_record(project_root, "codex-1")
    assert updated_record is not None
    assert updated_record.last_sync_result == "rebased"
    assert updated_record.last_heartbeat is not None

    events = load_events(project_root)
    metrics = load_metrics(project_root, "codex-1")
    assert any(event["type"] == "daemon_sync" for event in events)
    assert metrics[-1]["sync_ok"] is True
