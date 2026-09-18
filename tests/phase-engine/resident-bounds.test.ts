/**
 * Resident bound operand tests (Story DF3.6a, leaf-1 unit sections).
 *
 * The bounds this story owns are engine policy over numbers the engine already
 * holds — a manifest read, a projection, a comparison, a counter — and every
 * assertion here is falsifiable host-side, which is exactly the provability
 * seam the DF3.6 split cut on. The load-bearing cases:
 *
 * - AC2a: every way a stamped bound set can be INVALID refuses
 *   (missing operand, non-positive/non-integer operand, ordering violation),
 *   the equal chain is ADMITTED (`≤`, not `<`), and the ordering is NEVER
 *   asserted against this run's minted `limitMicroUsd` — that is AC2b's clamp;
 * - AC2b: a present `limitMicroUsd` below the ceiling clamps with a trace row;
 *   an absent one runs unclamped with NO refusal (absence is a normal state);
 * - the projection's per-term rounding mirrors the meter's (DD-9) and its
 *   arithmetic is pinned at the two fixture rates the e2e demo closes against
 *   (760,960 µ$ at 180.0/40.0 USD-per-MTok; 504 µ$ at 0.08/0.18);
 * - AC6: the three reachability verdicts over `2 + maxSteeringIterations ×
 *   phaseCount` structural solicitations, and the reachability row emitted
 *   exactly once at guard construction;
 * - AC1/AC3: the pre-call spend refusal arithmetic and the per-phase
 *   solicitation counter (this story's OWN counter — a proceed-loop is bounded
 *   too, which is why `telemetry.steeringIterations` is not the input here);
 * - the fill-side stamp's ladder (declared → fallback) and its dispatch-owned
 *   cap operands overwriting authored values (belt-and-braces, same shape as
 *   `stampManifestLimit`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BoundConfigError,
  DEFAULT_MAX_STEERING_ITERATIONS,
  DEFAULT_RESIDENT_SPEND_CEILING_MICROS,
  PROVISIONAL_RESIDENT_RSS_BYTES,
  createBoundsGuard,
  loadResidentBounds,
  projectWorstCaseMicros,
  stampResidentBounds,
  type ManifestWithResidentBounds,
} from "../../src/phase-engine/resident-bounds.ts";
import { PipelineManifestSchema, type LoadedManifest } from "../../src/phase-engine/manifest.ts";
import {
  MAX_OUTPUT_TOKENS,
  PROMPT_CHAR_CEILING,
  PlacementRefusedError,
  createSteering,
  type ResidentCaller,
  type SolicitCtx,
} from "../../src/phase-engine/steering.ts";
import { MAX_RETRIES } from "../../src/phase-engine/types.ts";

/** pi-catalog-bounds rates (180.0 / 40.0 USD-per-MTok) — the demo's rate. */
const FRONTIER_RATE = { inputPerMTok: 180_000_000, outputPerMTok: 40_000_000 };
/** Default fixture-catalog rates (0.08 / 0.18 USD-per-MTok) — 504 µ$/call. */
const CHEAP_RATE = { inputPerMTok: 80_000, outputPerMTok: 180_000 };
/** AC6's frontier-priced slug ($15 in / $75 out) — 136,800 µ$/call. */
const OUTRAGEOUS_RATE = { inputPerMTok: 15_000_000, outputPerMTok: 75_000_000 };

/** A schema-valid chain: ceiling 2M ≤ cap 5M ≤ defaultKeyCap 50M, 512 MiB rss. */
const CHAIN = {
  residentSpendCeilingMicros: 2_000_000,
  capMicroUsd: 5_000_000,
  defaultKeyCapMicroUsd: 50_000_000,
  residentRssBytes: 536_870_912,
};

function boundsManifest(over: Partial<ManifestWithResidentBounds> = {}): ManifestWithResidentBounds {
  return {
    version: "1.0.0",
    pipelineId: "bounds-pipeline",
    runBudgetMs: 120_000,
    phases: [
      {
        name: "plan",
        kind: "code",
        command: ["true"],
        description: "Produce the reviewed plan",
        maxDurationMs: 10_000,
        retries: 0,
      },
      {
        name: "build",
        kind: "code",
        command: ["true"],
        description: "Apply the reviewed change",
        maxDurationMs: 10_000,
        retries: 0,
      },
    ],
    ...CHAIN,
    ...over,
  };
}

function loaded(manifest: ManifestWithResidentBounds): LoadedManifest {
  return { manifest, manifestLoadMs: 1.25, resolvedPath: "/never/carried.json" };
}

/** Collects emitted rows so exact field sets are assertable. */
function sink(): { rows: Record<string, unknown>[]; emit: (line: Record<string, unknown>) => void } {
  const rows: Record<string, unknown>[] = [];
  return { rows, emit: (line) => void rows.push(line) };
}

describe("loadResidentBounds — AC2a refusals (fail-closed, INV-BND-2)", () => {
  test("a manifest missing ANY of the four operands refuses, naming the operand", () => {
    for (const key of [
      "residentSpendCeilingMicros",
      "capMicroUsd",
      "defaultKeyCapMicroUsd",
      "residentRssBytes",
    ] as const) {
      expect(() => loadResidentBounds(boundsManifest({ [key]: undefined }))).toThrow(BoundConfigError);
      expect(() => loadResidentBounds(boundsManifest({ [key]: undefined }))).toThrow(key);
    }
  });

  test("non-positive and non-integer operands refuse (safe-integer discipline)", () => {
    expect(() => loadResidentBounds(boundsManifest({ residentRssBytes: 0 }))).toThrow(BoundConfigError);
    expect(() => loadResidentBounds(boundsManifest({ residentRssBytes: -1 }))).toThrow(BoundConfigError);
    expect(() =>
      loadResidentBounds(boundsManifest({ residentSpendCeilingMicros: 2_000_000.5 })),
    ).toThrow(BoundConfigError);
    expect(() => loadResidentBounds(boundsManifest({ capMicroUsd: 5_000_000.5 }))).toThrow(BoundConfigError);
    expect(() => loadResidentBounds(boundsManifest({ defaultKeyCapMicroUsd: Number.NaN }))).toThrow(
      BoundConfigError,
    );
  });

  test("ceiling > capMicroUsd refuses; capMicroUsd > defaultKeyCapMicroUsd refuses", () => {
    expect(() =>
      loadResidentBounds(boundsManifest({ residentSpendCeilingMicros: 6_000_000, capMicroUsd: 5_000_000 })),
    ).toThrow(BoundConfigError);
    expect(() =>
      loadResidentBounds(boundsManifest({ capMicroUsd: 60_000_000, defaultKeyCapMicroUsd: 50_000_000 })),
    ).toThrow(BoundConfigError);
  });

  test("the EQUAL chain is admitted — the ordering is ≤, not < (operator ruling 2026-09-08)", () => {
    const cfg = loadResidentBounds(
      boundsManifest({
        residentSpendCeilingMicros: 5_000_000,
        capMicroUsd: 5_000_000,
        defaultKeyCapMicroUsd: 5_000_000,
      }),
    );
    expect(cfg.effectiveCeilingMicros).toBe(5_000_000);
    expect(cfg.clampRow).toBeUndefined();
  });

  test("the refusal carries the typed triple: code bound-config-invalid + non-empty remediation", () => {
    let err: BoundConfigError | undefined;
    try {
      loadResidentBounds(boundsManifest({ capMicroUsd: undefined }));
    } catch (e) {
      err = e as BoundConfigError;
    }
    expect(err).toBeInstanceOf(BoundConfigError);
    expect(err).toBeInstanceOf(Error);
    expect(err?.name).toBe("BoundConfigError");
    expect(err?.code).toBe("bound-config-invalid");
    expect(err?.remediation.length ?? 0).toBeGreaterThan(0);
  });

  test("maxSteeringIterations defaults to 3 (below MAX_RETRIES — a bound at 5 can never fire)", () => {
    expect(loadResidentBounds(boundsManifest()).maxSteeringIterations).toBe(
      DEFAULT_MAX_STEERING_ITERATIONS,
    );
    expect(loadResidentBounds(boundsManifest({ maxSteeringIterations: 1 })).maxSteeringIterations).toBe(1);
  });
});

