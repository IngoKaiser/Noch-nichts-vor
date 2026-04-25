import type { Event, RawEvent } from "./types";
import { getAnthropicClient, extractTextFromResponse, extractJson, createWithRetry } from "./anthropic";

/**
 * Classify a batch of raw events for audience suitability in a single API call.
 * Uses Haiku for speed and cost. Falls back to "unknown" if classification fails.
 */
export async function classifyEvents(raw: RawEvent[]): Promise<Event[]> {
  if (raw.length === 0) return [];

  // Strip down to minimal context for classification — we only need title + description
  const compact = raw.map((e, i) => ({
    i,
    title: e.title,
    description: e.description || "",
    location: e.location || "",
  }));

  const prompt = `Klassifiziere für jede Veranstaltung die Zielgruppe:
- "family": kinder-/familienfreundlich für 8-14 Jahre (Familienkonzert, Workshop für Kids, Mitmachausstellung, Kindertheater, Zirkus, Museum mit Kinderprogramm)
- "adult": eher Erwachsene (Bar, Club, 18+, Late-Night, Wein/Whisky, politische Vorträge)
- "mixed": für beide geeignet (Stadtfest, große Konzerte mit FSK egal, Museumsnacht, Kinoabend)
- "unknown": nicht eindeutig erkennbar

Veranstaltungen:
${JSON.stringify(compact, null, 1)}

Gib AUSSCHLIESSLICH JSON-Array zurück, gleiche Reihenfolge, mit "i" als Index:

[
  { "i": 0, "audience": "family"|"adult"|"mixed"|"unknown", "reason": "max 8 Wörter" }
]`;

  try {
    const client = getAnthropicClient();
    const response = await createWithRetry(client, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractTextFromResponse(response.content as any[]);
    const parsed = extractJson<Array<{ i: number; audience: string; reason: string }>>(text);

    const byIdx = new Map<number, { audience: string; reason: string }>();
    for (const p of parsed) byIdx.set(p.i, { audience: p.audience, reason: p.reason });

    return raw.map((e, i) => {
      const cls = byIdx.get(i);
      return {
        title: e.title,
        datetime: e.datetime,
        location: e.location || "",
        description: e.description || "",
        cost: e.cost || "",
        audience: (normalizeAudience(cls?.audience) || "unknown") as Event["audience"],
        audienceReason: cls?.reason || "",
        sourceName: e.sourceName,
        sourceUrl: e.url || "",
      };
    });
  } catch (err) {
    console.error("Classification failed, returning unknown audience", err);
    return raw.map((e) => ({
      title: e.title,
      datetime: e.datetime,
      location: e.location || "",
      description: e.description || "",
      cost: e.cost || "",
      audience: "unknown",
      audienceReason: "",
      sourceName: e.sourceName,
      sourceUrl: e.url || "",
    }));
  }
}

function normalizeAudience(a: string | undefined): Event["audience"] | null {
  if (!a) return null;
  const lower = a.toLowerCase();
  if (lower === "family" || lower === "adult" || lower === "mixed" || lower === "unknown") {
    return lower;
  }
  return null;
}
