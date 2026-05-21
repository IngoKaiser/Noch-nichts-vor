import type { Event, TimeFilter, RawEvent } from "./types";

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
    const day = now.getDay(); // 0 So, 1 Mo, ..., 6 Sa
    // Weekend = Saturday + Sunday.
    // If today is Saturday: today + tomorrow (Sun).
    // If today is Sunday: today only.
    // Otherwise: upcoming Saturday + Sunday.
    let satOffset: number;
    let durationDays: number;
    if (day === 6) {
      satOffset = 0; // today Sat
      durationDays = 1; // Sat + Sun
    } else if (day === 0) {
      satOffset = 0; // today Sun — start is today
      durationDays = 0; // only today
    } else {
      satOffset = 6 - day; // upcoming Sat
      durationDays = 1; // Sat + Sun
    }
    const start = new Date(startOfDay);
    start.setDate(now.getDate() + satOffset);
    const end = new Date(start);
    end.setDate(start.getDate() + durationDays);
    end.setHours(23, 59, 59, 999);
    return { from: start, to: end, label: "Wochenende" };
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
 * Strict filtering: events MUST have a parseable date that falls within the range.
 * Events without a parseable date are DROPPED (they can't be confirmed to match).
 *
 * Exception: when filter is "today", keep undated events — they MIGHT be ongoing.
 */
export function filterEventsByRange(
  events: Event[],
  from: Date,
  to: Date,
  isTodayFilter = false
): Event[] {
  return events.filter((e) => {
    const d = parseEventDate(e.datetime);
    if (!d) return isTodayFilter; // only keep undated events for "today"
    return d >= from && d <= to;
  });
}

/**
 * Same strict rule for RawEvent (pre-classification filter).
 */
export function filterRawEventsByRange(
  events: RawEvent[],
  from: Date,
  to: Date,
  isTodayFilter = false
): RawEvent[] {
  return events.filter((e) => {
    const d = parseEventDate(e.datetime);
    if (!d) return isTodayFilter;
    return d >= from && d <= to;
  });
}

/**
 * Robust date parsing — handles multiple common formats:
 * - "2026-05-03 19:30" or "2026-05-03T19:30:00"
 * - "2026-05-03"
 * - German "03.05.2026" or "03.05.2026 19:30"
 */
export function parseEventDate(s: string): Date | null {
  if (!s) return null;
  const trimmed = s.trim();

  // ISO-like
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (iso) {
    const d = new Date(
      parseInt(iso[1]),
      parseInt(iso[2]) - 1,
      parseInt(iso[3]),
      iso[4] ? parseInt(iso[4]) : 0,
      iso[5] ? parseInt(iso[5]) : 0
    );
    return isNaN(d.getTime()) ? null : d;
  }

  // German DD.MM.YYYY [HH:MM]
  const de = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,](\d{1,2}):(\d{2}))?/);
  if (de) {
    const d = new Date(
      parseInt(de[3]),
      parseInt(de[2]) - 1,
      parseInt(de[1]),
      de[4] ? parseInt(de[4]) : 0,
      de[5] ? parseInt(de[5]) : 0
    );
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
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
 * Aggressive deduplication.
 *
 * Two events are considered duplicates if:
 * - Same normalized title (Unicode-normalized, lowercased, punctuation stripped, whitespace collapsed)
 * - Same day (year-month-day, time ignored)
 *
 * When duplicates are found, the winner is the one with the most complete info:
 * - has event-specific URL > no URL
 * - has location > no location
 * - has cost > no cost
 * - longer description
 * - source adapter "jsonld" > "ical" > "rss" > "html"
 */
export function dedupeEvents(events: Event[]): Event[] {
  const seen = new Map<string, Event>();
  for (const ev of events) {
    const key = `${normalize(ev.title)}|${dayOf(ev.datetime)}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, ev);
    } else if (scoreEvent(ev) > scoreEvent(existing)) {
      seen.set(key, ev);
    }
  }
  return Array.from(seen.values());
}

/**
 * Same for raw events.
 */
export function dedupeRawEvents(events: RawEvent[]): RawEvent[] {
  const seen = new Map<string, RawEvent>();
  for (const e of events) {
    const key = `${normalize(e.title)}|${dayOf(e.datetime)}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, e);
    } else if (scoreRawEvent(e) > scoreRawEvent(existing)) {
      seen.set(key, e);
    }
  }
  return Array.from(seen.values());
}

function scoreEvent(e: Event): number {
  return (
    (e.sourceUrl && !e.sourceUrl.endsWith("/") ? 50 : 0) +
    (e.location ? 30 : 0) +
    (e.cost ? 20 : 0) +
    Math.min(e.description?.length || 0, 200) / 4
  );
}

function scoreRawEvent(e: RawEvent): number {
  return (
    (e.url ? 50 : 0) +
    (e.location ? 30 : 0) +
    (e.cost ? 20 : 0) +
    Math.min(e.description?.length || 0, 200) / 4
  );
}

/**
 * Normalize title for dedup comparison:
 * - lowercase
 * - normalize Unicode (NFKC) so umlauts/diacritics are stable
 * - replace umlauts with ASCII equivalents
 * - strip punctuation and special characters
 * - collapse whitespace
 */
function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract just the day portion (YYYY-MM-DD) from a datetime string.
 * Tries multiple formats. Returns empty string if no day can be extracted.
 */
function dayOf(s: string): string {
  if (!s) return "";
  const d = parseEventDate(s);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Cap the event list to a reasonable size — too many events overwhelm the user.
 * Tries to keep diversity across sources by interleaving them.
 */
export function capEvents(events: Event[], max: number): Event[] {
  if (events.length <= max) return events;

  // Group by source, interleave taking one per source per pass
  const bySource = new Map<string, Event[]>();
  for (const e of events) {
    const list = bySource.get(e.sourceName) || [];
    list.push(e);
    bySource.set(e.sourceName, list);
  }

  const sourceLists = Array.from(bySource.values());
  const result: Event[] = [];
  let idx = 0;
  while (result.length < max) {
    let added = false;
    for (const list of sourceLists) {
      if (idx < list.length && result.length < max) {
        result.push(list[idx]);
        added = true;
      }
    }
    if (!added) break;
    idx++;
  }

  // Re-sort chronologically since interleave broke order
  return sortEvents(result);
}
