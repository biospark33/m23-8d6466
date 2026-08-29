/**
 * DF3.2 rank (AC7) — score a completed best-of-N fan-out. ADVISORY: ranking
 * authorizes NOTHING; the diff is the artifact and a human closes the loop
 * (fan_out_n.md:136-140). Reads/writes ONLY the fan-out record (via injected
 * seams) plus the injected step-output source.
 *
 * score = testPassRate*0.6 + uniqueFileCoverage*0.4 (weights sum to 1.0 — a
 * deliberate round choice, NOT renormalization of P1.4's 0.5/0.3).
 *
 * The fan-out record is reached through `recordReader`/`recordWriter`, NOT
 * through FanoutRecordStore directly: the store lands in fanout.ts under wave
 * sequencing C3, and rank must compile standalone. The CLI wires the store's
 * get/mutate into these seams; until then tests inject fakes.
 */
import { FleetError } from "./dispatch.ts";
import { redactSecrets } from "../providers/step-log.ts";

/** Weight of `testPassRate` in the composite score. */
export const TEST_PASS_WEIGHT = 0.6;
/** Weight of `uniqueFileCoverage` in the composite score. */
export const FILE_COVERAGE_WEIGHT = 0.4;
/** Top-two delta at or below which `tie` is true — INCLUSIVE boundary. */
export const TIE_DELTA = 0.1;

/**
 * DF1.6 producer contract: counts are `passed`/`failed` (no `testsPassed`
 * exists anywhere), and `testsExecuted` is a boolean GUARD, never a divisor.
 */
export interface ArmStepOutput {
  testsExecuted?: boolean;
  testResults?: { passed: number; failed: number };
  changedFiles?: string[];
}

export interface RankedArm {
  arm: number;
  runId: string;
  /** null ⇒ no step output for this run; the arm stays LISTED, never dropped. */
  score: number | null;
  /** EXACTLY these two keys — P1.4's summaryQuality was dropped (AC7). */
  breakdown: { testPassRate: number; uniqueFileCoverage: number };
}

export interface RankResult {
  fanoutId: string;
  scores: RankedArm[];
  tie: boolean;
  rationale: string;
  /** Sub-timing for the observability line's nested `timings` object (D13). */
  timings: { rankMs: number };
}

/**
 * Structural view of the fields rank touches on a FanoutRecord — the minimal
 * shape that keeps this module decoupled from fanout.ts (ruling C3).
 */
export interface FanoutRecordView {
  n: number;
  winner?: number | null;
  rankedAt?: string | null;
  closedAt?: string | null;
  arms: readonly { arm: number; runId: string }[];
}

/** Mutate-and-persist under the store's per-record lock; returns the next state. */
export type FanoutRecordMutator = (rec: FanoutRecordView) => FanoutRecordView;

export interface RankDeps {
  /** Read the fan-out record; null ⇒ unknown id → FleetError exitCode 4. */
  recordReader: (fanoutId: string) => FanoutRecordView | null;
  /** Persist a mutation — rank uses it ONLY to stamp `rankedAt`. */
  recordWriter: (
    fanoutId: string,
    mutator: FanoutRecordMutator,
  ) => FanoutRecordView;
  /**
   * Step-output source, REQUIRED injection (OPEN-QUESTION-2 / ruling C2):
   * returning null lists that arm with score:null. An accessor that nulls
   * every run (e.g. `--steps-json` absent) leaves every arm unscored — not an
   * error; rank stays structurally useful.
   */
  stepOutputFor: (runId: string) => ArmStepOutput | null;
  /** performance.now seam (test); defaults to the host monotonic clock. */
  monotonic?: () => number;
}

/**
 * `(testsExecuted === true && testResults && passed+failed > 0)
 *   ? passed/(passed+failed) : 0` — absent testResults and passed+failed===0
 * both yield 0; the flag gates, it never divides.
 */
function testPassRate(out: ArmStepOutput): number {
  if (out.testsExecuted !== true || !out.testResults) return 0;
  const total = out.testResults.passed + out.testResults.failed;
  return total > 0 ? out.testResults.passed / total : 0;
}

/**
 * Structural guard at the library boundary — the same shape refusal the CLI's
 * --steps-json parser makes, so embedders calling rank() directly get the
 * named refusal instead of NaN scores. Counts must be NON-negative integers:
 * a negative count made passRate exceed 1 and ranked a broken arm above a
 * healthy one.
 */
