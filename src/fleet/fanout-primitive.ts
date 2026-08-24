/**
 * Fleet patterns as code (DF3.2) — section 3: the primitive, the three
 * patterns and the race poller (AC1–AC6).
 *
 * Lives in its own module under D1's sanctioned escape clause (sections 1+3
 * cannot share one file under the line ceiling; orchestrator pre-authorized
 * for wave-1b agent B). Acyclic by construction: this imports the record
 * store from `./fanout.ts` and the fleet lock from `./fleet-lock.ts`, and
 * nothing imports it back.
 *
 * The ORDERING is the contract:
 *
 *   validate (exit 2, zero side effects, BEFORE the lock) →
 *   FleetLock.acquire() →
 *   ONE fail-closed checkHeadroom(N) (AC1 — never N checks of 1) →
 *   FanoutRecordStore.create O_EXCL (AC9 — before the first mint) →
 *   N × mintRunId() SYNCHRONOUSLY (AC3 — DF3.1 stays the sole minter) →
 *   aggregate-exposure log line (INV-3) →
 *   semaphore(min(n, headroom, 8))-bounded allSettled over per-arm guards →
 *   per-arm classification → race pattern: poller + winner + loser teardown →
 *   close record (closedAt) → FleetLock.release() in FINALLY.
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkHeadroom,
  type HeadroomResult,
} from "../providers/quota.ts";
import { TimeoutError, withTimeout } from "../providers/timeout.ts";
import { teardownSandbox, type TeardownDeps } from "../providers/teardown.ts";
import { defaultKeyCapMicroUsd, type KeyApi } from "../providers/credentials.ts";
import type { ProviderDriver } from "../providers/driver.ts";
import type { RunRecord, RunRecordStore } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { runMarkerPath } from "../phase-engine/journal.ts";
import { log } from "../swarmclaw/log.ts";
import { BriefSchema, extractZodErrorField, type Brief } from "./brief-schema.ts";
import { dispatch, FleetError, mintRunId, type DispatchDeps, type MintedRunId } from "./dispatch.ts";
import { mintFanoutId, FanoutRecordStore, rmQuiet } from "./fanout.ts";
import { FLEET_LOCK_PATH, FleetLock } from "./fleet-lock.ts";

// ─── INV-6 finite caps (imported constants — never mirrored literals) ─────────

/** N is bounded 1..8 (many-stories) / 2..8 (best-of-n, race). */
export const FANOUT_MAX_N = 8;

/** Concurrency hard cap — `Math.min(n, headroom, MAX_FANOUT_CONCURRENCY)`. */
export const MAX_FANOUT_CONCURRENCY = 8;

/** AC5 poll interval. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** AC5 per-call deadline for every exec probe and copyFile read. */
export const DEFAULT_PER_CALL_DEADLINE_MS = 10_000;

/** AC5/INV-6 fan-out ceiling — undecided arms report armUnknown past it. */
export const DEFAULT_FANOUT_CEILING_MS = 3_600_000;

/**
 * Consecutive unreadable/unusable reads of one arm's completion marker after
 * which that arm is abandoned as armUnknown instead of polled to the ceiling.
 * DF1.1 publishes final.json by temp+rename (journal.ts), so its bytes never
 * exist half-written on disk — persistent parse failure is CORRUPTION, not
 * latency, and polling it to the 1h ceiling held the fleet lock while every
 * racing box billed for nothing.
 */
export const MARKER_UNUSABLE_TICKS_LIMIT = 3;

/**
 * Whole-pipeline deadline for ONE loser's teardownSandbox (all eight DF2.5
 * steps, network execs included). The fleet lock is HELD for every loser
 * disposal between markDestructive/clearDestructive, so one hung step — a
 * wedged exec, a stalled provider destroy — would otherwise park the lock
 * indefinitely and wedge every future fleet operation behind it. Generous by
 * design: this bounds a hang, it does not hurry a slow-but-alive teardown
 * (per-step pacing is teardown's own business).
 */
export const LOSER_TEARDOWN_TIMEOUT_MS = 300_000;

export type FanoutPattern = "best-of-n" | "many-stories" | "race";

