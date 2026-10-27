/**
 * Z3 — the cross-repo live exit round's PLAN: what one scheduled protocol fire
 * runs, what it may cost, and whether the operator said GO.
 *
 * Round shape (story Technical Notes, named not implied): one fork schedule
 * fire of the `z3_exit_round` protocol; one QA hunter-pack fleet run per
 * `QA_LENS`, then ONE operator-chosen benign code-affecting run whose dispatch
 * recall proves priming and whose chain parks at the approval gate — all
 * sequential (the fork chains the steps; nothing here fans out).
 *
 * `Z3_MAX_FLEET_RUNS = MAX_QA_LEGS + 1` is DERIVED from A2's constant
 * (DD-28.26(7)) — never restated. Worst-case spend is Σ per-run `groupCapUsd`
 * and is printed BEFORE the GO gate reads anything (charter §5.6), so even a
 * refused fire shows the operator the number they were asked to approve.
 *
 * The step ids are the fork counterpart's CONTRACT (protocol-z3-exit-round.ts),
 * chained by nextStepId: `qa-leg-<lens>` → `qa-observe-<lens>` per lens, then
 * `z3-code-run` → `z3-code-observe` → `z3-branch` → `z3-complete` | `z3-unmatched`
 * (cases approved / completed / unmatched; only `approved` is green). The legs and
 * the code run are external_job; the observes are factory_observe
 * (`fromStepOutput` = the target step; no runId, no box, no key). One `<stamp>`
 * spans the round's workIds: `w:qa-<stamp>-<lens>` and `w:z3-<stamp>-code`.
 * The fork's worst case is QA_LENS.length × qaGroupCapUsd + codeGroupCapUsd —
 * exactly Σ per-run groupCapUsd over `composeRound`'s default runs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { MAX_QA_LEGS, QA_LENS } from "../../src/qa/findings.ts";

/** The 11 legs, in the story's Observability Contract order — each writes its own JSON. */
export const Z3_LEGS = [
  "trigger",
  "kill-and-provision",
  "box-forensics",
  "qa-run-observe",
  "findings-retain",
  "priming-recall",
  "observe-read-only",
  "approval-park",
  "approve",
  "branch-and-complete",
  "crash-window-redrive",
] as const;
export type Z3Leg = (typeof Z3_LEGS)[number];

/** The `finally`'s own record (revoke-verify receipts + box destroy) — beside the 11, never one of them. */
export const Z3_CLEANUP_LEG = "cleanup";
/** filename → sha256 of every leg file the round wrote (the committed, re-auditable registry). */
export const Z3_MANIFEST_LEG = "round-manifest";
export type Z3EvidenceLeg = Z3Leg | typeof Z3_CLEANUP_LEG | typeof Z3_MANIFEST_LEG;

/** QA legs + the one code-affecting run (DD-28.26(7)). */
export const Z3_MAX_FLEET_RUNS = MAX_QA_LEGS + 1;

/** The story-pinned evidence dir (repo-root relative). */
export const Z3_EVIDENCE_DIR = "_bmad-output/evidence/v6-z3";
export const Z3_OPERATOR_GO_FILE = `${Z3_EVIDENCE_DIR}/operator-GO.json`;

/**
 * Open upstream seam gaps that make a live round red BY CONSTRUCTION. While
 * this list is non-empty the live test refuses by name BEFORE the GO gate,
 * arming, or any spend; unblocking is the code change that deletes the entry.
 */
export const Z3_UPSTREAM_BLOCKERS: ReadonlyArray<{ issue: string; url: string; what: string }> = [
  // Emptied 2026-10-26: #467 unblocked — the exe.dev image is re-published with
  // the sidecar writer in-box (publish run 40326654015 green: publish/attest/
  // attested all success), the pin adopted in the same-commit ritual (#474
  // TOFU ARGs, #476 driver REF sha256:1c8455a0… / buildId c8dd0a49…), and
  // verify-image-pin's verify job green (40336238552).
];

/** The refusal line naming every open blocker (empty string when none). */
export function upstreamBlockerRefusal(blockers: typeof Z3_UPSTREAM_BLOCKERS = Z3_UPSTREAM_BLOCKERS): string {
  if (blockers.length === 0) return "";
  return `Z3 live round refused before any spend — open upstream blockers: ${blockers.map((b) => `${b.issue} (${b.what}; ${b.url})`).join("; ")}`;
}

