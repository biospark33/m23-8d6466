/**
 * Run-completion observation and the approval-gate bridge (Story DF3.7).
 *
 * The in-box relocation broke one tier up from the gate: nothing on the host
 * learns that an in-box run finished, so nothing walks the harvest → teardown
 * → reverify → gate chain the operator runs by hand. This module is that
 * notice — a bounded poll of the box's terminal marker through the SHIPPED
 * classifier (`readMarkerVerdict`, the one read `fleet status` and the
 * fan-out race already share), liveness disambiguation of an absent marker
 * through the shared `unitActivity` probe, and on a settled marker the chain
 * itself, composed — never re-implemented.
 *
 * The marker is a run-COMPLETION signal, never an approval state (ADR
 * Appendix A, 2026-09-08): `extensions.approval` is written only by the gate
 * this module reaches through DF5.1's `ApprovalPort`, and the marker's `ok`
 * is never fed to reverify — DF5.1 re-judges the tree independently, so the
 * two-layer evidence doctrine (INV-IBOX-15) holds by construction.
 *
 * LOCKING: this module acquires NOTHING (INV-IBOX-16). Every caller — `fleet
 * observe`, DF3.8's sweep, DF6.1a's fix run — takes `<runsDir>/<runId>.lock`
 * itself and hands the handle in as `deps.runLock`: the acquire is not
 * re-entrant (`RunLockReentrantError`), so an acquisition pushed into this
 * shared composition would refuse the sibling that already holds it. The
 * handle is passed to `teardownSandbox` unchanged, and the #245 production
 * closure wired into the approval port passes the SAME handle — never a
 * `withRunLock` wrap, which would throw on re-entry.
 */
import { clearRunLockDestructive, markRunLockDestructive, type RunLockHandle } from "../../scripts/lib/run-lock.ts";
import type { CostLedger } from "../providers/cost-ledger.ts";
import type { KeyApi } from "../providers/credentials.ts";
import type { ProviderDriver } from "../providers/driver.ts";
import type { RunRecord, RunRecordStore } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { teardownSandbox, type TeardownDeps } from "../providers/teardown.ts";
import { recordApprovalPort } from "../reverify/approval.ts";
import { reverify, type ReverifyOutcome } from "../reverify/runner.ts";
import { log } from "../swarmclaw/log.ts";
import { DEFAULT_PER_CALL_DEADLINE_MS, DEFAULT_POLL_INTERVAL_MS, PROBE_SKIP_TICKS_LIMIT, boxMarkerPath, markerUnusableGivesUp, readMarkerVerdict, type MarkerVerdict } from "./fanout-primitive.ts";
import { unitActivity } from "./run.ts";

/**
 * The observation window — this story's only new number (fan-out's 1 h ceiling
 * is race-shaped and an unattended run routinely outlives it, so inheriting it
 * would silently abandon exactly the runs this module exists for).
 * Operator-settable on the verb (`--window-ms`); this default is provisional.
 */
// ponytail: 2 h — repriced per story :113 from live round T2.8 (2026-09-15,
// sha a1314720, evidence 2026-09-15-184348-…-5wmt0b.json): the minimum t3
// workload measured dispatch 79 s + in-box run ≈ 10 s + chain 40 s, so
// dispatch→terminal ≈ 130 s and the default sits at ~55× that minimum —
// sized for real unattended runs (which run hours, not seconds), never
// inherited from fan-out's race-shaped 1 h. Raise the multiple only with
// measured evidence; the operator's --window-ms always wins.
export const DEFAULT_OBSERVATION_WINDOW_MS = 7_200_000;

/**
 * What `fleet observe` (and DF3.8's sweep, and DF6.1a's fix run) ends in — a
 * discriminated union the caller can count, map to its exit table and log
 * without re-deriving anything. There is deliberately NO `markerWitnessed`
 * field: no producer of `true` exists at the single observation point the
 * collected-record arm permits.
 */