export function assertStepOutputShape(
  runId: string,
  out: ArmStepOutput,
  /**
   * How a rejected shape becomes an error. Defaults to the library refusal;
   * scripts/fleet.ts passes a wrapper that names the FLAG that carried the
   * payload (`--steps-json entry "…"`) under the CLI's `usage` code. One
   * validator, two spellings of the subject — never two validators.
   */
  fail: (why: string, hint: string) => Error = (why, hint) =>
    new FleetError(2, "invalid-step-output", `step output for run ${redactSecrets(runId)} ${why}`, hint),
): void {
  const hint = "each entry carries testsExecuted?, testResults{passed,failed}? and changedFiles[]?";
  // First statement, before any field access: a non-object (truthy junk — a
  // string, number, or an Array) refuses HERE as the named refusal instead of
  // dying as a TypeError on the accesses below.
  if (typeof out !== "object" || out === null || Array.isArray(out)) {
    throw fail("must be an object", hint);
  }
  if (out.testsExecuted !== undefined && typeof out.testsExecuted !== "boolean") {
    throw fail("has a non-boolean testsExecuted (it is a guard flag, never a divisor)", hint);
  }
  const tr = out.testResults;
  if (
    tr !== undefined &&
    // JSON carries `null` where the CLI's --steps-json gate refuses it
    // (scripts/fleet.ts's testResults branch) — `null !== undefined` alone let
    // it past this guard and die as `Cannot read properties of null` on the
    // `.passed` access below instead of the named refusal embedders get for
    // every other malformed shape.
    (tr === null ||
      typeof tr !== "object" ||
      !Number.isInteger(tr.passed) ||
      !Number.isInteger(tr.failed) ||
      tr.passed < 0 ||
      tr.failed < 0 ||
      // Astronomic counts are refused under the SAME message: past
      // MAX_SAFE_INTEGER the score arithmetic loses integrity before any
      // comparison could catch it.
      tr.passed > Number.MAX_SAFE_INTEGER ||
      tr.failed > Number.MAX_SAFE_INTEGER)
  ) {
    throw fail("needs testResults with non-negative integer passed/failed counts", hint);
  }
  // r7-S2a: Refuse semantic inconsistency — testResults present while
  // testsExecuted !== true. Matches CLI refusal (scripts/fleet.ts C3) so
  // embedders calling rank() directly get the named refusal, not silent
  // zero scores from testPassRate's gate on testsExecuted === true.
  if (tr !== undefined && out.testsExecuted !== true) {
    throw fail(
      "has testResults but testsExecuted is false — tests must have been executed to have results",
      hint,
    );
  }
  if (
    out.changedFiles !== undefined &&
    (!Array.isArray(out.changedFiles) || out.changedFiles.some((f) => typeof f !== "string"))
  ) {
    throw fail("has changedFiles that is not an array of path strings", hint);
  }
}

/** Normalized top-two delta ≤ TIE_DELTA (K6: toFixed(10) tames IEEE-754 drift). */
function isTie(scores: RankedArm[]): boolean {
  const [top, second] = scores;
  if (!top || top.score === null) return false;
  if (!second || second.score === null) return false;
  return Number((top.score - second.score).toFixed(10)) <= TIE_DELTA;
}

function buildRationale(scores: RankedArm[], tie: boolean): string {
  const top = scores[0];
  const unscored = scores.filter((s) => s.score === null);
  let rationale: string;
  if (!top || top.score === null) {
    rationale =
      "no step-output source provided — every arm listed unscored; " +
      "supply --steps-json to rank";
  } else if (tie && scores[1]) {
    const second = scores[1];
    rationale =
      `top arms ${top.arm} (run ${top.runId}) and ${second.arm} (run ${second.runId}) are within ${TIE_DELTA} of each other — tie flagged, NO automatic tie-break; human review resolves`;
  } else if (unscored.length === scores.length - 1) {
    // Exactly one scored arm: there is nothing for it to lead over, so the
    // "leads by more than" claim would be a comparison over no data.
    rationale = `only arm ${top.arm} (run ${top.runId}) has step output — no comparison possible; supply step output for every arm to rank`;
  } else {
    rationale =
      `top arm ${top.arm} (run ${top.runId}, score ${top.score}) leads by more than ${TIE_DELTA}`;
  }
  // Name the empty runs: a --steps-json key typo nulls an arm silently, and the
  // operator needs to see WHICH runId came up empty.
  if (unscored.length > 0 && unscored.length < scores.length) {
    rationale += `; no step output for ${unscored.map((s) => `arm ${s.arm} (run ${s.runId})`).join(", ")}`;
  }
  return rationale;
}

