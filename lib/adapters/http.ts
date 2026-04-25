/**
 * Polite HTTP fetch with browser-like User-Agent and timeout.
 * Many German news sites block requests without a UA header.
 */

const UA =
  "Mozilla/5.0 (compatible; NochNichtsVorBot/1.0; +https://github.com/your/noch-nichts-vor)";

export async function fetchWithTimeout(
  url: string,
  options: { timeoutMs?: number; accept?: string } = {}
): Promise<Response> {
  const { timeoutMs = 10_000, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.5",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return await res.text();
}
