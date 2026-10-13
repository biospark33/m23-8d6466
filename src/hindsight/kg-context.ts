/**
 * Dispatch-time KG grounding (M1.2 AC1/AC2/AC3) — fan-out recall over the
 * repo's provision-time bank + `qds-collective`, `<kg_context>` assembly, and
 * `primeDispatchBrief` — the ONE dispatch-shaped seam (leaf-1.3.1 calls it
 * from ingestBriefJson; per-verb copies are the AC1 make-or-break negative
 * control: they pass the happy path and strand sibling dispatch callers).
 *
 * Degradation ladder (story AC2 — the directive fires on EMPTY-RESULT only):
 *   (a) env unconfigured → brief returned untouched (SAME reference), no row,
 *       no log line — absent, not zero;
 *   (b) any recall/bank-resolution failure → proceed-unprimed, row
 *       {primed:false, directive:"none"} — NEVER the empty directive (mapping
 *       "KG unreachable" onto "KG says nothing" is the AC2 negative control);
 *   (c) recall ok, zero observations → EMPTY_KG_DIRECTIVE only;
 *   (d) results → full block, citation-floored, ranked, ≤ KG_CONTEXT_MAX_CHARS.
 * (b)/(c)/(d) write the side-channel row + `kg-recall` line; (a) writes
 * NEITHER. The seam never throws and never changes dispatch's exit codes.
 *
 * Budgets (story "Guards/limits"): KG_CONTEXT_MAX_CHARS is the assembly
 * ceiling at whole-observation granularity (an observation that does not fit
 * is dropped, never split); KG_RECALL_LIMIT per bank; the wall budget is the
 * client's own RECALL timeout — one attempt per bank, ZERO retries
 * (zeropoint's RECALL_MAX_ATTEMPTS=3 deliberately not copied: dispatch is
 * latency-budgeted).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { kgContextSanitize } from "../fleet/brief-schema.ts";
import { isValidUuidV4 } from "../phase-engine/issue-correlation.ts";
import { atomicReplaceFile } from "../providers/fs-atomic.ts";
import { log } from "../lib/log.ts";
import {
  COLLECTIVE_BANK_ID,
  extractExistingBankIds,
  resolveProvisionedRepoBankId,
} from "./bank-provisioner.ts";
import { HindsightClient } from "./client.ts";
import { resolveBankId, type RecallResponse } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Grammar + guards (copied symbols per story "Zeropoint grammar")
// ---------------------------------------------------------------------------

/** Half of the steering prompt ceiling (16_000) — the brief keeps prose headroom. */
export const KG_CONTEXT_MAX_CHARS = 8_000;

/** Per-bank recall k — the client default, named here so AC1 stays greppable. */
export const KG_RECALL_LIMIT = 5;

/** Default side-channel dir (relative to cwd, like judgment's provenance dir). */
export const DEFAULT_RECALL_DIR = "_bmad-output/memory/recall";

/**
 * Fires on EMPTY-RESULT only — a timed-out/errored fan-out must never emit
 * this (AC2's negative control). Single static string: no interpolation of
 * run internals, so the directive text is byte-stable across runs.
 */
export const EMPTY_KG_DIRECTIVE =
  "The factory memory banks hold no observations relevant to this repo or task; nothing in this dispatch is memory-grounded. Do not present generalizations, conventions, or prior-run knowledge as grounded — they are not in the banks.";

export const CITATION_INSTRUCTION =
  "When you make a factual claim grounded in a <kg_context> observation, append the citation token [cite:OBSERVATION_ID] immediately after the claim, using the observation's id exactly as it appears in <kg_context>. Use one token per grounded claim. Do not cite general knowledge or information not present in <kg_context>. The OBSERVATION_ID charset is letters, digits, underscore, and hyphen ([A-Za-z0-9_-]+); there are no spaces inside the brackets.";

/** Citable ids are exactly the charset CITATION_INSTRUCTION promises the box. */
const CITABLE_ID = /^[A-Za-z0-9_-]+$/;

