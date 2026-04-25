export type SourceType =
  | "official"
  | "editorial"
  | "aggregator"
  | "venue"
  | "tourism"
  | "commercial";

export type Audience = "family" | "adult" | "mixed" | "unknown" | "general";

export type AdapterKind = "jsonld" | "ical" | "rss" | "html" | "websearch";

export interface AdapterInfo {
  kind: AdapterKind;
  /**
   * For ical/rss: the actual feed URL (may differ from the source URL).
   * For html: optionally a selector hint.
   * For jsonld: not required (extracted from page).
   * For websearch: not used.
   */
  endpoint?: string;
  /**
   * When the adapter probe was performed.
   */
  probedAt: string;
  /**
   * Whether the last probe found events successfully.
   */
  ok: boolean;
  /**
   * Optional note about the probe (e.g., error reason).
   */
  note?: string;
}

export interface EventSource {
  name: string;
  url: string;
  type: SourceType;
  focus: string;
  audience: Audience;
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
  audienceReason: string;
  sourceName: string;
  sourceUrl: string;
}

export type TimeFilter = "today" | "tonight" | "weekend" | "custom";

/**
 * Raw event scraped from a source — before audience classification.
 */
export interface RawEvent {
  title: string;
  datetime: string;
  location?: string;
  description?: string;
  cost?: string;
  url?: string;
  sourceName: string;
}
