/** Ink monitor for daemon and workspace state. */

import React, { useEffect, useState } from "react";
import { Box, Newline, Text, useApp, useInput } from "ink";

import type { WorkspaceRecord } from "../core/models";
import type { StatusSnapshot } from "../coordination/status";
import { loadStatusSnapshot } from "../coordination/status";
import {
  formatDaemonHealth,
  formatStatusContext,
  formatWorkspaceSummary
} from "./status-presenter";

const REFRESH_INTERVAL_MS = 1000;

type MonitorExit =
  | {
      action: "quit";
    }
  | {
      action: "attach";
      record: WorkspaceRecord;
    };

export interface MonitorProps {
  root: string;
  onExit: (exit: MonitorExit) => void;
}

/** Render the live monitor and own its refresh and keyboard loop. */
export function MonitorApp({ root, onExit }: MonitorProps): React.JSX.Element {
  const { exit } = useApp();
  const snapshot = useMonitorSnapshot(root);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    handleMonitorInput({
      exit,
      input,
      key,
      onExit,
      selectedIndex,
      setSelectedIndex,
      snapshot
    });
  });

  if (!snapshot) {
    return <Text>Loading Revis monitor…</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>
        Revis monitor | {formatDaemonHealth(snapshot)} | {formatStatusContext(snapshot)}
      </Text>
      <Text>Enter/a attach • j/k move • q quit</Text>
      <Newline />
      <WorkspaceList selectedIndex={selectedIndex} snapshot={snapshot} />
      <Newline />
      <ActivityPanel selectedIndex={selectedIndex} snapshot={snapshot} />
      <Newline />
      <EventsPanel snapshot={snapshot} />
    </Box>
  );
}

/** Poll the runtime snapshot that backs the monitor UI. */
function useMonitorSnapshot(root: string): StatusSnapshot | null {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);

  useEffect(() => {
    let active = true;

    // Load once immediately, then keep refreshing while the UI is mounted.
    const refresh = async (): Promise<void> => {
      const next = await loadStatusSnapshot(root, {
        refresh: true
      });
      if (active) {
        setSnapshot(next);
      }
    };

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [root]);

  return snapshot;
}

/** Handle keyboard input for quitting, selection, and tmux attach. */
function handleMonitorInput(options: {
  exit: () => void;
  input: string;
  key: { downArrow: boolean; escape: boolean; return: boolean; upArrow: boolean };
  onExit: (exit: MonitorExit) => void;
  selectedIndex: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  snapshot: StatusSnapshot | null;
}): void {
  const { exit, input, key, onExit, selectedIndex, setSelectedIndex, snapshot } = options;
  if (shouldQuit(input, key)) {
    quitMonitor(onExit, exit);
    return;
  }

  if (!snapshot) {
    return;
  }

  if (key.upArrow || input === "k") {
    setSelectedIndex((current) => moveSelection(current, -1, snapshot.workspaces.length));
    return;
  }

  if (key.downArrow || input === "j") {
    setSelectedIndex((current) => moveSelection(current, 1, snapshot.workspaces.length));
    return;
  }

  const record = snapshot.workspaces[selectedIndex];
  if (!record || !(key.return || input === "a")) {
    return;
  }

  onExit({
    action: "attach",
    record
  });
  exit();
}

/** Render the workspace list inside the monitor body. */
function WorkspaceList({
  selectedIndex,
  snapshot
}: {
  selectedIndex: number;
  snapshot: StatusSnapshot;
}): React.JSX.Element {
  return (
    <>
      <Text>Workspaces</Text>
      {snapshot.workspaces.length === 0 ? (
        <Text color="yellow">No workspaces created yet.</Text>
      ) : (
        snapshot.workspaces.map((workspace, index) => (
          <WorkspaceRow
            key={workspace.agentId}
            isSelected={index === selectedIndex}
            workspace={workspace}
          />
        ))
      )}
    </>
  );
}

/** Render activity for the currently highlighted workspace. */
function ActivityPanel({
  selectedIndex,
  snapshot
}: {
  selectedIndex: number;
  snapshot: StatusSnapshot;
}): React.JSX.Element {
  const selected = selectedWorkspace(snapshot, selectedIndex);
  if (!selected) {
    return (
      <>
        <Text>Activity</Text>
        <Text color="gray">Select a workspace to inspect activity.</Text>
      </>
    );
  }

  return (
    <>
      <Text>Activity ({selected.agentId})</Text>
      {snapshot.activity[selected.agentId]!.slice(-12).map((line, index) => (
        <Text key={`${selected.agentId}-${index}`}>{line}</Text>
      ))}
    </>
  );
}

/** Render recent daemon and workspace events. */
function EventsPanel({ snapshot }: { snapshot: StatusSnapshot }): React.JSX.Element {
  return (
    <>
      <Text>Events</Text>
      {snapshot.events.slice(-8).map((event, index) => (
        <Text key={`${event.timestamp}-${index}`}>
          {event.timestamp} {event.summary}
        </Text>
      ))}
    </>
  );
}

/** Render one compact workspace row inside the monitor list. */
function WorkspaceRow({
  isSelected,
  workspace
}: {
  isSelected: boolean;
  workspace: WorkspaceRecord;
}): React.JSX.Element {
  const label = formatWorkspaceSummary(workspace);
  return (
    <Text {...(isSelected ? { color: "cyan" as const } : {})}>
      {isSelected ? ">" : " "} {label}
    </Text>
  );
}

/** Return whether the current keypress should close the monitor. */
function shouldQuit(
  input: string,
  key: { escape: boolean }
): boolean {
  return input === "q" || key.escape;
}

/** Move the highlighted workspace selection by one step. */
function moveSelection(current: number, delta: number, size: number): number {
  return Math.max(0, Math.min(current + delta, size - 1));
}

/** Return the currently highlighted workspace, if one exists. */
function selectedWorkspace(
  snapshot: StatusSnapshot,
  selectedIndex: number
): WorkspaceRecord | null {
  return snapshot.workspaces[selectedIndex] ?? null;
}

export type { MonitorExit };

/** Exit the monitor with a normal user-initiated quit action. */
function quitMonitor(
  onExit: (exit: MonitorExit) => void,
  exit: () => void
): void {
  onExit({
    action: "quit"
  });
  exit();
}
