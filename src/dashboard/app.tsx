/** React dashboard for browsing archived Revis sessions and live timelines. */

import React, {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from "react";

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { RuntimeEventSchema, type RuntimeEvent, type SessionMeta, type SessionSummary } from "../domain/models";
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
  { key: "iteration", label: "Iterations" },
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

interface TimelineCounts {
  commit: number;
  iteration: number;
  system: number;
}

interface DashboardDataState {
  events: RuntimeEvent[];
  loadError: string | null;
  loading: boolean;
  selectedSessionId: string | null;
  sessionMeta: SessionMeta | null;
  sessions: SessionSummary[];
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
}

interface TimelineModel {
  activeEvent: TimelineEvent | null;
  commitCount: number;
  eventsByAgent: ReadonlyMap<string, TimelineEvent[]>;
  filteredEvents: TimelineEvent[];
  iterationCount: number;
  laneAgents: string[];
  maxMinutes: number;
  normalizedEvents: TimelineEvent[];
  systemCount: number;
  tickMinutes: number;
  tickValues: number[];
  timelineWidth: number;
  totalEvents: number;
  visibleAgents: string[];
  visibleCounts: TimelineCounts;
}

/** Render the Revis dashboard shell. */
export function DashboardApp(): React.JSX.Element {
  const {
    events,
    loadError,
    loading,
    selectedSessionId,
    sessionMeta,
    sessions,
    setSelectedSessionId
  } = useDashboardData();

  // Keep UI-local filter and focus state outside the session-loading hook.
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<TimelineKind>>(
    () => new Set(EVENT_TYPES.map((eventType) => eventType.key))
  );
  const [hoveredEventKey, setHoveredEventKey] = useState<string | null>(null);
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<[number, number]>([0, 1]);
  const durationRef = useRef(1);

  useEffect(() => {
    if (!sessionMeta) {
      durationRef.current = 1;
      setSelectedAgents(new Set());
      setSelectedTypes(new Set(EVENT_TYPES.map((eventType) => eventType.key)));
      setHoveredEventKey(null);
      setSelectedEventKey(null);
      setTimeRange([0, 1]);
      return;
    }

    const rangeMax = Math.max(computeDurationMinutes(sessionMeta, events), 1);
    durationRef.current = rangeMax;
    setSelectedAgents(new Set(sessionMeta.participants.map((participant) => participant.agentId)));
    setSelectedTypes(new Set(EVENT_TYPES.map((eventType) => eventType.key)));
    setHoveredEventKey(null);
    setSelectedEventKey(null);
    setTimeRange([0, rangeMax]);
  }, [sessionMeta?.id]);

  const timeline = useTimelineModel(
    sessionMeta,
    events,
    selectedAgents,
    selectedTypes,
    timeRange,
    selectedEventKey,
    hoveredEventKey
  );
  const selectedCommitSha = timeline.activeEvent ? eventSha(timeline.activeEvent.event) : undefined;
  const { commitDetails, commitErrors } = useCommitLookup(selectedCommitSha);

  // Keep the right edge pinned when live data extends the visible duration.
  useEffect(() => {
    const previousMax = durationRef.current;
    if (previousMax === timeline.maxMinutes) {
      return;
    }

    setTimeRange((current) => {
      const pinnedToEnd = Math.abs(current[1] - previousMax) < 1;
      return pinnedToEnd ? [current[0], timeline.maxMinutes] : current;
    });
    durationRef.current = timeline.maxMinutes;
  }, [timeline.maxMinutes]);

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
            <strong>{timeline.totalEvents}</strong>
            <span>events</span>
          </span>
          <span className="stat-chip">
            <strong>{timeline.commitCount}</strong>
            <span>commits</span>
          </span>
          <span className="stat-chip">
            <strong>{timeline.iterationCount}</strong>
            <span>iterations</span>
          </span>
          <span className="stat-chip">
            <strong>{timeline.systemCount}</strong>
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
              {timeline.laneAgents.map((agentId, index) => (
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
                  <span className="filter-count">{timeline.visibleCounts[eventType.key]}</span>
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
                max={Math.ceil(timeline.maxMinutes)}
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
                max={Math.ceil(timeline.maxMinutes)}
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
            <div className="section-label">{timeline.activeEvent ? "Event Detail" : "Recent Activity"}</div>
            {timeline.activeEvent ? (
              <div className="detail-card">
                <div className={`detail-kind kind-${timeline.activeEvent.kind}`}>{labelForKind(timeline.activeEvent.kind)}</div>
                <div className="detail-title">{timeline.activeEvent.event.summary}</div>
                <div className="detail-meta">
                  {timeline.activeEvent.agentId ? <span>{timeline.activeEvent.agentId}</span> : null}
                  <span>{formatClock(timeline.activeEvent.event.timestamp)}</span>
                  {eventSha(timeline.activeEvent.event) ? (
                    <span>{eventSha(timeline.activeEvent.event)!.slice(0, 8)}</span>
                  ) : null}
                </div>
                {selectedCommitSha ? (
                  commitDetails[selectedCommitSha] ? (
                    <pre className="detail-pre">{commitDetails[selectedCommitSha]}</pre>
                  ) : commitErrors[selectedCommitSha] ? (
                    <div className="detail-error">{commitErrors[selectedCommitSha]}</div>
                  ) : (
                    <div className="detail-loading">Loading commit detail…</div>
                  )
                ) : eventMetadata(timeline.activeEvent.event) ? (
                  <pre className="detail-pre">{JSON.stringify(eventMetadata(timeline.activeEvent.event), null, 2)}</pre>
                ) : null}
              </div>
            ) : (
              <div className="recent-list">
                {events.slice(-8).reverse().map((event, index) => (
                  <button
                    key={`${index}:${event.timestamp}:${event._tag}`}
                    className="recent-row"
                    onClick={() => {
                      const match = timeline.normalizedEvents.find((candidate) => candidate.event === event);
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
                style={{ minWidth: `${timeline.timelineWidth + LANE_LABEL_WIDTH + 80}px` }}
              >
                <div className="lane-labels" style={{ top: 0 }}>
                  <div className="lane-label-header" />
                  {timeline.visibleAgents.map((agentId, index) => (
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
                    {timeline.tickValues.map((tick) => (
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
                    width={timeline.timelineWidth + 48}
                    height={HEADER_HEIGHT + timeline.visibleAgents.length * LANE_HEIGHT}
                    viewBox={`0 0 ${timeline.timelineWidth + 48} ${HEADER_HEIGHT + timeline.visibleAgents.length * LANE_HEIGHT}`}
                  >
                    {timeline.tickValues.map((tick) => {
                      const x = (tick - timeRange[0]) * PX_PER_MINUTE;
                      return (
                        <line
                          key={tick}
                          className="grid-line"
                          x1={x}
                          y1={HEADER_HEIGHT}
                          x2={x}
                          y2={HEADER_HEIGHT + timeline.visibleAgents.length * LANE_HEIGHT}
                        />
                      );
                    })}
                    {timeline.visibleAgents.map((agentId, laneIndex) => (
                      <line
                        key={agentId}
                        className="lane-line"
                        x1={0}
                        y1={HEADER_HEIGHT + laneIndex * LANE_HEIGHT}
                        x2={timeline.timelineWidth + 48}
                        y2={HEADER_HEIGHT + laneIndex * LANE_HEIGHT}
                      />
                    ))}
                  </svg>

                  {timeline.visibleAgents.map((agentId, laneIndex) => {
                    const agentEvents = timeline.eventsByAgent.get(agentId) ?? [];
                    return (
                      <div className="timeline-lane" key={agentId}>
                        <div
                          className="lane-baseline"
                          style={{ background: `${agentColor(agentId, laneIndex)}20` }}
                        />
                        {agentEvents.map((event) => {
                          const left = (event.minutes - timeRange[0]) * PX_PER_MINUTE;
                          const isActive = event.key === timeline.activeEvent?.key;
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
                                  {eventSha(event.event) ? ` · ${eventSha(event.event)!.slice(0, 8)}` : ""}
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

/** Load session archives, the selected session frame, and live SSE updates. */
function useDashboardData(): DashboardDataState {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Refresh the session list and keep the best available selection. */
  const refreshSessions = useEffectEvent(async (): Promise<void> => {
    try {
      const nextSessions = await fetchSessions();
      startTransition(() => {
        setSessions(nextSessions);
        setSelectedSessionId((current) => {
          // Keep the current selection when possible, otherwise prefer the live session and fall
          // back to the newest archived session.
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

  /** Refresh live-session metadata after streamed events may have changed archive state. */
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
      clearSelectedSessionFrame(setSessionMeta, setEvents, setLoading);
      return;
    }

    let active = true;
    setLoading(true);
    setLoadError(null);

    /** Load the selected session metadata plus its archived event backlog. */
    const load = async (): Promise<void> => {
      try {
        const { meta: nextMeta, events: nextEvents } = await loadSelectedSessionFrame(selectedSessionId);
        if (!active) {
          return;
        }

        startTransition(() => {
          setSessionMeta(nextMeta);
          setEvents(nextEvents);
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

  /** Append one streamed runtime event and refresh live session metadata around it. */
  const handleSseMessage = useEffectEvent((payload: string): void => {
    const decodedEvent = Schema.decodeUnknownEither(Schema.parseJson(RuntimeEventSchema))(payload);
    if (Either.isLeft(decodedEvent)) {
      // EventSource callbacks run outside the dashboard's request/load flow, so parse failures
      // must be surfaced into UI state explicitly instead of throwing out of band.
      setLoadError(String(decodedEvent.left));
      return;
    }

    const event = decodedEvent.right;

    startTransition(() => {
      setEvents((current) => [...current, event]);
    });

    if (selectedSessionId) {
      // Live events can update session participants and session liveness, not just the event list.
      void refreshLiveFrame(selectedSessionId);
    }
  });

  useEffect(() => {
    if (!sessionMeta || sessionMeta.endedAt !== null || sessionMeta.id !== selectedSessionId) {
      return;
    }

    const source = new EventSource("/api/events/stream");
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

  return {
    events,
    loadError,
    loading,
    selectedSessionId,
    sessionMeta,
    sessions,
    setSelectedSessionId
  };
}

/** Fetch commit detail lazily for the currently selected event, if any. */
function useCommitLookup(selectedCommitSha: string | undefined): {
  commitDetails: Record<string, string>;
  commitErrors: Record<string, string>;
} {
  const [commitDetails, setCommitDetails] = useState<Record<string, string>>({});
  const [commitErrors, setCommitErrors] = useState<Record<string, string>>({});

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

  return {
    commitDetails,
    commitErrors
  };
}

/** Clear the dashboard frame when no session is currently selected. */
function clearSelectedSessionFrame(
  setSessionMeta: React.Dispatch<React.SetStateAction<SessionMeta | null>>,
  setEvents: React.Dispatch<React.SetStateAction<RuntimeEvent[]>>,
  setLoading: React.Dispatch<React.SetStateAction<boolean>>
): void {
  setSessionMeta(null);
  setEvents([]);
  setLoading(false);
}

/** Load one selected session's metadata and archived event backlog together. */
async function loadSelectedSessionFrame(
  sessionId: string
): Promise<{ meta: SessionMeta; events: RuntimeEvent[] }> {
  const [meta, events] = await Promise.all([fetchSessionMeta(sessionId), fetchSessionEvents(sessionId)]);
  return { meta, events };
}

/** Build the filtered timeline model used by the dashboard render tree. */
function useTimelineModel(
  sessionMeta: SessionMeta | null,
  events: RuntimeEvent[],
  selectedAgents: Set<string>,
  selectedTypes: Set<TimelineKind>,
  timeRange: [number, number],
  selectedEventKey: string | null,
  hoveredEventKey: string | null
): TimelineModel {
  const normalizedEvents = useMemo(() => {
    if (!sessionMeta) {
      return [];
    }

    // Normalize raw runtime events into timeline nodes with stable keys and minute offsets.
    return events.map((event, index) => ({
      event,
      key: `${index}:${event.timestamp}:${event._tag}:${timelineAgentId(event) ?? "system"}:${eventSha(event) ?? "na"}`,
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

  const laneAgents = sessionMeta?.participants.map((participant) => participant.agentId) ?? [];
  const visibleAgents = laneAgents.filter((agentId) => selectedAgents.has(agentId));

  // Filter the normalized event list down to the currently visible lanes, event kinds, and range.
  const filteredEvents = useMemo(
    () => filterTimelineEvents(normalizedEvents, selectedAgents, selectedTypes, timeRange),
    [normalizedEvents, selectedAgents, selectedTypes, timeRange]
  );
  const eventsByAgent = useMemo(() => groupTimelineEventsByAgent(filteredEvents), [filteredEvents]);

  // Count only the currently visible events so sidebar filters track the active viewport.
  const visibleCounts = useMemo(
    () => countVisibleTimelineEvents(normalizedEvents, selectedAgents, timeRange),
    [normalizedEvents, selectedAgents, timeRange]
  );

  // Prefer explicit selection over hover state when deciding which event to show in detail.
  const activeEvent = resolveActiveTimelineEvent(filteredEvents, selectedEventKey, hoveredEventKey);
  const { commit: commitCount, iteration: iterationCount, system: systemCount } =
    countTimelineKinds(filteredEvents);
  const tickMinutes = chooseTickMinutes(PX_PER_MINUTE);
  const timelineWidth = Math.max((timeRange[1] - timeRange[0]) * PX_PER_MINUTE, 760);

  return {
    activeEvent,
    commitCount,
    eventsByAgent,
    filteredEvents,
    iterationCount,
    laneAgents,
    maxMinutes,
    normalizedEvents,
    systemCount,
    tickMinutes,
    tickValues: buildTickValues(timeRange[0], timeRange[1], tickMinutes),
    timelineWidth,
    totalEvents: filteredEvents.length,
    visibleAgents,
    visibleCounts
  };
}

/** Filter normalized timeline nodes down to the active viewport and filter state. */
function filterTimelineEvents(
  events: TimelineEvent[],
  selectedAgents: Set<string>,
  selectedTypes: Set<TimelineKind>,
  timeRange: [number, number]
): TimelineEvent[] {
  return events.filter((event) => {
    if (!selectedTypes.has(event.kind)) {
      return false;
    }

    if (event.agentId && !selectedAgents.has(event.agentId)) {
      return false;
    }

    return event.minutes >= timeRange[0] && event.minutes <= timeRange[1];
  });
}

/** Group visible timeline nodes by agent lane for render-time lookup. */
function groupTimelineEventsByAgent(
  events: TimelineEvent[]
): ReadonlyMap<string, TimelineEvent[]> {
  const grouped = new Map<string, TimelineEvent[]>();

  for (const event of events) {
    if (!event.agentId) {
      continue;
    }

    const current = grouped.get(event.agentId);
    if (current) {
      current.push(event);
      continue;
    }

    grouped.set(event.agentId, [event]);
  }

  return grouped;
}

/** Count visible timeline nodes by kind for the sidebar filter chips. */
function countVisibleTimelineEvents(
  events: TimelineEvent[],
  selectedAgents: Set<string>,
  timeRange: [number, number]
): TimelineCounts {
  return events.reduce<TimelineCounts>(
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
      iteration: 0,
      system: 0
    }
  );
}

/** Prefer explicit selection over hover state when choosing the detail panel event. */
function resolveActiveTimelineEvent(
  events: TimelineEvent[],
  selectedEventKey: string | null,
  hoveredEventKey: string | null
): TimelineEvent | null {
  return (
    events.find((event) => event.key === selectedEventKey) ??
    events.find((event) => event.key === hoveredEventKey) ??
    null
  );
}

/** Count the visible timeline nodes by display kind. */
function countTimelineKinds(events: TimelineEvent[]): TimelineCounts {
  return events.reduce<TimelineCounts>(
    (counts, event) => {
      counts[event.kind] += 1;
      return counts;
    },
    {
      commit: 0,
      iteration: 0,
      system: 0
    }
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
  if (event._tag === "BranchPublished" || event._tag === "Promoted") {
    return "commit";
  }

  if (
    event._tag === "IterationStarted" ||
    event._tag === "IterationExited" ||
    event._tag === "WorkspaceRestarted"
  ) {
    return "iteration";
  }

  return "system";
}

/** Return the lane agent id for one event when it belongs on a swim lane. */
function timelineAgentId(event: RuntimeEvent): string | null {
  return "agentId" in event ? event.agentId : null;
}

/** Return the commit SHA attached to one event, when present. */
function eventSha(event: RuntimeEvent): string | undefined {
  return "sha" in event ? event.sha : undefined;
}

/** Return the non-standard detail fields for one event, when present. */
function eventMetadata(event: RuntimeEvent): Record<string, unknown> | null {
  const { timestamp: _timestamp, summary: _summary, _tag: _tag, ...rest } = event as RuntimeEvent &
    Record<string, unknown>;

  // Agent and branch already live in dedicated UI chrome, so strip them to highlight the
  // event-specific fields in the metadata pane.
  delete rest.agentId;
  delete rest.branch;

  return Object.keys(rest).length > 0 ? rest : null;
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

/** Return the label text used in the detail panel. */
function labelForKind(kind: TimelineKind): string {
  switch (kind) {
    case "commit":
      return "Commit";
    case "iteration":
      return "Iteration";
    default:
      return "System";
  }
}

/** Return a stable color from the fixed dashboard palette. */
function agentColor(agentId: string, laneIndex: number): string {
  const match = /^agent-(\d+)$/.exec(agentId);
  // Prefer the numeric agent suffix so colors stay stable even if lane ordering changes.
  const paletteIndex = match ? (Number(match[1]) - 1) % AGENT_COLORS.length : laneIndex % AGENT_COLORS.length;
  return AGENT_COLORS[(paletteIndex + AGENT_COLORS.length) % AGENT_COLORS.length]!;
}
