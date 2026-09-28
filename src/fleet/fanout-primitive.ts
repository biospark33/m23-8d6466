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
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  checkHeadroom,
  type HeadroomResult,
} from "../providers/quota.ts";
import { claimQuotaIntentWeighted, releaseQuotaIntent } from "../providers/quota-intents.ts";
import { CostLedgerError } from "../providers/cost-ledger.ts";
import { TimeoutError, withTimeout } from "../providers/timeout.ts";
import type { ProviderAuditLink } from "../providers/driver.ts";
import { type BoxFileRead, readBoxFile } from "../providers/exedev/transport.ts";
import { teardownSandbox, type TeardownDeps } from "../providers/teardown.ts";
import { RunLockedError, withRunLock } from "../../scripts/lib/run-lock.ts";
import { defaultKeyCapMicroUsd } from "../providers/credentials.ts";
import type { RunRecord, RunRecordStore } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { boxRunRoot } from "../providers/harvest.ts";
import { log } from "../swarmclaw/log.ts";
import { BriefSchema, extractZodErrorField, type Brief } from "./brief-schema.ts";
import { dispatch, FleetError, mintRunId, type DispatchDeps, type MintedRunId } from "./dispatch.ts";
import { mintFanoutId, FanoutRecordStore } from "./fanout.ts";
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
 * Consecutive ticks whose probe produced NO evidence — the box never answered
 * (ssh 255), the call was SIGKILLed at its budget (137), the read timed out —
 * after which the arm is abandoned as armUnknown.
 *
 * Separate from MARKER_UNUSABLE_TICKS_LIMIT, and deliberately laxer, because
 * the reasoning is the opposite one: that limit rests on temp+rename making a
 * parse failure PERMANENT, while a transport failure is exactly the kind of
 * thing that is often transient. Counting is consecutive — any tick that
 * reaches the box (absent or unusable) clears the streak — so this bounds a box
 * that has stopped answering, not a blip.
 *
 * This is a TICK count, not a time bound, and the wall-clock it buys spans an
 * order of magnitude: a fast-failing probe (`ssh: connect … Connection
 * refused` returns in well under a second) makes six ticks ≈ 6 × the poll
 * interval — about 30 s on the AC5 defaults — while six probes that each burn
 * their whole per-call deadline take 6 × (poll + deadline) ≈ 90 s. Both inputs
 * are `deps` seams with no validation, so neither figure is a bound; what is
 * bounded is "six consecutive ticks with nothing to show", against a 1 h
 * ceiling held with the fleet lock.
 *
 * Because the fast end of that range is short, this limit alone cannot tell a
 * dead box from a dead HOST — one wifi/VPN/DNS blip fails every arm at once
 * and would cross the limit on all of them inside the same half-minute,
 * discarding every arm's in-flight spend for a fault that had nothing to do
 * with the boxes. `runRace` therefore only applies the limit when SOMETHING
 * answered on the same tick (or when the starved arm is the last undecided one
 * and there is nothing to compare it against). Abandoning is fail-safe for the
 * BOX — armUnknown is never torn down on a guess — but it is not fail-safe for
 * the RUN, which is why it needs corroboration.
 */
export const PROBE_SKIP_TICKS_LIMIT = 6;

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
  /**
   * DF5.3: the audit emit seam, required so an unwired construction fails at
   * compile time — a loser's teardown emits its `teardown` link through it.
   * The CLI binds it to `AuditStoreWriter.record` beside its other handles.
   */
  recordAuditLink: (link: ProviderAuditLink) => void;
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

/**
 * The F15 reconciliation's one ledger read, with the refusal every SIBLING
 * admission failure already gives (F048).
 *
 * A `SQLITE_BUSY`, an unopenable ledger file or a misconfigured
 * `deps.ledgerFactory` used to escape this loop as a RAW `Error`: bare CLI
 * exit 1 = `transient` = "retry me", for a condition retry does not clear —
 * while `dispatch.ts`'s admission gate converts the identical throw to
 * `refuse(5, "admission-failed", …)`. 5 is also honest about the side effects:
 * this runs before the first mint, so nothing was provisioned.
 */
