import type { SourceRecord } from "./types";

const PREFIX = "heutewas:sources:";

function key(location: string): string {
  return PREFIX + location.toLowerCase().trim();
}

export function saveSources(location: string, record: SourceRecord): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key(location), JSON.stringify(record));
  } catch (e) {
    console.error("Could not save sources", e);
  }
}

export function loadSources(location: string): SourceRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(location));
    if (!raw) return null;
    return JSON.parse(raw) as SourceRecord;
  } catch (e) {
    console.error("Could not load sources", e);
    return null;
  }
}

export function deleteSources(location: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key(location));
  } catch (e) {
    console.error("Could not delete sources", e);
  }
}

export function listLocations(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const result: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        result.push(k.substring(PREFIX.length));
      }
    }
    return result.sort();
  } catch (e) {
    console.error("Could not list locations", e);
    return [];
  }
}
