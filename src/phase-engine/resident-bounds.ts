/**
 * Resident bound operands: load, project, guard, stamp (Story DF3.6a).
 *
 * F12's invariant — "the resident agent is itself watched … enforced by the
 * phase engine, not by the agent" — is why this file is engine-side: a bound
 * owned by the fleet layer would be a bound owned by the agent's own tier, and
 * every value here is read from the frozen manifest, which the resident cannot
 * reach (INV-BND-1). The bounds are engine policy over numbers the engine
 * already holds: a manifest read (`loadResidentBounds`), a projection from the
 * one rate the resident is billed at (`projectWorstCaseMicros`), a pre-call
 * comparison plus a per-phase solicitation counter (`createBoundsGuard`), and
 * the fill-side stamp that gives every operand a production provisioner
 * (`stampResidentBounds`).
 *
 * Two quantities with two different jobs run through this module, stated once
 * because conflating them killed three derivations (W6-C-B1): the REFUSAL is
 * driven by the PROJECTED worst case of the next call, checked before the call
 * issues, while the ACCUMULATOR it guards (`telemetry.spendMicros`, owned by
 * steering.ts) sums METERED actuals in integer µ$ (DD-9). The projection is
 * ceiling-side protection; it never enters the ledger.
 */
import { PipelineManifestSchema, type LoadedManifest } from "./manifest.ts";
import { MAX_OUTPUT_TOKENS, PROMPT_CHAR_CEILING } from "./steering.ts";
import { MAX_RETRIES, type PipelineManifest } from "./types.ts";

/**
 * Provisional resident RSS bound, 512 MiB (W6-C-H4). DF3.6b's live round
 * measures pi's baseline RSS and re-sets it HERE — the constant lives in this
 * story's own file, not in `manifest.ts`, because a schema default would make
 * AC2a's missing-value refusal unobservable (W14C-PAIR-1). Applied (cgroup
 * `memory.max`) by DF3.6b; this half only validates and carries it.
 */
export const PROVISIONAL_RESIDENT_RSS_BYTES = 536_870_912;

/**
 * Shipped FALLBACK spend ceiling, 8,000 µ$ ($0.008) per run — user policy, not
 * a derivation (operator ruling, 2026-09-13). Rung 2 of a two-rung ladder:
 * per-task manifest declaration → this fallback. At the default
 * fixture-catalog rates (~504 µ$/call projected) it buys fifteen full
 * projected calls (15 × 504 = 7,560; the strict `>` gate refuses the
 * sixteenth — 7,560 + 504 = 8,064 > 8,000); at frontier rates it cannot buy
 * one and AC6's `below_one_call` refuses — the ladder working as designed.
 */
export const DEFAULT_RESIDENT_SPEND_CEILING_MICROS = 8_000;

/**
 * Default steering-iteration bound, per phase. Deliberately below `MAX_RETRIES`
 * (5, `types.ts`), the structural ceiling on `post_gate_failure` solicitations:
 * a default at or above 5 is a bound that can never fire on any schema-valid
 * manifest, and a test that can only assert the bound exists.
 */
export const DEFAULT_MAX_STEERING_ITERATIONS = 3;

/**
 * Every bounds-load failure is a `BoundConfigError`; nothing partial escapes
 * the loader. Carries the typed triple AC2a puts on the engine's fd-2
 * diagnostic line — `code` as payload, never as a process exit code.
 */
export class BoundConfigError extends Error {
  readonly code = "bound-config-invalid";
  /** What the operator does next, stated where the refusal is the only thing anyone is reading. */
  readonly remediation: string;

  constructor(message: string, remediation: string) {
    super(message);
    this.name = "BoundConfigError";
    this.remediation = remediation;
  }
}

