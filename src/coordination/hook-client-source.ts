/** Source generation for the workspace post-commit hook client. */

/** Render the Node hook client that forwards post-commit events to the daemon. */
export function renderHookClientSource(
  agentId: string,
  branch: string,
  socketPath: string
): string {
  return `const net = require("node:net");
const { execFileSync } = require("node:child_process");

const socketPath = ${JSON.stringify(socketPath)};
const payload = ${renderPayloadSource(agentId, branch)};

const socket = net.createConnection(socketPath, () => {
  socket.end(JSON.stringify(payload) + "\\n");
});

const timeout = setTimeout(() => {
  socket.destroy(new Error("timed out notifying revis daemon"));
}, 1000);

socket.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exit(1);
});

socket.on("close", (hadError) => {
  clearTimeout(timeout);
  process.exit(hadError ? 1 : 0);
});
`;
}

/** Render the serialized commit payload embedded inside the hook script. */
function renderPayloadSource(agentId: string, branch: string): string {
  return `{
  type: "commit",
  agentId: ${JSON.stringify(agentId)},
  branch: ${JSON.stringify(branch)},
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
}`;
}