export type KgDirective = "kg_context" | "empty" | "none";

/** One recalled fact, already narrowed to what the citation contract needs. */
export interface KgObservation {
  /** Server-minted fact id — the `[cite:<id>]` token target (distinct from documentId). */
  id: string;
  content: string;
  score: number;
  /** Document identity; null when retained without an explicit id (AC5). */
  documentId: string | null;
}

/** Minimal structural client — the real HindsightClient satisfies it; tests inject plain objects. */
export interface RecallClient {
  recall(bankId: string, query: string, limit?: number): Promise<RecallResponse>;
  listBanks(): Promise<unknown>;
}

export interface PrimeDispatchBriefDeps {
  /** Mock-mode client override (tests; never a second production client). */
  client?: RecallClient;
  /** Side-channel dir override (tests use a tmpdir; never real _bmad-output). */
  recallDir?: string;
  /**
   * The caller's already-resolved correlation id (submit's `--request-id` —
   * the id the run will carry, which the brief itself does not name). Wins
   * over the brief's own field, mirroring dispatch's deps-requestId rule
   * (INV-4-bis). The SAME UUID v4 gate applies to it as to the brief field —
   * an invalid value is treated as NO id (no row, no line), never a throw:
   * the seam's never-throw contract outranks caller input. Production callers
   * validate upstream (submit refuses a non-UUID `--request-id` before the
   * brief is read), so this gate firing is a defensive no-op there.
   */
  requestId?: string;
}

