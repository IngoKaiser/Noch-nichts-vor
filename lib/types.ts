export type SourceType =
  | "official"
  | "editorial"
  | "aggregator"
  | "venue"
  | "funfair"
  | "tourism"
  | "commercial";

/**
 * Reduced to two definitive values. Anything not clearly child-friendly
 * defaults to "adult" — the safer assumption for parents using the app.
 */
export type Audience = "family" | "adult";

/**
 * Coarse content categories used as a top-level filter.
 * - "concert": live music of any genre, DJ sets, festivals
 * - "stage": theater, comedy, cabaret, readings, opera, dance
 * - "art": exhibitions, museums, galleries, vernissages
 * - "cinema": film screenings, open-air cinema, film festivals
 * - "market": city festivals, flea markets, food markets, city tours
 * - "sport": competitions, races, public sports events to watch
 * - "other": workshops, lectures, parties, anything else
 */
export type Category = "concert" | "stage" | "art" | "cinema" | "market" | "sport" | "other";

export type AdapterKind = "jsonld" | "ical" | "rss" | "html" | "websearch";

export interface AdapterInfo {
  kind: AdapterKind;
  endpoint?: string;
  probedAt: string;
  ok: boolean;
  note?: string;
}

export interface EventSource {
  name: string;
  url: string;
  type: SourceType;
  focus: string;
  audience: Audience | "general" | "mixed";
  adapter?: AdapterInfo;
}

export interface CandidateSource extends EventSource {
  recommended: boolean;
  selected?: boolean;
}

export interface SourceRecord {
  location: string;
  sources: EventSource[];
  discoveredAt: string;
}

export interface Event {
  title: string;
  datetime: string;
  location: string;
  description: string;
  cost: string;
  audience: Audience;
  category: Category;
  audienceReason: string;
  sourceName: string;
  /** Direct link to the event detail page on the source site. */
  sourceUrl: string;
}

export type TimeFilter = "today" | "tonight" | "weekend" | "custom";

/**
 * Raw event scraped from a source — before audience classification & enrichment.
 */
export interface RawEvent {
  title: string;
  datetime: string;
  location?: string;
  description?: string;
  cost?: string;
  /** Direct link to the event detail page (NOT the source listing page). */
  url?: string;
  sourceName: string;
  /** The listing page URL — used as fallback if no detail link is available. */
  sourceListingUrl?: string;
}
