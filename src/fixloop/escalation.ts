/**
 * DF6.1b — the escalation core (`src/fixloop/escalation.ts`): the per-attempt
 * terminal-outcome classification union, the attempt ladder that DERIVES each
 * ledger entry's state from its own record (never persisted per attempt — the
 * append-pinning and the gate's own writes guarantee every input exists), the
 * two ceilings, the `fixOutcome` codec, and the human-escalation comment.
 *
 * The budget is TWO ceilings defined separately (AC2): the CHARGED budget is
 * two — only an attempt that reached CI and failed there charges it — and the
 * UNCHARGED ceiling is three per PR, because "uncharged" must not mean
 * "unlimited": every terminal state still costs a box, a capped key and model
 * spend. `dispatch-refused` and `scope-requires-privilege` are deterministic —
 * recorded at most once per PR, their first-occurrence escalation is their own
 * bound, they consume neither ceiling. `out-of-scope-diff` is capped at 1 —
 * a second identical out-of-scope diff is a signal about the comments.
 *
 * The escalation comment is this half's only egress to the public internet, so
 * every prose field passes through the PATTERN redactor (`redactSecrets` from
 * `src/providers/step-log.ts` — never cli-anything's known-value redactor,
 * which cannot see a credential the host has never held, and the host's own
 * GitHub token is deliberately absent from `process.env`).
 *
 * No prose from this module is ever persisted into a run record (INV-7): the
 * record keeps the classification and the runIds only.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { parseFixContext, ATTEMPT_SHA_PLACEHOLDER } from "./feedback-run.ts";
import { RunRecordStore, type RunRecord } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import type { GitHubApi } from "../pr/github.ts";

// ─── classifications ─────────────────────────────────────────────────────────

/**
 * The terminal-outcome classification union. Written per attempt as
 * `extensions.fixLoop.fixOutcomeClass` (the registered `string` field) and
 * derived for entries whose record carries no written class (the approval
 * `state` ladder, `orphaned`).
 */
export type EscalationClass =
  | "green"
  | "ci-red"
  | "ci-verdict-unavailable"
  | "transient"
  | "lead_failure"
  | "approval-timed-out"
  | "overflow"
  | "orphaned"
  | "dispatch-refused"
  | "out-of-scope-diff"
  | "scope-requires-privilege"
  | "approval-rejected"
  | "bot-response-to-fix"
  | "fix-scope-missing";

const ESCALATION_CLASSES: readonly EscalationClass[] = [
  "green", "ci-red", "ci-verdict-unavailable", "transient", "lead_failure",
  "approval-timed-out", "overflow", "orphaned", "dispatch-refused",
  "out-of-scope-diff", "scope-requires-privilege", "approval-rejected",
  "bot-response-to-fix", "fix-scope-missing",
];

/** Only an attempt that reached CI and failed there charges the budget (AC2). */
export const CHARGED_CLASSES: ReadonlySet<EscalationClass> = new Set(["ci-red", "ci-verdict-unavailable"]);

/**
 * Uncharged-terminal classes: resource-bearing (a box, a key and model spend
 * are sunk) but charging nothing — each counts toward the uncharged ceiling of
 * 3 and never the charged budget.
 */
export const UNCHARGED_TERMINAL_CLASSES: ReadonlySet<EscalationClass> = new Set([
  "transient", "lead_failure", "approval-timed-out", "overflow",
]);

/**
 * Deterministic refusals: retry can never succeed, so they are recorded at
 * most once per PR and their first-occurrence escalation is their own bound.
 */
export const ONCE_PER_PR_CLASSES: ReadonlySet<EscalationClass> = new Set([
  "dispatch-refused", "scope-requires-privilege",
]);

/** The loop-stop classifications a single occurrence makes permanent. */
export const LOOP_STOP_CLASSES: ReadonlySet<EscalationClass> = new Set([
  "approval-rejected", "bot-response-to-fix",
]);