describe("loadResidentBounds — AC2b clamp against the minted limitMicroUsd", () => {
  test("limitMicroUsd below the ceiling clamps and returns the exact clamp row", () => {
    const cfg = loadResidentBounds(boundsManifest({ limitMicroUsd: 1_500_000 }));
    expect(cfg.effectiveCeilingMicros).toBe(1_500_000);
    expect(cfg.clampRow).toEqual({
      bound: "spend",
      action: "clamped",
      configuredMicros: 2_000_000,
      limitMicroUsd: 1_500_000,
      effectiveMicros: 1_500_000,
    });
  });

  test("absent limitMicroUsd runs UNCLAMPED — no row, no refusal (a normal state)", () => {
    const cfg = loadResidentBounds(boundsManifest());
    expect(cfg.effectiveCeilingMicros).toBe(2_000_000);
    expect(cfg.clampRow).toBeUndefined();
  });

  test("limitMicroUsd at or above the ceiling is non-binding — effective stays the ceiling, NO row", () => {
    for (const limitMicroUsd of [2_000_000, 50_000_000]) {
      const cfg = loadResidentBounds(boundsManifest({ limitMicroUsd }));
      expect(cfg.effectiveCeilingMicros).toBe(2_000_000);
      expect(cfg.clampRow).toBeUndefined();
    }
  });

  test("ordering is NEVER asserted against limitMicroUsd — a limit BELOW the ceiling is a clamp, not a refusal", () => {
    // The negative control: applying check (a) to the minted cap would refuse
    // every run near its issue cap after DF2.8 already admitted it.
    const cfg = loadResidentBounds(boundsManifest({ limitMicroUsd: 100 }));
    expect(cfg.effectiveCeilingMicros).toBe(100);
    expect(cfg.clampRow?.effectiveMicros).toBe(100);
  });
});

describe("projectWorstCaseMicros — per-term rounding identical to the meter (DD-9)", () => {
  test("760,960 µ$ at the pi-catalog-bounds rate (the e2e demo's per-call figure)", () => {
    // (16000/4 × 180_000_000 + 1024 × 40_000_000) / 1e6, rounded per term:
    // 720,000 + 40,960 — the E2E Slice's pinned arithmetic.
    expect(PROMPT_CHAR_CEILING).toBe(16_000);
    expect(MAX_OUTPUT_TOKENS).toBe(1_024);
    expect(projectWorstCaseMicros(FRONTIER_RATE)).toBe(760_960);
  });

  test("504 µ$ at the default fixture-catalog rate (0.08 / 0.18 USD-per-MTok)", () => {
    // round(4000 × 80_000 / 1e6) = 320; round(1024 × 180_000 / 1e6) = 184.
    expect(projectWorstCaseMicros(CHEAP_RATE)).toBe(504);
  });

  test("a poisoned rate clamps per term — never NaN, never a throw (clampTerm discipline)", () => {
    expect(projectWorstCaseMicros({ inputPerMTok: -1, outputPerMTok: Number.NaN })).toBe(0);
    expect(projectWorstCaseMicros({ inputPerMTok: Number.NaN, outputPerMTok: 40_000_000 })).toBe(40_960);
    const garbage = projectWorstCaseMicros({
      inputPerMTok: Number.POSITIVE_INFINITY,
      outputPerMTok: Number.POSITIVE_INFINITY,
    });
    expect(Number.isFinite(garbage)).toBe(true);
    expect(Number.isNaN(garbage)).toBe(false);
  });
});

describe("createBoundsGuard — AC6 reachability, computed where the rate exists", () => {
  test("unreachable: 504/call × 8 structural solicitations fits inside the 8,000 fallback", () => {
    const cfg = loadResidentBounds(
      boundsManifest({ residentSpendCeilingMicros: DEFAULT_RESIDENT_SPEND_CEILING_MICROS }),
    );
    const { rows, emit } = sink();
    const guard = createBoundsGuard(cfg, CHEAP_RATE, 2, emit);
    expect(guard.projectedPerCallMicros).toBe(504);
    expect(guard.maxSolicitations).toBe(2 + 3 * 2);
    expect(guard.reachability).toBe("unreachable"); // 8,000 ≥ 504 × 8 = 4,032
    // The reachability row: exact field set, emitted ONCE at construction.
    expect(rows.filter((r) => r.check === "reachability")).toEqual([
      {
        bound: "spend",
        check: "reachability",
        projectedMicros: 504,
        effectiveMicros: 8_000,
        maxSolicitations: 8,
        verdict: "unreachable",
      },
    ]);
    // Later checks must not re-emit it.
    guard.check("run_start", { runId: "r1", spent: 0 });
    expect(rows.filter((r) => r.check === "reachability")).toHaveLength(1);
  });

  test("unreachable at 50,000 on the same rate (the story AC6 50k case)", () => {
    const cfg = loadResidentBounds(boundsManifest({ residentSpendCeilingMicros: 50_000 }));
    const guard = createBoundsGuard(cfg, CHEAP_RATE, 2, sink().emit);
    expect(guard.reachability).toBe("unreachable"); // 50,000 ≥ 4,032
  });

  test("binding: the ceiling sits between one call and the structural maximum", () => {
    // 504 ≤ 2,000 < 504 × 8 = 4,032 — the ceiling will bind mid-run.
    const tight = loadResidentBounds(boundsManifest({ residentSpendCeilingMicros: 2_000 }));
    expect(createBoundsGuard(tight, CHEAP_RATE, 2, sink().emit).reachability).toBe("binding");
    // The story AC6 shape: default 8,000 ceiling on a FIVE-phase manifest —
    // 504 × 17 = 8,568 > 8,000 > 504.
    const fivePhase = loadResidentBounds(boundsManifest({ residentSpendCeilingMicros: 8_000 }));
    expect(createBoundsGuard(fivePhase, CHEAP_RATE, 5, sink().emit).reachability).toBe("binding");
  });

  test("below_one_call at a frontier rate: 8,000 cannot buy one 136,800 µ$ call", () => {
    const cfg = loadResidentBounds(
      boundsManifest({ residentSpendCeilingMicros: DEFAULT_RESIDENT_SPEND_CEILING_MICROS }),
    );
    const { rows, emit } = sink();
    const guard = createBoundsGuard(cfg, OUTRAGEOUS_RATE, 2, emit);
    expect(guard.projectedPerCallMicros).toBe(136_800); // 60,000 + 76,800
    expect(guard.reachability).toBe("below_one_call");
    expect(rows[0]).toMatchObject({ check: "reachability", verdict: "below_one_call" });
    // AC6's machine-readable half: a misconfiguration is never a runaway —
    // the code rides the reachability row (never a tripwire; the cause union
    // has no member for it by design). The binding/unreachable verdicts
    // carry NO code.
    expect(rows[0]).toMatchObject({ code: "bound-config-invalid" });
  });
});

describe("createBoundsGuard.check — AC1 pre-flight spend refusal + AC3 iteration bound", () => {
  function guardWith(ceiling: number) {
    // Cap operands track the ceiling so the ordering chain never refuses for a
    // reason this describe block is not about (equal `≤` admitted).
    const cfg = loadResidentBounds(
      boundsManifest({
        residentSpendCeilingMicros: ceiling,
        capMicroUsd: Math.max(5_000_000, ceiling),
        defaultKeyCapMicroUsd: Math.max(50_000_000, ceiling),
      }),
    );
    const s = sink();
    const guard = createBoundsGuard(cfg, FRONTIER_RATE, 2, s.emit); // 760,960 µ$/call
    return { guard, ...s };
  }

  test("the bounds-check line carries the exact observability field set", () => {
    const { guard, rows } = guardWith(2_000_000);
    guard.check("run_start", { runId: "r1", requestId: "q1", spent: 0 });
    expect(rows[1]).toEqual({
      requestId: "q1",
      runId: "r1",
      phase: null,
      bound: "spend",
      spendMicros: 0,
      projectedMicros: 760_960,
      iterations: 0,
      allowed: true,
    });
  });

  test("spend refusal arithmetic: 1,521,920 + 760,960 = 2,282,880 > 2,000,000 refuses with the figures in detail", () => {
    const { guard, rows } = guardWith(2_000_000);
    const verdict = guard.check("post_gate_failure", {
      runId: "r1",
      requestId: "q2",
      phase: "build",
      spent: 1_521_920,
    });
    expect(verdict).toEqual({
      allowed: false,
      bound: "spend",
      cause: "spend_ceiling_breach",
      detail:
        "projected 760960 µ$ + spent 1521920 µ$ = 2282880 µ$ exceeds effective ceiling 2000000 µ$",
    });
    expect(rows[1]).toMatchObject({ phase: "build", bound: "spend", allowed: false, iterations: 0 });
  });

  test("allowed checks increment the per-phase counter; the 4th post_gate_failure for a max-3 phase refuses on iterations", () => {
    // Ceiling 8M keeps spend out of the picture (3 × 760,960 = 2,282,880 well
    // inside), so the iteration bound fires on its own.
    const { guard } = guardWith(8_000_000);
    const ctx = { runId: "r1", phase: "build", spent: 0 };
    expect(guard.check("post_gate_failure", ctx).allowed).toBe(true);
    expect(guard.check("post_gate_failure", { ...ctx, spent: 760_960 }).allowed).toBe(true);
    expect(guard.check("post_gate_failure", { ...ctx, spent: 1_521_920 }).allowed).toBe(true);
    expect(guard.iterations()).toEqual({ build: 3 });
    const fourth = guard.check("post_gate_failure", { ...ctx, spent: 2_282_880 });
    expect(fourth.allowed).toBe(false);
    expect(fourth).toEqual({ allowed: false, bound: "iterations" }); // NO cause — not a tripwire
    expect(guard.iterations()).toEqual({ build: 3 }); // refused ⇒ not counted
  });

  test("the iteration bound never applies at run_start / run_end (single-shot by construction)", () => {
    const { guard } = guardWith(8_000_000);
    for (let i = 0; i < 3; i++) guard.check("post_gate_failure", { runId: "r1", phase: "build", spent: 0 });
    expect(
      guard.check("run_start", { runId: "r1", phase: "build", spent: 0 }).allowed,
    ).toBe(true);
    expect(guard.check("run_end", { runId: "r1", phase: "build", spent: 0 }).allowed).toBe(true);
    // And run_start/run_end checks never count against any phase.
    expect(guard.iterations()).toEqual({ build: 3 });
  });

  test("the counter is PER PHASE: exhausting phase 'a' leaves phase 'b' solicitable", () => {
    const { guard } = guardWith(8_000_000);
    for (let i = 0; i < 3; i++) guard.check("post_gate_failure", { runId: "r1", phase: "a", spent: 0 });
    expect(guard.check("post_gate_failure", { runId: "r1", phase: "a", spent: 0 }).allowed).toBe(false);
    expect(guard.check("post_gate_failure", { runId: "r1", phase: "b", spent: 0 }).allowed).toBe(true);
    expect(guard.iterations()).toEqual({ a: 3, b: 1 });
  });
});

