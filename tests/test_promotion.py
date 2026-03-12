"""Tests for managed-trunk and PR-based promotion flows."""

from __future__ import annotations

import json
from pathlib import Path

from revis.cli.main import app
from revis.coordination.ledger import read_findings, write_findings_entry
from revis.coordination.promotion import create_or_reuse_pull_request, promote_branch
from revis.coordination.repo import branch_head, remote_branch_exists
from revis.coordination.sandbox_meta import write_sandbox_meta

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

    run_cmd(["git", "checkout", "-b", "revis/codex-1/work"], cwd=root)
    (root / "feature.txt").write_text("candidate change\n")
    run_cmd(["git", "add", "feature.txt"], cwd=root)
    run_cmd(["git", "commit", "-m", "candidate"], cwd=root)

    write_sandbox_meta(
        root,
        agent_id="codex-1",
        agent_type=config.default_agent,
        provider=config.provider,
        project_root=str(root),
    )
    write_findings_entry(
        root,
        remote_name="origin",
        agent_id="codex-1",
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
