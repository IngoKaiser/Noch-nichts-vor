import * as cheerio from "cheerio";
import type { RawEvent } from "../types";
import { fetchText, absolutize } from "./http";

/**
 * Extracts schema.org Event objects from a page's <script type="application/ld+json">
 * blocks. This is the gold standard — sites like rausgegangen.de, eventim.de, and
 * many newspaper event listings publish JSON-LD that's structured and stable.
 */

export interface JsonLdProbeResult {
  ok: boolean;
  count: number;
  note?: string;
}

const JSONLD_PATH_HINTS = [
  "", // the source URL itself
  "/veranstaltungen", "/termine", "/events", "/kalender",
  "/programm", "/spielplan",
];

export async function probeJsonLd(url: string): Promise<JsonLdProbeResult> {
  // Try the source URL first (most likely), then common event sub-paths
  for (const hint of JSONLD_PATH_HINTS) {
    const target = hint ? absolutizePath(url, hint) : url;
    try {
      const html = await fetchText(target, 8000);
      const events = extractJsonLdEvents(html);
      if (events.length > 0) {
        return { ok: true, count: events.length, note: hint ? `via ${hint}` : undefined };
      }
    } catch {
      continue;
    }
  }
  return { ok: false, count: 0, note: "No JSON-LD events found on common paths" };
}

function absolutizePath(baseUrl: string, path: string): string {
  try {
    const u = new URL(baseUrl);
    u.pathname = path;
    u.search = "";
    return u.toString();
  } catch {
    return baseUrl;
  }
}

export async function fetchJsonLdEvents(
  url: string,
  sourceName: string
): Promise<RawEvent[]> {
  const html = await fetchText(url, 12_000);
  const events = extractJsonLdEvents(html);
  return events.map((e) => ({
    title: e.name || "Unbekannt",
    datetime: normalizeDateTime(e.startDate),
    location: extractLocation(e.location),
    description: trim(e.description),
    cost: extractOffers(e.offers),
    // Prefer the event's own URL; fall back to listing URL only when missing
    url: e.url ? absolutize(e.url, url) : undefined,
    sourceName,
    sourceListingUrl: url,
  }));
}

interface JsonLdEvent {
  "@type"?: string | string[];
  name?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  url?: string;
  location?: any;
  offers?: any;
}

function extractJsonLdEvents(html: string): JsonLdEvent[] {
  const $ = cheerio.load(html);
  const blocks: string[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const text = $(el).contents().text();
    if (text && text.trim()) blocks.push(text);
  });

  const events: JsonLdEvent[] = [];
  for (const block of blocks) {
    let parsed: any;
    try {
      parsed = JSON.parse(block);
    } catch {
      // Some sites embed multiple objects or have HTML-escaped content.
      // Try to recover by stripping HTML entities.
      try {
        parsed = JSON.parse(block.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      } catch {
        continue;
      }
    }
    walkForEvents(parsed, events);
  }
  return events;
}

function walkForEvents(node: any, out: JsonLdEvent[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForEvents(item, out);
    return;
  }
  if (typeof node !== "object") return;

  const type = node["@type"];
  const isEvent = (() => {
    if (!type) return false;
    if (Array.isArray(type)) return type.some((t) => /event/i.test(String(t)));
    return /event/i.test(String(type));
  })();

  if (isEvent && node.name && node.startDate) {
    out.push(node);
  }

  // Some sites wrap events in @graph or itemListElement
  if (node["@graph"]) walkForEvents(node["@graph"], out);
  if (node.itemListElement) walkForEvents(node.itemListElement, out);
  if (node.item) walkForEvents(node.item, out);
}

function normalizeDateTime(s: string | undefined): string {
  if (!s) return "";
  // ISO format: 2026-04-25T19:30:00+02:00 → "2026-04-25 19:30"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (m) {
    if (m[2]) return `${m[1]} ${m[2]}:${m[3]}`;
    return m[1];
  }
  return s;
}

function extractLocation(loc: any): string {
  if (!loc) return "";
  if (typeof loc === "string") return loc;
  if (Array.isArray(loc)) return extractLocation(loc[0]);
  if (typeof loc === "object") {
    const name = loc.name || "";
    const addr = loc.address;
    if (typeof addr === "string") return name ? `${name}, ${addr}` : addr;
    if (addr && typeof addr === "object") {
      const parts = [addr.streetAddress, addr.postalCode, addr.addressLocality]
        .filter(Boolean)
        .join(" ");
      return name ? `${name}, ${parts}` : parts;
    }
    return name;
  }
  return "";
}

function extractOffers(offers: any): string {
  if (!offers) return "";
  const first = Array.isArray(offers) ? offers[0] : offers;
  if (!first || typeof first !== "object") return "";
  const price = first.price;
  const currency = first.priceCurrency || "EUR";
  if (price === 0 || price === "0" || price === "0.00") return "frei";
  if (price) {
    const symbol = currency === "EUR" ? "€" : currency;
    return `${price} ${symbol}`;
  }
  return "";
}

function trim(s: string | undefined, max = 200): string {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).trim() + "…";
}