/** Parse a record's `fixOutcomeClass` value into the union, or undefined. */
export function parseFixOutcomeClass(v: unknown): EscalationClass | undefined {
  return typeof v === "string" && (ESCALATION_CLASSES as readonly string[]).includes(v) ? (v as EscalationClass) : undefined;
}

// ─── ceilings ────────────────────────────────────────────────────────────────

export const MAX_CHARGED_ATTEMPTS = 2;
export const MAX_UNCHARGED_ATTEMPTS = 3;
export const MAX_OUT_OF_SCOPE_DIFF = 1;

/** The aggregate the routing reads, derived across the whole ledger. */
export interface BudgetCounts {
  charged: number;
  uncharged: number;
  outOfScopeDiff: number;
  dispatchRefused: boolean;
  scopePrivilege: boolean;
  approvalRejected: boolean;
  /** Every recorded classification — the ceiling escalation lists them all. */
  classifications: EscalationClass[];
}

/**
 * Every ceiling the current counts violate. Empty = the loop may dispatch its
 * next attempt; non-empty = the invocation escalates without dispatching.
 */
export function evaluateCeilings(c: BudgetCounts): string[] {
  const out: string[] = [];
  if (c.charged >= MAX_CHARGED_ATTEMPTS) out.push("charged");
  if (c.uncharged >= MAX_UNCHARGED_ATTEMPTS) out.push("uncharged");
  if (c.outOfScopeDiff >= MAX_OUT_OF_SCOPE_DIFF) out.push("out-of-scope-diff");
  if (c.dispatchRefused) out.push("dispatch-refused");
  if (c.scopePrivilege) out.push("scope-requires-privilege");
  if (c.approvalRejected) out.push("approval-rejected");
  return out;
}

// ─── the attempt ladder ──────────────────────────────────────────────────────

export interface AttemptEntry {
  runId: string;
  /** terminal · continuation · poll-recovery · orphaned (AC2's four states). */
  arm: "terminal" | "continuation" | "poll-recovery" | "orphaned";
  classification?: EscalationClass;
  /** True when the classification came from a WRITTEN `fixOutcomeClass` field — the escalation for it was already posted. */
  written: boolean;
  /** The approval extension's `state` when arm 2 decided, so routers need no second record read. */
  approvalState?: string;
}

function classificationCounts(entries: readonly AttemptEntry[]): BudgetCounts {
  const counts: BudgetCounts = {
    charged: 0,
    uncharged: 0,
    outOfScopeDiff: 0,
    dispatchRefused: false,
    scopePrivilege: false,
    approvalRejected: false,
    classifications: [],
  };
  const seen = new Set<EscalationClass>();
  for (const e of entries) {
    const c = e.classification;
    if (c === undefined) continue;
    if (!seen.has(c)) {
      seen.add(c);
      counts.classifications.push(c);
    }
    if (CHARGED_CLASSES.has(c)) counts.charged++;
    else if (UNCHARGED_TERMINAL_CLASSES.has(c)) counts.uncharged++;
    else if (c === "orphaned") counts.uncharged++;
    else if (c === "out-of-scope-diff") counts.outOfScopeDiff++;
    else if (c === "dispatch-refused") counts.dispatchRefused = true;
    else if (c === "scope-requires-privilege") counts.scopePrivilege = true;
    else if (c === "approval-rejected") counts.approvalRejected = true;
  }
  return counts;
}

/**
 * DERIVATION, not persistence: each ledger entry's lifecycle state is read off
 * that fix run's own record in arm order — the written terminal outcome first,
 * then the approval extension's `state` field, then `fixContext` — and only
 * one of the four states counts as orphaned (a bare approval extension is NOT
 * awaiting-approval; `awaiting-approval` is the loop's normal resting state
 * and consumes neither ceiling).
 */
