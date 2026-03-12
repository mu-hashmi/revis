"""Daytona sandbox provider for remote Codex sandboxes."""

from __future__ import annotations

import os
import shlex
import shutil
import uuid
from pathlib import Path

from daytona import CreateSandboxFromImageParams, Daytona, DaytonaNotFoundError, Image

from revis import __version__
from revis.agent.credentials import copy_codex_auth, daytona_agent_env, template_executable
from revis.agent.instructions import (
    install_sandbox_instructions,
    render_startup_prompt,
    revis_ignore_patterns,
)
from revis.coordination.repo import (
    credential_store_entry,
    local_git_credentials,
    normalize_http_remote,
    remote_url,
)
from revis.core.config import CONFIG_PATH
from revis.core.models import AgentRuntimeRecord, AgentState, AgentType, SandboxHandle
from revis.coordination.sandbox_meta import write_sandbox_meta
from revis.core.util import RevisError, shell_join, substitute_argv, temp_dir
from revis.sandbox.base import SandboxProvider


class DaytonaSandboxProvider(SandboxProvider):
    """Provision and manage remote sandboxes through the Daytona SDK."""

    def __init__(self, project_root: Path, config):
        """Create a Daytona-backed sandbox provider.

        Args:
            project_root: Repository root on the host machine.
            config: Loaded Revis project configuration.
        """
        super().__init__(project_root, config)
        self.client = Daytona()

    def spawn(
        self,
        *,
        agent_id: str,
        session_id: str,
        agent_type: AgentType,
        objective_text: str,
        protocol_objective_text: str,
        resume: bool,
    ) -> SandboxHandle:
        """Create a Daytona sandbox, clone the repo, and launch Codex in tmux.

        Args:
            agent_id: Stable Revis agent identifier.
            session_id: Stable Revis session identifier.
            agent_type: Agent type to launch.
            objective_text: Effective research objective text.
            protocol_objective_text: Shared research objective text.
            resume: Whether the spawn is resuming prior work.

        Returns:
            SandboxHandle: Handle describing the spawned Daytona sandbox.
        """
        del resume
        sandbox_name = f"revis-{agent_id}-{uuid.uuid4().hex[:6]}"
        sandbox = None
        repo_remote = remote_url(self.project_root, self.config.coordination_remote)
        clone_remote = normalize_http_remote(repo_remote)
        git_username, git_password = local_git_credentials(repo_remote)

        try:
            # Provision the remote sandbox first.
            sandbox = self.client.create(
                CreateSandboxFromImageParams(
                    name=sandbox_name,
                    language="python",
                    env_vars=self._sandbox_env(agent_type=agent_type),
                    labels={"tool": "revis", "agent_id": agent_id},
                    image=self._sandbox_image(agent_type=agent_type),
                ),
                timeout=600,
            )
            work_dir = sandbox.get_work_dir().rstrip("/")
            remote_repo = f"{work_dir}/repo"
            # Remote coordination follows the user's real base branch instead of
            # a hidden Revis trunk so promotions can become ordinary PRs.

            # Clone the repo and create the agent's work branch.
            sandbox.git.clone(
                url=clone_remote,
                path="repo",
                branch=self.config.trunk_base,
                username=git_username,
                password=git_password,
            )
            if self.config.coordination_remote != "origin":
                # Preserve the configured remote name so sandbox git commands
                # match the CLI config and protocol text exactly.
                self._exec_checked(
                    sandbox,
                    shell_join(
                        ["git", "remote", "rename", "origin", self.config.coordination_remote]
                    ),
                    cwd=remote_repo,
                    timeout=30,
                )
            self._exec_checked(
                sandbox,
                shell_join(
                    [
                        "sh",
                        "-lc",
                        " && ".join(
                            [
                                shell_join(
                                    [
                                        "git",
                                        "checkout",
                                        "-B",
                                        f"revis/{agent_id}/work",
                                        f"{self.config.coordination_remote}/{self.config.trunk_base}",
                                    ]
                                ),
                                shell_join(["git", "config", "user.name", agent_id]),
                                shell_join(["git", "config", "user.email", f"{agent_id}@revis.daytona"]),
                            ]
                        ),
                    ]
                ),
                cwd=remote_repo,
                timeout=120,
            )

            # Install repo-local credentials and bootstrap files.
            self._configure_git_credentials(
                sandbox,
                remote_repo=remote_repo,
                remote=clone_remote,
                username=git_username,
                password=git_password,
            )
            # Build the bootstrap tree locally first so Daytona and local mode
            # hand agents the same AGENTS/protocol/objective content.
            self._upload_sandbox_files(
                sandbox=sandbox,
                remote_repo=remote_repo,
                agent_id=agent_id,
                session_id=session_id,
                agent_type=agent_type,
                objective_text=objective_text,
                protocol_objective_text=protocol_objective_text,
            )
            self._install_revis(sandbox, remote_repo=remote_repo)
            self._append_info_exclude(sandbox, remote_repo)

            # Start the remote tmux session and return the human attach command.
            session_name = f"revis-{agent_id}"
            self._start_remote_tmux(
                sandbox,
                remote_repo=remote_repo,
                session_name=session_name,
                agent_id=agent_id,
                agent_type=agent_type,
            )
            self._exec_checked(
                sandbox,
                shell_join(["tmux", "has-session", "-t", session_name]),
                timeout=30,
            )
            ssh = sandbox.create_ssh_access(expires_in_minutes=24 * 60)
            attach_shell = f"{ssh.ssh_command} -t {shlex.quote(f'tmux attach -t {session_name}')}"
            return SandboxHandle(
                agent_id=agent_id,
                agent_type=agent_type,
                root=Path(remote_repo),
                branch=f"revis/{agent_id}/work",
                attach_cmd=["/bin/sh", "-lc", attach_shell],
                attach_label=sandbox.name,
                provider_id=sandbox.id,
                workspace_url=self._workspace_url(sandbox.id),
            )
        except Exception:
            if sandbox is not None:
                self.client.delete(sandbox, timeout=120)
            else:
                # Image or creation failures can happen before Daytona gives us a
                # durable handle, so name-based cleanup keeps orphaned sandboxes
                # from accumulating across retries.
                self._delete_by_name(sandbox_name)
            raise

    def probe(self, record: AgentRuntimeRecord) -> AgentRuntimeRecord:
        """Refresh sandbox state, tmux health, and daemon heartbeat.

        Args:
            record: Current persisted runtime record.

        Returns:
            AgentRuntimeRecord: Updated runtime record.
        """
        try:
            sandbox = self.client.get(record.sandbox_path_or_id)
        except DaytonaNotFoundError:
            record.state = AgentState.STOPPED
            record.attach_cmd = []
            record.attach_label = None
            record.workspace_url = None
            return record

        # Refresh sandbox metadata and infer the agent's effective state.
        sandbox.refresh_data()
        record.workspace_url = self._workspace_url(sandbox.id)
        repo = sandbox.get_work_dir().rstrip("/") + "/repo"
        tmux_session = sandbox.process.exec(
            f"tmux has-session -t revis-{record.agent_id}",
            cwd=repo,
            timeout=10,
        )
        sandbox_state = str(sandbox.state).lower()
        # A running workspace without the tmux session is still a failed agent
        # from Revis's perspective: the coordination daemon and Codex process are
        # the actual unit of health, not the raw VM/container.
        if sandbox_state.endswith("started") and tmux_session.exit_code == 0:
            record.state = AgentState.ACTIVE
            record.last_error = None
        elif sandbox_state.endswith("creating") or sandbox_state.endswith("pending"):
            record.state = AgentState.STARTING
        elif sandbox_state.endswith("stopped"):
            record.state = AgentState.STOPPED
        else:
            record.state = AgentState.FAILED
            record.last_error = (
                sandbox.error_reason
                or tmux_session.result.strip()
                or f"tmux session missing in {sandbox.name}"
            )

        # Pull daemon-produced heartbeat and conflict markers from the repo.
        heartbeat = sandbox.process.exec("cat .revis/last-daemon-sync", cwd=repo, timeout=10)
        if heartbeat.exit_code == 0 and heartbeat.result.strip():
            record.last_heartbeat = heartbeat.result.strip().splitlines()[-1]
        conflict = sandbox.process.exec(
            "test -f .revis/sync-conflict && cat .revis/sync-conflict",
            cwd=repo,
            timeout=10,
        )
        if conflict.exit_code == 0 and conflict.result.strip():
            record.conflict_path = ".revis/sync-conflict"
        else:
            record.conflict_path = None
        return record

    def capture_activity(
        self,
        record: AgentRuntimeRecord,
        *,
        line_limit: int = 120,
    ) -> list[str]:
        """Return recent tmux-pane output for one Daytona agent session."""

        try:
            sandbox = self.client.get(record.sandbox_path_or_id)
        except DaytonaNotFoundError:
            return ["Sandbox no longer exists."]

        repo = sandbox.get_work_dir().rstrip("/") + "/repo"
        response = sandbox.process.exec(
            f"tmux capture-pane -t revis-{record.agent_id}:0 -p",
            cwd=repo,
            timeout=10,
        )
        if response.exit_code != 0:
            return [response.result.strip() or "tmux capture failed."]

        cleaned = response.result.replace("\r", "")
        lines = cleaned.splitlines()
        if not lines:
            return ["No agent output yet."]
        return lines[-line_limit:]

    def stop(self, record: AgentRuntimeRecord, *, force: bool) -> AgentRuntimeRecord:
        """Delete the Daytona sandbox that backs an agent.

        Args:
            record: Current persisted runtime record.
            force: Included for interface parity; Daytona teardown is always
                destructive.

        Returns:
            AgentRuntimeRecord: Updated runtime record after deletion.
        """
        del force

        # Resolve the current sandbox handle if it still exists.
        try:
            sandbox = self.client.get(record.sandbox_path_or_id)
        except DaytonaNotFoundError:
            record.state = AgentState.STOPPED
            record.attach_cmd = []
            record.attach_label = None
            record.workspace_url = None
            return record

        # Delete the backing sandbox and clear attach metadata.
        self.client.delete(sandbox, timeout=120)
        record.state = AgentState.STOPPED
        record.attach_cmd = []
        record.attach_label = None
        record.workspace_url = None
        record.workspace_name = None
        return record

    def _sandbox_env(self, *, agent_type: AgentType) -> dict[str, str]:
        """Return environment variables that should be injected into a sandbox.

        Args:
            agent_type: Agent type running in the sandbox.

        Returns:
            dict[str, str]: Environment variables for sandbox creation.

        Raises:
            RevisError: If an unsupported agent type is requested.
        """
        if agent_type != AgentType.CODEX:
            raise RevisError("Revis Daytona sandboxes are codex-only right now.")
        return daytona_agent_env(agent_type=agent_type)

    def _agent_executable(self, agent_type: AgentType) -> str:
        """Return the configured agent executable name.

        Args:
            agent_type: Agent type running in the sandbox.

        Returns:
            str: Executable basename from the configured launch template.

        Raises:
            RevisError: If an unsupported agent type is requested.
        """
        if agent_type != AgentType.CODEX:
            raise RevisError("Revis Daytona sandboxes are codex-only right now.")
        return template_executable(self.config.codex_template.argv)

    def _sandbox_image(self, *, agent_type: AgentType) -> Image:
        """Build the image definition used for Daytona sandboxes.

        Args:
            agent_type: Agent type running in the sandbox.

        Returns:
            Image: Daytona image definition with required dependencies.
        """
        executable = self._agent_executable(agent_type)
        image = Image.debian_slim("3.12").run_commands(
            "apt-get update",
            "DEBIAN_FRONTEND=noninteractive apt-get install -y git tmux nodejs npm gh",
        )
        # `gh` is part of the base image because PR promotion now happens from
        # inside the sandbox, not from the host machine.
        if executable == "codex":
            image = image.run_commands("npm install -g @openai/codex")
        return image

    def _configure_git_credentials(
        self,
        sandbox,
        *,
        remote_repo: str,
        remote: str,
        username: str,
        password: str,
    ) -> None:
        """Configure repo-local git credential storage inside the sandbox clone.

        Args:
            sandbox: Daytona sandbox handle.
            remote_repo: Remote repo path inside the sandbox.
            remote: HTTPS remote URL.
            username: Git username.
            password: Git password or token.
        """
        # Upload the credential store file first.
        self._exec_checked(
            sandbox,
            shell_join(["mkdir", "-p", f"{remote_repo}/.git"]),
            timeout=30,
        )
        with temp_dir("revis-daytona-git-") as temp_root:
            # Keep credentials scoped to the clone so deleting the repo also
            # deletes the token material; the sandbox image stays stateless.
            credentials_path = temp_root / "git-credentials"
            credentials_path.write_text(
                credential_store_entry(remote, username=username, password=password) + "\n"
            )
            sandbox.fs.upload_file(str(credentials_path), f"{remote_repo}/.git/.revis-credentials")

        # Point git at the repo-local credential store.
        command = " && ".join(
            [
                shell_join(
                    [
                        "git",
                        "config",
                        "credential.helper",
                        f"store --file {remote_repo}/.git/.revis-credentials",
                    ]
                ),
                shell_join(["git", "config", "credential.useHttpPath", "true"]),
                shell_join(["chmod", "600", ".git/.revis-credentials"]),
            ]
        )
        self._exec_checked(sandbox, shell_join(["sh", "-lc", command]), cwd=remote_repo, timeout=30)

    def _upload_sandbox_files(
        self,
        *,
        sandbox,
        remote_repo: str,
        agent_id: str,
        session_id: str,
        agent_type: AgentType,
        objective_text: str,
        protocol_objective_text: str,
    ) -> None:
        """Upload Revis bootstrap files and reusable auth into the sandbox.

        Args:
            sandbox: Daytona sandbox handle.
            remote_repo: Remote repo path inside the sandbox.
            agent_id: Stable Revis agent identifier.
            session_id: Stable Revis session identifier.
            agent_type: Agent type running in the sandbox.
            objective_text: Effective research objective text.
            protocol_objective_text: Shared research objective text.
        """
        with temp_dir("revis-daytona-bootstrap-") as temp_root:
            # Render the same bootstrap files local sandboxes receive.
            (temp_root / ".revis").mkdir(parents=True, exist_ok=True)
            shutil.copy2(
                self.project_root / CONFIG_PATH,
                temp_root / ".revis" / "config.toml",
            )
            write_sandbox_meta(
                temp_root,
                agent_id=agent_id,
                session_id=session_id,
                agent_type=agent_type,
                provider=self.config.provider,
                project_root=None,
            )
            install_sandbox_instructions(
                temp_root,
                agent_type=agent_type,
                objective_text=objective_text,
                protocol_objective_text=protocol_objective_text,
                daemon_interval_minutes=self.config.daemon_interval_minutes,
                codex_home=temp_root / ".revis" / "codex-home",
                trusted_project_path=remote_repo,
            )
            if self._agent_executable(agent_type) == "codex":
                copy_codex_auth(temp_root / ".revis" / "codex-home")

            # Upload the rendered bootstrap tree into the remote repo.
            # Upload from a temp tree so the remote repo only ever sees the
            # rendered bootstrap artifacts, never host-specific scratch files.
            for path in sorted(temp_root.rglob("*")):
                if path.is_dir():
                    continue
                relative = path.relative_to(temp_root)
                sandbox.fs.upload_file(str(path), f"{remote_repo}/{relative.as_posix()}")

    def _append_info_exclude(self, sandbox, remote_repo: str) -> None:
        """Append sandbox-local ignore rules to `.git/info/exclude`.

        Args:
            sandbox: Daytona sandbox handle.
            remote_repo: Remote repo path inside the sandbox.
        """
        lines = "\n".join(revis_ignore_patterns())
        command = (
            f"mkdir -p {shlex.quote(remote_repo + '/.git/info')} && "
            f"cat >> {shlex.quote(remote_repo + '/.git/info/exclude')} <<'EOF'\n"
            f"{lines}\nEOF"
        )
        self._exec_checked(sandbox, command, timeout=30)

    def _install_revis(self, sandbox, *, remote_repo: str) -> None:
        """Install Revis into a sandbox-local virtual environment.

        Args:
            sandbox: Daytona sandbox handle.
            remote_repo: Remote repo path inside the sandbox.
        """
        venv_dir = f"{remote_repo}/.revis/venv"
        wheel_path = os.environ.get("REVIS_DEV_WHEEL")

        # Create the sandbox-local Python environment.
        self._exec_checked(sandbox, f"python -m venv {shlex.quote(venv_dir)}", timeout=120)
        if wheel_path and Path(wheel_path).exists():
            # Local development can point Daytona at an unpublished wheel without
            # changing the normal "install the released revis package" path.
            remote_wheel = f"{remote_repo}/{Path(wheel_path).name}"
            sandbox.fs.upload_file(wheel_path, remote_wheel)
            self._exec_checked(
                sandbox,
                f"{shlex.quote(venv_dir)}/bin/python -m pip install -q {shlex.quote(remote_wheel)}",
                timeout=300,
            )
        else:
            self._exec_checked(
                sandbox,
                f"{shlex.quote(venv_dir)}/bin/python -m pip install -q revis=={__version__}",
                timeout=300,
            )

        # Expose `revis` on PATH for both the daemon and any attached shell.
        self._exec_checked(
            sandbox,
            f"ln -sf {shlex.quote(venv_dir)}/bin/revis /usr/local/bin/revis",
            timeout=30,
        )

    def _start_remote_tmux(
        self,
        sandbox,
        *,
        remote_repo: str,
        session_name: str,
        agent_id: str,
        agent_type: AgentType,
    ) -> None:
        """Start Codex and the Revis daemon in tmux windows inside the sandbox.

        Args:
            sandbox: Daytona sandbox handle.
            remote_repo: Remote repo path inside the sandbox.
            session_name: Tmux session name.
            agent_id: Stable Revis agent identifier.
            agent_type: Agent type running in the sandbox.

        Raises:
            RevisError: If an unsupported agent type is requested.
        """
        if agent_type != AgentType.CODEX:
            raise RevisError("Revis Daytona sandboxes are codex-only right now.")

        # Build the remote agent command with the sandbox-local environment.
        prompt = render_startup_prompt(agent_id=agent_id, agent_type=agent_type)
        template = self.config.codex_template.argv
        argv = substitute_argv(template, prompt=prompt, agent_id=agent_id)
        venv_bin = f"{remote_repo}/.revis/venv/bin"
        argv_command = shell_join(argv)
        # The attach command is built around this deterministic tmux session
        # name, so both the monitor and the human operator always land in the
        # same place after SSHing into the workspace.
        agent_command = shell_join(
            [
                "sh",
                "-lc",
                f'export PATH={shlex.quote(venv_bin)}:"$PATH"; '
                f'export CODEX_HOME={shlex.quote(remote_repo + "/.revis/codex-home")}; '
                f"exec {argv_command}",
            ]
        )

        # Start the agent window first, then add the daemon beside it.
        self._exec_checked(
            sandbox,
            shell_join(
                ["tmux", "new-session", "-d", "-s", session_name, "-c", remote_repo, agent_command]
            ),
            timeout=60,
        )
        self._exec_checked(
            sandbox,
            shell_join(["tmux", "rename-window", "-t", f"{session_name}:0", "agent"]),
            timeout=30,
        )
        daemon_command = shell_join([f"{venv_bin}/python", "-m", "revis", "_daemon-run"])
        # Keep daemon output in its own window so attaching to Codex does not
        # bury the sync loop that keeps findings and rebases up to date.
        self._exec_checked(
            sandbox,
            shell_join(["tmux", "new-window", "-t", session_name, "-n", "daemon", "-c", remote_repo, daemon_command]),
            timeout=30,
        )

    def _exec_checked(self, sandbox, command: str, *, cwd: str | None = None, timeout: int) -> str:
        """Run a sandbox command and raise on failure.

        Args:
            sandbox: Daytona sandbox handle.
            command: Shell command to execute.
            cwd: Optional working directory inside the sandbox.
            timeout: Command timeout in seconds.

        Returns:
            str: Command stdout/stderr payload returned by Daytona.

        Raises:
            RevisError: If the command exits non-zero.
        """
        response = sandbox.process.exec(command, cwd=cwd, timeout=timeout)
        if response.exit_code != 0:
            message = response.result.strip() or f"{command} exited with {response.exit_code}"
            raise RevisError(message)
        return response.result

    def _workspace_url(self, sandbox_id: str) -> str:
        """Construct the Daytona dashboard URL for a sandbox.

        Args:
            sandbox_id: Daytona sandbox identifier.

        Returns:
            str: Dashboard URL for the sandbox.
        """
        api_url = os.environ.get("DAYTONA_API_URL", "https://app.daytona.io/api").rstrip("/")
        if api_url.endswith("/api"):
            api_url = api_url[:-4]
        return f"{api_url}/dashboard/sandboxes/{sandbox_id}"

    def _delete_by_name(self, sandbox_name: str) -> None:
        """Best-effort cleanup for image-build failures before a handle exists.

        Args:
            sandbox_name: Sandbox name to search and delete.
        """
        for item in self.client.list().items:
            if item.name != sandbox_name:
                continue
            self.client.delete(self.client.get(item.id), timeout=120)
            return
