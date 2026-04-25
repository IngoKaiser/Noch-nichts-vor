import type { Event, TimeFilter } from "./types";

/**
 * Compute the date range for a given filter.
 */
export function computeDateRange(
  filter: TimeFilter,
  customDate?: string,
  now: Date = new Date()
): { from: Date; to: Date; label: string } {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  if (filter === "today") {
    return { from: startOfDay, to: endOfDay, label: "heute" };
  }

  if (filter === "tonight") {
    const from = new Date(now);
    from.setHours(17, 0, 0, 0);
    return { from, to: endOfDay, label: "heute Abend" };
  }

  if (filter === "weekend") {
    const day = now.getDay(); // 0 So, 6 Sa
    const daysToSat = (6 - day + 7) % 7;
    const sat = new Date(startOfDay);
    sat.setDate(now.getDate() + daysToSat);
    const sunEnd = new Date(sat);
    sunEnd.setDate(sat.getDate() + 1);
    sunEnd.setHours(23, 59, 59, 999);
    return { from: sat, to: sunEnd, label: "Wochenende" };
  }

  if (filter === "custom" && customDate) {
    const from = new Date(customDate);
    from.setHours(0, 0, 0, 0);
    const to = new Date(customDate);
    to.setHours(23, 59, 59, 999);
    return { from, to, label: customDate };
  }

  return { from: startOfDay, to: endOfDay, label: "heute" };
}

/**
 * Filter events to those whose datetime falls within the given range.
 * Events with unparseable datetimes are kept (we'd rather show too many than too few).
 */
export function filterEventsByRange(
  events: Event[],
  from: Date,
  to: Date
): Event[] {
  return events.filter((e) => {
    const d = parseEventDate(e.datetime);
    if (!d) return true; // keep events with unknown date
    return d >= from && d <= to;
  });
}

function parseEventDate(s: string): Date | null {
  if (!s) return null;
  // Match "YYYY-MM-DD HH:MM" or "YYYY-MM-DD"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(
    parseInt(m[1]),
    parseInt(m[2]) - 1,
    parseInt(m[3]),
    m[4] ? parseInt(m[4]) : 0,
    m[5] ? parseInt(m[5]) : 0
  );
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Sort events chronologically. Events with no parseable date go last.
 */
export function sortEvents(events: Event[]): Event[] {
  return [...events].sort((a, b) => {
    const da = parseEventDate(a.datetime);
    const db = parseEventDate(b.datetime);
    if (da && db) return da.getTime() - db.getTime();
    if (da && !db) return -1;
    if (!da && db) return 1;
    return 0;
  });
}

/**
 * Deduplicate events by normalized (title, datetime) pair.
 * Same event reported by multiple sources gets merged into one.
 */
export function dedupeEvents(events: Event[]): Event[] {
  const seen = new Map<string, Event>();
  for (const ev of events) {
    const key = `${normalize(ev.title)}|${ev.datetime || ""}`;
    if (!seen.has(key)) {
      seen.set(key, ev);
    }
  }
  return Array.from(seen.values());
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
