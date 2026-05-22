"use client";

import React, { useState, useEffect } from "react";
import {
  MapPin,
  Search,
  RefreshCw,
  Clock,
  Euro,
  Users,
  ExternalLink,
  AlertCircle,
  Loader2,
  Check,
  Settings,
  ChevronLeft,
} from "lucide-react";
import {
  loadActiveLocation,
  saveActiveLocation,
  clearActiveLocation,
} from "@/lib/storage";
import type {
  CandidateSource,
  EventSource,
  Event,
  TimeFilter,
  SourceRecord,
  Audience,
  Category,
} from "@/lib/types";

const APP_NAME = "Noch nichts vor?";

type Phase = "idle" | "discovering" | "curating" | "searching";
type View = "main" | "settings";

export default function HomePage() {
  const [view, setView] = useState<View>("main");
  const [locationInput, setLocationInput] = useState("");
  const [activeRecord, setActiveRecord] = useState<SourceRecord | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("today");
  const [customDate, setCustomDate] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<{
    userMessage: string;
    code?: string;
    retryAfter?: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [candidateSources, setCandidateSources] = useState<CandidateSource[] | null>(null);
  const [curationLocation, setCurationLocation] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  // Diagnostic info from the last search — used to show per-source results
  // ("Source X returned 0 events") so user can see where the data is coming from.
  const [searchMeta, setSearchMeta] = useState<{
    sourceStatus?: Array<{ name: string; ok: boolean; count: number; fromCache?: boolean; note?: string }>;
    finalCount?: number;
    cappedFrom?: number;
    fromCache?: boolean;
  } | null>(null);

  // Display filters — operate on already-fetched events, no API call required
  const [audienceFilter, setAudienceFilter] = useState<"all" | Audience>("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | Category>("all");

  // Load active location on mount, but do NOT auto-search.
  // User picks a time filter first, then clicks search — avoids wasted
  // calls when they actually wanted to search for a different time period.
  useEffect(() => {
    const rec = loadActiveLocation();
    setActiveRecord(rec);
    setHydrated(true);
  }, []);

  // Tick once per second when an error has a retryAfter timestamp,
  // so the countdown updates live without manual refresh.
  useEffect(() => {
    if (!error?.retryAfter) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [error?.retryAfter]);

  async function discoverCandidates(loc: string): Promise<CandidateSource[]> {
    setPhase("discovering");
    setStatusMsg(`Identifiziere Quellen für ${loc}…`);
    setError(null);
    setCandidateSources(null);

    const res = await fetch("/api/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: loc }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw makeApiError(data, res.status);
    }
    const data = await res.json();
    return data.sources as CandidateSource[];
  }

  async function searchEventsInternal(
    loc: string,
    sourceList: EventSource[],
    filter: TimeFilter,
    customDateStr: string
  ) {
    setPhase("searching");
    setStatusMsg(`Suche Veranstaltungen…`);
    setError(null);

    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: loc,
          sources: sourceList,
          timeFilter: filter,
          customDate: customDateStr,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw makeApiError(data, res.status);
      }
      const data = await res.json();
      setEvents(data.events as Event[]);
      setSearchMeta(data.meta || null);
      setPhase("idle");
      setStatusMsg("");
    } catch (e: any) {
      console.error(e);
      setError(extractErrorObj(e));
      setPhase("idle");
    }
  }

  async function handleStartDiscovery() {
    if (!locationInput.trim()) return;
    const loc = locationInput.trim();

    try {
      const candidates = await discoverCandidates(loc);
      setCandidateSources(
        candidates.map((s) => ({ ...s, selected: s.recommended !== false }))
      );
      setCurationLocation(loc);
      setPhase("curating");
      setStatusMsg("");
    } catch (e: any) {
      console.error(e);
      setError(extractErrorObj(e));
      setPhase("idle");
    }
  }

  async function handleRefreshSources() {
    if (!activeRecord) return;
    setView("main");
    try {
      const candidates = await discoverCandidates(activeRecord.location);
      const currentUrls = new Set(activeRecord.sources.map((s) => s.url));
      setCandidateSources(
        candidates.map((s) => ({
          ...s,
          selected: currentUrls.has(s.url) || s.recommended !== false,
        }))
      );
      setCurationLocation(activeRecord.location);
      setPhase("curating");
      setStatusMsg("");
    } catch (e: any) {
      setError(extractErrorObj(e));
      setPhase("idle");
    }
  }

  function toggleCandidate(index: number) {
    setCandidateSources((prev) =>
      prev ? prev.map((s, i) => (i === index ? { ...s, selected: !s.selected } : s)) : prev
    );
  }

  function selectAllCandidates(value: boolean) {
    setCandidateSources((prev) =>
      prev ? prev.map((s) => ({ ...s, selected: value })) : prev
    );
  }

  async function handleConfirmSources() {
    if (!candidateSources || !curationLocation) return;
    const selected = candidateSources
      .filter((s) => s.selected)
      .map(({ selected, recommended, ...rest }) => rest) as EventSource[];

    if (selected.length === 0) {
      setError({ userMessage: "Bitte mindestens eine Quelle auswählen.", code: "no_sources" });
      return;
    }

    // Step 1: probe adapters for each source (parallel, server-side)
    setPhase("discovering");
    setStatusMsg("Prüfe Quellen auf direkte Datenfeeds…");
    setError(null);

    let probedSources: EventSource[] = selected;
    try {
      const res = await fetch("/api/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: selected }),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.sources)) probedSources = data.sources;
      }
      // If probe fails, fall through with un-probed sources;
      // the events route will still work via the HTML adapter fallback.
    } catch (e) {
      console.error("Probe failed, falling back", e);
    }

    const record: SourceRecord = {
      location: curationLocation,
      sources: probedSources,
      discoveredAt: new Date().toISOString(),
    };
    saveActiveLocation(record);
    setActiveRecord(record);
    setCandidateSources(null);
    setCurationLocation(null);
    setPhase("idle");
    setStatusMsg("");
    setError(null);
    setEvents([]);
    setTimeFilter("today");
    await searchEventsInternal(record.location, probedSources, "today", "");
  }

  function handleCancelCuration() {
    setCandidateSources(null);
    setCurationLocation(null);
    setPhase("idle");
    setStatusMsg("");
    setError(null);
  }

  async function handleSearchEvents() {
    if (!activeRecord) return;
    if (timeFilter === "custom" && !customDate) {
      setError({ userMessage: "Bitte Datum wählen.", code: "bad_request" });
      return;
    }
    await searchEventsInternal(
      activeRecord.location,
      activeRecord.sources,
      timeFilter,
      customDate
    );
  }

  function handleChangeCity() {
    clearActiveLocation();
    setActiveRecord(null);
    setEvents([]);
    setLocationInput("");
    setView("main");
    setError(null);
  }

  const audienceConfig: Record<Audience, { label: string; color: string; icon: string }> = {
    family: { label: "Familie", color: "var(--accent-family)", icon: "♡" },
    adult: { label: "Erw.", color: "var(--accent-adult)", icon: "⬢" },
  };

  const categoryConfig: Record<Category, { label: string; icon: string }> = {
    concert: { label: "Konzert", icon: "♪" },
    stage: { label: "Bühne", icon: "✦" },
    art: { label: "Kunst", icon: "◈" },
    cinema: { label: "Kino", icon: "▶" },
    market: { label: "Stadt & Markt", icon: "⊙" },
    sport: { label: "Sport", icon: "◎" },
    other: { label: "Sonstiges", icon: "·" },
  };

  // Apply display filters to fetched events
  const filteredEvents = events.filter((ev) => {
    if (audienceFilter !== "all" && ev.audience !== audienceFilter) return false;
    if (categoryFilter !== "all" && ev.category !== categoryFilter) return false;
    return true;
  });

  // Counts per category, used to show numbers in filter buttons
  const categoryCounts: Record<string, number> = { all: events.length };
  for (const ev of events) {
    categoryCounts[ev.category] = (categoryCounts[ev.category] || 0) + 1;
  }
  const audienceCounts: Record<string, number> = {
    all: events.length,
    family: events.filter((e) => e.audience === "family").length,
    adult: events.filter((e) => e.audience === "adult").length,
  };

  const typeLabel: Record<string, string> = {
    official: "Offiziell",
    editorial: "Redaktion",
    aggregator: "Aggregator",
    venue: "Venue",
    tourism: "Tourismus",
    commercial: "Kommerziell",
  };

  const typeColor: Record<string, string> = {
    official: "#2d6a4f",
    editorial: "#c44536",
    aggregator: "#0066cc",
    venue: "#6a4c93",
    tourism: "#b8860b",
    commercial: "#7a6f61",
  };

  const adapterLabel: Record<string, string> = {
    jsonld: "JSON-LD",
    ical: "iCal",
    rss: "RSS",
    html: "HTML",
    websearch: "Suche",
  };

  const adapterColor: Record<string, string> = {
    jsonld: "#2d6a4f",
    ical: "#2d6a4f",
    rss: "#0066cc",
    html: "#b8860b",
    websearch: "#7a6f61",
  };

  const isBusy = phase === "discovering" || phase === "searching";
  const inCuration = phase === "curating";
  const selectedCount = candidateSources?.filter((s) => s.selected).length || 0;

  // Don't render until hydrated to prevent flash
  if (!hydrated) {
    return <div style={S.root} />;
  }

  // ============ CURATION VIEW ============
  if (inCuration && candidateSources) {
    return (
      <div style={S.root}>
        <header style={S.compactHeader}>
          <button onClick={handleCancelCuration} style={S.backBtn} aria-label="Zurück">
            <ChevronLeft size={20} />
          </button>
          <div style={S.compactTitle}>Quellen für {curationLocation}</div>
          <div style={{ width: 36 }} />
        </header>

        <main style={S.main}>
          <p style={S.curationIntro}>
            {candidateSources.length} Quellen gefunden. Wähle aus, welche genutzt werden.
          </p>

          <div style={S.curationActions}>
            <span style={S.selectedCounter}>
              {selectedCount}/{candidateSources.length} ausgewählt
            </span>
            <div style={S.miniBtnGroup}>
              <button onClick={() => selectAllCandidates(true)} style={S.miniBtn}>
                Alle
              </button>
              <button onClick={() => selectAllCandidates(false)} style={S.miniBtn}>
                Keine
              </button>
              <button
                onClick={() =>
                  setCandidateSources((prev) =>
                    prev ? prev.map((s) => ({ ...s, selected: s.recommended !== false })) : prev
                  )
                }
                style={S.miniBtn}
              >
                ★
              </button>
            </div>
          </div>

          <div style={S.candidateList}>
            {candidateSources.map((s, i) => (
              <label
                key={i}
                style={{
                  ...S.candidateCard,
                  ...(s.selected ? S.candidateCardActive : {}),
                }}
              >
                <input
                  type="checkbox"
                  checked={!!s.selected}
                  onChange={() => toggleCandidate(i)}
                  style={S.hiddenCheckbox}
                />
                <div
                  style={{
                    ...S.checkBox,
                    ...(s.selected ? S.checkBoxActive : {}),
                  }}
                >
                  {s.selected && <Check size={12} strokeWidth={3} />}
                </div>
                <div style={S.candidateContent}>
                  <div style={S.candidateTopRow}>
                    <span
                      style={{
                        ...S.candidateType,
                        color: typeColor[s.type] || "var(--muted-fg)",
                      }}
                    >
                      {typeLabel[s.type] || s.type}
                    </span>
                    {s.recommended && <span style={S.starBadge}>★</span>}
                  </div>
                  <div style={S.candidateName}>{s.name}</div>
                  <div style={S.candidateFocus}>{s.focus}</div>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    style={S.candidateUrl}
                  >
                    {hostname(s.url)}
                  </a>
                </div>
              </label>
            ))}
          </div>

          {error && (
            <div style={S.errorBar}>
              <AlertCircle size={14} />
              <div style={{ flex: 1 }}>
                <div>{error.userMessage}</div>
                {error.retryAfter && (
                  <div style={S.errorCountdown}>
                    {formatCountdown(error.retryAfter, now)}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {/* Sticky bottom action bar */}
        <div style={S.bottomBar}>
          <button onClick={handleCancelCuration} style={S.bottomBarGhost}>
            Abbrechen
          </button>
          <button
            onClick={handleConfirmSources}
            disabled={selectedCount === 0}
            style={{
              ...S.bottomBarPrimary,
              ...(selectedCount === 0 ? S.disabled : {}),
            }}
          >
            <Check size={16} />
            {selectedCount} übernehmen
          </button>
        </div>
      </div>
    );
  }

  // ============ SETTINGS VIEW ============
  if (view === "settings" && activeRecord) {
    return (
      <div style={S.root}>
        <header style={S.compactHeader}>
          <button onClick={() => setView("main")} style={S.backBtn} aria-label="Zurück">
            <ChevronLeft size={20} />
          </button>
          <div style={S.compactTitle}>Einstellungen</div>
          <div style={{ width: 36 }} />
        </header>

        <main style={S.main}>
          <div style={S.settingsSection}>
            <div style={S.settingsLabel}>Aktive Stadt</div>
            <div style={S.settingsCity}>{activeRecord.location}</div>
            <div style={S.settingsMeta}>
              {activeRecord.sources.length} Quellen · seit{" "}
              {new Date(activeRecord.discoveredAt).toLocaleDateString("de-DE")}
            </div>
            <div style={S.settingsActions}>
              <button onClick={handleRefreshSources} style={S.settingsBtn}>
                <RefreshCw size={14} />
                Quellen auffrischen
              </button>
              <button onClick={handleChangeCity} style={S.settingsBtn}>
                <MapPin size={14} />
                Stadt wechseln
              </button>
            </div>
          </div>

          <div style={S.settingsSection}>
            <div style={S.settingsLabel}>Genutzte Quellen</div>
            <div style={S.sourcesList}>
              {activeRecord.sources.map((s, i) => (
                <a
                  key={i}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  style={S.sourceListItem}
                >
                  <div style={S.sourceListHeader}>
                    <span
                      style={{
                        ...S.candidateType,
                        color: typeColor[s.type] || "var(--accent)",
                      }}
                    >
                      {typeLabel[s.type] || s.type}
                    </span>
                    {s.adapter && (
                      <span
                        style={{
                          ...S.adapterBadge,
                          color: adapterColor[s.adapter.kind] || "var(--muted-fg)",
                          borderColor: adapterColor[s.adapter.kind] || "var(--border)",
                        }}
                        title={s.adapter.note || ""}
                      >
                        {adapterLabel[s.adapter.kind] || s.adapter.kind}
                      </span>
                    )}
                    <ExternalLink size={11} style={{ color: "var(--muted-fg)", marginLeft: "auto" }} />
                  </div>
                  <div style={S.sourceListName}>{s.name}</div>
                  <div style={S.sourceListUrl}>{hostname(s.url)}</div>
                </a>
              ))}
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ============ EMPTY STATE (no city yet) ============
  if (!activeRecord) {
    return (
      <div style={S.root}>
        <main style={S.emptyMain}>
          <div className="slide-up">
            <div style={S.emptyMark}>◉</div>
            <h1 style={S.emptyTitle} className="serif">
              {APP_NAME}
            </h1>
            <p style={S.emptySub}>Lokaler Veranstaltungsfinder</p>
          </div>

          <div style={S.emptyForm} className="slide-up">
            <p style={S.emptyHelp}>
              Welche Stadt? Ich suche dann passende Quellen — du wählst aus.
            </p>
            <div style={S.inputWrap}>
              <MapPin size={18} style={S.inputIcon} />
              <input
                type="text"
                value={locationInput}
                onChange={(e) => setLocationInput(e.target.value)}
                placeholder="z.B. Hamburg"
                style={S.input}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && locationInput.trim()) handleStartDiscovery();
                }}
                disabled={isBusy}
                autoFocus
              />
            </div>
            <button
              onClick={handleStartDiscovery}
              disabled={!locationInput.trim() || isBusy}
              style={{
                ...S.primaryFullBtn,
                ...(!locationInput.trim() || isBusy ? S.disabled : {}),
              }}
            >
              {phase === "discovering" ? (
                <>
                  <Loader2 size={16} className="spin" /> Quellen werden gesucht…
                </>
              ) : (
                <>
                  <Search size={16} /> Quellen suchen
                </>
              )}
            </button>
            {error && (
              <div style={S.errorBar}>
                <AlertCircle size={14} />
                <div style={{ flex: 1 }}>
                  <div>{error.userMessage}</div>
                  {error.retryAfter && (
                    <div style={S.errorCountdown}>
                      {formatCountdown(error.retryAfter, now)}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ============ MAIN VIEW (active city, events front and center) ============
  return (
    <div style={S.root}>
      <header style={S.mainHeader}>
        <div>
          <div style={S.cityKicker}>
            {new Date().toLocaleDateString("de-DE", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </div>
          <h1 style={S.cityName} className="serif">
            {activeRecord.location}
          </h1>
        </div>
        <button onClick={() => setView("settings")} style={S.iconBtn} aria-label="Einstellungen">
          <Settings size={18} />
        </button>
      </header>

      <main style={S.main}>
        {/* TIME FILTERS — front and center */}
        <div style={S.filterScroll}>
          {[
            { k: "today" as TimeFilter, label: "Heute" },
            { k: "tonight" as TimeFilter, label: "Heute Abend" },
            { k: "weekend" as TimeFilter, label: "Wochenende" },
            { k: "custom" as TimeFilter, label: "Datum…" },
          ].map((f) => (
            <button
              key={f.k}
              onClick={() => setTimeFilter(f.k)}
              style={{
                ...S.filterBtn,
                ...(timeFilter === f.k ? S.filterBtnActive : {}),
              }}
              disabled={isBusy}
            >
              {f.label}
            </button>
          ))}
        </div>

        {timeFilter === "custom" && (
          <div style={S.customDateRow}>
            <input
              type="date"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              style={S.dateInput}
              disabled={isBusy}
            />
          </div>
        )}

        {/* Big search button — always visible after a city is active */}
        <button
          onClick={handleSearchEvents}
          disabled={isBusy || (timeFilter === "custom" && !customDate)}
          style={{
            ...S.bigSearchBtn,
            ...(isBusy || (timeFilter === "custom" && !customDate)
              ? S.disabled
              : {}),
          }}
        >
          {isBusy ? (
            <>
              <Loader2 size={16} className="spin" /> Suche läuft…
            </>
          ) : (
            <>
              <Search size={16} /> Veranstaltungen suchen
            </>
          )}
        </button>

        {/* STATUS / ERROR */}
        {isBusy && (
          <div style={S.statusBar}>
            <Loader2 size={14} className="spin" style={{ color: "var(--accent)" }} />
            <span>{statusMsg}</span>
          </div>
        )}
        {error && (() => {
          const isCritical =
            error.code === "rate_limit_anthropic" ||
            error.code === "rate_limit_tokens_per_minute" ||
            error.code === "auth_invalid" ||
            error.code === "auth_missing";
          const isDailyLimit =
            error.code === "rate_limit_anthropic" &&
            error.retryAfter !== undefined &&
            error.retryAfter - now > 60 * 60 * 1000; // more than 1h wait = daily/monthly
          return (
            <div style={isCritical ? S.errorBarCritical : S.errorBar}>
              <AlertCircle size={isCritical ? 18 : 14} style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {isDailyLimit && (
                  <div style={S.errorTitle}>Kontingent aufgebraucht</div>
                )}
                {isCritical && !isDailyLimit && (
                  <div style={S.errorTitle}>Limit erreicht</div>
                )}
                <div>{error.userMessage}</div>
                {error.retryAfter && (
                  <div style={isCritical ? S.errorCountdownCritical : S.errorCountdown}>
                    Wieder verfügbar {formatCountdown(error.retryAfter, now)}
                  </div>
                )}
              </div>
              <button
                onClick={handleSearchEvents}
                style={S.retryBtn}
                disabled={
                  isBusy ||
                  (error.retryAfter !== undefined && error.retryAfter > now)
                }
              >
                Erneut
              </button>
            </div>
          );
        })()}

        {/* EVENTS */}
        {events.length > 0 && (
          <>
            {/* Filter Bar — Audience */}
            <div style={S.filterGroup}>
              <div style={S.filterGroupLabel}>Für</div>
              <div style={S.chipScroll}>
                {(["all", "family", "adult"] as const).map((a) => {
                  const cfg = a === "all" ? null : audienceConfig[a];
                  const count = audienceCounts[a] || 0;
                  const active = audienceFilter === a;
                  return (
                    <button
                      key={a}
                      onClick={() => setAudienceFilter(a)}
                      style={{
                        ...S.chipFilter,
                        ...(active ? S.chipFilterActive : {}),
                      }}
                      disabled={count === 0 && a !== "all"}
                    >
                      {cfg ? <span>{cfg.icon}</span> : null}
                      {a === "all" ? "Alle" : cfg!.label}
                      <span style={S.chipCount}>{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Filter Bar — Category */}
            <div style={S.filterGroup}>
              <div style={S.filterGroupLabel}>Art</div>
              <div style={S.chipScroll}>
                {(["all", "concert", "stage", "art", "cinema", "market", "sport", "other"] as const).map(
                  (c) => {
                    const cfg = c === "all" ? null : categoryConfig[c];
                    const count = categoryCounts[c] || 0;
                    const active = categoryFilter === c;
                    return (
                      <button
                        key={c}
                        onClick={() => setCategoryFilter(c)}
                        style={{
                          ...S.chipFilter,
                          ...(active ? S.chipFilterActive : {}),
                        }}
                        disabled={count === 0 && c !== "all"}
                      >
                        {cfg ? <span>{cfg.icon}</span> : null}
                        {c === "all" ? "Alle" : cfg!.label}
                        <span style={S.chipCount}>{count}</span>
                      </button>
                    );
                  }
                )}
              </div>
            </div>

            {/* Result count */}
            <div style={S.resultCount}>
              {filteredEvents.length === events.length
                ? `${events.length} Veranstaltung${events.length === 1 ? "" : "en"}`
                : `${filteredEvents.length} von ${events.length} angezeigt`}
              {searchMeta?.cappedFrom && (
                <span style={S.resultCountNote}>
                  {" "}· gekürzt von {searchMeta.cappedFrom}
                </span>
              )}
              {searchMeta?.fromCache && (
                <span style={S.resultCountNote}> · aus Cache</span>
              )}
            </div>

            {filteredEvents.length === 0 ? (
              <div style={S.emptyResults}>
                Keine Treffer mit diesen Filtern.{" "}
                <button
                  onClick={() => {
                    setAudienceFilter("all");
                    setCategoryFilter("all");
                  }}
                  style={S.linkBtn}
                >
                  Filter zurücksetzen
                </button>
              </div>
            ) : (
              <div style={S.eventsList} className="slide-up">
                {filteredEvents.map((ev, i) => {
                  const aud = audienceConfig[ev.audience];
                  const cat = categoryConfig[ev.category];
                  return (
                    <article key={i} style={S.eventCard}>
                      <div style={S.eventHeader}>
                        <div style={S.badgeRow}>
                          <div
                            style={{
                              ...S.audienceBadge,
                              color: aud.color,
                              borderColor: aud.color,
                            }}
                          >
                            <span>{aud.icon}</span> {aud.label}
                          </div>
                          {cat && (
                            <div style={S.categoryBadge}>
                              <span>{cat.icon}</span> {cat.label}
                            </div>
                          )}
                        </div>
                        <div style={S.eventTime}>
                          <Clock size={11} />
                          {formatDateTime(ev.datetime)}
                        </div>
                      </div>
                      <h3 style={S.eventTitle}>{ev.title}</h3>
                      {ev.description && <p style={S.eventDesc}>{ev.description}</p>}
                      {(ev.location || ev.cost) && (
                        <div style={S.eventMetaRow}>
                          {ev.location && (
                            <div style={S.metaItem}>
                              <MapPin size={12} />
                              <span>{ev.location}</span>
                            </div>
                          )}
                          {ev.cost && (
                            <div style={S.metaItem}>
                              <Euro size={12} />
                              <span>{ev.cost}</span>
                            </div>
                          )}
                        </div>
                      )}
                      {ev.audienceReason && (
                        <div style={S.audienceReason}>
                          <Users size={10} /> {ev.audienceReason}
                        </div>
                      )}
                      {ev.sourceUrl && (
                        <a
                          href={ev.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={S.eventSource}
                        >
                          {ev.sourceName || "Quelle"} <ExternalLink size={10} />
                        </a>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}

        {!isBusy && events.length === 0 && !error && searchMeta && (
          <div style={S.emptyResults}>
            <div style={{ marginBottom: 12, fontWeight: 600 }}>
              Keine Events für diesen Zeitraum gefunden.
            </div>
            {searchMeta.sourceStatus && searchMeta.sourceStatus.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: "var(--muted-fg)", marginBottom: 6 }}>
                  Pro Quelle:
                </div>
                <div style={S.sourceStatusList}>
                  {searchMeta.sourceStatus.map((s, i) => (
                    <div key={i} style={S.sourceStatusRow}>
                      <span style={s.ok ? S.sourceStatusOk : S.sourceStatusFail}>
                        {s.ok ? "✓" : "✗"}
                      </span>
                      <span style={S.sourceStatusName}>{s.name}</span>
                      <span style={S.sourceStatusCount}>
                        {s.ok ? `${s.count}` : s.note || "Fehler"}
                        {s.fromCache && " (Cache)"}
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted-fg)", marginTop: 10 }}>
                  Tipp: Wenn alle Quellen 0 zurückgeben, hat die Suche für diesen
                  Zeitraum tatsächlich nichts ergeben. Wenn einzelne Quellen Fehler
                  zeigen, sind diese vielleicht gerade nicht erreichbar.
                </div>
              </>
            )}
          </div>
        )}
        {!isBusy && events.length === 0 && !error && !searchMeta && (
          <div style={S.emptyResults}>
            Wähle einen Zeitraum und tippe auf „Veranstaltungen suchen".
          </div>
        )}
      </main>
    </div>
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Construct a structured error from a JSON response body.
 * Server returns { error: { code, userMessage, retryAfter? } } as our envelope.
 */
function makeApiError(data: any, status: number): Error {
  const err: any = new Error(
    data?.error?.userMessage || data?.error || `HTTP ${status}`
  );
  err.appError = data?.error || { userMessage: `HTTP ${status}` };
  return err;
}

/**
 * Pull the structured error info off a thrown error, if present.
 * Falls back to a plain message when missing.
 */
function extractErrorObj(e: any): { userMessage: string; code?: string; retryAfter?: number } {
  if (e?.appError && typeof e.appError === "object") {
    return e.appError;
  }
  return { userMessage: e?.message || "Unbekannter Fehler" };
}

/**
 * Format a remaining-time countdown like "in 23 Sek." or "in 2 Min."
 */
function formatCountdown(retryAt: number, now: number): string {
  const ms = retryAt - now;
  if (ms <= 0) return "jetzt verfügbar";
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `in ${sec} Sek.`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `in ${min} Min.`;
  const hours = Math.floor(min / 60);
  const remMin = min % 60;
  return `in ${hours} Std. ${remMin} Min.`;
}

function formatDateTime(s: string): string {
  if (!s) return "?";
  // Try ISO-like "2026-04-25 19:30"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}`);
    if (!isNaN(date.getTime())) {
      const today = new Date();
      const isToday = date.toDateString() === today.toDateString();
      const day = isToday
        ? "heute"
        : date.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });
      if (m[4]) {
        return `${day}, ${m[4]}:${m[5]}`;
      }
      return day;
    }
  }
  return s;
}

const S: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    paddingBottom: "env(safe-area-inset-bottom)",
  },

  // Empty state
  emptyMain: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    padding: "32px 20px",
    maxWidth: 480,
    margin: "0 auto",
    gap: 32,
  },
  emptyMark: {
    fontSize: 36,
    color: "var(--accent)",
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 32,
    fontWeight: 600,
    letterSpacing: "-0.02em",
    margin: 0,
    lineHeight: 1.1,
  },
  emptySub: {
    fontSize: 14,
    color: "var(--muted-fg)",
    margin: "8px 0 0 0",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  emptyForm: { display: "flex", flexDirection: "column", gap: 12 },
  emptyHelp: {
    fontSize: 14,
    color: "var(--muted-fg)",
    lineHeight: 1.5,
    margin: "0 0 4px 0",
  },

  // Main view header
  mainHeader: {
    padding: "20px 20px 16px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    background: "var(--bg)",
    borderBottom: "1px solid var(--border)",
    position: "sticky",
    top: 0,
    zIndex: 10,
    backdropFilter: "blur(12px)",
  },
  cityKicker: {
    fontSize: 10,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "var(--muted-fg)",
    fontWeight: 500,
    marginBottom: 2,
  },
  cityName: {
    fontSize: 22,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    margin: 0,
    lineHeight: 1.1,
  },
  iconBtn: {
    width: 36,
    height: 36,
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--fg)",
    borderRadius: 0,
    flexShrink: 0,
  },

  // Compact header (curation, settings)
  compactHeader: {
    padding: "12px 12px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    background: "var(--bg)",
    borderBottom: "1px solid var(--border)",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--fg)",
  },
  compactTitle: {
    fontSize: 14,
    fontWeight: 600,
    flex: 1,
    textAlign: "center",
    letterSpacing: "-0.01em",
  },

  main: { padding: "16px 16px 80px", maxWidth: 720, margin: "0 auto" },

  // Inputs
  inputWrap: { position: "relative", display: "flex", alignItems: "center" },
  inputIcon: {
    position: "absolute",
    left: 14,
    color: "var(--muted-fg)",
    pointerEvents: "none",
  },
  input: {
    width: "100%",
    padding: "14px 14px 14px 42px",
    fontSize: 16, // 16px prevents iOS zoom
    border: "1px solid var(--border)",
    borderRadius: 0,
    background: "var(--bg-elevated)",
    color: "var(--fg)",
    outline: "none",
  },
  primaryFullBtn: {
    width: "100%",
    padding: "14px 16px",
    fontSize: 14,
    fontWeight: 600,
    background: "var(--fg)",
    color: "var(--bg)",
    border: "none",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    letterSpacing: "0.02em",
  },
  disabled: { opacity: 0.4, cursor: "not-allowed" },

  // Filters
  filterScroll: {
    display: "flex",
    gap: 8,
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
    paddingBottom: 8,
    marginBottom: 12,
    scrollbarWidth: "none",
  },
  filterBtn: {
    padding: "10px 16px",
    fontSize: 14,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    color: "var(--fg)",
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontWeight: 500,
  },
  filterBtnActive: {
    background: "var(--fg)",
    color: "var(--bg)",
    borderColor: "var(--fg)",
  },

  // Display filters (audience + category) — applied client-side
  filterGroup: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  chipScroll: {
    display: "flex",
    gap: 6,
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
    paddingBottom: 4,
    scrollbarWidth: "none",
    flex: 1,
  },
  filterGroupLabel: {
    fontSize: 10,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "var(--muted-fg)",
    fontWeight: 700,
    minWidth: 28,
    flexShrink: 0,
  },
  chipFilter: {
    padding: "6px 10px",
    fontSize: 12,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    color: "var(--fg)",
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontWeight: 500,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    borderRadius: 999,
  },
  chipFilterActive: {
    background: "var(--fg)",
    color: "var(--bg)",
    borderColor: "var(--fg)",
  },
  chipCount: {
    fontSize: 10,
    opacity: 0.65,
    fontWeight: 600,
    marginLeft: 2,
  },
  resultCount: {
    fontSize: 11,
    color: "var(--muted-fg)",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    margin: "12px 0 10px",
    fontWeight: 600,
  },
  resultCountNote: {
    fontWeight: 400,
    opacity: 0.7,
  },
  sourceStatusList: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    background: "var(--bg-elevated)",
    padding: "10px 12px",
    border: "1px solid var(--border)",
    borderRadius: 4,
  },
  sourceStatusRow: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    fontSize: 12,
  },
  sourceStatusOk: {
    color: "var(--accent-family)",
    fontWeight: 700,
    width: 14,
    textAlign: "center" as const,
  },
  sourceStatusFail: {
    color: "var(--accent)",
    fontWeight: 700,
    width: 14,
    textAlign: "center" as const,
  },
  sourceStatusName: {
    flex: 1,
    color: "var(--fg)",
  },
  sourceStatusCount: {
    color: "var(--muted-fg)",
    fontVariantNumeric: "tabular-nums",
    fontSize: 11,
  },
  badgeRow: {
    display: "inline-flex",
    gap: 6,
    alignItems: "center",
    flexWrap: "wrap",
  },
  categoryBadge: {
    fontSize: 9,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    padding: "2px 7px",
    border: "1px solid var(--border)",
    background: "var(--bg-sunk)",
    color: "var(--muted-fg)",
    fontWeight: 700,
    display: "inline-flex",
    gap: 4,
    alignItems: "center",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--accent)",
    cursor: "pointer",
    textDecoration: "underline",
    fontSize: "inherit",
    padding: 0,
    fontFamily: "inherit",
  },
  customDateRow: {
    display: "flex",
    gap: 8,
    marginBottom: 12,
  },
  dateInput: {
    flex: 1,
    padding: "10px 12px",
    fontSize: 16,
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    color: "var(--fg)",
  },
  searchBtn: {
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  bigSearchBtn: {
    width: "100%",
    padding: "14px 20px",
    fontSize: 14,
    fontWeight: 700,
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 16,
  },

  // Status
  statusBar: {
    padding: "12px 14px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
    fontSize: 13,
    color: "var(--fg)",
  },
  errorBar: {
    padding: "12px 14px",
    background: "#fef2f0",
    border: "1px solid var(--accent)",
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    marginBottom: 16,
    fontSize: 13,
    color: "var(--accent-dark)",
    borderRadius: 4,
    lineHeight: 1.4,
  },
  errorBarCritical: {
    padding: "16px 18px",
    background: "#fde2dc",
    border: "2px solid var(--accent)",
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 16,
    fontSize: 13,
    color: "var(--accent-dark)",
    borderRadius: 6,
    lineHeight: 1.45,
    boxShadow: "0 2px 8px rgba(196, 69, 54, 0.15)",
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: 6,
    color: "var(--accent)",
  },
  errorCountdown: {
    fontSize: 11,
    color: "var(--accent-dark)",
    opacity: 0.8,
    marginTop: 4,
    fontWeight: 600,
    letterSpacing: "0.04em",
  },
  errorCountdownCritical: {
    fontSize: 12,
    color: "var(--accent)",
    marginTop: 6,
    fontWeight: 700,
    letterSpacing: "0.04em",
    padding: "4px 8px",
    background: "rgba(196, 69, 54, 0.12)",
    display: "inline-block",
    borderRadius: 3,
  },
  retryBtn: {
    flexShrink: 0,
    padding: "6px 12px",
    fontSize: 11,
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    alignSelf: "center",
  },

  // Events
  eventsList: { display: "flex", flexDirection: "column", gap: 12 },
  eventCard: {
    padding: "16px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  eventHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  audienceBadge: {
    fontSize: 9,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    padding: "2px 7px",
    border: "1px solid",
    fontWeight: 700,
    display: "inline-flex",
    gap: 4,
    alignItems: "center",
  },
  eventTime: {
    fontSize: 12,
    color: "var(--muted-fg)",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontWeight: 500,
  },
  eventTitle: {
    fontSize: 17,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    lineHeight: 1.25,
    margin: 0,
    fontFamily: "Georgia, serif",
  },
  eventDesc: {
    fontSize: 13,
    color: "var(--muted-fg)",
    lineHeight: 1.45,
    margin: 0,
  },
  eventMetaRow: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
    fontSize: 12,
    color: "var(--fg)",
    paddingTop: 6,
    borderTop: "1px dashed var(--border)",
  },
  metaItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
  },
  audienceReason: {
    fontSize: 11,
    color: "var(--muted-fg)",
    fontStyle: "italic",
    display: "inline-flex",
    gap: 5,
    alignItems: "center",
  },
  eventSource: {
    fontSize: 11,
    color: "var(--accent)",
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontWeight: 600,
    letterSpacing: "0.02em",
    marginTop: 4,
  },
  emptyResults: {
    textAlign: "center",
    padding: "40px 20px",
    color: "var(--muted-fg)",
    fontSize: 13,
  },

  // Curation
  curationIntro: {
    fontSize: 14,
    color: "var(--muted-fg)",
    lineHeight: 1.5,
    margin: "0 0 16px 0",
  },
  curationActions: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  selectedCounter: {
    fontSize: 13,
    color: "var(--fg)",
    fontWeight: 600,
  },
  miniBtnGroup: { display: "flex", gap: 4 },
  miniBtn: {
    padding: "6px 10px",
    fontSize: 11,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--fg)",
    fontWeight: 600,
  },
  candidateList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    paddingBottom: 100, // Space for sticky bottom bar
  },
  candidateCard: {
    display: "flex",
    gap: 12,
    padding: "12px 14px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    position: "relative",
  },
  candidateCardActive: {
    borderColor: "var(--fg)",
    boxShadow: "inset 3px 0 0 var(--accent)",
  },
  hiddenCheckbox: { position: "absolute", opacity: 0, pointerEvents: "none" },
  checkBox: {
    width: 20,
    height: 20,
    border: "1.5px solid var(--border-strong)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 2,
    background: "var(--bg-elevated)",
    color: "var(--bg-elevated)",
  },
  checkBoxActive: { background: "var(--fg)", color: "var(--bg)" },
  candidateContent: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  candidateTopRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  candidateType: {
    fontSize: 9,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    fontWeight: 700,
  },
  starBadge: {
    fontSize: 12,
    color: "var(--accent-mixed)",
  },
  candidateName: {
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1.25,
    marginTop: 2,
  },
  candidateFocus: {
    fontSize: 12,
    color: "var(--muted-fg)",
    lineHeight: 1.4,
    marginTop: 2,
  },
  candidateUrl: {
    fontSize: 11,
    color: "var(--muted-fg)",
    marginTop: 4,
    textDecoration: "none",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  // Sticky bottom bar
  bottomBar: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    padding: "12px 16px calc(12px + env(safe-area-inset-bottom))",
    background: "var(--bg)",
    borderTop: "1px solid var(--border)",
    display: "flex",
    gap: 8,
    zIndex: 20,
  },
  bottomBarGhost: {
    padding: "12px 16px",
    fontSize: 13,
    background: "transparent",
    border: "1px solid var(--border)",
    cursor: "pointer",
    color: "var(--fg)",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  bottomBarPrimary: {
    flex: 1,
    padding: "12px 16px",
    fontSize: 13,
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },

  // Settings
  settingsSection: {
    marginBottom: 28,
    padding: "16px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
  },
  settingsLabel: {
    fontSize: 10,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "var(--muted-fg)",
    fontWeight: 700,
    marginBottom: 6,
  },
  settingsCity: {
    fontSize: 22,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    fontFamily: "Georgia, serif",
  },
  settingsMeta: {
    fontSize: 12,
    color: "var(--muted-fg)",
    marginTop: 4,
  },
  settingsActions: {
    display: "flex",
    gap: 8,
    marginTop: 14,
    flexWrap: "wrap",
  },
  settingsBtn: {
    padding: "10px 14px",
    fontSize: 12,
    background: "transparent",
    border: "1px solid var(--border)",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "var(--fg)",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  sourcesList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    marginTop: 8,
  },
  sourceListItem: {
    padding: "10px 12px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    textDecoration: "none",
    color: "var(--fg)",
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  sourceListHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  adapterBadge: {
    fontSize: 9,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    padding: "2px 6px",
    border: "1px solid",
    fontWeight: 700,
  },
  sourceListName: { fontSize: 14, fontWeight: 600, marginTop: 2 },
  sourceListUrl: {
    fontSize: 11,
    color: "var(--muted-fg)",
  },
};