export interface FanoutDeps extends Omit<DispatchDeps, "requestId"> {
  /** CC-9: ONE correlation id across all N arms. */
  requestId: string;
  /** Default `resolveFanoutsDir()` (the store resolves env/default itself). */
  fanoutsDir?: string;
  /** Default `.sandbox/fleet.lock`. */
  lockPath?: string;
  /** Roster provenance per arm — REQUIRED for best-of-n/race, forbidden for many-stories. */
  rosterIds?: readonly string[];
  /** Default `Math.min(n, headroom.headroom, MAX_FANOUT_CONCURRENCY)` (K8: literal). */
  concurrency?: number;
  /** AC5 seams (tests inject small values; production defaults are the AC numbers). */
  pollIntervalMs?: number;
  perCallDeadlineMs?: number;
  ceilingMs?: number;
  /**
   * Whole-pipeline deadline for ONE loser's teardownSandbox during disposal
   * (default LOSER_TEARDOWN_TIMEOUT_MS). Tests inject small values.
   */
  loserTeardownTimeoutMs?: number;
  /** Monotonic seam for same-process budgets (tick math, ceilings). */
  monotonic?: () => number;
  /**
   * DF2.8: when present, race losers' teardown prices their box hours into
   * the ledger at its close step (teardown.ts gates on exactly this hook).
   * Wired beside the records dir by the CLI, like teardown's own.
   */
  costLedger?: TeardownDeps["costLedger"];
}

export interface ArmOutcome {
  arm: number;
  /** Null only when a refusal preceded minting (fanout then refuses wholesale). */
  runId: string | null;
  outcome: "ready" | "setupFailed" | "armFailed" | "armUnknown" | "lostRace";
  /** The arm dispatch's collected exit classification, when it threw one. */
  exitCode?: number;
  vmName?: string;
}

export interface FanoutResult {
  fanoutId: string;
  arms: ArmOutcome[];
  winner: number | null;
  headroom: HeadroomResult;
}

/** An outcome slot before its arm settles (the allSettled section fills it). */
type OutcomeSlot = Omit<ArmOutcome, "outcome"> & { outcome?: ArmOutcome["outcome"] };

// ─── refusals ──────────────────────────────────────────────────────────────────

function invalid(
  exitCode: 2 | 5,
  code: string,
  message: string,
  remediation: string,
  payload?: Record<string, unknown>,
  exitStatusOverride?: "transient",
): FleetError {
  const err = new FleetError(exitCode, code, redactSecrets(message), redactSecrets(remediation), payload);
  // The retry classification rides the error like dispatch.ts's refuse() log
  // line carries its own (:811) — exactly one caller needs it: list-unverified.
  return exitStatusOverride === undefined ? err : Object.assign(err, { exitStatus: exitStatusOverride });
}

// ─── D9 validation (exit 2, BEFORE the lock — zero side effects) ──────────────

interface ValidatedInput {
  pattern: FanoutPattern;
  n: number;
  briefList: Brief[];
  rosterIds: readonly string[] | undefined;
  concurrency: number | undefined;
}

