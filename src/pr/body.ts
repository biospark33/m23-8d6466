/**
 * The PR body (Story DF5.2, AC2 / INV-PR-7).
 *
 * A PR is a PUBLICATION surface. What goes on it is exactly enough for a
 * reviewer to see what was verified and where to look — the DF5.1 check tally,
 * the failing item names, the flags, the changed-file list, the cost and the
 * approver. The trace DB, the compiled prompts and the full agent transcripts
 * are never attached, uploaded or quoted (F11/R10): access to that material
 * stays host-side and tier-1-tunneled.
 *
 * Pure — no fs, no network, no clock. Everything it renders is an argument, so
 * the redaction boundary is one function call and the cap is one slice.
 */
import { redactSecrets } from "../../cli-anything/src/redact.ts";
import { assertRedactable, type RedactionMap, type ReverifyReport } from "../reverify/report.ts";

/** GitHub's ceiling is 65,536; the cap is the truncation suffix INCLUDED. */
export const BODY_MAX_CHARS = 60_000;
export const CHECK_ROWS_MAX = 50;
export const CHANGED_FILES_MAX = 100;

export interface CostSummary {
  totalMicroUsd: number;
  eventCount: number;
  unpricedRows: number;
}

export interface BodyInput {
  runId: string;
  report: ReverifyReport;
  approval: { approverId: string; decidedAt: string };
  /** Rendered issue reference, or `unresolved`. ALWAYS a line — never omitted. */
  issueRef: string;
  /** Null when the ledger is unreachable or holds no rows for this run. */
  cost: CostSummary | null;
  changedFiles: readonly string[];
}

/**
 * Integer micro-dollars to `$D.dddddd`, with NO rounding (DD-9). A sub-cent
 * role split is not float-representable, so the ledger's integer is carried
 * through to the last digit rather than through a `toFixed`.
 */
export function renderMicroUsd(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(micro));
  return `${sign}$${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, "0")}`;
}

/**
 * The cost line, or `Cost: unavailable`.
 *
 * DF2.8 is not a predecessor edge: an unreachable or empty ledger is a
 * REPORTING gap, not a reason to withhold a verified PR. The `unpriced` count
 * rides along so a reviewer can see when the total is incomplete.
 */
export function renderCostLine(cost: CostSummary | null): string {
  if (cost === null) return "Cost: unavailable";
  const events = `${cost.eventCount} event${cost.eventCount === 1 ? "" : "s"}`;
  return `Cost: ${renderMicroUsd(cost.totalMicroUsd)} (${events}, ${cost.unpricedRows} unpriced)`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const suffix = `\n\n[truncated, ${text.length} chars total]`;
  return `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

function capList(items: readonly string[], max: number): string[] {
  if (items.length <= max) return [...items];
  return [...items.slice(0, max), `+${items.length - max} more`];
}

/**
 * Render the body, redact it ONCE at this boundary, then cap it.
 *
 * Redact-then-truncate, not the reverse: a secret straddling the cut no longer
 * matches the full-value pattern, so truncating first would leak its suffix
 * (the same reasoning `report.ts#scrub` carries one layer down).
 *
 * `redaction` is a purpose-built map of THIS RUN's known-sensitive values — the
 * host token, the run's minted provider key and its hash, the approver token —
 * assembled by the caller. Never `process.env`: INV-PR-2 keeps the token out of
 * the environment entirely, so an environment-derived map would redact nothing
 * (INV-PR-7).
 *
 * The map is VALIDATED here, not merely applied. `redactSecrets` silently
 * ignores a key its heuristic does not recognise, and `RedactionMap` is an
 * unrestricted `Record<string, string>` — so a caller who names the host token
 * `hostCredential` gets a body with the token still in it and no error. Only
 * `sealReport` validated before; this is the second publication boundary and it
 * validates too (INV-PR-7).
 */
export function renderBody(input: BodyInput, redaction: RedactionMap): string {
  assertRedactable(redaction);
  const { report } = input;
  const failing = report.checks.filter((c) => !c.ok);
  const tally = `${report.checks.length - failing.length}/${report.checks.length} checks`;

  const lines: string[] = [
    `Run: ${input.runId}`,
    `Issue: ${input.issueRef}`,
    renderCostLine(input.cost),
    `Re-verify: ${report.verdict} — ${tally}${failing.length > 0 ? ` (failing: ${failing.map((c) => c.item).join(", ")})` : ""}`,
    `Approved by: ${input.approval.approverId} at ${input.approval.decidedAt}`,
    `Flags: ${report.flags.length > 0 ? report.flags.join(", ") : "none"}`,
    `Head: ${report.headSha} (base ${report.baseSha})`,
    "",
    `## Verified checks (${tally})`,
    "",
  ];

  for (const row of capList(
    report.checks.map((c) => `- ${c.ok ? "ok" : "FAIL"} — ${c.item}`),
    CHECK_ROWS_MAX,
  )) {
    lines.push(row);
  }

  lines.push("", `## Changed files (${input.changedFiles.length})`, "");
  for (const row of capList(
    input.changedFiles.map((f) => `- ${f}`),
    CHANGED_FILES_MAX,
  )) {
    lines.push(row);
  }

  lines.push(
    "",
    "---",
    "Re-verified host-side, out of the sandbox, before this PR was opened. The trace database,",
    "compiled prompts and agent transcripts are host-side artifacts and are deliberately not published here.",
  );

  return truncate(redactSecrets(lines.join("\n"), redaction), BODY_MAX_CHARS);
}

export function renderTitle(runId: string, changedFiles: readonly string[]): string {
  const n = changedFiles.length;
  return `qds run ${runId} — ${n} file${n === 1 ? "" : "s"}, re-verified green`;
}

/** The refusal notification, same content as the durable record (AC3). */
export function renderRefusalComment(
  runId: string,
  refusal: { failedPrecondition: string; failingChecks: string[]; reportPath: string; message: string },
  redaction: RedactionMap,
): string {
  assertRedactable(redaction);
  const lines = [
    `No PR was opened for run \`${runId}\`.`,
    "",
    `Failed precondition: \`${refusal.failedPrecondition}\``,
    `Detail: ${refusal.message}`,
    refusal.failingChecks.length > 0 ? `Failing checks: ${refusal.failingChecks.join(", ")}` : "Failing checks: none recorded",
    `Re-verify report: \`${refusal.reportPath}\``,
    "",
    "Nothing was pushed. The refusal is recorded host-side whether or not this comment landed.",
  ];
  return truncate(redactSecrets(lines.join("\n"), redaction), BODY_MAX_CHARS);
}