describe("stampResidentBounds — the fill-side stamp (ladder + dispatch-owned operands)", () => {
  test("ladder: a declared ceiling and rss survive; absent ones fall back to the shipped constants", () => {
    const stamped = stampResidentBounds(loaded(boundsManifest({ residentRssBytes: 268_435_456 })), {
      capMicroUsd: 4_000_000,
      defaultKeyCapMicroUsd: 50_000_000,
    });
    const sm = stamped.manifest as ManifestWithResidentBounds;
    expect(sm.residentSpendCeilingMicros).toBe(2_000_000); // declared rung
    expect(sm.residentRssBytes).toBe(268_435_456); // declared rung

    const bare = stampResidentBounds(
      loaded(boundsManifest({ residentSpendCeilingMicros: undefined, residentRssBytes: undefined })),
      { capMicroUsd: 4_000_000, defaultKeyCapMicroUsd: 50_000_000 },
    );
    const bm = bare.manifest as ManifestWithResidentBounds;
    expect(bm.residentSpendCeilingMicros).toBe(DEFAULT_RESIDENT_SPEND_CEILING_MICROS);
    expect(bm.residentRssBytes).toBe(PROVISIONAL_RESIDENT_RSS_BYTES);
  });

  test("authored capMicroUsd / defaultKeyCapMicroUsd are OVERWRITTEN by the dispatch values", () => {
    const stamped = stampResidentBounds(
      loaded(boundsManifest({ capMicroUsd: 999_999, defaultKeyCapMicroUsd: 999_999 })),
      { capMicroUsd: 4_000_000, defaultKeyCapMicroUsd: 50_000_000 },
    );
    const sm = stamped.manifest as ManifestWithResidentBounds;
    expect(sm.capMicroUsd).toBe(4_000_000);
    expect(sm.defaultKeyCapMicroUsd).toBe(50_000_000);
  });

  test("the stamped manifest parses against the schema and serializes all four operands", () => {
    const stamped = stampResidentBounds(loaded(boundsManifest()), {
      capMicroUsd: 4_000_000,
      defaultKeyCapMicroUsd: 50_000_000,
    });
    expect(PipelineManifestSchema.safeParse(stamped.manifest).success).toBe(true);
    const round = JSON.parse(JSON.stringify(stamped.manifest));
    for (const key of [
      "residentSpendCeilingMicros",
      "capMicroUsd",
      "defaultKeyCapMicroUsd",
      "residentRssBytes",
    ]) {
      expect(Object.hasOwn(round, key)).toBe(true);
    }
  });

  test("invalid ops refuse with BoundConfigError (positive safe integers only)", () => {
    expect(() =>
      stampResidentBounds(loaded(boundsManifest()), { capMicroUsd: 0, defaultKeyCapMicroUsd: 50_000_000 }),
    ).toThrow(BoundConfigError);
    expect(() =>
      stampResidentBounds(loaded(boundsManifest()), { capMicroUsd: 4_000_000, defaultKeyCapMicroUsd: 1.5 }),
    ).toThrow(BoundConfigError);
    expect(() =>
      stampResidentBounds(loaded(boundsManifest()), { capMicroUsd: Number.NaN, defaultKeyCapMicroUsd: 50_000_000 }),
    ).toThrow(BoundConfigError);
  });

  test("a stamped manifest that fails schema validation refuses through the zod-detail path", () => {
    // Same contract as stampManifestLimit: a schema failure leaves through
    // this module's OWN error type, never a raw ZodError. maxSteeringIterations
    // 99 exceeds the schema's MAX_RETRIES clamp — an operand no ops value can
    // rescue, so the STAMPED manifest is what fails.
    const poisoned = boundsManifest({ maxSteeringIterations: 99 });
    expect(() =>
      stampResidentBounds(loaded(poisoned), { capMicroUsd: 4_000_000, defaultKeyCapMicroUsd: 50_000_000 }),
    ).toThrow(BoundConfigError);
    expect(() =>
      stampResidentBounds(loaded(poisoned), { capMicroUsd: 4_000_000, defaultKeyCapMicroUsd: 50_000_000 }),
    ).toThrow(/stamped manifest failed validation/);
  });

  test("result: frozen, manifestLoadMs carried, resolvedPath dropped (stamped bytes match no file)", () => {
    const stamped = stampResidentBounds(loaded(boundsManifest()), {
      capMicroUsd: 4_000_000,
      defaultKeyCapMicroUsd: 50_000_000,
    });
    expect(Object.isFrozen(stamped.manifest)).toBe(true);
    expect(stamped.manifestLoadMs).toBe(1.25);
    expect(stamped.resolvedPath).toBeUndefined();
  });
});

describe("PipelineManifestSchema — the five DF3.6a fields (INV-BND-4: no ratio field)", () => {
  test("accepts all five optional fields; a non-resident manifest parses unchanged", () => {
    expect(PipelineManifestSchema.safeParse(boundsManifest({ maxSteeringIterations: 3 })).success).toBe(
      true,
    );
    // A hand-authored non-resident manifest omits every bound field — the
    // schema must not have made any of them required.
    const {
      residentSpendCeilingMicros: _c,
      capMicroUsd: _m,
      defaultKeyCapMicroUsd: _k,
      residentRssBytes: _r,
      ...nonResident
    } = boundsManifest();
    expect(PipelineManifestSchema.safeParse(nonResident).success).toBe(true);
  });

  test("a ratio-shaped key is a parse rejection (.strict()), never a tolerated extra", () => {
    expect(
      PipelineManifestSchema.safeParse(boundsManifest({ residentSpendPercent: 15 } as Partial<ManifestWithResidentBounds>))
        .success,
    ).toBe(false);
  });

  test("maxSteeringIterations is clamped to MAX_RETRIES; 0 is a legal bound", () => {
    expect(PipelineManifestSchema.safeParse(boundsManifest({ maxSteeringIterations: 0 })).success).toBe(true);
    expect(
      PipelineManifestSchema.safeParse(boundsManifest({ maxSteeringIterations: MAX_RETRIES + 1 })).success,
    ).toBe(false);
    expect(PipelineManifestSchema.safeParse(boundsManifest({ maxSteeringIterations: -1 })).success).toBe(
      false,
    );
  });

  test("negative / float / zero bound operands fail schema parse (positive ints only)", () => {
    expect(PipelineManifestSchema.safeParse(boundsManifest({ residentSpendCeilingMicros: -1 })).success).toBe(
      false,
    );
    expect(PipelineManifestSchema.safeParse(boundsManifest({ capMicroUsd: 1.5 })).success).toBe(false);
    expect(PipelineManifestSchema.safeParse(boundsManifest({ residentRssBytes: 0 })).success).toBe(false);
  });
});

// leaf-6: integration + e2e sections append below