function validatePatternInput(pattern: FanoutPattern, n: number, briefs: unknown, deps: FanoutDeps): ValidatedInput {
  if (pattern !== "best-of-n" && pattern !== "many-stories" && pattern !== "race") {
    throw invalid(2, "invalid-pattern", `unknown pattern: ${String(pattern)}`, "pattern is one of best-of-n, many-stories, race");
  }
  const minN = pattern === "many-stories" ? 1 : 2;
  if (!Number.isInteger(n) || n < minN || n > FANOUT_MAX_N) {
    throw invalid(
      2,
      "invalid-n",
      `--n must be an integer in ${minN}..${FANOUT_MAX_N}, got ${JSON.stringify(n)}`,
      minN === 2 ? "a comparison needs two arms — rerun with a legal --n" : "rerun with a legal --n",
    );
  }
  if (pattern === "many-stories") {
    if (!Array.isArray(briefs)) {
      throw invalid(2, "invalid-brief", "many-stories takes an array of n brief objects", 'wrap the briefs: { "briefs": [ … ] }');
    }
    if ((briefs as unknown[]).length !== n) {
      throw invalid(2, "brief-count-mismatch", `many-stories got ${(briefs as unknown[]).length} briefs for n=${n}`, "make the brief array length equal --n");
    }
    if (deps.rosterIds !== undefined) {
      throw invalid(2, "roster-forbidden", "--roster is not valid for many-stories", "drop --roster; per-arm variation comes from the distinct briefs");
    }
  } else if (Array.isArray(briefs)) {
    throw invalid(2, "invalid-brief", `${pattern} takes exactly ONE brief object (every arm runs it identically)`, "pass a single brief; distinct briefs per arm are many-stories' mechanism");
  }
  const rawList: unknown[] = Array.isArray(briefs) ? briefs : [briefs];
  const parsedList = rawList.map((b): Brief => {
    const parsed = BriefSchema.safeParse(b);
    if (!parsed.success) {
      throw invalid(2, "invalid-brief", `brief rejected at field "${extractZodErrorField(parsed.error)}"`, "fix the brief JSON, then rerun");
    }
    return parsed.data;
  });
  // best-of-n/race: every arm runs the ONE brief identically — expand it to n
  // so per-arm indexing below stays uniform with many-stories'.
  const briefList =
    pattern === "many-stories" ? parsedList : Array.from({ length: n }, () => parsedList[0] as Brief);
  let rosterIds: readonly string[] | undefined;
  if (pattern !== "many-stories") {
    const r = deps.rosterIds;
    if (r === undefined) {
      throw invalid(2, "roster-required", `${pattern} requires a roster list (one entry per arm)`, "pass the roster entries and rerun");
    }
    if (r.length !== n) {
      throw invalid(2, "roster-count-mismatch", `${pattern} got ${r.length} roster entries for n=${n}`, "the roster count must equal --n");
    }
    rosterIds = r;
  }
  if (deps.concurrency !== undefined && (!Number.isInteger(deps.concurrency) || deps.concurrency < 1)) {
    throw invalid(2, "invalid-concurrency", `concurrency must be a positive integer, got ${JSON.stringify(deps.concurrency)}`, "drop concurrency for the default min(n, headroom, 8)");
  }
  if (
    deps.capMicroUsd !== undefined &&
    (!Number.isInteger(deps.capMicroUsd) || deps.capMicroUsd <= 0)
  ) {
    // Same shape as credentials.ts:231's mint-time check, but HERE — before the
    // lock — so an invalid cap never reaches the INV-3 admitted line or a box.
    throw invalid(
      2,
      "invalid-cap",
      `capMicroUsd must be a positive integer of micro-dollars, got ${JSON.stringify(deps.capMicroUsd)}`,
      "pass a positive-integer micro-dollar cap, or drop capMicroUsd to use the key default",
    );
  }
  return { pattern, n, briefList, rosterIds, concurrency: deps.concurrency };
}

/**
 * The pin is the control variable (`fan_out_n.md:39/:45/:132`): best-of-n/race
 * pin EVERY arm to one SHA, so `--pin` must equal the brief's `commitSha`;
 * many-stories forbids `--pin` outright (per-arm pins ride each brief). Called
 * by the CLI front door BEFORE `fanout()` — validation owns zero side effects.
 */
export function assertFanoutPin(pattern: FanoutPattern, briefs: readonly unknown[], pin: string | undefined): void {
  if (pin === undefined) return;
  if (pattern === "many-stories") {
    throw invalid(2, "pin-mismatch", "--pin is not valid for many-stories: per-arm pins ride each brief's commitSha", "drop --pin, or put the intended sha on each brief");
  }
  const sha = (briefs[0] as { commitSha?: unknown } | undefined)?.commitSha;
  if (typeof sha !== "string" || sha !== pin) {
    throw invalid(2, "pin-mismatch", `--pin ${JSON.stringify(pin)} does not equal the brief commitSha`, "pass --pin exactly as the brief pins it, or omit --pin to trust the brief");
  }
}

// ─── the primitive ─────────────────────────────────────────────────────────────

/**
 * Run N isolated dispatch arms as one pattern. Throws `FleetError` exit 2 on
 * validation (nothing provisioned, nothing locked), exit 5 on a fleet-busy or
 * no-headroom refusal (same posture); returns per-arm outcomes otherwise.
 */
