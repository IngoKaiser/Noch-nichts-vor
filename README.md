# Noch nichts vor?

Lokaler Veranstaltungsfinder. Identifiziert pro Stadt/Region einmalig ein kuratiertes Quellenset (offizielle Kalender, redaktionelle Portale, Aggregatoren wie Rausgegangen, Venues) und nutzt dieses für alle weiteren Eventabfragen.

## Features

- **Quellen-Kuratierung**: Checkboxen-Auswahl aus automatisch gefundenen Kandidaten
- **Zeitfilter**: Heute, heute Abend, Wochenende, eigenes Datum
- **Familientauglichkeit**: Klassifikation nach Altersgruppe (8–14 / Erwachsene / gemischt)
- **Persistenz**: Quellensets werden im Browser gespeichert (localStorage)
- **Quellen-Auffrischung** als bewusster Trigger

## Lokal entwickeln

```bash
npm install
cp .env.example .env.local
# Trage deinen ANTHROPIC_API_KEY in .env.local ein
npm run dev
```

App läuft auf http://localhost:3000

## Auf Vercel deployen

1. Dieses Repo zu GitHub pushen
2. In Vercel: "Add New Project" → Repo auswählen
3. Unter **Environment Variables** hinzufügen:
   - `ANTHROPIC_API_KEY` = dein API-Key von console.anthropic.com
4. Deploy

Framework wird automatisch als Next.js erkannt — keine weiteren Einstellungen nötig.

## Architektur

- `app/page.tsx` — Haupt-UI
- `app/api/discover/route.ts` — Quellensuche (serverseitig, nutzt Anthropic web_search)
- `app/api/events/route.ts` — Eventsuche (serverseitig, nutzt Anthropic web_search)
- `lib/storage.ts` — localStorage-Wrapper
- `lib/types.ts` — TypeScript-Typen

Der Anthropic-API-Key wird ausschließlich serverseitig verwendet.

## Quellen-Priorisierung

Die App sucht gezielt nach mehreren Quellentypen:

1. **Offizielle** städtische Veranstaltungskalender
2. **Redaktionelle** Lokalmedien (z.B. MOPO, Mitteldeutsche Zeitung, Stadtmagazine)
3. **Aggregatoren/Stadtblogs** (z.B. "Heute in Hamburg", Rausgegangen, Stadtbekannt)
4. **Venues** mit eigenem Kalender
5. **Tourismus-Websites**
6. **Kommerzielle Plattformen** (nur ergänzend)

Du entscheidest per Checkbox, welche davon tatsächlich genutzt werden.