// ---------------------------------------------------------------------------
// leaf-6 PART B — integration: the bounds seam through `createSteering`, the
// composition the runner actually wires (guard → steering deps). Local helpers
// follow steering.test.ts's scriptedCaller/ctx idiom; the leaf-1 fixtures
// (boundsManifest/CHAIN/rates) above are reused as-is.
// ---------------------------------------------------------------------------

/** One scripted caller step: a raw reply (with optional usage), a reply whose
 *  usage object is ABSENT (AC4's fail-open arm — scriptedCaller's default is
 *  the literal {0,0}, a different case), or a throw. */
interface Step {
  raw?: string;
  usage?: { inputTokens: number; outputTokens: number };
  absentUsage?: boolean;
  error?: Error;
}

function stepCaller(steps: Step[]) {
  const prompts: string[] = [];
  let calls = 0;
  const caller: ResidentCaller = {
    async call(prompt: string) {
      prompts.push(prompt);
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls += 1;
      if (step.error !== undefined) throw step.error;
      const usage =
        step.absentUsage === true
          ? // The port type demands the key; the ENGINE's meter contract is
            // `| undefined` and that is the arm under test — the cast is the
            // seam, not a lie about production (resident.ts can return a reply
            // whose harvest found no message_end).
            (undefined as unknown as { inputTokens: number; outputTokens: number })
          : (step.usage ?? { inputTokens: 0, outputTokens: 0 });
      return { raw: step.raw ?? '{"action":"proceed"}', usage };
    },
  };
  return { caller, prompts, calls: () => calls };
}

const ictx = (over: Partial<SolicitCtx> = {}): SolicitCtx => ({
  runId: "run-b",
  requestId: "req-b",
  promptContext: ["brief: fix the assertion"],
  ...over,
});

/** The onBoundBreach event shape steering fires (steering.ts's dep, spelled
 *  out so the capture arrays below type cleanly). */
interface BoundBreachEvent {
  bound: "spend" | "rss";
  allowed: false;
  cause: string;
  exitCode?: number;
  runId: string;
  requestId?: string;
  phase?: string;
}

/** Compose guard + steering exactly as the runner does, capturing the bounds
 *  lines, the DF2.12 attribution rows, and (optionally) onBoundBreach. */
function steeringWith(opts: {
  ceiling: number;
  rate: { inputPerMTok: number; outputPerMTok: number };
  caller: ResidentCaller;
  onBoundBreach?: (e: BoundBreachEvent) => void | Promise<void>;
}) {
  // Cap operands track the ceiling so the ordering chain never refuses for a
  // reason these sections are not about (equal `<=` admitted).
  const cfg = loadResidentBounds(
    boundsManifest({
      residentSpendCeilingMicros: opts.ceiling,
      capMicroUsd: Math.max(5_000_000, opts.ceiling),
      defaultKeyCapMicroUsd: Math.max(50_000_000, opts.ceiling),
    }),
  );
  const boundsRows: Record<string, unknown>[] = [];
  const guard = createBoundsGuard(cfg, opts.rate, 2, (line) => void boundsRows.push(line));
  const attributionRows: Record<string, unknown>[] = [];
  const steering = createSteering({
    caller: opts.caller,
    rate: opts.rate,
    bounds: guard,
    emitAttribution: (line) => void attributionRows.push(line),
    ...(opts.onBoundBreach === undefined ? {} : { onBoundBreach: opts.onBoundBreach }),
  });
  return { steering, boundsRows, attributionRows, guard };
}

describe("integration (leaf-6) — AC1: the pre-flight refusal through createSteering", () => {
  test("spend at ceiling−ε: the 3rd solicitation issues NO call, stops the resident, and never exceeds the ceiling", async () => {
    // The E2E Slice's arithmetic, unit-composed: FRONTIER rate projects
    // 760,960 µ$/call and the caller's usage (4000/1024) meters exactly the
    // same — metered per call equals projected per call by construction.
    const s = stepCaller([
      { usage: { inputTokens: 4_000, outputTokens: 1_024 } },
      { usage: { inputTokens: 4_000, outputTokens: 1_024 } },
      { usage: { inputTokens: 4_000, outputTokens: 1_024 } },
    ]);
    const { steering } = steeringWith({ ceiling: 2_000_000, rate: FRONTIER_RATE, caller: s.caller });

    const pgf = () => ictx({ phase: "build" });
    expect((await steering.solicit("post_gate_failure", pgf())).action).toBe("proceed");
    expect(steering.telemetry.spendMicros).toBe(760_960); // < ceiling, strictly
    expect((await steering.solicit("post_gate_failure", pgf())).action).toBe("proceed");
    expect(steering.telemetry.spendMicros).toBe(1_521_920); // still < ceiling
    expect(s.calls()).toBe(2);

    // The refusal point: 1,521,920 + 760,960 = 2,282,880 > 2,000,000.
    expect((await steering.solicit("post_gate_failure", pgf())).action).toBe("proceed");
    const t = steering.telemetry;
    expect(t.status).toBe("stopped");
    // NEGATIVE CONTROL (the shape that catches post-hoc metering): the refusal
    // happened BEFORE the third call — an implementation that meters only
    // after the call shows 3 issued calls and an overshot accumulator.
    expect(s.calls()).toBe(2);
    expect(t.spendMicros).toBe(1_521_920);
    expect(t.spendMicros).toBeLessThan(2_000_000);
    // The tripwire: full row with the projected + cumulative figures.
    expect(t.tripwires).toHaveLength(1);
    expect(t.tripwires[0]).toMatchObject({
      runId: "run-b",
      requestId: "req-b",
      cause: "spend_ceiling_breach",
      phase: "build",
    });
    expect(t.tripwires[0]?.detail).toContain("760960");
    expect(t.tripwires[0]?.detail).toContain("1521920");
    expect(t.tripwires[0]?.detail).toContain("2282880");
    expect(t.tripwires[0]?.detail).toContain("2000000");

    // Stopped is terminal for the conversation: later solicitations resolve
    // PROCEED through the status gate with NO further calls or rows.
    expect((await steering.solicit("run_end", ictx({ phase: "build" }))).action).toBe("proceed");
    expect(s.calls()).toBe(2);
    expect(steering.telemetry.tripwires).toHaveLength(1);
  });

  test("pre-correction re-gate: a malformed reply that meters past the headroom never gets its correction call", async () => {
    // Self-review fix (AC1's margin): ONE solicitation bills up to two calls
    // (reply + malformed correction), and the SEAM check gated only the
    // first. Here the malformed reply carries 8,106 input tokens — it meters
    // 1,500,040 where its 760,960 projection promised headroom — so by the
    // time the correction would issue, spent (2,261,000) + projection already
    // crosses the ceiling. The re-gate refuses the correction, stops the
    // resident for spend (the proximate cause), and the one-call margin holds:
    // overshoot is bounded by the LAST issued call's metered-minus-projected.
    const s = stepCaller([
      { usage: { inputTokens: 4_000, outputTokens: 1_024 } },
      { raw: "not json at all", usage: { inputTokens: 8_106, outputTokens: 1_024 } },
      { usage: { inputTokens: 4_000, outputTokens: 1_024 } },
    ]);
    const { steering } = steeringWith({ ceiling: 2_000_000, rate: FRONTIER_RATE, caller: s.caller });

    const pgf = () => ictx({ phase: "build" });
    expect((await steering.solicit("post_gate_failure", pgf())).action).toBe("proceed");
    expect(steering.telemetry.spendMicros).toBe(760_960);
    expect((await steering.solicit("post_gate_failure", pgf())).action).toBe("proceed");
    const t = steering.telemetry;
    expect(t.status).toBe("stopped");
    // Exactly TWO calls: the reply and its unparseable correction were one
    // solicitation, but the correction was REFUSED — a post-hoc-only
    // implementation (or one without the re-gate) issues the third call.
    expect(s.calls()).toBe(2);
    expect(t.spendMicros).toBe(2_261_000); // 760,960 + 1,500,040 — ≤ ceiling + one call's overshoot
    expect(t.tripwires).toHaveLength(1);
    expect(t.tripwires[0]).toMatchObject({ cause: "spend_ceiling_breach", phase: "build" });
    expect(t.tripwires[0]?.detail).toContain("pre-correction re-gate");
  });
});

