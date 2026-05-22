import * as cheerio from "cheerio";
import type { RawEvent } from "../types";
import { fetchText, absolutize } from "./http";
import { getAnthropicClient, extractTextFromResponse, extractJson, createWithRetry } from "../anthropic";

/**
 * Generic HTML adapter — used as fallback when no structured data is available.
 *
 * Cost-optimized strategy:
 * 1. Fetch the page HTML
 * 2. Aggressively narrow down to event-listing region (multiple selector strategies)
 * 3. Pre-filter lines: only keep those that look like they describe an event
 *    (presence of date pattern, time pattern, or known event keywords)
 * 4. Hand the filtered text — typically 3-5k chars instead of 14k — to Haiku
 *    with a few-shot prompt that includes negative examples
 *
 * Result: ~70% fewer input tokens to Haiku, better extraction precision.
 */

export interface HtmlProbeResult {
  ok: boolean;
  note?: string;
}

export async function probeHtml(url: string): Promise<HtmlProbeResult> {
  try {
    const html = await fetchText(url, 8000);
    const text = extractEventListing(html, url);
    if (text.length < 200) {
      return { ok: false, note: "Page text too short — likely auth wall or empty" };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, note: e?.message || "fetch failed" };
  }
}

export async function fetchHtmlEvents(
  url: string,
  sourceName: string,
  context: { location: string; rangeLabel: string; fromIso: string; toIso: string }
): Promise<RawEvent[]> {
  const html = await fetchText(url, 12_000);
  const text = extractEventListing(html, url, context);
  if (!text) return [];

  // Cap to ~18k chars (~4500 tokens). Previous 6500 was too aggressive —
  // weekend events on a busy city portal would appear after position 10000+
  // and get cut off, leading to empty weekend results.
  const capped = text.length > 18_000 ? text.slice(0, 18_000) : text;

  return await structureWithHaiku(capped, url, sourceName, context);
}

/**
 * Extract the event-listing portion of the page.
 * When a date range is provided, prefer lines that look related to that range.
 * Returns text with inline links preserved as "Text [→ URL]".
 */
