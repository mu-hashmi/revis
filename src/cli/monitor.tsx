/**
 * Broken Ink monitor for live daemon and workspace state.
 *
 * This code is intentionally kept in-tree for future repair, but the public
 * `revis monitor` command is disabled and hidden from user-facing docs.
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import type { WorkspaceRecord } from "../core/models";
import type { StatusSnapshot } from "../coordination/status";
import { loadStatusSnapshot } from "../coordination/status";

const REFRESH_INTERVAL_MS = 1000;
const SIDEBAR_MIN_WIDTH = 28;
const SIDEBAR_MAX_WIDTH = 38;

type MonitorTab = "activity" | "events";

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
  const { stdout } = useStdout();
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const snapshot = useMonitorSnapshot(root, manualRefreshTick);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [tab, setTab] = useState<MonitorTab>("activity");

  useInput((input, key) => {
    handleMonitorInput({
      exit,
      input,
      key,
      onExit,
      refresh: () => {
        setManualRefreshTick((current) => current + 1);
      },
      selectedIndex,
      setSelectedIndex,
      setTab,
      snapshot,
      tab
    });
  });

  if (!snapshot) {
    return <Text>Loading Revis monitor...</Text>;
  }

  const width = Math.max(stdout.columns ?? 100, 80);
  const sidebarWidth = clamp(Math.floor(width * 0.3), SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header snapshot={snapshot} />
      <Box marginTop={1} flexDirection="row" columnGap={1}>
        <WorkspacePanel
          selectedIndex={selectedIndex}
          snapshot={snapshot}
          width={sidebarWidth}
        />
        <InspectorPanel
          selectedIndex={selectedIndex}
          snapshot={snapshot}
          tab={tab}
          width={Math.max(width - sidebarWidth - 4, 40)}
        />
      </Box>
      <Footer tab={tab} />
    </Box>
  );
}

/** Poll the runtime snapshot that backs the monitor UI. */
function useMonitorSnapshot(
  root: string,
  manualRefreshTick: number
): StatusSnapshot | null {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const snapshotFingerprint = useRef("");

  useEffect(() => {
    let active = true;

    const applySnapshot = (next: StatusSnapshot): void => {
      const fingerprint = JSON.stringify(next);
      if (!active || fingerprint === snapshotFingerprint.current) {
        return;
      }

      snapshotFingerprint.current = fingerprint;
      setSnapshot(next);
    };

    const refresh = async (): Promise<void> => {
      applySnapshot(
        await loadStatusSnapshot(root, {
          includeGitDetails: false,
          refresh: true
        })
      );
    };

    const poll = async (): Promise<void> => {
      applySnapshot(
        await loadStatusSnapshot(root, {
          includeGitDetails: false,
          refresh: false
        })
      );
    };

    void refresh();

    const timer = setInterval(() => {
      void poll();
    }, REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [root]);

  useEffect(() => {
    if (manualRefreshTick === 0) {
      return;
    }

    let active = true;

    const refresh = async (): Promise<void> => {
      const next = await loadStatusSnapshot(root, {
        includeGitDetails: false,
        refresh: true
      });
      const fingerprint = JSON.stringify(next);
      if (!active || fingerprint === snapshotFingerprint.current) {
        return;
      }

      snapshotFingerprint.current = fingerprint;
      setSnapshot(next);
    };

    void refresh();

    return () => {
      active = false;
    };
  }, [manualRefreshTick, root]);

  return snapshot;
}

/** Handle keyboard input for navigation, refresh, attach, and quit. */
function handleMonitorInput(options: {
  exit: () => void;
  input: string;
  key: {
    downArrow?: boolean;
    escape?: boolean;
    leftArrow?: boolean;
    return?: boolean;
    rightArrow?: boolean;
    tab?: boolean;
    upArrow?: boolean;
  };
  onExit: (exit: MonitorExit) => void;
  refresh: () => void;
  selectedIndex: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setTab: React.Dispatch<React.SetStateAction<MonitorTab>>;
  snapshot: StatusSnapshot | null;
  tab: MonitorTab;
}): void {
  const {
    exit,
    input,
    key,
    onExit,
    refresh,
    selectedIndex,
    setSelectedIndex,
    setTab,
    snapshot,
    tab
  } = options;

  if (shouldQuit(input, key)) {
    quitMonitor(onExit, exit);
    return;
  }

  if (input === "r") {
    refresh();
    return;
  }

  if (input === "\t" || key.tab) {
    setTab((current) => (current === "activity" ? "events" : "activity"));
    return;
  }

  if (input === "h" || key.leftArrow) {
    setTab("activity");
    return;
  }

  if (input === "l" || key.rightArrow) {
    setTab("events");
    return;
  }

  if (input === "1") {
    setTab("activity");
    return;
  }

  if (input === "2") {
    setTab("events");
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

/** Render the monitor header with the current daemon and repo context. */
function Header({ snapshot }: { snapshot: StatusSnapshot }): React.JSX.Element {
  const workspacesLabel =
    snapshot.workspaces.length === 1 ? "1 workspace" : `${snapshot.workspaces.length} workspaces`;

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Text bold>Revis Monitor</Text>
        <Text color={snapshot.daemonHealthy ? "green" : "red"}>
          {snapshot.daemonHealthy ? "daemon up" : "daemon down"}
        </Text>
      </Box>
      <Text wrap="truncate-end">
        {snapshot.operatorSlug} on {snapshot.config.coordinationRemote}/{snapshot.syncBranch} •{" "}
        {workspacesLabel}
      </Text>
    </Box>
  );
}

/** Render the workspace selector sidebar. */
function WorkspacePanel(options: {
  selectedIndex: number;
  snapshot: StatusSnapshot;
  width: number;
}): React.JSX.Element {
  const { selectedIndex, snapshot, width } = options;

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
      width={width}
    >
      <SectionTitle title="Workspaces" />
      {snapshot.workspaces.length === 0 ? (
        <Text color="yellow">No workspaces yet.</Text>
      ) : (
        snapshot.workspaces.map((workspace, index) => (
          <WorkspaceRow
            key={workspace.agentId}
            isSelected={index === selectedIndex}
            workspace={workspace}
            width={width - 4}
          />
        ))
      )}
    </Box>
  );
}

/** Render the detail area for the selected workspace. */
function InspectorPanel(options: {
  selectedIndex: number;
  snapshot: StatusSnapshot;
  tab: MonitorTab;
  width: number;
}): React.JSX.Element {
  const { selectedIndex, snapshot, tab, width } = options;
  const selected = snapshot.workspaces[selectedIndex] ?? null;
  const events = snapshot.events.slice(-10).reverse();

  if (!selected) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
        flexGrow={1}
        width={width}
      >
        <SectionTitle title="Details" />
        <Text color="gray">Create a workspace to inspect live activity.</Text>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
      flexGrow={1}
      width={width}
    >
      <WorkspaceInspectorHeader workspace={selected} width={width - 4} />
      <TabBar tab={tab} />
      {tab === "activity" ? (
        <ActivityFeed
          lines={snapshot.activity[selected.agentId] ?? []}
          width={width - 4}
        />
      ) : (
        <EventFeed events={events} width={width - 4} />
      )}
    </Box>
  );
}

/** Render one selected-workspace header card. */
function WorkspaceInspectorHeader(options: {
  workspace: WorkspaceRecord;
  width: number;
}): React.JSX.Element {
  const { workspace, width } = options;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold>{workspace.agentId}</Text>
        <Text color={stateColor(workspace.state)}>[{workspace.state}]</Text>
      </Box>
      <Text wrap="truncate-end">{truncateEnd(workspace.attachCmd.join(" "), width)}</Text>
      <Text color="gray" wrap="truncate-end">
        local {truncateEnd(workspace.localBranch, width - 6)}
      </Text>
      <Text color="gray" wrap="truncate-end">
        coord {truncateEnd(workspace.coordinationBranch, width - 6)}
      </Text>
    </Box>
  );
}