/**
 * Score one completed best-of-N fan-out: per-arm composite over the CROSS-ARM
 * union denominator, FP-normalized inclusive tie window, rankedAt stamped
 * through the injected writer. Emits `{scores[{arm,runId,score,breakdown}],
 * tie, rationale}` — advisory only.
 */
// NOTE: `async` with no `await` in the body is deliberate. `Promise<RankResult>`
// is the published signature both CLI call sites and embedders consume; dropping
// `async` would either change that contract or need a `Promise.resolve` wrapper
// for no gain. Rank stays sync-computable on purpose — the I/O is all in `deps`.
export async function rank(fanoutId: string, deps: RankDeps): Promise<RankResult> {
  const start = deps.monotonic?.() ?? performance.now();

  const record = deps.recordReader(fanoutId);
  if (!record) {
    throw new FleetError(
      4,
      "fanout-not-found",
      `no fan-out record found for ${redactSecrets(fanoutId)}`,
      "Check the fanout-id (`fleet fanout` prints it; ids look like fan-YYYYMMDD-<6hex>) or list .sandbox/fanouts/.",
    );
  }

  // r7-S3c: Detect orphaned fanout record — crash window between store.create
  // (with arms:[]) and store.mutate (fills arms). A record with n>0 but
  // arms.length===0 is indistinguishable from a real empty outcome; fail-safe
  // refusal with named error.
  if (record.n > 0 && record.arms.length === 0) {
    throw new FleetError(
      2,
      "invalid-fanout-record",
      `fanout record ${redactSecrets(fanoutId)} has n=${record.n} but zero arms — orphaned by a crash between create and arm fill`,
      `inspect .sandbox/fanouts/${redactSecrets(fanoutId)}.json and re-run fleet fanout to complete the record`,
    );
  }

  // Cross-arm union FIRST: every arm's changedFiles contributes to everyone's
  // denominator, Set-deduped on both sides (AC7).
  const outputs = record.arms.map((a) => ({
    arm: a.arm,
    runId: a.runId,
    out: deps.stepOutputFor(a.runId),
  }));
  const union = new Set<string>();
  for (const o of outputs) {
    // Malformed entries refuse NAMING the run before any arithmetic: a negative
    // count or a non-array changedFiles would otherwise flow into the score as
    // an above-1 pass rate or NaN.
    if (o.out !== null) assertStepOutputShape(o.runId, o.out);
    for (const f of o.out?.changedFiles ?? []) union.add(f);
  }

  let scores: RankedArm[] = [];
  let tie = false;
  let rationale: string;

  // NOTE: unreachable through the in-repo reader — `validateFanoutRecord` pins
  // `n >= 1`, so an empty `arms` is already refused by the orphan guard above.
  // Kept as defence in depth for the injected `deps.recordReader` seam: an
  // embedder's reader need not validate, and the else-branch below would score
  // an empty arm set into a meaningless verdict rather than say so.
  if (record.arms.length === 0) {
    rationale =
      `fan-out ${fanoutId} has no ranked arms: every arm failed before minting a run id — nothing to rank`;
  } else {
    scores = outputs
      .map(({ arm, runId, out }): RankedArm => {
        if (!out) {
          return {
            arm,
            runId,
            score: null,
            breakdown: { testPassRate: 0, uniqueFileCoverage: 0 },
          };
        }
        const passRate = testPassRate(out);
        const coverage =
          union.size === 0 ? 0 : new Set(out.changedFiles ?? []).size / union.size;
        return {
          arm,
          runId,
          // Clamped to [0,1]: both terms are bounded once the shape guard holds,
          // so this only keeps a future weight change from emitting an
          // unnormalizable composite.
          score: Math.min(1, Math.max(0, passRate * TEST_PASS_WEIGHT + coverage * FILE_COVERAGE_WEIGHT)),
          breakdown: { testPassRate: passRate, uniqueFileCoverage: coverage },
        };
      })
      // Descending score, nulls last, stable by arm within equals.
      .sort((a, b) =>
        (b.score ?? -1) !== (a.score ?? -1)
          ? (b.score ?? -1) - (a.score ?? -1)
          : a.arm - b.arm,
      );
    tie = isTie(scores);
    rationale = buildRationale(scores, tie);
  }

  deps.recordWriter(fanoutId, (rec) => ({
    ...rec,
    rankedAt: new Date().toISOString(),
  }));

  const rankMs = (deps.monotonic?.() ?? performance.now()) - start;
  return { fanoutId, scores, tie, rationale: redactSecrets(rationale), timings: { rankMs } };
}