describe("integration (leaf-6) — AC4: zero-usage replies charge the projection, never the ledger", () => {
  test("a reply with NO usage object: accumulator += projection, attribution row stays unpriced", async () => {
    const s = stepCaller([{ absentUsage: true }]);
    const { steering, attributionRows } = steeringWith({
      ceiling: 2_000_000,
      rate: FRONTIER_RATE,
      caller: s.caller,
    });
    expect((await steering.solicit("run_start", ictx())).action).toBe("proceed");
    // INV-BND-3: the ceiling accumulator charged the projected worst case
    // (760,960), never zero — a silent resident cannot zero its own meter.
    expect(steering.telemetry.spendMicros).toBe(760_960);
    // The DF2.12 row keeps its shipped METERED disposition: absent usage is
    // recorded UNPRICED (fail-closed), and the ledger never carries the
    // projection — one spend truth per basis.
    expect(attributionRows).toHaveLength(1);
    expect(attributionRows[0]).toMatchObject({ role: "resident", unpricedTurns: 1 });
    expect(attributionRows[0]?.costMicroUsd).toBe(0);
  });

  test("a literal {0,0} reply: accumulator += projection, attribution row priced-zero", async () => {
    // "no usage field" is unreachable in production (every shipped caller
    // normalises to numbers) — the zero-shape reply is the path INV-BND-3
    // exists to close, so it must fail an implementation that only guards the
    // absent-object shape.
    const s = stepCaller([{ usage: { inputTokens: 0, outputTokens: 0 } }]);
    const { steering, attributionRows } = steeringWith({
      ceiling: 2_000_000,
      rate: FRONTIER_RATE,
      caller: s.caller,
    });
    expect((await steering.solicit("run_start", ictx())).action).toBe("proceed");
    expect(steering.telemetry.spendMicros).toBe(760_960);
    expect(attributionRows).toHaveLength(1);
    expect(attributionRows[0]).toMatchObject({ role: "resident", unpricedTurns: 0 });
    // Priced-zero (absence of money is not absence of evidence) — and still
    // NEVER the projection.
    expect(attributionRows[0]?.costMicroUsd).toBe(0);
  });

  test("a POSITIVE-token reply that merely ROUNDS to 0 µ$ is genuinely priced — no projection charge", async () => {
    // Self-review fix (AC4's letter): 3 input tokens at the default-catalog
    // rate (80,000 µ$/MTok) price to round(3 × 0.08) = 0 µ$ — a real, billed,
    // sub-micro-dollar call. Charging it the 504 µ$ projection would stop a
    // cheap-call resident far below the ceiling; only the no-positive-usage
    // shapes (absent / {0,0} / garbage) carry the fail-safe charge.
    const s = stepCaller([{ usage: { inputTokens: 3, outputTokens: 0 } }]);
    const { steering, attributionRows } = steeringWith({
      ceiling: 2_000_000,
      rate: { inputPerMTok: 80_000, outputPerMTok: 180_000 },
      caller: s.caller,
    });
    expect((await steering.solicit("run_start", ictx())).action).toBe("proceed");
    expect(steering.telemetry.spendMicros).toBe(0); // metered 0 — NOT the 504 projection
    expect(attributionRows[0]).toMatchObject({ role: "resident", unpricedTurns: 0 });
    expect(attributionRows[0]?.costMicroUsd).toBe(0);
  });
});

describe("integration (leaf-6) — AC5: precedence against an already-degraded resident", () => {
  test("degrade at solicitation 2, would-breach at 4: 'degraded' stands, no tripwire, no post-latch bounds line", async () => {
    // CONSTRUCTION (revised twice for the pre-correction re-gate): the degrade
    // must latch with spend ALREADY inside would-breach range, and the only
    // meter that can land there AFTER the re-gate is the malformed limit's
    // SECOND call overshooting its projection (the soft-ceiling case AC1's
    // margin exists for): the first malformed call is tiny (re-gate passes),
    // the correction call carries 8,106 input tokens and meters 1,500,040 —
    // past what its 760,960 projection promised, straight through the
    // remaining headroom. Attempt 2 is still malformed, so the DEGRADE latch
    // fires — with spendMicros 2,263,200, already past the ceiling a later
    // check would refuse on. (A plain call failure cannot build this state:
    // it meters nothing, and the SEAM check at the failing solicitation would
    // have to pass, which pins later checks below the boundary too.)
    const s = stepCaller([
      { raw: '{"action":"proceed"}', usage: { inputTokens: 4_000, outputTokens: 1_024 } },
      { raw: "not json at all", usage: { inputTokens: 10, outputTokens: 10 } },
      { raw: "still not json", usage: { inputTokens: 8_106, outputTokens: 1_024 } },
    ]);
    const { steering, boundsRows } = steeringWith({
      ceiling: 2_000_000,
      rate: FRONTIER_RATE,
      caller: s.caller,
    });

    // Solicitation 1: check passes (0 + 760,960 <= 2,000,000), meters 760,960.
    expect((await steering.solicit("post_gate_failure", ictx({ phase: "build" }))).action).toBe("proceed");
    expect(steering.telemetry.spendMicros).toBe(760_960);
    expect(s.calls()).toBe(1);

    // Solicitation 2: check passes (760,960 + 760,960 <= 2,000,000); the
    // malformed pair bills twice — tiny first (760,960+2,200, re-gate passes:
    // 763,160 + 760,960 <= 2,000,000), then the correction overshoots to
    // 763,160 + 1,500,040 = 2,263,200 — and the limit latches the degrade.
    expect((await steering.solicit("post_gate_failure", ictx({ phase: "build" }))).action).toBe("proceed");
    expect(steering.telemetry.status).toBe("degraded");
    expect(steering.telemetry.spendMicros).toBe(2_263_200);
    expect(s.calls()).toBe(3);

    // Solicitations 3 and 4: the status gate precedes the bounds check, so a
    // would-breach point 4 (2,263,200 + 760,960 > 2,000,000) never evaluates
    // the bound at all — the ABSENCE of the line is the mechanism's guarantee.
    expect((await steering.solicit("post_gate_failure", ictx({ phase: "build" }))).action).toBe("proceed");
    expect((await steering.solicit("post_gate_failure", ictx({ phase: "build" }))).action).toBe("proceed");
    const t = steering.telemetry;
    // "stopped" wins only when this story's enforcement is the proximate
    // cause — a bound that never fired cannot overwrite the latch.
    expect(t.status).toBe("degraded");
    expect(t.tripwires).toEqual([]); // no spend_ceiling_breach row exists
    expect(s.calls()).toBe(3); // no post-latch calls either
    // Exactly one reachability row + two allowed check lines; NOTHING after
    // the degrade — an implementation hoisting the check above the status
    // gate emits a third (refused) line here and fails.
    expect(boundsRows.filter((r) => r.check === "reachability")).toHaveLength(1);
    expect(boundsRows.filter((r) => r.check === undefined && r.allowed === true)).toHaveLength(2);
    expect(boundsRows.filter((r) => r.check === undefined && r.allowed === false)).toHaveLength(0);
  });
});

describe("integration (leaf-6) — AC6: below_one_call stops at construction, never as a breach", () => {
  test("frontier rate vs the 8,000 fallback: stopped BEFORE the first solicitation, reachability row is the only emission", async () => {
    const s = stepCaller([{ usage: { inputTokens: 4_000, outputTokens: 1_024 } }]);
    const { steering, boundsRows } = steeringWith({
      ceiling: DEFAULT_RESIDENT_SPEND_CEILING_MICROS,
      rate: OUTRAGEOUS_RATE, // 136,800 µ$/call — the ceiling cannot buy one
      caller: s.caller,
    });
    // From CONSTRUCTION, before any solicit — a misconfiguration is a policy
    // outcome, not a runaway.
    expect(steering.telemetry.status).toBe("stopped");
    expect((await steering.solicit("run_start", ictx())).action).toBe("proceed");
    expect(s.calls()).toBe(0); // the refusal precedes the call
    expect(steering.telemetry.tripwires).toEqual([]); // NO spend_ceiling_breach row
    expect(steering.telemetry.spendMicros).toBe(0);
    // The reachability row is the ONLY bounds emission — every later
    // solicitation exits at the status gate before check() runs.
    expect(boundsRows).toHaveLength(1);
    expect(boundsRows[0]).toMatchObject({
      check: "reachability",
      projectedMicros: 136_800,
      effectiveMicros: DEFAULT_RESIDENT_SPEND_CEILING_MICROS,
      verdict: "below_one_call",
    });
  });
});

