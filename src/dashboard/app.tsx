/** React dashboard for browsing archived Revis sessions and live timelines. */

import React, {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from "react";

import type { RuntimeEvent, SessionMeta, SessionSummary } from "../core/models";
import {
  fetchCommitDetail,
  fetchSessionEvents,
  fetchSessionMeta,
  fetchSessions
} from "./api";
import {
  chooseTickMinutes,
  formatClock,
  formatElapsed,
  minutesSince,
  shortSessionId
} from "./time";

const PX_PER_MINUTE = 12;
const HEADER_HEIGHT = 44;
const LANE_HEIGHT = 92;
const LANE_LABEL_WIDTH = 144;
const EVENT_TYPES = [
  { key: "commit", label: "Commits" },
  { key: "relay", label: "Relays" },
  { key: "system", label: "System" }
] as const;
const AGENT_COLORS = ["#38bdf8", "#f59e0b", "#34d399", "#a78bfa", "#f97316", "#f472b6"];

type TimelineKind = (typeof EVENT_TYPES)[number]["key"];

interface TimelineEvent {
  agentId: string | null;
  event: RuntimeEvent;
  key: string;
  kind: TimelineKind;
  minutes: number;
}

/** Render the Revis dashboard shell. */
export function DashboardApp(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<TimelineKind>>(
    () => new Set(EVENT_TYPES.map((eventType) => eventType.key))
  );
  const [hoveredEventKey, setHoveredEventKey] = useState<string | null>(null);
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<[number, number]>([0, 1]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commitDetails, setCommitDetails] = useState<Record<string, string>>({});
  const [commitErrors, setCommitErrors] = useState<Record<string, string>>({});
  const durationRef = useRef(1);

  const refreshSessions = useEffectEvent(async (): Promise<void> => {
    try {
      const nextSessions = await fetchSessions();
      startTransition(() => {
        setSessions(nextSessions);
        setSelectedSessionId((current) => {
          if (current && nextSessions.some((session) => session.id === current)) {
            return current;
          }

          return (
            nextSessions.find((session) => session.endedAt === null)?.id ??
            nextSessions[0]?.id ??
            null
          );
        });
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoading(false);
    }
  });

  const refreshLiveFrame = useEffectEvent(async (sessionId: string): Promise<void> => {
    try {
      const [nextSessions, nextMeta] = await Promise.all([
        fetchSessions(),
        fetchSessionMeta(sessionId)
      ]);
      startTransition(() => {
        setSessions(nextSessions);
        setSessionMeta(nextMeta);
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  });

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSessionMeta(null);
      setEvents([]);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setLoadError(null);

    const load = async (): Promise<void> => {
      try {
        const [nextMeta, nextEvents] = await Promise.all([
          fetchSessionMeta(selectedSessionId),
          fetchSessionEvents(selectedSessionId)
        ]);
        if (!active) {
          return;
        }

        const rangeMax = Math.max(computeDurationMinutes(nextMeta, nextEvents), 1);
        durationRef.current = rangeMax;

        startTransition(() => {
          setSessionMeta(nextMeta);
          setEvents(nextEvents);
          setSelectedAgents(new Set(nextMeta.participants.map((participant) => participant.agentId)));
          setSelectedTypes(new Set(EVENT_TYPES.map((eventType) => eventType.key)));
          setHoveredEventKey(null);
          setSelectedEventKey(null);
          setTimeRange([0, rangeMax]);
        });
      } catch (error) {
        if (!active) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [selectedSessionId]);

  const handleSseMessage = useEffectEvent((payload: string): void => {
    const event = JSON.parse(payload) as RuntimeEvent;

    startTransition(() => {
      setEvents((current) => [...current, event]);
    });

    if (selectedSessionId) {
      void refreshLiveFrame(selectedSessionId);
    }
  });

  useEffect(() => {
    if (!sessionMeta || sessionMeta.endedAt !== null || sessionMeta.id !== selectedSessionId) {
      return;
    }

    const source = new EventSource("/events/stream");
    source.onmessage = (message) => {
      handleSseMessage(message.data);
    };
    source.onerror = () => {
      source.close();
    };

    return () => {
      source.close();
    };
  }, [handleSseMessage, selectedSessionId, sessionMeta]);

  const normalizedEvents = useMemo(() => {
    if (!sessionMeta) {
      return [];
    }

    return events.map((event, index) => ({
      event,
      key: `${index}:${event.timestamp}:${event.type}:${event.agentId ?? event.sourceAgentId ?? "na"}:${event.sha ?? "na"}`,
      kind: eventKind(event),
      agentId: timelineAgentId(event),
      minutes: minutesSince(sessionMeta.startedAt, event.timestamp)
    }));
  }, [events, sessionMeta]);

  const maxMinutes = useMemo(() => {
    if (!sessionMeta) {
      return 1;
    }

    return Math.max(computeDurationMinutes(sessionMeta, events), 1);
  }, [events, sessionMeta]);

  useEffect(() => {
    const previousMax = durationRef.current;
    if (previousMax === maxMinutes) {
      return;
    }

    setTimeRange((current) => {
      const pinnedToEnd = Math.abs(current[1] - previousMax) < 1;
      return pinnedToEnd ? [current[0], maxMinutes] : current;
    });
    durationRef.current = maxMinutes;
  }, [maxMinutes]);

  const laneAgents = sessionMeta?.participants.map((participant) => participant.agentId) ?? [];
  const visibleAgents = laneAgents.filter((agentId) => selectedAgents.has(agentId));

  const filteredEvents = useMemo(
    () =>
      normalizedEvents.filter((event) => {
        if (event.kind === "commit" || event.kind === "relay" || event.kind === "system") {
          if (!selectedTypes.has(event.kind)) {
            return false;
          }
        }

        if (event.agentId && !selectedAgents.has(event.agentId)) {
          return false;
        }

        return event.minutes >= timeRange[0] && event.minutes <= timeRange[1];
      }),
    [normalizedEvents, selectedAgents, selectedTypes, timeRange]
  );

  const visibleCounts = useMemo(
    () =>
      normalizedEvents.reduce(
        (counts, event) => {
          if (event.agentId && !selectedAgents.has(event.agentId)) {
            return counts;
          }

          if (event.minutes < timeRange[0] || event.minutes > timeRange[1]) {
            return counts;
          }

          counts[event.kind] += 1;
          return counts;
        },
        {
          commit: 0,
          relay: 0,
          system: 0
        }
      ),
    [normalizedEvents, selectedAgents, timeRange]
  );

  const sourceAnchors = useMemo(() => {
    const map = new Map<string, TimelineEvent>();

    for (const event of normalizedEvents) {
      if (event.minutes < timeRange[0] || event.minutes > timeRange[1]) {
        continue;
      }

      if (event.event.type === "branch_pushed" && event.event.branch && event.event.sha && event.agentId) {
        if (!selectedAgents.has(event.agentId)) {
          continue;
        }
        map.set(sourceKey(event.event.branch, event.event.sha), event);
      }

      if (event.event.type === "commit_relayed" && event.event.sourceBranch && event.event.sha && event.event.agentId) {
        if (!selectedAgents.has(event.event.agentId)) {
          continue;
        }
        const key = sourceKey(event.event.sourceBranch, event.event.sha);
        if (!map.has(key)) {
          map.set(key, event);
        }
      }
    }

    return map;
  }, [normalizedEvents, selectedAgents, timeRange]);

  const relayPairs = useMemo(
    () =>
      filteredEvents
        .filter((event) => event.event.type === "relay_received" && event.event.sourceBranch && event.event.sha)
        .map((relay) => {
          const source = sourceAnchors.get(sourceKey(relay.event.sourceBranch!, relay.event.sha!));
          return source ? { relay, source } : null;
        })
        .filter((pair): pair is { relay: TimelineEvent; source: TimelineEvent } => pair !== null),
    [filteredEvents, sourceAnchors]
  );

  const activeEvent =
    filteredEvents.find((event) => event.key === selectedEventKey) ??
    filteredEvents.find((event) => event.key === hoveredEventKey) ??
    null;

  const selectedCommitSha = activeEvent?.event.sha;
  useEffect(() => {
    if (!selectedCommitSha || commitDetails[selectedCommitSha] || commitErrors[selectedCommitSha]) {
      return;
    }

    let active = true;
    void fetchCommitDetail(selectedCommitSha)
      .then((detail) => {
        if (!active) {
          return;
        }

        setCommitDetails((current) => ({
          ...current,
          [selectedCommitSha]: detail
        }));
      })
      .catch((error) => {
        if (!active) {
          return;
        }

        setCommitErrors((current) => ({
          ...current,
          [selectedCommitSha]: error instanceof Error ? error.message : String(error)
        }));
      });

    return () => {
      active = false;
    };
  }, [commitDetails, commitErrors, selectedCommitSha]);

  const totalEvents = filteredEvents.length;
  const commitCount = filteredEvents.filter((event) => event.kind === "commit").length;
  const relayCount = filteredEvents.filter((event) => event.kind === "relay").length;
  const systemCount = filteredEvents.filter((event) => event.kind === "system").length;
  const tickMinutes = chooseTickMinutes(timeRange[1] - timeRange[0], PX_PER_MINUTE);
  const timelineWidth = Math.max((timeRange[1] - timeRange[0]) * PX_PER_MINUTE, 760);
  const tickValues = buildTickValues(timeRange[0], timeRange[1], tickMinutes);

  return (
    <div className="dashboard-shell">
      <header className="dashboard-topbar">
        <div className="wordmark">
          <span className="wordmark-brand">revis</span>
          <span className="wordmark-subtitle">dashboard</span>
        </div>
        <div className="topbar-divider" />
        <div className="topbar-meta">
          <span className="meta-label">session</span>
          <span className="meta-value">
            {sessionMeta ? shortSessionId(sessionMeta.id) : "none"}
          </span>
        </div>
        <div className="topbar-meta">
          <span className="meta-label">started</span>
          <span className="meta-value">
            {sessionMeta ? formatClock(sessionMeta.startedAt) : "--:--"}
          </span>
        </div>
        <div className="topbar-spacer" />
        <div className="topbar-stats">
          <span className="stat-chip">
            <strong>{totalEvents}</strong>
            <span>events</span>
          </span>
          <span className="stat-chip">
            <strong>{commitCount}</strong>
            <span>commits</span>
          </span>
          <span className="stat-chip">
            <strong>{relayCount}</strong>
            <span>relays</span>
          </span>
          <span className="stat-chip">
            <strong>{systemCount}</strong>
            <span>system</span>
          </span>
        </div>
      </header>

      <div className="dashboard-body">
        <aside className="sidebar">
          <section className="sidebar-section">
            <div className="section-label">Sessions</div>
            <div className="session-list">
              {sessions.length === 0 ? (
                <div className="empty-copy">No session archives yet. Run `revis spawn` to start one.</div>
              ) : (
                sessions.map((session) => (
                  <button
                    key={session.id}
                    className={`session-card ${selectedSessionId === session.id ? "is-selected" : ""}`}
                    onClick={() => {
                      startTransition(() => {
                        setSelectedSessionId(session.id);
                      });
                    }}
                    type="button"
                  >
                    <div className="session-card-header">
                      <span>{shortSessionId(session.id)}</span>
                      <span className={`session-badge ${session.endedAt === null ? "is-live" : ""}`}>
                        {session.endedAt === null ? "live" : "archived"}
                      </span>
                    </div>
                    <div className="session-card-meta">
                      <span>{formatClock(session.startedAt)}</span>
                      <span>{session.participantCount} lanes</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="sidebar-section">
            <div className="section-label">Agents</div>
            <div className="filter-list">
              {laneAgents.map((agentId, index) => (
                <button
                  key={agentId}
                  className={`filter-row ${selectedAgents.has(agentId) ? "is-selected" : ""}`}
                  onClick={() => toggleSetValue(setSelectedAgents, agentId)}
                  type="button"
                >
                  <span
                    className="filter-swatch"
                    style={{ background: agentColor(agentId, index) }}
                  />
                  <span className="filter-label">{agentId}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="sidebar-section">
            <div className="section-label">Event Types</div>
            <div className="filter-list">
              {EVENT_TYPES.map((eventType) => (
                <button
                  key={eventType.key}
                  className={`filter-row ${selectedTypes.has(eventType.key) ? "is-selected" : ""}`}
                  onClick={() => toggleSetValue(setSelectedTypes, eventType.key)}
                  type="button"
                >
                  <span className={`filter-icon kind-${eventType.key}`} />
                  <span className="filter-label">{eventType.label}</span>
                  <span className="filter-count">{visibleCounts[eventType.key]}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="sidebar-section">
            <div className="section-label">Time Range</div>
            <div className="range-label">
              {formatElapsed(timeRange[0])} - {formatElapsed(timeRange[1])}
            </div>
            <div className="range-sliders">
              <input
                type="range"
                min={0}
                max={Math.ceil(maxMinutes)}
                step={1}
                value={timeRange[0]}
                onChange={(event) =>
                  setTimeRange(([_, end]) => [
                    Math.min(Number(event.target.value), Math.max(end - 1, 0)),
                    end
                  ])
                }
              />
              <input
                type="range"
                min={0}
                max={Math.ceil(maxMinutes)}
                step={1}
                value={timeRange[1]}
                onChange={(event) =>
                  setTimeRange(([start]) => [
                    start,
                    Math.max(Number(event.target.value), start + 1)
                  ])
                }
              />
            </div>
          </section>

          <section className="sidebar-section detail-panel">
            <div className="section-label">{activeEvent ? "Event Detail" : "Recent Activity"}</div>
            {activeEvent ? (
              <div className="detail-card">
                <div className={`detail-kind kind-${activeEvent.kind}`}>{labelForKind(activeEvent.kind)}</div>
                <div className="detail-title">{activeEvent.event.summary}</div>
                <div className="detail-meta">
                  {activeEvent.agentId ? <span>{activeEvent.agentId}</span> : null}
                  <span>{formatClock(activeEvent.event.timestamp)}</span>
                  {activeEvent.event.sha ? <span>{activeEvent.event.sha.slice(0, 8)}</span> : null}
                  {activeEvent.event.deliveryMode ? <span>{activeEvent.event.deliveryMode}</span> : null}
                </div>
                {activeEvent.event.sourceBranch ? (
                  <div className="detail-line">from {activeEvent.event.sourceBranch}</div>
                ) : null}
                {activeEvent.event.destinationBranch ? (
                  <div className="detail-line">to {activeEvent.event.destinationBranch}</div>
                ) : null}
                {selectedCommitSha ? (
                  commitDetails[selectedCommitSha] ? (
                    <pre className="detail-pre">{commitDetails[selectedCommitSha]}</pre>
                  ) : commitErrors[selectedCommitSha] ? (
                    <div className="detail-error">{commitErrors[selectedCommitSha]}</div>
                  ) : (
                    <div className="detail-loading">Loading commit detail…</div>
                  )
                ) : activeEvent.event.metadata ? (
                  <pre className="detail-pre">{JSON.stringify(activeEvent.event.metadata, null, 2)}</pre>
                ) : null}
              </div>
            ) : (
              <div className="recent-list">
                {events.slice(-8).reverse().map((event, index) => (
                  <button
                    key={`${index}:${event.timestamp}:${event.type}`}
                    className="recent-row"
                    onClick={() => {
                      const match = normalizedEvents.find((candidate) => candidate.event === event);
                      if (match) {
                        setSelectedEventKey(match.key);
                      }
                    }}
                    type="button"
                  >
                    <span className={`recent-kind kind-${eventKind(event)}`} />
                    <span className="recent-copy">{event.summary}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </aside>

        <main className="timeline-panel">
          {loadError ? <div className="state-card error-state">{loadError}</div> : null}
          {!loadError && loading ? <div className="state-card">Loading session…</div> : null}
          {!loadError && !loading && !sessionMeta ? (
            <div className="state-card">No session selected.</div>
          ) : null}
          {!loadError && !loading && sessionMeta ? (
            <div className="timeline-scroll">
              <div
                className="timeline-canvas"
                style={{ minWidth: `${timelineWidth + LANE_LABEL_WIDTH + 80}px` }}
              >
                <div className="lane-labels" style={{ top: 0 }}>
                  <div className="lane-label-header" />
                  {visibleAgents.map((agentId, index) => (
                    <div className="lane-label" key={agentId}>
                      <span
                        className="lane-dot"
                        style={{ background: agentColor(agentId, index) }}
                      />
                      <span>{agentId}</span>
                    </div>
                  ))}
                </div>

                <div className="timeline-stage" style={{ marginLeft: `${LANE_LABEL_WIDTH}px` }}>
                  <div className="timeline-axis">
                    {tickValues.map((tick) => (
                      <div
                        className="axis-tick"
                        key={tick}
                        style={{ left: `${(tick - timeRange[0]) * PX_PER_MINUTE}px` }}
                      >
                        {formatElapsed(tick)}
                      </div>
                    ))}
                  </div>

                  <svg
                    className="timeline-grid"
                    width={timelineWidth + 48}
                    height={HEADER_HEIGHT + visibleAgents.length * LANE_HEIGHT}
                    viewBox={`0 0 ${timelineWidth + 48} ${HEADER_HEIGHT + visibleAgents.length * LANE_HEIGHT}`}
                  >
                    {tickValues.map((tick) => {
                      const x = (tick - timeRange[0]) * PX_PER_MINUTE;
                      return (
                        <line
                          key={tick}
                          className="grid-line"
                          x1={x}
                          y1={HEADER_HEIGHT}
                          x2={x}
                          y2={HEADER_HEIGHT + visibleAgents.length * LANE_HEIGHT}
                        />
                      );
                    })}
                    {visibleAgents.map((agentId, laneIndex) => (
                      <line
                        key={agentId}
                        className="lane-line"
                        x1={0}
                        y1={HEADER_HEIGHT + laneIndex * LANE_HEIGHT}
                        x2={timelineWidth + 48}
                        y2={HEADER_HEIGHT + laneIndex * LANE_HEIGHT}
                      />
                    ))}
                    {relayPairs.map(({ relay, source }) => {
                      const x1 = (source.minutes - timeRange[0]) * PX_PER_MINUTE;
                      const x2 = (relay.minutes - timeRange[0]) * PX_PER_MINUTE;
                      const y1 = laneCenter(source.agentId, visibleAgents);
                      const y2 = laneCenter(relay.agentId, visibleAgents);
                      if (y1 === null || y2 === null) {
                        return null;
                      }

                      const active =
                        relay.key === activeEvent?.key || source.key === activeEvent?.key;
                      const curve = `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
                      return (
                        <path
                          key={`${source.key}:${relay.key}`}
                          className={`relay-arc ${active ? "is-active" : ""}`}
                          d={curve}
                          style={{ stroke: agentColor(source.agentId ?? "agent-0", visibleAgents.indexOf(source.agentId ?? "agent-0")) }}
                        />
                      );
                    })}
                  </svg>

                  {visibleAgents.map((agentId, laneIndex) => {
                    const agentEvents = filteredEvents.filter((event) => event.agentId === agentId);
                    return (
                      <div className="timeline-lane" key={agentId}>
                        <div
                          className="lane-baseline"
                          style={{ background: `${agentColor(agentId, laneIndex)}20` }}
                        />
                        {agentEvents.map((event) => {
                          const left = (event.minutes - timeRange[0]) * PX_PER_MINUTE;
                          const isActive = event.key === activeEvent?.key;
                          const title = event.event.summary;

                          return (
                            <button
                              key={event.key}
                              className={`event-node kind-${event.kind} ${isActive ? "is-active" : ""}`}
                              onClick={() =>
                                setSelectedEventKey((current) =>
                                  current === event.key ? null : event.key
                                )
                              }
                              onMouseEnter={() => setHoveredEventKey(event.key)}
                              onMouseLeave={() => setHoveredEventKey(null)}
                              style={{
                                left: `${left}px`,
                                ["--event-color" as string]: agentColor(agentId, laneIndex)
                              }}
                              title={title}
                              type="button"
                            >
                              <span className="event-tooltip">
                                <strong>{title}</strong>
                                <span>
                                  {formatClock(event.event.timestamp)}
                                  {event.event.sha ? ` · ${event.event.sha.slice(0, 8)}` : ""}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

/** Toggle one string member inside a Set-backed React state value. */
function toggleSetValue<T extends string>(
  setter: React.Dispatch<React.SetStateAction<Set<T>>>,
  value: T
): void {
  setter((current) => {
    const next = new Set(current);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    return next;
  });
}

/** Return the timeline kind used by the dashboard filters and nodes. */
function eventKind(event: RuntimeEvent): TimelineKind {
  if (event.type === "branch_pushed") {
    return "commit";
  }

  if (event.type === "relay_received") {
    return "relay";
  }

  return "system";
}

/** Return the lane agent id for one event when it belongs on a swim lane. */
function timelineAgentId(event: RuntimeEvent): string | null {
  if (event.type === "relay_received") {
    return event.destinationAgentId ?? event.agentId ?? null;
  }

  return event.agentId ?? null;
}

/** Return the session duration in minutes from metadata plus event bounds. */
function computeDurationMinutes(meta: SessionMeta, events: RuntimeEvent[]): number {
  const endTimestamp =
    meta.endedAt ??
    events.at(-1)?.timestamp ??
    new Date().toISOString();
  return minutesSince(meta.startedAt, endTimestamp);
}

/** Build tick values for the current visible time window. */
function buildTickValues(start: number, end: number, step: number): number[] {
  const first = Math.ceil(start / step) * step;
  const values: number[] = [];

  for (let current = first; current <= end; current += step) {
    values.push(current);
  }

  if (!values.includes(start)) {
    values.unshift(start);
  }

  return values;
}

/** Return the SVG lane-center y coordinate for one visible agent id. */
function laneCenter(agentId: string | null, visibleAgents: string[]): number | null {
  if (!agentId) {
    return null;
  }

  const laneIndex = visibleAgents.indexOf(agentId);
  if (laneIndex === -1) {
    return null;
  }

  return HEADER_HEIGHT + laneIndex * LANE_HEIGHT + LANE_HEIGHT / 2;
}

/** Return the lookup key shared by source commit anchors and relay destinations. */
function sourceKey(branch: string, sha: string): string {
  return `${branch}:${sha}`;
}

/** Return the label text used in the detail panel. */
function labelForKind(kind: TimelineKind): string {
  switch (kind) {
    case "commit":
      return "Commit";
    case "relay":
      return "Relay";
    default:
      return "System";
  }
}

/** Return a stable color from the fixed dashboard palette. */
function agentColor(agentId: string, laneIndex: number): string {
  const match = /^agent-(\d+)$/.exec(agentId);
  const paletteIndex = match ? (Number(match[1]) - 1) % AGENT_COLORS.length : laneIndex % AGENT_COLORS.length;
  return AGENT_COLORS[(paletteIndex + AGENT_COLORS.length) % AGENT_COLORS.length]!;
}