/**
 * The five DF3.6a manifest operands as a compile-time view. `PipelineManifest`
 * (`types.ts`) predates these schema fields and is not this story's file to
 * widen; this mirror is structurally identical to what `PipelineManifestSchema`
 * now outputs (five optionals, no defaults — see the schema block in
 * `manifest.ts`), and every `PipelineManifest` is assignable to the
 * intersection because all five arms are optional.
 */
export interface ResidentBoundOperands {
  residentSpendCeilingMicros?: number;
  capMicroUsd?: number;
  defaultKeyCapMicroUsd?: number;
  residentRssBytes?: number;
  maxSteeringIterations?: number;
}

/** A `PipelineManifest` carrying the DF3.6a bound operands (all optional). */
export type ManifestWithResidentBounds = PipelineManifest & ResidentBoundOperands;

/** AC2b's trace/log row — emitted to the engine's log stream, never the journal's resident block. */
export interface ResidentClampRow {
  bound: "spend";
  action: "clamped";
  configuredMicros: number;
  limitMicroUsd: number;
  effectiveMicros: number;
}

/** The resolved static bound set one resident-arming run executes against. */
export interface ResidentBoundsConfig {
  readonly residentSpendCeilingMicros: number;
  readonly capMicroUsd: number;
  readonly defaultKeyCapMicroUsd: number;
  /** Validated here, applied by DF3.6b. */
  readonly residentRssBytes: number;
  readonly maxSteeringIterations: number;
  /** `min(residentSpendCeilingMicros, limitMicroUsd)` when the limit is present and lower. */
  readonly effectiveCeilingMicros: number;
  /** Present only when the AC2b clamp bound. */
  readonly clampRow?: ResidentClampRow;
}

/**
 * Load and validate the resident bound set (AC2a/AC2b, INV-BND-2). Pure — no
 * I/O, no path reads; every operand comes off the frozen manifest by value.
 *
 * Refuses (`BoundConfigError`) when any of the four stamped operands is absent
 * or not a positive safe integer, or when the ordering
 * `residentSpendCeilingMicros ≤ capMicroUsd ≤ defaultKeyCapMicroUsd` is
 * violated — `≤` on both pairs (operator ruling 2026-09-08): a ceiling merely
 * EQUAL to the mint-time cap is admitted. The ordering is NEVER asserted
 * against this run's minted `limitMicroUsd`: DF2.8 mints `min(default,
 * remaining)`, so a run near its issue cap legitimately carries a limit below
 * every chain operand, and that state is AC2b's clamp below, not a refusal.
 * A missing operand refuses rather than defaulting because a defaulted operand
 * turns the assertion into a comparison of two constants that can never
 * disagree — the false green AC2a exists to prevent.
 */