describe("integration (leaf-6) — onBoundBreach: the sidecar the runner stops the spawn on", () => {
  test("a spend breach fires it exactly once with the full event; a THROWING observer never fails the solicitation", async () => {
    // (a) the capture arm: the observer contract the runner's stop rides on.
    {
      const breaches: BoundBreachEvent[] = [];
      const s = stepCaller([
        { usage: { inputTokens: 4_000, outputTokens: 1_024 } },
        { usage: { inputTokens: 4_000, outputTokens: 1_024 } },
      ]);
      const { steering } = steeringWith({
        ceiling: 2_000_000,
        rate: FRONTIER_RATE,
        caller: s.caller,
        onBoundBreach: (e) => {
          breaches.push(e);
        },
      });
      const pgf = () => ictx({ phase: "build" });
      await steering.solicit("post_gate_failure", pgf());
      await steering.solicit("post_gate_failure", pgf());
      await steering.solicit("post_gate_failure", pgf()); // refused
      expect(breaches).toEqual([
        {
          bound: "spend",
          allowed: false,
          cause: "spend_ceiling_breach",
          runId: "run-b",
          requestId: "req-b",
          phase: "build",
        },
      ]);
      // Once only: the status gate refuses every later solicitation before
      // the bound can re-fire.
      await steering.solicit("run_end", ictx({ phase: "build" }));
      expect(breaches).toHaveLength(1);
    }
    // (b) the sidecar rule: a throwing observer loses only the push — the
    // stop, the tripwire and the PROCEED resolution all still happen.
    {
      const s = stepCaller([
        { usage: { inputTokens: 4_000, outputTokens: 1_024 } },
        { usage: { inputTokens: 4_000, outputTokens: 1_024 } },
      ]);
      const { steering } = steeringWith({
        ceiling: 2_000_000,
        rate: FRONTIER_RATE,
        caller: s.caller,
        onBoundBreach: () => {
          throw new Error("observer sink is down");
        },
      });
      const pgf = () => ictx({ phase: "build" });
      await steering.solicit("post_gate_failure", pgf());
      await steering.solicit("post_gate_failure", pgf());
      expect((await steering.solicit("post_gate_failure", pgf())).action).toBe("proceed");
      expect(steering.telemetry.status).toBe("stopped");
      expect(steering.telemetry.tripwires).toHaveLength(1);
    }
  });

  test("PlacementRefusedError: stopped (never degraded), onBoundBreach carries the exit-97 unenforceable arm", async () => {
    const breaches: BoundBreachEvent[] = [];
    const s = stepCaller([{ error: new PlacementRefusedError() }]);
    const { steering } = steeringWith({
      ceiling: 8_000_000,
      rate: FRONTIER_RATE,
      caller: s.caller,
      onBoundBreach: (e) => {
        breaches.push(e);
      },
    });
    expect((await steering.solicit("run_start", ictx())).action).toBe("proceed");
    const t = steering.telemetry;
    // Stopped FIRST (the proximate cause is the placement failure, not a call
    // failure) — the classify-by-type arm can never fall through to the
    // degrade write, where a stopped resident would be re-labeled "degraded".
    expect(t.status).toBe("stopped");
    expect(steering.lastDegradationReason).toBeNull(); // NO degrade write
    expect(t.tripwires).toEqual([]); // not a spend breach — no tripwire row
    expect(breaches).toEqual([
      {
        bound: "rss",
        allowed: false,
        cause: "unenforceable",
        exitCode: 97,
        runId: "run-b",
        requestId: "req-b",
        phase: undefined,
      },
    ]);
    // Terminal: the next solicitation is refused by the status gate alone.
    expect((await steering.solicit("post_gate_failure", ictx({ phase: "build" }))).action).toBe("proceed");
    expect(breaches).toHaveLength(1);
    expect(s.calls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// leaf-6 PART C — e2e: `bun scripts/pipeline-run.ts` for real, the DF3.3
// harness mechanics (spawnRunner/runLeg) copied locally because the host
// file's are module-private. Every leg gets its own dir (also its TMPDIR, so
// the bounds fixture's FIXED counter name `qds-bounds-count` cannot leak
// between legs) and is cleaned in finally.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "pipeline-run.ts");
const E2E_FIXTURES = path.join(import.meta.dir, "fixtures");
const BOUNDS_FIXTURE = path.join(E2E_FIXTURES, "pipeline.bounds.json");
const BOUNDS_CATALOG = path.join(E2E_FIXTURES, "pi-catalog-bounds");
const DEFAULT_CATALOG = path.join(E2E_FIXTURES, "pi-catalog");
const FAKE_PI = path.join(E2E_FIXTURES, "fake-resident.ts");
/** The bounds fixture's testCommand counts attempts in $TMPDIR under this name. */
const BOUNDS_COUNT_NAME = "qds-bounds-count";

const e2eRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df3-6a-e2e-")));

const PROCEED_ONLY = [JSON.stringify({ action: "proceed" })];

/** The journal as the e2e reads it — the read-side view of the DOD's fields. */
interface E2eJournal {
  version: string;
  runId: string;
  ok: boolean;
  completedAt?: string;
  phases: Array<{ name: string; status: string }>;
  gateEvents: Array<{ phase?: string; type?: string; attempt?: number }>;
  resident?: {
    status: string;
    directives: number;
    directivesRejected: number;
    steeringIterations: Record<string, number>;
    spendMicros: number;
    exitStatus: string | null;
    tripwires: Array<{ runId: string; cause: string; phase?: string; detail: string }>;
  };
}

/** Parsed JSON-object stderr lines with an `event` field (the runner's own). */
function jsonLines(stderr: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of stderr.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const row = JSON.parse(t) as Record<string, unknown>;
      if (typeof row.event === "string") parsed.push(row);
    } catch {
      /* relayed child noise that merely starts with "{" */
    }
  }
  return parsed;
}

/** The runner's bounds observability rows (guard lines ride event resident_bounds). */
const boundsLines = (stderr: string): Record<string, unknown>[] =>
  jsonLines(stderr).filter((l) => l.event === "resident_bounds");
const reachabilityRow = (stderr: string): Record<string, unknown> | undefined =>
  boundsLines(stderr).find((l) => l.check === "reachability");
const checkLines = (stderr: string): Record<string, unknown>[] =>
  boundsLines(stderr).filter((l) => l.check === undefined);

/** Fake-pi invocation markers in the session file — the ground truth for how
 *  many solicitation CALLS actually issued (a status-gated or bound-refused
 *  solicitation still emits its resident_solicit line; only a real call
 *  appends a marker). */
function piCalls(dir: string, runId: string): number {
  try {
    return fs
      .readFileSync(path.join(dir, `${runId}.resident.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l.includes('"fake_resident_invocation"')).length;
  } catch {
    return 0;
  }
}

function spawnRunner(
  args: string[],
  markerRoot: string,
  tmpDir: string,
  env: Record<string, string>,
) {
  // `process.execPath`, not "bun": a sibling suite that rewrites PATH must not
  // decide which runtime this spawns (the resident-e2e harness rule).
  return Bun.spawn({
    cmd: [process.execPath, RUNNER, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      QDS_RUN_ROOT: markerRoot,
      QDS_PI_BIN: FAKE_PI,
      // The catalog selects the rate — bounds (180/40, projection 760,960) or
      // default (0.08/0.18, projection 504) — so it rides the per-leg env.
      QDS_PI_CATALOG_DIR: BOUNDS_CATALOG,
      // #219 / INV-RES-3: the arming key gate asserts presence regardless of
      // whether the fake pi needs a real one.
      OPENROUTER_API_KEY: "sk-or-v1-df36a-e2e-fixture-key-000000111111",
      // S2-4's child-env allowlist escape hatch — the fake pi's scripting knobs.
      QDS_RESIDENT_ENV_PASSTHROUGH:
        "FAKE_RESIDENT_REPLIES,FAKE_RESIDENT_USAGE,FAKE_RESIDENT_EXIT,FAKE_RESIDENT_HANG,FAKE_RESIDENT_HANG_AT,FAKE_RESIDENT_ECHO_ENV",
      TMPDIR: tmpDir,
      // ENOENT is the sanctioned empty rate registry.
      QDS_PI_MODELS_JSON: path.join(tmpDir, "no-such-models.json"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** One e2e leg: fresh dir, manifest + dispatch witness, reset counter, run. */
async function boundsLeg(
  name: string,
  opts: {
    runId: string;
    manifest: Record<string, unknown>;
    catalogDir: string;
    witnessOver?: Record<string, unknown>;
    env?: Record<string, string>;
    budgetMs?: number;
  },
): Promise<{ dir: string; runId: string; journal: E2eJournal; exitCode: number; stderr: string }> {
  const dir = path.join(e2eRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "pipeline.bounds.json");
  fs.writeFileSync(manifestPath, JSON.stringify(opts.manifest));
  const requestId = crypto.randomUUID();
  // The brief IS the cap witness (one file, two readers): arming fields for
  // the resident, positive effectiveCeilingMicros for the cap reader. The
  // ceiling value feeds the HARNESS cap only — the resident bound is the
  // manifest's, and limitMicroUsd (the clamp input) is whatever the manifest
  // declares, reconciled against this same field.
  fs.writeFileSync(
    path.join(dir, "run-context.json"),
    JSON.stringify({
      runId: opts.runId,
      pipelineId: "df3-6a-e2e",
      requestId,
      repoSlug: "qds/demo",
      issueId: 42,
      effectiveCeilingMicros: 250_000,
      ...opts.witnessOver,
    }),
  );
  const counter = path.join(dir, BOUNDS_COUNT_NAME);
  fs.rmSync(counter, { force: true }); // a fresh leg starts at attempt 1
  const markerRoot = path.join(dir, "marker");
  const journalPath = path.join(dir, "out.json");
  const proc = spawnRunner(
    [
      "--manifest", manifestPath,
      "--budget-ms", String(opts.budgetMs ?? 120_000),
      "--journal", journalPath,
      "--run-root", dir,
      "--run-id", opts.runId,
      "--request-id", requestId,
    ],
    markerRoot,
    dir,
    {
      QDS_PI_CATALOG_DIR: opts.catalogDir,
      FAKE_RESIDENT_REPLIES: JSON.stringify(PROCEED_ONLY),
      ...(opts.env ?? {}),
    },
  );
  try {
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), // drained: piped-but-undrained fds deadlock
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let journal: E2eJournal;
    try {
      journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as E2eJournal;
    } catch (err) {
      throw new Error(
        `journal ${journalPath} unreadable after exit ${exitCode}: ${(err as Error).message}\n` +
          `stderr tail: ${stderr.slice(-2000)}`,
        { cause: err },
      );
    }
    return { dir, runId: opts.runId, journal, exitCode, stderr };
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    fs.rmSync(counter, { force: true });
  }
}

/** The shipped bounds fixture's manifest body, optionally patched. */
function boundsManifestBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(JSON.parse(fs.readFileSync(BOUNDS_FIXTURE, "utf8")) as Record<string, unknown>), ...patch };
}

describe("e2e (leaf-6) — the mandatory demo: projection-driven refusal, run still deterministic", () => {
  test("pipeline.bounds.json + pi-catalog-bounds + pinned usage: stopped at 1,521,960 with a full tripwire, run ok", async () => {
    const leg = await boundsLeg("demo", {
      runId: "bounds-demo-run",
      manifest: boundsManifestBody(),
      catalogDir: BOUNDS_CATALOG,
      // The pin that makes metered per call equal projected per call BY
      // CONSTRUCTION: the fake pi's reported usage is the projection's own
      // shape (PROMPT_CHAR_CEILING/4, MAX_OUTPUT_TOKENS).
      env: { FAKE_RESIDENT_USAGE: JSON.stringify({ input: 4000, output: 1024 }) },
    });
    const j = leg.journal;
    const r = j.resident;

    // (d) The run COMPLETED: build passes on attempt 5, verify passes, exit 0.
    expect(leg.exitCode).toBe(0);
    expect(j.ok).toBe(true);
    expect(j.phases.map((p) => [p.name, p.status])).toEqual([
      ["build", "success"],
      ["verify", "success"],
    ]);
    expect(
      j.gateEvents
        .filter((e) => e.phase === "build")
        .map((e) => ({ type: e.type, attempt: e.attempt })),
    ).toEqual([
      { type: "gate_fail", attempt: 1 },
      { type: "gate_fail", attempt: 2 },
      { type: "gate_fail", attempt: 3 },
      { type: "gate_fail", attempt: 4 },
      { type: "gate_pass", attempt: 5 },
    ]);

    // (a) + (b) The resident stopped with metered spend strictly under the
    // ceiling: 760,960 x 2 metered calls.
    expect(r?.status).toBe("stopped");
    expect(r?.spendMicros).toBe(1_521_920);
    expect(r?.spendMicros ?? 0).toBeLessThan(2_000_000);

    // (c) The tripwire: full shipped shape, phase "build", detail carrying
    // the projected (760,960), cumulative (1,521,920), would-be (2,282,880)
    // and ceiling (2,000,000) figures.
    expect(r?.tripwires).toHaveLength(1);
    expect(r?.tripwires[0]).toMatchObject({
      runId: "bounds-demo-run",
      cause: "spend_ceiling_breach",
      phase: "build",
    });
    for (const figure of ["760960", "1521920", "2282880", "2000000"]) {
      expect(r?.tripwires[0]?.detail).toContain(figure);
    }

    // (e) The refusal is projection-driven and PRE-CALL: exactly two pi calls
    // (run_start + the FIRST post_gate_failure) — the second post-gate point
    // never issued one. The session markers are the call ground truth; the
    // bounds lines carry the verdict sequence as [phase, bound, allowed,
    // spendMicros, iterations]: allow at run_start, allow at gate point 1,
    // then the spend refusal at gate point 2 — and NOTHING after (points 3-4
    // and run_end exit at the status gate before check() runs).
    expect(piCalls(leg.dir, leg.runId)).toBe(2);
    expect(
      checkLines(leg.stderr).map((l) => [l.phase, l.bound, l.allowed, l.spendMicros, l.iterations]),
    ).toEqual([
      [null, "spend", true, 0, 0], // run_start — allowed, called
      ["build", "spend", true, 760_960, 1], // gate point 1 — allowed, called, counted
      ["build", "spend", false, 1_521_920, 1], // gate point 2 — REFUSED, never called, NOT counted
    ]);
    // The solicitation LINES exist at every point (a refused solicitation
    // still resolves PROCEED); what never happened is the CALL. Cumulative
    // spend on every line stays pinned at the two-call figure — strictly
    // under the ceiling at every observation.
    const solicitLines = jsonLines(leg.stderr).filter((l) => l.event === "resident_solicit");
    expect(solicitLines.map((l) => l.point)).toEqual([
      "run_start",
      "post_gate_failure",
      "post_gate_failure",
      "post_gate_failure",
      "post_gate_failure",
      "run_end",
    ]);
    for (const line of solicitLines) {
      expect(line.spendMicros as number).toBeLessThanOrEqual(1_521_920);
    }
    const breach = jsonLines(leg.stderr).find((l) => l.event === "resident_bound_breach");
    expect(breach).toMatchObject({
      bound: "spend",
      allowed: false,
      cause: "spend_ceiling_breach",
      phase: "build",
    });

    // (f) The reachability row: binding — 760,960 x 8 structural solicitations
    // (6,087,680) sits above the 2,000,000 effective ceiling, which itself
    // still buys one call (2,000,000 >= 760,960).
    expect(reachabilityRow(leg.stderr)).toMatchObject({
      bound: "spend",
      check: "reachability",
      projectedMicros: 760_960,
      effectiveMicros: 2_000_000,
      maxSolicitations: 8,
      verdict: "binding",
    });
    // And nothing else fired: no clamp (the fixture declares no limitMicroUsd
    // — INV-BND-2's absence state), no config refusal.
    expect(jsonLines(leg.stderr).some((l) => l.event === "resident_bounds_clamped")).toBe(false);
    expect(jsonLines(leg.stderr).some((l) => l.event === "resident_bounds_invalid")).toBe(false);
  }, 120_000);
});

describe("e2e (leaf-6) — AC3: the per-phase iteration bound fires through the runner", () => {
  test("4th post_gate_failure point not solicited, attempt 5 passes, run_end still calls, status stays active", async () => {
    // The DEFAULT catalog (~504 µ$/call projected, 92 µ$/call metered) funds
    // every point far inside the 2M ceiling, so the only bound that can fire
    // on the fixture is the iteration one — exactly the isolation AC3's
    // producible trigger demands.
    const leg = await boundsLeg("iteration", {
      runId: "bounds-iteration-run",
      manifest: boundsManifestBody(),
      catalogDir: DEFAULT_CATALOG,
      // no FAKE_RESIDENT_USAGE: the fixture default (1000/64) meters 92 µ$/call
    });
    const j = leg.journal;
    const r = j.resident;

    expect(leg.exitCode).toBe(0);
    expect(j.ok).toBe(true);
    expect(j.phases.map((p) => [p.name, p.status])).toEqual([
      ["build", "success"],
      ["verify", "success"],
    ]);

    // Exactly THREE post_gate_failure calls issued (points 1-3); the 4th was
    // refused by the iteration bound BEFORE the call. Markers: run_start +
    // 3 gated calls + run_end = 5. The full check sequence as [phase, bound,
    // allowed, iterations]: the per-phase counter climbs 1-2-3 across build's
    // gate points, the 4th point refuses on "iterations" (never on spend),
    // and run_end — phase "verify", a DIFFERENT phase — checks and calls
    // normally: the bound is per phase, not per run.
    expect(piCalls(leg.dir, leg.runId)).toBe(5);
    expect(
      checkLines(leg.stderr).map((l) => [l.phase, l.bound, l.allowed, l.iterations]),
    ).toEqual([
      [null, "spend", true, 0], // run_start
      ["build", "spend", true, 1], // gate point 1 — called
      ["build", "spend", true, 2], // gate point 2 — called
      ["build", "spend", true, 3], // gate point 3 — called
      ["build", "iterations", false, 3], // gate point 4 — REFUSED, not called
      ["verify", "spend", true, 0], // run_end — per-phase, not per-run
    ]);

    // The negative control: a proceed-replying resident is still bounded —
    // telemetry.steeringIterations (accepted RETRY directives only) stays
    // empty the whole run, so it is not the counter the bound reads.
    expect(r?.status).toBe("active"); // an iteration refusal never stops the resident
    expect(r?.steeringIterations).toEqual({});
    expect(r?.spendMicros).toBe(460); // 5 calls x 92 µ$ — the metered pin
    expect(r?.tripwires).toEqual([]); // an iteration refusal is not a tripwire

    // Per-phase, not per-run: the run_end solicitation still CALLED after the
    // build phase's budget was spent.
    expect(
      jsonLines(leg.stderr).some((l) => l.event === "resident_solicit" && l.point === "run_end"),
    ).toBe(true);
  }, 180_000);
});

describe("e2e (leaf-6) — AC2a: loadResidentBounds is actually called by the runner", () => {
  test("an arming manifest missing the four operands refuses the run: marker ok:false, diagnostic triple, no resident", async () => {
    // The leaf-4 refusal arm, pinned as a test: an implementation exporting
    // loadResidentBounds without wiring it passes every unit test and dies
    // here — the manifest is hand-authored (the fill stamp's bypass shape).
    const { residentSpendCeilingMicros: _c, capMicroUsd: _m, defaultKeyCapMicroUsd: _k, residentRssBytes: _r, ...bare } =
      boundsManifestBody() as {
        residentSpendCeilingMicros?: number;
        capMicroUsd?: number;
        defaultKeyCapMicroUsd?: number;
        residentRssBytes?: number;
      } & Record<string, unknown>;
    const leg = await boundsLeg("bounds-invalid", {
      runId: "bounds-invalid-run",
      manifest: bare,
      catalogDir: BOUNDS_CATALOG,
    });
    expect(leg.exitCode).toBe(1); // settled not-ok — the marker is on disk, not exit 2
    const j = leg.journal;
    expect(j.ok).toBe(false);
    expect(j.phases).toEqual([]); // refused before the walk

    // The typed triple on the engine's fd-2 diagnostic line — code as payload.
    const invalid = jsonLines(leg.stderr).find((l) => l.event === "resident_bounds_invalid");
    expect(invalid).toMatchObject({ code: "bound-config-invalid" });
    expect(String(invalid?.message)).toContain("residentSpendCeilingMicros");
    expect(typeof invalid?.remediation === "string" && (invalid?.remediation as string).length > 0).toBe(true);

    // The terminal marker in the writer's shipped shape at the identity path.
    const marker = JSON.parse(
      fs.readFileSync(
        path.join(e2eRoot, "bounds-invalid", "marker", "qds-run", "bounds-invalid-run", "journal", "final.json"),
        "utf8",
      ),
    ) as { runId?: string; ok?: boolean; completedAt?: string };
    expect(marker.runId).toBe("bounds-invalid-run");
    expect(marker.ok).toBe(false);
    expect(typeof marker.completedAt).toBe("string");

    // No resident was spawned and nothing was solicited; the journal carries
    // the explicit disabled shape (the settled-journal guarantee).
    expect(jsonLines(leg.stderr).some((l) => l.event === "resident_solicit")).toBe(false);
    expect(j.resident).toEqual({
      status: "disabled",
      directives: 0,
      directivesRejected: 0,
      steeringIterations: {},
      spendMicros: 0,
      exitStatus: null,
      tripwires: [],
    });
  }, 60_000);
});

describe("e2e (leaf-6) — AC2b: the minted limitMicroUsd clamps, never refuses", () => {
  test("ceiling 2M with limitMicroUsd 1.5M: clamp row on stderr, the bound fires against 1.5M at the FIRST gate failure", async () => {
    const leg = await boundsLeg("clamp", {
      runId: "bounds-clamp-run",
      manifest: boundsManifestBody({ limitMicroUsd: 1_500_000 }),
      catalogDir: BOUNDS_CATALOG,
      // The witness must AGREE with the declared limit or runContextFrom
      // refuses at reconciliation — the clamp input is the manifest's own
      // field, vouched for like any declared limit.
      witnessOver: { effectiveCeilingMicros: 1_500_000 },
      env: { FAKE_RESIDENT_USAGE: JSON.stringify({ input: 4000, output: 1024 }) },
    });
    const j = leg.journal;
    const r = j.resident;

    // The clamp row — a TRACE/LOG row, never a journal resident key.
    expect(jsonLines(leg.stderr).find((l) => l.event === "resident_bounds_clamped")).toMatchObject({
      bound: "spend",
      action: "clamped",
      configuredMicros: 2_000_000,
      limitMicroUsd: 1_500_000,
      effectiveMicros: 1_500_000,
    });
    expect(reachabilityRow(leg.stderr)).toMatchObject({
      effectiveMicros: 1_500_000,
      verdict: "binding",
    });

    // The spend bound fires against the EFFECTIVE ceiling at the FIRST
    // post_gate_failure: run_start allowed (0 + 760,960 <= 1.5M), then
    // 760,960 + 760,960 = 1,521,920 > 1.5M refuses. Exactly one pi call;
    // the sequence [phase, bound, allowed, spendMicros] pins which point.
    expect(piCalls(leg.dir, leg.runId)).toBe(1);
    expect(
      checkLines(leg.stderr).map((l) => [l.phase, l.bound, l.allowed, l.spendMicros]),
    ).toEqual([
      [null, "spend", true, 0], // run_start — allowed, called
      ["build", "spend", false, 760_960], // gate point 1 — REFUSED, never called
    ]);
    expect(r?.status).toBe("stopped");
    expect(r?.spendMicros).toBe(760_960);
    expect(r?.tripwires[0]).toMatchObject({ cause: "spend_ceiling_breach", phase: "build" });
    expect(r?.tripwires[0]?.detail).toContain("1500000");

    // Build still completes: attempts 2-5 run ungated (the stopped resident
    // resolves PROCEED through the status gate), attempt 5 passes, verify
    // runs, the run is ok. A remainder-capped mint is a normal state.
    expect(leg.exitCode).toBe(0);
    expect(j.ok).toBe(true);
    expect(j.phases.map((p) => [p.name, p.status])).toEqual([
      ["build", "success"],
      ["verify", "success"],
    ]);

    // The journal's resident block key set stays DF3.3-closed — the clamp
    // gained no field there.
    expect(Object.keys(r ?? {}).sort()).toEqual([
      "directives",
      "directivesRejected",
      "exitStatus",
      "spendMicros",
      "status",
      "steeringIterations",
      "tripwires",
    ]);
  }, 120_000);
});

describe("e2e (leaf-6) — INV-BND-2: a manifest with NO limitMicroUsd runs UNCLAMPED", () => {
  test("four operands, no limit, fresh witness: armed, zero clamp/refusal lines, effective = the declared ceiling", async () => {
    // The witness MUST carry a positive effectiveCeilingMicros (the cap
    // reader refuses a present witness without one, BEFORE bounds load) —
    // but that value feeds the HARNESS cap only. The resident bound's clamp
    // input is the manifest's limitMicroUsd, which this manifest omits:
    // absence is a normal state, never a refusal.
    const leg = await boundsLeg("no-limit", {
      runId: "bounds-nolimit-run",
      manifest: boundsManifestBody({
        // A green two-phase walk is all this leg needs; the four operands
        // with ceiling 2M and no limitMicroUsd are the state under test.
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Emit the plan artifact",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "planned"],
          },
          {
            name: "verify",
            kind: "code",
            description: "Confirm the deterministic path",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "verified"],
          },
        ],
      }),
      catalogDir: DEFAULT_CATALOG,
    });
    expect(leg.exitCode).toBe(0);
    expect(leg.journal.ok).toBe(true);
    // The run ARMS and solicits — no refusal, no clamp, and the reachability
    // row reports the DECLARED ceiling as the effective one.
    expect(leg.journal.resident?.status).toBe("active");
    expect(
      jsonLines(leg.stderr).some((l) => l.event === "resident_solicit" && l.point === "run_start"),
    ).toBe(true);
    expect(jsonLines(leg.stderr).some((l) => l.event === "resident_bounds_clamped")).toBe(false);
    expect(jsonLines(leg.stderr).some((l) => l.event === "resident_bounds_invalid")).toBe(false);
    expect(reachabilityRow(leg.stderr)).toMatchObject({
      effectiveMicros: 2_000_000,
      verdict: "unreachable", // 504 x 8 structural calls fits inside 2M
    });
  }, 60_000);
});

afterAll(() => fs.rmSync(e2eRoot, { recursive: true, force: true }));
