import { NextRequest, NextResponse } from "next/server";
import {
  getAnthropicClient,
  extractTextFromResponse,
  extractJson,
  createWithRetry,
} from "@/lib/anthropic";
import { errorResponse } from "@/lib/errors";
import type { CandidateSource } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * Discover relevant event sources for a given location.
 * Uses Claude Sonnet with web_search — this is the only step that requires
 * a heavy LLM. Runs once per location, then sources are cached client-side.
 */
export async function POST(req: NextRequest) {
  try {
    const { location } = await req.json();
    if (!location || typeof location !== "string") {
      return NextResponse.json(
        { error: { code: "bad_request", userMessage: "Bitte einen Ort angeben." } },
        { status: 400 }
      );
    }

    const prompt = buildDiscoveryPrompt(location);
    const client = getAnthropicClient();

    const response = await createWithRetry(client, {
      model: "claude-sonnet-4-20250514",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        } as any,
      ],
    });

    const text = extractTextFromResponse(response.content as any[]);
    const sources = extractJson<CandidateSource[]>(text);

    if (!Array.isArray(sources)) {
      throw new Error("Unexpected source format");
    }

    const seen = new Set<string>();
    const deduped = sources.filter((s) => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    return NextResponse.json({ sources: deduped });
  } catch (e: any) {
    console.error("Discovery error", e);
    const { body, status } = errorResponse(e);
    return NextResponse.json(body, { status });
  }
}

function buildDiscoveryPrompt(location: string): string {
  return `Du recherchierst für "${location}" in Deutschland Quellen für Veranstaltungshinweise.

Suche per Websuche 10-12 geeignete Quellen aus diesen Kategorien:
- "official": städtischer Veranstaltungskalender, Kulturamt
- "editorial": Tageszeitung Events (z.B. MOPO, Hamburger Abendblatt, SZ Termine), Stadtmagazine (PRINZ, Szene, tip Berlin, Mitvergnügen)
- "aggregator": Stadtportale (Rausgegangen, "Heute in Hamburg/München/Köln", Stadtbekannt, Ask Helmut, Kulturkurier)
- "venue": wichtige Konzerthäuser, Theater, Museen mit Kalender
- "tourism": offizielle Tourismus-Site
- "commercial": max 1-2 (Eventim, Reservix)

WICHTIG: Aggregatoren wie Rausgegangen, "Heute in ${location}" und Tageszeitungs-Eventseiten dürfen NICHT fehlen, sofern sie existieren.

Führe gezielte Suchen durch:
- "rausgegangen ${location}"
- "heute in ${location}"
- "${location} stadtmagazin veranstaltungen"
- "${location} veranstaltungskalender"

Gib AUSSCHLIESSLICH ein JSON-Array zurück, keine Einleitung, kein Markdown:

[
  {
    "name": "Name",
    "url": "https://...",
    "type": "official"|"editorial"|"aggregator"|"venue"|"tourism"|"commercial",
    "focus": "Was dort zu finden ist (max 12 Wörter)",
    "audience": "general"|"family"|"adult"|"mixed",
    "recommended": true|false
  }
]

Setze "recommended": true für die 6-7 stärksten Quellen (offizieller Kalender, große Aggregatoren, redaktionelle Tagesübersichten). Bei den anderen false.`;
}
