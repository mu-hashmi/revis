"""Core utility helpers shared across Revis commands and providers."""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import subprocess
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Iterable


class RevisError(RuntimeError):
    """Raised for user-visible Revis failures.

    Attributes:
        args: Positional exception payload inherited from `RuntimeError`.
    """

    pass


def now_utc() -> datetime:
    """Return the current UTC timestamp.

    Returns:
        datetime: Current timezone-aware UTC timestamp.
    """

    return datetime.now(tz=UTC)


def iso_now() -> str:
    """Return the current UTC time as an ISO-8601 string.

    Returns:
        str: UTC timestamp with second precision and a trailing `Z`.
    """

    return now_utc().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_dir(path: Path) -> Path:
    """Create a directory tree when needed.

    Args:
        path: Directory path to create.

    Returns:
        Path: The same path after ensuring it exists.
    """

    path.mkdir(parents=True, exist_ok=True)
    return path


def sha256_text(value: str) -> str:
    """Compute a SHA-256 digest for text.

    Args:
        value: Text payload to hash.

    Returns:
        str: Hex-encoded SHA-256 digest.
    """

    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def run(
    argv: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
    capture: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run a subprocess with Revis-style error handling.

    Args:
        argv: Command argv to execute.
        cwd: Optional working directory for the command.
        env: Optional environment override for the command.
        check: Whether to raise `RevisError` on a non-zero exit code.
        capture: Whether to capture stdout and stderr.

    Returns:
        subprocess.CompletedProcess[str]: Completed process record.

    Raises:
        RevisError: If `check` is enabled and the command exits non-zero.
    """

    completed = subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        capture_output=capture,
        check=False,
    )
    if check and completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "command failed"
        raise RevisError(f"{shell_join(argv)}: {message}")
    return completed


def shell_join(argv: Iterable[str]) -> str:
    """Render argv as a shell-safe string.

    Args:
        argv: Command parts to render.

    Returns:
        str: Shell-escaped command string.
    """

    return " ".join(shlex.quote(part) for part in argv)


def substitute_argv(argv: list[str], **replacements: str) -> list[str]:
    """Expand placeholders inside an argv template.

    Args:
        argv: Template argv containing `str.format` placeholders.
        **replacements: Placeholder values to substitute.

    Returns:
        list[str]: Rendered argv list.
    """

    rendered: list[str] = []
    for part in argv:
        rendered.append(part.format(**replacements))
    return rendered


def write_json(path: Path, payload: object) -> None:
    """Write stable pretty-printed JSON to disk.

    Args:
        path: Destination path.
        payload: JSON-serializable object to persist.
    """

    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def read_json(path: Path) -> object:
    """Read JSON from disk.

    Args:
        path: Path to the JSON file.

    Returns:
        object: Decoded JSON payload.
    """

    return json.loads(path.read_text())


def append_jsonl(path: Path, payload: dict[str, object]) -> None:
    """Append one JSON object to a JSONL file.

    Args:
        path: JSONL file path.
        payload: JSON-serializable mapping to append.
    """

    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\n")


def parse_since_expression(value: str) -> datetime:
    """Parse a `revis findings --since` expression.

    Args:
        value: Either an ISO timestamp or a relative expression such as
            `2 hours ago`.

    Returns:
        datetime: Parsed timezone-aware timestamp.

    Raises:
        RevisError: If the expression does not match a supported format.
    """

    candidate = value.strip()
    try:
        if candidate.endswith("Z"):
            return datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        return datetime.fromisoformat(candidate)
    except ValueError:
        pass

    match = re.fullmatch(r"(\d+)\s+(minute|minutes|hour|hours|day|days)\s+ago", candidate)
    if not match:
        raise RevisError(f"Unsupported --since value: {value}")
    amount = int(match.group(1))
    unit = match.group(2)
    if unit.startswith("minute"):
        delta = timedelta(minutes=amount)
    elif unit.startswith("hour"):
        delta = timedelta(hours=amount)
    else:
        delta = timedelta(days=amount)
    return now_utc() - delta


def parse_iso(value: str) -> datetime:
    """Parse an ISO-8601 timestamp.

    Args:
        value: Timestamp string, optionally using a trailing `Z`.

    Returns:
        datetime: Parsed timezone-aware timestamp.
    """

    if value.endswith("Z"):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return datetime.fromisoformat(value)


@contextmanager
def temp_dir(prefix: str) -> Iterable[Path]:
    """Yield a temporary directory and clean it up afterward.

    Args:
        prefix: Directory name prefix for the temporary directory.

    Yields:
        Path: Path to the temporary directory.
    """

    raw = tempfile.TemporaryDirectory(prefix=prefix)
    try:
        yield Path(raw.name)
    finally:
        raw.cleanup()