/**
 * Each QA leg's fork-side poll deadline (the fork's QA_POLL_TIMEOUT_MS — the
 * QA legs and their observes take the fork default; a z3 config cannot move it).
 */
export const Z3_QA_LEG_POLL_MS = 3_600_000;

/**
 * The code run's fork-side deadline (`codePollTimeoutMs`, covering z3-code-run
 * AND z3-code-observe — hold + replay + run to park + approve + observe): the
 * round budget minus the sequential QA legs' worst case. Refuses a budget the
 * QA legs alone exhaust.
 */
export function codePollTimeoutFor(roundBudgetMs: number, runs: readonly RoundRun[]): number {
  const qaLegs = runs.filter((r) => r.kind === "qa-leg").length;
  const left = roundBudgetMs - qaLegs * Z3_QA_LEG_POLL_MS;
  if (!Number.isFinite(left) || left < 30 * 60_000) {
    throw new Error(`a ${roundBudgetMs} ms round budget leaves ${left} ms for the code run after ${qaLegs} QA legs × ${Z3_QA_LEG_POLL_MS} ms — raise the round budget`);
  }
  return left;
}

/**
 * The round's gateway assertions are host-side `reflect` calls (the only verb
 * an M2.1 agent token can authenticate with at the gateway — host class =
 * {reflect, retain}; never in-box). `reflect` is LLM-backed, so it is spend
 * outside every fleet cap: budgeted here per call and added to what the GO
 * must approve. Calls: one per QA lens (findings-retain) + one priming + one
 * pre-GO preflight probe.
 */
export const Z3_REFLECT_CALL_USD = 0.05;
export function reflectAllowanceUsd(runs: readonly RoundRun[]): number {
  const calls = runs.filter((r) => r.kind === "qa-leg").length + 2;
  return Math.round(calls * Z3_REFLECT_CALL_USD * 100) / 100;
}

/** A GO older than this authorizes nothing: one GO per round (charter §5.6). */
export const Z3_GO_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The fork's inert anchor template id the schedule fires. */
export const Z3_TEMPLATE_ID = "z3_exit_round";

/** The fork step ids this side reads (the contract). */
export const Z3_STEP = {
  qaLeg: (lens: string) => `qa-leg-${lens}`,
  qaObserve: (lens: string) => `qa-observe-${lens}`,
  codeRun: "z3-code-run",
  codeObserve: "z3-code-observe",
  branch: "z3-branch",
  complete: "z3-complete",
  /** The catch-all case's target: a zero-case branch that fails the run (caseId `unmatched` is red). */
  unmatched: "z3-unmatched",
} as const;

/** The z3-branch case a human decision takes (`completed` = the run never parked). */
export const Z3_APPROVED_CASE = "approved";

/** The round's workIds share one stamp: `w:qa-<stamp>-<lens>`, `w:z3-<stamp>-code`. */
export const Z3_WORK_ID = {
  qa: (stamp: string, lens: string) => `w:qa-${stamp}-${lens}`,
  /** The stamp a code-run workId carries, or null when it is not the z3 shape. */
  codeStamp: (workId: string): string | null => /^w:z3-(.+)-code$/.exec(workId)?.[1] ?? null,
} as const;

export interface RoundRun {
  stepId: string;
  kind: "qa-leg" | "code";
  lens?: string;
  groupCapUsd: number;
}

