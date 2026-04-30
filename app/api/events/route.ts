import { NextRequest, NextResponse } from "next/server";
import { fetchSourceEvents } from "@/lib/adapters";
import { classifyEvents } from "@/lib/classify";
import { cacheGet, cacheSet, cacheMaybeCleanup } from "@/lib/cache";
import {
  computeDateRange,
  filterEventsByRange,
  sortEvents,
  dedupeEvents,
} from "@/lib/timefilter";
import { errorResponse } from "@/lib/errors";
import type { Event, EventSource, RawEvent, TimeFilter } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

// Per-source cache TTL (raw events, before classification & filtering).
// Switching the time filter (today → weekend) reuses these without refetching.
const RAW_TTL_SECONDS = 2 * 60 * 60; // 2 hours

// Per-query cache TTL (classified, filtered events).
// Hit when same user reloads or comes back within window.
const CLASSIFIED_TTL_SECONDS = 30 * 60; // 30 minutes

interface SourceStatus {
  name: string;
  ok: boolean;
  count: number;
  fromCache?: boolean;
  note?: string;
}

/**
 * Pipeline:
 *
 * 1. Try classified-events cache first → instant return on hit
 * 2. For each source:
 *    a. Try raw-events cache (per source URL × adapter kind)
 *    b. On miss: fetch via adapter (JSON-LD / iCal / RSS / HTML+Haiku)
 *    c. Cache raw events for RAW_TTL
 * 3. Merge raw events, dedupe, filter to requested date range
 * 4. Classify audience + category in ONE Haiku call (only on cache miss)
 * 5. Cache classified result for CLASSIFIED_TTL
 *
 * Result: when user toggles Heute → Wochenende, only the filter step re-runs.
 * No source refetch, no LLM call. Most expensive thing skipped.
 */
export async function POST(req: NextRequest) {
  cacheMaybeCleanup();

  try {
    const { location, sources, timeFilter, customDate } = await req.json();

    if (!location || !Array.isArray(sources) || sources.length === 0) {
      return NextResponse.json(
        { error: { code: "no_sources", userMessage: "Keine Quellen ausgewählt." } },
        { status: 400 }
      );
    }

    // 1. Classified cache check
    const classifiedKey = `events:classified:${location.toLowerCase()}:${timeFilter}:${customDate || ""}`;
    const classifiedHit = cacheGet<{ events: Event[]; meta: any }>(classifiedKey);
    if (classifiedHit) {
      return NextResponse.json({
        events: classifiedHit.events,
        meta: { ...classifiedHit.meta, fromCache: true },
      });
    }

    const cappedSources = (sources as EventSource[]).slice(0, 10);
    const range = computeDateRange(timeFilter as TimeFilter, customDate);
    const dateRangeStr = `${range.from.toISOString().slice(0, 10)} bis ${range.to
      .toISOString()
      .slice(0, 10)}`;

    // 2. Per-source raw-events fetch with cache
    const sourceStatus: SourceStatus[] = [];
    const allRaw: RawEvent[] = [];

    const perSourceResults = await Promise.allSettled(
      cappedSources.map(async (source) => {
        const adapterKind = source.adapter?.kind || "html";
        const rawKey = `events:raw:${source.url}:${adapterKind}`;
        const rawHit = cacheGet<RawEvent[]>(rawKey);
        if (rawHit) {
          return { source, events: rawHit, fromCache: true };
        }
        const events = await fetchSourceEvents(source, {
          location,
          dateRange: dateRangeStr,
        });
        // Cache raw events even if empty — avoids hammering broken sources
        cacheSet(rawKey, events, RAW_TTL_SECONDS);
        return { source, events, fromCache: false };
      })
    );

    perSourceResults.forEach((result, idx) => {
      const source = cappedSources[idx];
      if (result.status === "fulfilled") {
        sourceStatus.push({
          name: source.name,
          ok: true,
          count: result.value.events.length,
          fromCache: result.value.fromCache,
        });
        allRaw.push(...result.value.events);
      } else {
        sourceStatus.push({
          name: source.name,
          ok: false,
          count: 0,
          note: shortError(result.reason),
        });
      }
    });

    if (allRaw.length === 0) {
      const meta = {
        sourceStatus,
        rawCount: 0,
        filteredCount: 0,
        fromCache: false,
      };
      // Cache empty results briefly so we don't hammer broken sources
      cacheSet(classifiedKey, { events: [], meta }, 5 * 60);
      return NextResponse.json({ events: [], meta });
    }

    // 3. Pre-filter to date range BEFORE classification — saves Haiku tokens
    // (we don't need to classify events outside the requested window)
    const dedupedRaw = dedupeRawEvents(allRaw);
    const inRange = filterRawByRange(dedupedRaw, range.from, range.to);

    // 4. Classify only events that survived the pre-filter
    const classified = await classifyEvents(inRange);
    const sorted = sortEvents(dedupeEvents(classified));

    const meta = {
      sourceStatus,
      rawCount: allRaw.length,
      filteredCount: sorted.length,
      fromCache: false,
    };

    cacheSet(classifiedKey, { events: sorted, meta }, CLASSIFIED_TTL_SECONDS);

    return NextResponse.json({ events: sorted, meta });
  } catch (e: any) {
    console.error("Events error", e);
    const { body, status } = errorResponse(e);
    return NextResponse.json(body, { status });
  }
}

/**
 * Pre-filter raw events to the requested date range.
 * Events without a parseable date are kept (could be ongoing/all-day).
 */
function filterRawByRange(events: RawEvent[], from: Date, to: Date): RawEvent[] {
  return events.filter((e) => {
    if (!e.datetime) return true;
    const d = parseRawDate(e.datetime);
    if (!d) return true;
    return d >= from && d <= to;
  });
}

function parseRawDate(s: string): Date | null {
  if (!s) return null;
  // Try ISO-like "2026-04-30 19:30"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) {
    const d = new Date(
      `${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}`
    );
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function dedupeRawEvents(events: RawEvent[]): RawEvent[] {
  const seen = new Map<string, RawEvent>();
  for (const e of events) {
    const norm = (e.title || "").toLowerCase().replace(/\s+/g, " ").trim();
    const dateKey = (e.datetime || "").slice(0, 10);
    const key = `${norm}|${dateKey}`;
    // Prefer the version with more detail (longer description, has URL, etc.)
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, e);
    } else {
      const existingScore =
        (existing.description?.length || 0) +
        (existing.location ? 50 : 0) +
        (existing.cost ? 30 : 0) +
        (existing.url ? 40 : 0);
      const newScore =
        (e.description?.length || 0) +
        (e.location ? 50 : 0) +
        (e.cost ? 30 : 0) +
        (e.url ? 40 : 0);
      if (newScore > existingScore) seen.set(key, e);
    }
  }
  return Array.from(seen.values());
}

function shortError(reason: any): string {
  const msg = reason?.message || String(reason || "unknown");
  return msg.length > 100 ? msg.slice(0, 97) + "…" : msg;
}
