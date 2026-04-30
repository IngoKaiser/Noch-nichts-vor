import type { Event, RawEvent, Audience, Category } from "./types";
import { getAnthropicClient, extractTextFromResponse, extractJson, createWithRetry } from "./anthropic";

/**
 * Classify and enrich raw events in a single Haiku call:
 * - audience (family | adult): "family" only when CLEARLY suitable for children 8-14
 * - category (concert | stage | art | kids | sport | other)
 * - fill in missing details (location, cost, time) where the title/description make them obvious
 */
export async function classifyEvents(raw: RawEvent[]): Promise<Event[]> {
  if (raw.length === 0) return [];

  // Send full context including any links so Haiku can reason about audience
  const compact = raw.map((e, i) => ({
    i,
    title: e.title,
    description: e.description || "",
    location: e.location || "",
    cost: e.cost || "",
    datetime: e.datetime || "",
    sourceName: e.sourceName,
  }));

  const prompt = `Du klassifizierst Veranstaltungen für eine deutsche Veranstaltungs-App.

Für JEDES Event vergib zwei Felder und ergänze fehlende Details, wo möglich:

1. "audience" — nur zwei Werte:
   - "family": EINDEUTIG kinder-/familienfreundlich für 8-14 Jahre.
     Beispiele: Familienkonzert, Kinderworkshop, Mitmachausstellung, Kindertheater, Zirkus, Museum mit Kinderprogramm, Familienflohmarkt, Kinderfilm.
   - "adult": Alles andere — auch Stadtfeste, große Konzerte, Museumsnächte, Kino, Lesungen, wenn nicht explizit für Kinder beworben.
     Im Zweifel IMMER "adult". Lieber zu vorsichtig als zu inklusiv.

2. "category" — eine von:
   - "concert": Live-Musik (Konzert, Festival, DJ-Set, Klassik, Jazz, Pop, Rock, Hip-Hop)
   - "stage": Bühne (Theater, Comedy, Lesung, Cabaret, Oper, Tanzaufführung)
   - "art": Kunst (Ausstellung, Museum, Galerie, Vernissage, Kunstführung)
   - "cinema": Film (Kinovorführung, Open-Air-Kino, Filmfestival, Filmpremiere)
   - "market": Stadt & Markt (Stadtfest, Flohmarkt, Wochenmarkt, Weihnachtsmarkt, Stadtführung, Stadtteilfest)
   - "sport": Sport zum Zugucken oder Mitmachen (Spiel, Wettkampf, Lauf, Sportfest)
   - "other": Alles andere (Workshop, Vortrag, Party, politische Veranstaltung, Lesung außerhalb Bühne)

3. "locationGuess" — wenn das Feld "location" leer oder unklar ist, leite einen Ort aus dem Titel/der Beschreibung ab (z.B. "Konzert in der Elbphilharmonie" → "Elbphilharmonie"). Wenn nichts ableitbar: leer lassen.

4. "costGuess" — wenn "cost" leer ist, aber Beschreibung "kostenlos"/"frei"/"Eintritt frei" oder einen Preis enthält: extrahieren. Wenn typisch kostenfreies Event (Vernissage, öffentliche Ausstellung, Stadtführung): "frei" wenn klar erkennbar. Sonst leer lassen.

5. "reason" — kurze Begründung der audience-Einordnung (max 8 Wörter).

Veranstaltungen:
${JSON.stringify(compact, null, 1)}

Gib AUSSCHLIESSLICH ein JSON-Array zurück, gleiche Reihenfolge, mit "i" als Index, kein Markdown:

[
  {
    "i": 0,
    "audience": "family"|"adult",
    "category": "concert"|"stage"|"art"|"kids"|"sport"|"other",
    "locationGuess": "abgeleiteter Ort oder leer",
    "costGuess": "abgeleitete Kosten oder leer",
    "reason": "max 8 Wörter"
  }
]`;

  try {
    const client = getAnthropicClient();
    const response = await createWithRetry(client, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractTextFromResponse(response.content as any[]);
    const parsed = extractJson<Array<{
      i: number;
      audience: string;
      category: string;
      locationGuess?: string;
      costGuess?: string;
      reason: string;
    }>>(text);

    const byIdx = new Map<number, typeof parsed[0]>();
    for (const p of parsed) byIdx.set(p.i, p);

    return raw.map((e, i) => {
      const cls = byIdx.get(i);
      const audience: Audience =
        cls?.audience === "family" ? "family" : "adult";
      const category: Category = normalizeCategory(cls?.category);

      // Pick the best URL: event-specific URL > source listing URL
      const sourceUrl = e.url || e.sourceListingUrl || "";

      // Use Haiku's locationGuess only when original was empty
      const finalLocation =
        (e.location && e.location.trim()) ||
        (cls?.locationGuess?.trim() || "");
      const finalCost =
        (e.cost && e.cost.trim()) ||
        (cls?.costGuess?.trim() || "");

      return {
        title: e.title,
        datetime: e.datetime,
        location: finalLocation,
        description: e.description || "",
        cost: finalCost,
        audience,
        category,
        audienceReason: cls?.reason || "",
        sourceName: e.sourceName,
        sourceUrl,
      };
    });
  } catch (err) {
    console.error("Classification failed, defaulting to adult/other", err);
    return raw.map((e) => ({
      title: e.title,
      datetime: e.datetime,
      location: e.location || "",
      description: e.description || "",
      cost: e.cost || "",
      audience: "adult" as Audience,
      category: "other" as Category,
      audienceReason: "",
      sourceName: e.sourceName,
      sourceUrl: e.url || e.sourceListingUrl || "",
    }));
  }
}

function normalizeCategory(c: string | undefined): Category {
  if (!c) return "other";
  const lower = c.toLowerCase();
  if (lower === "concert" || lower === "stage" || lower === "art" ||
      lower === "cinema" || lower === "market" || lower === "sport" ||
      lower === "other") {
    return lower as Category;
  }
  // Map old/alternative values to closest match
  if (lower === "kids") return "other"; // kids is now an audience, not a category
  if (lower === "festival") return "market";
  return "other";
}