export function loadResidentBounds(manifest: PipelineManifest): ResidentBoundsConfig {
  const m = manifest as ManifestWithResidentBounds;
  const operand = (name: keyof ResidentBoundOperands): number => {
    const v = m[name];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      throw new BoundConfigError(
        `${name} must be a positive integer <= ${Number.MAX_SAFE_INTEGER} on a resident-arming manifest (INV-BND-2)`,
        "stamp all four bound operands at dispatch fill (stampResidentBounds) or declare them on the task manifest; a defaulted operand would make the ordering assertion compare two constants",
      );
    }
    return v;
  };
  const residentSpendCeilingMicros = operand("residentSpendCeilingMicros");
  const capMicroUsd = operand("capMicroUsd");
  const defaultKeyCapMicroUsd = operand("defaultKeyCapMicroUsd");
  const residentRssBytes = operand("residentRssBytes");
  if (residentSpendCeilingMicros > capMicroUsd) {
    throw new BoundConfigError(
      `residentSpendCeilingMicros ${residentSpendCeilingMicros} exceeds capMicroUsd ${capMicroUsd}; the chain is residentSpendCeilingMicros <= capMicroUsd <= defaultKeyCapMicroUsd`,
      "lower residentSpendCeilingMicros or raise the run's mint-time cap (capMicroUsd) so the engine ceiling sits inside the provider-enforced caps",
    );
  }
  if (capMicroUsd > defaultKeyCapMicroUsd) {
    throw new BoundConfigError(
      `capMicroUsd ${capMicroUsd} exceeds defaultKeyCapMicroUsd ${defaultKeyCapMicroUsd}; the chain is residentSpendCeilingMicros <= capMicroUsd <= defaultKeyCapMicroUsd`,
      "the mint-time cap cannot request past the provider backstop; align capMicroUsd with the admission budget's derived value",
    );
  }

  // AC2b: limitMicroUsd is a CLAMP INPUT, never a chain operand. Present and
  // below the ceiling → the effective ceiling narrows to it (a remainder-capped
  // mint is a normal state, never a misconfiguration); present at or above →
  // non-binding; ABSENT → unclamped, no refusal (INV-BND-2's required set is
  // the three chain operands plus rssBytes, of which this is not one).
  // A poisoned limit (present but not a positive safe integer) refuses rather
  // than laundering into an effective ceiling or being silently ignored —
  // schema-valid manifests can never hit this arm.
  const limit = manifest.limitMicroUsd;
  let effectiveCeilingMicros = residentSpendCeilingMicros;
  let clampRow: ResidentClampRow | undefined;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new BoundConfigError(
        `limitMicroUsd ${limit} is not a positive integer <= ${Number.MAX_SAFE_INTEGER}; it is the clamp input to the effective ceiling and must be usable as one`,
        "re-dispatch the run: limitMicroUsd is stamped by DF3.1's fill step and an unusable value means the stamp or the delivery was corrupted",
      );
    }
    if (limit < residentSpendCeilingMicros) {
      effectiveCeilingMicros = limit;
      clampRow = {
        bound: "spend",
        action: "clamped",
        configuredMicros: residentSpendCeilingMicros,
        limitMicroUsd: limit,
        effectiveMicros: limit,
      };
    }
  }

  // The fifth operand rides outside the ordering chain, and `??` alone would
  // let NaN/Infinity/float/negative ride with it: NaN makes
  // `(counters[phase] ?? 0) >= NaN` always false — the iteration bound
  // silently disarmed — and NaN-poisons maxSolicitations/worstRunMicros
  // besides. Refuse, don't default: this loader is the backstop for
  // manifests that already bypassed BOTH the schema and the fill stamp, so
  // an unusable value is a corrupted delivery, not a missing preference
  // (INV-BND-2 fail-closed — same posture as the operand() checks above).
  // 0 stays legal: the schema's `.min(0)` blesses never-solicit.
  const maxSteeringIterations = m.maxSteeringIterations ?? DEFAULT_MAX_STEERING_ITERATIONS;
  if (!Number.isSafeInteger(maxSteeringIterations) || maxSteeringIterations < 0 || maxSteeringIterations > MAX_RETRIES) {
    throw new BoundConfigError(
      `maxSteeringIterations must be an integer between 0 and MAX_RETRIES (${MAX_RETRIES}) on a resident-arming manifest (INV-BND-2); got ${m.maxSteeringIterations}`,
      "declare an integer 0..5 bound on the task manifest or omit it for the default (3); a NaN, fractional, or oversized value means the manifest delivery was corrupted",
    );
  }

  return {
    residentSpendCeilingMicros,
    capMicroUsd,
    defaultKeyCapMicroUsd,
    residentRssBytes,
    maxSteeringIterations,
    effectiveCeilingMicros,
    clampRow,
  };
}