function issueSnapshot(
  deps: FanoutDeps,
  repoSlug: string,
  issueId: string,
): { ceilingMicroUsd: number; spentMicroUsd: number; reservedMicroUsd: number } {
  try {
    const ledger = deps.ledgerFactory();
    try {
      return ledger.issueBudgetSnapshot(repoSlug, issueId);
    } finally {
      try {
        ledger.close();
      } catch {
        // a read-only probe's close failure must not mask the refusal below
      }
    }
  } catch (e) {
    // A FleetError from below is already classified — relabelling it here would
    // overwrite a designed refusal with a generic one.
    if (e instanceof FleetError) throw e;
    const q = e as { code?: unknown; remediation?: unknown };
    // Read once, up front: `q.code`/`q.remediation` may be throwing getters on
    // a hostile throwable, and re-reading after a first successful read would
    // still throw on a second call for a getter that only fires once.
    const qCode = safeRead(q, "code");
    const qRemediation = safeRead(q, "remediation");
    if (e instanceof CostLedgerError) {
      // dispatch.ts:1930-1956, verbatim rule: a FIXED fleet code with the
      // ledger's own in the payload. `invalid(5, e.code, …)` would make this
      // CLI's exit-code table whatever cost-ledger.ts currently emits. The
      // MESSAGE and REMEDIATION stay the ledger's — those are diagnosis and the
      // operator's literal next command, not a classification.
      //
      // Read through safeRead like the payload above: the "misconfigured
      // ledgerFactory" this function classifies can hand back a
      // CostLedgerError SUBCLASS whose `message`/`remediation` are throwing
      // getters, and evaluating them inside the catch would escape unclassified
      // as a bare exit 1 ("transient") — the exact regression this refusal
      // exists to prevent.
      const eMessage = safeRead(e, "message");
      const eRemediation = safeRead(e, "remediation");
      throw invalid(
        5,
        "ledger-failed",
        typeof eMessage === "string" ? eMessage : errText(e),
        typeof eRemediation === "string"
          ? eRemediation
          : "fix or move the cost ledger, then retry — nothing was provisioned",
        typeof qCode === "string" ? { providerCode: qCode } : undefined,
      );
    }
    // Everything else — a raw bun:sqlite SQLITE_BUSY/SQLITE_CANTOPEN, a
    // TypeError out of a misconfigured `deps.ledgerFactory`. The provider's own
    // code rides the payload as diagnosis, as the `headroom-failed` arm below
    // already does; it does not become this layer's FleetError code.
    throw invalid(
      5,
      "admission-failed",
      `budget admission failed: ${errText(e)}`,
      typeof qRemediation === "string"
        ? qRemediation
        : "fix or move the cost ledger, then retry — nothing was provisioned",
      typeof qCode === "string" ? { providerCode: qCode } : undefined,
    );
  }
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
    (!Number.isInteger(deps.capMicroUsd) ||
      deps.capMicroUsd <= 0 ||
      deps.capMicroUsd > defaultKeyCapMicroUsd)
  ) {
    // Same shape as credentials.ts's mint-time checks, but HERE — before the
    // lock — so an invalid cap never reaches the INV-3 admitted line or a box.
    // INV-CAP-1 (DF2.14) adds the backstop bound: `mintRunKey` refuses any cap
    // above `defaultKeyCapMicroUsd`, and refusing it only THERE let a fan-out
    // pass admission and F15, provision every arm's billable box, and then die
    // arm-by-arm at the mint. The bound is DERIVED from the same exported
    // constant the mint enforces — never a numeric copy.
    throw invalid(
      2,
      "invalid-cap",
      `capMicroUsd must be a positive integer of micro-dollars no greater than the backstop defaultKeyCapMicroUsd (${defaultKeyCapMicroUsd}), got ${JSON.stringify(deps.capMicroUsd)}`,
      "pass a positive-integer micro-dollar cap at or below defaultKeyCapMicroUsd, or drop capMicroUsd to use the key default; raising the backstop is a code change in src/providers/credentials.ts that owes a test naming it",
    );
  }
  // R4-34: the loser-teardown deadline is a `withTimeout` budget like the
  // reaper's action budgets — 0, a negative or NaN fires it immediately, which
  // reports every loser lost while its abandoned teardown keeps running and
  // strands a destructive-marked run lock. Refused here in D9, before the lock
  // and zero side effects, beside the other deps-seam checks (same shape as
  // reaper.ts's `budget-invalid`).
  if (
    deps.loserTeardownTimeoutMs !== undefined &&
    (!Number.isFinite(deps.loserTeardownTimeoutMs) || deps.loserTeardownTimeoutMs < 1)
  ) {
    throw invalid(
      2,
      "budget-invalid",
      `loserTeardownTimeoutMs ${JSON.stringify(deps.loserTeardownTimeoutMs)} is not a finite number >= 1 ms`,
      "pass a positive millisecond budget, or omit the seam for its default",
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
  // Q1.6 (G7): the lock is THIS record's, not the fleet's. The old global
  // fleet lock made a second concurrent fan-out fail exit-5 fleet-busy for as
  // long as the first held it — up to the 1h race ceiling — which is exactly
  // the contention a DAG host cannot absorb. The shared state the global lock
  // used to stand over is arbitrated at its own layers now: money in the
  // ledger's transactions (Q1.2), the VM ceiling in the quota intents the arms
  // claim through dispatch (Q1.5), record identity in O_EXCL creates (AC9).
  // What still needs a mutex is ONE fan-out record's lifecycle — its close and
  // its loser teardown against a second invocation of the SAME record — and
  // the lock scopes to that: <fanoutsDir>/<fanoutId>.lock. The id is minted
  // BEFORE the acquire for the path; AC9's create-before-first-mint ordering
  // is untouched (the RECORD is still created inside the lock, before any
  // runId mint).
  const fanoutId = mintFanoutId();
  const lockBase = deps.lockPath ?? FLEET_LOCK_PATH;
  const lock = new FleetLock({ path: join(dirname(lockBase), `fanout-${fanoutId}.lock`), requestId: deps.requestId });
  lock.acquire();
  try {
    // AC1: EXACTLY ONE checkHeadroom(N), inside the lock, before anything minted.
    const tAdmit = mono();
    let headroom: HeadroomResult;
    // Q1.5/Q1.6: the aggregate intent goes down BEFORE the ceiling read —
    // ONE weighted claim covering all N arms — and comes up when the fan-out
    // exits (the lock's own finally below). A concurrent plain dispatch's
    // checkHeadroom counts this fan-out's not-yet-visible boxes; the arms
    // themselves claim NOTHING (quotaIntentSkip) because this claim already
    // stands for them.
    const fanoutIntentsDir = join(dirname(deps.store.dir), "quota-intents");
    const fanoutOwnIntent = claimQuotaIntentWeighted(fanoutIntentsDir, deps.requestId, n);
    try {
      headroom = await checkHeadroom(deps.driver, n, deps.quotaLimits, undefined, {
        dir: fanoutIntentsDir,
        exclude: fanoutOwnIntent ? deps.requestId : undefined,
      });
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

    // ── F15 budget reconciliation: the DECLARED aggregate must fit the issue ──
    // Every arm of best-of-n/race runs ONE brief, so every arm shares ONE
    // issueId — and admitIssue budgets PER ISSUE. Measured live ×2 (fan-
    // 20260825-{ff6d64,b37e88}): with the issue ceiling below n×cap, arm 0
    // admitted and provisioned a billable box while every later arm was
    // refused budget-exceeded — a deterministic partial fan-out that spent
    // money on a fan-out the ledger was always going to strangle. Reconcile
    // BEFORE anything is minted: read the same three numbers admission acts on
    // and require headroom for the whole declared aggregate.
    //
    // F15b: many-stories arms may target DIFFERENT issues, and the briefs
    // carry no cross-issue rule — so the aggregate is per GROUP of briefs
    // sharing a canonical (repoSlug, issueId), not n×cap flattened onto
    // briefList[0]'s issue. Reading only arm 0 was wrong twice: it OVER-REFUSED
    // (demanding n×cap on an issue arm 0 alone bills cap against) and it
    // UNDER-PROTECTED (arms 1..n-1's issues were never checked, so their
    // budget-exceeded refusals landed mid-flight, after arm 0 provisioned).
    // The remedy names every short group's own config line — the operator's
    // cost-config stays the one place budgets are declared.
    // INV-CAP-1 (DF2.14): this cap can never be a figure the mint would
    // refuse. `validatePatternInput` bounded the override at
    // `defaultKeyCapMicroUsd` before the lock was taken, and the fallback IS
    // the backstop — so `need = count × cap` never reserves headroom for arms
    // whose keys could not be minted.
    const cap = deps.capMicroUsd ?? defaultKeyCapMicroUsd;
    const groups = new Map<string, { repoSlug: string; issueId: string; count: number }>();
    for (const b of input.briefList) {
      const issueId = String(b.issueId);
      const g = groups.get(`${b.repoSlug}#${issueId}`);
      if (g === undefined) groups.set(`${b.repoSlug}#${issueId}`, { repoSlug: b.repoSlug, issueId, count: 1 });
      else g.count += 1;
    }
    const shortGroups: Array<{
      issueKey: string;
      need: number;
      available: number;
      snapshot: { ceilingMicroUsd: number; spentMicroUsd: number; reservedMicroUsd: number };
    }> = [];
    for (const g of groups.values()) {
      const snapshotMicroUsd = issueSnapshot(deps, g.repoSlug, g.issueId);
      const available =
        snapshotMicroUsd.ceilingMicroUsd -
        snapshotMicroUsd.spentMicroUsd -
        snapshotMicroUsd.reservedMicroUsd;
      const need = g.count * cap;
      if (available < need) {
        shortGroups.push({
          issueKey: `${g.repoSlug}#${g.issueId}`,
          need,
          available,
          snapshot: snapshotMicroUsd,
        });
      }
    }
    if (shortGroups.length > 0) {
      const first = shortGroups[0] as (typeof shortGroups)[number];
      const message =
        shortGroups.length === 1
          ? `fan-out of ${n} arms at ${cap} µ$ each needs ${first.need} µ$ of issue headroom for ${first.issueKey}, but the ledger has ${first.available} (ceiling ${first.snapshot.ceilingMicroUsd} − spent ${first.snapshot.spentMicroUsd} − reserved ${first.snapshot.reservedMicroUsd})`
          : `fan-out of ${n} arms at ${cap} µ$ each across ${groups.size} issues lacks per-issue headroom: ${shortGroups
              .map(
                (s) =>
                  `${s.issueKey} needs ${s.need} µ$ (ledger has ${s.available}: ceiling ${s.snapshot.ceilingMicroUsd} − spent ${s.snapshot.spentMicroUsd} − reserved ${s.snapshot.reservedMicroUsd})`,
              )
              .join("; ")}`;
      const overrides = shortGroups.map((s) => `"${s.issueKey}": ${s.need}`).join(", ");
      throw invalid(
        5,
        "issue-ceiling-insufficient",
        message,
        `declare the aggregate${shortGroups.length === 1 ? "" : "s"} for this fan-out in .sandbox/cost-config.json: {"perIssueOverrides": {${overrides}}}`,
        {
          issues: shortGroups.map((s) => ({
            issueKey: s.issueKey,
            needMicroUsd: s.need,
            availableMicroUsd: s.available,
            ...s.snapshot,
          })),
        },
      );
    }

    // AC9: the record exists before the FIRST mint. Arms are attached right
    // after the mints (the schema wants real runIds, so create-then-fill).
    const store = new FanoutRecordStore({ dir: deps.fanoutsDir, requestId: deps.requestId });
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

    // INV-3: aggregate exposure stated BEFORE the first dispatch. `cap` is the
    // per-arm figure resolved in the F15 reconciliation above.
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
    // Q1.6: the aggregate intent comes up with the fan-out — the arms' boxes
    // are created (visible in the listing), refused, or abandoned, and the
    // ceiling reopens for the next submit either way.
    releaseQuotaIntent(join(dirname(deps.store.dir), "quota-intents"), deps.requestId);
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
          // Q1.6: the aggregate intent already covers this arm — a per-arm
          // claim would double-count it (and collide on the shared requestId).
          quotaIntentSkip: true,
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

// ─── the shared completion-marker read (DF1.10 AC5) ───────────────────────────

/**
 * The driver shape ONE marker read needs, taken from `readBoxFile` rather than
 * restated: a second structural copy is a second place the transport contract
 * can drift, and `execTimed`'s optionality is load-bearing (see its docblock —
 * `exec` hard-codes DEFAULT_EXEC_TIMEOUT_MS, so only `execTimed` pushes the
 * caller's deadline down to the spawn).
 */
export type MarkerReadDriver = Parameters<typeof readBoxFile>[0];

/**
 * Where THIS run's marker lives INSIDE the box — per-run since #217 F-D1,
 * derived from `harvest.ts`'s `boxRunRoot(runId)` and deliberately NOT from
 * `runMarkerPath()`. `runMarkerPath()` derives its base from the HOST's
 * `QDS_RUN_ROOT` (journal.ts) — a test seam for exercising `finish()` where
 * `/run` is root-owned or absent — and journal.ts names this exact hazard: an
 * ambient `QDS_RUN_ROOT` in an operator's shell, a test runner or a shell
 * profile must not redirect a BOX probe. It did: every `test -f` went to the
 * wrong in-box path, missed cleanly, and `fleet status` reported a whole fleet
 * as `running` regardless of what the runs had done. `harvest.ts` reached the
 * same conclusion for its own box-side reads; this is that rule, kept now that
 * the path is per-run.
 *
 * `runMarkerPath()` stays correct for code that runs IN the box (the engine
 * writing the marker) — that is the only place the seam belongs.
 */
export function boxMarkerPath(runId: string): string {
  return `${boxRunRoot(runId)}/journal/final.json`;
}

/**
 * The SHAPE of a per-run marker path, unanchored so it also finds the path
 * embedded in a `test -f '<path>'` / `cat '<path>'` script line. Exists for
 * the test fixtures that used to key on the exact `BOX_MARKER_PATH` literal:
 * the path is per-run now, so a fixture intercepts by grammar instead of by
 * one string — same immunity to a host-side `QDS_RUN_ROOT`, which cannot
 * reach a path this shape describes.
 */
export const BOX_MARKER_PATH_RE = /\/run\/qds-run\/[^/"\\\s'"]+\/journal\/final\.json/;

/**
 * One completion-marker read, classified — the verdict BOTH the fan-out race
 * poller and `fleet status`'s in-box read act on (DF1.10 AC5 requires the two
 * to share this code, not to agree by inspection).
 *
 * `BoxFileRead`'s four kinds (`absent`/`unreadable`/`oversized`/`content`)
 * collapse to four verdicts, not four-to-four, because the mapping is about
 * what the reading PROVES rather than about which leg produced it:
 *  - `absent` — the presence probe answered cleanly and the marker is simply
 *    not there yet. The one reading that RESETS a corruption streak.
 *  - `skip` — no evidence either way (the probe itself never answered), so it
 *    must neither reset a corruption streak nor decide anything.
 *  - `unusable` — the marker is THERE and cannot be judged: unreadable at
 *    `cat`, over the capture cap, unparseable, or carrying a non-boolean `ok`.
 *    journal.ts publishes it by temp+rename, so persistence means corruption.
 *  - `settled` — the marker parsed and carries a boolean `ok`.
 *
 * `code`/`error` ride the two non-decisive verdicts so the caller can log the
 * cause without this function reaching for a log sink. The codes are NEUTRAL
 * (`marker-probe-failed`, `marker-read-failed`, `marker-probe-timeout`) and
 * that is a correction: they used to be the race poller's (`race-…`), so
 * `fleet status` on a plain single run emitted `code:"race-probe-failed"` and
 * sent an operator hunting a fan-out that did not exist. Each caller maps the
 * verdict into ITS own vocabulary — `probeArm` back to the `race-…` codes
 * `tests/fleet/patterns.test.ts` pins, `fleet status` to its own note — which
 * is what "the caller logs it in its own vocabulary" was always supposed to
 * mean.
 */
export type MarkerVerdict =
  | { kind: "absent" }
  | { kind: "skip"; code: string; error: unknown }
  | { kind: "unusable"; code: string; error: unknown }
  | { kind: "settled"; ok: boolean };

/**
 * `BoxFileRead` → `MarkerVerdict`. PURE: it logs nothing and mutates nothing,
 * which is what lets two callers with different side effects share it.
 *
 * `expectedRunId`, when given, is the run the CALLER believes owns this box,
 * and a marker naming a different run is `unusable` rather than `settled`. Two
 * records can address one box — `joinedBox` falls back to matching on the run
 * id for the INV-1 crash window, and `reportDuplicateBoxNames` exists because
 * duplicate box names happen — and the marker body carries `runId`
 * (journal.ts's `writeTerminalMarker`), so whose run settled is a question the
 * read can actually answer instead of assuming. Without it a record whose id
 * collided with a live box owned by another record read THAT box's marker and
 * reported `ok` for a run that never started.
 *
 * A marker with NO `runId` is not a mismatch: it is an older or hand-written
 * marker that makes no claim about ownership, and refusing it would fail closed
 * on a reading that is merely less informative. A `runId` that is PRESENT but
 * not a string is not "no claim" either: the one legit writer
 * (`writeTerminalMarker`) always emits a string, so a `runId` of any other type
 * is corruption on a box whose ownership therefore cannot be judged — treating
 * it as claim-less once let a wrong-box marker settle this run via `{"runId":42}`.
 * The EMPTY string is corruption on the same evidence (no legit writer emits
 * `""`): until R4 it slipped past this arm and, with no expectation passed,
 * settled a run via `{"runId":"","ok":true}`. Only a marker that names a
 * DIFFERENT run is a mismatch — that one is positive evidence of the wrong box.
 */
export function classifyMarkerRead(res: BoxFileRead, expectedRunId?: string): MarkerVerdict {
  if (res.kind === "absent") {
    // "absent" is only a CLEAN read when `test -f` itself answered cleanly.
    // `readBoxFile` reports every non-zero probe exit as absence and carries
    // the exit so callers can tell the two apart (BoxFileRead's own doc):
    // exit 1 is the file genuinely not being there, while 255 (ssh never
    // connected) and 137 (SIGKILLed at the budget) are the box not
    // answering. Treating those as a clean read RESET the arm's corruption
    // streak on every tick, so a dead arm could never reach
    // MARKER_UNUSABLE_TICKS_LIMIT and the race spun to its full ceiling with
    // the fleet lock held — the exact failure the streak limit exists to
    // bound. `undefined` keeps the clean reading, per the type: absence is
    // still absence without the exit.
    //
    // JSON.stringify, not a raw slice, for every stderr tail below: it is
    // box-controlled and these notes are logged — a newline or an ANSI escape
    // in one forges log lines from a box that has just stopped answering
    // (transport.ts:344 states the same rule on the gate path).
    if (res.probeExit === undefined || res.probeExit === 1) return { kind: "absent" };
    return {
      kind: "skip", // no evidence either way: never resets the streak, and counted on its own
      code: "marker-probe-failed",
      // Phrased for EVERY non-clean exit, not just the ssh/SIGKILL pair. `0`
      // reaches here too — `readBoxFile` only reports absence on a non-zero
      // probe, so `{kind:"absent", probeExit:0}` is a self-contradictory
      // reading from some other producer — and the old sentence ("not `test
      // -f`'s clean miss (exit 1), so absence is unproven") read as nonsense
      // against it. It is still `skip`: a contradictory reading is no evidence,
      // which is the fail-closed disposition either way.
      error: new Error(`presence probe exited ${String(res.probeExit)} — only exit 1 is \`test -f\`'s clean miss, so absence is unproven: ${JSON.stringify(res.probeStderr?.trim().slice(0, 200) ?? "")}`),
    };
  }
  if (res.kind === "unreadable") {
    // `exitCode: -1` is the transport's "no process ever ran" sentinel
    // (transport.ts: no `cat` was issued — the presence probe spent the whole
    // shared budget). Blaming a `cat` that never existed ("cat exited -1")
    // sends the operator to the box for a fault the CALLER's deadline caused,
    // exactly what the sentinel exists to prevent — so the exhausted case is
    // named as latency, not corruption, while keeping the same `unusable`
    // disposition (present, unjudgeable) below.
    if (res.exitCode === -1) {
      return {
        kind: "unusable",
        code: "marker-read-budget-exhausted",
        error: new Error(`no cat was issued — ${JSON.stringify(res.stderr.trim().slice(0, 200))}`),
      };
    }
    // Present at test, unreadable at cat. The box answered TWICE on this
    // tick, so this is emphatically not "no evidence" and must not be
    // counted as an unanswered probe — an arm abandoned this way used to be
    // logged as `probe-unanswered`, which asserts the opposite of what
    // happened and sends the operator looking for a dead box. It is counted
    // as corruption instead: journal.ts publishes the marker by temp+rename,
    // so a `cat` that keeps failing on a file `test -f` keeps finding is
    // EACCES/EIO, not a half-written file. A genuinely vanishing marker
    // clears the streak by itself — the next tick's `test -f` misses and
    // reads clean.
    return {
      kind: "unusable",
      code: "marker-read-failed",
      error: new Error(`cat exited ${res.exitCode}: ${JSON.stringify(res.stderr.trim().slice(0, 200))}`),
    };
  }
  if (res.kind === "oversized") {
    // Present but permanently over the capture cap — not a transient read
    // failure (returning null here would poll it forever). Counted the same
    // as present-but-corrupt so runRace's unusable-streak handling applies.
    return { kind: "unusable", code: "marker-oversized", error: new Error("marker output exceeded the capture cap") };
  }
  // EXPLICIT, not a fall-through. The three arms above used to be the only
  // tests, so anything else reached `JSON.parse(res.content)` — and the day
  // `BoxFileRead` grows a fifth arm (transport.ts) that is `JSON.parse(undefined)`,
  // a TypeError reported as marker CORRUPTION and counted against the give-up
  // streak. A reading this build cannot name is no evidence, which is `skip`.
  if (res.kind !== "content") {
    return {
      kind: "skip",
      code: "marker-read-unclassified",
      error: new Error(`BoxFileRead kind ${JSON.stringify((res as { kind?: unknown }).kind)} is not one this build classifies`),
    };
  }

  let marker: { ok?: unknown; runId?: unknown };
  try {
    marker = JSON.parse(res.content) as { ok?: unknown; runId?: unknown };
  } catch (e) {
    // present-but-corrupt is counted by the caller's streak, never polled forever
    return { kind: "unusable", code: "marker-unreadable", error: e };
  }
  // `JSON.parse` is guarded but its RESULT is not: `null` parses cleanly, the
  // `as` cast above is not a check, and `marker.runId` on a null dereferences
  // to a TypeError — caught upstream as `skip`/`marker-probe-failed`, i.e. "the
  // box never answered", for a marker that IS present and IS corrupt. That is
  // the `unusable` vocabulary's exact case (counted on the corruption streak,
  // not the unanswered-probe one), so a JSON `null` body — and any primitive
  // the same parse can produce — is classified here rather than misdiagnosed.
  if (marker === null || typeof marker !== "object") {
    return {
      kind: "unusable",
      code: "marker-unreadable",
      error: new Error(`final.json parsed to ${JSON.stringify(marker)} — not a JSON object`),
    };
  }
  // WHOSE run settled — checked before `ok` is read at all, so a marker from
  // another run can never decide this one in either direction. See the
  // `expectedRunId` note above: a PRESENT-but-non-string `runId` (JSON cannot
  // produce `undefined`, so `!== undefined` is exactly "the key is there") is
  // unusable, never "makes no claim".
  //
  // The non-string arm is UNCONDITIONAL, not gated on the caller passing an
  // expected id: `fleet status` passes none, and under the old conditional a
  // `{"runId":42,"ok":true}` marker settled a run cleanly on exactly the
  // status path the docblock above says a wrong-typed claim must never
  // decide. Corruption of the ownership claim is corruption wherever it is
  // read; only the MISMATCH needs to know which run was expected.
  if (marker.runId !== undefined && (typeof marker.runId !== "string" || marker.runId === "")) {
    return {
      kind: "unusable",
      code: "marker-run-id-invalid",
      error: new Error(
        `final.json carries runId=${JSON.stringify(marker.runId)} — ${marker.runId === "" ? "the empty string" : "not a string"}, so whose run settled cannot be judged`,
      ),
    };
  }
  if (expectedRunId !== undefined && marker.runId !== undefined) {
    if (marker.runId !== expectedRunId) {
      return {
        kind: "unusable",
        code: "marker-run-mismatch",
        error: new Error(
          `final.json on this box names run ${JSON.stringify(marker.runId)}, not ${JSON.stringify(expectedRunId)} — the box is another run's`,
        ),
      };
    }
  }
  if (marker.ok === false) return { kind: "settled", ok: false };
  if (marker.ok !== true) {
    // same corruption counting as the parse failure above
    return {
      kind: "unusable",
      code: "marker-unreadable",
      error: new Error(`final.json carries ok=${JSON.stringify(marker.ok)}`),
    };
  }
  return { kind: "settled", ok: true };
}

/**
 * ONE marker read, bounded by `deadlineMs` and classified — `readBoxFile` plus
 * `classifyMarkerRead` plus the fail-closed catch, which is the whole read path
 * both callers share.
 *
 * The catch is part of the contract, not defensive padding: a TimeoutError or
 * any transport failure BEFORE the marker was read as a verdict is `skip` —
 * the probe produced no reading, and nothing else. Everything a caller does
 * AFTER a verdict (claiming a winner, deciding a row) is its own, and keeps its
 * own guards, so a post-read failure can never land here and be miscounted as
 * an unanswered probe.
 *
 * That scoping is literal: only the READ is under the `skip` catch. A throw
 * during CLASSIFICATION is a read that demonstrably happened — a hostile
 * field getter on the `BoxFileRead`, the same throwable the `safeRead` rule
 * below exists for — and mapping it to `skip` ("the probe never answered")
 * would starve the corruption streak that exists to bound exactly this.
 * It fails closed the other way: present, unjudgeable, counted on the
 * corruption streak (`unusable`).
 */
export async function readMarkerVerdict(
  driver: MarkerReadDriver,
  vm: string,
  markerPath: string,
  deadlineMs: number,
  /** The run the caller believes owns this box — see `classifyMarkerRead`. */
  expectedRunId?: string,
): Promise<MarkerVerdict> {
  let res: BoxFileRead;
  try {
    // The probe commands are BUILT in the providers layer (readBoxFile), never
    // here: `dispatch.ts:63-66` states the DoD as "no substrate command string
    // under `src/fleet/`". Shell-quoting of the marker path (AC5) and the
    // per-call deadlines ("race-probe"/"race-read") live with them.
    res = await readBoxFile(driver, vm, markerPath, deadlineMs);
  } catch (e) {
    return { kind: "skip", code: e instanceof TimeoutError ? "marker-probe-timeout" : "marker-probe-failed", error: e };
  }
  try {
    return classifyMarkerRead(res, expectedRunId);
  } catch (e) {
    // The read landed; its verdict could not be produced. `unusable`, never
    // `skip` — and this function still never rejects (its contract, pinned by
    // fanout-primitive.test.ts).
    return { kind: "unusable", code: "marker-read-failed", error: e };
  }
}

/**
 * The MARKER_UNUSABLE_TICKS_LIMIT reclassification, in ONE place: this many
 * CONSECUTIVE unusable reads mean the marker is corrupt rather than late, so
 * the run's state is UNKNOWN — never ok, never a loser, never torn down on a
 * guess. `runRace` gives the arm up here.
 *
 * The sole caller is `runRace` — `fleet status` never invokes this. The
 * predicate stands as the ONE definition of the ceiling's semantics (when a
 * marker stops being late and starts being corrupt), single-sourced here so
 * they cannot be duplicated into a second copy that drifts. Status needs no
 * ceiling of its own: it is a single-read snapshot, and ONE unusable read
 * maps straight to `unknown` (status.ts) — the same answer the ceiling
 * exists to produce here. The two cannot disagree because status never
 * reaches the ceiling question.
 */
export function markerUnusableGivesUp(consecutiveUnusableTicks: number): boolean {
  return consecutiveUnusableTicks >= MARKER_UNUSABLE_TICKS_LIMIT;
}

// ─── the race poller (AC5) — host-side composition, no port method added ──────

/**
 * Poll every racing arm's in-box completion marker (`DF1.1's finish(accepted)`
 * file) until one satisfies the predicate (`ok === true`) or the ceiling
 * expires. Each probe/read carries its own per-call deadline: ExeDevDriver
 * execs can outlive a destroy (driver.ts:153-168), so a hung remote call
 * SKIPS its tick — logged, non-fatal — instead of wedging the loop.
 *
 * A marker that EXISTS but cannot be read as `{ok: boolean}` — unreadable at
 * `cat`, over the capture cap, or not parseable — is different: journal.ts
 * publishes it by temp+rename, so persistence of the failure means corruption,
 * not latency. After MARKER_UNUSABLE_TICKS_LIMIT consecutive unusable reads an
 * arm is reclassified armUnknown and dropped from polling (never touched by
 * loser disposal — its run state is genuinely unknown), bounding what used to
 * spin to the full ceiling with the fleet lock held.
 *
 * Skipped ticks are counted SEPARATELY (PROBE_SKIP_TICKS_LIMIT), for a similar
 * bound by different reasoning: a skip is no evidence either way, so it must
 * not reset a genuine corruption streak — but "no evidence" repeated forever is
 * how a box that has simply stopped answering would otherwise stay undecided
 * to the ceiling. A third streak bounds claim-failed ticks (the marker read as
 * a WINNER but the record write keeps failing) at MARKER_UNUSABLE_TICKS_LIMIT:
 * the marker is still there and still says this arm won, yet a stale record
 * lock or an unvalidatable record fails the claim forever — re-reading it
 * every tick to the ceiling with the fleet lock held is the same spin the
 * other streaks bound. All streaks are consecutive. A filled UNUSABLE streak
 * abandons the arm outright; a filled SKIP streak abandons it only with
 * corroboration that the transport is up (some arm answered on the same tick,
 * or the starved arm is the last undecided one) — otherwise one host-side blip
 * would abandon all N arms at once. See PROBE_SKIP_TICKS_LIMIT.
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
): Promise<number | null> { /* dp:ok probeArm self-guards every await: readMarkerVerdict never rejects (its own contract, pinned by fanout-primitive.test.ts), the claim write carries its own try/catch, and every log line goes through emitLine, which swallows a raising sink; the sleep promise never rejects */
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadlineMs = deps.perCallDeadlineMs ?? DEFAULT_PER_CALL_DEADLINE_MS;
  const ceilingMs = deps.ceilingMs ?? DEFAULT_FANOUT_CEILING_MS;
  const undecided = (): number[] => outcomes.filter((o) => o.outcome === "ready").map((o) => o.arm);
  const unusableTicks = new Map<number, number>();
  const skipTicks = new Map<number, number>();
  // P19: consecutive claim-failed ticks per arm — a winner marker the
  // host-side record write keeps failing to claim. See the branch below.
  const claimFailedTicks = new Map<number, number>();
  const giveUp = (arm: number, event: string, detail: string): void => {
    outcomes[arm] = { ...(outcomes[arm] as ArmOutcome), outcome: "armUnknown" };
    // Dropping from `ready` removes the arm from `undecided()` and from
    // disposeLosers' entrants in one move: an unknown-state box is never
    // torn down on a guess, and no longer polls.
    raceEvent(deps.requestId, fanoutId, { arm, event, detail });
  };

  const baseline = performanceNow(deps);
  while (undecided().length > 0 && performanceNow(deps) - baseline < ceilingMs) {
    const current = undecided();
    // Did ANY arm reach its box this tick? A skip streak is only evidence
    // about a box if the transport itself is demonstrably up — see below.
    let anyArmAnswered = false;
    // arm → its streak length, for the arms whose skip streak filled on this
    // tick. Collected rather than acted on immediately, because the decision
    // needs the whole tick's evidence.
    const starved = new Map<number, number>();
    // Tie-break: when multiple arms complete in the same poll iteration, the lowest arm index wins (r7-S4a).
    for (const arm of current) {
      // The marker path is PER-RUN (#217 F-D1): each arm polls its own run's
      // root, derived from the arm's dispatched runId — never a shared literal,
      // and never the host's QDS_RUN_ROOT. An arm with no runId on record
      // cannot have its root derived at all; it is given up loudly rather than
      // polled at a path that would belong to some other run.
      const armRunId = (outcomes[arm] as ArmOutcome).runId;
      if (armRunId === undefined || armRunId === null) {
        giveUp(arm, "race-marker-root-unknown", "the arm carries no runId, so its per-run marker root cannot be derived (F-D1); refusing to poll a path that would belong to another run");
        continue;
      }
      const verdict = await probeArm(deps, store, fanoutId, outcomes, arm, boxMarkerPath(armRunId), deadlineMs);
      if (verdict !== null && typeof verdict === "object") {
        // The probe reached the box, so whatever else is wrong, it is ANSWERING.
        anyArmAnswered = true;
        skipTicks.delete(arm);
        claimFailedTicks.delete(arm);
        const ticks = (unusableTicks.get(arm) ?? 0) + 1;
        unusableTicks.set(arm, ticks);
        // The ceiling rule itself is single-sourced in this ONE predicate
        // (DF1.10 AC5): only the poller consumes it — `fleet status` maps a
        // single unusable read straight to `unknown` and never counts ticks.
        // The EVENT carries the verdict's own code verbatim —
        // "marker-run-mismatch" (the box is another run's) must not be
        // reported as generic unreadability, or the operator re-examines a
        // marker that was never corrupt.
        if (markerUnusableGivesUp(ticks)) {
          // E4: the event's CODE goes through raceCode like every skipTick
          // line does — the tick lines say `race-read-failed`, so the give-up
          // that abandons the arm on the filled streak must not spell the
          // same fault `marker-read-failed` and split the one evidence stream
          // across two greppable names. The raw neutral code stays in the
          // detail for diagnosis.
          giveUp(
            arm,
            raceCode(verdict.code),
            `${verdict.code} for ${String(ticks)} ticks in a row — arm left UNKNOWN, polling abandoned`,
          );
        }
        continue;
      }
      if (verdict === "absent") {
        // The probe RAN and read the box clean — the marker is just not there
        // yet. Every streak is CONSECUTIVE (the contract above), so the clean
        // read clears them all.
        anyArmAnswered = true;
        claimFailedTicks.delete(arm);
        unusableTicks.delete(arm);
        skipTicks.delete(arm);
        continue;
      }
      if (verdict === "claim-failed") {
        // The marker WAS read (and read as a winner); only the host-side
        // record write failed. That is the opposite of "no evidence", so it
        // clears the other streaks — but a claim that NEVER lands (a stale
        // fanout-record lock `acquireRunLock` refuses to steal, a record the
        // store's strict validation rejects on every attempt, EIO on the
        // records dir) would otherwise re-read a settled winner every tick to
        // the 1 h ceiling with the fleet lock held and finally report it
        // armUnknown — the exact spin these streaks exist to bound. Bounded
        // at MARKER_UNUSABLE_TICKS_LIMIT, the corruption bound, not the laxer
        // skip one: like a temp+rename parse failure, a persistent claim
        // failure is structural and does not heal with latency.
        anyArmAnswered = true;
        // The box ANSWERED — the marker read as a winner — which is evidence
        // against the other streaks, and every streak is consecutive: the
        // corruption and skip streaks clear here too, or a skip tick between
        // two claim failures would keep counting toward give-up for a box
        // that is demonstrably up.
        skipTicks.delete(arm);
        unusableTicks.delete(arm);
        const failed = (claimFailedTicks.get(arm) ?? 0) + 1;
        claimFailedTicks.set(arm, failed);
        if (failed >= MARKER_UNUSABLE_TICKS_LIMIT) {
          giveUp(
            arm,
            "race-claim-failed",
            `winner claim write failed ${String(failed)} ticks in a row — arm left UNKNOWN, polling abandoned`,
          );
        }
        continue;
      }
      if (verdict === "skip") {
        // No evidence either way, so it must not reset the corruption streak —
        // but it cannot be free either, or a box that never answers stays
        // undecided to the ceiling with the fleet lock held. Its own streak.
        const skips = (skipTicks.get(arm) ?? 0) + 1;
        skipTicks.set(arm, skips);
        if (skips >= PROBE_SKIP_TICKS_LIMIT) starved.set(arm, skips);
        continue;
      }
      // The settled-failed marker: the box answered, and decisively.
      if (verdict === null) {
        anyArmAnswered = true;
        continue;
      }
      return verdict; // includes "another process won"
    }
    // A filled skip streak means "this BOX stopped answering" only if the
    // transport is otherwise working. When every undecided arm skipped the same
    // tick the common cause is the HOST — the operator's wifi/VPN, DNS, an
    // exe.dev control-plane hiccup — and those fail fast, so all N arms would
    // cross the limit inside the same half-minute: `runRace` would return null,
    // discard every arm's in-flight LLM spend, and (by the deliberate "unknown
    // is never torn down" rule) leave every box running for the orphan reaper.
    // So the streak is only ACTED on with corroboration: some other arm reached
    // its box this tick, or the starved arm is the last undecided one, where
    // there is nothing to corroborate against and the per-arm bound is all that
    // stands between a dead box and the 1 h ceiling. Streaks keep counting
    // either way, so the arm is abandoned the moment the fleet recovers around
    // it.
    if (anyArmAnswered || current.length === 1) {
      for (const [arm, skips] of starved) {
        giveUp(
          arm,
          "probe-unanswered",
          `probe produced no reading ${String(skips)} ticks in a row — arm left UNKNOWN, polling abandoned`,
        );
      }
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
 * process's), the unusable VERDICT itself (code attached — runRace names that
 * code verbatim in the give-up event) when the marker exists but cannot be
 * judged, "absent" when the probe ran clean and the marker is simply not there
 * yet (the usable read that resets the arm's corruption streak), "skip" when
 * the tick produced no reading at all (both streaks are runRace's to count),
 * "claim-failed" when the marker read as a WINNER but the record write did not
 * land (runRace counts those on their own streak and bounds them), and null for
 * the settled-failed marker, which decides the arm here and stops polling it.
 */
/**
 * The RACE's own name for a read that produced no usable verdict.
 *
 * `readMarkerVerdict` speaks neutrally (`marker-…`) because `fleet status`
 * shares it and a status row on a plain single run must not emit a code naming
 * a fan-out. The poller's log lines are a fan-out's, and the `race-…` codes are
 * what `tests/fleet/patterns.test.ts` and the tier-3 live round key on, so the
 * translation happens HERE — at the one caller those codes belong to — rather
 * than by making every other caller inherit them. Codes with no race spelling
 * (`marker-oversized`, `marker-unreadable`, `marker-run-mismatch`) pass
 * through: they name the MARKER, which is the same object in both vocabularies.
 */
const RACE_CODES: Readonly<Record<string, string>> = {
  "marker-probe-failed": "race-probe-failed",
  "marker-probe-timeout": "race-probe-timeout",
  "marker-read-failed": "race-read-failed",
  "marker-read-budget-exhausted": "race-read-budget-exhausted",
};

function raceCode(code: string): string {
  return Object.hasOwn(RACE_CODES, code) ? (RACE_CODES[code] as string) : code;
}

/** The unusable verdict with its `code`/`error` intact — probeArm's return for a present-but-unjudgeable marker. */
type UnusableTick = Extract<MarkerVerdict, { kind: "unusable" }>;

async function probeArm(
  deps: FanoutDeps,
  store: FanoutRecordStore,
  fanoutId: string,
  outcomes: OutcomeSlot[],
  arm: number,
  markerPath: string,
  deadlineMs: number,
): Promise<number | null | "absent" | "skip" | "claim-failed" | UnusableTick> {
  const outcome = outcomes[arm] as ArmOutcome; // racing arms are settled and ready
  const vm = outcome.vmName as string;
  const skipTick = (code: string, e: unknown): void => {
    raceEvent(deps.requestId, fanoutId, { arm, error: { code: raceCode(code), message: errText(e) } });
  };
  // The read, its classification and its fail-closed catch are SHARED with
  // `fleet status`'s in-box read (DF1.10 AC5) — see readMarkerVerdict. What
  // stays here is what is the RACE's alone: the skip-tick vocabulary, the
  // armFailed transition and the winner claim.
  //
  // The arm's OWN runId rides the read: an arm polls the box it provisioned,
  // and a marker naming a different run is another run's settlement — never
  // this arm's win. See classifyMarkerRead's `expectedRunId`.
  const verdict = await readMarkerVerdict(deps.driver, vm, markerPath, deadlineMs, outcome.runId ?? undefined);
  if (verdict.kind === "absent") return "absent";
  if (verdict.kind === "skip") {
    skipTick(verdict.code, verdict.error);
    return "skip";
  }
  if (verdict.kind === "unusable") {
    skipTick(verdict.code, verdict.error);
    return verdict; // the verdict itself, so runRace can name the code when it gives up
  }
  if (!verdict.ok) {
    // A settled-but-failed run: armFailed and the race CONTINUES (G6:
    // the marker fires on EVERY settled run — absence ≠ pending failure).
    outcomes[arm] = { ...outcome, outcome: "armFailed" };
    raceEvent(deps.requestId, fanoutId, { arm, event: "arm-failed-marker" });
    return null;
  }
  // Atomic first-writer transition, under the record's own lock: the mutate
  // fn ADOPTS the persisted winner when another writer claimed first — the
  // caller has to learn who won HERE, or this process re-probes to the
  // ceiling holding the fleet lock while its losers never tear down.
  //
  // Guarded SEPARATELY from the read above: readMarkerVerdict classifies a
  // failed READ as `skip` ("no evidence"), and by this point there is evidence
  // — the marker was read and it says this arm WON. A lock contention with a
  // second process racing the same fanoutId, a corrupt fanout record or an
  // EIO here is a HOST-side failure to record finished work, and counting it
  // as an unanswered probe six times over abandoned a winning arm as
  // armUnknown: the work discarded, the box leaked.
  let claimed: number | null = null;
  let mutateInvoked = false;
  try {
    store.mutate(fanoutId, (rec) => {
      mutateInvoked = true;
      if (rec.winner !== null) {
        claimed = rec.winner;
        return rec;
      }
      claimed = arm;
      return { ...rec, winner: arm };
    });
  } catch (e) {
    skipTick("race-claim-failed", e);
    return "claim-failed"; // the marker is still there; the next tick re-claims
  }
  // E1: a NO-OP mutate — the record absent, or the store's validation silently
  // skipping the write — returns without ever invoking the fn. No throw, no
  // claim, no evidence, and `claimed` still null: the old path reported that
  // as "another writer claimed arm null" and returned null, which runRace
  // reads as the settled-failed marker — the arm stayed `ready` and re-read
  // its winner marker every tick to the ceiling. Onto the claim-failed
  // streak instead: bounded, loud, and the arm is never "lost" on a phantom.
  if (!mutateInvoked) {
    skipTick("race-claim-failed", new Error("store.mutate returned without invoking the claim fn — the winner claim never landed"));
    return "claim-failed"; // the marker is still there; the next tick re-claims
  }
  // E2: a persisted winner that is not a number (a hand-written or drifted
  // record) must never become the race's winner index — `undefined` here used
  // to flow straight out of runRace into `outcomes[undefined]`. Fail-closed on
  // the streak: the arm is abandoned UNKNOWN, and runRace can only ever
  // return a number or null.
  if (typeof claimed !== "number") {
    skipTick(
      "race-claim-failed",
      new Error(`persisted winner ${JSON.stringify(claimed ?? null)} is not a number — refusing to adopt it as the race winner`),
    );
    return "claim-failed";
  }
  if (claimed !== arm) {
    raceEvent(deps.requestId, fanoutId, {
      arm,
      error: { code: "race-lost-cross-process", message: `another writer claimed arm ${String(claimed)}` },
    });
    return claimed; // someone else won: our arms are all losers
  }
  raceEvent(deps.requestId, fanoutId, { arm, event: "won" });
  return arm;
}


/**
 * Winner disposal: every arm that ENTERED the race (gate returned ready) and
 * did not win goes through DF2.5's teardownSandbox UNMODIFIED — its fixed step
 * array harvests before it destroys (teardown.ts:99-111). Per-arm guards: one
 * failed disposal never aborts a sibling's. Each teardown runs under its own
 * DF2.5 run lock; a refusal (`loser-teardown-refused`) means the sandbox never
 * started — the holder's progress stays the operator's judgment.
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
    driver: deps.driver,
    store: deps.store,
    keyApi: deps.keyApi,
    requestId: deps.requestId,
    // DF5.3: the fan-out race's own TeardownDeps construction threads the
    // required audit seam, so a loser's teardown emits its `teardown` link.
    recordAuditLink: deps.recordAuditLink,
    // DF2.8: a loser's close step must price its box hours like any teardown,
    // or the ledger under-counts spend and a later assertWithinBudget
    // over-admits against the cap.
    ...(deps.costLedger === undefined ? {} : { costLedger: deps.costLedger }),
  };
  // Undecided losers become lostRace; a marker-decided armFailed KEEPS its
  // classification (a completed run that reported failure — not a race loss).
  for (const o of entered) {
    if (o.outcome === "ready") outcomes[o.arm] = { ...o, outcome: "lostRace" };
  } // NOTE: spread required — o is OutcomeSlot without guaranteed outcome field
  // E9: this value and teardownSandbox's own head check (teardown.ts:491)
  // both derive the lock path from `runsDir ?? store.dir`, so an unresolvable
  // value would mint `undefined/<runId>.lock` — a path nothing else in the
  // system addresses, with every loser reported "refused" against it. The
  // real RunRecordStore guarantees a resolved `dir`, so this is
  // defense-in-depth against a non-conforming store seam — but the failure
  // mode is destructive-path-wide, so it fails closed BEFORE the destructive
  // window opens: no loser touched, the record left open, one named refusal
  // instead of N silent ones.
  const runsDir = teardownDeps.runsDir ?? teardownDeps.store.dir;
  if (typeof runsDir !== "string" || runsDir === "") {
    throw invalid(
      5,
      "loser-teardown-unknown-runs-dir",
      "loser disposal cannot resolve the runs directory for the per-run lock paths — runsDir is unset and the record store exposes no dir",
      "pass runsDir in the fanout deps (or build the record store with a dir), then rerun — no race loser was torn down",
    );
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
        await withTimeout(
          // DF2.5: each loser's teardown runs under ITS OWN run lock — the same
          // `<runsDir>/<runId>.lock` teardownSandbox's head check expects, so
          // the handle this loop mints is the one the sandbox verifies. A
          // sibling invocation (a hung harvest, the reaper) holding the lock
          // refuses the acquire before anything is mutated.
          withRunLock(
            runsDir,
            o.runId as string,
            "fanout loser teardown",
            (h) => teardownSandbox(teardownDeps, o.runId as string, h),
            // D7: the acquire contract line carries the fan-out's correlation
            // id, like every other emission on this path.
            { destructive: true, requestId: deps.requestId },
          ),
          teardownDeadlineMs,
          "loser-teardown",
        );
      } catch (e) {
        // A refusal is not a failure: the box and its record are untouched
        // (acquire throws before any mutation) and the holder's progress is
        // the operator's judgment, per DF2.5's no-steal posture. Typed and
        // remediated, never silent — and one locked loser never aborts the
        // disposal of its siblings: the loop continues either way.
        // Ceiling: a loser-teardown timeout cannot cancel the in-flight
        // teardown — the run lock it holds (destructive-marked) stays owned
        // by THIS process until exit, and the lock must NOT be released here
        // (the teardown may be mid-destroy).
        // E6: the plain-failure arm is the one most likely to have LEFT the
        // destructive mark behind — withRunLock attaches its own "the
        // destructive window was interrupted, judge the lock" remediation to
        // the thrown error, and the old `{}` silently discarded it. Inherit
        // whatever the failure carries (safeRead: a throwing getter must not
        // escape the catch).
        const inherited = safeRead(e as { remediation?: unknown }, "remediation");
        const remediation =
          e instanceof RunLockedError
            ? { remediation: e.remediation }
            : e instanceof TimeoutError
              ? {
                  // E7: a deadline hit does not prove the lock is still held —
                  // a teardown that COMPLETED after the deadline released its
                  // own lock on withRunLock's normal path. State both
                  // dispositions instead of asserting one that can be false.
                  remediation:
                    `the loser-teardown for run ${o.runId} hit its deadline and was abandoned: if it is still mid-flight, its destructive-marked run lock stays held for this process's lifetime; if it completed after the deadline, it released the lock itself. After this process exits, judge <runsDir>/${o.runId}.lock by hand (a lock that is gone means the teardown completed) before re-running anything for it`,
                }
              : typeof inherited === "string"
                ? {
                    // E6 (R4-32): this arm is a failure PAST the destructive
                    // mark — `withRunLock` took its leave-for-operator path and
                    // left the lock on disk. The inherited remediation
                    // (teardown's own "re-run teardown …") dead-ends on that
                    // lock: every re-run refuses until it is judged, and
                    // `withRunLock` could not append the fact itself because
                    // the error already carried a remediation. Original advice
                    // first; the stranded-lock fact appended.
                    remediation: `${inherited} — note: this failure happened past the destructive mark, so the run lock was left in place on purpose; a re-run refuses on it until it is judged (live holder? half-torn-down run?) and rm'd`,
                  }
                : {};
        armLine(deps.requestId, fanoutId, {
          arm: o.arm,
          runId: o.runId,
          outcome: "lostRace",
          error: {
            code:
              e instanceof RunLockedError
                ? "loser-teardown-refused"
                : e instanceof TimeoutError
                  ? "loser-teardown-timeout"
                  : "loser-teardown-failed",
            message: errText(e),
            ...remediation,
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

// A hostile throwable can carry a `.message`/`.code`/`.remediation` GETTER
// that itself throws — reading it directly would escape the catch block this
// helper exists to keep inside. Swallow that and treat the property as absent,
// same as `redactSecrets` already does for the value itself.
function safeRead<T extends object, K extends keyof T>(obj: T, key: K): T[K] | undefined {
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}

function errText(e: unknown): string {
  // The F018 idiom, not `String(e)`: `String` throws on a null-prototype or
  // hostile-`toString` rejection — exactly the values a catch-all must survive
  // — and `redactSecrets` coerces anything without throwing. `(e ?? {})` also
  // reads `.message` off a non-Error that carries one, which `instanceof`
  // rendered as "[object Object]".
  const x = (e ?? {}) as { message?: string };
  return redactSecrets(safeRead(x, "message") ?? e);
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
