/**
 * DF2.12 host leg — the cost-attribution reader. One module, two surfaces:
 *
 *  - `ingestHarvestedTokens` — teardown's reader. Reads the harvested engine
 *    log `<runsDir>/<runId>-artifacts/<runId>.engine.log` (harvest.ts
 *    `pullArtifacts` re-roots the in-box `$HOME/<runId>.engine.log` there),
 *    selects the `cost_attribution` lines for this runId, and drives
 *    `ingestCostEvent` once per line. `ingestCostEvent` stays the ONLY writer
 *    of `kind='tokens'` rows — DF2.8's idempotency digest and unpriced
 *    taxonomy both rest on that, so this module adds a caller, never a writer.
 *  - `classifyHarvestedTokens` — the same evidence, classified without a
 *    ledger write, for `qds cost`'s per-run rendering. AC4's discriminator is
 *    the harvested evidence itself, so both surfaces read the SAME file
 *    through the SAME classifier and agree by construction.
 *
 * INV-COST-8 (the reader's half): `role` and `invocationSeq` are read OFF THE
 * LINE, never re-derived from iteration order. A position-derived reader
 * re-numbers on a partial re-harvest, which changes the AC2 `event_id` digest
 * and turns `ON CONFLICT DO NOTHING` into duplicate spend. A line missing
 * either field is refused with a structured error naming the field and zero
 * rows — DF2.8's `assertIngestCtx` posture, mirrored here so the refusal
 * happens before a ledger round trip.
 *
 * INV-COST-9 (fail-closed): an absent or unreadable log is the outcome
 * `tokens-not-harvested`, never an implicit zero. A PARSED `cost_attribution`
 * line whose money figure is unusable is handed to `ingestCostEvent`
 * unchanged — it persists `unpriced = 1` (AC5's taxonomy, no new class) so
 * the spend stays visible to every unpriced count. A line that does not even
 * parse (a log truncated mid-write) cannot supply `role`, and a guessed role
 * is the one thing INV-COST-8 forbids — so it is refused loudly and counted
 * in the summary rather than filtered silently.
 *
 * No credential material anywhere: the line carries agentId/role/model and
 * never a key, a key hash or an `sk-or-` token (INV-COST-5).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "../lib/log.ts";
import { COST_ROLES, type CostRole, type CostWireEvent, type IngestCtx, type IngestResult } from "./cost-ledger.ts";
import { resolveRunsDir } from "./run-record.ts";

/**
 * The subset of `CostLedger` the bridge drives — structural, so tests hand a
 * stub. The method is called AS A METHOD on this object (never detached), so
 * a real `CostLedger` keeps its `this`. Optional because the contract's
 * structural mirrors (teardown's CostLedgerHook) may narrow it; the ingest
 * refuses rather than guessing when it is absent.
 */
export interface TokenIngestTarget {
  ingestCostEvent?(event: CostWireEvent, ctx: IngestCtx): IngestResult;
}

/** The run record's `extensions.budget`, exactly as the DF2.8 ingest points read it. */
export interface HarvestedBudget {
  repoSlug?: string | number;
  issueId?: string | number;
}

export type TokenRowOutcome = "ingested" | "duplicate" | "refused";

/**
 * The summary vocabulary. The Observability Contract's three states, plus the
 * fourth AC4's refined mechanism names: a readable log carrying ZERO
 * cost_attribution lines is `no-token-spend`, never `tokens-not-harvested` —
 * calling a genuinely spendless run unharvested is exactly the false alarm the
 * AC4 negative control rules out.
 */
export type HarvestSummaryOutcome = "ingested" | "tokens-not-harvested" | "no-token-spend" | "refused";

export interface HarvestedIngestSummary {
  /** The path the reader looked at — named on every summary, present or not. */
  logPath: string;
  rowsRead: number;
  rowsInserted: number;
  rowsDuplicate: number;
  rowsUnpriced: number;
  rowsRefused: number;
  outcome: HarvestSummaryOutcome;
  /** Why a non-`ingested` outcome — names the path and the DF2.5 outcome behind it. */
  reason?: string;
  logReadMs: number;
}

