/**
 * #467 host side: read a QA leg's findings sidecar out of its harvested
 * artifacts dir (`<runsDir>/<runId>-artifacts/journal/findings.json`, written
 * in-box by src/phase-engine/findings-sidecar.ts). Absence and unreadable or
 * malformed content are typed data, never a throw: the caller decides,
 * and `normalizeHarvest` stays the one strict schema gate.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { FINDINGS_SIDECAR, FINDINGS_SIDECAR_MAX_BYTES } from "../phase-engine/findings-sidecar.ts";
import { isHarvestFinding, MAX_FINDINGS_PER_HARVEST } from "./findings.ts";

export type HarvestedFindings =
  | { ok: true; path: string; findings: unknown[] }
  | { ok: false; path: string; reason: "absent" | "unreadable" | "oversize" | "malformed" };

export function harvestedFindingsPath(runsDir: string, runId: string): string {
  return join(runsDir, `${runId}-artifacts`, "journal", FINDINGS_SIDECAR);
}

export function readHarvestedFindings(runsDir: string, runId: string): HarvestedFindings {
  const path = harvestedFindingsPath(runsDir, runId);
  let text: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, path, reason: "unreadable" };
    if (st.size > FINDINGS_SIDECAR_MAX_BYTES) return { ok: false, path, reason: "oversize" };
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, path, reason: (e as { code?: string }).code === "ENOENT" ? "absent" : "unreadable" };
  }
  try {
    const parsed = JSON.parse(text) as { schemaVersion?: unknown; findings?: unknown };
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.findings)) return { ok: false, path, reason: "malformed" };
    return { ok: true, path, findings: parsed.findings };
  } catch {
    return { ok: false, path, reason: "malformed" };
  }
}

/**
 * The `normalizeHarvest` input for one leg. The box never names its lens, so
 * the host stamps the lens it submitted the leg under; absence is `undefined`,
 * which normalizeHarvest reads as legRan:false-or-refused, never as `[]`.
 *
 * Per-entry, not all-or-nothing: the box-side check is deliberately loose (the
 * strict schema lives in src/qa, which the box does not carry), so one entry a
 * worker shaped wrong — a `diff_context_ref` like `fn()` or `x.ts#L4`, an extra
 * key — must not cost the leg every valid finding. Entries failing
 * `isHarvestFinding`, and any past `MAX_FINDINGS_PER_HARVEST`, are dropped and
 * COUNTED (`onDropped`, default one stderr line) — the A2 day-of precedent
 * (`droppedPreNormalization`). A non-array, wrong-version file stays refused.
 */
export function harvestForLens(
  runsDir: string,
  runId: string,
  lens: string,
  onDropped: (dropped: number) => void = (dropped) =>
    process.stderr.write(`${JSON.stringify({ event: "harvest_findings_dropped", level: "warn", runId, lens, dropped })}\n`),
): unknown {
  const read = readHarvestedFindings(runsDir, runId);
  if (!read.ok) return undefined;
  const findings = read.findings.filter(isHarvestFinding).slice(0, MAX_FINDINGS_PER_HARVEST);
  const dropped = read.findings.length - findings.length;
  if (dropped > 0) onDropped(dropped);
  return { schemaVersion: 1, lens, findings };
}
