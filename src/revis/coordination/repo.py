"""Git repository and remote helpers shared across coordination workflows."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote, urlparse

from revis.core.util import RevisError, ensure_dir, run, shell_join


TRUNK_BRANCH = "revis/trunk"
FINDINGS_BRANCH = "revis/findings"


def uses_managed_trunk(*, remote_name: str) -> bool:
    """Return whether coordination uses the local fallback trunk workflow."""

    return remote_name == "revis-local"


def resolve_repo_root(cwd: Path) -> Path:
    """Resolve the git repository root containing a path."""

    try:
        output = run(["git", "rev-parse", "--show-toplevel"], cwd=cwd).stdout.strip()
    except RevisError as exc:
        raise RevisError("revis must run inside a git repository") from exc
    return Path(output)


def is_git_repo(cwd: Path) -> bool:
    """Return whether a path lives inside a git repository."""

    try:
        resolve_repo_root(cwd)
        return True
    except RevisError:
        return False


def has_commits(root: Path) -> bool:
    """Return whether the repository already has a commit at `HEAD`."""

    completed = run(["git", "rev-parse", "--verify", "HEAD"], cwd=root, check=False)
    return completed.returncode == 0


def current_branch(root: Path) -> str:
    """Return the currently checked-out branch name."""

    branch = run(["git", "branch", "--show-current"], cwd=root).stdout.strip()
    if not branch:
        raise RevisError("could not determine current branch")
    return branch


def remote_url(root: Path, remote_name: str) -> str:
    """Return the configured URL for a git remote."""

    return run(["git", "remote", "get-url", remote_name], cwd=root).stdout.strip()


def normalize_http_remote(url: str) -> str:
    """Normalize a git remote URL into an HTTPS form."""

    if url.startswith("https://") or url.startswith("http://"):
        return url
    if url.startswith("git@"):
        host, path = url[4:].split(":", 1)
        return f"https://{host}/{path}"
    if url.startswith("ssh://"):
        parsed = urlparse(url)
        if not parsed.hostname or not parsed.path:
            raise RevisError(f"Unsupported remote URL: {url}")
        return f"https://{parsed.hostname}/{parsed.path.lstrip('/')}"
    raise RevisError(f"Daytona requires an HTTPS-capable remote URL, got: {url}")


def local_git_credentials(url: str) -> tuple[str, str]:
    """Resolve locally stored HTTPS git credentials for a remote."""

    normalized = normalize_http_remote(url)
    parsed = urlparse(normalized)

    # Ask git's configured credential helpers so Revis inherits the operator's
    # existing auth setup instead of introducing a parallel secret store.
    request = f"protocol={parsed.scheme}\nhost={parsed.hostname}\n"
    path = parsed.path.lstrip("/")
    if path:
        request += f"path={path}\n"
    request += "\n"

    completed = subprocess.run(
        ["git", "credential", "fill"],
        input=request,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "git credential fill failed"
        raise RevisError(message)

    values: dict[str, str] = {}
    for line in completed.stdout.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value

    username = values.get("username")
    password = values.get("password")
    if not username or not password:
        raise RevisError(
            f"No HTTPS git credentials found for {normalized}. "
            "Store credentials for this remote in your local git credential helper and retry."
        )
    return username, password


def credential_store_entry(url: str, *, username: str, password: str) -> str:
    """Render one `git credential-store` entry for a remote."""

    normalized = normalize_http_remote(url)
    parsed = urlparse(normalized)
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return f"{parsed.scheme}://{quote(username, safe='')}:{quote(password, safe='')}@{host}{parsed.path}"


def remote_exists(root: Path, remote_name: str) -> bool:
    """Return whether a remote exists in the repository."""

    return run(["git", "remote", "get-url", remote_name], cwd=root, check=False).returncode == 0


def add_or_update_remote(root: Path, remote_name: str, url: str) -> None:
    """Create or update a remote definition."""

    if remote_exists(root, remote_name):
        run(["git", "remote", "set-url", remote_name, url], cwd=root)
        return
    run(["git", "remote", "add", remote_name, url], cwd=root)


def git_status_porcelain(root: Path) -> list[str]:
    """Return porcelain status output for the worktree."""

    output = run(["git", "status", "--porcelain"], cwd=root).stdout
    return [line for line in output.splitlines() if line.strip()]


def working_tree_dirty(root: Path) -> bool:
    """Return whether the worktree has local changes."""

    return bool(git_status_porcelain(root))


def ensure_coordination_remote(root: Path) -> Path:
    """Create the bare coordination remote used by local mode."""

    target = ensure_dir(root / ".revis") / "coordination.git"
    if not target.exists():
        run(["git", "init", "--bare", str(target)], cwd=root)
    return target


def clone_remote(remote_url_value: str, remote_name: str, dest: Path, *, branch: str = TRUNK_BRANCH) -> None:
    """Clone the coordination remote into a sandbox-local working copy."""

    ensure_dir(dest.parent)
    if dest.exists():
        shutil.rmtree(dest)
    run(
        ["git", "clone", "-o", remote_name, "--branch", branch, remote_url_value, str(dest)]
    )


def create_agent_branch(repo: Path, *, remote_name: str, agent_branch: str) -> None:
    """Create or reset an agent work branch from the managed trunk."""

    create_agent_branch_from(
        repo,
        remote_name=remote_name,
        agent_branch=agent_branch,
        base_branch=TRUNK_BRANCH,
    )


def create_agent_branch_from(repo: Path, *, remote_name: str, agent_branch: str, base_branch: str) -> None:
    """Create or reset an agent work branch from the selected remote branch."""

    fetch_remote_branch(repo, remote_name=remote_name, branch=base_branch)
    run(["git", "checkout", "-B", agent_branch, f"{remote_name}/{base_branch}"], cwd=repo)


def set_git_identity(repo: Path, *, name: str, email: str) -> None:
    """Set the git author identity used for sandbox commits."""

    run(["git", "config", "user.name", name], cwd=repo)
    run(["git", "config", "user.email", email], cwd=repo)


def append_info_exclude(repo: Path, patterns: list[str]) -> None:
    """Append local-only ignore patterns to `.git/info/exclude`."""

    info_exclude = repo / ".git" / "info" / "exclude"
    existing = info_exclude.read_text() if info_exclude.exists() else ""
    with info_exclude.open("a", encoding="utf-8") as handle:
        for pattern in patterns:
            if pattern not in existing:
                handle.write(f"{pattern}\n")


def remote_ref(remote_name: str, branch: str) -> str:
    """Return the fully qualified remote-tracking ref for a branch."""

    return f"refs/remotes/{remote_name}/{branch}"


def fetch_remote_branch(repo: Path, *, remote_name: str, branch: str) -> None:
    """Force-refresh one remote-tracking branch ref."""

    run(
        [
            "git",
            "fetch",
            "--force",
            remote_name,
            f"{branch}:{remote_ref(remote_name, branch)}",
        ],
        cwd=repo,
    )


@contextmanager
def with_branch_worktree(
    repo: Path,
    *,
    remote_name: str,
    branch: str,
) -> Iterator[Path]:
    """Yield a temporary detached worktree for a remote branch snapshot."""

    from revis.core.util import temp_dir

    fetch_remote_branch(repo, remote_name=remote_name, branch=branch)
    with temp_dir(f"revis-{branch.replace('/', '-')}-") as temp_root:
        worktree_path = temp_root / "tree"
        # Shared coordination refs are edited through disposable detached
        # worktrees so agent sandboxes never need to leave their own branch.
        run(
            [
                "git",
                "worktree",
                "add",
                "--detach",
                str(worktree_path),
                remote_ref(remote_name, branch),
            ],
            cwd=repo,
        )
        try:
            yield worktree_path
        finally:
            run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=repo,
                check=False,
            )


def branch_head(repo: Path, *, remote_name: str, branch: str) -> tuple[str, str]:
    """Return the current remote branch commit hash and subject line."""

    fetch_remote_branch(repo, remote_name=remote_name, branch=branch)
    sha = run(["git", "rev-parse", f"{remote_name}/{branch}"], cwd=repo).stdout.strip()
    subject = run(
        ["git", "log", "-1", "--pretty=%s", f"{remote_name}/{branch}"],
        cwd=repo,
    ).stdout.strip()
    return sha, subject


def trunk_head(repo: Path, *, remote_name: str) -> tuple[str, str]:
    """Return the current trunk commit hash and subject line."""

    return branch_head(repo, remote_name=remote_name, branch=TRUNK_BRANCH)


def remote_branch_exists(repo: Path, *, remote_name: str, branch: str) -> bool:
    """Return whether a named branch exists on the remote."""

    result = run(
        ["git", "ls-remote", "--exit-code", "--heads", remote_name, branch],
        cwd=repo,
        check=False,
    )
    return result.returncode == 0


def render_attach_command(argv: list[str]) -> str:
    """Render an attach command as one shell-ready string."""

    return shell_join(argv)