export function deriveAttemptLadder(readRecord: (id: string) => RunRecord, ledgerIds: readonly string[]): { entries: AttemptEntry[]; counts: BudgetCounts } {
  const entries: AttemptEntry[] = ledgerIds.map((runId): AttemptEntry => {
    let rec: RunRecord;
    try {
      rec = readRecord(runId);
    } catch {
      // A dangling ledger id (reaped/damaged record) is a dead attempt.
      return { runId, arm: "orphaned", classification: "orphaned", written: false };
    }
    const loop = rec.extensions?.fixLoop as Record<string, unknown> | undefined;

    // Arm 1 — the written terminal outcome; the CLASSIFICATION decides which
    // budget it consumes, never the bare presence of an outcome.
    const written = parseFixOutcomeClass(loop?.fixOutcomeClass);
    if (written !== undefined) return { runId, arm: "terminal", classification: written, written: true };

    // Arm 2 — the approval extension's `state` field decides; the bare
    // presence of the extension is not any one of these states.
    const state = (rec.extensions?.approval as { state?: unknown } | undefined)?.state;
    const approvalState = typeof state === "string" ? state : undefined;
    if (state === "awaiting-approval" || state === "pausing") return { runId, arm: "continuation", written: false, approvalState };
    if (state === "timed-out") return { runId, arm: "terminal", classification: "approval-timed-out", written: false, approvalState };
    if (state === "rejected") return { runId, arm: "terminal", classification: "approval-rejected", written: false, approvalState };
    if (state === "approved") {
      return hasRealAttemptSha(loop?.fixContext)
        ? { runId, arm: "poll-recovery", written: false, approvalState }
        : { runId, arm: "continuation", written: false, approvalState };
    }

    // Arm 3 — a fixContext (the push happened; the approval state should have
    // been present but the push is only ever approved-gated) is poll recovery.
    if (typeof loop?.fixContext === "string" && hasRealAttemptSha(loop.fixContext)) {
      return { runId, arm: "poll-recovery", written: false };
    }

    // None of the three: a dead attempt that never reached CI.
    return { runId, arm: "orphaned", classification: "orphaned", written: false };
  });
  return { entries, counts: classificationCounts(entries) };
}

/** A fixContext string carrying a REAL (non-placeholder) attemptSha — i.e. a push happened. */
export function fixContextHasRealSha(encoded: unknown): boolean {
  return hasRealAttemptSha(encoded);
}

function hasRealAttemptSha(encoded: unknown): boolean {
  if (typeof encoded !== "string") return false;
  try {
    return parseFixContext(encoded).attemptSha !== ATTEMPT_SHA_PLACEHOLDER;
  } catch {
    return false;
  }
}

// ─── the fixOutcome codec (INV-7) ────────────────────────────────────────────

export interface FixOutcomePayload {
  schemaVersion: 1;
  prNumber: number;
  /** The attempts that reached CI — charged failures plus the green one. */
  attempts: number;
  outcome: "green" | "escalated";
  /** The escalation's classification; absent on green. */
  classification?: EscalationClass;
  /** The parent's own runId followed by every fix runId in attempt order. */
  runIds: string[];
}

const RUN_ID_RE = /^[a-z0-9-]{6,64}$/;

const FixOutcomeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    prNumber: z.number().int().positive(),
    attempts: z.number().int().nonnegative(),
    outcome: z.enum(["green", "escalated"]),
    classification: z.enum(ESCALATION_CLASSES as unknown as [EscalationClass, ...EscalationClass[]]).optional(),
    runIds: z.array(z.string().regex(RUN_ID_RE)).min(1),
  })
  .strict();

/**
 * JSON-encode into the already-registered `"string"` field (no object kind —
 * an implementation assigning an object fails with `schema-rejected: … must be
 * a string` at the store). Write-once at the LOOP's terminal: green, or the
 * escalation that stops the loop.
 */
export function encodeFixOutcome(payload: FixOutcomePayload): string {
  const p = FixOutcomeSchema.parse(payload);
  return JSON.stringify({
    schemaVersion: p.schemaVersion,
    prNumber: p.prNumber,
    attempts: p.attempts,
    outcome: p.outcome,
    ...(p.classification === undefined ? {} : { classification: p.classification as EscalationClass }),
    runIds: p.runIds,
  });
}

