"""Tests for managed-trunk and PR-based promotion flows."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from revis.cli import main as cli_main
from revis.cli.main import app
from revis.coordination.ledger import read_findings, write_findings_entry
from revis.coordination.promotion import create_or_reuse_pull_request, promote_branch
from revis.coordination.repo import branch_head, remote_branch_exists
from revis.coordination.sandbox_meta import write_sandbox_meta
from typer.testing import CliRunner

from tests.helpers import (
    bootstrap_local_project,
    bootstrap_origin_project,
    create_bare_remote,
    run_cmd,
)


def test_promote_branch_merges_agent_into_trunk(tmp_path: Path) -> None:
    """Managed-trunk promotion should merge the agent branch into trunk."""

    root = tmp_path / "project"
    _, _ = bootstrap_local_project(root)

    run_cmd(["git", "checkout", "-b", "revis/codex-1/work"], cwd=root)
    (root / "feature.txt").write_text("promoted\n")
    run_cmd(["git", "add", "feature.txt"], cwd=root)
    run_cmd(["git", "commit", "-m", "agent change"], cwd=root)

    summary = promote_branch(
        root,
        remote_name="revis-local",
        current_branch_name="revis/codex-1/work",
    )

    sha, _ = branch_head(root, remote_name="revis-local", branch="revis/trunk")
    assert summary
    assert sha

    trunk_clone = tmp_path / "trunk-clone"
    run_cmd(
        ["git", "clone", "--branch", "revis/trunk", str(root / ".revis" / "coordination.git"), str(trunk_clone)],
        cwd=tmp_path,
    )
    assert (trunk_clone / "feature.txt").read_text() == "promoted\n"


def test_create_or_reuse_pull_request_reuses_existing(tmp_path: Path, fake_gh: dict[str, Path], monkeypatch) -> None:
    """PR promotion should reuse the existing PR for one branch pair."""

    repo = tmp_path / "repo"
    repo.mkdir()

    first = create_or_reuse_pull_request(
        repo,
        repo_name="example/revis",
        base_branch="main",
        head_branch="revis/codex-1/work",
        title="[Revis] First title",
        body="Initial body",
    )
    second = create_or_reuse_pull_request(
        repo,
        repo_name="example/revis",
        base_branch="main",
        head_branch="revis/codex-1/work",
        title="[Revis] Second title",
        body="Updated body",
    )

    log_lines = fake_gh["log"].read_text().splitlines()

    assert first.created is True
    assert second.created is False
    assert first.number == second.number == 1
    assert sum('"pr", "create"' in line for line in log_lines) == 1


def test_cli_promote_remote_pr_flow_pushes_branch_and_logs_promotion(
    tmp_path: Path,
    runner,
    fake_gh: dict[str, Path],
    monkeypatch,
) -> None:
    """`revis promote` should push the branch, open a PR, and log the promotion."""

    remote_path = create_bare_remote(tmp_path / "origin.git")
    root = tmp_path / "project"
    config = bootstrap_origin_project(root, remote_path)
    session_id = "session-test"

    run_cmd(["git", "checkout", "-b", "revis/codex-1/work"], cwd=root)
    (root / "feature.txt").write_text("candidate change\n")
    run_cmd(["git", "add", "feature.txt"], cwd=root)
    run_cmd(["git", "commit", "-m", "candidate"], cwd=root)

    write_sandbox_meta(
        root,
        agent_id="codex-1",
        session_id=session_id,
        agent_type=config.default_agent,
        provider=config.provider,
        project_root=str(root),
    )
    write_findings_entry(
        root,
        remote_name="origin",
        agent_id="codex-1",
        session_id=session_id,
        message="Result body",
        kind="result",
        source=None,
        title="Candidate title",
        url=None,
    )

    monkeypatch.chdir(root)
    monkeypatch.setattr("revis.cli.main.remote_url", lambda *_args, **_kwargs: "https://github.com/example/revis.git")

    result = runner.invoke(app, ["promote"])

    assert result.exit_code == 0, result.output
    assert "https://github.com/example/revis/pull/1" in result.output
    assert remote_branch_exists(root, remote_name="origin", branch="revis/codex-1/work")

    entries = read_findings(root, remote_name="origin")
    promotion = next(entry for entry in entries if entry.kind == "promotion")
    assert promotion.title == "[Revis] Candidate title"
    assert promotion.url == "https://github.com/example/revis/pull/1"

    state = json.loads(fake_gh["state"].read_text())
    assert state["head"] == "revis/codex-1/work"


def test_cli_promote_uses_concurrent_local_result_seed_before_remote_ledger_updates(
    tmp_path: Path,
    runner,
    fake_gh: dict[str, Path],
    monkeypatch,
) -> None:
    """`revis promote` should prefer the just-logged local result over stale remote findings."""

    remote_path = create_bare_remote(tmp_path / "origin.git")
    root = tmp_path / "project"
    config = bootstrap_origin_project(root, remote_path)
    session_id = "session-test"

    run_cmd(["git", "checkout", "-b", "revis/codex-1/work"], cwd=root)
    write_sandbox_meta(
        root,
        agent_id="codex-1",
        session_id=session_id,
        agent_type=config.default_agent,
        provider=config.provider,
        project_root=str(root),
    )

    write_findings_entry(
        root,
        remote_name="origin",
        agent_id="codex-1",
        session_id=session_id,
        message="Stale result body",
        kind="result",
        source=None,
        title="Stale title",
        url=None,
    )

    (root / "feature.txt").write_text("candidate change\n")
    run_cmd(["git", "add", "feature.txt"], cwd=root)
    run_cmd(["git", "commit", "-m", "candidate"], cwd=root)

    stale_write_reached = threading.Event()
    allow_fresh_write = threading.Event()
    log_finished = threading.Event()
    log_result: dict[str, object] = {}

    original_write = cli_main.write_findings_entry

    def delayed_write_findings_entry(*args, **kwargs):
        if kwargs.get("kind") == "result" and kwargs.get("title") == "Fresh title":
            stale_write_reached.set()
            if not allow_fresh_write.wait(timeout=5):
                raise AssertionError("timed out waiting to release fresh findings write")
        return original_write(*args, **kwargs)

    def run_log_command() -> None:
        log_runner = CliRunner()
        log_result["result"] = log_runner.invoke(
            app,
            ["log", "Fresh result body", "--kind", "result", "--title", "Fresh title"],
        )
        log_finished.set()

    monkeypatch.chdir(root)
    monkeypatch.setattr(
        "revis.cli.main.remote_url",
        lambda *_args, **_kwargs: "https://github.com/example/revis.git",
    )
    monkeypatch.setattr(
        "revis.cli.main.write_findings_entry",
        delayed_write_findings_entry,
    )

    log_thread = threading.Thread(target=run_log_command)
    log_thread.start()
    if not stale_write_reached.wait(timeout=5):
        if "result" in log_result:
            result = log_result["result"]
            raise AssertionError(f"fresh log write never reached delay point: {result}")
        raise AssertionError("fresh log write never reached delay point")

    promote_result = runner.invoke(app, ["promote"])
    assert promote_result.exit_code == 0, promote_result.output

    allow_fresh_write.set()
    assert log_finished.wait(timeout=5), "log command did not finish"
    log_thread.join(timeout=5)
    result = log_result["result"]
    assert result.exit_code == 0, result.output

    state = json.loads(fake_gh["state"].read_text())
    assert state["title"] == "[Revis] Fresh title"

    entries = read_findings(root, remote_name="origin")
    promotion = next(entry for entry in entries if entry.kind == "promotion")
    assert promotion.title == "[Revis] Fresh title"
