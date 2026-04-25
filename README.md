# Noch nichts vor?

Lokaler Veranstaltungsfinder. Identifiziert pro Stadt einmalig ein kuratiertes Quellenset und ruft Events anschließend über strukturierte Adapter ab — günstig, schnell, skalierbar.

## Architektur

Drei klar getrennte Pipelines:

**1. Quellen-Discovery (einmalig pro Stadt)** — `/api/discover`
- Claude Sonnet 4 mit `web_search`
- Findet 10–12 Kandidatenquellen aus 6 Kategorien (offiziell, redaktionell, Aggregator, Venue, Tourismus, kommerziell)
- Nutzer kuratiert per Checkbox → Auswahl wird gespeichert

**2. Adapter-Probing (einmalig pro Quelle)** — `/api/probe`
- Pro Quelle wird der beste Abrufmechanismus erkannt:
  1. **JSON-LD** — `<script type="application/ld+json">` mit `@type: Event` (Gold-Standard, viele moderne Sites)
  2. **iCal/ICS** — `.ics`-Feeds (städtische Kalender, Hochschulen)
  3. **RSS/Atom** — Newsfeeds (Tageszeitungen wie MOPO)
  4. **HTML + Haiku** — generischer Fallback: Cheerio extrahiert Hauptinhalt, Claude Haiku strukturiert ihn als JSON
- Ergebnis wird mit der Quelle persistiert

**3. Event-Abruf (laufend)** — `/api/events`
- Cache-Hit? → instant zurück
- Sonst: parallel von allen Quellen über die jeweiligen Adapter ziehen
- Mergen, deduplizieren, nach Datum filtern, sortieren
- Eine einzige Haiku-Klassifikation für alle Events (Familie 8–14 / Erwachsene / gemischt)
- 1h-Cache pro `(Stadt × Zeitfilter)`

## Kostenvergleich

| Mechanismus | Kosten/Abruf | Latenz |
|---|---|---|
| Alt: Sonnet + Websuche | ~5–15 Cent | 20–40 s |
| Neu: JSON-LD/iCal/RSS | ~0 € | 1–3 s |
| Neu: HTML + Haiku | ~0,1–0,2 Cent | 3–6 s |
| Neu: Cache-Hit | 0 € | <100 ms |

In der Praxis liefern bei den meisten Städten 60–80 % der Quellen JSON-LD oder Feeds, der Rest läuft günstig über Haiku.

## Lokal entwickeln

```bash
npm install
cp .env.example .env.local
# ANTHROPIC_API_KEY in .env.local eintragen
npm run dev
```

→ http://localhost:3000

## Auf Vercel deployen

1. Repo zu GitHub pushen
2. [vercel.com/new](https://vercel.com/new) → Repo importieren
3. Environment Variables: `ANTHROPIC_API_KEY` setzen
4. Deploy

Framework wird automatisch als Next.js erkannt.

**Wichtig:** Der In-Memory-Cache ist pro Serverless-Instance. Bei höherer Last und mehreren parallelen Lambdas profitieren nicht alle Anfragen vom Cache. Für echte Skalierung später auf Vercel KV oder Upstash Redis umstellen — der Code ist dafür vorbereitet (`lib/cache.ts` ist die einzige Stelle, die ausgetauscht werden muss).

## Projektstruktur

```
app/
├── page.tsx                  Hauptseite (Single-Location, Mobile-First)
├── layout.tsx, globals.css
└── api/
    ├── discover/route.ts     Quellensuche (Sonnet + web_search)
    ├── probe/route.ts        Adapter-Erkennung pro Quelle
    └── events/route.ts       Event-Pipeline (Adapter → Klassifikation → Cache)
lib/
├── adapters/
│   ├── index.ts              Adapter-Routing
│   ├── http.ts               Polite fetch mit UA + Timeout
│   ├── jsonld.ts             schema.org Events aus HTML
│   ├── ical.ts               .ics-Feeds (ical.js)
│   ├── rss.ts                RSS/Atom (fast-xml-parser)
│   └── html.ts               Generic HTML + Haiku-Strukturierung
├── anthropic.ts              SDK + Retry-Wrapper
├── cache.ts                  In-Memory TTL-Cache
├── classify.ts               Audience-Klassifikation (Haiku)
├── timefilter.ts             Datumsbereiche, Sortierung, Dedupe
├── storage.ts                localStorage (Single Active Location)
└── types.ts                  TypeScript-Typen
```

## Quellen-Priorisierung beim Discovery

Der Discovery-Prompt sucht gezielt nach:
1. Offiziellen städtischen Veranstaltungskalendern
2. Redaktionellen Lokalmedien (MOPO, Hamburger Abendblatt, PRINZ, tip Berlin, Mitvergnügen…)
3. **Aggregatoren** (Rausgegangen, „Heute in Hamburg/München/Köln", Stadtbekannt, Ask Helmut, Kulturkurier) — der wichtigste Kategorie, früher unter den Tisch gefallen
4. Venues mit eigenem Kalender
5. Tourismus-Sites
6. Kommerziell (max 1–2: Eventim, Reservix)

Du entscheidest per Checkbox, welche davon tatsächlich genutzt werden.
