import * as cheerio from "cheerio";
import ICAL from "ical.js";
import type { RawEvent } from "../types";
import { fetchText, fetchWithTimeout } from "./http";

/**
 * iCal/ICS feed adapter. Many city event calendars publish .ics feeds
 * (e.g., hamburg.de, kulturkurier.de, university calendars).
 */

export interface IcalProbeResult {
  ok: boolean;
  endpoint?: string;
  count?: number;
  note?: string;
}

const ICAL_HINTS = ["/feed.ical", "/calendar.ics", "/feed.ics", "/events.ics"];

export async function probeIcal(url: string): Promise<IcalProbeResult> {
  // Strategy 1: try to find an .ics link inside the page HTML
  try {
    const html = await fetchText(url, 8000);
    const $ = cheerio.load(html);
    let icsUrl: string | undefined;

    $('a[href*=".ics"], link[href*=".ics"]').each((_i, el) => {
      const href = $(el).attr("href");
      if (href && !icsUrl) {
        icsUrl = absolutize(href, url);
      }
    });

    if (icsUrl) {
      const probe = await tryFetchIcal(icsUrl);
      if (probe.ok) return { ok: true, endpoint: icsUrl, count: probe.count };
    }
  } catch {
    // fall through to hint-based probing
  }

  // Strategy 2: try common endpoints relative to the source URL
  for (const hint of ICAL_HINTS) {
    try {
      const candidate = absolutize(hint, url);
      const probe = await tryFetchIcal(candidate);
      if (probe.ok) return { ok: true, endpoint: candidate, count: probe.count };
    } catch {
      continue;
    }
  }

  return { ok: false, note: "No .ics endpoint found" };
}

export async function fetchIcalEvents(
  endpoint: string,
  sourceName: string
): Promise<RawEvent[]> {
  const text = await fetchText(endpoint, 15_000);
  return parseIcal(text, sourceName, endpoint);
}

async function tryFetchIcal(
  url: string
): Promise<{ ok: boolean; count: number }> {
  const res = await fetchWithTimeout(url, {
    timeoutMs: 6000,
    accept: "text/calendar,*/*",
  });
  if (!res.ok) return { ok: false, count: 0 };
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) return { ok: false, count: 0 };
  try {
    const events = parseIcal(text, "probe", url);
    return { ok: events.length > 0, count: events.length };
  } catch {
    return { ok: false, count: 0 };
  }
}

function parseIcal(text: string, sourceName: string, sourceUrl: string): RawEvent[] {
  const jcal = ICAL.parse(text);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents("vevent");

  const out: RawEvent[] = [];
  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(now.getDate() + 90); // only future events within 90 days

  for (const vevent of vevents) {
    try {
      const event = new ICAL.Event(vevent);
      const start = event.startDate?.toJSDate();
      if (!start) continue;
      if (start < now || start > horizon) continue;

      out.push({
        title: event.summary || "Unbekannt",
        datetime: formatJsDate(start),
        location: event.location || "",
        description: trim(event.description || ""),
        url: sourceUrl,
        sourceName,
      });
    } catch {
      continue;
    }
  }
  return out;
}

function formatJsDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function trim(s: string, max = 200): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).trim() + "…";
}
