import { NextRequest, NextResponse } from "next/server";
import { detectAdapter } from "@/lib/adapters";
import type { EventSource } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Probe a list of sources to determine the best adapter for each.
 * Called once after the user confirms their source selection.
 *
 * Returns the same sources with `adapter` field populated.
 */
export async function POST(req: NextRequest) {
  try {
    const { sources } = await req.json();
    if (!Array.isArray(sources) || sources.length === 0) {
      return NextResponse.json({ error: "Sources required" }, { status: 400 });
    }

    // Probe all sources in parallel — but with a per-source timeout via the adapter itself
    const results = await Promise.all(
      (sources as EventSource[]).map(async (source) => {
        try {
          const adapter = await detectAdapter(source.url);
          return { ...source, adapter };
        } catch (e: any) {
          return {
            ...source,
            adapter: {
              kind: "html" as const,
              probedAt: new Date().toISOString(),
              ok: false,
              note: e?.message || "probe failed",
            },
          };
        }
      })
    );

    return NextResponse.json({ sources: results });
  } catch (e: any) {
    console.error("Probe error", e);
    return NextResponse.json({ error: e?.message || "Probe failed" }, { status: 500 });
  }
}
