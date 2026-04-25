import Anthropic from "@anthropic-ai/sdk";

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable not set");
  }
  return new Anthropic({ apiKey });
}

export function extractTextFromResponse(content: any[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function extractJson<T = any>(text: string): T {
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const firstBrace = cleaned.search(/[\[{]/);
  if (firstBrace >= 0) cleaned = cleaned.slice(firstBrace);
  const lastBrace = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
  if (lastBrace >= 0) cleaned = cleaned.slice(0, lastBrace + 1);
  return JSON.parse(cleaned) as T;
}

/**
 * Wrapper around messages.create that handles 429 rate-limit errors with
 * exponential backoff. Retries up to `maxRetries` times.
 */
export async function createWithRetry(
  client: Anthropic,
  params: any,
  maxRetries: number = 2
): Promise<any> {
  let attempt = 0;
  let lastError: any;

  while (attempt <= maxRetries) {
    try {
      return await client.messages.create(params);
    } catch (e: any) {
      lastError = e;
      const status = e?.status || e?.response?.status;
      const isRateLimit = status === 429;
      const isOverloaded = status === 529;

      if ((isRateLimit || isOverloaded) && attempt < maxRetries) {
        // Exponential backoff: 5s, 15s
        const delay = isRateLimit ? (attempt === 0 ? 5000 : 15000) : 3000;
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

/**
 * Translate raw API errors into more user-friendly German messages.
 */
export function friendlyError(e: any): string {
  const status = e?.status || e?.response?.status;
  const msg = e?.message || String(e);

  if (status === 429) {
    return "Rate-Limit erreicht. Bitte 1-2 Minuten warten und erneut versuchen.";
  }
  if (status === 529 || /overloaded/i.test(msg)) {
    return "Anthropic-API ist gerade überlastet. Bitte kurz warten und erneut versuchen.";
  }
  if (status === 401) {
    return "API-Key ungültig oder fehlt. Bitte ANTHROPIC_API_KEY prüfen.";
  }
  if (status === 400) {
    return `Anfrage abgelehnt: ${msg}`;
  }
  return msg;
}
