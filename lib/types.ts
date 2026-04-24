export type SourceType =
  | "official"
  | "editorial"
  | "aggregator"
  | "venue"
  | "tourism"
  | "commercial";

export type Audience = "family" | "adult" | "mixed" | "unknown" | "general";

export interface EventSource {
  name: string;
  url: string;
  type: SourceType;
  focus: string;
  audience: Audience;
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
