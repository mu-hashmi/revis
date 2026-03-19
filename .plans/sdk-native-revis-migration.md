# SDK-Native Revis Migration

## Summary
- Replace the daemon/supervisor/provider architecture with a foreground run coordinator built on the current Sandbox Agent SDK API: `SandboxAgent.start/connect`, `createSession/resumeSession`, `session.prompt`, and `session.onEvent`.
- Keep Revis focused on multi-agent coordination, branch isolation, and promotion. Coordination moves from git ref polling/rebase loops to completed-turn event relays plus follow-up prompts.
- Remove the daemon design completely: no Revis daemon process, no daemon HTTP API, no daemon state model, no provider contract, no daemon-served dashboard, no `revis-local`, and no git-ref-based reconcile loop anywhere.

## Key Changes
- Add `.reference/sandbox-agent` as a git submodule and pin the npm dependency to the same upstream release line inspected at current HEAD (`sandbox-agent` `0.5.0-rc.1`). Implement against that SDK, not the older `SandboxAgentClient/postMessage` snippets still present in some docs pages.
- Replace `RevisConfig` with a versioned config that stores:
  - `git`: `remoteName`, `baseBranch`, `branchPrefix`
  - `sandbox`: discriminated union for `local | daytona | e2b | docker`, plus an explicit env-var passthrough allowlist
  - `agent`: discriminated union for `codex | claude | opencode`, with required defaults per agent kind
  - `coordination`: fixed `completed_turn` relay policy and relay size limits
- Make `revis init` optional. It only validates the repo, selects the remote/base branch, writes config, and updates `.gitignore`. `revis spawn` auto-creates the same defaults when config is missing.
- Replace workspace/daemon state with run-scoped storage under `.revis/runs/<run-id>/`:
  - `run.json` for run metadata
  - `agents/<agent-id>.json` for participant state
  - `sessions/<session-id>.json` and `events/<session-id>.jsonl` through a file-backed `SessionPersistDriver`
  - `revis-events.jsonl` for high-level Revis events
  - `worktrees/` only for the local sandbox
- Use one sandbox per agent slot. Local participants use git worktrees on the host plus `sandbox-agent/local`. Non-local participants create a sandbox with the SDK provider, clone the configured remote inside it, and run the session there.
- Replace the reconcile loop with a foreground coordinator that:
  - creates participants on branches `revis/<operator>/<run-id>/agent-N`
  - sends the initial task prompt
  - subscribes to each session’s live events
  - detects substantive completed turns
  - pushes new HEADs when the participant branch moved
  - builds a short relay from the latest assistant output plus changed files
  - queues that relay to every other participant and sends it as the next prompt when that participant is idle
- Permission and question handling:
  - auto-accept SDK permission requests so unattended runs do not stall
  - treat SDK question requests as a blocking participant state, surface them in the foreground/status output, and do not auto-answer in v1
- Promotion becomes remote-first only:
  - remove `revis-local`, `coordination.git`, managed trunk, ref mirroring, fetch/rebase sync, and poll timers
  - `promote` fails if the participant worktree is dirty
  - `promote` ensures the participant branch is pushed, then opens or reuses a PR against `baseBranch`
- Delete the old architecture outright:
  - remove `src/daemon/`
  - remove the custom `src/providers/` runtime boundary
  - remove the daemon-hosted dashboard/frontend stack and turn `revis dashboard` into an inspector-link launcher or plain URL output

## Public Interface Changes
- `revis spawn` stops accepting `--exec`. It becomes `revis spawn <count> <task>` with overrides like `--agent`, `--model`, `--mode`, `--thought`, and `--sandbox`.
- Add `revis resume` to reconnect to the active run, restore persisted sessions/sandboxes, and restart the foreground coordinator after a crash or manual detach.
- `revis status` reads the active run store and optionally probes live sandbox/session health instead of calling a daemon API.
- `revis events` reads `revis-events.jsonl` and follows the active run locally instead of daemon SSE.
- `revis stop [agent-id|--all]` destroys participant sandboxes directly and closes the run when everything is stopped.
- Keep `revis version`. Remove the hidden `_daemon-run` command.

## Validation
- Run `npm run typecheck` and `npm run build`.
- Manual smokes on a real repo:
  - `revis spawn 2 "<task>"` with `sandbox=local`, confirm worktrees, sessions, relays, and branch pushes
  - kill the foreground process, run `revis resume`, confirm sessions reconnect and coordination resumes
  - `revis stop --all`, confirm all sandboxes/worktrees are destroyed and run state closes cleanly
  - `revis promote agent-1`, confirm dirty-tree refusal and clean PR creation/reuse on a real remote
  - one non-local smoke with `daytona` or `e2b`, confirming remote clone, prompt execution, event persistence, and promotion

## Assumptions
- Chosen defaults:
  - foreground `spawn` is the live coordinator
  - remote-first Git flow
  - completed-turn relay policy
  - no custom dashboard UI
- Non-local sandboxes require a network-accessible git remote and working auth inside the sandbox. v1 does not upload local repo snapshots into remote sandboxes.
- README install/usage/requirements sections will become stale because the CLI and dependencies change; those sections need updating during implementation, but broader README wording should stay untouched unless you explicitly request it.
- Automated test-suite rewrites are excluded unless you explicitly authorize test-suite changes; validation for this migration is manual smokes plus type/build checks.