function cap(name: string, v: number): number {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} groupCapUsd must be a positive finite USD amount, got ${v}`);
  return v;
}

/** The round's fleet runs, in fire order. Refuses a composition over the cap. */
export function composeRound(input: {
  lenses?: readonly string[];
  qaGroupCapUsd: number;
  codeGroupCapUsd: number;
}): RoundRun[] {
  const lenses = input.lenses ?? QA_LENS;
  if (lenses.length + 1 > Z3_MAX_FLEET_RUNS) {
    throw new Error(
      `round composition of ${lenses.length} QA legs + 1 code run exceeds Z3_MAX_FLEET_RUNS = MAX_QA_LEGS + 1 = ${Z3_MAX_FLEET_RUNS}`,
    );
  }
  if (new Set(lenses).size !== lenses.length) throw new Error(`duplicate lens in the round: ${lenses.join(", ")}`);
  for (const lens of lenses) {
    if (!(QA_LENS as readonly string[]).includes(lens)) throw new Error(`lens ${JSON.stringify(lens)} is not in QA_LENS`);
  }
  const qa = cap("QA", input.qaGroupCapUsd);
  const code = cap("code", input.codeGroupCapUsd);
  return [
    ...lenses.map((lens): RoundRun => ({ stepId: Z3_STEP.qaLeg(lens), kind: "qa-leg", lens, groupCapUsd: qa })),
    { stepId: Z3_STEP.codeRun, kind: "code", groupCapUsd: code },
  ];
}

/** Σ per-run groupCapUsd (cents-rounded: float sums must not print $26.000000004). */
export function worstCaseSpendUsd(runs: readonly RoundRun[]): number {
  return Math.round(runs.reduce((s, r) => s + r.groupCapUsd, 0) * 100) / 100;
}

export function worstCaseSpendLine(runs: readonly RoundRun[]): string {
  const parts = runs.map((r) => `${r.stepId} $${r.groupCapUsd.toFixed(2)}`).join(" + ");
  const reflect = reflectAllowanceUsd(runs);
  return `Z3 LIVE ROUND — worst-case spend: ${parts} = $${worstCaseSpendUsd(runs).toFixed(2)} fleet max (${runs.length} sequential fleet runs, cap ${Z3_MAX_FLEET_RUNS}) + $${reflect.toFixed(2)} host-side gateway reflect = $${(worstCaseSpendUsd(runs) + reflect).toFixed(2)} the GO must approve`;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Scope-derivation amendment (2026-10-27, operator-approved): the QA legs'
 * bounded review set is DERIVED from the pinned sha's own diff and PINNED as
 * a round input — never re-derived in-box from a static scope constant (the
 * A2-era `src/qa scripts/qa tests/qa` scopes cover none of the z3 surface, so
 * live round 18's hunters honestly found nothing and priming-recall red'd by
 * contract). Empty refuses HERE: a round that would audit nothing must not
 * burn its GO or its spend. The fork re-validates shape and the 600-char
 * instructions fit at arm time (protocol-qa-hunter-pack resolveReviewSet) —
 * one rule per layer, this layer owns derivation + prose-safety.
 */
export function deriveReviewSet(sha: string, opts: { cwd?: string } = {}): string[] {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`deriveReviewSet needs a 40-hex sha, got "${sha}"`);
  const cwd = opts.cwd ?? path.resolve(import.meta.dir, "../..");
  const out = execFileSync("git", ["diff", "--name-only", `${sha}~1..${sha}`], { cwd, encoding: "utf8", timeout: 30_000 });
  const paths = [...new Set(out.split("\n").map((p) => p.trim()).filter(Boolean))];
  if (paths.length === 0) {
    throw new Error(`the review set at ${sha} is EMPTY (git diff ${sha}~1..${sha} names no paths) — the QA legs would hunt nothing; pin a sha whose own diff is non-empty`);
  }
  for (const p of paths) {
    if (!/^[A-Za-z0-9._/-]+$/.test(p) || p.split("/").includes("..")) {
      throw new Error(`the review set carries a path outside the prose-safe, parent-traversal-free charset: ${JSON.stringify(p)}`);
    }
  }
  // The set rides the leg instructions prose fork-side: 600-char ceiling,
  // ~150-char lens prefix + 37-char clause prefix leaves ~400 for the paths
  // joined with ", ". Refuse before the GO, not as a red arm.
  const joined = paths.join(", ");
  if (joined.length + 2 * paths.length > 400) {
    throw new Error(
      `the review set's ${paths.length} paths need ${joined.length + 2 * paths.length} prose chars — the fork's 600-char leg-instructions ceiling holds; pin a narrower commit`,
    );
  }
  return paths;
}

/** Order-insensitive set equality (both sides derive paths from git, whose order is stable but not contractual). */
function sameSet(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length || !a.every((x) => typeof x === "string")) return false;
  const key = (xs: readonly string[]) => [...xs].sort().join("\n");
  return key(a as string[]) === key(b);
}

/** The GO record's shape (v6-a2/operator-GO.json precedent: who/when/spendApproved/swarmclawForkRev). */
export const OperatorGoSchema = z
  .object({
    who: z.string().trim().min(1),
    when: z.string().regex(ISO_RE).refine((s) => Number.isFinite(Date.parse(s)), "unparseable instant"),
    spendApproved: z.object({ worstCaseUsd: z.number().positive().finite() }).passthrough(),
    swarmclawForkRev: z.string().regex(/^[0-9a-f]{7,40}$/),
  })
  .passthrough();
export type OperatorGo = z.infer<typeof OperatorGoSchema>;

/** Reads the GO record; throws on absent or malformed (never a default). */
export function readOperatorGo(file: string): OperatorGo {
  if (!existsSync(file)) {
    throw new Error(`operator GO not recorded at ${file} — record it (who/when/spendApproved.worstCaseUsd/swarmclawForkRev) before firing`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`operator GO at ${file} is malformed (not JSON: ${e instanceof Error ? e.message : String(e)})`);
  }
  const parsed = OperatorGoSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`operator GO at ${file} is malformed at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/**
 * The pre-fire gate: print the worst case FIRST, then refuse unless a GO is
 * recorded that covers that spend and names the round's fork rev — and, since
 * the scope-derivation amendment (2026-10-27), the review set the operator is
 * funding the audit OF.
 */