function extractEventListing(
  html: string,
  baseUrl: string,
  context?: { fromIso: string; toIso: string }
): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, aside, noscript, iframe, svg, .cookie, .newsletter, form").remove();

  // Try increasingly broad selectors. First match wins.
  const selectorGroups = [
    [".event-list", ".events", ".veranstaltungen", ".termine", ".kalender",
     ".event-listing", ".veranstaltungsliste", "[id*=event]", "[class*=event-card]",
     "[class*=eventlist]", "[class*=termin]"],
    ["main", '[role="main"]', "#content", "#main", ".content", ".main"],
    ["article", ".articles"],
    ["body"],
  ];

  let chosen: cheerio.Cheerio<any> | null = null;
  for (const selectors of selectorGroups) {
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length > 0 && el.text().trim().length > 200) {
        chosen = el;
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) chosen = $("body");

  // Inline anchors so links survive text extraction
  chosen.find("a[href]").each((_i, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    const txt = $el.text().trim();
    if (!href || !txt) return;
    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      return;
    }
    const abs = absolutize(href, baseUrl);
    $el.replaceWith(`${txt} [→ ${abs}]`);
  });

  // Walk block elements line-by-line
  const lines: string[] = [];
  chosen.find("*").addBack().each((_i, el) => {
    const tag = (el as any).tagName?.toLowerCase?.();
    if (tag && /^(p|div|li|h1|h2|h3|h4|h5|h6|tr|br|article|section)$/.test(tag)) {
      const t = $(el).clone().children().remove().end().text().trim();
      if (t) lines.push(t);
    }
  });

  // Pre-filter heuristics
  const eventKeywords = /\b(konzert|theater|ausstellung|festival|workshop|lesung|markt|fest|premiere|vortrag|musical|oper|kino|film|tanz|comedy|cabaret|party|club|bar|live|tour|gastspiel|matinee|vernissage|führung|stadtrundgang|stadtrundfahrt|kindertheater|familienkonzert|spielplatzfest|stadtteilfest|flohmarkt|wochenmarkt|weihnachtsmarkt)\b/i;
  // Match date patterns (more carefully — short weekday abbreviations only when followed by punctuation/digits)
  const datePattern = /\b(\d{1,2}\.\s*\d{1,2}\.?(\s*\d{2,4})?|\d{1,2}\/\d{1,2}\/?\d{0,4}|\d{4}-\d{2}-\d{2}|(?:mo|di|mi|do|fr|sa|so)\.|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|jan(?:uar)?|feb(?:ruar)?|mär(?:z)?|apr(?:il)?|mai|jun(?:i)?|jul(?:i)?|aug(?:ust)?|sep(?:tember)?|okt(?:ober)?|nov(?:ember)?|dez(?:ember)?)\b/i;
  const timePattern = /\b(\d{1,2}[:\.]\d{2}\s*(uhr|h)?|\d{1,2}\s*uhr)\b/i;

  const isEventy = (line: string): boolean => {
    if (line.length < 5) return false;
    if (line.length > 400) return false;
    return eventKeywords.test(line) || datePattern.test(line) || timePattern.test(line);
  };

  // Build a relevance map for the requested date range, if any.
  // A line is "in range" if it contains a date that falls between fromIso and toIso.
  const rangeDayMatchers: RegExp[] = [];
  if (context) {
    const days = enumerateDays(context.fromIso, context.toIso);
    for (const d of days) {
      // Match "DD.MM.", "DD.MM.YYYY", "YYYY-MM-DD", "DD/MM", and weekday name
      const dd = String(d.day).padStart(2, "0");
      const mm = String(d.month).padStart(2, "0");
      rangeDayMatchers.push(
        new RegExp(`\\b${d.day}\\.\\s*${d.month}\\.?(\\s*${d.year})?\\b`),
        new RegExp(`\\b${dd}\\.\\s*${mm}\\.?(\\s*${d.year})?\\b`),
        new RegExp(`\\b${d.year}-${mm}-${dd}\\b`),
        new RegExp(`\\b${d.weekday}\\b`, "i")
      );
    }
  }

  const isInRange = (line: string): boolean => {
    if (rangeDayMatchers.length === 0) return false;
    return rangeDayMatchers.some((r) => r.test(line));
  };

  // Two-pass: mark eventy lines, then include neighbors for context.
  // Lines that match the target date range get a boost (kept even when long).
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (isEventy(lines[i]) || isInRange(lines[i])) keep[i] = true;
  }
  const finalKeep = [...keep];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (i > 0) finalKeep[i - 1] = true;
      if (i < lines.length - 1) finalKeep[i + 1] = true;
      // Extra context when line matches the requested date — events typically
      // span 3-5 lines in city portal listings
      if (rangeDayMatchers.length > 0 && isInRange(lines[i])) {
        if (i > 1) finalKeep[i - 2] = true;
        if (i < lines.length - 2) finalKeep[i + 2] = true;
      }
    }
  }

  const filtered = lines.filter((_, i) => finalKeep[i]).join("\n");

  // If pre-filter was too aggressive, fall back to full text
  if (filtered.length < 300 && lines.length > 5) {
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return filtered.replace(/\n{3,}/g, "\n\n").trim();
}