/** Render the activity/events tab selector. */
function TabBar({ tab }: { tab: MonitorTab }): React.JSX.Element {
  return (
    <Box marginBottom={1}>
      <Text color={tab === "activity" ? "cyan" : "gray"} bold={tab === "activity"}>
        [1] Activity
      </Text>
      <Text>  </Text>
      <Text color={tab === "events" ? "cyan" : "gray"} bold={tab === "events"}>
        [2] Events
      </Text>
    </Box>
  );
}

/** Render the latest pane output for the selected workspace. */
function ActivityFeed(options: {
  lines: string[];
  width: number;
}): React.JSX.Element {
  const { lines, width } = options;
  const visible = lines.slice(-14);

  if (visible.length === 0) {
    return <Text color="gray">No captured output yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {visible.map((line, index) => (
        <Text key={`activity-${index}`} wrap="truncate-end">
          {truncateEnd(line, width)}
        </Text>
      ))}
    </Box>
  );
}

/** Render the recent daemon event feed. */
function EventFeed(options: {
  events: StatusSnapshot["events"];
  width: number;
}): React.JSX.Element {
  const { events, width } = options;

  if (events.length === 0) {
    return <Text color="gray">No events yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {events.map((event, index) => (
        <Text key={`${event.timestamp}-${index}`} wrap="truncate-end">
          {truncateEnd(`${shortTimestamp(event.timestamp)}  ${event.summary}`, width)}
        </Text>
      ))}
    </Box>
  );
}

