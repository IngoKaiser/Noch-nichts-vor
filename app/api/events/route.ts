import { NextRequest, NextResponse } from "next/server";
import { fetchSourceEvents } from "@/lib/adapters";
import { classifyEvents } from "@/lib/classify";
import { cacheGet, cacheSet, cacheMaybeCleanup } from "@/lib/cache";
import { computeDateRange, filterEventsByRange, sortEvents, dedupeEvents } from "@/lib/timefilter";
import type { Event, EventSource, RawEvent, TimeFilter } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

const CACHE_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Main events endpoint. Pipeline:
 *
 *  1. Build cache key from (location × filter × custom_date)
 *  2. Cache hit? Return immediately.
 *  3. For each source in parallel: fetch raw events via adapter
 *  4. Merge, dedupe, filter by date range, sort
 *  5. Classify audience in a single Haiku call
 *  6. Cache and return.
 *
 * The expensive web_search path is no longer used here. All fetching goes
 * through structured adapters (JSON-LD / iCal / RSS / HTML+Haiku).
 */
export async function POST(req: NextRequest) {
  cacheMaybeCleanup();

  try {
    const { location, sources, timeFilter, customDate } = await req.json();

    if (!location || !Array.isArray(sources) || sources.length === 0) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const cacheKey = `events:${location.toLowerCase()}:${timeFilter}:${customDate || ""}`;
    const cached = cacheGet<{ events: Event[]; meta: any }>(cacheKey);
    if (cached) {
      return NextResponse.json({
        events: cached.events,
        meta: { ...cached.meta, fromCache: true },
      });
    }

    // Cap source count for performance — most users won't have more than 8 anyway
    const cappedSources = (sources as EventSource[]).slice(0, 10);

    const range = computeDateRange(timeFilter as TimeFilter, customDate);
    const dateRangeStr = `${range.from.toISOString().slice(0, 10)} bis ${range.to.toISOString().slice(0, 10)}`;

    // Fetch from all sources in parallel. Failures are logged but don't break the batch.
    const perSourceResults = await Promise.allSettled(
      cappedSources.map((source) =>
        fetchSourceEvents(source, { location, dateRange: dateRangeStr })
      )
    );

    const sourceStatus: Array<{ name: string; ok: boolean; count: number; note?: string }> = [];
    const allRaw: RawEvent[] = [];

    perSourceResults.forEach((result, idx) => {
      const source = cappedSources[idx];
      if (result.status === "fulfilled") {
        sourceStatus.push({
          name: source.name,
          ok: true,
          count: result.value.length,
        });
        allRaw.push(...result.value);
      } else {
        sourceStatus.push({
          name: source.name,
          ok: false,
          count: 0,
          note: String(result.reason?.message || result.reason || "unknown error"),
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
      // Cache empty result briefly so we don't hammer broken sources
      cacheSet(cacheKey, { events: [], meta }, 5 * 60);
      return NextResponse.json({ events: [], meta });
    }

    // Classify all events for audience suitability in one Haiku call
    let classified = await classifyEvents(allRaw);

    // Sort and dedupe
    classified = dedupeEvents(classified);
    classified = sortEvents(classified);

    // Filter to the requested date range (events with no parseable date are kept)
    const filtered = filterEventsByRange(classified, range.from, range.to);

    const meta = {
      sourceStatus,
      rawCount: allRaw.length,
      filteredCount: filtered.length,
      fromCache: false,
    };

    cacheSet(cacheKey, { events: filtered, meta }, CACHE_TTL_SECONDS);

    return NextResponse.json({ events: filtered, meta });
  } catch (e: any) {
    console.error("Events error", e);
    return NextResponse.json(
      { error: e?.message || "Events search failed" },
      { status: 500 }
    );
  }
}
