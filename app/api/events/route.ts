import { NextRequest, NextResponse } from "next/server";
import { fetchSourceEvents } from "@/lib/adapters";
import { classifyEvents } from "@/lib/classify";
import { cacheGet, cacheSet, cacheMaybeCleanup } from "@/lib/cache";
import {
  computeDateRange,
  filterRawEventsByRange,
  filterEventsByRange,
  sortEvents,
  dedupeRawEvents,
  dedupeEvents,
  capEvents,
} from "@/lib/timefilter";
import { errorResponse } from "@/lib/errors";
import type { Event, EventSource, RawEvent, TimeFilter } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

const RAW_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const CLASSIFIED_TTL_SECONDS = 30 * 60; // 30 minutes
const MAX_EVENTS = 80; // hard cap displayed to user

interface SourceStatus {
  name: string;
  ok: boolean;
  count: number;
  fromCache?: boolean;
  note?: string;
}

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

    const isTodayFilter = timeFilter === "today" || timeFilter === "tonight";

    // Classified cache check
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

    // Per-source raw-events fetch with cache
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
        classifiedCount: 0,
        filteredCount: 0,
        fromCache: false,
      };
      cacheSet(classifiedKey, { events: [], meta }, 5 * 60);
      return NextResponse.json({ events: [], meta });
    }

    // STRICT pre-filter to date range BEFORE classification.
    // Events without a parseable date are DROPPED unless filter is "today" or "tonight".
    // This is the fix for "297 events for weekend" — most of those had no parseable date
    // and were being kept under the old loose rule.
    const dedupedRaw = dedupeRawEvents(allRaw);
    const inRange = filterRawEventsByRange(dedupedRaw, range.from, range.to, isTodayFilter);

    // Classify only events in range (saves Haiku tokens)
    const classified = await classifyEvents(inRange);

    // Strict filter AGAIN after classification (Haiku might have normalized dates).
    // Same isTodayFilter rule applies.
    const filtered = filterEventsByRange(classified, range.from, range.to, isTodayFilter);

    // Dedupe, sort, cap
    const deduped = dedupeEvents(filtered);
    const sorted = sortEvents(deduped);
    const capped = capEvents(sorted, MAX_EVENTS);

    const meta = {
      sourceStatus,
      rawCount: allRaw.length,
      dedupedCount: dedupedRaw.length,
      inRangeCount: inRange.length,
      classifiedCount: classified.length,
      filteredCount: filtered.length,
      finalCount: capped.length,
      cappedFrom: sorted.length > MAX_EVENTS ? sorted.length : undefined,
      fromCache: false,
    };

    cacheSet(classifiedKey, { events: capped, meta }, CLASSIFIED_TTL_SECONDS);

    return NextResponse.json({ events: capped, meta });
  } catch (e: any) {
    console.error("Events error", e);
    const { body, status } = errorResponse(e);
    return NextResponse.json(body, { status });
  }
}

function shortError(reason: any): string {
  const msg = reason?.message || String(reason || "unknown");
  return msg.length > 100 ? msg.slice(0, 97) + "…" : msg;
}
