/**
 * Broken attach-aware monitor session loop.
 *
 * This implementation is intentionally retained for future repair, but the
 * public `revis monitor` command is disabled and should not call into it.
 */

import React from "react";
import { render } from "ink";

import { runInteractive } from "../core/process";
import { MonitorApp, type MonitorExit } from "./monitor";

/** Run the monitor loop, re-entering Ink after tmux attaches return. */
export async function runMonitor(root: string): Promise<void> {
  while (true) {
    const exit = await runMonitorSession(root);
    if (exit.action !== "attach") {
      return;
    }

    await runInteractive(exit.record.attachCmd);
  }
}

/** Render one monitor instance and resolve when the user exits it. */
async function runMonitorSession(root: string): Promise<MonitorExit> {
  return new Promise<MonitorExit>((resolve, reject) => {
    const instance = render(
      React.createElement(MonitorApp, {
        root,
        onExit: resolve
      })
    );
    instance.waitUntilExit().catch(reject);
  });
}
