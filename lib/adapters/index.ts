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
export async function detectAdapter(url: string): Promise<AdapterInfo> {
  const probedAt = new Date().toISOString();

  // 1. JSON-LD — best signal, structured by the site itself
  try {
    const r = await probeJsonLd(url);
    if (r.ok) return { kind: "jsonld", probedAt, ok: true, note: `${r.count} events` };
  } catch {}

  // 2. iCal — explicit calendar feed
  try {
    const r = await probeIcal(url);
    if (r.ok && r.endpoint) {
      return { kind: "ical", endpoint: r.endpoint, probedAt, ok: true, note: `${r.count} events` };
    }
  } catch {}

  // 3. RSS — newsfeed, may include events
  try {
    const r = await probeRss(url);
    if (r.ok && r.endpoint) {
      return { kind: "rss", endpoint: r.endpoint, probedAt, ok: true, note: `${r.count} items` };
    }
  } catch {}

  // 4. HTML — generic fallback
  try {
    const r = await probeHtml(url);
    if (r.ok) return { kind: "html", probedAt, ok: true };
    return { kind: "html", probedAt, ok: false, note: r.note };
  } catch (e: any) {
    return { kind: "html", probedAt, ok: false, note: e?.message };
  }
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
      return await fetchRssEvents(adapter.endpoint, source.name);
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
