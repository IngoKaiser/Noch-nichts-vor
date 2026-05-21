/**
 * User-friendly error envelope returned by all API routes.
 *
 * The frontend reads `userMessage` for display, `code` for behavior
 * (e.g., showing a retry countdown), and `retryAfterSeconds` if applicable.
 */
export interface AppError {
  code: AppErrorCode;
  userMessage: string;
  /** Optional: when the user can retry, in epoch milliseconds. */
  retryAfter?: number;
  /** Optional: technical detail for debugging. Not shown by default. */
  detail?: string;
}

export type AppErrorCode =
  | "rate_limit_anthropic"
  | "rate_limit_tokens_per_minute"
  | "overloaded"
  | "auth_invalid"
  | "auth_missing"
  | "bad_request"
  | "timeout"
  | "network"
  | "no_sources"
  | "no_events_found"
  | "parse_failure"
  | "source_unreachable"
  | "unknown";

/**
 * Translate any thrown error (Anthropic SDK, fetch, parse, etc.) into
 * a structured AppError with a German user-facing message.
 */
export function toAppError(e: unknown): AppError {
  // Anthropic SDK errors and fetch Response-like errors
  const err = e as any;
  const status: number | undefined = err?.status ?? err?.response?.status;
  const headers = extractHeaders(err);
  const rawMsg: string = err?.message || (typeof e === "string" ? e : "Unbekannter Fehler");

  // ---- 429: Rate Limit ----
  if (status === 429) {
    const retry = computeRetryFromHeaders(headers);

    // Detect specific limit type from message + headers
    const isDailySpend = /daily.spend|daily.usage.limit/i.test(rawMsg);
    const isMonthlySpend = /monthly.spend|monthly.usage/i.test(rawMsg);
    const isInputTokens =
      /input.tokens.*per.minute/i.test(rawMsg) ||
      headers["anthropic-ratelimit-input-tokens-remaining"] === "0";
    const isOutputTokens =
      /output.tokens.*per.minute/i.test(rawMsg) ||
      headers["anthropic-ratelimit-output-tokens-remaining"] === "0";
    const isRequestsPerMinute =
      /requests.per.minute/i.test(rawMsg) ||
      headers["anthropic-ratelimit-requests-remaining"] === "0";
    const isRequestsPerDay = /requests.per.day|daily.request/i.test(rawMsg);

    // Spend-based limits — these need to be paid up or wait until reset
    if (isDailySpend) {
      return {
        code: "rate_limit_anthropic",
        userMessage:
          "Tagesbudget für Anthropic erreicht. Heute keine weiteren Abfragen möglich. Morgen wieder verfügbar oder Budget in console.anthropic.com erhöhen.",
        retryAfter: nextDayUTC(),
        detail: rawMsg,
      };
    }
    if (isMonthlySpend) {
      return {
        code: "rate_limit_anthropic",
        userMessage:
          "Monatsbudget für Anthropic erreicht. Bitte Budget in console.anthropic.com erhöhen oder bis zum nächsten Monat warten.",
        detail: rawMsg,
      };
    }
    if (isRequestsPerDay) {
      return {
        code: "rate_limit_anthropic",
        userMessage:
          "Tageslimit für Anfragen erreicht. Morgen wieder verfügbar oder höheres Anthropic-Tier wählen.",
        retryAfter: nextDayUTC(),
        detail: rawMsg,
      };
    }

    // Per-minute token/request limits
    let what = "Anthropic-Limit";
    if (isInputTokens) what = "Token-Eingabelimit (pro Minute)";
    else if (isOutputTokens) what = "Token-Ausgabelimit (pro Minute)";
    else if (isRequestsPerMinute) what = "Anfragen-Limit (pro Minute)";

    const wait = retry ? humanWait(retry) : "etwa 1 Minute";
    return {
      code: isInputTokens ? "rate_limit_tokens_per_minute" : "rate_limit_anthropic",
      userMessage: `${what} erreicht. Bitte ${wait} warten und erneut versuchen.`,
      retryAfter: retry?.retryAt,
      detail: rawMsg,
    };
  }

  // ---- 529: Overloaded ----
  if (status === 529 || /overloaded/i.test(rawMsg)) {
    return {
      code: "overloaded",
      userMessage: "Anthropic ist gerade überlastet. Bitte 1–2 Minuten warten und erneut versuchen.",
      retryAfter: Date.now() + 60_000,
      detail: rawMsg,
    };
  }

  // ---- 401/403: Auth ----
  if (status === 401) {
    return {
      code: "auth_invalid",
      userMessage: "API-Key ungültig. Bitte ANTHROPIC_API_KEY in den Vercel-Einstellungen prüfen.",
      detail: rawMsg,
    };
  }
  if (status === 403) {
    return {
      code: "auth_invalid",
      userMessage: "Zugriff verweigert. Der API-Key hat keine Berechtigung für diese Aktion.",
      detail: rawMsg,
    };
  }
  if (/ANTHROPIC_API_KEY/.test(rawMsg)) {
    return {
      code: "auth_missing",
      userMessage: "Kein API-Key konfiguriert. Bitte ANTHROPIC_API_KEY in den Umgebungsvariablen setzen.",
      detail: rawMsg,
    };
  }

  // ---- 400: Bad Request ----
  if (status === 400) {
    return {
      code: "bad_request",
      userMessage: `Anfrage wurde abgelehnt. ${shortenMsg(rawMsg)}`,
      detail: rawMsg,
    };
  }

  // ---- 5xx: Server errors ----
  if (typeof status === "number" && status >= 500 && status < 600) {
    return {
      code: "unknown",
      userMessage: "Anthropic hatte einen kurzen Aussetzer. Bitte gleich nochmal probieren.",
      retryAfter: Date.now() + 10_000,
      detail: `HTTP ${status}: ${rawMsg}`,
    };
  }

  // ---- Timeouts & network ----
  if (err?.name === "AbortError" || /aborted|timed?\s*out|deadline/i.test(rawMsg)) {
    return {
      code: "timeout",
      userMessage:
        "Die Anfrage hat zu lange gedauert (über 90 Sek.). Mögliche Ursachen: viele oder langsame Quellen. Bitte erneut versuchen — beim zweiten Versuch sind viele Quellen bereits gecacht und antworten schnell.",
      detail: rawMsg,
    };
  }
  if (
    /load.failed|networkerror|fetch.failed|err_connection|err_network|err_internet/i.test(rawMsg) ||
    /failed to fetch/i.test(rawMsg) ||
    (status === undefined && /TypeError/.test(err?.name || ""))
  ) {
    return {
      code: "network",
      userMessage:
        "Verbindung zum Server unterbrochen. Bitte Internetverbindung prüfen und erneut versuchen. Falls das Problem weiter besteht, war der Server zu langsam (Timeout nach 90 Sek.).",
      detail: rawMsg,
    };
  }
  if (/ECONN|ENOTFOUND/i.test(rawMsg)) {
    return {
      code: "network",
      userMessage:
        "Eine der Quellen war nicht erreichbar. Andere Quellen werden trotzdem ausgewertet. Erneut versuchen oder die betroffene Quelle in den Einstellungen entfernen.",
      detail: rawMsg,
    };
  }

  // ---- JSON parse errors ----
  if (/JSON|parse|unexpected token/i.test(rawMsg)) {
    return {
      code: "parse_failure",
      userMessage: "Antwort konnte nicht ausgelesen werden. Bitte erneut versuchen — meist hilft das schon.",
      detail: rawMsg,
    };
  }

  // ---- Fallback ----
  return {
    code: "unknown",
    userMessage: "Etwas ist schiefgegangen. Bitte erneut versuchen.",
    detail: rawMsg,
  };
}

