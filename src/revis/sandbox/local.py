"""Local sandbox provider built on disposable clones and tmux sessions."""

from __future__ import annotations

import shutil
import time
from pathlib import Path

from revis.agent.credentials import copy_codex_auth, template_executable
from revis.agent.instructions import install_sandbox_instructions, revis_ignore_patterns
from revis.coordination.repo import (
    append_info_exclude,
    clone_remote,
    create_agent_branch,
    create_agent_branch_from,
    remote_url,
    set_git_identity,
)
from revis.coordination.sync import sync_target_branch
from revis.core.config import CONFIG_PATH
from revis.core.models import AgentRuntimeRecord, AgentState, AgentType, SandboxHandle
from revis.coordination.sandbox_meta import write_sandbox_meta
from revis.core.util import RevisError, ensure_dir, run, shell_join, substitute_argv
from revis.sandbox.base import SandboxProvider


class LocalSandboxProvider(SandboxProvider):
    """Provision local agent sandboxes as disposable clones plus tmux sessions."""

    def spawn(
        self,
        *,
        agent_id: str,
        agent_type: AgentType,
        objective_text: str,
        protocol_objective_text: str,
        resume: bool,
    ) -> SandboxHandle:
        """Create one local clone, then launch tmux-backed agent and daemon.

        Args:
            agent_id: Stable Revis agent identifier.
            agent_type: Agent type to launch.
            objective_text: Effective research objective text.
            protocol_objective_text: Shared research objective text.
            resume: Whether the spawn is resuming prior work.

        Returns:
            SandboxHandle: Handle describing the spawned local sandbox.
        """
        coordination_url = remote_url(self.project_root, self.config.coordination_remote)
        repo = self.project_root / ".revis" / "agents" / agent_id / "repo"
        branch = f"revis/{agent_id}/work"
        session_name = f"revis-{agent_id}"
        base_branch = sync_target_branch(
            remote_name=self.config.coordination_remote,
            base_branch=self.config.trunk_base,
        )
        try:
            # Local sandboxes follow the same sync target the daemon will later
            # rebase onto. That keeps local mode compatible with both the
            # private `revis-local` trunk and real GitHub-backed coordination.

            # Prepare the disposable repo clone and work branch.
            clone_remote(
                coordination_url,
                self.config.coordination_remote,
                repo,
                branch=base_branch,
            )
            if base_branch == self.config.trunk_base:
                create_agent_branch_from(
                    repo,
                    remote_name=self.config.coordination_remote,
                    agent_branch=branch,
                    base_branch=self.config.trunk_base,
                )
            else:
                create_agent_branch(
                    repo, remote_name=self.config.coordination_remote, agent_branch=branch
                )
            set_git_identity(repo, name=agent_id, email=f"{agent_id}@revis.local")

            # Install sandbox-local config, metadata, and instructions.
            self._copy_local_config(repo)
            write_sandbox_meta(
                repo,
                agent_id=agent_id,
                agent_type=agent_type,
                provider=self.config.provider,
                project_root=str(self.project_root),
            )
            install_sandbox_instructions(
                repo,
                agent_type=agent_type,
                objective_text=objective_text,
                protocol_objective_text=protocol_objective_text,
                daemon_interval_minutes=self.config.daemon_interval_minutes,
                codex_home=repo / ".revis" / "codex-home",
            )
            self._sync_local_agent_credentials(repo, agent_type=agent_type)
            append_info_exclude(repo, revis_ignore_patterns())

            # Start the agent and daemon session once the repo is ready.
            # Session names are deterministic per agent so `status` and
            # `monitor` always have a stable attach target after respawns.
            self._kill_session_if_exists(session_name)
            self._start_tmux_session(
                repo,
                session_name=session_name,
                agent_id=agent_id,
                agent_type=agent_type,
            )
            return SandboxHandle(
                agent_id=agent_id,
                agent_type=agent_type,
                root=repo,
                branch=branch,
                attach_cmd=["tmux", "attach", "-t", session_name],
                attach_label=session_name,
            )
        except Exception:
            # Half-created local sandboxes are cheaper to discard than to debug.
            # Keeping them around would also make later respawns ambiguous.
            self._kill_session_if_exists(session_name)
            if repo.exists():
                shutil.rmtree(repo.parent, ignore_errors=True)
            raise

    def probe(self, record: AgentRuntimeRecord) -> AgentRuntimeRecord:
        """Refresh local sandbox health and daemon heartbeat state.

        Args:
            record: Current persisted runtime record.

        Returns:
            AgentRuntimeRecord: Updated runtime record.
        """
        session = record.tmux_session or f"revis-{record.agent_id}"
        active = run(["tmux", "has-session", "-t", session], check=False, capture=True).returncode == 0
        record.state = AgentState.ACTIVE if active else AgentState.STOPPED

        # Refresh daemon-produced heartbeat and conflict markers.
        repo = Path(record.sandbox_path_or_id)
        heartbeat = repo / ".revis" / "last-daemon-sync"
        if heartbeat.exists():
            record.last_heartbeat = heartbeat.read_text().strip()
        conflict = repo / ".revis" / "sync-conflict"
        record.conflict_path = str(conflict) if conflict.exists() else None
        return record

    def stop(self, record: AgentRuntimeRecord, *, force: bool) -> AgentRuntimeRecord:
        """Stop the tmux session and remove the local sandbox clone.

        Args:
            record: Current persisted runtime record.
            force: Whether to kill the tmux session immediately.

        Returns:
            AgentRuntimeRecord: Updated runtime record after teardown.
        """
        session = record.tmux_session or f"revis-{record.agent_id}"

        # Stop the tmux session first so the agent and daemon can exit cleanly.
        if run(["tmux", "has-session", "-t", session], check=False).returncode == 0:
            if force:
                run(["tmux", "kill-session", "-t", session], check=False)
            else:
                # Let both windows handle Ctrl-C first so the daemon can finish
                # any in-flight sync/log write before the disposable clone is
                # torn down.
                run(["tmux", "send-keys", "-t", f"{session}:0", "C-c"], check=False)
                run(["tmux", "send-keys", "-t", f"{session}:1", "C-c"], check=False)
                time.sleep(3)
                run(["tmux", "kill-session", "-t", session], check=False)

        # Remove the disposable clone once the session is gone.
        repo = Path(record.sandbox_path_or_id)
        if repo.exists():
            shutil.rmtree(repo.parent, ignore_errors=True)
        record.state = AgentState.STOPPED
        record.attach_cmd = []
        record.attach_label = None
        record.tmux_session = None
        record.worktree_path = None
        return record

    def _copy_local_config(self, repo: Path) -> None:
        """Copy the project config into a local sandbox.

        Args:
            repo: Sandbox repo root.
        """
        target = ensure_dir(repo / ".revis") / "config.toml"
        shutil.copy2(self.project_root / CONFIG_PATH, target)

    def _kill_session_if_exists(self, session_name: str) -> None:
        """Best-effort cleanup for a tmux session name.

        Args:
            session_name: Tmux session name to kill if present.
        """
        run(["tmux", "kill-session", "-t", session_name], check=False)

    def _sync_local_agent_credentials(self, repo: Path, *, agent_type: AgentType) -> None:
        """Copy reusable Codex auth into a local sandbox.

        Args:
            repo: Sandbox repo root.
            agent_type: Agent type running in the sandbox.

        Raises:
            RevisError: If an unsupported agent type is requested.
        """
        if agent_type != AgentType.CODEX:
            raise RevisError("Revis local sandboxes are codex-only right now.")
        if template_executable(self.config.codex_template.argv) != "codex":
            return
        copy_codex_auth(repo / ".revis" / "codex-home")

    def _start_tmux_session(
        self,
        repo: Path,
        *,
        session_name: str,
        agent_id: str,
        agent_type: AgentType,
    ) -> None:
        """Start the local agent and daemon windows inside one tmux session.

        Args:
            repo: Sandbox repo root.
            session_name: Tmux session name.
            agent_id: Stable Revis agent identifier.
            agent_type: Agent type running in the sandbox.
        """
        # Build the two long-lived commands that make up a local sandbox.
        agent_command = self._render_agent_command(
            repo,
            agent_id=agent_id,
            agent_type=agent_type,
        )
        daemon_command = shell_join(
            ["env", f"REVIS_PROJECT_ROOT={self.project_root}", "revis", "_daemon-run"]
        )

        # Start the agent window first, then add the daemon beside it.
        run(
            ["tmux", "new-session", "-d", "-s", session_name, "-c", str(repo), agent_command],
            capture=True,
        )
        run(["tmux", "rename-window", "-t", f"{session_name}:0", "agent"], capture=True)
        # Keeping the daemon in the same session makes local debugging a single
        # tmux attach instead of two separate process hunts.
        run(["tmux", "new-window", "-t", session_name, "-n", "daemon", "-c", str(repo), daemon_command], capture=True)

    def _render_agent_command(self, repo: Path, *, agent_id: str, agent_type: AgentType) -> str:
        """Render the shell command used for the local Codex process.

        Args:
            repo: Sandbox repo root.
            agent_id: Stable Revis agent identifier.
            agent_type: Agent type running in the sandbox.

        Returns:
            str: Shell-ready command string.

        Raises:
            RevisError: If an unsupported agent type is requested.
        """
        prompt = install_prompt(repo, agent_id=agent_id, agent_type=agent_type)
        if agent_type != AgentType.CODEX:
            raise RevisError("Revis local sandboxes are codex-only right now.")
        template = self.config.codex_template.argv
        argv = substitute_argv(template, prompt=prompt, agent_id=agent_id)
        # Local sandboxes can mirror findings/promotion activity back into the
        # host runtime registry because they share the same filesystem.
        env_vars = {"REVIS_PROJECT_ROOT": str(self.project_root)}
        env_vars["CODEX_HOME"] = str(repo / ".revis" / "codex-home")
        command = ["env", *[f"{key}={value}" for key, value in env_vars.items()], *argv]
        return shell_join(command)


def install_prompt(repo: Path, *, agent_id: str, agent_type: AgentType) -> str:
    """Build the initial agent prompt for a local sandbox.

    Args:
        repo: Sandbox repo root.
        agent_id: Stable Revis agent identifier.
        agent_type: Agent type running in the sandbox.

    Returns:
        str: Startup prompt passed into the agent CLI.
    """
    # Import lazily so sandbox providers do not pay Textual/template cost at import time.
    from revis.agent.instructions import render_startup_prompt

    return render_startup_prompt(agent_id=agent_id, agent_type=agent_type)
