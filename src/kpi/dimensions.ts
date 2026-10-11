/**
 * A5 — the AC4 dimension readers, split out of join.ts for the <500-line file
 * rule (same precedent as schema.ts's split from kpis.ts). A dimension is
 * typed `{source, status: "absent"}` or `{source, status: "joined", count}`
 * — never a bare 0-as-measured, the same absent-not-0 law as every missing
 * source. KpiError comes from join.ts (one-way import — join.ts does not
 * import this module).
 */
import { readFileSync } from "node:fs";

import { z } from "zod";

import { KpiError } from "./join.ts";

// ─── dimensions (AC4) ────────────────────────────────────────────────────────

export const DimensionSchema = z.union([
  z.strictObject({ source: z.string(), status: z.literal("absent") }),
  z.strictObject({ source: z.string(), status: z.literal("joined"), count: z.number().int() }),
]);

export type Dimension = z.infer<typeof DimensionSchema>;

/** Type a named source absent — a dimension column is never `0`, never omitted. */
export function absentDimension(source: string): Dimension {
  return { source, status: "absent" };
}

/** Read-side dimension join over a JSONL source: ENOENT → typed absent; present → line count. Used for J3's routing log. */
export function readJsonlDimension(source: string, path: string): Dimension {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return absentDimension(source);
    throw e;
  }
  const count = text.split("\n").filter((l) => l.trim() !== "").length;
  return { source, status: "joined", count };
}

/**
 * Routing-decision dimension (AC4): joins each routing-log line by its OWNED
 * key — `runId` — against the in-window run ids, and reports JOINED decisions
 * only. A line whose runId is outside the window (stale) and a line with no
 * runId field each carry no joinable key and are not counted. A non-JSON line
 * that is NOT the final non-blank line is a typed `routing-log-invalid` fault
 * (F-011); the final non-blank line failing to parse is TOLERATED and not
 * counted — a concurrent appender's torn tail. ENOENT → typed absent.
 */
export function readRoutingLogDimension(
  source: string,
  path: string,
  inWindowRunIds: ReadonlySet<string>,
): Dimension {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return absentDimension(source);
    throw e;
  }
  const rawLines = text.split("\n");
  let lastNonBlank = -1;
  for (const [i, raw] of rawLines.entries()) {
    if (raw.trim() !== "") lastNonBlank = i;
  }
  let count = 0;
  for (const [i, raw] of rawLines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (i === lastNonBlank) continue; // torn tail — tolerated, not counted
      throw new KpiError(
        "routing-log-invalid",
        `routing log ${path} line ${i + 1} is not JSON`,
        "a corrupt non-tail routing line is a fault — inspect the log before recomputing KPIs (only a torn final line is tolerated)",
      );
    }
    const runId = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).runId : undefined;
    if (typeof runId === "string" && inWindowRunIds.has(runId)) count++;
  }
  return { source, status: "joined", count };
}
