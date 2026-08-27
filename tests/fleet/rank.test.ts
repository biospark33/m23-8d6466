/**
 * Rank tests (Story DF3.2 AC7): TDD — written before src/fleet/rank.ts existed.
 *
 * Coverage per spec D11/D14 + Correction K6:
 * - score === testPassRate*0.6 + uniqueFileCoverage*0.4 to six decimals (three-arm fixture)
 * - uniqueFileCoverage denominates over the CROSS-ARM union of changedFiles
 * - breakdown carries EXACTLY {testPassRate, uniqueFileCoverage}; summaryQuality cannot
 *   compile (type-level pin) and never appears at runtime
 * - tie deltas: 0.05 → true, 0.2 → false, 0.1 boundary → true INCLUSIVE via the
 *   FP-normalized comparator (K6: fixtures chosen so the RAW delta straddles 0.1 both ways)
 * - guarded divisors: testsExecuted:false / absent testResults / passed+failed===0 → 0
 * - empty union → coverage 0; arm without step output LISTED score:null, never dropped;
 *   all-null source → every arm unscored + "no step-output source provided" rationale (C2);
 *   record with no arms → empty scores + failure rationale
 * - unknown fanout-id → FleetError exitCode 4
 * - rankedAt stamped through the injected writer exactly once
 * - rationale passes the single redactSecrets chokepoint before returning
 * - timings.rankMs reported from the injected monotonic clock
 */
import { describe, expect, test } from "bun:test";

import { FleetError } from "../../src/fleet/dispatch.ts";
import {
  type ArmStepOutput,
  type FanoutRecordView,
  type RankedArm,
  type RankDeps,
  rank,
} from "../../src/fleet/rank.ts";

/** Step-output fixture row: everything `stepOutputFor` may hand back. */
interface StepFixture extends ArmStepOutput {}

interface HarnessOpts {
  arms?: { arm: number; runId: string }[];
  /** runId → step output; runIds absent from the map yield null (no step output). */
  steps?: Record<string, StepFixture>;
}

/**
 * Local fake fan-out record plumbing (C3: wave-1 fakes stay local to this file).
 * The CLI wires FanoutRecordStore.get/mutate into these seams after merge.
 */
function harness(opts: HarnessOpts = {}) {
  const record: FanoutRecordView = {
    n: opts.arms?.length ?? 0,
    winner: null,
    rankedAt: null,
    closedAt: null,
    arms: opts.arms ?? [],
  };
  const writes: { fanoutId: string; next: FanoutRecordView }[] = [];
  let readCalls = 0;
  const deps: RankDeps = {
    recordReader: () => {
      readCalls += 1;
      return record;
    },
    recordWriter: (fanoutId, mutator) => {
      const next = mutator(record);
      writes.push({ fanoutId, next });
      return next;
    },
    stepOutputFor: (runId) => opts.steps?.[runId] ?? null,
  };
  return { deps, record, writes, reads: () => readCalls };
}

const FANOUT_ID = "fan-20260823-abc123";

