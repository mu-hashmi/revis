"""Minimal interactive terminal prompts for Revis CLI workflows."""

from __future__ import annotations

import shutil
import sys
import termios
import tty
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

CYAN = "\x1b[36m"
RESET = "\x1b[0m"


@dataclass(frozen=True, slots=True)
class MenuOption:
    """One selectable terminal menu option."""

    value: str
    label: str
    description: str | None = None


@contextmanager
def _raw_terminal() -> Iterator[None]:
    """Temporarily switch stdin into raw mode for arrow-key handling."""

    fd = sys.stdin.fileno()
    original = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        yield
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, original)


def _read_key() -> str:
    """Read one keypress, preserving arrow-key escape sequences."""

    first = sys.stdin.read(1)
    if first == "\x03":
        raise KeyboardInterrupt
    if first != "\x1b":
        return first

    second = sys.stdin.read(1)
    if second != "[":
        return first + second
    return first + second + sys.stdin.read(1)


def _clear_rendered_lines(count: int) -> None:
    """Clear the previously rendered inline menu block."""

    if count <= 0:
        return
    for index in range(count):
        sys.stdout.write("\r\x1b[2K")
        if index < count - 1:
            sys.stdout.write("\x1b[1A")
    sys.stdout.write("\r")


def _render_menu(
    *,
    prompt: str,
    options: list[MenuOption],
    selected_index: int,
    note: str | None,
) -> int:
    """Render an inline menu and return how many terminal lines it used."""

    width = max(20, shutil.get_terminal_size((80, 24)).columns - 1)

    def clip(text: str) -> str:
        if len(text) <= width:
            return text
        return text[: max(1, width - 3)] + "..."

    lines = [prompt]
    if note:
        lines.extend(clip(line) for line in note.splitlines())
    for index, option in enumerate(options):
        prefix = f"{CYAN}>{RESET}" if index == selected_index else " "
        lines.append(clip(f"{prefix} {option.label}"))
    lines.append(clip("Use up/down arrows and Enter."))
    sys.stdout.write("\x1b[?25l")
    sys.stdout.write("\r\n".join(lines))
    sys.stdout.flush()
    return len(lines)


def select_option(
    prompt: str,
    options: list[MenuOption],
    *,
    note: str | None = None,
    initial_index: int = 0,
) -> MenuOption:
    """Interactively pick one option from an inline arrow-key menu."""

    if not options:
        raise ValueError("select_option requires at least one option")

    selected_index = max(0, min(initial_index, len(options) - 1))
    rendered_lines = 0
    try:
        with _raw_terminal():
            while True:
                _clear_rendered_lines(rendered_lines)
                rendered_lines = _render_menu(
                    prompt=prompt,
                    options=options,
                    selected_index=selected_index,
                    note=note,
                )
                key = _read_key()
                if key in {"\r", "\n"}:
                    break
                if key in {"k", "\x1b[A"}:
                    selected_index = (selected_index - 1) % len(options)
                    continue
                if key in {"j", "\x1b[B"}:
                    selected_index = (selected_index + 1) % len(options)
                    continue
                if key == "\x1b":
                    raise KeyboardInterrupt
    finally:
        _clear_rendered_lines(rendered_lines)
        sys.stdout.write("\x1b[?25h")
        sys.stdout.flush()

    selected = options[selected_index]
    summary = prompt.rstrip(":")
    sys.stdout.write(f"{summary}: {selected.label}\n")
    sys.stdout.flush()
    return selected


def prompt_text(
    prompt: str,
    *,
    default: str | None = None,
    allow_blank: bool = False,
) -> str:
    """Prompt for one line of text using normal cooked terminal input."""

    suffix = f" [{default}]" if default is not None else ""
    while True:
        response = input(f"{prompt}{suffix}: ").strip()
        if response:
            return response
        if default is not None:
            return default
        if allow_blank:
            return ""
