"""Common pytest fixtures for Revis tests."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tests.helpers import install_fake_gh


@pytest.fixture
def runner() -> CliRunner:
    """Return a fresh Typer CLI runner."""

    return CliRunner()


@pytest.fixture
def fake_gh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """Install a fake `gh` executable and expose its state/log paths."""

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()

    state_path = tmp_path / "gh-state.json"
    log_path = tmp_path / "gh-log.jsonl"
    install_fake_gh(bin_dir, state_path=state_path, log_path=log_path)

    monkeypatch.setenv("FAKE_GH_STATE", str(state_path))
    monkeypatch.setenv("FAKE_GH_LOG", str(log_path))
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ.get('PATH', '')}")
    return {"state": state_path, "log": log_path}