export function harvestedEngineLogPath(runsDir: string | undefined, runId: string): string {
  return join(resolveRunsDir(runsDir), `${runId}-artifacts`, `${runId}.engine.log`);
}

interface HarvestedLog {
  ok: true;
  logPath: string;
  text: string;
  logReadMs: number;
}
type HarvestedLogResult = HarvestedLog | { ok: false; logPath: string; logReadMs: number; error: string };

/** Read the harvested engine log, classifying absence/unreadability as data (INV-COST-9). */
function readHarvestedLog(runsDir: string | undefined, runId: string): HarvestedLogResult {
  const logPath = harvestedEngineLogPath(runsDir, runId);
  const started = Date.now();
  try {
    return { ok: true, logPath, text: readFileSync(logPath, "utf8"), logReadMs: Date.now() - started };
  } catch (e) {
    const err = (e ?? {}) as { code?: string; message?: string };
    return { ok: false, logPath, logReadMs: Date.now() - started, error: err.code ?? String(e) };
  }
}

// The role gate reads the ledger's own vocabulary (BRG-3: one list, derived
// from `CostRole`, so a role the ingest's `assertIngestCtx` refuses can never
// pass this gate — the two checks were separate literal sets until review
// round 6).
const ROLES: ReadonlySet<string> = new Set<string>(COST_ROLES);

/**
 * The count fields whose values reach SQLite STRICT INTEGER columns (input/
 * output/cache/turn). A value that is `typeof "number"` but NOT an integer
 * (a fractional count, `Infinity`) would fail the bind mid-loop and abort the
 * whole ingest (BRG-1) — the bridge refuses the line instead and keeps going.
 */
const COUNT_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "turnCount",
] as const;

/**
 * The AC4 discriminator's states for one run's harvested log, as `qds cost`
 * renders them: `tokens-not-harvested` (no readable evidence — never a zero),
 * `no-token-spend` (readable, nothing emitted), `token-rows` (candidate lines
 * and/or refusal evidence exist; whether any PRICED row landed is the ledger
 * view's to say — `refusedLines` keeps the lost-evidence half of the log
 * visible even beside priced rows, BRG-4). Only `cost_attribution` lines for
 * this runId count; anything else on the engine log is not a cost event and
 * skipping it drops no spend.
 */
export type HarvestedTokenState =
  | { state: "tokens-not-harvested"; logPath: string; reason: string }
  | { state: "no-token-spend"; logPath: string }
  | {
      state: "token-rows";
      logPath: string;
      /** Parseable `cost_attribution` lines in scope — candidate money rows. */
      lines: number;
      /** Refusal EVIDENCE lines: `cost_attribution_refused` markers plus
       * truncated cost lines. Money the reader could not attribute (BRG-4:
       * without this count, a mixed priced+refused log rendered as a clean
       * `token-rows` and the lost evidence was invisible). */
      refusedLines: number;
    };

export function classifyHarvestedTokens(runsDir: string | undefined, runId: string): HarvestedTokenState {
  const read = readHarvestedLog(runsDir, runId);
  if (!read.ok) {
    return {
      state: "tokens-not-harvested",
      logPath: read.logPath,
      reason: `no readable harvested engine log at ${read.logPath} (${read.error}) — the DF2.5 artifacts pull failed or the box died before harvest, so no attribution evidence exists`,
    };
  }
  // One pass, the same line semantics the ingest applies: an in-scope cost
  // line counts once as a candidate, refusal evidence (marker or truncated
  // line) counts once as refused, everything else counts never.
  let candidates = 0;
  let refused = 0;
  for (const raw of read.text.split("\n")) {
    if (raw.trim() === "") continue;
    const kind = classifyLine(raw, runId).kind;
    if (kind === "line") candidates += 1;
    else if (kind !== "other") refused += 1;
  }
  if (candidates === 0 && refused === 0) return { state: "no-token-spend", logPath: read.logPath };
  return { state: "token-rows", logPath: read.logPath, lines: candidates, refusedLines: refused };
}

