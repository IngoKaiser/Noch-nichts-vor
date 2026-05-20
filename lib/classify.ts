import type { Event, RawEvent, Audience, Category } from "./types";
import { getAnthropicClient, extractTextFromResponse, extractJson, createWithRetry } from "./anthropic";

/**
 * Classify and enrich raw events.
 *
 * Strategy:
 * - Batch events into chunks of CHUNK_SIZE (Haiku call per chunk)
 * - Parallel execution of all chunks
 * - On per-chunk failure: fall back to KEYWORD-BASED classification for that chunk
 *   (NOT all "adult/other" — that's the previous bug that made everything look the same)
 *
 * Result: scales to hundreds of events, gracefully degrades when LLM fails.
 */

const CHUNK_SIZE = 40; // events per Haiku call — safe for ~4000 max_tokens output

export async function classifyEvents(raw: RawEvent[]): Promise<Event[]> {
  if (raw.length === 0) return [];

  // Split into chunks
  const chunks: RawEvent[][] = [];
  for (let i = 0; i < raw.length; i += CHUNK_SIZE) {
    chunks.push(raw.slice(i, i + CHUNK_SIZE));
  }

  // Classify all chunks in parallel
  const results = await Promise.all(chunks.map(classifyChunk));
  return results.flat();
}

