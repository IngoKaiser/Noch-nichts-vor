import { NextRequest, NextResponse } from "next/server";
import { getAnthropicClient, extractTextFromResponse, extractJson } from "@/lib/anthropic";
import type { CandidateSource } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  try {
    const { location } = await req.json();
    if (!location || typeof location !== "string") {
      return NextResponse.json({ error: "Location required" }, { status: 400 });
    }

    const prompt = buildDiscoveryPrompt(location);
    const client = getAnthropicClient();

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
        } as any,
      ],
    });

    const text = extractTextFromResponse(response.content as any[]);
    const sources = extractJson<CandidateSource[]>(text);

    if (!Array.isArray(sources)) {
      throw new Error("Unexpected source format");
    }

    // Deduplicate by URL
    const seen = new Set<string>();
    const deduped = sources.filter((s) => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    return NextResponse.json({ sources: deduped });
  } catch (e: any) {
    console.error("Discovery error", e);
    return NextResponse.json(
      { error: e.message || "Discovery failed" },
      { status: 500 }
    );
  }
}

function buildDiscoveryPrompt(location: string): string {
  return `Du bist Lokaljournalist und recherchierst für "${location}" in Deutschland ein möglichst vollständiges Set an Quellen für Veranstaltungshinweise.

ZIEL: 10-15 Quellen, die zusammen einen realistischen Überblick über das lokale Veranstaltungsgeschehen geben. Finde AUS JEDER der folgenden Kategorien mindestens 1-2 Einträge, sofern vorhanden:

KATEGORIE A — OFFIZIELL (type: "official"):
- Städtische oder regionale Veranstaltungskalender (z.B. hamburg.de/veranstaltungen, stadt-xyz.de/events)
- Kulturämter, Bürgerportale

KATEGORIE B — REDAKTIONELL / LOKALMEDIEN (type: "editorial"):
- Tageszeitungs-Eventseiten (z.B. MOPO Event-Empfehlungen, Hamburger Abendblatt Events, SZ München Termine, Rheinische Post Veranstaltungen)
- Stadtmagazine (z.B. PRINZ, Szene Hamburg, tip Berlin, zitty, Mitvergnügen)
- Lokale Kulturblogs

KATEGORIE C — AGGREGATOREN / STADT-TAGESPLANER (type: "aggregator"):
**Dies sind die in der Praxis wichtigsten Quellen — unbedingt suchen!**
- Stadt-spezifische Tagesportale (z.B. "Heute in Hamburg" = heuteinhamburg.de, "Heute in München", "Heute in Köln")
- Rausgegangen (rausgegangen.de/STADT)
- Stadtbekannt, Stadt-Anzeiger-Portale
- Berlin.de Tipps, Kulturkurier, Regioactive, Ask Helmut

KATEGORIE D — VENUES MIT KALENDER (type: "venue"):
- Wichtige Konzerthäuser, Theater, Museen, Kulturzentren mit eigenem Eventkalender
- Familien-/Kinderzentren wenn vorhanden

KATEGORIE E — TOURISMUS (type: "tourism"):
- Offizielle Tourismus-Websites (z.B. visit-xyz.de)

KATEGORIE F — KOMMERZIELL (type: "commercial"):
- Nur ergänzend, max. 1-2 (Eventim, Ticketmaster, Reservix)

VORGEHEN:
Führe mehrere parallele Websuchen durch:
1. "${location} veranstaltungen heute"
2. "${location} events wochenende"  
3. "rausgegangen ${location}"
4. "heute in ${location}"
5. "${location} stadtmagazin veranstaltungen"
6. "${location} kulturkalender offiziell"
7. Lokale Tageszeitung ${location} Events

Prüfe bei jedem Treffer kurz die URL. Verwerfe nur, wenn die Seite offensichtlich tot ist oder keine Events listet.

WICHTIG: Aggregatoren wie Rausgegangen, "Heute in ${location}" und die Event-Seiten der lokalen Tageszeitung dürfen NICHT fehlen, sofern sie existieren.

Gib AUSSCHLIESSLICH ein JSON-Array zurück, keine Einleitung, keine Markdown-Codefences:

[
  {
    "name": "Name der Quelle",
    "url": "https://...",
    "type": "official" | "editorial" | "aggregator" | "venue" | "tourism" | "commercial",
    "focus": "Kurzbeschreibung, was dort zu finden ist (max 15 Wörter)",
    "audience": "general" | "family" | "adult" | "mixed",
    "recommended": true | false
  }
]

Setze "recommended": true für die stärksten 6-8 Quellen — das sind in der Regel: der offizielle Kalender, die großen Aggregatoren (Rausgegangen, Heute-in-Stadt), und 1-2 redaktionelle Portale mit täglicher Pflege. Bei den übrigen false.`;
}