/**
 * Worst-case µ$ cost of ONE solicitation at this run's rate, for the pre-call
 * refusal: `round((PROMPT_CHAR_CEILING/4) × inputPerMTok / 1e6) +
 * round(MAX_OUTPUT_TOKENS × outputPerMTok / 1e6)`.
 *
 * The per-term `Math.round` mirrors the meter's discipline (DD-9, integer µ$
 * summed only with integers) so a projection and a metering of the same usage
 * agree to the micro-dollar. The two ceilings are DF3.3's per-call guards; both
 * are SOFT (chars/4 is a heuristic, `MAX_OUTPUT_TOKENS` rides a prompt
 * instruction) — that is why AC1's journal assertion carries a one-call margin
 * and why this is an estimate standing guard, not a bill.
 *
 * A non-finite or non-positive rate term clamps to 0, exactly like the meter's
 * `clampTerm`: one poisoned rate must not turn the projection into NaN, which
 * would make every comparison false and the bound vacuous. On the ENFORCEMENT
 * path this is defense-in-depth only — `createBoundsGuard` refuses a
 * zero/unusable rate at construction before calling this (a 0-rate projection
 * would make `spent + 0 > ceiling` unsatisfiable and report "unreachable":
 * fail-open, exactly what INV-BND-3's fail-safe posture forbids). The clamp
 * that must SURVIVE that refusal is the huge-but-FINITE case: a rate of 1e300
 * is finite and > 0, passes the guard, and its projection overflows to
 * Infinity, which flows to the `below_one_call` verdict — also a refusal, so
 * the ladder fails closed at every rung. The rate comes from `deps.rate` —
 * resolved once per run by `resolveRate` and handed to the engine; this module
 * loads nothing and is never a second rate path.
 */
export function projectWorstCaseMicros(rate: { inputPerMTok: number; outputPerMTok: number }): number {
  const clampTerm = (n: number): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
  const inputMicros = Math.round(((PROMPT_CHAR_CEILING / 4) * clampTerm(rate.inputPerMTok)) / 1_000_000);
  const outputMicros = Math.round((MAX_OUTPUT_TOKENS * clampTerm(rate.outputPerMTok)) / 1_000_000);
  return inputMicros + outputMicros;
}

/** The point a bound is evaluated at — DF3.3's three solicitation points, no fourth. */
export type BoundsCheckPoint = "run_start" | "post_gate_failure" | "run_end";

/** One `check` verdict: allow, or refuse naming which bound and (spend only) why. */
export type BoundsVerdict =
  | { allowed: true }
  | { allowed: false; bound: "spend" | "iterations"; cause?: string; detail?: string };

/**
 * The run-scoped guard over the effective ceiling and the per-phase iteration
 * bound. The counter lives HERE and nowhere else — `telemetry.steeringIterations`
 * counts accepted `retry` directives and stays at zero for a resident that
 * replies `proceed` on every call, which is exactly the loop this bound exists
 * to stop (AC3). Nothing bound-related is written to the journal's resident
 * block (its key set is DF3.3-closed); the log lines are the record.
 */
export interface ResidentBoundsGuard {
  readonly projectedPerCallMicros: number;
  readonly effectiveCeilingMicros: number;
  readonly reachability: "unreachable" | "binding" | "below_one_call";
  /** Structural maximum: 2 (run_start + run_end) + maxSteeringIterations × phaseCount. */
  readonly maxSolicitations: number;
  /** Per-phase solicitation counters (issued-and-allowed checks). */
  iterations(): Readonly<Record<string, number>>;
  /**
   * Pre-flight gate for one solicitation. Emits the bounds-check line
   * `{requestId, runId, phase, bound, spendMicros, projectedMicros, iterations,
   * projection_ms, allowed}` on every call the SEAM gates — allowed and
   * refused alike — then returns the verdict. One deliberate exception: the
   * malformed-correction re-gate in steering.ts does NOT call check() (a
   * correction is a second billed call inside ONE solicitation, not a new
   * one — it must neither emit a second bounds line nor bump the phase
   * counter) and compares inline against the guard's public figures instead.
   * Spend refusal carries the projected + cumulative figures in `detail`;
   * iteration refusal carries NO cause: it is not a tripwire, and the log
   * line is the record.
   */
  check(
    point: BoundsCheckPoint,
    ctx: { runId: string; requestId?: string; phase?: string; spent: number },
  ): BoundsVerdict;
}

