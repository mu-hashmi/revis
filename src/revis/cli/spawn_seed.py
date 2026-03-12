"""Textual picker for per-agent starting directions collected during spawn."""

from __future__ import annotations

from dataclasses import dataclass

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Input, ListItem, ListView, Static


@dataclass(slots=True)
class SeedDraft:
    agent_id: str
    starting_direction: str | None = None
    visited: bool = False


class SpawnSeedApp(App[dict[str, str | None]]):
    """Collect optional starting directions for a batch of agents."""

    CSS = """
    Screen {
      layout: vertical;
    }
    #body {
      height: 1fr;
    }
    #agents {
      width: 38;
      border: solid $panel;
    }
    #editor {
      width: 1fr;
      padding: 1 2;
      border: solid $panel;
    }
    #hint {
      color: $text-muted;
      margin-top: 1;
    }
    #status {
      margin-top: 1;
    }
    """

    BINDINGS = [
        Binding("q", "cancel", "Cancel"),
        Binding("enter", "edit_selected", "Edit"),
        Binding("escape", "focus_agents", "Back"),
    ]

    def __init__(self, agent_ids: list[str]):
        super().__init__()
        self.drafts = [SeedDraft(agent_id=agent_id) for agent_id in agent_ids]

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="body"):
            yield ListView(
                *[
                    ListItem(Static("", id=f"label-{draft.agent_id}"))
                    for draft in self.drafts
                ],
                id="agents",
            )
            with Vertical(id="editor"):
                yield Static("", id="title")
                yield Static("", id="summary")
                yield Input(placeholder="Type a short starting direction or leave blank", id="seed-input")
                yield Static("", id="status")
                yield Static(
                    "Arrow keys move between agents. Press Enter to edit, Enter again to save and advance. Leave input blank to skip.",
                    id="hint",
                )
        yield Footer()

    def on_mount(self) -> None:
        # Populate the initial labels before focusing the agent list.
        self._refresh_labels()
        self._sync_editor()
        self.query_one("#agents", ListView).focus()

    def action_cancel(self) -> None:
        self.exit(None, return_code=1)

    def action_edit_selected(self) -> None:
        if self.query_one("#seed-input", Input).has_focus:
            self._save_current()
            return
        self._focus_input()

    def action_focus_agents(self) -> None:
        self.query_one("#agents", ListView).focus()

    def on_list_view_highlighted(self, _: ListView.Highlighted) -> None:
        if not self.query_one("#seed-input", Input).has_focus:
            self._sync_editor()

    def on_list_view_selected(self, _: ListView.Selected) -> None:
        self._focus_input()

    def on_input_submitted(self, _: Input.Submitted) -> None:
        self._save_current()

    def _current_index(self) -> int:
        list_view = self.query_one("#agents", ListView)
        if list_view.index is None:
            return 0
        return int(list_view.index)

    def _current_draft(self) -> SeedDraft:
        return self.drafts[self._current_index()]

    def _focus_input(self) -> None:
        self._sync_editor()
        self.query_one("#seed-input", Input).focus()

    def _sync_editor(self) -> None:
        draft = self._current_draft()

        # Show the selected agent and its current seed value.
        self.query_one("#title", Static).update(f"Agent: {draft.agent_id}")
        if draft.starting_direction:
            summary = f"Current starting direction: {draft.starting_direction}"
        else:
            summary = "Current starting direction: blank"
        self.query_one("#summary", Static).update(summary)
        input_widget = self.query_one("#seed-input", Input)
        input_widget.value = draft.starting_direction or ""

        # Refresh the overall progress indicator.
        status = self._status_text()
        self.query_one("#status", Static).update(status)

    def _refresh_labels(self) -> None:
        for draft in self.drafts:
            # Distinguish "skipped" from "pending" so a blank direction is an
            # explicit decision rather than missing operator input.
            if draft.starting_direction:
                state = "seeded"
            elif draft.visited:
                state = "skipped"
            else:
                state = "pending"
            self.query_one(f"#label-{draft.agent_id}", Static).update(
                f"{draft.agent_id}  [{state}]"
            )

    def _status_text(self) -> str:
        completed = sum(1 for draft in self.drafts if draft.visited)
        total = len(self.drafts)
        return f"Visited {completed}/{total} agents"

    def _save_current(self) -> None:
        draft = self._current_draft()

        # Persist the current input onto the selected draft.
        value = self.query_one("#seed-input", Input).value.strip()
        draft.starting_direction = value or None
        draft.visited = True
        self._refresh_labels()
        # Jump to the next unfinished agent instead of the next row so the
        # operator can move around freely without re-editing completed entries.
        next_index = self._next_unvisited_index(after=self._current_index())
        if next_index is None:
            self.exit(
                {
                    draft.agent_id: draft.starting_direction
                    for draft in self.drafts
                }
            )
            return

        # Advance the selection and reopen the editor on the next unfinished agent.
        list_view = self.query_one("#agents", ListView)
        list_view.index = next_index
        self._sync_editor()
        self._focus_input()

    def _next_unvisited_index(self, *, after: int) -> int | None:
        total = len(self.drafts)
        for offset in range(1, total + 1):
            index = (after + offset) % total
            if not self.drafts[index].visited:
                return index
        return None


def collect_starting_directions(agent_ids: list[str]) -> dict[str, str | None]:
    """Run the seed picker and return the collected directions."""

    result = SpawnSeedApp(agent_ids).run()
    if result is None:
        raise KeyboardInterrupt
    return result