export async function fanout(
  pattern: FanoutPattern,
  n: number,
  briefs: Brief | Brief[],
  deps: FanoutDeps,
): Promise<FanoutResult> {
  const input = validatePatternInput(pattern, n, briefs, deps);
  const mono = deps.monotonic ?? (() => performance.now());
  const now = (): Date => new Date(deps.clock?.() ?? Date.now());
  const lock = new FleetLock({ path: deps.lockPath ?? FLEET_LOCK_PATH, requestId: deps.requestId });
  lock.acquire();
  try {
    // AC1: EXACTLY ONE checkHeadroom(N), inside the lock, before anything minted.
    const tAdmit = mono();
    let headroom: HeadroomResult;
    try {
      headroom = await checkHeadroom(deps.driver, n, deps.quotaLimits);
    } catch (e) {
      if (e instanceof FleetError) throw e;
      // Copied from dispatch.ts's admission gate: checkHeadroom's default
      // parameter is loadQuotaLimits(), which throws QuotaLimitsError for a
      // malformed or unreadable quota-limits file — an admission refusal like
      // any other, never a bare exit 1. The provider's own code rides the
      // payload as diagnosis; it does not become this layer's FleetError code.
      const q = e as { code?: unknown; remediation?: unknown };
      throw invalid(
        5,
        "headroom-failed",
        `headroom could not be determined: ${errText(e)}`,
        typeof q.remediation === "string"
          ? q.remediation
          : "fix .sandbox/quota-limits.json, then retry — nothing was provisioned",
        typeof q.code === "string" ? { providerCode: q.code } : undefined,
      );
    }
    if (!headroom.allowed) {
      // Copied from dispatch.ts:1552-1576: list-unverified is the SUBSTRATE
      // failing to answer, not the request being wrong — classify transient.
      const transient = headroom.reason === "list-unverified";
      throw invalid(
        5,
        "no-headroom",
        `refusing fan-out of ${n}: ${headroom.reason ?? "headroom"} — live ${headroom.liveVms}/${headroom.ceiling}, headroom ${headroom.headroom}`,
        "wait for a slot (fleet status), tear runs down, or raise the ceiling in the quota limits",
        { reason: headroom.reason, liveVms: headroom.liveVms, ceiling: headroom.ceiling, headroom: headroom.headroom },
        transient ? "transient" : undefined,
      );
    }

    // AC9: the record exists before the FIRST mint. Arms are attached right
    // after the mints (the schema wants real runIds, so create-then-fill).
    const store = new FanoutRecordStore({ dir: deps.fanoutsDir, requestId: deps.requestId });
    const fanoutId = mintFanoutId();
    const pin = input.pattern === "many-stories" ? null : (input.briefList[0]?.commitSha ?? null);
    store.create({
      fanoutId,
      requestId: deps.requestId,
      pattern: input.pattern,
      n,
      pin,
      createdAt: now().toISOString(),
      arms: [],
      winner: null,
      rankedAt: null,
      closedAt: null,
    });

    // AC3: all N ids minted synchronously BEFORE the parallel section opens.
    const tMint = mono();
    const ids: MintedRunId[] = [];
    for (let i = 0; i < n; i++) ids.push(mintRunId());
    store.mutate(fanoutId, (rec) => ({
      ...rec,
      arms: ids.map((runId, i) => ({
        arm: i,
        runId,
        ...(input.rosterIds?.[i] !== undefined ? { rosterId: input.rosterIds[i] as string } : {}),
        briefHash: createHash("sha256").update(JSON.stringify(input.briefList[i])).digest("hex"),
      })),
    }));
    const mintAllMs = mono() - tMint;

    // INV-3: aggregate exposure stated BEFORE the first dispatch.
    const cap = deps.capMicroUsd ?? defaultKeyCapMicroUsd;
    emitLine({
      requestId: deps.requestId,
      operation: "fleet.fanout",
      phase: "admitted",
      fanoutId,
      pattern: input.pattern,
      n,
      headroom: headroom.headroom,
      capMicroUsd: cap,
      aggregateExposureMicroUsd: n * cap,
      timings: { admission_ms: Math.round(tMint - tAdmit), mint_all_ms: Math.round(mintAllMs) },
    });

    // Pre-race slots carry no outcome yet; every slot has one once the
    // allSettled section returns.
    const outcomes: OutcomeSlot[] = ids.map((runId, arm) => ({ arm, runId }));
    // K8's bound holds for BOTH paths: an explicit concurrency is clamped to
    // MAX_FANOUT_CONCURRENCY like the default (the constant's doc contract),
    // and the Math.max(1, …) keeps a degenerate headroom answer from building
    // a semaphore(0) that would park allSettled forever with the lock held.
    const requested = input.concurrency ?? Math.min(n, headroom.headroom, MAX_FANOUT_CONCURRENCY);
    const width = Math.max(1, Math.min(requested, MAX_FANOUT_CONCURRENCY));
    await runArms(input, ids, deps, fanoutId, outcomes, width);

    let winner: number | null = null;
    if (input.pattern === "race") {
      // Entrants are the arms whose gate returned ready — fixed BEFORE polling,
      // because AC5's disposal rule is about who ENTERED the race, not how the
      // poller later classified them.
      const entrants = outcomes.filter((o) => o.outcome === "ready").map((o) => o.arm);
      winner = await runRace(input, deps, store, fanoutId, outcomes);
      await disposeLosers(deps, lock, outcomes, entrants, winner, fanoutId);
    }

    store.mutate(fanoutId, (rec) => ({ ...rec, closedAt: now().toISOString() }));
    return {
      fanoutId,
      arms: outcomes.map((o) => ({ ...o, outcome: o.outcome ?? "armUnknown" })),
      winner,
      headroom,
    };
  } finally {
    lock.release();
  }
}