/**
 * Build the guard, judge reachability once (AC6), and arm the per-phase
 * counter. The ceiling is a manifest constant and the rate is a roster fact;
 * they meet for the first time here, where the rate exists — `loadResidentBounds`
 * structurally cannot do this check (`deps.rate` resolves at `startResident`).
 *
 * `below_one_call` means "the amount configured for this task is too small for
 * this roster's prices", never "the resident ran away": the caller treats it
 * as a `bound-config-invalid` stop, NOT a `spend_ceiling_breach` tripwire.
 */
export function createBoundsGuard(
  cfg: ResidentBoundsConfig,
  rate: { inputPerMTok: number; outputPerMTok: number },
  phaseCount: number,
  emit: (line: Record<string, unknown>) => void,
  runId?: string,
): ResidentBoundsGuard {
  // INV-BND-3's fail-safe posture, applied to the rate: a zero/poisoned rate
  // term REFUSES construction instead of projecting to 0 µ$/call — a 0-rate
  // projection makes `spent + 0 > ceiling` unsatisfiable AND reachability
  // reports "unreachable", the bound silently disarmed exactly when the
  // billing data is least trustworthy (fail-closed, same family as the
  // loader's operand() refusals). A huge-but-FINITE rate (1e300) is legal
  // here: it passes this check, projects to Infinity, and flows to the
  // `below_one_call` verdict below — also a refusal, so every rung of the
  // ladder fails closed.
  for (const term of ["inputPerMTok", "outputPerMTok"] as const) {
    const v = rate[term];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new BoundConfigError(
        `rate.${term} ${v} is not a finite number > 0; a zero or unusable rate would project every call at 0 µ$ and silently disarm the spend bound (INV-BND-3)`,
        "re-dispatch the run: the rate is resolved once per run from the roster (resolveRate at startResident); an unusable term means the roster entry or its delivery is corrupted",
      );
    }
  }
  // `projection_ms` (Observability Contract: "Sub-timings: projection_ms")
  // covers the construction-time projection + reachability comparison; the
  // per-solicitation evaluations carry their own timing on each check row.
  const projectionStart = performance.now();
  const projectedPerCallMicros = projectWorstCaseMicros(rate);
  const effectiveCeilingMicros = cfg.effectiveCeilingMicros;
  const maxSolicitations = 2 + cfg.maxSteeringIterations * phaseCount;
  const worstRunMicros = projectedPerCallMicros * maxSolicitations;
  const reachability =
    effectiveCeilingMicros >= worstRunMicros
      ? "unreachable"
      : effectiveCeilingMicros < projectedPerCallMicros
        ? "below_one_call"
        : "binding";
  const projectionMs = performance.now() - projectionStart;
  // "unreachable" is a structural-worst-case ESTIMATE over SOFT ceilings —
  // the chars/4 heuristic and the prompt-enforced MAX_OUTPUT_TOKENS — that
  // also ignores correction calls (each a second billed call inside one
  // solicitation) and any metered actual above its projection. A run labeled
  // unreachable can therefore still trip the spend refusal in check(); the
  // check, not this verdict, is the enforcement.

  /** Emit is an observability sidecar: a broken sink must never convert a
   *  verdict into a throw on the solicitation path (same rule as steering's
   *  `onTripwire` observer). */
  const emitSafe = (line: Record<string, unknown>): void => {
    try {
      emit(line);
    } catch {
      /* the returned verdict is the record; the log line is evidence */
    }
  };

  // The reachability row, exactly once, at construction — the only place all
  // four inputs (projection, ceiling, structure, verdict) are in one scope.
  // `below_one_call` additionally carries AC6's `code: "bound-config-invalid"`:
  // the verdict is a POLICY outcome an operator must recognize as
  // intentional-looking ("the amount configured for this task is too small for
  // this roster's prices"), never "the resident ran away" — and the code is
  // the machine-readable half of that distinction, riding the one row the
  // verdict already lives on (no second emission, no tripwire: the cause union
  // has no member for a misconfiguration, by design).
  emitSafe({
    // `runId` when the caller can name it: this row carries the
    // below_one_call/bound-config-invalid verdict — the policy-stop record —
    // and must correlate to its run.
    ...(runId !== undefined ? { runId } : {}),
    bound: "spend",
    check: "reachability",
    projectedMicros: projectedPerCallMicros,
    effectiveMicros: effectiveCeilingMicros,
    maxSolicitations,
    verdict: reachability,
    projection_ms: projectionMs,
    ...(reachability === "below_one_call" ? { code: "bound-config-invalid" } : {}),
  });

  const counters: Record<string, number> = {};

  return {
    projectedPerCallMicros,
    effectiveCeilingMicros,
    reachability,
    maxSolicitations,
    // Copy, not the live map: the Readonly<> return type is a lie the
    // compiler cannot enforce on a direct reference — callers must not be
    // handed a mutable handle into the guard's counters.
    iterations: () => ({ ...counters }),
    check(point, ctx) {
      const phase = ctx.phase;
      // Spend-breach evaluated FIRST, deliberately: when a post_gate_failure
      // point is BOTH at the iteration max AND over the spend line, the spend
      // refusal wins — metered spend has crossed/overshot the ceiling and
      // that is a stop-with-tripwire the record must carry; letting the
      // iterations branch (refuse-only, no tripwire) shadow it would erase
      // the breach. Iterations refuse on their own only when spend is fine.
      // `projection_ms` times exactly this projection + comparison work.
      const evalStart = performance.now();
      const spendBreached = ctx.spent + projectedPerCallMicros > effectiveCeilingMicros;
      const iterationMaxed =
        !spendBreached &&
        point === "post_gate_failure" &&
        phase !== undefined &&
        (counters[phase] ?? 0) >= cfg.maxSteeringIterations;
      const projectionMs = performance.now() - evalStart;
      let verdict: BoundsVerdict;
      if (spendBreached) {
        verdict = {
          allowed: false,
          bound: "spend",
          cause: "spend_ceiling_breach",
          detail: `projected ${projectedPerCallMicros} µ$ + spent ${ctx.spent} µ$ = ${
            projectedPerCallMicros + ctx.spent
          } µ$ exceeds effective ceiling ${effectiveCeilingMicros} µ$`,
        };
      } else if (iterationMaxed) {
        // The phase's solicitation budget is spent: refuse the call, let the
        // deterministic walk continue (AC3 — the one bound that never stops
        // the resident). No cause: not a tripwire.
        verdict = { allowed: false, bound: "iterations" };
      } else {
        verdict = { allowed: true };
        // Count only what the bound counts: solicitations ISSUED (allowed) at
        // the in-phase point — never on a refused check, either bound.
        // run_start/run_end are single-shot by construction and are never
        // counted against any phase.
        if (point === "post_gate_failure" && phase !== undefined) {
          counters[phase] = (counters[phase] ?? 0) + 1;
        }
      }
      emitSafe({
        requestId: ctx.requestId ?? null,
        runId: ctx.runId,
        phase: ctx.phase ?? null,
        bound: verdict.allowed ? "spend" : verdict.bound,
        spendMicros: ctx.spent,
        projectedMicros: projectedPerCallMicros,
        iterations: phase !== undefined ? (counters[phase] ?? 0) : 0,
        projection_ms: projectionMs,
        allowed: verdict.allowed,
      });
      return verdict;
    },
  };
}