export function gateFire(input: {
  runs: readonly RoundRun[];
  goFile: string;
  forkRev: string;
  /** The round's pinned review set; when passed, the GO must name the same set. */
  reviewSet?: readonly string[];
  print?: (line: string) => void;
  now?: number;
}): { go: OperatorGo; worstCaseUsd: number } {
  const worstCaseUsd = worstCaseSpendUsd(input.runs);
  (input.print ?? console.log)(worstCaseSpendLine(input.runs));
  const go = readOperatorGo(input.goFile);
  if (input.reviewSet !== undefined && !sameSet(go.reviewSet, input.reviewSet)) {
    throw new Error(
      `operator GO ${go.reviewSet === undefined ? "does not name" : "names a different"} review set — the GO must name exactly the pinned set (${input.reviewSet.join(", ")}) the round will audit: refusing to fire`,
    );
  }
  const gated = Math.round((worstCaseUsd + reflectAllowanceUsd(input.runs)) * 100) / 100;
  if (go.spendApproved.worstCaseUsd < gated) {
    throw new Error(
      `operator GO approves $${go.spendApproved.worstCaseUsd} but the round's worst case is $${gated.toFixed(2)} (fleet + gateway reflect) — refusing to fire`,
    );
  }
  const now = input.now ?? Date.now();
  const at = Date.parse(go.when);
  // Zero tolerance: a GO that passes here always predates the fire (AC7 re-checks go.when <= firedAt).
  if (at > now) throw new Error(`operator GO is dated ${go.when}, in the future — refusing to fire`);
  if (now - at > Z3_GO_MAX_AGE_MS) {
    throw new Error(`operator GO dated ${go.when} is older than ${Z3_GO_MAX_AGE_MS / 3_600_000}h — record a GO for THIS round`);
  }
  if (go.swarmclawForkRev !== input.forkRev) {
    throw new Error(`operator GO was recorded against fork rev ${go.swarmclawForkRev}, the round runs ${input.forkRev} — refusing to fire`);
  }
  return { go, worstCaseUsd };
}

/**
 * One GO per round, enforced by CONSUMING it: the GO file is moved (link +
 * unlink, so a concurrent consumer cannot both win) to
 * `<stamp>-operator-GO.consumed.json` beside it the moment the round passes
 * the gate. A second round finds no GO and refuses; the consumed copy stays in
 * the evidence dir as the round's GO record.
 */
export function consumeOperatorGo(goFile: string, stamp: string): string {
  const consumed = path.join(path.dirname(goFile), `${stamp}-operator-GO.consumed.json`);
  linkSync(goFile, consumed); // EEXIST = this stamp already consumed one
  try {
    unlinkSync(goFile);
  } catch (e) {
    // Lost the race to a concurrent consumer: leave no stray "consumed" record for a GO this round never used.
    unlinkSync(consumed);
    throw e;
  }
  return consumed;
}
