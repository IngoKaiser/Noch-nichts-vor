import type { SourceRecord } from "./types";

const ACTIVE_KEY = "nnv:active";

export function saveActiveLocation(record: SourceRecord): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(record));
  } catch (e) {
    console.error("Could not save", e);
  }
}

export function loadActiveLocation(): SourceRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SourceRecord;
  } catch (e) {
    console.error("Could not load", e);
    return null;
  }
}

export function clearActiveLocation(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch (e) {
    console.error("Could not clear", e);
  }
}