/**
 * Anthropic returns headers like:
 *   retry-after: 5
 *   anthropic-ratelimit-input-tokens-reset: 2026-04-25T11:23:00Z
 * We use whichever is more specific.
 */
function computeRetryFromHeaders(
  headers: Record<string, string>
): { retryAt: number; seconds: number } | null {
  // Prefer the absolute reset time if present
  const resetCandidates = [
    headers["anthropic-ratelimit-input-tokens-reset"],
    headers["anthropic-ratelimit-output-tokens-reset"],
    headers["anthropic-ratelimit-requests-reset"],
  ].filter(Boolean);

  if (resetCandidates.length > 0) {
    // Pick the latest (most conservative) reset time
    const times = resetCandidates
      .map((s) => Date.parse(s))
      .filter((t) => !isNaN(t));
    if (times.length > 0) {
      const retryAt = Math.max(...times);
      const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
      return { retryAt, seconds };
    }
  }

  // Fall back to the relative retry-after header
  const ra = headers["retry-after"];
  if (ra) {
    const seconds = parseInt(ra, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return { retryAt: Date.now() + seconds * 1000, seconds };
    }
    // Some servers send retry-after as an HTTP date
    const asDate = Date.parse(ra);
    if (!isNaN(asDate)) {
      const seconds = Math.max(1, Math.ceil((asDate - Date.now()) / 1000));
      return { retryAt: asDate, seconds };
    }
  }

  return null;
}

function extractHeaders(err: any): Record<string, string> {
  const out: Record<string, string> = {};
  const h = err?.headers || err?.response?.headers;
  if (!h) return out;

  // Headers can be a plain object, a Map-like, or a Fetch Headers instance
  if (typeof h.get === "function") {
    // Fetch Headers
    const knownKeys = [
      "retry-after",
      "anthropic-ratelimit-input-tokens-reset",
      "anthropic-ratelimit-output-tokens-reset",
      "anthropic-ratelimit-requests-reset",
      "anthropic-ratelimit-input-tokens-remaining",
      "anthropic-ratelimit-output-tokens-remaining",
      "anthropic-ratelimit-requests-remaining",
    ];
    for (const k of knownKeys) {
      const v = h.get(k);
      if (v) out[k] = String(v);
    }
    return out;
  }

  if (typeof h === "object") {
    for (const [k, v] of Object.entries(h)) {
      out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

/**
 * Render a wait time like "30 Sekunden" or "2 Minuten" or "bis 14:32 Uhr".
 */
function humanWait(retry: { retryAt: number; seconds: number }): string {
  const { seconds, retryAt } = retry;
  if (seconds < 60) return `${seconds} Sekunde${seconds === 1 ? "" : "n"}`;
  if (seconds < 60 * 5) {
    const mins = Math.ceil(seconds / 60);
    return `${mins} Minute${mins === 1 ? "" : "n"}`;
  }
  // For longer waits, give a clock time so the user knows when to come back
  const d = new Date(retryAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `bis ${hh}:${mm} Uhr`;
}

function shortenMsg(s: string, max = 120): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).trim() + "…";
}

/**
 * Anthropic daily limits reset at 00:00 UTC.
 */
function nextDayUTC(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Build a NextResponse-compatible error payload for API routes.
 */
export function errorResponse(e: unknown): { body: { error: AppError }; status: number } {
  const appErr = toAppError(e);
  const err = e as any;
  const status = err?.status ?? err?.response?.status ?? 500;
  return {
    body: { error: appErr },
    status: typeof status === "number" ? status : 500,
  };
}
