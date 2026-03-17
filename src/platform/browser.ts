/** Browser launching helpers for operator-facing local URLs. */

import { spawn } from "node:child_process";

import * as Effect from "effect/Effect";

export interface OpenUrlOptions {
  readonly noOpen?: boolean;
  readonly stderr?: (text: string) => void;
  readonly stdout?: (text: string) => void;
}

/** Print one URL and optionally open it in the system browser. */
export function presentUrl(url: string, options: OpenUrlOptions = {}) {
  return Effect.sync(() => {
    const writeOut = options.stdout ?? ((text: string) => process.stdout.write(text));
    const writeErr = options.stderr ?? ((text: string) => process.stderr.write(text));

    writeOut(`${url}\n`);

    if (options.noOpen) {
      return;
    }

    try {
      openUrl(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeErr(`Could not open browser: ${message}\n`);
    }
  });
}

/** Open one URL in the system browser. */
export function openUrl(url: string): void {
  switch (process.platform) {
    case "darwin":
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return;
    case "win32":
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      return;
    default:
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}
