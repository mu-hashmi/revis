"""Abstract sandbox provider interface implemented by local and Daytona backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from revis.core.models import AgentRuntimeRecord, AgentType, RevisConfig, SandboxHandle


class SandboxProvider(ABC):
    """Abstract interface for sandbox lifecycle management.

    Attributes:
        project_root: Repository root on the host machine.
        config: Loaded Revis project configuration.
    """

    def __init__(self, project_root: Path, config: RevisConfig):
        """Store provider context shared by concrete backends.

        Args:
            project_root: Repository root on the host machine.
            config: Loaded Revis project configuration.
        """
        self.project_root = project_root
        self.config = config

    @abstractmethod
    def spawn(
        self,
        *,
        agent_id: str,
        agent_type: AgentType,
        objective_text: str,
        protocol_objective_text: str,
        resume: bool,
    ) -> SandboxHandle:
        """Create a sandbox, launch the agent, and return attach metadata.

        Args:
            agent_id: Stable Revis agent identifier.
            agent_type: Agent type to launch.
            objective_text: Effective research objective text.
            protocol_objective_text: Shared research objective text.
            resume: Whether the spawn is resuming prior work.

        Returns:
            SandboxHandle: Provider-specific handle for the spawned sandbox.
        """
        raise NotImplementedError

    @abstractmethod
    def probe(self, record: AgentRuntimeRecord) -> AgentRuntimeRecord:
        """Refresh a runtime record with live provider state.

        Args:
            record: Current persisted runtime record.

        Returns:
            AgentRuntimeRecord: Updated runtime record.
        """
        raise NotImplementedError

    @abstractmethod
    def stop(self, record: AgentRuntimeRecord, *, force: bool) -> AgentRuntimeRecord:
        """Stop and clean up the sandbox backing a runtime record.

        Args:
            record: Current persisted runtime record.
            force: Whether to force immediate termination.

        Returns:
            AgentRuntimeRecord: Updated runtime record after stop/cleanup.
        """
        raise NotImplementedError
