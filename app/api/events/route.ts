import { NextRequest, NextResponse } from "next/server";
import { getAnthropicClient, extractTextFromResponse, extractJson } from "@/lib/anthropic";
import type { Event, EventSource, TimeFilter } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  try {
    const { location, sources, timeFilter, customDate } = await req.json();

    if (!location || !Array.isArray(sources) || sources.length === 0) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const prompt = buildEventsPrompt(location, sources, timeFilter, customDate);
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
    const events = extractJson<Event[]>(text);

    if (!Array.isArray(events)) {
      throw new Error("Unexpected event format");
    }

    return NextResponse.json({ events });
  } catch (e: any) {
    console.error("Events error", e);
    return NextResponse.json(
      { error: e.message || "Events search failed" },
      { status: 500 }
    );
  }
}

function buildEventsPrompt(
  location: string,
  sources: EventSource[],
  timeFilter: TimeFilter,
  customDate?: string
): string {
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  let label = "heute";
  let dateRange = fmt(today);

  if (timeFilter === "tonight") {
    label = "heute Abend (ab 17 Uhr)";
    dateRange = fmt(today);
  } else if (timeFilter === "weekend") {
    const day = today.getDay();
    const daysToSat = (6 - day + 7) % 7;
    const sat = new Date(today);
    sat.setDate(today.getDate() + daysToSat);
    const sun = new Date(sat);
    sun.setDate(sat.getDate() + 1);
    label = "kommendes Wochenende";
    dateRange = `${fmt(sat)} bis ${fmt(sun)}`;
  } else if (timeFilter === "custom" && customDate) {
    label = `am ${customDate}`;
    dateRange = customDate;
  }

  const sourcesText = sources
    .map((s, i) => `${i + 1}. ${s.name} (${s.url}) – ${s.focus}`)
    .join("\n");

  const todayStr = today.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return `Du bist Eventkurator für "${location}". Heutiges Datum: ${todayStr}.

Suche per Websuche Veranstaltungen in ${location} für ${label} (${dateRange}).

Nutze bevorzugt diese Quellen:
${sourcesText}

Führe gezielte Websuchen durch, z.B. "site:domain.de veranstaltungen ${dateRange}" oder "${location} events ${label}". Sammle mindestens 8, idealerweise 15 konkrete Events.

Klassifiziere die Zielgruppe:
- "family" = kinder-/familienfreundlich für 8-14 Jahre (Museen, Workshops, Familienkonzerte, Mitmachaktionen, altersgerechte Theater)
- "adult" = eher für Erwachsene (Bars, Clubs, 18+, politische Vorträge, Weinabende, Late-Night)
- "mixed" = für beide geeignet (Stadtfeste, große Konzerte, Museumsnacht, Kino ab FSK 12)
- "unknown" = nicht eindeutig klassifizierbar

AUSSCHLIESSLICH JSON-Array, keine Einleitung, kein Markdown:

[
  {
    "title": "Eventtitel",
    "datetime": "YYYY-MM-DD HH:MM oder 'ganztägig' oder Zeitspanne",
    "location": "Veranstaltungsort / Adresse",
    "description": "Max 25 Wörter",
    "cost": "z.B. '12 €', 'frei', 'Spende', 'unbekannt'",
    "audience": "family" | "adult" | "mixed" | "unknown",
    "audienceReason": "Max 12 Wörter",
    "sourceName": "Name aus Liste",
    "sourceUrl": "Direktlink zum Event oder zur Quellenseite"
  }
]

Nur belegte Events, keine Erfindungen. Falls nichts: [].`;
}