/**
 * `deepFreeze` is module-private in `manifest.ts`; the same walker,
 * re-implemented locally rather than exported from a file this story does not
 * widen. Frozen at stamp for the same reason `loadManifest` freezes: the run
 * carries the value, and a mid-run mutation has no effect (INV-BND-1).
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    // Object.values yields NOTHING for Map/Set — without these arms their
    // contents stay mutable behind a frozen wrapper. Ceiling: Object.freeze
    // on a Map/Set blocks neither .set()/.add() nor entry deletion (they
    // carry no frozen flag), so this is contents-only; today's manifest is
    // plain JSON and never hits either arm.
    if (value instanceof Map) for (const v of value.values()) deepFreeze(v);
    else if (value instanceof Set) for (const v of value) deepFreeze(v);
    else for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * DF3.6a fill-side stamp, sitting beside DF3.1's `stampManifestLimit` at the
 * dispatch fill step: the four bound operands get a production provisioner, so
 * a real dispatched run never arms against an unstamped required field
 * (W12C-6a-1) while `loadResidentBounds`'s missing-value refusal stays the
 * fail-closed backstop for any manifest that bypasses the fill step.
 *
 * `residentSpendCeilingMicros` and `residentRssBytes` resolve through their
 * two-rung ladders (declared → shipped fallback / PROVISIONAL constant).
 * `capMicroUsd` and `defaultKeyCapMicroUsd` are ALWAYS the dispatch-owned
 * values — authored ones are overwritten, the same belt-and-braces as
 * `stampManifestLimit`'s last-wins spread: a hand-authored `pipeline.yaml`
 * must not be able to name its own chain operands. `limitMicroUsd` stays
 * DF3.1's stamp's field alone (CC-1); `maxSteeringIterations` is not stamped
 * and keeps its loader default.
 *
 * The result carries no `resolvedPath`: stamped bytes exist at no path, and
 * inheriting the unstamped file's would claim provenance the content no longer
 * has (same reason `stampManifestLimit` drops it).
 *
 * @throws {BoundConfigError} if an ops value is not a positive safe integer, or
 *   the stamped manifest fails schema validation — every failure of this
 *   function, so callers catch one type
 */
