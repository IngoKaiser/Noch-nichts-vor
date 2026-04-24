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
