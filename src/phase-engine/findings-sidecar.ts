/**
 * #467 — the QA hunt phase's findings, persisted beside the terminal marker.
 *
 * A dispatch_task phase returns a `MergedOutput` with no envelope `kind`, so
 * pipeline-run's envelope loop never records it and the findings a QA leg
 * produced reached neither trace.db nor events.jsonl. The worker's structured
 * reply rides `agentOutputs[<agentId>]` (merger.ts `validateWorkerOutput`
 * keeps only its `result` object), so the hunt task asks for the findings
 * UNDER `result` and this module lifts them out.
 *
 * The file lands at `<runRoot>/journal/findings.json`, which DF2.5's
 * artifacts pull carries to `<runsDir>/<runId>-artifacts/journal/findings.json`
 * (harvest.ts BOX_RUN_SOURCES). It is written BEFORE `run.finish`, so a
 * harvest keyed on the marker never races it.
 *
 * Redaction is already done: `buildMergedOutput` runs `redactDeep` over
 * `agentOutputs`. Fail closed: a malformed or oversized payload writes NOTHING
 * (the host reader then reports absence) and the caller logs the reason. The
 * strict schema (src/qa/findings.ts HarvestOutputSchema) is the host's; this
 * box-side check only refuses shapes that are not findings at all, because
 * src/qa does not ship in the box.
 */
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FINDINGS_SIDECAR = "findings.json";
/** 32 findings × (4096-char text + 512-char ref) fits with room; past this is garbage. */
export const FINDINGS_SIDECAR_MAX_BYTES = 256 * 1024;

export type FindingsSidecarResult =
  | { written: true; path: string; count: number }
  | { written: false; reason: "none" | "malformed" | "oversize" | "write-failed"; detail?: string };

const isFinding = (f: unknown): boolean =>
  typeof f === "object" &&
  f !== null &&
  typeof (f as Record<string, unknown>).finding_text === "string" &&
  typeof (f as Record<string, unknown>).diff_context_ref === "string";

/** The first agent output carrying a `findings` field, as found (unchecked). */
export function extractFindings(value: unknown): { found: false } | { found: true; findings: unknown } {
  const outputs = (value as { agentOutputs?: unknown } | null | undefined)?.agentOutputs;
  if (typeof outputs !== "object" || outputs === null) return { found: false };
  for (const out of Object.values(outputs)) {
    if (typeof out === "object" && out !== null && "findings" in out) {
      return { found: true, findings: (out as { findings: unknown }).findings };
    }
  }
  return { found: false };
}

/**
 * Write the first phase value's findings beside `markerPath`. Never throws.
 * Every non-written arm REMOVES a sidecar already there: a resumed or re-walked
 * run on the same run root must not have an earlier walk's findings harvested
 * as this one's.
 */
export function writeFindingsSidecar(markerPath: string, values: readonly unknown[]): FindingsSidecarResult {
  const out = writeOrRefuse(markerPath, values);
  if (!out.written) {
    try {
      rmSync(join(dirname(markerPath), FINDINGS_SIDECAR), { force: true });
    } catch {
      /* best effort: the refusal above is the result either way */
    }
  }
  return out;
}

function writeOrRefuse(markerPath: string, values: readonly unknown[]): FindingsSidecarResult {
  for (const value of values) {
    const got = extractFindings(value);
    if (!got.found) continue;
    if (!Array.isArray(got.findings) || !got.findings.every(isFinding)) {
      return { written: false, reason: "malformed", detail: "findings is not an array of {finding_text, diff_context_ref}" };
    }
    try {
      const text = JSON.stringify({ schemaVersion: 1, findings: got.findings });
      if (Buffer.byteLength(text) > FINDINGS_SIDECAR_MAX_BYTES) {
        return { written: false, reason: "oversize", detail: `${Buffer.byteLength(text)} > ${FINDINGS_SIDECAR_MAX_BYTES} bytes` };
      }
      const path = join(dirname(markerPath), FINDINGS_SIDECAR);
      writeFileSync(path, text, { mode: 0o600 });
      return { written: true, path, count: got.findings.length };
    } catch (e) {
      return { written: false, reason: "write-failed", detail: e instanceof Error ? e.message : String(e) };
    }
  }
  // The "none" arm (no agent output carried a `findings` field — a model
  // nondeterminism: the same pipeline yields findings on one leg and none on
  // the next) used to DELETE any sidecar and return absent. A completed leg
  // then harvested with no sidecar at all, and the host's normalizeHarvest
  // rightly refuses a completed leg without a harvest. A zero is a RESULT,
  // not an absence: write the empty sidecar (count 0), which the strict
  // schema reads as legRan with zero findings. The removal semantics stay
  // for the true refusals (malformed / oversize / write-failed): a resumed
  // walk must not be harvested as this one's.
  try {
    const path = join(dirname(markerPath), FINDINGS_SIDECAR);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, findings: [] }), { mode: 0o600 });
    return { written: true, path, count: 0 };
  } catch (e) {
    return { written: false, reason: "write-failed", detail: e instanceof Error ? e.message : String(e) };
  }
}