export function stampResidentBounds(
  loaded: LoadedManifest,
  ops: { capMicroUsd: number; defaultKeyCapMicroUsd: number },
): LoadedManifest {
  const dispatchOperand = (name: keyof ResidentBoundOperands, v: number): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      throw new BoundConfigError(
        `${name} must be a positive integer <= ${Number.MAX_SAFE_INTEGER}; got ${v}`,
        "the dispatch-owned cap operands come from the admission budget chain (DF2.13/DF2.3); an unusable value means that chain, not the manifest, is wrong",
      );
    }
    return v;
  };
  const capMicroUsd = dispatchOperand("capMicroUsd", ops.capMicroUsd);
  const defaultKeyCapMicroUsd = dispatchOperand("defaultKeyCapMicroUsd", ops.defaultKeyCapMicroUsd);

  const m = loaded.manifest as ManifestWithResidentBounds;
  const stamped: ManifestWithResidentBounds = {
    ...m,
    residentSpendCeilingMicros: m.residentSpendCeilingMicros ?? DEFAULT_RESIDENT_SPEND_CEILING_MICROS,
    capMicroUsd,
    defaultKeyCapMicroUsd,
    residentRssBytes: m.residentRssBytes ?? PROVISIONAL_RESIDENT_RSS_BYTES,
  };
  // safeParse, so a schema failure leaves through this module's OWN error type
  // (same contract as `stampManifestLimit`): a raw ZodError would reach every
  // caller as an unrecognised throw.
  const result = PipelineManifestSchema.safeParse(stamped);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new BoundConfigError(
      `stamped manifest failed validation: ${detail}`,
      "the bound operands stamped at fill must satisfy the manifest schema; re-dispatch rather than delivering an unstamped manifest",
    );
  }
  const validated = result.data as ManifestWithResidentBounds;
  return { manifest: deepFreeze(validated), manifestLoadMs: loaded.manifestLoadMs };
}
