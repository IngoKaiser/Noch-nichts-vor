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
  context: { location: string; dateRange: string }
): Promise<RawEvent[]> {
  const html = await fetchText(url, 12_000);
  const text = extractEventListing(html, url);
  if (!text) return [];

  // Cap to ~6k chars — much smaller than before, since pre-filter does the heavy lifting
  const capped = text.length > 6500 ? text.slice(0, 6500) : text;

  return await structureWithHaiku(capped, url, sourceName, context);
}

/**
 * Extract just the event-listing portion of the page.
 * Tries multiple selector strategies in order of specificity.
 * Returns text with inline links preserved as "Text [→ URL]".
 */
function extractEventListing(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, aside, noscript, iframe, svg, .cookie, .newsletter, form").remove();

  // Try increasingly broad selectors. First match wins.
  const selectorGroups = [
    // Most specific: event-list-like containers
    [".event-list", ".events", ".veranstaltungen", ".termine", ".kalender",
     ".event-listing", ".veranstaltungsliste", "[id*=event]", "[class*=event-card]",
     "[class*=eventlist]", "[class*=termin]"],
    // Generic content containers
    ["main", '[role="main"]', "#content", "#main", ".content", ".main"],
    // Article-like
    ["article", ".articles"],
    // Last resort
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

  // Pre-filter: keep only lines that look event-related
  // Heuristic: a line is kept if it contains a date pattern, time pattern,
  // or a known event keyword — OR if the previous/next line did (context).
  const eventKeywords = /\b(konzert|theater|ausstellung|festival|workshop|lesung|markt|fest|premiere|vortrag|musical|oper|kino|film|tanz|comedy|cabaret|party|club|bar|live|tour|gastspiel|matinee|vernissage|fĂĽhrung|stadtrundgang|stadtrundfahrt|kindertheater|familienkonzert|spielplatzfest|stadtteilfest|flohmarkt|wochenmarkt|weihnachtsmarkt)\b/i;
  const datePattern = /\b(\d{1,2}[.\/]\d{1,2}[.\/]?(\d{2,4})?|\d{4}-\d{2}-\d{2}|mo|di|mi|do|fr|sa|so|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|jan|feb|mär|apr|mai|jun|jul|aug|sep|okt|nov|dez)\b/i;
  const timePattern = /\b(\d{1,2}[:\.]\d{2}\s*(uhr|h)?|\d{1,2}\s*uhr)\b/i;

  const isEventy = (line: string): boolean => {
    if (line.length < 5) return false;
    if (line.length > 400) return false; // Likely paragraph text, not an event entry
    return eventKeywords.test(line) || datePattern.test(line) || timePattern.test(line);
  };

  // Two-pass: mark lines as keep/drop, then include neighbors of kept lines
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (isEventy(lines[i])) keep[i] = true;
  }
  // Include 1 line before and after each kept line for context (date often on separate line from title)
  const finalKeep = [...keep];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (i > 0) finalKeep[i - 1] = true;
      if (i < lines.length - 1) finalKeep[i + 1] = true;
    }
  }

  const filtered = lines.filter((_, i) => finalKeep[i]).join("\n");

  // If pre-filter was too aggressive (very short result), fall back to full text
  if (filtered.length < 300 && lines.length > 5) {
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return filtered.replace(/\n{3,}/g, "\n\n").trim();
}

async function structureWithHaiku(
  text: string,
  sourceUrl: string,
  sourceName: string,
  context: { location: string; dateRange: string }
): Promise<RawEvent[]> {
  const client = getAnthropicClient();

  const prompt = `Extrahiere konkrete Veranstaltungen aus diesem Webseitentext.

Stadt: ${context.location}
Zeitraum: ${context.dateRange}
Quelle: ${sourceName} (${sourceUrl})

Hier ein Beispiel für gewünschten Output:

INPUT:
"Sa., 30.04. 20:00 Uhr — Kammermusikabend [→ https://venue.de/events/123]
Elbphilharmonie, Kleiner Saal · 25 €
Quartett spielt Beethoven und Schostakowitsch."

OUTPUT:
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

WICHTIG — was IGNORIERT wird:
- Cookie-Banner, Newsletter-Werbung, Datenschutzhinweise
- Allgemeine Vereins- oder Veranstaltungsort-Beschreibungen ohne konkretes Datum
- Archivierte Events (Datum in der Vergangenheit)
- Navigation, Menüpunkte, "Alle Veranstaltungen anzeigen"-Links
- Wiederholte Boilerplate-Texte

REGELN:
- "url": Wenn ein Link "[→ https://...]" zum konkreten Event führt (Pfad enthält /event/, /veranstaltung/, /termin/, oder eine ID): übernehmen. Sonst leer.
- "datetime": Format "YYYY-MM-DD HH:MM" wenn Uhrzeit bekannt, sonst "YYYY-MM-DD". Heute = ${new Date().toISOString().slice(0, 10)}.
- "location": Konkreter Ort/Veranstaltungsort. Leer wenn nicht ableitbar.
- "cost": "frei" / "X €" / "ab X €". Leer wenn unbekannt.
- "description": Max 25 Wörter, faktentreu.

Webseitentext:
---
${text}
---

AUSSCHLIESSLICH JSON-Array, kein Markdown, keine Einleitung:`;

  const response = await createWithRetry(client, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2500,
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