export type ChainOutcome =
  /** The chain landed and the gate registered — exit 0. */
  | { kind: "driven"; markerOk?: boolean; chainMs: number }
  /**
   * No terminal arm this invocation. `terminal` is present EXACTLY when the
   * invocation ended on a typed terminal arm — `box-unreachable`,
   * `run-engine-dead`, `run-completion-unobserved` (the window fill and the
   * unusable-streak fill share that one code) — and ABSENT when returning to
   * the caller mid-window (maxTicks exhaustion: the caller decides).
   */
  | { kind: "unsettled"; verdict: MarkerVerdict; terminal?: { code: string; message: string; remediation: string } }
  /** Every pre-chain refusal the module itself issues — refused before mutation. */
  | { kind: "refused"; code: string; message: string; remediation: string }
  /** The re-verifier's own judgment said no (non-green, incl. `error` and `nothing-to-verify`) — exit 6. */
  | { kind: "vetoed"; reason: string }
  /** The gate leg errored — exit 6; a null approval is never a registration. */
  | { kind: "approval-failed"; error: string }
  /** A chain step other than the approval leg threw, pre- or post-close — exit 6. */
  | { kind: "chain-failed"; step: "teardown" | "reverify" | string; error: string }
  /** The gate returned a non-request outcome — already in the pause flow or decided — exit 6. */
  | { kind: "handed-off"; outcome: string };

export interface RunCompletionDeps {
  /** Enough for readBoxFile / unitActivity / teardownSandbox. */
  driver: ProviderDriver;
  store: RunRecordStore;
  runsDir: string;
  /** REQUIRED; the CALLER asserts it is a git worktree BEFORE calling — never discovered inside reverify(), after the box is gone. */
  hostRoot: string;
  /** The caller's handle — this module acquires NOTHING; holding a handle and taking a lock are different acts. */
  runLock: RunLockHandle;
  /** Caller-built via openRouterKeyApi(); fail-closed before box touch on a keyed record. */
  keyApi: KeyApi;
  /** The RECORD's dispatch stamp (the join key, never the invocation's own id). */
  requestId: string;
  /** Write-path constructor; the teardown's box-hours ingest points here. */
  costLedger: CostLedger;
  /** Unset ⇒ poll to windowMs. DF3.8's sweep passes 1 — a sweep is not a wait. */
  maxTicks?: number;
  windowMs?: number;
}

// ─── observability (the emitLine/log idiom, fanout-primitive.ts:1538-1550) ────

/** Every observer line carries the record's dispatch id — the cross-process join key. */
function observeLine(requestId: string, fields: Record<string, unknown>): void {
  try {
    log({
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: typeof fields.marker_poll_ms === "number" ? (fields.marker_poll_ms as number) : 0,
      status: fields.error === undefined ? "ok" : "error",
      requestId,
      operation: "fleet.observe",
      ...fields,
    });
  } catch {
    // A raising sink must never replace the caller's real outcome.
  }
}

const LOG_TEXT_CAP = 200;

/**
 * A verdict's `code`/`error` reach the log ONLY through `redactSecrets` and
 * capped — the classifier builds the marker codes out of the marker's OWN
 * bytes, so an unredacted cause would publish them (story :123).
 */
function logText(text: unknown): string {
  return redactSecrets(text).slice(0, LOG_TEXT_CAP);
}

function errText(e: unknown): string {
  // The F018 idiom, not `String(e)`: `String` throws on a hostile `toString`,
  // and a hostile `.message` getter must not escape either — swallow it and
  // fall back to the throwable itself, which redactSecrets coerces safely.
  const x = (e ?? {}) as { message?: unknown };
  let m: unknown = e;
  try {
    m = x.message ?? e;
  } catch {
    // hostile getter — the fallback above stands
  }
  return logText(m);
}

// ─── small readers ────────────────────────────────────────────────────────────

/** The approval extension's state, read defensively — a hand-edited record can carry any ExtensionValue. */
function approvalExtensionState(rec: RunRecord): string | undefined {
  const state = rec.extensions?.approval?.state;
  return typeof state === "string" ? state : undefined;
}

/**
 * The join key is always the RECORD's dispatch stamp, never the invocation's
 * (Observability Contract :124): `deps.requestId` is the caller's copy of the
 * same stamp, so the record's own field wins whenever it carries one.
 */