// ─── the parallel section ──────────────────────────────────────────────────────

/** A counting semaphore — chunking would serialize survivors behind a failure. */
function semaphore(width: number): { acquire(): Promise<void>; release(): void } {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (active < width) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release(): void {
      // A permit hands off WHOLE to the next waiter. Decrementing AND waking
      // made the woken waiter run on a permit nobody holds, drifting `active`
      // below zero until later acquires fast-pathed past the width bound.
      const wake = waiters.shift();
      if (wake !== undefined) {
        wake();
        return;
      }
      active -= 1;
    },
  };
}

async function runArms(
  input: ValidatedInput,
  ids: MintedRunId[],
  deps: FanoutDeps,
  fanoutId: string,
  outcomes: OutcomeSlot[],
  width: number,
): Promise<void> { /* dp:ok body awaits allSettled (never rejects) and a non-rejecting semaphore; every per-arm await carries its own guard */
  const sem = semaphore(width);
  await Promise.allSettled(
    ids.map(async (runId, i) => {
      await sem.acquire();
      try {
        const started = performanceNow(deps);
        // Fresh per-arm object (K5); shared driver/keyApi/store instances are
        // fine — every dispatch opens its own ledger via the factory. The cap
        // threads straight through (ruling C1 landed the DispatchDeps field).
        const armDeps: DispatchDeps = {
          driver: deps.driver,
          keyApi: deps.keyApi,
          store: deps.store,
          ledgerFactory: deps.ledgerFactory,
          repoRoot: deps.repoRoot,
          quotaLimits: deps.quotaLimits,
          port: deps.port,
          requestId: deps.requestId,
          clock: deps.clock,
          timeoutMs: deps.timeoutMs,
          setupGate: deps.setupGate,
          dispatchLogPath: deps.dispatchLogPath,
          ...(deps.capMicroUsd === undefined ? {} : { capMicroUsd: deps.capMicroUsd }),
        };
        try {
          const ack = await dispatch(input.briefList[i], armDeps, { admitted: true, runId: ids[i] });
          outcomes[i] = { arm: i, runId, outcome: "ready", vmName: ack.vmName };
        } catch (e) {
          outcomes[i] = classifyArmFailure(i, runId, e);
        }
        // The run↔fan-out join rides DF2.1's PRE-REGISTERED extension namespace
        // (K2: schemaVersion is the store's to stamp). After classification, so
        // a refused arm with no record skips cleanly. A failed join is logged
        // and never changes the arm's lifecycle class.
        try {
          stampFanoutExtension(deps.store, runId, fanoutId, i);
        } catch (e) {
          armLine(deps.requestId, fanoutId, {
            arm: i,
            runId,
            outcome: outcomes[i]?.outcome,
            error: { code: "fanout-extension-failed", message: errText(e) },
          });
        }
        armLine(deps.requestId, fanoutId, {
          arm: i,
          runId,
          outcome: outcomes[i]?.outcome,
          exitCode: outcomes[i]?.exitCode,
          vmName: outcomes[i]?.vmName,
          durationMs: Math.round(performanceNow(deps) - started),
        });
      } finally {
        sem.release();
      }
    }),
  );
}

function performanceNow(deps: FanoutDeps): number {
  return deps.monotonic?.() ?? performance.now();
}