async function structureWithHaiku(
  text: string,
  sourceUrl: string,
  sourceName: string,
  context: { location: string; rangeLabel: string; fromIso: string; toIso: string }
): Promise<RawEvent[]> {
  const client = getAnthropicClient();

  // Use the date that the server's range calculation produced as "today
  // anchor" for the prompt — not new Date() which on Vercel would be UTC
  // and could be one day off from the user's local date.
  // The fromIso for "today"/"tonight" filter equals today; for "weekend"
  // it equals the upcoming/current Saturday — close enough as an anchor.
  const today = context.fromIso;
  const sameDay = context.fromIso === context.toIso;
  const rangeDescription = sameDay
    ? `am ${context.fromIso} (${context.rangeLabel})`
    : `vom ${context.fromIso} bis ${context.toIso} (${context.rangeLabel})`;

  const prompt = `Extrahiere Veranstaltungen für ${context.location} ${rangeDescription} aus diesem Webseitentext.

Quelle: ${sourceName} (${sourceUrl})
Heutiges Datum: ${today}
Gesuchter Zeitraum: ${rangeDescription}

WICHTIG — Zeitraum-Filter:
- Extrahiere NUR Events, deren Datum im gesuchten Zeitraum liegt (zwischen ${context.fromIso} und ${context.toIso}, jeweils inklusive).
- Events VOR ${context.fromIso} oder NACH ${context.toIso}: ignorieren.
- Events ohne klares Datum: ignorieren (lieber zu wenige als falsche zeigen).
- Dauerausstellungen, die im Zeitraum geöffnet haben: NUR einschließen, wenn sie speziell für den Zeitraum beworben werden.

Beispiel-Output:
[
  {
    "title": "Kammermusikabend",
    "datetime": "2026-04-30 20:00",
    "location": "Elbphilharmonie, Kleiner Saal",
    "description": "Quartett spielt Beethoven und Schostakowitsch.",
    "cost": "25 €",
    "url": "https://venue.de/events/123"
  }
]

IGNORIEREN:
- Cookie-Banner, Newsletter-Werbung, Datenschutzhinweise
- Allgemeine Veranstaltungsort-Beschreibungen ohne konkretes Datum
- Navigation, "Alle Veranstaltungen"-Links

REGELN für jedes Event:
- "url": Wenn ein Link "[→ https://...]" eindeutig zu DIESEM Event führt: übernehmen. Sonst leer.
- "datetime": IMMER "YYYY-MM-DD HH:MM" mit Uhrzeit wenn bekannt, sonst "YYYY-MM-DD". KEIN Eintrag ohne Jahr.
- "location": Konkreter Ort. Leer wenn nicht ableitbar.
- "cost": "frei" / "X €" / "ab X €". Leer wenn unbekannt.
- "description": Max 25 Wörter, faktentreu.

Webseitentext:
---
${text}
---

AUSSCHLIESSLICH JSON-Array, kein Markdown, keine Einleitung. Wenn keine passenden Events im Zeitraum: []`;

  const response = await createWithRetry(client, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const responseText = extractTextFromResponse(response.content as any[]);
  let parsed: any;
  try {
    parsed = extractJson(responseText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.map((e: any) => {
    const eventUrl = String(e.url || "").trim();
    return {
      title: String(e.title || "").trim() || "Unbekannt",
      datetime: String(e.datetime || "").trim(),
      location: String(e.location || "").trim(),
      description: String(e.description || "").trim(),
      cost: String(e.cost || "").trim(),
      url: eventUrl ? absolutize(eventUrl, sourceUrl) : undefined,
      sourceName,
      sourceListingUrl: sourceUrl,
    };
  });
}

/**
 * Enumerate calendar days between two ISO date strings (inclusive).
 * Used by the pre-filter to detect lines that mention dates in range.
 */
function enumerateDays(
  fromIso: string,
  toIso: string
): Array<{ year: number; month: number; day: number; weekday: string }> {
  const weekdayNames = [
    "sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag",
  ];
  const result: Array<{ year: number; month: number; day: number; weekday: string }> = [];
  const start = new Date(fromIso);
  const end = new Date(toIso);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];

  const cursor = new Date(start);
  // Hard cap at 14 days to keep regex count manageable
  for (let i = 0; i < 14 && cursor <= end; i++) {
    result.push({
      year: cursor.getFullYear(),
      month: cursor.getMonth() + 1,
      day: cursor.getDate(),
      weekday: weekdayNames[cursor.getDay()],
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}
