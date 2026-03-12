"""Inline prompt flow for per-agent starting directions during spawn."""

from __future__ import annotations

from dataclasses import dataclass

from revis.cli.interactive import MenuOption, prompt_text, select_option


@dataclass(slots=True)
class SeedDraft:
    agent_id: str
    starting_direction: str | None = None
    visited: bool = False


def _draft_status(draft: SeedDraft) -> str:
    """Render a short status string for one starting-direction draft."""

    if draft.starting_direction:
        return f"{draft.agent_id} [seeded: {draft.starting_direction}]"
    if draft.visited:
        return f"{draft.agent_id} [blank]"
    return f"{draft.agent_id} [pending]"


def _next_unvisited_index(drafts: list[SeedDraft], *, after: int) -> int:
    """Return the next unvisited draft index, falling back to the current one."""

    total = len(drafts)
    for offset in range(1, total + 1):
        index = (after + offset) % total
        if not drafts[index].visited:
            return index
    return after


def collect_starting_directions(agent_ids: list[str]) -> dict[str, str | None]:
    """Collect optional per-agent starting directions with an inline menu."""

    drafts = [SeedDraft(agent_id=agent_id) for agent_id in agent_ids]
    selected_index = 0

    while True:
        options = [
            MenuOption(
                value=draft.agent_id,
                label=_draft_status(draft),
            )
            for draft in drafts
        ]
        options.append(
            MenuOption(
                value="__start__",
                label="Start swarm",
            )
        )
        choice = select_option(
            "Spawn setup",
            options,
            note="Select an agent to give it an initial direction to explore, for example 'optimizer / LR schedule changes', or start the swarm.",
            initial_index=selected_index,
        )
        if choice.value == "__start__":
            return {
                draft.agent_id: draft.starting_direction
                for draft in drafts
            }

        selected_index = next(
            index
            for index, draft in enumerate(drafts)
            if draft.agent_id == choice.value
        )
        draft = drafts[selected_index]
        if draft.starting_direction:
            print(f"Current starting direction for {draft.agent_id}: {draft.starting_direction}")
        value = prompt_text(
            f"Starting direction for {draft.agent_id} (leave blank to skip)",
            allow_blank=True,
        ).strip()
        draft.starting_direction = value or None
        draft.visited = True
        selected_index = _next_unvisited_index(drafts, after=selected_index)