describe("rank (DF3.2 AC7)", () => {
  test("scores three arms as testPassRate*0.6 + uniqueFileCoverage*0.4 to six decimals", async () => {
    const h = harness({
      arms: [
        { arm: 0, runId: "r0" },
        { arm: 1, runId: "r1" },
        { arm: 2, runId: "r2" },
      ],
      steps: {
        // tpr 0.7, coverage 3/4 → 0.42 + 0.30 = 0.72
        r0: { testsExecuted: true, testResults: { passed: 7, failed: 3 }, changedFiles: ["a.ts", "b.ts", "c.ts"] },
        // tpr 0.5, coverage 3/4 → 0.30 + 0.30 = 0.60
        r1: { testsExecuted: true, testResults: { passed: 1, failed: 1 }, changedFiles: ["b.ts", "c.ts", "d.ts"] },
        // tpr 0.25, coverage 0/4 → 0.15 + 0 = 0.15
        r2: { testsExecuted: true, testResults: { passed: 2, failed: 6 }, changedFiles: [] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    expect(res.fanoutId).toBe(FANOUT_ID);
    // Descending by score, stable by arm.
    expect(res.scores.map((s) => s.arm)).toEqual([0, 1, 2]);
    expect(res.scores[0]?.score).toBeCloseTo(0.72, 6);
    expect(res.scores[1]?.score).toBeCloseTo(0.6, 6);
    expect(res.scores[2]?.score).toBeCloseTo(0.15, 6);
    expect(res.scores[0]?.breakdown).toEqual({ testPassRate: 0.7, uniqueFileCoverage: 0.75 });
    // 0.72 − 0.60 clears the 0.1 window — no accidental tie in the happy path.
    expect(res.tie).toBe(false);
  });

  test("denominates uniqueFileCoverage over the cross-arm union of changedFiles", async () => {
    const h = harness({
      arms: [
        { arm: 0, runId: "sub" },
        { arm: 1, runId: "sup" },
      ],
      steps: {
        sub: { testsExecuted: true, testResults: { passed: 1, failed: 0 }, changedFiles: ["f1.ts"] },
        sup: {
          testsExecuted: true,
          testResults: { passed: 1, failed: 0 },
          changedFiles: ["f1.ts", "f2.ts", "f3.ts"],
        },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    const byArm = new Map(res.scores.map((s) => [s.arm, s]));
    // Union = {f1,f2,f3} (size 3): the subset arm covers 1/3 of the SURFACE any arm touched —
    // a per-arm denominator would have scored it a full 1.
    expect(byArm.get(0)?.breakdown.uniqueFileCoverage).toBeCloseTo(1 / 3, 10);
    expect(byArm.get(0)?.breakdown.uniqueFileCoverage).not.toBe(1);
    expect(byArm.get(1)?.breakdown.uniqueFileCoverage).toBe(1);
    // Duplicate entries within one arm's list count once (Set-dedup both sides).
    const dedup = harness({
      arms: [{ arm: 0, runId: "d" }],
      steps: {
        d: {
          testsExecuted: true,
          testResults: { passed: 1, failed: 0 },
          changedFiles: ["f1.ts", "f1.ts"],
        },
      },
    });
    const dedupRes = await rank(FANOUT_ID, dedup.deps);
    expect(dedupRes.scores[0]?.breakdown.uniqueFileCoverage).toBe(1);
  });

  test("carries exactly two breakdown keys — summaryQuality cannot compile and never appears", async () => {
    // Type-level pin: excess-property checking must reject P1.4's dropped third term.
    // Enforcement lives in `bunx tsc --noEmit`; the literal below fails compilation
    // if the breakdown type ever widens to admit summaryQuality again.
    const _mustNotCompile: RankedArm["breakdown"] = {
      testPassRate: 0,
      uniqueFileCoverage: 0,
      // @ts-expect-error summaryQuality was dropped from AC7 — re-adding it MUST fail typecheck
      summaryQuality: 0,
    };
    void _mustNotCompile;

    const h = harness({
      arms: [{ arm: 0, runId: "r0" }],
      steps: {
        r0: { testsExecuted: true, testResults: { passed: 1, failed: 0 }, changedFiles: ["f.ts"] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    expect(Object.keys(res.scores[0]?.breakdown ?? {}).sort()).toEqual([
      "testPassRate",
      "uniqueFileCoverage",
    ]);
  });

  test("tie: delta 0.05 flags a tie", async () => {
    // All arms share one file ⇒ ufc = 1 everywhere ⇒ deltas ride testPassRate alone.
    const h = harness({
      arms: [
        { arm: 0, runId: "top" },
        { arm: 1, runId: "near" },
      ],
      steps: {
        top: { testsExecuted: true, testResults: { passed: 12, failed: 0 }, changedFiles: ["shared.ts"] },
        near: { testsExecuted: true, testResults: { passed: 11, failed: 1 }, changedFiles: ["shared.ts"] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    expect((res.scores[0]?.score ?? 0) - (res.scores[1]?.score ?? 0)).toBeCloseTo(0.05, 6);
    expect(res.tie).toBe(true);
  });

  test("tie: delta 0.2 does not flag a tie", async () => {
    const h = harness({
      arms: [
        { arm: 0, runId: "top" },
        { arm: 1, runId: "far" },
      ],
      steps: {
        top: { testsExecuted: true, testResults: { passed: 12, failed: 0 }, changedFiles: ["shared.ts"] },
        far: { testsExecuted: true, testResults: { passed: 8, failed: 4 }, changedFiles: ["shared.ts"] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    expect((res.scores[0]?.score ?? 0) - (res.scores[1]?.score ?? 0)).toBeCloseTo(0.2, 6);
    expect(res.tie).toBe(false);
  });

  test("tie: 0.1 boundary is INCLUSIVE — normalization rescues a raw delta ABOVE 0.1 (K6)", async () => {
    // passed 2/3 vs passed 1/2: nominal score delta is exactly 0.1, but IEEE-754 renders
    // the raw subtraction as 0.10000000000000009 — strictly GREATER than 0.1. An
    // unnormalized `<= 0.1` comparator flips the DOD's boundary case to tie:false; the
    // normalized Number(delta.toFixed(10)) lands on exactly 0.1 and must report tie:true.
    const h = harness({
      arms: [
        { arm: 0, runId: "a23" },
        { arm: 1, runId: "b12" },
      ],
      steps: {
        a23: { testsExecuted: true, testResults: { passed: 2, failed: 1 }, changedFiles: ["shared.ts"] },
        b12: { testsExecuted: true, testResults: { passed: 1, failed: 1 }, changedFiles: ["shared.ts"] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);
    expect(res.scores[0]).toBeDefined();
    expect(res.scores[1]).toBeDefined();
    // The RAW subtraction on one invocation's scores is the K6 proof: two
    // separate rank() calls would let a non-idempotent writer mask the trap.
    const rawDelta = (res.scores[0]!.score ?? 0) - (res.scores[1]!.score ?? 0);
    expect(rawDelta).toBeGreaterThan(0.1); // the trap exists — this assertion IS the K6 proof

    expect(Number(rawDelta.toFixed(10))).toBe(0.1);
    expect(res.tie).toBe(true); // inclusive boundary survives the float rendering

    // Canonical K6 example, pinned as documentation: 0.7 − 0.6 renders BELOW 0.1 raw,
    // so neither direction of the boundary can be judged unnormalized.
    expect(Number((0.7 - 0.6).toFixed(10))).toBe(0.1);
  });

  test("tie: different runIds with identical step outputs produce identical scores and tie", async () => {
    const h = harness({
      arms: [
        { arm: 0, runId: "first" },
        { arm: 1, runId: "second" },
      ],
      steps: {
        first: { testsExecuted: true, testResults: { passed: 3, failed: 1 }, changedFiles: ["a.ts", "b.ts"] },
        second: { testsExecuted: true, testResults: { passed: 3, failed: 1 }, changedFiles: ["a.ts", "b.ts"] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    expect(res.scores.map((s) => s.arm)).toEqual([0, 1]); // stable by arm on equals
    expect(res.scores[0]?.runId).toBe("first");
    expect(res.scores[1]?.runId).toBe("second");
    expect(res.scores[0]?.score).toBe(res.scores[1]?.score); // EXACTLY equal
    expect(res.tie).toBe(true);
    expect(res.rationale).toContain("tie flagged");
    // Deterministic winner on tie: lower arm index wins (stable by arm sort)
    expect(res.scores[0]?.arm).toBe(0);
  });

  test("tie: normalization rescues a raw delta BELOW 0.1 the other way (K6 straddle)", async () => {
    // Mirror of the fixture above: passed 1/2 vs passed 1/3 has a nominal score
    // delta of exactly 0.1, but this time IEEE-754 renders the score subtraction
    // as 0.09999999999999998 — strictly BELOW 0.1. Normalization rounds back UP
    // onto exactly 0.1, so the inclusive comparator still reports tie:true: the
    // boundary verdict may not depend on which way the rendering fell.
    const h = harness({
      arms: [
        { arm: 0, runId: "a12" },
        { arm: 1, runId: "b13" },
      ],
      steps: {
        a12: { testsExecuted: true, testResults: { passed: 1, failed: 1 }, changedFiles: ["shared.ts"] },
        b13: { testsExecuted: true, testResults: { passed: 1, failed: 2 }, changedFiles: ["shared.ts"] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);
    expect(res.scores[0]).toBeDefined();
    expect(res.scores[1]).toBeDefined();
    const rawDelta = (res.scores[0]!.score ?? 0) - (res.scores[1]!.score ?? 0);
    expect(rawDelta).toBeLessThan(0.1); // the straddle's other direction is real

    expect(Number(rawDelta.toFixed(10))).toBe(0.1); // normalized UP onto the boundary
    expect(res.tie).toBe(true);
  });

  test("guards the pass-rate divisor: testsExecuted:false, absent testResults, zero total → 0", async () => {
    const h = harness({
      arms: [
        { arm: 0, runId: "noresults" },
        { arm: 1, runId: "zerototal" },
      ],
      steps: {
        noresults: { testsExecuted: true, changedFiles: [] },
        zerototal: { testsExecuted: true, testResults: { passed: 0, failed: 0 }, changedFiles: [] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    // Empty changedFiles across ALL arms also pins the empty-union rule: coverage 0.
    for (const s of res.scores) {
      expect(s.score).toBe(0);
      expect(s.breakdown.testPassRate).toBe(0);
      expect(s.breakdown.uniqueFileCoverage).toBe(0);
    }
    // Literal spec: all scores are exactly 0, so the top-two normalized delta is
    // 0 ≤ 0.1 — a tie. No all-zero carve-out exists in AC7 and none is invented;
    // the human reviewer sees two zeros and concludes nothing worked.
    expect(res.tie).toBe(true);
  });

  test("all arms with empty changedFiles → every arm scores 0, breakdown 0, tie (union denominator 0)", async () => {
    // Pins the cross-arm union rule: when NO arm touches any file, the union is empty
    // (size 0), every arm's uniqueFileCoverage is 0/0 → 0, and all scores are 0.
    const h = harness({
      arms: [
        { arm: 0, runId: "empty-a" },
        { arm: 1, runId: "empty-b" },
        { arm: 2, runId: "empty-c" },
      ],
      steps: {
        "empty-a": { testsExecuted: true, testResults: { passed: 5, failed: 0 }, changedFiles: [] },
        "empty-b": { testsExecuted: true, testResults: { passed: 3, failed: 2 }, changedFiles: [] },
        "empty-c": { testsExecuted: true, testResults: { passed: 1, failed: 4 }, changedFiles: [] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    // Every arm's breakdown is {testPassRate: <their TPR>, uniqueFileCoverage: 0}
    // because the cross-arm union is empty (denominator 0 → coverage 0).
    const byArm = new Map(res.scores.map((s) => [s.arm, s]));
    expect(byArm.get(0)?.breakdown.uniqueFileCoverage).toBe(0);
    expect(byArm.get(1)?.breakdown.uniqueFileCoverage).toBe(0);
    expect(byArm.get(2)?.breakdown.uniqueFileCoverage).toBe(0);

    // Scores are testPassRate * 0.6 only (coverage term vanishes): arm0=1.0*0.6=0.6, arm1=0.6*0.6=0.36, arm2=0.2*0.6=0.12
    expect(res.scores.map((s) => s.score)).toEqual([0.6, 0.36, 0.12]);

    // Top-two delta: 0.6 - 0.36 = 0.24 > 0.1 → no tie despite all coverage being 0.
    expect(res.tie).toBe(false);
    expect(res.rationale).toContain("leads by more than");
  });

  test("testResults:null is refused through invalid-step-output, never a TypeError", async () => {
    // JSON carries `null` where absence means `undefined`; the CLI's
    // --steps-json gate refuses it, so embedders calling rank() directly must
    // get the SAME named refusal — not "Cannot read properties of null".
    const h = harness({
      arms: [{ arm: 0, runId: "nulltr" }],
      steps: {
        nulltr: { testsExecuted: true, testResults: null } as unknown as StepFixture,
      },
    });
    let err: FleetError | undefined;
    try {
      await rank(FANOUT_ID, h.deps);
    } catch (e) {
      err = e as FleetError;
    }
    expect(err?.exitCode).toBe(2);
    expect(err?.code).toBe("invalid-step-output");
    expect(err?.message).toContain("nulltr"); // names the run before any arithmetic
  });

  test("lists an arm with no step output as score:null and never drops it", async () => {
    const h = harness({
      arms: [
        { arm: 0, runId: "scored" },
        { arm: 1, runId: "silent" },
      ],
      steps: {
        scored: { testsExecuted: true, testResults: { passed: 1, failed: 0 }, changedFiles: ["f.ts"] },
        // "silent" deliberately absent from the map → stepOutputFor returns null.
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    expect(res.scores).toHaveLength(2);
    expect(res.scores.map((s) => s.arm)).toEqual([0, 1]); // scored first, null-scored listed after
    expect(res.scores[0]).toBeDefined();
    expect(res.scores[0]?.score).not.toBeNull();
    expect(res.scores[1]?.score).toBeNull();
    expect(res.scores[1]?.runId).toBe("silent");
    expect(res.scores[1]?.breakdown).toEqual({ testPassRate: 0, uniqueFileCoverage: 0 });
    expect(res.rationale).toContain("silent");
  });

  test("returns every arm unscored with a no-source rationale when no step output exists at all", async () => {
    const h = harness({
      arms: [
        { arm: 0, runId: "r0" },
        { arm: 1, runId: "r1" },
      ],
      steps: {}, // ruling C2: --steps-json absent ⇒ accessor nulls every arm
    });

    const res = await rank(FANOUT_ID, h.deps);

    expect(res.scores).toHaveLength(2);
    expect(res.scores.every((s) => s.score === null)).toBe(true);
    expect(res.tie).toBe(false);
    expect(res.rationale).toContain("no step-output source provided");
  });

  test("yields empty scores and a failure rationale when the record has no arms", async () => {
    const h = harness({ arms: [] }); // every arm refused before minting a run id

    const res = await rank(FANOUT_ID, h.deps);

    expect(res.scores).toEqual([]);
    expect(res.tie).toBe(false);
    expect(res.rationale.toLowerCase()).toContain("fail");
  });

  test("throws FleetError exit 4 when the fan-out record is unknown", async () => {
    const h = harness();
    const missing: RankDeps = { ...h.deps, recordReader: () => null };

    try {
      await rank("fan-20260823-deadbe", missing);
      throw new Error("expected rank to refuse an unknown fanout-id");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const fe = e as FleetError;
      expect(fe.exitCode).toBe(4);
      expect(fe.code).toBe("fanout-not-found");
    }
  });

  test("stamps rankedAt on the fan-out record through the injected writer, exactly once", async () => {
    const h = harness({
      arms: [{ arm: 0, runId: "r0" }],
      steps: {
        r0: { testsExecuted: true, testResults: { passed: 1, failed: 0 }, changedFiles: ["f.ts"] },
      },
    });

    await rank(FANOUT_ID, h.deps);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.fanoutId).toBe(FANOUT_ID);
    const stamped = h.writes[0]?.next.rankedAt ?? ""; /* dp:ok fallback only feeds the assertion below, which fails on an unparsable stamp */
    expect(Number.isNaN(Date.parse(stamped))).toBe(false);
    expect(h.reads()).toBe(1);
  });

  test("passes the rationale through the single redactSecrets chokepoint", async () => {
    const leakyRunId = "qds-x https://openrouter.ai/api/v1/keys/s3cr3tvalue99";
    const h = harness({
      arms: [{ arm: 0, runId: leakyRunId }],
      steps: {
        [leakyRunId]: {
          testsExecuted: true,
          testResults: { passed: 1, failed: 0 },
          changedFiles: ["f.ts"],
        },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    // The rationale names the winning run — after redaction the key-management URL's
    // token must not survive anywhere in the returned string.
    expect(res.rationale).not.toContain("s3cr3tvalue99");
  });

  test("reports rank_ms from the injected monotonic clock", async () => {
    const h = harness({ arms: [] });
    let now = 100;
    const deps: RankDeps = {
      ...h.deps,
      monotonic: () => {
        now += 7;
        return now;
      },
    };

    const res = await rank(FANOUT_ID, deps);

    expect(res.timings.rankMs).toBe(7);
  });

  test("refuses a negative test count instead of scoring nonsense from it", async () => {
    // passed:-3 makes passRate exceed 1 — a broken arm ranked ABOVE healthy
    // ones. The library guard mirrors the CLI's --steps-json refusal.
    const h = harness({
      arms: [{ arm: 0, runId: "neg" }],
      steps: { neg: { testsExecuted: true, testResults: { passed: -3, failed: 1 } } },
    });

    try {
      await rank(FANOUT_ID, h.deps);
      throw new Error("expected rank to refuse a negative count");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const fe = e as FleetError;
      expect(fe.exitCode).toBe(2);
      expect(fe.code).toBe("invalid-step-output");
      expect(fe.message).toContain("neg");
    }
  });

  test("treats a non-array changedFiles as malformed, not as a character union", async () => {
    // A bare string would iterate per CHARACTER into the cross-arm union and
    // poison everyone's coverage denominator.
    const h = harness({
      arms: [{ arm: 0, runId: "strfiles" }],
      steps: {
        strfiles: {
          testsExecuted: true,
          testResults: { passed: 1, failed: 0 },
          changedFiles: "f.ts" as unknown as string[],
        },
      },
    });

    try {
      await rank(FANOUT_ID, h.deps);
      throw new Error("expected rank to refuse a non-array changedFiles");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const fe = e as FleetError;
      expect(fe.exitCode).toBe(2);
      expect(fe.code).toBe("invalid-step-output");
      expect(fe.message).toContain("changedFiles");
    }
  });

  test("states no comparison was possible when exactly ONE arm scored", async () => {
    // One scored arm among two: the old rationale claimed it "leads by more
    // than 0.1" over nothing at all.
    const h = harness({
      arms: [
        { arm: 0, runId: "only" },
        { arm: 1, runId: "dark" },
      ],
      steps: { only: { testsExecuted: true, testResults: { passed: 1, failed: 0 }, changedFiles: ["f.ts"] } },
    });

    const res = await rank(FANOUT_ID, h.deps);

    expect(res.scores[0]).toBeDefined();
    expect(res.scores[0]?.score).not.toBeNull();
    expect(res.tie).toBe(false);
    expect(res.rationale).toContain("no comparison possible");
    expect(res.rationale).not.toContain("leads by more than");

    // A single-arm record is the same branch by construction.
    const solo = harness({
      arms: [{ arm: 0, runId: "solo" }],
      steps: { solo: { testsExecuted: true, testResults: { passed: 1, failed: 0 }, changedFiles: ["f.ts"] } },
    });
    const soloRes = await rank(FANOUT_ID, solo.deps);
    expect(soloRes.rationale).toContain("no comparison possible");
  });

  test("refuses non-object step output instead of silently scoring it zero", async () => {
    // An embedder seam handing back truthy junk must hit the guard's FIRST
    // statement — the named invalid-step-output refusal that names the run —
    // not a TypeError on the field accesses below it (or worse, a quiet zero
    // score ranked against healthy arms).
    const cases: [string, unknown][] = [
      ["numjunk", 42],
      ["strjunk", "x"],
      // Arrays pass `typeof === "object"` — they are refused explicitly too.
      ["arrjunk", ["f.ts"]],
    ];
    for (const [runId, junk] of cases) {
      const h = harness({
        arms: [{ arm: 0, runId }],
        steps: { [runId]: junk as unknown as StepFixture },
      });
      try {
        await rank(FANOUT_ID, h.deps);
        throw new Error(`expected rank to refuse a ${typeof junk} step output`);
      } catch (e) {
        expect(e).toBeInstanceOf(FleetError);
        const fe = e as FleetError;
        expect({ junkKind: typeof junk, exitCode: fe.exitCode, code: fe.code }).toEqual({
          junkKind: typeof junk,
          exitCode: 2,
          code: "invalid-step-output",
        });
        expect(fe.message).toContain(runId); // names the run before any arithmetic
        expect(fe.message).toContain("must be an object");
      }
    }
  });

  test("refuses counts past Number.MAX_SAFE_INTEGER under the same invalid-step-output code", async () => {
    // Past MAX_SAFE_INTEGER the composite arithmetic loses integrity before any
    // tie comparison could catch it — refused outright, not clamped.
    const h = harness({
      arms: [{ arm: 0, runId: "huge" }],
      steps: {
        huge: { testsExecuted: true, testResults: { passed: Number.MAX_SAFE_INTEGER + 1, failed: 0 } },
      },
    });
    try {
      await rank(FANOUT_ID, h.deps);
      throw new Error("expected rank to refuse an astronomic count");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const fe = e as FleetError;
      expect(fe.exitCode).toBe(2);
      expect(fe.code).toBe("invalid-step-output");
      expect(fe.message).toContain("non-negative integer passed/failed");
    }
  });

  test("r7-S2a: refuses testResults with testsExecuted=false as inconsistent", async () => {
    // The CLI already refuses this combo (round-6 C3); rank must refuse too,
    // so embedders calling rank() directly get the named refusal instead of a
    // silent zero score.
    const h = harness({
      arms: [{ arm: 0, runId: "notexec" }],
      steps: {
        notexec: { testsExecuted: false, testResults: { passed: 5, failed: 0 } },
      },
    });
    try {
      await rank(FANOUT_ID, h.deps);
      throw new Error("expected rank to refuse testResults with testsExecuted=false");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const fe = e as FleetError;
      expect(fe.exitCode).toBe(2);
      expect(fe.code).toBe("invalid-step-output");
      // The refusal names the offending run AND the actual diagnostic — the
      // runId deliberately does NOT collide with any word in the message, so
      // each toContain pins a distinct fragment (CodeRabbit r7 follow-up).
      expect(fe.message).toContain("notexec");
      expect(fe.message).toContain("testResults but testsExecuted is false");
    }
  });

  test("r7-S2a: refuses testResults with testsExecuted absent as inconsistent", async () => {
    // testsExecuted missing (undefined) while testResults present is the same
    // semantic inconsistency — results exist but the guard doesn't say tests ran.
    const h = harness({
      arms: [{ arm: 0, runId: "absentflag" }],
      steps: {
        absentflag: { testResults: { passed: 5, failed: 0 } },
      },
    });
    try {
      await rank(FANOUT_ID, h.deps);
      throw new Error("expected rank to refuse testResults with testsExecuted absent");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const fe = e as FleetError;
      expect(fe.exitCode).toBe(2);
      expect(fe.code).toBe("invalid-step-output");
      expect(fe.message).toContain("absentflag");
      expect(fe.message).toContain("testResults but testsExecuted is false");
    }
  });

  test("r7-S2a: accepts testResults with testsExecuted=true and scores normally", async () => {
    // Control case: the consistent combo still scores, not refused.
    const h = harness({
      arms: [{ arm: 0, runId: "consistent" }],
      steps: {
        consistent: { testsExecuted: true, testResults: { passed: 5, failed: 1 }, changedFiles: ["f.ts"] },
      },
    });
    const res = await rank(FANOUT_ID, h.deps);
    // testPassRate = 5/6 ≈ 0.833, coverage = 1 (single file, union of 1)
    // score = 0.833*0.6 + 1*0.4 ≈ 0.5 + 0.4 = 0.9
    expect(res.scores[0]?.score).toBeCloseTo(0.9, 1);
    expect(res.scores[0]?.breakdown.testPassRate).toBeCloseTo(5 / 6, 6);
    expect(res.scores[0]?.breakdown.uniqueFileCoverage).toBe(1);
  });

  test("characterization: two arms sharing one runId score identically over the deduped union", async () => {
    // CURRENT behavior, pinned: stepOutputFor is keyed by runId, so both arms
    // read the SAME output; the union Set-dedupes the repeated contribution;
    // and identical scores put the top-two delta at exactly 0 — inside the
    // inclusive tie window.
    const h = harness({
      arms: [
        { arm: 0, runId: "dup" },
        { arm: 1, runId: "dup" },
      ],
      steps: {
        dup: { testsExecuted: true, testResults: { passed: 3, failed: 1 }, changedFiles: ["a.ts", "b.ts"] },
      },
    });

    const res = await rank(FANOUT_ID, h.deps);

    expect(res.scores.map((s) => s.arm)).toEqual([0, 1]); // equals → stable by arm
    // The union counted the shared run's files ONCE ({a,b}, size 2), so each
    // arm covers ALL of it — a denominator that concatenated the repeated
    // contributions would read 2/4 here.
    for (const s of res.scores) {
      expect(s.runId).toBe("dup");
      expect(s.breakdown.testPassRate).toBeCloseTo(0.75, 10);
      expect(s.breakdown.uniqueFileCoverage).toBe(1);
      expect(s.score).toBeCloseTo(0.75 * 0.6 + 0.4, 6);
    }
    expect(res.scores[0]?.score).toBe(res.scores[1]?.score); // EXACTLY equal, not close
    expect(res.tie).toBe(true);
    expect(res.rationale).toContain("tie flagged"); // no automatic tie-break
  });
});