/** Setup-gate failures (exit 3) stop ONE arm and stay alive — never a race loss. */
function classifyArmFailure(i: number, runId: string, e: unknown): ArmOutcome {
  if (e instanceof FleetError) {
    // The box name rides dispatch's refusal payload once provisioning ran —
    // an INV-5 outcome (box alive) must still be NAMEABLE.
    const vmName = (e.payload as { vmName?: unknown } | undefined)?.vmName;
    return {
      arm: i,
      runId,
      outcome: e.exitCode === 3 ? "setupFailed" : "armFailed",
      exitCode: e.exitCode,
      ...(typeof vmName === "string" ? { vmName } : {}),
    };
  }
  return { arm: i, runId, outcome: "armFailed" };
}

// ─── the race poller (AC5) — host-side composition, no port method added ──────

/**
 * Poll every racing arm's in-box completion marker (`DF1.1's finish(accepted)`
 * file) until one satisfies the predicate (`ok === true`) or the ceiling
 * expires. Each probe/read carries its own per-call deadline: ExeDevDriver
 * execs can outlive a destroy (driver.ts:153-168), so a hung remote call
 * SKIPS its tick — logged, non-fatal — instead of wedging the loop.
 *
 * A marker that EXISTS but cannot be read as `{ok: boolean}` is different:
 * journal.ts publishes it by temp+rename, so persistence of the failure means
 * corruption, not latency. After MARKER_UNUSABLE_TICKS_LIMIT consecutive
 * unusable reads an arm is reclassified armUnknown and dropped from polling
 * (never touched by loser disposal — its run state is genuinely unknown),
 * bounding what used to spin to the full ceiling with the fleet lock held.
 *
 * Returns the winning arm index, or null (all armFailed/armUnknown-given-up,
 * or ceiling reached).
 */
