"""Tests for the shared findings ledger."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading

from revis.coordination.ledger import read_findings, write_findings_entry

from tests.helpers import bootstrap_local_project, clone_repo, run_cmd


def test_write_findings_entry_round_trip(tmp_path: Path) -> None:
    """A written finding should round-trip through the shared ledger branch."""

    root = tmp_path / "project"
    _, remote_path = bootstrap_local_project(root)

    path = write_findings_entry(
        root,
        remote_name="revis-local",
        agent_id="codex-1",
        message="Observed a stable improvement.",
        kind="result",
        source="exp-1",
        title="Improved baseline",
        url="https://example.com/run/1",
    )

    entries = read_findings(root, remote_name="revis-local")

    assert path.name.endswith("-codex-1.md")
    assert entries[0].agent == "codex-1"
    assert entries[0].body == "Observed a stable improvement."
    assert entries[0].kind == "result"
    assert entries[0].source == "exp-1"
    assert entries[0].title == "Improved baseline"
    assert entries[0].url == "https://example.com/run/1"

    ls_remote = run_cmd(
        ["git", "ls-remote", "--heads", str(remote_path), "revis/findings"],
        cwd=root,
    ).stdout
    assert "revis/findings" in ls_remote


def test_concurrent_findings_writes_keep_all_entries(tmp_path: Path) -> None:
    """Concurrent writers should all land in the shared findings branch."""

    root = tmp_path / "project"
    _, remote_path = bootstrap_local_project(root)

    clones: list[Path] = []
    for index in range(4):
        clone = tmp_path / f"clone-{index}"
        clone_repo(root, clone)
        if run_cmd(["git", "remote"], cwd=clone).stdout.splitlines().count("revis-local") == 0:
            run_cmd(["git", "remote", "add", "revis-local", str(remote_path)], cwd=clone)
        clones.append(clone)

    barrier = threading.Barrier(len(clones))

    def writer(index: int, repo: Path) -> None:
        barrier.wait()
        write_findings_entry(
            repo,
            remote_name="revis-local",
            agent_id=f"codex-{index + 1}",
            message=f"finding {index}",
            kind="result",
            source=f"exp-{index}",
            title=f"Title {index}",
            url=None,
        )

    with ThreadPoolExecutor(max_workers=len(clones)) as executor:
        futures = [
            executor.submit(writer, index, clone)
            for index, clone in enumerate(clones)
        ]
        for future in futures:
            future.result()

    entries = read_findings(root, remote_name="revis-local")
    bodies = {entry.body for entry in entries}

    assert "Revis findings ledger initialized." in bodies
    for index in range(4):
        assert f"finding {index}" in bodies