/** Render one workspace row inside the sidebar list. */
function WorkspaceRow(options: {
  isSelected: boolean;
  workspace: WorkspaceRecord;
  width: number;
}): React.JSX.Element {
  const { isSelected, workspace, width } = options;
  const badge = workspace.state.toUpperCase();
  const label = truncateEnd(`${workspace.agentId}  ${badge}`, width - 2);

  return (
    <Text
      color={isSelected ? "cyan" : stateColor(workspace.state)}
      bold={isSelected}
      wrap="truncate-end"
    >
      {isSelected ? ">" : " "} {label}
    </Text>
  );
}

/** Render the persistent monitor keybinding hint row. */
function Footer({ tab }: { tab: MonitorTab }): React.JSX.Element {
  const tabHint = tab === "activity" ? "activity selected" : "events selected";

  return (
    <Box marginTop={1}>
      <Text color="gray">
        j/k move  •  enter attach  •  tab or 1/2 switch panes ({tabHint})  •  r refresh  •
        {" "}q quit
      </Text>
    </Box>
  );
}

/** Render one small section title. */
function SectionTitle({ title }: { title: string }): React.JSX.Element {
  return (
    <Box marginBottom={1}>
      <Text bold>{title}</Text>
    </Box>
  );
}

/** Return whether the current keypress should close the monitor. */
function shouldQuit(
  input: string,
  key: { escape?: boolean }
): boolean {
  return input === "q" || Boolean(key.escape);
}

/** Move the highlighted workspace selection by one step. */
function moveSelection(current: number, delta: number, size: number): number {
  return Math.max(0, Math.min(current + delta, size - 1));
}

/** Return the display color for a workspace state. */
function stateColor(state: WorkspaceRecord["state"]): string {
  switch (state) {
    case "active":
      return "green";
    case "failed":
      return "red";
    case "stopping":
    case "starting":
      return "yellow";
    default:
      return "gray";
  }
}

/** Clamp one numeric value into the provided range. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** Keep one monitor line inside its available terminal width. */
function truncateEnd(value: string, width: number): string {
  if (width <= 1 || value.length <= width) {
    return value;
  }

  return `${value.slice(0, width - 1)}…`;
}

/** Format one ISO timestamp for compact monitor display. */
function shortTimestamp(timestamp: string): string {
  return timestamp.slice(11, 19);
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
