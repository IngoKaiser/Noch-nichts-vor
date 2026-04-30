import type { AdapterInfo, EventSource, RawEvent } from "../types";
import { probeJsonLd, fetchJsonLdEvents } from "./jsonld";
import { probeIcal, fetchIcalEvents } from "./ical";
import { probeRss, fetchRssEvents } from "./rss";
import { probeHtml, fetchHtmlEvents } from "./html";

/**
 * Detect the best adapter for a source. Tried in order of robustness:
 * JSON-LD → iCal → RSS → HTML scraping.
 *
 * Called once per source when sources are confirmed (after curation).
 */
/**
 * Detect the best adapter for a source. Probes are run in parallel for speed,
 * then we pick the best result in priority order:
 * JSON-LD → iCal → RSS → HTML scraping.
 *
 * Called once per source when sources are confirmed (after curation).
 */
export async function detectAdapter(url: string): Promise<AdapterInfo> {
  const probedAt = new Date().toISOString();

  // Run all four probes in parallel to keep total probe time bounded.
  // Each individual probe has its own timeout via fetchText.
  const [jsonldResult, icalResult, rssResult, htmlResult] = await Promise.allSettled([
    probeJsonLd(url),
    probeIcal(url),
    probeRss(url),
    probeHtml(url),
  ]);

  // 1. JSON-LD — best signal, structured by the site itself
  if (jsonldResult.status === "fulfilled" && jsonldResult.value.ok) {
    return {
      kind: "jsonld",
      probedAt,
      ok: true,
      note: `${jsonldResult.value.count} events${jsonldResult.value.note ? ` (${jsonldResult.value.note})` : ""}`,
    };
  }

  // 2. iCal — explicit calendar feed
  if (icalResult.status === "fulfilled" && icalResult.value.ok && icalResult.value.endpoint) {
    return {
      kind: "ical",
      endpoint: icalResult.value.endpoint,
      probedAt,
      ok: true,
      note: `${icalResult.value.count} events`,
    };
  }

  // 3. RSS — newsfeed, may include events
  if (rssResult.status === "fulfilled" && rssResult.value.ok && rssResult.value.endpoint) {
    return {
      kind: "rss",
      endpoint: rssResult.value.endpoint,
      probedAt,
      ok: true,
      note: `${rssResult.value.count} items`,
    };
  }

  // 4. HTML — generic fallback (always tries, since we can usually fetch a page)
  if (htmlResult.status === "fulfilled") {
    if (htmlResult.value.ok) {
      return { kind: "html", probedAt, ok: true };
    }
    return { kind: "html", probedAt, ok: false, note: htmlResult.value.note };
  }

  return {
    kind: "html",
    probedAt,
    ok: false,
    note: htmlResult.status === "rejected" ? String(htmlResult.reason?.message || htmlResult.reason) : "all probes failed",
  };
}

/**
 * Fetch events from a source using the configured adapter.
 * Returns RawEvent[] (no audience classification yet — that's a separate step).
 */
export async function fetchSourceEvents(
  source: EventSource,
  context: { location: string; dateRange: string }
): Promise<RawEvent[]> {
  const adapter = source.adapter;
  if (!adapter) {
    // No adapter info yet — fall back to HTML
    return await fetchHtmlEvents(source.url, source.name, context);
  }

  switch (adapter.kind) {
    case "jsonld":
      return await fetchJsonLdEvents(source.url, source.name);
    case "ical":
      if (!adapter.endpoint) return [];
      return await fetchIcalEvents(adapter.endpoint, source.name);
    case "rss":
      if (!adapter.endpoint) return [];
      return await fetchRssEvents(adapter.endpoint, source.name, source.url);
    case "html":
      return await fetchHtmlEvents(source.url, source.name, context);
    case "websearch":
      // Legacy fallback — would call the old Sonnet+web_search path.
      // Not implemented here to keep the new pipeline clean.
      return [];
    default:
      return [];
  }
}

export { detectAdapter as default };
