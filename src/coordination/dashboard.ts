/** Localhost dashboard server for Revis session archives and live timelines. */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { open as openFile, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { RevisError } from "../core/error";
import { runCommand } from "../core/process";
import { loadLiveSession, sessionEventsPath, sessionsDir } from "./runtime";

export interface DashboardServerOptions {
  noOpen?: boolean;
  port?: number;
  stderr?: (text: string) => void;
  stdout?: (text: string) => void;
}

interface JsonlTailState {
  offset: number;
  remainder: string;
}

/** Start the dashboard server, print its URL, and keep it alive until interrupted. */
export async function runDashboardServer(
  root: string,
  options: DashboardServerOptions = {}
): Promise<void> {
  const writeOut = options.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const dashboardRoot = fileURLToPath(new URL("../dashboard/", import.meta.url));
  const host = "127.0.0.1";

  const server = createServer(async (request, response) => {
    try {
      await handleDashboardRequest(root, dashboardRoot, request, response);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        respondText(response, 404, "Not found\n");
        return;
      }

      if (error instanceof RevisError && error.message.startsWith("Invalid dashboard path")) {
        respondText(response, 404, "Not found\n");
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      respondText(response, 500, `${message}\n`);
    }
  });

  const port = options.port ?? 0;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new RevisError("Dashboard server did not expose a TCP address");
  }

  const url = `http://${host}:${address.port}/`;
  writeOut(`${url}\n`);

  if (!options.noOpen) {
    try {
      launchBrowser(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeErr(`Could not open browser: ${message}\n`);
    }
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    const stop = (): void => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }

        resolveClose();
      });
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** Route one dashboard HTTP request. */
async function handleDashboardRequest(
  root: string,
  dashboardRoot: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    respondText(response, 405, "Method not allowed\n");
    return;
  }

  if (url.pathname === "/events/stream") {
    await streamLiveEvents(root, response);
    return;
  }

  if (url.pathname === "/git/show") {
    await respondGitShow(root, response, url.searchParams.get("sha"));
    return;
  }

  if (url.pathname === "/sessions" || url.pathname.startsWith("/sessions/")) {
    const relativePath =
      url.pathname === "/sessions" ? "index.json" : url.pathname.slice("/sessions/".length);
    await respondFile(
      response,
      await resolveSafePath(sessionsDir(root), relativePath),
      contentTypeForPath(relativePath)
    );
    return;
  }

  const assetPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const resolved = await resolveSafePath(dashboardRoot, assetPath);
  await respondFile(response, resolved, contentTypeForPath(assetPath));
}

/** Return git show output for one requested commit. */
async function respondGitShow(
  root: string,
  response: ServerResponse,
  sha: string | null
): Promise<void> {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    respondText(response, 400, "Expected a commit SHA\n");
    return;
  }

  const result = await runCommand(
    ["git", "show", "--stat", "--format=fuller", sha],
    {
      cwd: root,
      check: false
    }
  );
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "git show failed";
    respondText(response, 404, `${message}\n`);
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(result.stdout);
}

/** Stream appended live-session events over SSE. */
async function streamLiveEvents(root: string, response: ServerResponse): Promise<void> {
  const session = await loadLiveSession(root);
  if (!session) {
    respondText(response, 204, "");
    return;
  }

  const logPath = sessionEventsPath(root, session.id);
  const initial = await stat(logPath);
  let state: JsonlTailState = {
    offset: initial.size,
    remainder: ""
  };

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  response.write("retry: 1000\n\n");

  let closed = false;
  const close = (): void => {
    closed = true;
    clearInterval(timer);
  };

  response.on("close", close);
  response.on("error", close);

  const timer = setInterval(() => {
    void flushSseChunk();
  }, 750);

  const flushSseChunk = async (): Promise<void> => {
    if (closed) {
      return;
    }

    const live = await loadLiveSession(root);
    if (!live || live.id !== session.id) {
      response.end();
      close();
      return;
    }

    const next = await readAppendedJsonl(logPath, state);
    state = {
      offset: next.offset,
      remainder: next.remainder
    };

    for (const payload of next.lines) {
      response.write(`data: ${payload}\n\n`);
    }
  };
}

/** Read appended JSONL payloads from one event log. */
async function readAppendedJsonl(
  path: string,
  state: JsonlTailState
): Promise<{
  lines: string[];
  offset: number;
  remainder: string;
}> {
  const info = await stat(path);
  if (info.size <= state.offset) {
    return {
      lines: [],
      offset: state.offset,
      remainder: state.remainder
    };
  }

  const handle = await openFile(path, "r");
  const length = info.size - state.offset;
  const buffer = Buffer.alloc(length);

  try {
    await handle.read(buffer, 0, length, state.offset);
  } finally {
    await handle.close();
  }

  const chunk = `${state.remainder}${buffer.toString("utf8")}`;
  const complete = chunk.endsWith("\n");
  const parts = chunk.split(/\r?\n/);
  const remainder = complete ? "" : parts.pop() ?? "";

  return {
    lines: parts.filter(Boolean),
    offset: info.size,
    remainder
  };
}

/** Resolve one path under a trusted base directory. */
async function resolveSafePath(baseDir: string, unsafePath: string): Promise<string> {
  const candidate = resolve(baseDir, `.${sep}${unsafePath}`);
  const relativePath = relative(baseDir, candidate);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new RevisError(`Invalid dashboard path: ${unsafePath}`);
  }

  return candidate;
}

/** Serve one file response. */
async function respondFile(
  response: ServerResponse,
  path: string,
  contentType: string
): Promise<void> {
  const payload = await readFile(path);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(payload);
}

/** Write a plain-text HTTP response. */
function respondText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

/** Return the HTTP content type for one served file. */
function contentTypeForPath(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".jsonl":
      return "application/x-ndjson; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/** Launch the user's default browser for the local dashboard URL. */
function launchBrowser(url: string): void {
  const argv =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}
