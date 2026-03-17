import { createWorkspaceProviderForKind } from "../src/coordination/provider";

describe("daytona provider", () => {
  test("rejects local coordination remotes before contacting Daytona", async () => {
    const provider = createWorkspaceProviderForKind("daytona");

    await expect(
      provider.createWorkspace({
        root: "/tmp/revis",
        remoteName: "revis-local",
        remoteUrl: "/tmp/revis/coordination.git",
        syncBranch: "revis/trunk",
        operatorSlug: "alice",
        agentId: "agent-1",
        coordinationBranch: "revis/alice/agent-1/work",
        execCommand: "sleep 1"
      })
    ).rejects.toThrow(
      "Daytona workspaces require a network-accessible git remote. Local revis-local paths are not supported."
    );
  });
});
