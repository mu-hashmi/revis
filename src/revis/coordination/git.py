"""Git-backed coordination primitives for trunk, findings, sync, and promotion."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlparse

from revis.core.models import FindingEntry
from revis.core.util import RevisError, ensure_dir, iso_now, parse_iso, run, shell_join, temp_dir


# Shared branch that accumulates proven improvements from agents.
TRUNK_BRANCH = "revis/trunk"
# Append-only branch that stores one markdown file per finding.
FINDINGS_BRANCH = "revis/findings"


@dataclass(slots=True)
class PullRequestRef:
    """Minimal PR metadata returned from GitHub CLI lookups."""

    number: int
    url: str
    title: str
    created: bool


def uses_managed_trunk(*, remote_name: str) -> bool:
    """Return whether coordination uses the local fallback trunk workflow."""

    return remote_name == "revis-local"


def resolve_repo_root(cwd: Path) -> Path:
    """Resolve the git repository root containing a path.

    Args:
        cwd: Working directory inside the target repository.

    Returns:
        Path: Repository root path.

    Raises:
        RevisError: If the path is not inside a git repository.
    """
    try:
        output = run(["git", "rev-parse", "--show-toplevel"], cwd=cwd).stdout.strip()
    except RevisError as exc:
        raise RevisError("revis must run inside a git repository") from exc
    return Path(output)


def is_git_repo(cwd: Path) -> bool:
    """Return whether a path lives inside a git repository.

    Args:
        cwd: Path to test.

    Returns:
        bool: True when the path resolves to a git repository.
    """
    try:
        resolve_repo_root(cwd)
        return True
    except RevisError:
        return False


def has_commits(root: Path) -> bool:
    """Return whether the repository already has a commit at `HEAD`.

    Args:
        root: Repository root.

    Returns:
        bool: True when `HEAD` resolves successfully.
    """
    completed = run(["git", "rev-parse", "--verify", "HEAD"], cwd=root, check=False)
    return completed.returncode == 0


def current_branch(root: Path) -> str:
    """Return the currently checked-out branch name.

    Args:
        root: Repository root.

    Returns:
        str: Current branch name.

    Raises:
        RevisError: If no branch name can be resolved.
    """
    branch = run(["git", "branch", "--show-current"], cwd=root).stdout.strip()
    if not branch:
        raise RevisError("could not determine current branch")
    return branch


def remote_url(root: Path, remote_name: str) -> str:
    """Return the configured URL for a git remote.

    Args:
        root: Repository root.
        remote_name: Remote name to inspect.

    Returns:
        str: Configured remote URL.
    """
    return run(["git", "remote", "get-url", remote_name], cwd=root).stdout.strip()


def normalize_http_remote(url: str) -> str:
    """Normalize a git remote URL into an HTTPS form.

    Args:
        url: Git remote URL in HTTPS, SSH, or scp-style syntax.

    Returns:
        str: HTTPS-capable remote URL.

    Raises:
        RevisError: If the URL cannot be normalized to an HTTPS form usable by
            Daytona.
    """
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
    """Resolve locally stored HTTPS git credentials for a remote.

    Args:
        url: Remote URL to resolve credentials for.

    Returns:
        tuple[str, str]: Username and password resolved from git credential
        helpers.

    Raises:
        RevisError: If git credential helpers fail or no credentials are found.
    """
    normalized = normalize_http_remote(url)
    parsed = urlparse(normalized)
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
    """Render one `git credential-store` entry for a remote.

    Args:
        url: Remote URL the credentials apply to.
        username: Git username.
        password: Git password or token.

    Returns:
        str: Credential-store entry line.
    """
    normalized = normalize_http_remote(url)
    parsed = urlparse(normalized)
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return f"{parsed.scheme}://{quote(username, safe='')}:{quote(password, safe='')}@{host}{parsed.path}"


def remote_exists(root: Path, remote_name: str) -> bool:
    """Return whether a remote exists in the repository.

    Args:
        root: Repository root.
        remote_name: Remote name to check.

    Returns:
        bool: True when the remote exists.
    """
    return run(["git", "remote", "get-url", remote_name], cwd=root, check=False).returncode == 0


def add_or_update_remote(root: Path, remote_name: str, url: str) -> None:
    """Create or update a remote definition.

    Args:
        root: Repository root.
        remote_name: Remote name to create or update.
        url: Target remote URL.
    """
    if remote_exists(root, remote_name):
        run(["git", "remote", "set-url", remote_name, url], cwd=root)
        return
    run(["git", "remote", "add", remote_name, url], cwd=root)


def git_status_porcelain(root: Path) -> list[str]:
    """Return porcelain status output for the worktree.

    Args:
        root: Repository root.

    Returns:
        list[str]: Non-empty porcelain status lines.
    """
    output = run(["git", "status", "--porcelain"], cwd=root).stdout
    return [line for line in output.splitlines() if line.strip()]


def working_tree_dirty(root: Path) -> bool:
    """Return whether the worktree has local changes.

    Args:
        root: Repository root.

    Returns:
        bool: True when tracked or untracked changes are present.
    """
    return bool(git_status_porcelain(root))


def ensure_coordination_remote(root: Path) -> Path:
    """Create the bare coordination remote used by local mode.

    Args:
        root: Repository root.

    Returns:
        Path: Path to the bare coordination remote.
    """
    target = ensure_dir(root / ".revis") / "coordination.git"
    if not target.exists():
        run(["git", "init", "--bare", str(target)], cwd=root)
    return target


def bootstrap_remote(
    root: Path,
    *,
    remote_name: str,
    target_url: str,
    trunk_base_branch: str,
    manage_trunk: bool,
) -> None:
    """Initialize findings and, when needed, trunk branches on the coordination remote.

    Args:
        root: Repository root.
        remote_name: Remote name that points at the coordination remote.
        target_url: URL or local path of the coordination remote.
        trunk_base_branch: User branch trunk was initialized from.
        manage_trunk: Whether this provider keeps using the Revis-managed trunk.
    """
    add_or_update_remote(root, remote_name, target_url)
    # Only the fallback `revis-local` remote owns a Revis-managed trunk. When
    # coordinating through a real remote, Revis leaves the user's branch layout
    # intact and limits itself to the findings ledger plus PR-based promotion.

    # Seed the shared code branch only when Revis owns trunk management.
    if manage_trunk:
        if has_commits(root):
            run(["git", "push", "--force", remote_name, f"HEAD:refs/heads/{TRUNK_BRANCH}"], cwd=root)
        else:
            seed_empty_trunk(target_url)

    # Seed the findings ledger in every coordination mode.
    seed_findings_branch(target_url, source_branch=TRUNK_BRANCH if manage_trunk else trunk_base_branch)
    if manage_trunk and target_url.endswith(".git") and Path(target_url).exists():
        run(["git", "--git-dir", target_url, "symbolic-ref", "HEAD", f"refs/heads/{TRUNK_BRANCH}"], cwd=root, check=False)


def seed_empty_trunk(remote_url_value: str) -> None:
    """Seed `revis/trunk` with an empty root commit.

    Args:
        remote_url_value: Coordination remote URL or local bare path.
    """
    with temp_dir("revis-seed-trunk-") as temp_root:
        run(["git", "init"], cwd=temp_root)
        set_git_identity(temp_root, name="Revis", email="revis@localhost")
        run(["git", "checkout", "-b", TRUNK_BRANCH], cwd=temp_root)
        run(["git", "commit", "--allow-empty", "-m", "Initialize revis trunk"], cwd=temp_root)
        run(["git", "remote", "add", "origin", remote_url_value], cwd=temp_root)
        run(["git", "push", "--force", "origin", f"{TRUNK_BRANCH}:refs/heads/{TRUNK_BRANCH}"], cwd=temp_root)


def seed_findings_branch(remote_url_value: str, *, source_branch: str) -> None:
    """Seed the orphan findings branch with a bootstrap finding.

    Args:
        remote_url_value: Coordination remote URL or local bare path.
        source_branch: Existing branch used as a temporary clone base.
    """
    with temp_dir("revis-seed-findings-") as temp_root:
        # Clone any existing branch only to get a valid repository we can orphan
        # from. The findings ledger intentionally has no shared history with code
        # branches so collaboration data never pollutes normal repo history.
        run(["git", "clone", "--branch", source_branch, remote_url_value, str(temp_root / "repo")], cwd=temp_root)
        repo = temp_root / "repo"
        set_git_identity(repo, name="Revis", email="revis@localhost")

        # Replace the working tree with the minimal findings bootstrap state.
        run(["git", "checkout", "--orphan", FINDINGS_BRANCH], cwd=repo)
        for child in repo.iterdir():
            if child.name == ".git":
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        ensure_dir(repo / "findings")
        seed = repo / "findings" / "bootstrap.md"
        seed.write_text("---\nagent: revis\ntimestamp: " + iso_now() + "\nkind: claim\n---\nRevis findings ledger initialized.\n")
        run(["git", "add", "findings/bootstrap.md"], cwd=repo)
        run(["git", "commit", "-m", "Initialize revis findings"], cwd=repo)
        run(["git", "push", "--force", "origin", f"{FINDINGS_BRANCH}:refs/heads/{FINDINGS_BRANCH}"], cwd=repo)


def clone_remote(remote_url_value: str, remote_name: str, dest: Path, *, branch: str = TRUNK_BRANCH) -> None:
    """Clone the coordination remote into a sandbox-local working copy.

    Args:
        remote_url_value: Coordination remote URL or local bare path.
        remote_name: Remote name to use in the clone.
        dest: Destination repo path.
        branch: Branch to check out during clone.
    """
    ensure_dir(dest.parent)
    if dest.exists():
        shutil.rmtree(dest)
    run(["git", "clone", "-o", remote_name, "--branch", branch, remote_url_value, str(dest)])


def create_agent_branch(repo: Path, *, remote_name: str, agent_branch: str) -> None:
    """Create or reset an agent work branch from a remote base branch.

    Args:
        repo: Sandbox repo root.
        remote_name: Coordination remote name.
        agent_branch: Agent work branch name to create.
    """
    create_agent_branch_from(repo, remote_name=remote_name, agent_branch=agent_branch, base_branch=TRUNK_BRANCH)


def create_agent_branch_from(repo: Path, *, remote_name: str, agent_branch: str, base_branch: str) -> None:
    """Create or reset an agent work branch from the selected remote branch.

    Args:
        repo: Sandbox repo root.
        remote_name: Coordination remote name.
        agent_branch: Agent work branch name to create.
        base_branch: Remote branch used as the branch point.
    """
    fetch_remote_branch(repo, remote_name=remote_name, branch=base_branch)
    run(["git", "checkout", "-B", agent_branch, f"{remote_name}/{base_branch}"], cwd=repo)


def set_git_identity(repo: Path, *, name: str, email: str) -> None:
    """Set the git author identity used for sandbox commits.

    Args:
        repo: Repository root.
        name: Git author name.
        email: Git author email.
    """
    run(["git", "config", "user.name", name], cwd=repo)
    run(["git", "config", "user.email", email], cwd=repo)


def append_info_exclude(repo: Path, patterns: list[str]) -> None:
    """Append local-only ignore patterns to `.git/info/exclude`.

    Args:
        repo: Repository root.
        patterns: Ignore patterns to append when missing.
    """
    info_exclude = repo / ".git" / "info" / "exclude"
    existing = info_exclude.read_text() if info_exclude.exists() else ""
    with info_exclude.open("a", encoding="utf-8") as handle:
        for pattern in patterns:
            if pattern not in existing:
                handle.write(f"{pattern}\n")


def remote_ref(remote_name: str, branch: str) -> str:
    """Return the fully qualified remote-tracking ref for a branch.

    Args:
        remote_name: Remote name.
        branch: Branch name.

    Returns:
        str: Remote-tracking ref path.
    """
    return f"refs/remotes/{remote_name}/{branch}"


def fetch_remote_branch(repo: Path, *, remote_name: str, branch: str) -> None:
    """Force-refresh one remote-tracking branch ref.

    Args:
        repo: Repository root.
        remote_name: Coordination remote name.
        branch: Branch name to fetch.
    """
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


def with_branch_worktree(repo: Path, *, remote_name: str, branch: str):
    """Yield a temporary detached worktree for a remote branch snapshot.

    Args:
        repo: Repository root.
        remote_name: Coordination remote name.
        branch: Branch name to materialize.

    Returns:
        contextmanager: Context manager yielding the temporary worktree path.
    """
    from contextlib import contextmanager

    @contextmanager
    def manager():
        fetch_remote_branch(repo, remote_name=remote_name, branch=branch)
        with temp_dir(f"revis-{branch.replace('/', '-')}-") as temp_root:
            worktree_path = temp_root / "tree"
            # Shared coordination refs are edited through disposable detached
            # worktrees so agent sandboxes never need to leave their own branch.
            run(["git", "worktree", "add", "--detach", str(worktree_path), remote_ref(remote_name, branch)], cwd=repo)
            try:
                yield worktree_path
            finally:
                run(["git", "worktree", "remove", "--force", str(worktree_path)], cwd=repo, check=False)

    return manager()


def write_findings_entry(
    repo: Path,
    *,
    remote_name: str,
    agent_id: str,
    message: str,
    kind: str | None,
    source: str | None,
    title: str | None,
    url: str | None,
) -> Path:
    """Write, commit, and push one findings entry on the findings branch.

    Args:
        repo: Sandbox repo root.
        remote_name: Coordination remote name.
        agent_id: Agent identifier writing the finding.
        message: Finding body markdown.
        kind: Optional finding kind.
        source: Optional source identifier.
        title: Optional finding title.
        url: Optional supporting URL.

    Returns:
        Path: Path to the written finding file inside the temporary worktree.
    """
    with with_branch_worktree(repo, remote_name=remote_name, branch=FINDINGS_BRANCH) as worktree:
        timestamp = iso_now()
        # Timestamped filenames keep the ledger append-only and make raw branch
        # inspection readable even before frontmatter is parsed.
        filename = timestamp.replace(":", "-") + f"-{agent_id}.md"

        # Build the markdown finding payload.
        frontmatter = {
            "agent": agent_id,
            "timestamp": timestamp,
            "kind": kind,
            "source": source,
            "title": title,
            "url": url,
        }
        header = "---\n"
        header += "".join(f"{key}: {value}\n" for key, value in frontmatter.items() if value)
        header += "---\n\n"
        path = worktree / "findings" / filename
        ensure_dir(path.parent)
        path.write_text(header + message.strip() + "\n")

        # Commit the new finding onto the detached findings worktree.
        run(["git", "add", str(path.relative_to(worktree))], cwd=worktree)
        run(["git", "commit", "-m", f"finding: {agent_id} {timestamp}"], cwd=worktree)
        attempts = 0

        # Rebase-and-push until we win the race with any concurrent logger.
        while True:
            attempts += 1
            try:
                # Multiple agents can log concurrently. Rebase-and-retry keeps
                # every finding as its own commit without introducing a central
                # coordination service outside git.
                run(["git", "pull", "--rebase", remote_name, FINDINGS_BRANCH], cwd=worktree)
                run(["git", "push", remote_name, f"HEAD:refs/heads/{FINDINGS_BRANCH}"], cwd=worktree)
                break
            except RevisError:
                if attempts >= 3:
                    raise
        return path


def fetch_findings_tree(repo: Path, *, remote_name: str) -> list[Path]:
    """Return finding file paths from a temporary findings worktree.

    Args:
        repo: Repository root.
        remote_name: Coordination remote name.

    Returns:
        list[Path]: Paths to finding markdown files.
    """
    with with_branch_worktree(repo, remote_name=remote_name, branch=FINDINGS_BRANCH) as worktree:
        return sorted((worktree / "findings").glob("*.md"))


def read_findings(repo: Path, *, remote_name: str) -> list[FindingEntry]:
    """Read and sort all findings from newest to oldest.

    Args:
        repo: Repository root.
        remote_name: Coordination remote name.

    Returns:
        list[FindingEntry]: Parsed findings in reverse chronological order.
    """
    entries: list[FindingEntry] = []

    # Parse every finding file from the shared ledger snapshot.
    with with_branch_worktree(repo, remote_name=remote_name, branch=FINDINGS_BRANCH) as worktree:
        for path in sorted((worktree / "findings").glob("*.md")):
            entries.append(parse_finding(path))

    # Return newest-first so CLI consumers can slice without resorting.
    entries.sort(key=lambda entry: parse_iso(entry.timestamp), reverse=True)
    return entries


def parse_finding(path: Path) -> FindingEntry:
    """Parse one markdown finding file with simple frontmatter.

    Args:
        path: Path to the finding markdown file.

    Returns:
        FindingEntry: Parsed finding entry.

    Raises:
        RevisError: If the file does not contain the expected frontmatter.
    """
    content = path.read_text()
    if not content.startswith("---\n"):
        raise RevisError(f"Invalid finding: {path}")
    _, frontmatter, body = content.split("---\n", 2)
    data: dict[str, str] = {}
    for line in frontmatter.splitlines():
        if ": " in line:
            key, value = line.split(": ", 1)
            data[key.strip()] = value.strip()
    return FindingEntry(
        path=str(path),
        agent=data["agent"],
        timestamp=data["timestamp"],
        body=body.strip(),
        kind=data.get("kind"),
        source=data.get("source"),
        title=data.get("title"),
        url=data.get("url"),
    )


def sync_branch(repo: Path, *, remote_name: str, branch: str) -> None:
    """Fetch and rebase the current branch onto a remote branch.

    Args:
        repo: Sandbox repo root.
        remote_name: Coordination remote name.
        branch: Branch name to rebase onto.
    """
    fetch_remote_branch(repo, remote_name=remote_name, branch=branch)
    run(["git", "rebase", f"{remote_name}/{branch}"], cwd=repo)


def try_sync_branch(repo: Path, *, remote_name: str, branch: str, conflict_path: Path) -> tuple[bool, str]:
    """Attempt a rebase onto the provider-selected sync branch and classify the outcome.

    Args:
        repo: Sandbox repo root.
        remote_name: Coordination remote name.
        branch: Branch name to rebase onto.
        conflict_path: Path used to surface conflicts to the agent.

    Returns:
        tuple[bool, str]: Success flag and outcome label.
    """
    if working_tree_dirty(repo):
        # Auto-rebasing over an in-progress experiment would hide exactly the
        # local edits the agent still needs to reason about, so dirty trees are
        # surfaced as "skip and try later" instead of being forced through git.
        return False, "dirty"

    # Attempt the rebase against the active coordination target.
    fetch_remote_branch(repo, remote_name=remote_name, branch=branch)
    result = run(["git", "rebase", f"{remote_name}/{branch}"], cwd=repo, check=False)
    if result.returncode == 0:
        if conflict_path.exists():
            conflict_path.unlink()
        return True, "rebased"
    conflicts = run(["git", "diff", "--name-only", "--diff-filter=U"], cwd=repo, check=False).stdout.strip()
    # Conflicts are written into the sandbox itself because the agent is already
    # operating there; the monitor only needs a breadcrumb to point the human at
    # the repo-local conflict artifact.
    conflict_path.write_text((conflicts or result.stderr.strip() or "rebase conflict") + "\n")

    # Reset back to the pre-rebase state once the conflict has been surfaced.
    run(["git", "rebase", "--abort"], cwd=repo, check=False)
    return False, "conflict"


def sync_target_branch(*, remote_name: str, base_branch: str) -> str:
    """Return the branch each coordination mode should rebase agents onto.

    Local tmux sandboxes can still coordinate through GitHub. Only the fallback
    `revis-local` remote keeps using the managed trunk path.
    """
    if uses_managed_trunk(remote_name=remote_name):
        return TRUNK_BRANCH
    return base_branch


def remote_branch_exists(repo: Path, *, remote_name: str, branch: str) -> bool:
    """Return whether a named branch exists on the remote."""

    result = run(["git", "ls-remote", "--exit-code", "--heads", remote_name, branch], cwd=repo, check=False)
    return result.returncode == 0


def promote_branch(repo: Path, *, remote_name: str, current_branch_name: str) -> str:
    """Merge the current agent branch into trunk and push the update.

    Args:
        repo: Sandbox repo root.
        remote_name: Coordination remote name.
        current_branch_name: Current agent work branch name.

    Returns:
        str: Subject line of the resulting trunk commit.
    """
    with with_branch_worktree(repo, remote_name=remote_name, branch=TRUNK_BRANCH) as worktree:
        result = run(["git", "merge", "--no-ff", "--no-edit", current_branch_name], cwd=worktree, check=False)
        if result.returncode != 0:
            run(["git", "merge", "--abort"], cwd=worktree, check=False)
            raise RevisError(result.stderr.strip() or "merge failed")
        run(["git", "push", remote_name, f"HEAD:refs/heads/{TRUNK_BRANCH}"], cwd=worktree)
        summary = run(["git", "log", "-1", "--pretty=%s"], cwd=worktree).stdout.strip()
        return summary


def branch_head(repo: Path, *, remote_name: str, branch: str) -> tuple[str, str]:
    """Return the current remote branch commit hash and subject line.

    Args:
        repo: Repository root.
        remote_name: Coordination remote name.
        branch: Remote branch to inspect.

    Returns:
        tuple[str, str]: Commit hash and subject line.
    """
    fetch_remote_branch(repo, remote_name=remote_name, branch=branch)
    sha = run(["git", "rev-parse", f"{remote_name}/{branch}"], cwd=repo).stdout.strip()
    subject = run(["git", "log", "-1", "--pretty=%s", f"{remote_name}/{branch}"], cwd=repo).stdout.strip()
    return sha, subject


def trunk_head(repo: Path, *, remote_name: str) -> tuple[str, str]:
    """Return the current trunk commit hash and subject line."""
    return branch_head(repo, remote_name=remote_name, branch=TRUNK_BRANCH)


def ensure_github_cli_ready(repo: Path) -> None:
    """Fail fast when GitHub CLI is unavailable for PR-based promotion."""
    if shutil.which("gh") is None:
        raise RevisError("GitHub CLI is not installed. Install `gh` before using PR-based promotion.")
    if os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"):
        return
    result = run(["gh", "auth", "status", "--hostname", "github.com"], cwd=repo, check=False)
    if result.returncode != 0:
        raise RevisError("GitHub CLI is not authenticated. Set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`.")


def ensure_github_remote(url: str) -> str:
    """Validate that a remote points at GitHub and return its HTTPS form."""
    normalized = normalize_http_remote(url)
    hostname = urlparse(normalized).hostname
    if hostname != "github.com":
        raise RevisError(f"GitHub PR promotion requires a github.com remote, got: {url}")
    return normalized


def github_repo_name(url: str) -> str:
    """Return the `OWNER/REPO` slug for a GitHub remote."""

    normalized = ensure_github_remote(url)
    path = urlparse(normalized).path.removeprefix("/").removesuffix(".git")
    parts = path.split("/")
    if len(parts) < 2:
        raise RevisError(f"Could not determine OWNER/REPO from remote URL: {url}")
    return f"{parts[0]}/{parts[1]}"


def push_branch_for_pr(repo: Path, *, remote_name: str, branch: str) -> None:
    """Push an agent branch so GitHub can open or update a PR for it."""
    # Agents own their work branches outright, so force-with-lease preserves the
    # "one branch per agent" workflow without clobbering unrelated remote state.
    run(["git", "push", "--force-with-lease", "-u", remote_name, f"{branch}:{branch}"], cwd=repo)


def find_open_pull_request(repo: Path, *, repo_name: str, base_branch: str, head_branch: str) -> PullRequestRef | None:
    """Return the open PR for one branch pair, if it exists."""
    # Ask GitHub whether this agent branch already has an open promotion PR.
    result = run(
        [
            "gh",
            "pr",
            "list",
            "--repo",
            repo_name,
            "--state",
            "open",
            "--base",
            base_branch,
            "--head",
            head_branch,
            "--json",
            "number,url,title",
        ],
        cwd=repo,
    )
    payload = json.loads(result.stdout)
    if not payload:
        return None
    pr = payload[0]
    return PullRequestRef(
        number=int(pr["number"]),
        url=str(pr["url"]),
        title=str(pr["title"]),
        created=False,
    )


def create_or_reuse_pull_request(
    repo: Path,
    *,
    repo_name: str,
    base_branch: str,
    head_branch: str,
    title: str,
    body: str,
) -> PullRequestRef:
    """Create a PR for the current branch pair or return the existing open one."""
    # Reuse an existing promotion PR when one already tracks this branch pair.
    existing = find_open_pull_request(repo, repo_name=repo_name, base_branch=base_branch, head_branch=head_branch)
    if existing is not None:
        # Revis treats promotion as "maintain the candidate PR for this agent
        # branch", not "open a fresh PR every time the agent makes progress".
        return existing

    # Create the promotion PR when this branch pair has not been promoted yet.
    run(
        [
            "gh",
            "pr",
            "create",
            "--repo",
            repo_name,
            "--base",
            base_branch,
            "--head",
            head_branch,
            "--title",
            title,
            "--body",
            body,
        ],
        cwd=repo,
    )
    created = find_open_pull_request(repo, repo_name=repo_name, base_branch=base_branch, head_branch=head_branch)
    if created is None:
        raise RevisError("GitHub CLI did not return the created pull request.")
    created.created = True
    return created


def render_attach_command(argv: list[str]) -> str:
    """Render an attach command as one shell-ready string.

    Args:
        argv: Attach command argv.

    Returns:
        str: Shell-escaped attach command.
    """
    return shell_join(argv)
