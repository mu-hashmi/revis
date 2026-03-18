/** Fake `HostGit` service backed by the orchestration model state. */

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { CommandError, ValidationError } from "../../../src/domain/errors";
import type { HostGitApi } from "../../../src/git/host-git";
import { remoteTrackingRef } from "../../../src/git/branch-names";
import type { Revision } from "../../../src/domain/models";
import type { OrchestrationState } from "./model";

/** Build the host git service for one orchestration test harness. */
export function buildHostGitService(
  state: OrchestrationState
): HostGitApi {
  return {
    resolveRepoRoot: (cwd) => Effect.succeed(cwd),
    isGitRepo: () => Effect.succeed(true),
    hasCommits: () => Effect.succeed(true),
    currentBranch: () => Effect.succeed("main" as never),
    remoteUrl: (_root, remoteName) =>
      Ref.get(state.remoteUrlsRef).pipe(
        Effect.flatMap((urls) =>
          urls.has(remoteName)
            ? Effect.succeed(urls.get(remoteName)!)
            : Effect.fail(
                ValidationError.make({
                  message: `Remote ${remoteName} is not configured`
                })
              )
        )
      ),
    determineRemoteName: () => Effect.succeed(state.config.coordinationRemote),
    ensureCoordinationRemote: () => Effect.succeed(`${state.root}/.revis/coordination.git`),
    addOrUpdateRemote: (_root, remoteName, url) =>
      Ref.update(state.remoteUrlsRef, (current) => new Map(current).set(remoteName, url)),
    bootstrapCoordinationRemote: (_root, remoteName, targetUrl, trunkBaseBranch) =>
      Effect.gen(function* () {
        yield* Ref.update(state.remoteUrlsRef, (current) => new Map(current).set(remoteName, targetUrl));

        const refs = yield* Ref.get(state.remoteRefsRef);
        const remote = refs.get(remoteName);

        // Managed-trunk repos may expose only the synthetic sync branch in tests, so allow either
        // the requested trunk base or the derived sync branch to satisfy bootstrap.
        if (!remote?.has(trunkBaseBranch) && !remote?.has(state.syncBranch)) {
          return yield* ValidationError.make({
            message: `Remote branch ${remoteName}/${trunkBaseBranch} does not exist.`
          });
        }
      }),
    remoteBranchExists: (_root, remoteName, branch) =>
      Ref.get(state.remoteRefsRef).pipe(
        Effect.map((refs) => refs.get(remoteName)?.has(branch) === true)
      ),
    fetchCoordinationRefs: (_root, remoteName, _syncBranch) =>
      Ref.get(state.remoteRefsRef).pipe(
        Effect.flatMap((refs) =>
          Ref.update(state.hostFetchedRefsRef, (current) => {
            const next = new Map(current);

            // Reconciles should only "see" refs after an explicit fetch, so update the fetched
            // view rather than reading from the remote ref store directly elsewhere.
            for (const [branch, sha] of refs.get(remoteName) ?? []) {
              next.set(remoteTrackingRef(remoteName, branch), sha);
            }

            return next;
          })
        )
      ),
    fetchRemoteRefs: () => unsupportedHostGit("fetchRemoteRefs"),
    cloneWorkspaceRepo: () => unsupportedHostGit("cloneWorkspaceRepo"),
    createBranchFromRemote: () => unsupportedHostGit("createBranchFromRemote"),
    setGitIdentity: () => Effect.void,
    workingTreeDirty: () => unsupportedHostGit("workingTreeDirty"),
    currentHeadSha: () => unsupportedHostGit("currentHeadSha"),
    resolveRefSha: (_root, ref) =>
      Ref.get(state.hostFetchedRefsRef).pipe(
        Effect.flatMap((refs) =>
          refs.has(ref)
            ? Effect.succeed(refs.get(ref)!)
            : ValidationError.make({
                message: `Could not resolve git ref ${ref}`
              })
        )
      ),
    currentHeadSubject: () => unsupportedHostGit("currentHeadSubject"),
    commitCountSinceRef: () => unsupportedHostGit("commitCountSinceRef"),
    deriveOperatorSlug: () => Effect.succeed(state.operatorSlug),
    listRemoteWorkspaceHeads: () => unsupportedHostGit("listRemoteWorkspaceHeads"),
    commitSummaryForRef: () => unsupportedHostGit("commitSummaryForRef"),
    pushBranch: () => unsupportedHostGit("pushBranch"),
    showCommit: () => unsupportedHostGit("showCommit")
  };
}

function unsupportedHostGit(method: string) {
  return CommandError.make({
    command: method,
    message: `${method} is not implemented by the orchestration harness`
  });
}