/** Side-channel row — EXACTLY these seven keys (M1.3 parses the shape verbatim). */
export interface RecallRow {
  runId: string;
  primed: boolean;
  directive: KgDirective;
  banks: string[];
  recalledDocumentIds: string[];
  chars: number;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Fan-out recall — exactly {<provision-time repo bank>, qds-collective}
// ---------------------------------------------------------------------------

export interface RecallFanOutResult {
  observations: KgObservation[];
  /** Fan-out set attempted (deduped, repo bank first). */
  banks: string[];
  /** True when at least one bank's recall SUCCEEDED — even with zero results. */
  anyBankOk: boolean;
  /** Per-bank wall ms, attempted banks only (failed attempts included). */
  bankMs: Record<string, number>;
  /** Whole fan-out wall ms. */
  recallMs: number;
}

/**
 * One attempt per bank, in parallel, zero retries. A failed bank contributes
 * nothing — no observations, no directive change — but a bank that SUCCEEDED
 * keeps ladder (c) alive even when it returned zero results: only ALL-bank
 * failure is ladder (b). Partial failure therefore degrades content, never
 * the ladder.
 */
export async function recallFanOut(
  client: RecallClient,
  repoBankId: string,
  query: string,
): Promise<RecallFanOutResult> {
  // The set is EXACTLY these two banks (story "Fan-out set" — `-dev-meta` is
  // deliberately absent); deduped for a caller that hands us the collective.
  const banks = [...new Set([repoBankId, COLLECTIVE_BANK_ID])];
  const start = Date.now();
  const per = await Promise.all(
    banks.map(async (bankId) => {
      const t0 = Date.now();
      try {
        const res = await client.recall(bankId, query, KG_RECALL_LIMIT);
        return { bankId, ms: Date.now() - t0, ok: true as const, results: res.results };
      } catch {
        // Per-bank failure contributes NOTHING — swallowed by design, not by
        // accident: the client already logged the attempt (request() finally).
        return { bankId, ms: Date.now() - t0, ok: false as const, results: [] };
      }
    }),
  );
  // Dedup by fact id (memoryId), first-seen wins — `banks` is repo bank
  // before qds-collective and Promise.all preserves that order, so a fact
  // fanned into both banks surfaces from the repo bank's copy.
  const seen = new Set<string>();
  const observations: KgObservation[] = [];
  for (const p of per) {
    if (!p.ok) continue;
    for (const r of p.results) {
      // Citation floor: an id outside the promised charset (or an absent
      // one → "") cannot back a [cite:] token — drop the observation
      // whole rather than ship an uncitable line.
      if (!CITABLE_ID.test(r.memoryId) || seen.has(r.memoryId)) continue;
      seen.add(r.memoryId);
      observations.push({
        id: r.memoryId,
        content: r.content,
        score: r.score,
        documentId: r.documentId,
      });
    }
  }
  return {
    observations,
    banks,
    anyBankOk: per.some((p) => p.ok),
    bankMs: Object.fromEntries(per.map((p) => [p.bankId, p.ms])),
    recallMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Assembly — ranked, citation-floored, whole-observation ceiling
// ---------------------------------------------------------------------------

/**
 * Rank by score desc. Array#sort is stable (ES2019+), so equal scores keep
 * fan-out (original) order — the deterministic tie-break the story names.
 * Non-finite scores (NaN/±Infinity) collapse to 0: a NaN would make the
 * comparator return NaN (sort order undefined) and ±Infinity would hijack
 * rank order outright.
 */
const byScoreDesc = (a: KgObservation, b: KgObservation): number =>
  (Number.isFinite(b.score) ? b.score : 0) - (Number.isFinite(a.score) ? a.score : 0);

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return escXml(s).replace(/"/g, "&quot;");
}

function observationXml(o: KgObservation): string {
  // Recalled text is substrate data, so it can carry code points the brief
  // schema refuses (\r, \v, \f, DEL, C1, U+2028/2029) — the strip happens
  // HERE, before wrapping/ceiling, so a poisoned bank degrades the block's
  // text instead of killing dispatch with an exit-2 at schema refine time.
  const content = kgContextSanitize(o.content);
  // documentId rides the element only when the substrate surfaced one (AC5:
  // null-tolerant — an item retained without an explicit id has none to show).
  // It is substrate data too and gets the SAME strip — an unsanitized control
  // char in the attribute would re-poison the block past the schema.
  const docId = o.documentId !== null ? kgContextSanitize(o.documentId) : null;
  const doc = docId !== null ? ` documentId="${escAttr(docId)}"` : "";
  return `<observation id="${escAttr(o.id)}"${doc}>${escXml(content)}</observation>`;
}

const KG_HEAD = "<kg_context>\n";
const KG_TAIL = `\n</kg_context>\n${CITATION_INSTRUCTION}`;

/**
 * The ranked observations that fit the ceiling, shared by the block and the
 * row so `recalledDocumentIds` advertises exactly what the block includes.
 * Whole-observation granularity: an observation that does not fit is dropped
 * whole, never split (a split citation grounds half a fact). An EMPTY
 * selection means ladder (c) "empty" — never a zero-observation block.
 */
function includedWithinCeiling(observations: KgObservation[]): KgObservation[] {
  const ranked = [...observations].sort(byScoreDesc);
  let used = KG_HEAD.length + KG_TAIL.length;
  const included: KgObservation[] = [];
  for (const o of ranked) {
    const cost = observationXml(o).length + (included.length > 0 ? 1 : 0);
    if (used + cost > KG_CONTEXT_MAX_CHARS) continue;
    included.push(o);
    used += cost;
  }
  return included;
}

/**
 * Assemble the appendix: `<kg_context>` block (one observation element per
 * fact, id attribute for `[cite:<id>]`, documentId when non-null) followed by
 * the CITATION_INSTRUCTION line. Content is escaped ONLY for XML-structural
 * safety (<>&) — this is host-side assembly of host-recalled content, escaped
 * to keep the block well-formed, not sanitized for trust.
 *
 * The ceiling budget covers the WHOLE assembled block (wrapper + instruction
 * included) so the brief schema's own cap can never trip downstream — the
 * schema ceiling stays a fail-loud backstop, never a routine path.
 */
export function buildKgContextXml(observations: KgObservation[]): string {
  const lines = includedWithinCeiling(observations).map(observationXml);
  return KG_HEAD + lines.join("\n") + KG_TAIL;
}

// ---------------------------------------------------------------------------
// primeDispatchBrief — the ONE dispatch-shaped seam
// ---------------------------------------------------------------------------

function memoryEnvConfigured(): boolean {
  // Empty-string env values count as unconfigured (mirror client.ts's coercion).
  return Boolean(process.env.HINDSIGHT_BASE_URL) &&
    Boolean(process.env.HINDSIGHT_BEARER_TOKEN || process.env.HINDSIGHT_API_KEY);
}

function briefStr(brief: object, key: string): string | undefined {
  const v = (brief as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The correlation id becomes a filename segment AND the row's join key —
 * so the gate here must be EXACTLY the resolver's gate (resolveBriefRequestId /
 * isValidUuidV4): an id this seam would write a row for is an id dispatch
 * keeps, and an id dispatch drops (mints past) produces NO row at all. The
 * earlier SAFE_RUN_ID charset gate was looser than the resolver's, which let
 * a safe-but-non-UUID brief id leave an orphan row — a counted cycle with no
 * joinable receipt (the case Amendment R7 recorded; this gate closes it).
 * A UUID v4 is inherently filename-safe, so the traversal/dot-segment
 * refusals ride along for free. An invalid id is treated as NO id (no row,
 * no line), exactly the missing-requestId posture. */
function usableCorrelation(raw: string | undefined): string | undefined {
  return raw !== undefined && isValidUuidV4(raw) ? raw : undefined;
}

function writeRecallRow(dir: string | undefined, runId: string | undefined, row: RecallRow): void {
  // No (usable) runId → no filename. Observability is skipped; priming is
  // unaffected.
  if (runId === undefined) return;
  try {
    const base = dir ?? DEFAULT_RECALL_DIR;
    mkdirSync(base, { recursive: true });
    // Temp + rename (the fs-atomic posture): a crash mid-write must leave the
    // prior row complete, never a truncated one. A replayed requestId reuses
    // the filename — documented last-wins.
    atomicReplaceFile(join(base, `${runId}.json`), `${JSON.stringify(row)}\n`);
  } catch {
    // The side channel must never break dispatch — a full disk degrades to a
    // missing row, which M1.3 reads as an uncounted cycle, not a crash.
  }
}

/**
 * Prime a dispatch brief with the `<kg_context>` appendix, env-gated.
 *
 * Returns the SAME reference untouched on ladder (a) and (b) — v5 byte-identical
 * — and a SHALLOW copy carrying `kgContext` on (c)/(d). Never throws: any
 * surprise (listBanks failure, unresolvable bank id, missing brief fields) is
 * ladder (b), row + line still firing so M1.3 counts every M1 cycle.
 */
export async function primeDispatchBrief<T extends object>(
  briefJson: T,
  deps: PrimeDispatchBriefDeps = {},
): Promise<T> {
  // Ladder (a): the env gate is FIRST and unconditional — no attempt, no row,
  // no line, same object reference.
  if (!memoryEnvConfigured()) return briefJson;
  const startedAt = Date.now();
  // Validated ONCE, at the derivation point: both the row and the log line
  // below then treat an invalid id exactly like a missing one (F1 — the raw
  // pre-schema brief must never reach a filename or the log's runId field).
  // The caller's resolved id (submit's --request-id) wins over the brief's
  // own field — the same deps-win rule dispatch applies (INV-4-bis) — and
  // rides the SAME gate, so every written row joins to the id the run
  // actually carries.
  const runId = usableCorrelation(deps.requestId ?? briefStr(briefJson, "requestId"));
  // banks:[] on a PRE-RECALL failure is truthful — zero banks were attempted
  // — and the error detail rides the log line, not the row (D2).
  let attempted: string[] = [];
  let bankMs: Record<string, number> = {};
  let recallMs: number | undefined;

  // Single emit point so the row and the log line stay unconditionally paired
  // (same conditionality) and the untouched-reference contract can't drift.
  const emitAndReturn = (
    primed: boolean,
    directive: KgDirective,
    kgContext: string | undefined,
    docIds: string[],
  ): T => {
    const latencyMs = Date.now() - startedAt;
    const chars = kgContext?.length ?? 0;
    writeRecallRow(deps.recallDir, runId, {
      runId: runId ?? "",
      primed,
      directive,
      banks: attempted,
      recalledDocumentIds: docIds,
      chars,
      latencyMs,
    });
    if (runId !== undefined) {
      // Never-throw is the seam's contract, independent of the sink's
      // behaviour — the row above is already guarded the same way.
      try {
        log({
          requestId: runId,
          operation: "kg-recall",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: latencyMs,
          status: primed ? "ok" : "error",
          runId,
          directive,
          banks: attempted,
          chars,
          ...(recallMs !== undefined ? { recallMs, bankMs } : {}),
        });
      } catch {
        // A broken sink degrades to a missing line; priming still returns.
      }
    }
    return kgContext === undefined ? briefJson : ({ ...briefJson, kgContext } as T);
  };

  try {
    const client = deps.client ?? new HindsightClient();
    const repoSlug = briefStr(briefJson, "repoSlug");
    if (repoSlug === undefined) return emitAndReturn(false, "none", undefined, []);
    // resolveBankId is the RAW normalizer: it feeds ONLY the read-side family
    // resolver, which re-derives the PROVISION-TIME id against the LIVE bank
    // list. Nothing persists the provision-time id, so the provisioned repo
    // bank is identified by its family signature — candidate `c` with its
    // `-dev-meta` sibling, the pair only the provisioner creates. Create-side
    // resolvers (resolveRepoBankId) return ids NOT in the list by design; AC1
    // pins the provision-time id, and the raw form is never used as the bank
    // id itself (a collision would make it a foreign bank).
    const existing = extractExistingBankIds(await client.listBanks());
    const repoBankId = resolveProvisionedRepoBankId(resolveBankId(repoSlug), existing);
    // No provisioned family → ladder (b) proceed-unprimed.
    if (repoBankId === null) return emitAndReturn(false, "none", undefined, []);
    // BriefSchema types issueId as a NUMBER, so a string probe never engaged
    // for it — numeric-issue dispatches were recalling on repoSlug alone.
    const rawIssueId = (briefJson as Record<string, unknown>).issueId;
    const workId = briefStr(briefJson, "workId") ??
      (typeof rawIssueId === "number" ? String(rawIssueId) : undefined);
    // Short deterministic query — same brief always recalls the same thing.
    const query = `${repoSlug} ${workId ?? ""}`.trim();
    const fan = await recallFanOut(client, repoBankId, query);
    attempted = fan.banks;
    bankMs = fan.bankMs;
    recallMs = fan.recallMs;
    // Directive vocab is exact. Only ALL-bank failure is ladder (b); a bank
    // that succeeded-but-empty keeps (c) alive.
    if (fan.observations.length === 0 && !fan.anyBankOk) {
      return emitAndReturn(false, "none", undefined, []);
    }
    // Ceiling selection happens BEFORE the ladder decision: observations that
    // don't fit are dropped whole, and if NOTHING fits the caller gets ladder
    // (c) "empty" — never a directive:"kg_context" block with zero
    // observations.
    const included = includedWithinCeiling(fan.observations);
    if (included.length === 0) {
      return emitAndReturn(true, "empty", EMPTY_KG_DIRECTIVE, []);
    }
    const kgContext = buildKgContextXml(included);
    // recalledDocumentIds — the INCLUDED observations only, already in RANK
    // order (the row stops advertising documents the ceiling dropped).
    const recalledDocumentIds = included
      .map((o) => o.documentId)
      .filter((d): d is string => d !== null);
    return emitAndReturn(true, "kg_context", kgContext, recalledDocumentIds);
  } catch {
    // Contract: NEVER throw out of the seam. Recall failures are swallowed per
    // bank above; what reaches here is bank resolution/shape surprises — all
    // ladder (b): proceed-unprimed, observability still fires.
    return emitAndReturn(false, "none", undefined, []);
  }
}