/**
 * The line kinds the reader distinguishes, shared by the ingest loop and the
 * classifier so both surfaces agree by construction:
 *  - "line"      — a parseable `cost_attribution` line in scope for runId.
 *                  Scope is generous on purpose: the harvested log is ALREADY
 *                  a per-run file (`<runId>-artifacts/<runId>.engine.log`), so
 *                  a line whose runId field is absent still belongs to this
 *                  run's evidence; only a line naming a DIFFERENT runId is
 *                  foreign and skipped;
 *  - "refused"   — a parseable `cost_attribution_refused` marker in scope:
 *                  the in-box emission was REFUSED (INV-COST-8 — role or
 *                  invocationSeq not attributable). Evidence, never money:
 *                  counted in `rowsRefused`, zero rows written, so a run
 *                  whose cost events were all refused reads as `refused`,
 *                  never as the `no-token-spend` that means genuinely
 *                  spendless;
 *  - "truncated" — an UNPARSEABLE line whose JSON head still carries
 *                  `cost_attribution` (truncation cuts a line's tail, so the
 *                  head is the tell): money evidence the reader cannot
 *                  attribute. The head check is load-bearing (BRG-2): a bare
 *                  `includes` on any unparseable line fabricated refusal
 *                  evidence out of tee'd stderr noise that merely mentioned
 *                  the string;
 *  - "other"     — everything else on the engine log (step lines, trace
 *                  notes, another run's lines, tee'd stderr noise): not cost
 *                  evidence, never counted, never dropped spend.
 */
function classifyLine(
  raw: string,
  runId: string,
): { kind: "line"; line: Record<string, unknown> } | { kind: "refused" } | { kind: "truncated" } | { kind: "other" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON head required: truncation is a cut-off OBJECT, so the line starts
    // like one. (A truncated `cost_attribution_refused` marker still lands
    // here — misfiled as truncated money evidence, which the substring limit
    // accepts: both are refusal-shaped evidence, never money.)
    return raw.trimStart().startsWith("{") && raw.includes("cost_attribution")
      ? { kind: "truncated" }
      : { kind: "other" };
  }
  if (parsed === null || typeof parsed !== "object") return { kind: "other" };
  const line = parsed as Record<string, unknown>;
  if (line.type === "cost_attribution_refused") {
    if (line.runId !== undefined && line.runId !== runId) return { kind: "other" };
    return { kind: "refused" };
  }
  if (line.type !== "cost_attribution") return { kind: "other" };
  if (line.runId !== undefined && line.runId !== runId) return { kind: "other" };
  return { kind: "line", line };
}

/**
 * The host leg's one ingest. Reads the harvested log and calls
 * `ledger.ingestCostEvent` once per `cost_attribution` line, building each
 * `IngestCtx` from the run record's `extensions.budget` (the same source and
 * the same string-only validation `ingestBoxHoursIfAttributed` uses) plus the
 * line's own role/invocationSeq. Returns the summary the caller's log carries.
 *
 * Throws only when the LEDGER refuses (busy, key-hash-missing) — the same
 * fail-closed posture the box-hours ingest beside it has; log-level problems
 * are `tokens-not-harvested` / `refused` outcomes, never throws.
 */