async function runRace(
  _input: ValidatedInput,
  deps: FanoutDeps,
  store: FanoutRecordStore,
  fanoutId: string,
  outcomes: OutcomeSlot[],
): Promise<number | null> { /* dp:ok probeArm self-guards every await (try/catch/finally); the sleep promise never rejects */
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadlineMs = deps.perCallDeadlineMs ?? DEFAULT_PER_CALL_DEADLINE_MS;
  const ceilingMs = deps.ceilingMs ?? DEFAULT_FANOUT_CEILING_MS;
  const markerPath = runMarkerPath(); // DIRECT import — the barrel withholds it (K7)
  const undecided = (): number[] => outcomes.filter((o) => o.outcome === "ready").map((o) => o.arm);
  const unusableTicks = new Map<number, number>();

  const baseline = performanceNow(deps);
  while (undecided().length > 0 && performanceNow(deps) - baseline < ceilingMs) {
    const current = undecided();
    for (const arm of current) {
      const verdict = await probeArm(deps, store, fanoutId, outcomes, arm, markerPath, deadlineMs);
      if (verdict === "unusable") {
        const ticks = (unusableTicks.get(arm) ?? 0) + 1;
        unusableTicks.set(arm, ticks);
        if (ticks >= MARKER_UNUSABLE_TICKS_LIMIT) {
          outcomes[arm] = { ...(outcomes[arm] as ArmOutcome), outcome: "armUnknown" };
          // Dropping from `ready` removes the arm from `undecided()` and from
          // disposeLosers' entrants in one move: an unknown-state box is never
          // torn down on a guess, and no longer polls.
          raceEvent(deps.requestId, fanoutId, {
            arm,
            event: "marker-unusable",
            detail: `marker present but unreadable ${String(ticks)} ticks in a row — arm left UNKNOWN, polling abandoned`,
          });
        }
        continue;
      }
      if (verdict === "absent") {
        // The probe RAN and read the box clean — the marker is just not there
        // yet. Corruption counting is CONSECUTIVE (the contract above), so a
        // usable read clears the arm's streak. Transport skips return null: a
        // probe that never ran is no evidence either way and must not reset.
        unusableTicks.delete(arm);
        continue;
      }
      if (verdict !== null) return verdict; // includes "another process won"
    }
    if (undecided().length > 0 && performanceNow(deps) - baseline < ceilingMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  // Ceiling: undecided arms are UNKNOWN — never assumed losers, never touched.
  for (const arm of undecided()) {
    outcomes[arm] = { ...(outcomes[arm] as ArmOutcome), outcome: "armUnknown" };
  }
  return null;
}

/**
 * One arm's one tick. A winner index when the race is decided (ours or another
 * process's), "unusable" when the marker exists but cannot be judged, "absent"
 * when the probe ran clean and the marker is simply not there yet (the usable
 * read that resets the arm's corruption streak), and null for transport skips
 * and settled-failed markers.
 */
async function probeArm(
  deps: FanoutDeps,
  store: FanoutRecordStore,
  fanoutId: string,
  outcomes: OutcomeSlot[],
  arm: number,
  markerPath: string,
  deadlineMs: number,
): Promise<number | null | "unusable" | "absent"> {
  const outcome = outcomes[arm] as ArmOutcome; // racing arms are settled and ready
  const vm = outcome.vmName as string;
  let tmp: string | undefined;
  const skipTick = (code: string, e: unknown): void => {
    raceEvent(deps.requestId, fanoutId, { arm, error: { code, message: errText(e) } });
  };
  try {
    // Shell-quote the marker path INSIDE the probe command (AC5).
    const probe = await withTimeout(
      deps.driver.exec(vm, ["sh", "-c", `test -f ${shellQuote(markerPath)}`]),
      deadlineMs,
      "race-probe",
    );
    if (probe.exitCode !== 0) return "absent"; // no marker yet — a clean read, resets the streak

    tmp = join(tmpdir(), `qds-fanout-${fanoutId}-${arm}-${randomBytes(4).toString("hex")}.json`);
    await withTimeout(deps.driver.copyFile(vm, markerPath, tmp), deadlineMs, "race-read");
    let marker: { ok?: unknown };
    try {
      marker = JSON.parse(readFileSync(tmp, "utf8")) as { ok?: unknown };
    } catch (e) {
      skipTick("marker-unreadable", e);
      return "unusable"; // present-but-corrupt is counted by runRace, never polled forever
    }
    if (marker.ok === false) {
      // A settled-but-failed run: armFailed and the race CONTINUES (G6:
      // the marker fires on EVERY settled run — absence ≠ pending failure).
      outcomes[arm] = { ...outcome, outcome: "armFailed" };
      raceEvent(deps.requestId, fanoutId, { arm, event: "arm-failed-marker" });
      return null;
    }
    if (marker.ok !== true) {
      skipTick("marker-unreadable", new Error(`final.json carries ok=${JSON.stringify(marker.ok)}`));
      return "unusable"; // same corruption counting as the parse failure above
    }
    // Atomic first-writer transition, under the record's own lock: the mutate
    // fn ADOPTS the persisted winner when another writer claimed first — the
    // caller has to learn who won HERE, or this process re-probes to the
    // ceiling holding the fleet lock while its losers never tear down.
    let claimed: number | null = null;
    store.mutate(fanoutId, (rec) => {
      if (rec.winner !== null) {
        claimed = rec.winner;
        return rec;
      }
      claimed = arm;
      return { ...rec, winner: arm };
    });
    if (claimed !== arm) {
      raceEvent(deps.requestId, fanoutId, {
        arm,
        error: { code: "race-lost-cross-process", message: `another writer claimed arm ${String(claimed)}` },
      });
      return claimed; // someone else won: our arms are all losers
    }
    raceEvent(deps.requestId, fanoutId, { arm, event: "won" });
    return arm;
  } catch (e) {
    // TimeoutError or any transport failure: SKIP this tick, logged non-fatal;
    // the loop retries on the next tick, bounded by the overall ceiling.
    skipTick(e instanceof TimeoutError ? "race-probe-timeout" : "race-probe-failed", e);
    return null;
  } finally {
    if (tmp !== undefined) rmQuiet(tmp);
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Winner disposal: every arm that ENTERED the race (gate returned ready) and
 * did not win goes through DF2.5's teardownSandbox UNMODIFIED — its fixed step
 * array harvests before it destroys (teardown.ts:99-111). Per-arm guards: one
 * failed disposal never aborts a sibling's.
 *
 * Each disposal is DEADLINED (`loserTeardownTimeoutMs`, default
 * LOSER_TEARDOWN_TIMEOUT_MS): this whole loop sits between markDestructive and
 * clearDestructive with the fleet lock held, so one unbounded teardown — a
 * wedged exec, a stalled provider destroy — would park the lock indefinitely
 * and wedge every future fleet operation behind it. DF2.5 has no cancellation
 * seam (no AbortSignal crosses driver.exec, git or destroy), so "known to have
 * stopped" is not observable; the deadline therefore ABANDONS the attempt.
 * That is safe because a late-settling abandoned teardown can only touch its
 * OWN run state: the record close is first-close-wins, the box-hour ledger row
 * is idempotent by event id, and withTimeout pins a no-op catch on the
 * abandoned promise so its eventual fate never surfaces as an unhandled
 * rejection after release.
 */
async function disposeLosers(
  deps: FanoutDeps,
  lock: FleetLock,
  outcomes: OutcomeSlot[],
  entrants: number[],
  winner: number | null,
  fanoutId: string,
): Promise<void> {
  // Every entrant that did not win is a loser — including arms the poller
  // marked armFailed (ok:false). armUnknown entrants are NEVER touched.
  const entered = entrants
    .filter((arm) => arm !== winner && outcomes[arm]?.outcome !== "armUnknown")
    .map((arm) => outcomes[arm] as ArmOutcome);
  if (entered.length === 0) return;
  const teardownDeps: TeardownDeps = {
    driver: deps.driver as ProviderDriver,
    store: deps.store as RunRecordStore,
    keyApi: deps.keyApi as KeyApi,
    requestId: deps.requestId,
    // DF2.8: a loser's close step must price its box hours like any teardown,
    // or the ledger under-counts spend and a later assertWithinBudget
    // over-admits against the cap.
    ...(deps.costLedger === undefined ? {} : { costLedger: deps.costLedger }),
  };
  // Undecided losers become lostRace; a marker-decided armFailed KEEPS its
  // classification (a completed run that reported failure — not a race loss).
  for (const o of entered) {
    if (o.outcome === "ready") outcomes[o.arm] = { ...o, outcome: "lostRace" };
  }
  // The destructive phase began — the fleet lock refuses release until the
  // phase completes. Cleared once EVERY loser has been ATTEMPTED: individual
  // failures were logged with their own remediation above. The mark sits
  // INSIDE the try so any throw after the flag is set still reaches the clear.
  const teardownDeadlineMs = deps.loserTeardownTimeoutMs ?? LOSER_TEARDOWN_TIMEOUT_MS;
  try {
    lock.markDestructive();
    for (const o of entered) {
      try {
        await withTimeout(teardownSandbox(teardownDeps, o.runId as string), teardownDeadlineMs, "loser-teardown");
      } catch (e) {
        armLine(deps.requestId, fanoutId, {
          arm: o.arm,
          runId: o.runId,
          outcome: "lostRace",
          error: {
            code: e instanceof TimeoutError ? "loser-teardown-timeout" : "loser-teardown-failed",
            message: errText(e),
          },
        });
      }
    }
  } finally {
    lock.clearDestructive();
  }
}

// ─── observability (D13) ───────────────────────────────────────────────────────

/** Every arm line carries the fan-out's correlation id alongside the request's. */
function armLine(requestId: string, fanoutId: string, fields: Record<string, unknown>): void {
  emitLine({ requestId, operation: "fleet.fanout.arm", fanoutId, ...fields });
}

function raceEvent(requestId: string, fanoutId: string, fields: Record<string, unknown>): void {
  emitLine({ requestId, operation: "fleet.fanout.race", fanoutId, ...fields });
}

function emitLine(fields: Record<string, unknown>): void {
  try {
    log({
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: typeof fields.durationMs === "number" ? (fields.durationMs as number) : 0,
      status: fields.error === undefined ? "ok" : "error",
      ...fields,
    } as Parameters<typeof log>[0]);
  } catch {
    // A raising sink must never replace the caller's real outcome.
  }
}

function errText(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e));
}

// ─── extension stamps (AC9/D3) ────────────────────────────────────────────────

/**
 * Stamp `extensions.fanout = { fanoutId, arm }` onto a run record through
 * DF2.1's pre-registered namespace. Idempotent (EEXIST stamp-skip — an
 * already-stamped record is never written twice) and ENOENT-tolerant (a
 * refused arm has no record to join). Any other failure THROWS: a join that
 * cannot be verified is the caller's to log, never a silent skip.
 */
export function stampFanoutExtension(store: RunRecordStore, runId: string, fanoutId: string, arm: number): void {
  let current: RunRecord;
  try {
    current = store.get(runId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw e;
  }
  if (current.extensions?.fanout !== undefined) return;
  // EXTENSION_NAMESPACES.fanout registers `arm` as a string — obey the registry.
  store.set(runId, { extensions: { fanout: { fanoutId, arm: String(arm) } } });
}
