/** Time-formatting helpers shared across the dashboard UI. */

/** Return elapsed minutes from one ISO timestamp baseline. */
export function minutesSince(startedAt: string, timestamp: string): number {
  return Math.max(0, (Date.parse(timestamp) - Date.parse(startedAt)) / 60_000);
}

/** Format a wall-clock timestamp for the dashboard header and details. */
export function formatClock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

/** Format one elapsed minute count for the axis and range labels. */
export function formatElapsed(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;

  if (hours === 0) {
    return `${remainder}m`;
  }

  return `${hours}h ${String(remainder).padStart(2, "0")}m`;
}

/** Choose a dense but readable tick interval for the current zoom level. */
export function chooseTickMinutes(pxPerMinute: number): number {
  const targetPx = 78;
  const candidates = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120];

  for (const candidate of candidates) {
    if (candidate * pxPerMinute >= targetPx) {
      return candidate;
    }
  }

  return candidates.at(-1)!;
}

/** Return a stable short label for one session id. */
export function shortSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}…`;
}