export function ingestHarvestedTokens(
  ledger: TokenIngestTarget,
  runsDir: string | undefined,
  runId: string,
  budget: HarvestedBudget | undefined,
  requestId: string,
): HarvestedIngestSummary {
  // Same string-only validation as ingestBoxHoursIfAttributed: non-string
  // budget fields are no attribution, and an unattributable row is not
  // persisted under a guessed issue (INV-COST-8's ctx half).
  const repoSlug = typeof budget?.repoSlug === "string" ? budget.repoSlug : undefined;
  const issueId = typeof budget?.issueId === "string" ? budget.issueId : undefined;
  if (repoSlug === undefined || issueId === undefined) {
    const summary: HarvestedIngestSummary = {
      logPath: harvestedEngineLogPath(runsDir, runId),
      rowsRead: 0,
      rowsInserted: 0,
      rowsDuplicate: 0,
      rowsUnpriced: 0,
      rowsRefused: 0,
      outcome: "refused",
      reason: `run record carries no string issue attribution in extensions.budget (${repoSlug === undefined ? "repoSlug" : "issueId"} absent) — token rows refused, zero written`,
      logReadMs: 0,
    };
    emitSummary(requestId, runId, summary);
    return summary;
  }

  if (ledger.ingestCostEvent === undefined) {
    throw new Error(
      "cost-ledger-bridge: the target ledger exposes no ingestCostEvent — nothing can drive token rows into it (INV-COST-9: never read this as zero)",
    );
  }

  const read = readHarvestedLog(runsDir, runId);
  if (!read.ok) {
    const summary: HarvestedIngestSummary = {
      logPath: read.logPath,
      rowsRead: 0,
      rowsInserted: 0,
      rowsDuplicate: 0,
      rowsUnpriced: 0,
      rowsRefused: 0,
      outcome: "tokens-not-harvested",
      reason: `no readable harvested engine log at ${read.logPath} (${read.error}) — the DF2.5 artifacts pull failed or the box died before harvest, so this run's token spend is unrecorded, not zero`,
      logReadMs: read.logReadMs,
    };
    emitSummary(requestId, runId, summary);
    return summary;
  }

  const summary: HarvestedIngestSummary = {
    logPath: read.logPath,
    rowsRead: 0,
    rowsInserted: 0,
    rowsDuplicate: 0,
    rowsUnpriced: 0,
    rowsRefused: 0,
    outcome: "refused",
    logReadMs: read.logReadMs,
  };

  for (const rawLine of read.text.split("\n")) {
    if (rawLine.trim() === "") continue;
    const classified = classifyLine(rawLine, runId);
    if (classified.kind === "other") continue;
    if (classified.kind === "refused") {
      // The in-box emission refused itself (INV-COST-8): the marker is
      // durable evidence that money flowed and was NOT attributed — counted,
      // never written as a row, never folded into a clean zero.
      summary.rowsRefused += 1;
      emitRow(requestId, runId, repoSlug, issueId, {
        outcome: "refused",
        reason: "in-box refusal marker (cost_attribution_refused) — the emission was refused before attribution (INV-COST-8); no row written",
      });
      continue;
    }
    if (classified.kind === "truncated") {
      // A log truncated mid-write: this line's money figure is gone, and
      // INV-COST-8 forbids guessing the role it would need. Refused loudly
      // and counted — never filtered into a silent zero.
      summary.rowsRefused += 1;
      emitRow(requestId, runId, repoSlug, issueId, {
        outcome: "refused",
        reason: "unparseable cost_attribution line (log truncated mid-write?) — no role/invocationSeq can be read off it, and attribution is never guessed (INV-COST-8)",
      });
      continue;
    }
    const line = classified.line;
    summary.rowsRead += 1;

    const role = typeof line.role === "string" && ROLES.has(line.role) ? (line.role as CostRole) : undefined;
    if (role === undefined) {
      summary.rowsRefused += 1;
      emitRow(requestId, runId, repoSlug, issueId, {
        outcome: "refused",
        role: typeof line.role === "string" ? line.role : undefined,
        reason: "line carries no valid role — attribution is supplied by the dispatcher, never inferred (INV-COST-8); zero rows written",
      });
      continue;
    }
    const invocationSeq =
      typeof line.invocationSeq === "number" && Number.isInteger(line.invocationSeq) && line.invocationSeq >= 0
        ? line.invocationSeq
        : undefined;
    if (invocationSeq === undefined) {
      summary.rowsRefused += 1;
      emitRow(requestId, runId, repoSlug, issueId, {
        outcome: "refused",
        role,
        reason: "line carries no integer invocationSeq — the digest input is read off the line, never derived from position (INV-COST-8); zero rows written",
      });
      continue;
    }
    // BRG-1: a count that is `typeof "number"` but not an integer (a
    // fractional token/cache/turn count, or `1e999` → `Infinity`) fails the
    // ledger's STRICT INTEGER bind — which used to abort the WHOLE loop and
    // permanently strand every later line as un-ingested on every re-run.
    // Refuse this line, name the field, keep going. String-typed numerics
    // keep the coerce-to-0 path below (money stays visible); only numbers
    // that cannot bind are refused here.
    const badCountField = COUNT_FIELDS.find((f) => {
      const v = line[f];
      return typeof v === "number" && !Number.isInteger(v);
    });
    if (badCountField !== undefined) {
      summary.rowsRefused += 1;
      emitRow(requestId, runId, repoSlug, issueId, {
        outcome: "refused",
        role,
        reason: `line carries non-integer ${badCountField} (${String(line[badCountField])}) — the ledger's STRICT INTEGER columns cannot bind it, so the line is refused and the loop continues rather than aborting the whole ingest (BRG-1); zero rows written`,
      });
      continue;
    }

    // µ$ → USD, once, at the ledger seam; ingestCostEvent converts back at
    // usdToMicros. Bit-exact across the money range (pinned by the ledger's
    // property test over [1, 2^50]; the ~1 µ$ drift above ~2^51 is the
    // seam's recorded finding, five orders of magnitude past real spend);
    // an unusable figure (NaN here) lands in AC5's existing unpriced class —
    // persisted, counted, never dropped.
    const costMicroUsd =
      typeof line.costMicroUsd === "number" && Number.isFinite(line.costMicroUsd) ? line.costMicroUsd : Number.NaN;
    const event: CostWireEvent = {
      agentId: typeof line.agentId === "string" ? line.agentId : line.agentId == null ? "" : String(line.agentId),
      // The resident wire genuinely lacks a model; "" satisfies the CostEvent
      // type without inventing one. (The ledger's INSERT omits the model
      // column, so nothing observable hangs on the choice.)
      model: typeof line.model === "string" ? line.model : "",
      inputTokens: typeof line.inputTokens === "number" ? line.inputTokens : 0,
      outputTokens: typeof line.outputTokens === "number" ? line.outputTokens : 0,
      cacheReadTokens: typeof line.cacheReadTokens === "number" ? line.cacheReadTokens : undefined,
      cacheWriteTokens: typeof line.cacheWriteTokens === "number" ? line.cacheWriteTokens : undefined,
      costUsd: costMicroUsd / 1e6,
      turnCount: typeof line.turnCount === "number" ? line.turnCount : undefined,
      unpricedTurns: typeof line.unpricedTurns === "number" ? line.unpricedTurns : undefined,
      durationMs: 0,
      timestamp: typeof line.timestamp === "string" ? line.timestamp : "",
    };
    const started = Date.now();
    let result: IngestResult;
    try {
      result = ledger.ingestCostEvent(event, {
        runId,
        repoSlug,
        issueId,
        requestId,
        role,
        invocationSeq,
      });
    } catch (e) {
      // Ledger-level refusals (busy, key-hash-missing) are fail-closed exactly
      // like the box-hours ingest: surface them, write nothing, let teardown's
      // own error path report them.
      summary.rowsRefused += 1;
      const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
      emitRow(requestId, runId, repoSlug, issueId, {
        outcome: "refused",
        role,
        agentId: event.agentId,
        reason: `ingestCostEvent refused: ${err.code ?? "ledger-error"} — ${err.message ?? String(e)}`,
        // BRG-10: a typed ledger refusal (CostLedgerError) carries the literal
        // next command; the refusal row forwards it so the operator reading
        // the row does not have to re-derive it from the class.
        ...(err.remediation === undefined ? {} : { remediation: err.remediation }),
      });
      // Review round: the summary rides out BEFORE the rethrow — teardown's
      // error path reports the refusal, but only this summary carries the
      // partial counts, and an operator reading the log after the failure
      // must still be able to see how much evidence landed first.
      summary.reason = `ingest aborted by ledger refusal (${err.code ?? "ledger-error"}) — counts are PARTIAL: ${summary.rowsInserted} inserted, ${summary.rowsDuplicate} duplicate before the refusal`;
      emitSummary(requestId, runId, summary);
      throw e;
    }
    const ingestMs = Date.now() - started;
    if (result.inserted) summary.rowsInserted += 1;
    else summary.rowsDuplicate += 1;
    // BRG-8: count an unpriced row only when it LANDED — a duplicate re-run's
    // unpriced rows are already on disk, and counting them again inflated the
    // summary's unpriced figure on every healing pass.
    if (result.inserted && result.unpriced) summary.rowsUnpriced += 1;
    emitRow(requestId, runId, repoSlug, issueId, {
      outcome: result.inserted ? "ingested" : "duplicate",
      role,
      agentId: event.agentId,
      // BRG-6: a non-finite figure logs as null, never a 0 — 0 is a REAL
      // price (a genuinely free cached turn) and the log field must not
      // confuse the two.
      costMicroUsd: Number.isFinite(costMicroUsd) ? costMicroUsd : null,
      unpriced: result.unpriced ? 1 : 0,
      inserted: result.inserted,
      ingestMs,
    });
  }

  summary.outcome =
    summary.rowsInserted + summary.rowsDuplicate > 0
      ? "ingested"
      : summary.rowsRefused > 0
        ? "refused"
        : // Log present, zero cost_attribution lines: this run genuinely emitted no
          // token spend — a distinct, non-alarming outcome (AC4's no-token-spend).
          "no-token-spend";
  if (summary.outcome === "no-token-spend") {
    summary.reason = `harvested engine log at ${read.logPath} is readable and carries zero cost_attribution lines — nothing was emitted to harvest`;
  } else if (summary.rowsInserted === 0 && summary.rowsDuplicate > 0 && summary.rowsRefused === 0) {
    // BRG-8: a duplicate-only re-run used to report outcome "ingested" with
    // zero inserts and no reason — reading as if this pass priced the run.
    summary.reason = `${summary.rowsDuplicate} duplicate row(s): every cost_attribution line in this log already landed on a prior ingest (the deterministic event_id makes the re-run a no-op) — 0 new rows inserted`;
  } else if (summary.rowsRefused > 0) {
    // Mixed logs get an honest summary too: `ingested` with refused evidence
    // must not read as a clean bill (closeout review F4) — the reason names
    // the refusals whether or not priced rows also landed.
    summary.reason = `${summary.rowsRefused} line(s) refused (see the per-row refusals above) — ${
      summary.rowsInserted + summary.rowsDuplicate > 0
        ? "rows still landed in the ledger; evidence was lost for the refused ones"
        : `no token row landed for run ${runId}`
    }`;
  }
  emitSummary(requestId, runId, summary);
  return summary;
}

