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
  Sparkles,
  AlertCircle,
  X,
  Loader2,
  BookOpen,
  Check,
} from "lucide-react";
import {
  loadSources,
  saveSources,
  deleteSources,
  listLocations,
} from "@/lib/storage";
import type {
  CandidateSource,
  EventSource,
  Event,
  TimeFilter,
  SourceRecord,
} from "@/lib/types";

const APP_NAME = "Noch nichts vor?";
const APP_TAGLINE = "Lokaler Veranstaltungsfinder";

type Phase = "idle" | "discovering" | "curating" | "searching";

export default function HomePage() {
  const [location, setLocation] = useState("");
  const [activeLocation, setActiveLocation] = useState<string | null>(null);
  const [sources, setSources] = useState<EventSource[]>([]);
  const [savedLocations, setSavedLocations] = useState<string[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("today");
  const [customDate, setCustomDate] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState("");
  const [showSourcesPanel, setShowSourcesPanel] = useState(false);
  const [lastQueryMeta, setLastQueryMeta] = useState<{ discoveredAt: string } | null>(null);

  const [candidateSources, setCandidateSources] = useState<CandidateSource[] | null>(null);
  const [curationLocation, setCurationLocation] = useState<string | null>(null);

  useEffect(() => {
    setSavedLocations(listLocations());
  }, []);

  function refreshSavedLocations() {
    setSavedLocations(listLocations());
  }

  async function discoverCandidates(loc: string): Promise<CandidateSource[]> {
    setPhase("discovering");
    setStatusMsg(`Identifiziere passende Quellen für ${loc}…`);
    setError("");
    setCandidateSources(null);

    const res = await fetch("/api/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: loc }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
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
    setStatusMsg(`Suche Veranstaltungen in ${loc}…`);
    setError("");
    setEvents([]);

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
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setEvents(data.events as Event[]);
      setPhase("idle");
      setStatusMsg("");
    } catch (e: any) {
      console.error(e);
      setError(`Fehler bei Eventsuche: ${e.message}`);
      setPhase("idle");
    }
  }

  async function handleStartDiscovery() {
    if (!location.trim()) return;
    const loc = location.trim();

    const existing = loadSources(loc);
    if (existing) {
      activateLocation(loc, existing);
      await searchEventsInternal(loc, existing.sources, "today", "");
      return;
    }

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
      setError(`Fehler bei Quellensuche: ${e.message}`);
      setPhase("idle");
    }
  }

  async function handleRefreshSources() {
    if (!activeLocation) return;
    try {
      const candidates = await discoverCandidates(activeLocation);
      const currentUrls = new Set(sources.map((s) => s.url));
      setCandidateSources(
        candidates.map((s) => ({
          ...s,
          selected: currentUrls.has(s.url) || s.recommended !== false,
        }))
      );
      setCurationLocation(activeLocation);
      setPhase("curating");
      setStatusMsg("");
    } catch (e: any) {
      setError(`Fehler bei Quellen-Auffrischung: ${e.message}`);
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
      setError("Bitte mindestens eine Quelle auswählen.");
      return;
    }

    const record: SourceRecord = {
      location: curationLocation,
      sources: selected,
      discoveredAt: new Date().toISOString(),
    };
    saveSources(curationLocation, record);
    refreshSavedLocations();
    const loc = curationLocation;
    activateLocation(loc, record);
    setTimeFilter("today");
    await searchEventsInternal(loc, selected, "today", "");
  }

  function handleCancelCuration() {
    setCandidateSources(null);
    setCurationLocation(null);
    setPhase("idle");
    setStatusMsg("");
    setError("");
  }

  function activateLocation(loc: string, record: SourceRecord) {
    setActiveLocation(loc);
    setSources(record.sources);
    setLastQueryMeta({ discoveredAt: record.discoveredAt });
    setCandidateSources(null);
    setCurationLocation(null);
    setPhase("idle");
    setStatusMsg("");
    setError("");
    setEvents([]);
  }

  async function handleSearchEvents() {
    if (!activeLocation || sources.length === 0) return;
    if (timeFilter === "custom" && !customDate) {
      setError("Bitte Datum wählen.");
      return;
    }
    await searchEventsInternal(activeLocation, sources, timeFilter, customDate);
  }

  async function handleDeleteLocation(loc: string) {
    deleteSources(loc);
    refreshSavedLocations();
    if (activeLocation === loc) {
      setActiveLocation(null);
      setSources([]);
      setEvents([]);
    }
  }

  const audienceConfig: Record<string, { label: string; color: string; icon: string }> = {
    family: { label: "Familie 8–14", color: "var(--accent-family)", icon: "♡" },
    adult: { label: "Erwachsene", color: "var(--accent-adult)", icon: "⬢" },
    mixed: { label: "Gemischt", color: "var(--accent-mixed)", icon: "◇" },
    unknown: { label: "Offen", color: "var(--muted-fg)", icon: "?" },
  };

  const typeLabel: Record<string, string> = {
    official: "Offiziell",
    editorial: "Redaktion",
    aggregator: "Aggregator",
    venue: "Veranstaltungsort",
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

  const isBusy = phase === "discovering" || phase === "searching";
  const inCuration = phase === "curating";
  const selectedCount = candidateSources?.filter((s) => s.selected).length || 0;

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.brand}>
            <div style={styles.logoMark}>◉</div>
            <div>
              <div style={styles.brandKicker}>{APP_TAGLINE}</div>
              <h1 style={styles.brandTitle}>{APP_NAME}</h1>
            </div>
          </div>
          <div style={styles.headerDate}>
            {new Date().toLocaleDateString("de-DE", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {!inCuration && (
          <section style={styles.section}>
            <div style={styles.sectionLabel}>01 — Ort wählen</div>
            <div style={styles.locationRow}>
              <div style={styles.inputWrap}>
                <MapPin size={18} style={styles.inputIcon} />
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Stadt oder Region, z.B. Hamburg"
                  style={styles.input}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && location.trim()) handleStartDiscovery();
                  }}
                  disabled={isBusy}
                />
              </div>
              <button
                onClick={handleStartDiscovery}
                disabled={!location.trim() || isBusy}
                style={{
                  ...styles.primaryBtn,
                  ...(!location.trim() || isBusy ? styles.btnDisabled : {}),
                }}
              >
                {phase === "discovering" ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Search size={16} />
                )}
                Quellen suchen
              </button>
            </div>

            {savedLocations.length > 0 && (
              <div style={styles.chipsWrap}>
                <span style={styles.chipsLabel}>Gespeichert:</span>
                {savedLocations.map((loc) => (
                  <button
                    key={loc}
                    onClick={async () => {
                      const rec = loadSources(loc);
                      if (rec) {
                        activateLocation(loc, rec);
                        await searchEventsInternal(loc, rec.sources, "today", "");
                      }
                    }}
                    disabled={isBusy}
                    style={{
                      ...styles.chip,
                      ...(activeLocation === loc ? styles.chipActive : {}),
                    }}
                  >
                    {loc}
                    <X
                      size={12}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteLocation(loc);
                      }}
                      style={styles.chipClose}
                    />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {(isBusy || error) && !inCuration && (
          <div style={styles.statusBar}>
            {isBusy && (
              <Loader2 size={16} className="spin" style={{ color: "var(--accent)" }} />
            )}
            {error && <AlertCircle size={16} style={{ color: "var(--danger)" }} />}
            <span style={{ color: error ? "var(--danger)" : "var(--fg)" }}>
              {error || statusMsg}
            </span>
          </div>
        )}

        {inCuration && candidateSources && (
          <section style={styles.section}>
            <div style={styles.curationHeader}>
              <div>
                <div style={styles.sectionLabel}>
                  02 — Quellen auswählen für {curationLocation}
                </div>
                <p style={styles.curationIntro}>
                  Ich habe {candidateSources.length} Quellen identifiziert. Hake die ab, die
                  du nutzen willst. Die Auswahl wird gespeichert und für alle weiteren
                  Abfragen verwendet. Direkt danach lade ich die heutigen Events.
                </p>
              </div>
              <div style={styles.curationStats}>
                <div style={styles.curationCount}>
                  {selectedCount}
                  <span style={{ fontSize: 18, color: "var(--muted-fg)" }}>
                    /{candidateSources.length}
                  </span>
                </div>
                <div style={styles.curationCountLabel}>ausgewählt</div>
              </div>
            </div>

            <div style={styles.curationActions}>
              <button onClick={() => selectAllCandidates(true)} style={styles.miniBtn}>
                Alle
              </button>
              <button onClick={() => selectAllCandidates(false)} style={styles.miniBtn}>
                Keine
              </button>
              <button
                onClick={() =>
                  setCandidateSources((prev) =>
                    prev
                      ? prev.map((s) => ({ ...s, selected: s.recommended !== false }))
                      : prev
                  )
                }
                style={styles.miniBtn}
              >
                Empfohlene
              </button>
            </div>

            <div style={styles.curationGrid}>
              {candidateSources.map((s, i) => (
                <label
                  key={i}
                  style={{
                    ...styles.candidateCard,
                    ...(s.selected ? styles.candidateCardActive : {}),
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!s.selected}
                    onChange={() => toggleCandidate(i)}
                    style={styles.hiddenCheckbox}
                  />
                  <div
                    style={{
                      ...styles.checkBox,
                      ...(s.selected ? styles.checkBoxActive : {}),
                    }}
                  >
                    {s.selected && <Check size={12} strokeWidth={3} />}
                  </div>
                  <div style={styles.candidateContent}>
                    <div style={styles.candidateTopRow}>
                      <span
                        style={{
                          ...styles.candidateType,
                          color: typeColor[s.type] || "var(--muted-fg)",
                        }}
                      >
                        {typeLabel[s.type] || s.type}
                      </span>
                      {s.recommended && (
                        <span style={styles.recommendedBadge}>★ empfohlen</span>
                      )}
                    </div>
                    <div style={styles.candidateName}>{s.name}</div>
                    <div style={styles.candidateFocus}>{s.focus}</div>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={styles.candidateUrl}
                    >
                      <ExternalLink size={10} />{" "}
                      {(() => {
                        try {
                          return new URL(s.url).hostname;
                        } catch {
                          return s.url;
                        }
                      })()}
                    </a>
                  </div>
                </label>
              ))}
            </div>

            {error && (
              <div style={{ ...styles.statusBar, marginTop: 16 }}>
                <AlertCircle size={16} style={{ color: "var(--danger)" }} />
                <span style={{ color: "var(--danger)" }}>{error}</span>
              </div>
            )}

            <div style={styles.curationFooter}>
              <button onClick={handleCancelCuration} style={styles.ghostBtn}>
                Abbrechen
              </button>
              <button
                onClick={handleConfirmSources}
                disabled={selectedCount === 0}
                style={{
                  ...styles.searchBtn,
                  ...(selectedCount === 0 ? styles.btnDisabled : {}),
                }}
              >
                <Check size={16} />
                {selectedCount} {selectedCount === 1 ? "Quelle" : "Quellen"} übernehmen &
                Events laden
              </button>
            </div>
          </section>
        )}

        {activeLocation && !inCuration && (
          <>
            <section style={styles.section}>
              <div style={styles.activeLocBar}>
                <div>
                  <div style={styles.sectionLabel}>Aktive Quelle</div>
                  <div style={styles.activeLocName}>{activeLocation}</div>
                  {lastQueryMeta?.discoveredAt && (
                    <div style={styles.activeLocMeta}>
                      {sources.length} Quellen · identifiziert am{" "}
                      {new Date(lastQueryMeta.discoveredAt).toLocaleDateString("de-DE")}
                      {" · "}
                      <button
                        onClick={() => setShowSourcesPanel((s) => !s)}
                        style={styles.linkBtn}
                      >
                        {showSourcesPanel ? "ausblenden" : "anzeigen"}
                      </button>
                    </div>
                  )}
                </div>
                <button
                  onClick={handleRefreshSources}
                  disabled={isBusy}
                  style={styles.ghostBtn}
                  title="Quellen neu identifizieren"
                >
                  {phase === "discovering" ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  Quellen auffrischen
                </button>
              </div>

              {showSourcesPanel && (
                <div style={styles.sourcesGrid}>
                  {sources.map((s, i) => (
                    <a
                      key={i}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      style={styles.sourceCard}
                    >
                      <div
                        style={{
                          ...styles.sourceType,
                          color: typeColor[s.type] || "var(--accent)",
                        }}
                      >
                        {typeLabel[s.type] || s.type}
                      </div>
                      <div style={styles.sourceName}>{s.name}</div>
                      <div style={styles.sourceFocus}>{s.focus}</div>
                      <div style={styles.sourceUrl}>
                        <ExternalLink size={11} />{" "}
                        {(() => {
                          try {
                            return new URL(s.url).hostname;
                          } catch {
                            return s.url;
                          }
                        })()}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </section>

            <section style={styles.section}>
              <div style={styles.sectionLabel}>03 — Zeitraum</div>
              <div style={styles.timeFilters}>
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
                      ...styles.filterBtn,
                      ...(timeFilter === f.k ? styles.filterBtnActive : {}),
                    }}
                    disabled={isBusy}
                  >
                    {f.label}
                  </button>
                ))}
                {timeFilter === "custom" && (
                  <input
                    type="date"
                    value={customDate}
                    onChange={(e) => setCustomDate(e.target.value)}
                    style={styles.dateInput}
                    disabled={isBusy}
                  />
                )}
              </div>
              <button
                onClick={handleSearchEvents}
                disabled={isBusy}
                style={{
                  ...styles.searchBtn,
                  ...(isBusy ? styles.btnDisabled : {}),
                }}
              >
                {phase === "searching" ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Search size={16} />
                )}
                Veranstaltungen suchen
              </button>
            </section>

            {events.length > 0 && (
              <section style={styles.section}>
                <div style={styles.sectionLabel}>
                  04 — Gefundene Veranstaltungen · {events.length}
                </div>
                <div style={styles.eventsGrid}>
                  {events.map((ev, i) => {
                    const aud = audienceConfig[ev.audience] || audienceConfig.unknown;
                    return (
                      <article key={i} style={styles.eventCard}>
                        <div style={styles.eventHeader}>
                          <div
                            style={{
                              ...styles.audienceBadge,
                              color: aud.color,
                              borderColor: aud.color,
                            }}
                          >
                            <span>{aud.icon}</span> {aud.label}
                          </div>
                          <div style={styles.eventIndex}>
                            {String(i + 1).padStart(2, "0")}
                          </div>
                        </div>
                        <h3 style={styles.eventTitle}>{ev.title}</h3>
                        <div style={styles.eventMeta}>
                          <div style={styles.metaRow}>
                            <Clock size={13} />
                            <span>{ev.datetime || "Zeit unbekannt"}</span>
                          </div>
                          <div style={styles.metaRow}>
                            <MapPin size={13} />
                            <span>{ev.location || "Ort unbekannt"}</span>
                          </div>
                          <div style={styles.metaRow}>
                            <Euro size={13} />
                            <span>{ev.cost || "unbekannt"}</span>
                          </div>
                        </div>
                        {ev.description && <p style={styles.eventDesc}>{ev.description}</p>}
                        {ev.audienceReason && (
                          <div style={styles.audienceReason}>
                            <Users size={11} /> {ev.audienceReason}
                          </div>
                        )}
                        {ev.sourceUrl && (
                          <a
                            href={ev.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={styles.eventSource}
                          >
                            <BookOpen size={11} /> {ev.sourceName || "Quelle"}{" "}
                            <ExternalLink size={10} />
                          </a>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {phase === "idle" && events.length === 0 && !error && (
              <div style={styles.emptyHint}>
                <Sparkles size={14} /> Keine Events gefunden. Zeitraum ändern oder erneut
                suchen.
              </div>
            )}
          </>
        )}

        {!activeLocation && !inCuration && !isBusy && savedLocations.length === 0 &&
          !error && (
            <div style={styles.welcome}>
              <div style={styles.welcomeMark}>✺</div>
              <h2 style={styles.welcomeTitle}>Finde heraus, was gerade läuft.</h2>
              <p style={styles.welcomeText}>
                Ort eingeben. Passende Quellen auswählen. Events erscheinen automatisch —
                erst für heute, danach filterbar nach Abend, Wochenende oder eigenem Datum.
              </p>
            </div>
          )}
      </main>

      <footer style={styles.footer}>
        <span>Quellen lokal gespeichert · Auffrischung bei Bedarf</span>
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh" },
  header: {
    borderBottom: "1px solid var(--border)",
    background: "var(--bg)",
    position: "sticky",
    top: 0,
    zIndex: 20,
    backdropFilter: "blur(12px)",
  },
  headerInner: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "20px 28px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 20,
  },
  brand: { display: "flex", alignItems: "center", gap: 14 },
  logoMark: { fontSize: 32, color: "var(--accent)", lineHeight: 1 },
  brandKicker: {
    fontSize: 10,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: "var(--muted-fg)",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontWeight: 500,
  },
  brandTitle: {
    fontSize: 28,
    fontWeight: 600,
    letterSpacing: "-0.02em",
    margin: 0,
    lineHeight: 1,
    marginTop: 4,
  },
  headerDate: {
    fontSize: 12,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--muted-fg)",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  main: { maxWidth: 1200, margin: "0 auto", padding: "36px 28px 80px" },
  section: { marginBottom: 40, animation: "slideUp 0.4s ease-out" },
  sectionLabel: {
    fontSize: 10,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: "var(--muted-fg)",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontWeight: 600,
    marginBottom: 14,
  },
  locationRow: { display: "flex", gap: 10, flexWrap: "wrap" },
  inputWrap: {
    flex: "1 1 280px",
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  inputIcon: {
    position: "absolute",
    left: 16,
    color: "var(--muted-fg)",
    pointerEvents: "none",
  },
  input: {
    width: "100%",
    padding: "14px 16px 14px 44px",
    fontSize: 16,
    border: "1px solid var(--border)",
    borderRadius: 0,
    background: "var(--bg-elevated)",
    color: "var(--fg)",
    outline: "none",
  },
  primaryBtn: {
    padding: "14px 22px",
    fontSize: 14,
    fontWeight: 500,
    background: "var(--fg)",
    color: "var(--bg)",
    border: "none",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "'Inter', system-ui, sans-serif",
    letterSpacing: "0.02em",
  },
  btnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  chipsWrap: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    marginTop: 14,
    alignItems: "center",
  },
  chipsLabel: {
    fontSize: 11,
    color: "var(--muted-fg)",
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    fontFamily: "'Inter', system-ui, sans-serif",
    marginRight: 4,
  },
  chip: {
    padding: "6px 10px 6px 12px",
    fontSize: 13,
    background: "var(--bg-sunk)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "var(--fg)",
  },
  chipActive: { background: "var(--fg)", color: "var(--bg)", borderColor: "var(--fg)" },
  chipClose: { opacity: 0.6, marginLeft: 2 },
  statusBar: {
    padding: "12px 16px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 24,
    fontSize: 14,
    fontFamily: "'Inter', system-ui, sans-serif",
  },

  curationHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 20,
    marginBottom: 18,
    flexWrap: "wrap",
  },
  curationIntro: {
    fontSize: 15,
    color: "var(--muted-fg)",
    lineHeight: 1.5,
    fontFamily: "'Inter', system-ui, sans-serif",
    margin: "6px 0 0 0",
    maxWidth: 640,
  },
  curationStats: {
    textAlign: "right",
    padding: "10px 18px",
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
  },
  curationCount: {
    fontSize: 36,
    fontWeight: 500,
    lineHeight: 1,
    color: "var(--accent)",
  },
  curationCountLabel: {
    fontSize: 10,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "var(--muted-fg)",
    fontFamily: "'Inter', system-ui, sans-serif",
    marginTop: 4,
  },
  curationActions: { display: "flex", gap: 8, marginBottom: 16 },
  miniBtn: {
    padding: "6px 12px",
    fontSize: 11,
    background: "transparent",
    border: "1px solid var(--border)",
    cursor: "pointer",
    fontFamily: "'Inter', system-ui, sans-serif",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--fg)",
  },
  curationGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    gap: 10,
  },
  candidateCard: {
    display: "flex",
    gap: 12,
    padding: "14px 16px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    transition: "all 0.15s",
    position: "relative",
  },
  candidateCardActive: {
    borderColor: "var(--fg)",
    background: "var(--bg)",
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
    gap: 3,
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
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontWeight: 600,
  },
  recommendedBadge: {
    fontSize: 9,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "var(--accent-mixed)",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontWeight: 600,
  },
  candidateName: { fontSize: 15, fontWeight: 500, lineHeight: 1.25, marginTop: 2 },
  candidateFocus: {
    fontSize: 12,
    color: "var(--muted-fg)",
    lineHeight: 1.4,
    fontFamily: "'Inter', system-ui, sans-serif",
    marginTop: 2,
  },
  candidateUrl: {
    fontSize: 10,
    color: "var(--muted-fg)",
    fontFamily: "'JetBrains Mono', monospace",
    marginTop: 6,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    textDecoration: "none",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  curationFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginTop: 24,
    paddingTop: 20,
    borderTop: "1px solid var(--border)",
    flexWrap: "wrap",
  },

  activeLocBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    padding: "18px 20px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderLeft: "3px solid var(--accent)",
    flexWrap: "wrap",
  },
  activeLocName: {
    fontSize: 28,
    fontWeight: 500,
    letterSpacing: "-0.01em",
    marginTop: 4,
  },
  activeLocMeta: {
    fontSize: 12,
    color: "var(--muted-fg)",
    marginTop: 6,
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--accent)",
    cursor: "pointer",
    fontSize: 12,
    padding: 0,
    textDecoration: "underline",
  },
  ghostBtn: {
    padding: "8px 12px",
    fontSize: 12,
    background: "transparent",
    border: "1px solid var(--border)",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "'Inter', system-ui, sans-serif",
    color: "var(--fg)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  sourcesGrid: {
    marginTop: 16,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: 10,
  },
  sourceCard: {
    padding: "14px 16px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    textDecoration: "none",
    color: "var(--fg)",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  sourceType: {
    fontSize: 9,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontWeight: 600,
  },
  sourceName: { fontSize: 15, fontWeight: 500, marginTop: 2 },
  sourceFocus: {
    fontSize: 12,
    color: "var(--muted-fg)",
    lineHeight: 1.4,
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  sourceUrl: {
    fontSize: 11,
    color: "var(--muted-fg)",
    fontFamily: "'JetBrains Mono', monospace",
    marginTop: 6,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
  },

  timeFilters: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    alignItems: "center",
    marginBottom: 16,
  },
  filterBtn: {
    padding: "10px 16px",
    fontSize: 14,
    background: "transparent",
    border: "1px solid var(--border)",
    cursor: "pointer",
    color: "var(--fg)",
  },
  filterBtnActive: { background: "var(--fg)", color: "var(--bg)", borderColor: "var(--fg)" },
  dateInput: {
    padding: "10px 12px",
    fontSize: 14,
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    color: "var(--fg)",
  },
  searchBtn: {
    padding: "16px 28px",
    fontSize: 14,
    fontWeight: 500,
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    fontFamily: "'Inter', system-ui, sans-serif",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },

  eventsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
    gap: 0,
    borderTop: "1px solid var(--border)",
    borderLeft: "1px solid var(--border)",
  },
  eventCard: {
    padding: "20px 22px",
    background: "var(--bg-elevated)",
    borderRight: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  eventHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  audienceBadge: {
    fontSize: 10,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    padding: "3px 8px",
    border: "1px solid",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontWeight: 600,
    display: "inline-flex",
    gap: 5,
    alignItems: "center",
  },
  eventIndex: {
    fontSize: 11,
    color: "var(--muted-fg)",
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: "0.1em",
  },
  eventTitle: {
    fontSize: 20,
    fontWeight: 500,
    letterSpacing: "-0.01em",
    lineHeight: 1.2,
    margin: 0,
    marginTop: 4,
  },
  eventMeta: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 },
  metaRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "var(--fg)",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  eventDesc: {
    fontSize: 13,
    color: "var(--muted-fg)",
    lineHeight: 1.5,
    margin: 0,
    fontFamily: "'Inter', system-ui, sans-serif",
    borderTop: "1px dashed var(--border)",
    paddingTop: 10,
    marginTop: 4,
  },
  audienceReason: {
    fontSize: 11,
    color: "var(--muted-fg)",
    fontStyle: "italic",
    fontFamily: "'Inter', system-ui, sans-serif",
    display: "inline-flex",
    gap: 5,
    alignItems: "center",
  },
  eventSource: {
    fontSize: 11,
    color: "var(--accent)",
    textDecoration: "none",
    marginTop: "auto",
    paddingTop: 8,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontFamily: "'Inter', system-ui, sans-serif",
    letterSpacing: "0.04em",
  },
  emptyHint: {
    padding: "14px 18px",
    background: "var(--bg-sunk)",
    fontSize: 13,
    color: "var(--muted-fg)",
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  welcome: { textAlign: "center", padding: "80px 20px", maxWidth: 560, margin: "0 auto" },
  welcomeMark: { fontSize: 56, color: "var(--accent)", marginBottom: 16 },
  welcomeTitle: {
    fontSize: 40,
    fontWeight: 500,
    letterSpacing: "-0.02em",
    margin: 0,
    marginBottom: 16,
  },
  welcomeText: {
    fontSize: 15,
    color: "var(--muted-fg)",
    lineHeight: 1.6,
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  footer: {
    borderTop: "1px solid var(--border)",
    padding: "20px 28px",
    textAlign: "center",
    fontSize: 11,
    color: "var(--muted-fg)",
    fontFamily: "'Inter', system-ui, sans-serif",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
};