function recordRequestId(rec: RunRecord, deps: RunCompletionDeps): string {
  return typeof rec.requestId === "string" && rec.requestId !== "" ? rec.requestId : deps.requestId;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function chainTeardownDeps(deps: RunCompletionDeps, requestId: string): TeardownDeps {
  return {
    driver: deps.driver,
    store: deps.store,
    keyApi: deps.keyApi,
    requestId,
    runsDir: deps.runsDir,
    costLedger: deps.costLedger,
    gitCwd: deps.hostRoot,
  };
}

/**
 * The chain's destructive window, wrapped the way the `fleet teardown` verb
 * wraps its own (DF2.11's mark-before/clear-after dance): the lock is marked
 * destructive IMMEDIATELY before `teardownSandbox` begins and cleared only on
 * its success — never armed on the poll-only paths, where nothing has been
 * mutated. A signal (through `releaseHeldRunLocks`) or a mid-teardown throw
 * then leaves the lock and the mark for the operator instead of handing a
 * half-torn-down run to the next teardown; withRunLock preserves the
 * already-marked lock when the caller's callback resolves around this failure
 * (`chain-failed`).
 */
async function guardedTeardown(
  deps: RunCompletionDeps,
  teardownDeps: TeardownDeps,
  runId: string,
  opts?: Parameters<typeof teardownSandbox>[3],
): Promise<void> {
  markRunLockDestructive(deps.runLock);
  let tornDown = false;
  try {
    await teardownSandbox(teardownDeps, runId, deps.runLock, opts);
    tornDown = true;
  } finally {
    // Cleared only on completion; on a throw the mark stays — whether the box,
    // key and record actually landed is exactly what the operator must judge
    // before the lock is released (withRunLock preserves the marked lock on
    // both settle arms).
    if (tornDown) clearRunLockDestructive(deps.runLock);
  }
}

// ─── the chain (composition only — every step already exists) ─────────────────

/** How the terminating observation line is shaped: the event name, plus the observe path's own facts. */
interface TerminalLine {
  /** `run-complete` on the observe path, `pause-promoted` on the stranded-pause re-entry. */
  event: string;
  /** Present only on the observe path — the promote leg never read a marker, so the field is absent there, never 0. */
  markerPollMs?: number;
  /** Present only on the observe path — the promote leg's `driven` carries NO markerOk. */
  markerOk?: boolean;
}

/**
 * The terminating line carries the outcome's kind and, where the kind carries
 * one, its code — this is how an event-only consumer separates the refusal
 * codes from the per-tick vocabulary without minting second event names.
 * `chain_ms` rides it because this is only ever emitted after the chain ran.
 */
function emitTerminal(
  requestId: string,
  runId: string,
  line: TerminalLine,
  outcome: ChainOutcome,
  chainMs: number,
): void {
  const fields: Record<string, unknown> = { event: line.event, kind: outcome.kind, chain_ms: chainMs };
  if (line.markerPollMs !== undefined) fields.marker_poll_ms = line.markerPollMs;
  if (outcome.kind === "refused") fields.code = outcome.code;
  else if (outcome.kind === "unsettled" && outcome.terminal !== undefined) fields.code = outcome.terminal.code;
  else if (outcome.kind === "vetoed") fields.reason = logText(outcome.reason);
  else if (outcome.kind === "approval-failed") fields.error = logText(outcome.error);
  else if (outcome.kind === "chain-failed") {
    fields.step = outcome.step;
    fields.error = logText(outcome.error);
  } else if (outcome.kind === "handed-off") fields.outcome = logText(outcome.outcome);
  observeLine(requestId, { runId, ...fields });
}

/**
 * reverify() plus the outcome mapping shared by both entries. Any throw past
 * reverify's typed outcome (its report leg sits outside its own try blocks)
 * lands as `chain-failed {step:"reverify"}`; the port's teardown seam throwing
 * through the gate lands there too, post-close.
 */
async function reverifyAndMap(
  runId: string,
  deps: RunCompletionDeps,
  requestId: string,
  teardownDeps: TeardownDeps,
  chainStartMs: number,
  line: TerminalLine,
): Promise<ChainOutcome> {
  // #245 production closure: carries the chain-held RunLockHandle straight
  // into teardownSandbox — NEVER a `withRunLock` wrap, which would throw
  // RunLockReentrantError on re-entry (the gate calls the seam verbatim; the
  // lock it runs under is this chain's own).
  const port = recordApprovalPort(deps.store, {
    bundleDir: deps.runsDir,
    teardown: (id, opts) => guardedTeardown(deps, teardownDeps, id, opts),
  });
  let result: ReverifyOutcome;
  try {
    result = await reverify(runId, {
      store: deps.store,
      runsDir: deps.runsDir,
      hostRoot: deps.hostRoot,
      approval: port,
    });
  } catch (e) {
    const outcome: ChainOutcome = { kind: "chain-failed", step: "reverify", error: errText(e) };
    emitTerminal(requestId, runId, line, outcome, Date.now() - chainStartMs);
    return outcome;
  }
  const chainMs = Date.now() - chainStartMs;
  let outcome: ChainOutcome;
  if (result.report.verdict !== "green") {
    // The re-verifier's independent judgment — including the `error` verdict a
    // host failure produces and the `nothing-to-verify` preflight.
    outcome = { kind: "vetoed", reason: result.report.reason || result.report.verdict };
  } else if (result.approval === null) {
    // A null is never a gate registration (AC5): the runner's catch flattens
    // every gate refusal and transport failure to the one generic flag.
    outcome = {
      kind: "approval-failed",
      error: result.report.flags.includes("approval-request-failed")
        ? "approval-request-failed"
        : "approval null without flag",
    };
  } else if (result.approval.outcome === "requested") {
    outcome =
      line.markerOk === undefined
        ? { kind: "driven", chainMs }
        : { kind: "driven", markerOk: line.markerOk, chainMs };
  } else {
    // pause-in-progress | already-decided | rebound — nothing re-runs, nothing re-mints.
    outcome = { kind: "handed-off", outcome: result.approval.outcome };
  }
  emitTerminal(requestId, runId, line, outcome, chainMs);
  return outcome;
}

/** AC3's typed terminal arm — the window fill and the unusable-streak fill share this one code, distinct from `box-unreachable`. */
function unobservedTerminal(
  requestId: string,
  runId: string,
  vmName: string,
  verdict: MarkerVerdict,
  markerPollMs: number,
  cause: string,
): ChainOutcome {
  const outcome: ChainOutcome = {
    kind: "unsettled",
    verdict,
    terminal: {
      code: "run-completion-unobserved",
      message: `${cause}; box ${vmName} stays alive with its evidence`,
      remediation: `re-run fleet observe ${runId} — the box is left alive and the marker stays in place, so re-observation is idempotent`,
    },
  };
  observeLine(requestId, {
    runId,
    event: "run-completion-unobserved",
    marker_poll_ms: markerPollMs,
    kind: "unsettled",
    code: "run-completion-unobserved",
  });
  return outcome;
}

// ─── the exported entries ─────────────────────────────────────────────────────

/**
 * Observe one box's terminal marker and, on seeing it, walk the chain the
 * operator runs by hand: `teardownSandbox` (harvest is its own first internal
 * step) → `reverify()` → the gate's own `requestApproval` — composed, with
 * `ok:false` still driving the chain (ok is a signal, never a veto).
 *
 * PRECONDITION: the caller already holds `<runsDir>/<runId>.lock` and passes
 * the handle as `deps.runLock` — this module acquires nothing (see header).
 */
export async function observeAndDriveChain(runId: string, deps: RunCompletionDeps): Promise<ChainOutcome> {
  // Pre-flight read — a throw propagates; the verb maps ENOENT → exit 4.
  const rec = deps.store.get(runId);
  const requestId = recordRequestId(rec, deps);

  // Pre-flight ORDER (binding): approval extension → pausing route → closedAt → no box.
  const approvalState = approvalExtensionState(rec);
  if (
    approvalState === "awaiting-approval" ||
    approvalState === "approved" ||
    approvalState === "rejected" ||
    approvalState === "timed-out"
  ) {
    return {
      kind: "refused",
      code: "approval-already-registered",
      message: `run ${runId} already carries approval state "${approvalState}" — the gate owns this run`,
      remediation: "decide it with fleet approve/reject, or dispatch a new run; this refusal fires before any box is touched",
    };
  }
  if (approvalState === "pausing") {
    // NOT a refusal, and never a poll: a pausing record is post-teardown on
    // every driven path, so its box and its tmpfs marker are already gone —
    // polling can only produce skip ticks against a destroyed box.
    return promoteStrandedPause(runId, deps);
  }
  if (typeof rec.closedAt === "string") {
    return {
      kind: "refused",
      code: "run-already-closed",
      message: `run ${runId} is already closed (closedAt ${rec.closedAt}) — the chain already ran`,
      remediation: "dispatch a new run; a second teardown of a closed record is refused before any box is touched",
    };
  }
  const vmName = rec.vmName;
  if (vmName === undefined) {
    // D1: cheap pre-flight refusal — a record that names no box has nothing to
    // observe, and the refusal lands before any box is touched.
    return {
      kind: "refused",
      code: "record-names-no-box",
      message: `run ${runId}'s record names no vmName — there is no box to observe`,
      remediation: "dispatch a new run; an approval cannot be driven for a record that owns no box",
    };
  }

  const windowMs = deps.windowMs ?? DEFAULT_OBSERVATION_WINDOW_MS;
  const deadline = Date.now() + windowMs;
  const markerPath = boxMarkerPath(runId);
  let skipStreak = 0;
  let unusableStreak = 0;
  // The invocation's start counts as the last reach: six sub-second transport
  // blips are a wifi flicker, not a dead box (the wall-clock conjunct below).
  let lastReachMs = Date.now();
  let lastEvidence = "no tick yet";
  let ticks = 0;

  for (;;) {
    ticks += 1;
    const pollStarted = Date.now();
    // expectedRunId on EVERY read — a marker naming another run is unusable,
    // never this run's settlement (the wrong-box defect the classifier records).
    const verdict = await readMarkerVerdict(deps.driver, vmName, markerPath, DEFAULT_PER_CALL_DEADLINE_MS, runId);
    const markerPollMs = Date.now() - pollStarted;

    if (verdict.kind === "settled") {
      const teardownDeps = chainTeardownDeps(deps, requestId);
      const chainStartMs = Date.now();
      try {
        // Harvest is teardown's own first internal step — never a separate
        // orchestration stage here. An abort leaves the record open and the
        // box alive, and lands below as chain-failed {step:"teardown"} — with
        // the destructive mark left in place for the operator (guardedTeardown).
        await guardedTeardown(deps, teardownDeps, runId);
      } catch (e) {
        const outcome: ChainOutcome = { kind: "chain-failed", step: "teardown", error: errText(e) };
        emitTerminal(requestId, runId, { event: "run-complete", markerPollMs }, outcome, Date.now() - chainStartMs);
        return outcome;
      }
      return reverifyAndMap(runId, deps, requestId, teardownDeps, chainStartMs, {
        event: "run-complete",
        markerPollMs,
        markerOk: verdict.ok,
      });
    }

    if (verdict.kind === "absent") {
      observeLine(requestId, { runId, event: "marker-absent", marker_poll_ms: markerPollMs });
      // A clean absence resets the corruption streak — only then, liveness.
      unusableStreak = 0;
      const activity = await unitActivity(deps.driver, vmName, runId, DEFAULT_PER_CALL_DEADLINE_MS);
      if (activity === "active") {
        skipStreak = 0;
        lastReachMs = Date.now();
      } else if (activity === "failed") {
        // The ONE terminal liveness reading: the unit is Type=simple with
        // Restart=no, so it sits failed and no marker is ever written. The
        // box is left alive and listable — nothing is destroyed on a liveness
        // reading (DF2.2 INV-5).
        const outcome: ChainOutcome = {
          kind: "unsettled",
          verdict,
          terminal: {
            code: "run-engine-dead",
            message: `unit qds-run@${runId}.service on box ${vmName} is failed (Restart=no) — the engine died without writing a marker`,
            remediation: `inspect systemctl status qds-run@${runId}.service on ${vmName}; the box is left alive and listable`,
          },
        };
        observeLine(requestId, {
          runId,
          event: "run-engine-dead",
          marker_poll_ms: markerPollMs,
          kind: "unsettled",
          code: "run-engine-dead",
        });
        return outcome;
      } else {
        // inactive/unknown are NOT terminal: a dispatched-but-not-yet-started
        // box reads exactly these, and treating either as failed would issue
        // a death certificate for every run in the dispatch→run window.
        // Counted on the skip streak (AC2d); an ANSWERED reading (inactive)
        // updates lastReachMs — unknown is ambiguous and does not (D2).
        skipStreak += 1;
        lastEvidence = `unit ${activity}`;
        if (activity === "inactive") lastReachMs = Date.now();
      }
    } else if (verdict.kind === "skip") {
      // No evidence either way — resets nothing, touches lastReachMs not.
      lastEvidence = `probe ${verdict.code}`;
      skipStreak += 1;
      observeLine(requestId, {
        runId,
        event: "marker-skip",
        marker_poll_ms: markerPollMs,
        code: logText(verdict.code),
        error: errText(verdict.error),
      });
    } else {
      // Present but unjudgeable — the box answered, so this is counted on the
      // corruption streak (temp+rename makes persistence corruption), never a
      // free tick and never a skip. The read also settles the TRANSPORT arm:
      // the streaks are consecutive, and the race treats the same verdict as
      // `anyArmAnswered` (fanout-primitive.ts), so a tick the box demonstrably
      // answered resets the skip streak and moves lastReachMs — or skips left
      // over from an earlier blip would combine with later ones into a
      // box-unreachable that asserts the box "answered nothing" on ticks it
      // answered.
      skipStreak = 0;
      lastReachMs = Date.now();
      unusableStreak += 1;
      observeLine(requestId, {
        runId,
        event: "marker-unusable",
        marker_poll_ms: markerPollMs,
        code: logText(verdict.code),
        error: errText(verdict.error),
      });
      if (markerUnusableGivesUp(unusableStreak)) {
        return unobservedTerminal(
          requestId,
          runId,
          vmName,
          verdict,
          markerPollMs,
          `the marker on ${vmName} was unusable on ${unusableStreak} consecutive reads — present but unjudgeable, so corruption rather than latency`,
        );
      }
    }

    // Skip-streak fill — BOTH conjuncts: six ticks AND the wall clock a full
    // six-tick span buys (90 s on the shipped defaults) since anything last
    // reached the box. Distinct from run-completion-unobserved: this code says
    // the box never answered, not that the host never looked.
    if (
      skipStreak >= PROBE_SKIP_TICKS_LIMIT &&
      Date.now() - lastReachMs >= PROBE_SKIP_TICKS_LIMIT * (DEFAULT_POLL_INTERVAL_MS + DEFAULT_PER_CALL_DEADLINE_MS)
    ) {
      const outcome: ChainOutcome = {
        kind: "unsettled",
        verdict,
        terminal: {
          code: "box-unreachable",
          message: `box ${vmName} for run ${runId} answered nothing on ${skipStreak} consecutive ticks (last evidence: ${lastEvidence})`,
          remediation: `transient — re-run fleet observe ${runId} later; the box is left alive and listable, and no record field was mutated`,
        },
      };
      observeLine(requestId, {
        runId,
        event: "box-unreachable",
        marker_poll_ms: markerPollMs,
        kind: "unsettled",
        code: "box-unreachable",
      });
      return outcome;
    }

    // maxTicks exhaustion: unsettled WITHOUT terminal — the caller decides
    // (DF3.8's sweep passes 1; a sweep is not a wait).
    if (deps.maxTicks !== undefined && ticks >= deps.maxTicks) {
      return { kind: "unsettled", verdict };
    }
    if (Date.now() >= deadline) {
      return unobservedTerminal(
        requestId,
        runId,
        vmName,
        verdict,
        markerPollMs,
        `the ${windowMs}ms observation window expired with run ${runId}'s marker still unsettled`,
      );
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
}

/**
 * The stranded-pause re-entry (AC5): a `pausing` record is post-teardown on
 * every path this story or DF3.8 drives — its box and its tmpfs marker are
 * already gone — so the only live step is reverify's own resume arm, which
 * re-presents the bound reportId and promotes. The hand-run live-box `pausing`
 * case is covered by the gate's teardown-at-pause through the SAME wired port
 * (INV-APPROVE-6 enforced at the gate). `driven` here carries NO `markerOk`:
 * no caller of this entry has ever read a marker.
 *
 * PRECONDITION: the caller already holds `<runsDir>/<runId>.lock` and passes
 * the handle as `deps.runLock` — this module acquires nothing (see header).
 */
export async function promoteStrandedPause(runId: string, deps: RunCompletionDeps): Promise<ChainOutcome> {
  // Re-read: the record may have moved since the caller's pre-flight.
  const rec = deps.store.get(runId);
  const requestId = recordRequestId(rec, deps);
  const state = approvalExtensionState(rec);
  if (state !== "pausing") {
    return {
      kind: "refused",
      code: "record-not-pausing",
      message: `run ${runId} carries approval state ${state === undefined ? "(none)" : `"${state}"`}, not "pausing" — there is no stranded pause to promote`,
      remediation: `a run that never entered the pause is observed with fleet observe ${runId}; this refusal touched nothing`,
    };
  }
  const teardownDeps = chainTeardownDeps(deps, requestId);
  return reverifyAndMap(runId, deps, requestId, teardownDeps, Date.now(), { event: "pause-promoted" });
}