/** This story's own fail-closed parser for the encoded field. */
export function parseFixOutcome(encoded: unknown): FixOutcomePayload {
  if (typeof encoded !== "string") {
    throw new Error("fixOutcome is not a JSON-encoded string (there is no object kind — encodeFixOutcome writes the string)");
  }
  const parsed = FixOutcomeSchema.safeParse(JSON.parse(encoded));
  if (!parsed.success) {
    throw new Error(`fixOutcome failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/**
 * INV-7's validate-only route for fixOutcome — the SAME validation the write
 * will apply, through a real store on a scratch dir, BEFORE the escalation
 * comment is posted. Posting a comment is this half's one irreversible act, so
 * a record write cannot refuse after a human has already been paged.
 */
export function preflightFixOutcomeWrite(encoded: string): void {
  parseFixOutcome(encoded);
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "qds-fixout-"));
  try {
    const store = new RunRecordStore({ dir });
    store.create("qds-fixout-preflight");
    store.set("qds-fixout-preflight", { extensions: { fixLoop: { fixOutcome: encoded } } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── the escalation comment ──────────────────────────────────────────────────

export interface EscalationDiagnostic {
  /** The fix run's own terminal error text (its trace rows stay durable). */
  errorLog: string;
  /** The diff the attempt landed — name-status paths. */
  diffAttempted: string[];
  /** The CI failure messages (check names + states) the verdict produced. */
  ciFailureMessages: string[];
  /** Every contributing runId, attempt order. */
  runIds: string[];
}

/**
 * Build the human handoff comment. Every prose field passes through the
 * PATTERN redactor HERE — before the body exists — so nothing a caller forgets
 * to redact can reach the public PR.
 */
export function buildEscalationComment(o: {
  prNumber: number;
  classification: string;
  charged: boolean;
  diagnostics: EscalationDiagnostic;
  /** Extra framing (e.g. which ceiling was exhausted). */
  note?: string;
}): string {
  const d = o.diagnostics;
  const lines: string[] = [];
  lines.push(`## Fix loop stopped — human escalation needed (PR #${o.prNumber})`);
  lines.push("");
  lines.push(`**Classification:** \`${redactSecrets(o.classification)}\` · **charged the attempt budget:** ${o.charged ? "yes" : "no"}`);
  if (o.note !== undefined) lines.push(`**Note:** ${redactSecrets(o.note)}`);
  lines.push("");
  lines.push("### Error log");
  lines.push("```");
  lines.push(redactSecrets(d.errorLog).slice(0, 4000));
  lines.push("```");
  lines.push("");
  lines.push("### Diff attempted");
  if (d.diffAttempted.length === 0) lines.push("_(no diff reached the push)_");
  else for (const p of d.diffAttempted) lines.push(`- \`${redactSecrets(p)}\``);
  lines.push("");
  lines.push("### CI failure messages");
  if (d.ciFailureMessages.length === 0) lines.push("_(CI never ran for this attempt)_");
  else for (const m of d.ciFailureMessages) lines.push(`- ${redactSecrets(m)}`);
  lines.push("");
  lines.push("### Contributing runs");
  for (const id of d.runIds) lines.push(`- \`${id}\``);
  lines.push("");
  lines.push("_Posted by the fix loop (DF6.1b). The loop dispatches nothing further on this PR until you act._");
  return lines.join("\n");
}

/**
 * Post the handoff on the PR. Uses the existing `commentIssue` seam — a PR is
 * an issue — so no new GitHub surface is introduced. A failed post propagates;
 * the caller maps it to a non-zero exit and names it in the diagnostic, and
 * the fixOutcome was already validated and written (INV-7's ordering).
 */
export async function postEscalationComment(o: {
  github: Pick<GitHubApi, "commentIssue">;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  token: string;
}): Promise<void> {
  await o.github.commentIssue({ owner: o.owner, repo: o.repo, issueNumber: o.prNumber, body: o.body, token: o.token });
}