type RowFields = {
  outcome: TokenRowOutcome;
  role?: string;
  agentId?: string;
  /** `null` when the figure was non-finite (BRG-6) — never a 0, which is a
   * REAL price and must stay distinguishable from "no usable figure". */
  costMicroUsd?: number | null;
  unpriced?: number;
  inserted?: boolean;
  ingestMs?: number;
  reason?: string;
  /** The underlying refusal's literal next command, when it carries one (BRG-10). */
  remediation?: string;
};

function emitRow(requestId: string, runId: string, repoSlug: string, issueId: string, f: RowFields): void {
  log({
    requestId,
    operation: "cost-ledger.token-ingest",
    agentId: f.agentId ?? null,
    timestamp: new Date().toISOString(),
    duration: f.ingestMs ?? 0,
    // BRG-7: a refused outcome is an error-shaped line — "ok" on a refusal
    // read as a clean bill sitting next to the real ingest rows.
    status: f.outcome === "refused" ? "error" : "ok",
    runId,
    repoSlug,
    issueId,
    kind: "tokens",
    role: f.role ?? null,
    costMicroUsd: f.costMicroUsd ?? null,
    unpriced: f.unpriced ?? 0,
    inserted: f.inserted ?? false,
    durationMs: f.ingestMs ?? 0,
    ingest_ms: f.ingestMs ?? 0,
    outcome: f.outcome,
    ...(f.reason === undefined ? {} : { reason: f.reason }),
    ...(f.remediation === undefined ? {} : { remediation: f.remediation }),
  });
}

function emitSummary(requestId: string, runId: string, s: HarvestedIngestSummary): void {
  log({
    requestId,
    operation: "cost-ledger.token-ingest-summary",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: s.logReadMs,
    status: "ok",
    runId,
    logPath: s.logPath,
    rowsRead: s.rowsRead,
    rowsInserted: s.rowsInserted,
    rowsDuplicate: s.rowsDuplicate,
    rowsUnpriced: s.rowsUnpriced,
    rowsRefused: s.rowsRefused,
    log_read_ms: s.logReadMs,
    durationMs: s.logReadMs,
    outcome: s.outcome,
    ...(s.reason === undefined ? {} : { reason: s.reason }),
  });
}
