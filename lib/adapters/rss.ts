import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import type { RawEvent } from "../types";
import { fetchText, fetchWithTimeout, absolutize } from "./http";

/**
 * RSS/Atom feed adapter. MOPO, Hamburger Abendblatt, and many other
 * newspapers publish event RSS feeds. RSS is generally less structured
 * than iCal — we get a title, description, link and pubDate, but datetime
 * extraction is heuristic.
 */

export interface RssProbeResult {
  ok: boolean;
  endpoint?: string;
  count?: number;
  note?: string;
}

const RSS_HINTS = [
  "/rss", "/feed", "/feed/rss", "/feed.xml", "/rss.xml", "/atom.xml",
  "/events.rss", "/events/feed", "/veranstaltungen/feed",
  "/termine/feed", "/?feed=rss", "/?feed=rss2",
  "/feed/atom", "/atom",
];

export async function probeRss(url: string): Promise<RssProbeResult> {
  // Strategy 1: <link rel="alternate" type="application/rss+xml">
  try {
    const html = await fetchText(url, 8000);
    const $ = cheerio.load(html);
    let feedUrl: string | undefined;
    $('link[rel="alternate"]').each((_i, el) => {
      const t = $(el).attr("type") || "";
      if (/rss|atom/i.test(t) && !feedUrl) {
        const href = $(el).attr("href");
        if (href) feedUrl = absolutize(href, url);
      }
    });

    if (feedUrl) {
      const probe = await tryFetchRss(feedUrl);
      if (probe.ok) return { ok: true, endpoint: feedUrl, count: probe.count };
    }
  } catch {
    // fall through
  }

  // Strategy 2: hint-based probing
  for (const hint of RSS_HINTS) {
    try {
      const candidate = absolutize(hint, url);
      const probe = await tryFetchRss(candidate);
      if (probe.ok) return { ok: true, endpoint: candidate, count: probe.count };
    } catch {
      continue;
    }
  }

  return { ok: false, note: "No RSS feed found" };
}

export async function fetchRssEvents(
  endpoint: string,
  sourceName: string,
  sourceListingUrl?: string
): Promise<RawEvent[]> {
  const xml = await fetchText(endpoint, 12_000);
  return parseRss(xml, sourceName, sourceListingUrl, endpoint);
}

async function tryFetchRss(
  url: string
): Promise<{ ok: boolean; count: number }> {
  const res = await fetchWithTimeout(url, {
    timeoutMs: 6000,
    accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*",
  });
  if (!res.ok) return { ok: false, count: 0 };
  const text = await res.text();
  if (!/<rss|<feed|<channel/i.test(text)) return { ok: false, count: 0 };
  try {
    const events = parseRss(text, "probe");
    // RSS feeds may contain non-event articles; we accept any feed with items
    // and let the LLM filter later. For probing, just check we got items.
    return { ok: events.length > 0, count: events.length };
  } catch {
    return { ok: false, count: 0 };
  }
}

function parseRss(
  xml: string,
  sourceName: string,
  sourceListingUrl?: string,
  feedUrl?: string
): RawEvent[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const obj = parser.parse(xml);

  // RSS 2.0
  const items: any[] =
    obj?.rss?.channel?.item ||
    (Array.isArray(obj?.feed?.entry) ? obj.feed.entry : obj?.feed?.entry ? [obj.feed.entry] : []) ||
    [];

  const list = Array.isArray(items) ? items : [items];

  // Use feedUrl as base for relative URLs, fall back to listing URL
  const base = feedUrl || sourceListingUrl || "";

  const out: RawEvent[] = [];
  for (const item of list) {
    if (!item) continue;
    const title = textOf(item.title) || "Unbekannt";
    const link = textOf(item.link) || textOf(item["@_href"]) || "";
    const desc = textOf(item.description) || textOf(item.summary) || "";
    const pubDate = textOf(item.pubDate) || textOf(item.published) || textOf(item.updated) || "";

    out.push({
      title: stripHtml(title),
      datetime: normalizeRssDate(pubDate),
      description: trim(stripHtml(desc)),
      url: link ? absolutize(link, base) : undefined,
      sourceName,
      sourceListingUrl,
    });
  }

  return out;
}

function textOf(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (v["#text"]) return String(v["#text"]);
    if (v["@_href"]) return String(v["@_href"]);
  }
  return String(v);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeRssDate(s: string): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function trim(s: string, max = 200): string {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).trim() + "…";
}
