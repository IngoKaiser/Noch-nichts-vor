import * as cheerio from "cheerio";
import type { RawEvent } from "../types";
import { fetchText } from "./http";
import { getAnthropicClient, extractTextFromResponse, extractJson, createWithRetry } from "../anthropic";

/**
 * Generic HTML adapter — used as fallback when no structured data is available.
 *
 * Strategy:
 * 1. Fetch the page HTML
 * 2. Strip nav/footer/scripts and extract the main content as plain text
 * 3. Hand the plain text (typically a few KB) to Claude Haiku, which is fast
 *    and cheap, to extract events as JSON.
 *
 * Cost: typically 0.05-0.2 cents per page (~5k input tokens → Haiku rate).
 * Compare to Sonnet+web_search at 5-15 cents per query.
 */

export interface HtmlProbeResult {
  ok: boolean;
  note?: string;
}

export async function probeHtml(url: string): Promise<HtmlProbeResult> {
  // For HTML, the probe is essentially "can we fetch the page?".
  // We don't run the LLM during probe — that happens at fetch time.
  try {
    const html = await fetchText(url, 8000);
    const text = extractMainText(html);
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
  const text = extractMainText(html);
  if (!text) return [];

  // Cap input to ~12k chars to keep token usage low
  const capped = text.length > 12_000 ? text.slice(0, 12_000) : text;

  return await structureWithHaiku(capped, url, sourceName, context);
}

/**
 * Extract the main textual content from an HTML page.
 * Strips scripts, styles, nav, footer, header, aside.
 */
function extractMainText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, aside, noscript, iframe, svg").remove();

  // Prefer <main> or article-like containers if present
  const candidates = [
    $("main").first(),
    $('[role="main"]').first(),
    $("#content, #main, .content, .main, .events, .event-list").first(),
    $("article").first(),
    $("body"),
  ];

  let chosen: cheerio.Cheerio<any> | null = null;
  for (const c of candidates) {
    if (c.length > 0) {
      chosen = c;
      break;
    }
  }
  if (!chosen) chosen = $("body");

  // Get text but preserve line breaks at block elements
  let text = "";
  chosen.find("*").addBack().each((_i, el) => {
    const tag = (el as any).tagName?.toLowerCase?.();
    if (tag && /^(p|div|li|h1|h2|h3|h4|h5|h6|tr|br)$/.test(tag)) {
      const t = $(el).clone().children().remove().end().text().trim();
      if (t) text += t + "\n";
    }
  });

  if (text.length < 200) {
    text = chosen.text();
  }

  return text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

async function structureWithHaiku(
  text: string,
  sourceUrl: string,
  sourceName: string,
  context: { location: string; dateRange: string }
): Promise<RawEvent[]> {
  const client = getAnthropicClient();

  const prompt = `Du extrahierst Veranstaltungen aus Webseitentext.

Stadt: ${context.location}
Zeitraum-Hinweis: ${context.dateRange}

Hier ist der extrahierte Seiteninhalt von ${sourceName}:

---
${text}
---

Extrahiere ALLE konkreten Veranstaltungen (Konzerte, Ausstellungen, Theater, Workshops, Stadtfeste, Vorträge etc.) als JSON-Array.

Regeln:
- Nur belegte Events aus dem Text. Keine Erfindungen.
- Wenn Datum/Uhrzeit fehlen, nimm leeren String.
- Beschreibung max 20 Wörter, in eigenen Worten.
- Bei "kostenlos"/"frei"/"Eintritt frei" → "frei". Bei Preisen → "X €".

AUSSCHLIESSLICH JSON-Array, kein Markdown:

[
  {
    "title": "...",
    "datetime": "YYYY-MM-DD HH:MM oder leer",
    "location": "Ort/Adresse oder leer",
    "description": "kurze Beschreibung oder leer",
    "cost": "z.B. '12 €', 'frei', oder leer"
  }
]

Falls keine Events erkennbar: [].`;

  const response = await createWithRetry(client, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
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

  return parsed.map((e: any) => ({
    title: String(e.title || "").trim() || "Unbekannt",
    datetime: String(e.datetime || "").trim(),
    location: String(e.location || "").trim(),
    description: String(e.description || "").trim(),
    cost: String(e.cost || "").trim(),
    url: sourceUrl,
    sourceName,
  }));
}