async function classifyChunk(chunk: RawEvent[]): Promise<Event[]> {
  const compact = chunk.map((e, i) => ({
    i,
    title: e.title,
    description: trim(e.description || "", 200),
    location: e.location || "",
    cost: e.cost || "",
    datetime: e.datetime || "",
  }));

  const prompt = `Du klassifizierst Veranstaltungen für eine deutsche Veranstaltungs-App.

Für JEDES Event:

1. "audience" — exakt zwei Werte:
   - "family": EINDEUTIG kinder-/familienfreundlich für 8-14 Jahre.
     Erkennungsmerkmale: "Familie", "Kinder", "ab X Jahren" (X≤14), "Kindertheater", "Kinderkonzert", "Mitmachausstellung", "Workshop für Kinder", "Schulkinder", "Zirkus", "Märchen", "Puppentheater".
   - "adult": Alles andere — auch Stadtfeste, große Konzerte, Museumsnächte, Kino, Lesungen.
     Im Zweifel "adult".

2. "category" — eine von (in dieser Priorität bei Mehrdeutigkeit):
   - "concert": Live-Musik jeder Art (Konzert, Festival, DJ-Set, Klassik, Jazz, Pop, Rock, Hip-Hop, Singer-Songwriter, Chormusik, Orgelkonzert)
   - "stage": Theater, Comedy, Lesung, Cabaret, Oper, Musical, Tanz, Schauspiel, Improtheater
   - "art": Kunstausstellung, Museum, Galerie, Vernissage, Kunstführung, Skulpturen, Fotografie
   - "cinema": Kinofilm, Open-Air-Kino, Filmfestival, Filmpremiere, Filmvorführung
   - "market": Stadtfest, Flohmarkt, Wochenmarkt, Weihnachtsmarkt, Stadtteilfest, Straßenfest, Spezialmarkt, Stadtführung, Stadtrundgang
   - "sport": Fußballspiel, Wettkampf, Lauf, Sportfest, Turnier, Yoga-Event, Lauftreff
   - "other": Workshop für Erwachsene, Vortrag, Party, Diskussion, politische Veranstaltung, Networking

3. "locationGuess" — wenn "location" leer: aus Titel/Beschreibung ableiten. Sonst leer.

4. "costGuess" — wenn "cost" leer: aus Beschreibung extrahieren ("kostenlos"/"frei"/Preis). Bei Vernissagen/öffentlichen Ausstellungen/Stadtteilfesten oft "frei". Sonst leer.

5. "reason" — kurze Begründung der audience-Einordnung (max 8 Wörter).

WICHTIG zur Kategorisierung: Wähle die SPEZIFISCHSTE passende Kategorie. "other" nur wenn wirklich keine andere passt. Ein "Konzert" ist NIEMALS "other". Ein "Theater-Stück" ist NIEMALS "other". Sei großzügig mit market (für alles Stadt-/Marktähnliche).

Events:
${JSON.stringify(compact, null, 1)}

Gib AUSSCHLIESSLICH JSON-Array zurück, gleiche Indices, kein Markdown:

[
  {"i": 0, "audience": "family"|"adult", "category": "concert"|"stage"|"art"|"cinema"|"market"|"sport"|"other", "locationGuess": "", "costGuess": "", "reason": "..."}
]`;

  try {
    const client = getAnthropicClient();
    const response = await createWithRetry(client, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractTextFromResponse(response.content as any[]);
    const parsed = extractJson<Array<{
      i: number;
      audience: string;
      category: string;
      locationGuess?: string;
      costGuess?: string;
      reason?: string;
    }>>(text);

    const byIdx = new Map<number, typeof parsed[0]>();
    for (const p of parsed) byIdx.set(p.i, p);

    return chunk.map((e, i) => {
      const cls = byIdx.get(i);
      if (!cls) {
        // This particular event was missing from the response — apply keyword fallback
        return keywordFallback(e);
      }
      const audience: Audience = cls.audience === "family" ? "family" : "adult";
      const category: Category = normalizeCategory(cls.category, e.title, e.description);

      const sourceUrl = e.url || e.sourceListingUrl || "";
      const finalLocation = (e.location && e.location.trim()) || (cls.locationGuess?.trim() || "");
      const finalCost = (e.cost && e.cost.trim()) || (cls.costGuess?.trim() || "");

      return {
        title: e.title,
        datetime: e.datetime,
        location: finalLocation,
        description: e.description || "",
        cost: finalCost,
        audience,
        category,
        audienceReason: cls.reason || "",
        sourceName: e.sourceName,
        sourceUrl,
      };
    });
  } catch (err) {
    console.error("Chunk classification failed, falling back to keyword rules", err);
    // CRITICAL: do NOT default everything to adult/other.
    // Use keyword heuristics so the user still gets meaningful categories.
    return chunk.map(keywordFallback);
  }
}

/**
 * Keyword-based classification used when Haiku is unavailable or returns garbage.
 * Better than "everything is adult/other" — at least the obvious cases get classified.
 */
function keywordFallback(e: RawEvent): Event {
  const haystack = `${e.title} ${e.description || ""}`.toLowerCase();
  const audience = isFamily(haystack) ? "family" : "adult";
  const category = guessCategory(haystack);

  return {
    title: e.title,
    datetime: e.datetime,
    location: e.location || "",
    description: e.description || "",
    cost: extractCostFromText(e.cost || "", e.description || ""),
    audience,
    category,
    audienceReason: "",
    sourceName: e.sourceName,
    sourceUrl: e.url || e.sourceListingUrl || "",
  };
}

function isFamily(text: string): boolean {
  const familyPatterns = [
    /\bkinder/, /\bfamilie/, /\bkita\b/, /\bschulklass/, /\bjugend/,
    /\bab\s*[3-9]\s*jahr/, /\bab\s*1[0-4]\s*jahr/,
    /\bmitmach/, /\bkindertheater/, /\bkinderkonzert/, /\bkinderfest/,
    /\bmärchen/, /\bpuppentheater/, /\bzirkus/, /\bspielplatz/,
    /\bbastel/, /\bsommerferien/, /\bferienprogramm/,
  ];
  return familyPatterns.some((p) => p.test(text));
}

function guessCategory(text: string): Category {
  // Order matters: more specific first
  if (/\b(konzert|festival|band|chor|orchester|symphon|klassik|jazz|rock|pop|hip.?hop|techno|dj.set|musical(?!.?theater)|liederabend|orgelkonzert|songwriter)\b/.test(text)) return "concert";
  if (/\b(theater|schauspiel|oper(?!ette)?|operette|musical|comedy|kabarett|cabaret|lesung|tanz|ballet|improtheater|monolog|bühnenstück)\b/.test(text)) return "stage";
  if (/\b(ausstellung|museum|galerie|vernissage|kunstführung|skulptur|fotografie|gemälde|installation|kunsthalle)\b/.test(text)) return "art";
  if (/\b(kino|film|open.?air.?kino|filmpremiere|filmfestival|filmvorführung|cinema)\b/.test(text)) return "cinema";
  if (/\b(stadtfest|flohmarkt|wochenmarkt|weihnachtsmarkt|straßenfest|stadtteilfest|markt(?!ing)|spezialmarkt|stadtführung|stadtrundgang|fest\b|kirchweih|kirmes)\b/.test(text)) return "market";
  if (/\b(fußball|spiel(?:tag)?|wettkampf|lauf|marathon|turnier|sport|yoga|fitness|bundesliga|spielzeit)\b/.test(text)) return "sport";
  return "other";
}

function extractCostFromText(existing: string, desc: string): string {
  if (existing && existing.trim()) return existing.trim();
  const text = desc.toLowerCase();
  if (/\b(kostenlos|gratis|eintritt frei|frei(?:er)? eintritt)\b/.test(text)) return "frei";
  const priceMatch = desc.match(/(\d+(?:[.,]\d{2})?)\s*€/);
  if (priceMatch) return priceMatch[0].replace(",", ".");
  const fromMatch = desc.match(/ab\s+(\d+(?:[.,]\d{2})?)\s*€/i);
  if (fromMatch) return `ab ${fromMatch[1].replace(",", ".")} €`;
  return "";
}

function normalizeCategory(c: string | undefined, title: string, desc: string | undefined): Category {
  if (!c) return guessCategory(`${title} ${desc || ""}`.toLowerCase());
  const lower = c.toLowerCase();
  if (lower === "concert" || lower === "stage" || lower === "art" ||
      lower === "cinema" || lower === "market" || lower === "sport" ||
      lower === "other") {
    // If LLM said "other" but keyword heuristic finds something specific, prefer that
    if (lower === "other") {
      const guessed = guessCategory(`${title} ${desc || ""}`.toLowerCase());
      if (guessed !== "other") return guessed;
    }
    return lower as Category;
  }
  if (lower === "kids") return "other";
  if (lower === "festival") return "concert"; // festival usually = music
  return guessCategory(`${title} ${desc || ""}`.toLowerCase());
}

function trim(s: string, max: number): string {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max) + "…";
}
