/**
 * The host-side completion sweep (Story DF3.8): `fleet observe --all`.
 *
 * A bounded, re-entrant, EXITING pass over every open record whose box is
 * live and listable, driving DF3.7's `observeAndDriveChain` for each one —
 * a second CALLER of the one entry point, never a second chain. It adds no
 * observer, no process and no state: nothing is persisted (INV-IBOX-18), so
 * every sweep is a fresh read and the operator's own cron is the only
 * schedule (INV-IBOX-16's no-watcher-process limb stays literally true).
 *
 * LOCKING: this module takes the per-run invocation lock ITSELF, per
 * candidate, through the same `acquireRunLock`/`releaseRunLock` pair the
 * run-scoped CLI verbs use — never `withRunLock` around the whole pass, and
 * never inside `run-completion.ts` (the acquire is not re-entrant, so an
 * acquisition pushed into the shared composition would refuse the sibling
 * caller that already holds it). The pass is serial (AC2a), which is what
 * makes the process-global `held` map's serial acquire/release safe.
 *
 * IMPORT FENCE (AC1, DF3.7's extended verbatim): no direct import of
 * approval-gate.ts, approvers.ts, push.ts, the src/fleet barrel, or any
 * run-record writer symbol — this module cannot acquire the ability to write
 * `extensions.approval` even if a later edit wanted it (INV-IBOX-17).
 *
 * Dev Agent Record (self-review round 1 — 8 findings, steers story-cited):
 * - F1/F2: readBoxFile rejections and chain-context construction failures are
 *   PER-CANDIDATE outcomes (uptime_unknown / runs_chain_failed), never pass
 *   aborts — one dead-ssh box at the oldest-first head must not starve the
 *   tail the partial-pass design exists to protect.
 * - F3: candidates are vmName-carrying records only — the chain's
 *   record-names-no-box pre-flight would refuse a vmName-less candidate every
 *   tick forever; the leaked live box is DF2.6's reaper arm's to collect.
 * - F4: the chain-refused fold names its reachable codes; F5: a non-content
 *   uptime read still records a null evidence entry (the margin must be
 *   re-derivable from data, unknown boxes included); F6: an unusable verdict
 *   at maxTicks 1 misfiles into runs_unsettled, bounded by the tick; F7: the
 *   sweep's own per-run disposition events carry the sweep- prefix.
 */
import { readBoxFile } from "../providers/exedev/transport.ts";
import { driverListing, type ProviderAuditLink, type ProviderDriver } from "../providers/driver.ts";
import type { KeyApi } from "../providers/credentials.ts";
import type { CostLedger } from "../providers/cost-ledger.ts";
import type { RunRecord, RunRecordStore } from "../providers/run-record.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { log } from "../swarmclaw/log.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, type RunLockHandle } from "../../scripts/lib/run-lock.ts";
import { DEFAULT_PER_CALL_DEADLINE_MS, boxMarkerPath } from "./fanout-primitive.ts";
import { observeAndDriveChain, type ChainOutcome } from "./run-completion.ts";

/**
 * The provisioning-lag margin for the reboot comparison (AC4a): a reboot is
 * `uptimeMs < (hostNow − createdAt) − PROVISION_LAG_MARGIN_MS`.
 *
 * Derivation: `store.create` stamps `createdAt` BEFORE `driver.create()` boots
 * the VM (both inside provisionAdmittedRun's `within("create", …)` span,
 * src/fleet/dispatch.ts), so a first boot always postdates `createdAt` and a
 * naive "boot later than createdAt" comparison counts EVERY box as rebooted.
 * The margin absorbs the real create→boot lag. Interval heuristic context:
 * DF2.6's reaper classifies an open record stale at `staleAfterMs`
 * (4 h default, src/providers/quota.ts:49) — this margin is ~1/48 of that
 * ceiling, so the sweep never mistakes a merely-provisioning box for a
 * rebooted one on any interval derived from it.
 *
 * RE-DERIVED (story Technical Notes' open measurement, closed 2026-09-18):
 * the first live e2e round that could measure this (DF3.8 round 2, evidence
 * 2026-09-18-233121-…-v1nygd.json) recorded the create→boot span directly —
 * dispatch `timings.create_ms` = 50 172 ms, the exact lag this margin
 * absorbs (createdAt is stamped inside that span, src/fleet/dispatch.ts).
 * 6× that measurement is ≈301 s; the value keeps the round 300 000 (within
 * 0.4% of the derived figure), so the CONSTANT IS UNCHANGED and only its
 * basis swaps — provisional 4×-dispatch-leg estimate → measured span × 6.
 * Caveat, filed as #266: that round could not capture per-box raw
 * `uptime_evidence` (`provisionLagMs = (hostNow − createdAt) − uptimeMs`,
 * milliseconds on both sides) — the sweep is stateless (INV-IBOX-18) and
 * scripts/fleet.ts strips the summary's uptime_evidence before any line is
 * emitted — so the derivation stands on the recorded dispatch timing span:
 * the same lag, measured one level up. When #266 lands and a later round
 * captures the raw per-box values, reprice against THAT sample.
 */
export const PROVISION_LAG_MARGIN_MS = 300_000;

/**
 * Max candidates one pass will drive (Technical Notes "Guards/limits"): a
 * COUNT bound, not a duration. Each candidate costs up to two
 * `DEFAULT_PER_CALL_DEADLINE_MS` reads (20 s) and, if settled, a full chain
 * including `reverify()`'s test suite — all serially (AC2a). 25 × the T2.8
 * minimum chain (~40 s) ≈ 17 min, inside the wall-clock budget below, so the
 * pair of bounds meets rather than fights.
 */
export const MAX_CANDIDATES_PER_PASS = 25;

/**
 * The pass's wall-clock budget, checked BETWEEN candidates (never mid-chain):
 * staleAfterMs (240 min) / 12 — one twelfth of the reaper's ceiling per pass.
 * Exceeding it, like exceeding the count bound, is a counted, logged partial
 * pass that still exits 0.
 */
export const SWEEP_WALL_CLOCK_BUDGET_MS = 1_200_000;

/**
 * The documented cron interval (AC6): staleAfterMs (240 min) / 8 = 30 min,
 * past the wall-clock budget above so the observed worst-case pass fits
 * inside one tick. A HEURISTIC, not a correctness argument: the reaper is an
 * operator CLI, dry-run by default — there is no wall-clock deadline to beat,
 * and a run collected first is AC3's typed refusal, not lost data. An
 * operator who lowers `staleAfterMs` sees here what else moves.
 */
export const SWEEP_INTERVAL_MINUTES = 30;

/** The raw reboot-measurement evidence per box (AC4a) — milliseconds on both derived sides, seconds recorded raw. */
export interface SweepUptimeEvidence {
  runId: string;
  hostNow: number;
  createdAt: string;
  uptimeSeconds: number | null;
  provisionLagMs: number | null;
}

/** Every disposition counter, the two measurements, and the raw uptime evidence (the Observability Contract's field set). */
export interface SweepSummary {
  candidates_enumerated: number;
  runs_observed: number;
  runs_unsettled: number;
  runs_engine_dead: number;
  runs_box_unreachable: number;
  runs_lost_to_reboot: number;
  lock_refused: number;
  completion_unwitnessed: number;
  runs_vetoed: number;
  runs_approval_failed: number;
  /**
   * A per-candidate chain-PHASE failure: the chain threw past its typed
   * outcome, a chain step aborted (teardown/reverify), or the chain CONTEXT
   * could not be built (no key env on a keyed record, ledger construction) —
   * the pass continues; never a benign skip.
   */
  runs_chain_failed: number;
  runs_handed_off: number;
  /** The ONLY producer is the partial-pass truncation arm — the candidates the pass did not reach. */
  candidates_skipped: number;
  /** Measurements, not dispositions: they cut ACROSS the disposition set (runs_lost_to_reboot ⊆ box_reboot_after_dispatch). */
  box_reboot_after_dispatch: number;
  uptime_unknown: number;
  uptime_evidence: SweepUptimeEvidence[];
  sweep_ms: number;
}

/** A completed pass, or a typed start-up refusal (which touched zero boxes and zero records). */
export type SweepOutcome =
  | { kind: "sweep"; summary: SweepSummary }
  | { kind: "refused"; code: string; message: string; remediation: string };

/**
 * The per-run chain context the CALLER builds inside the lock (mirroring
 * `runObserve`'s in-lock wiring): the key client fail-closed on a keyed
 * record, the write-path ledger, the audit-link seam, and the close that
 * owns the two handles' lifetimes. A seam because those constructors live in
 * the CLI layer (`openRouterKeyApi`, `costLedgerOpts`, `openAuditStore`) —
 * this module must not import them.
 */
export interface SweepChainCtx {
  keyApi: KeyApi;
  costLedger: CostLedger;
  recordAuditLink: (link: ProviderAuditLink) => void;
  /** Best-effort close of the ledger/audit handles; typed notes are the caller's. */
  close: () => void;
}

export interface ObserveSweepDeps {
  driver: ProviderDriver;
  /** Read-mode is fine: enumeration and the in-lock re-reads never write — the chain writes through `writableStore()`. */
  store: RunRecordStore;
  runsDir: string;
  /** REQUIRED; resolved and worktree-asserted by the sweep ONCE, before any candidate — never discovered inside reverify(). */
  hostRoot: string;
  /** The sweep invocation's own id — stamped on every per-run line (the chain's lines carry the record's own dispatch stamp). */
  requestId: string;
  buildChainCtx: (rec: RunRecord) => SweepChainCtx;
  /**
   * Round-11 twin (runObserve's create:false posture): the writable store the
   * chain writes `closedAt` and the approval extension through, opened lazily
   * at the FIRST candidate past the in-lock re-read — a named --dir is never
   * created (or chmod'ed) by a sweep that refuses or finds nothing.
   */
  writableStore?: () => RunRecordStore;
  maxCandidatesPerPass?: number;
  wallClockBudgetMs?: number;
}

// ─── observability (the observeLine idiom, run-completion.ts:115-129) ────────

/** Every sweep line carries the invocation's own id and operation, on DF3.7's channel. */
function sweepLine(requestId: string, fields: Record<string, unknown>): void {
  try {
    log({
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: typeof fields.sweep_ms === "number" ? (fields.sweep_ms as number) : 0,
      status: fields.error === undefined && fields.stale !== true ? "ok" : "error",
      requestId,
      operation: "fleet.observe",
      ...fields,
    });
  } catch {
    // A raising sink must never replace the sweep's outcome.
  }
}

const LOG_TEXT_CAP = 200;

/** Marker/driver-derived text reaches the log only redacted and capped (the probeArm/boxText idiom). */
function logText(text: unknown): string {
  return redactSecrets(text).slice(0, LOG_TEXT_CAP);
}

function errText(e: unknown): string {
  const x = (e ?? {}) as { message?: unknown };
  let m: unknown = e;
  try {
    m = x.message ?? e;
  } catch {
    // hostile getter — the fallback stands
  }
  return logText(m);
}

/** The empty counters object every pass starts from — the Observability Contract's field set, verbatim. */
function emptySummary(): SweepSummary {
  return {
    candidates_enumerated: 0,
    runs_observed: 0,
    runs_unsettled: 0,
    runs_engine_dead: 0,
    runs_box_unreachable: 0,
    runs_lost_to_reboot: 0,
    lock_refused: 0,
    completion_unwitnessed: 0,
    runs_vetoed: 0,
    runs_approval_failed: 0,
    runs_chain_failed: 0,
    runs_handed_off: 0,
    candidates_skipped: 0,
    box_reboot_after_dispatch: 0,
    uptime_unknown: 0,
    uptime_evidence: [],
    sweep_ms: 0,
  };
}

// ─── small readers ────────────────────────────────────────────────────────────

/**
 * The box this record owns, from the pass's ONE listing — the joinedBox match
 * (src/fleet/status.ts): both `vmName` and `runId`, because `createRun` names
 * the box after the run id and persists `vmName` only after `driver.create()`
 * returns, so an open record with no `vmName` can still own a live box.
 */
function joinedBox(rec: RunRecord, boxes: Map<string, { name: string }>): { name: string } | undefined {
  const names = rec.vmName === undefined ? [rec.runId] : [rec.vmName, rec.runId];
  return names.map((n) => boxes.get(n)).find((b) => b !== undefined);
}

/** `/proc/uptime`'s first field, or null when the content is unparseable — never a guessed zero. */
function parseUptimeSeconds(content: string): number | null {
  const first = content.trim().split(/\s+/)[0];
  if (first === undefined || first === "") return null;
  const s = Number(first);
  return Number.isFinite(s) && s >= 0 ? s : null;
}

// ─── the sweep ────────────────────────────────────────────────────────────────

/**
 * One bounded pass over every open record with a live, listable box — the
 * `fleet observe --all` entry the CLI calls. A COMPLETED pass returns
 * `{kind:"sweep"}` whatever its candidates did (every per-run refusal is a
 * counted, logged skip); only a start-up failure to complete the pass itself
 * returns `{kind:"refused"}`. Persists nothing: no record, no cursor, no
 * second marker (INV-IBOX-18).
 */
export async function observeSweep(deps: ObserveSweepDeps): Promise<SweepOutcome> { // dp:ok the pass-level awaits (driverListing, listWithAnomalies) propagate by design: a failure to complete the pass is the CLI's non-zero via reportCode, never a per-candidate concern
  const passStart = Date.now();
  const summary = emptySummary();
  const el = (): number => Date.now() - passStart;

  // hostRoot FIRST, once, before any box is touched: reverify() re-judges the
  // tree host-side, and a verb that discovers an unusable root INSIDE it has
  // already harvested and destroyed the box (AC6's negative control). Same
  // assert as the single-run form: stdout "true" AND exit 0 — inside .git/
  // prints "false" WITH exit 0.
  const worktree = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: deps.hostRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (worktree.exitCode !== 0 || worktree.stdout.toString().trim() !== "true") {
    return {
      kind: "refused",
      code: "reverify-host-root-unusable",
      message: `${deps.hostRoot} is not a git worktree — the re-verification this sweep drives needs a repo root`,
      remediation: "run the sweep from the repo the runs were dispatched against — nothing was mutated",
    };
  }

  // ONE driver listing for the whole pass, through `driverListing` (never a
  // bare `list()`): a listing with skipped entries is NOT a verified listing,
  // and a sweep that cannot prove the box population complete does not guess.
  const listing = await driverListing(deps.driver);
  if (listing.skipped.length > 0) {
    return {
      kind: "refused",
      code: "sweep-listing-unverified",
      message: `refusing to sweep: driver ${deps.driver.name} could not account for ${listing.skipped.length} listing entr${listing.skipped.length === 1 ? "y" : "ies"} (${logText(listing.skipped.join("; "))}), so the box population cannot be proven complete`,
      remediation: "resolve the listing entries above by hand (fleet status names them), then re-run — a candidate set built on an unverified listing is a guess, not an enumeration",
    };
  }
  const boxes = new Map(listing.vms.map((v) => [v.name, v] as const));

  // Enumeration (one pass over the records). Anomalies are named on a log
  // line — a skipped file may hold a live box and is never silently dropped.
  const recordListing = deps.store.listWithAnomalies();
  for (let i = 0; i < recordListing.skipped.length; i++) {
    sweepLine(deps.requestId, {
      event: "sweep-record-anomaly",
      file: logText(recordListing.skipped[i]),
      reason: logText(recordListing.skippedReasons[i] ?? ""), // dp:ok skippedReasons is same-length-as-skipped by contract; the fallback only shapes an optional reason field on a diagnostics line no consumer branches on
      sweep_ms: el(),
    });
  }
  const candidates = recordListing.records
    // AC2a/AC5: open record, no approval extension (a candidate by definition
    // carries none — the gate's, never this sweep's), box live and listable.
    // vmName-carrying ONLY: the chain's pre-flight hard-refuses
    // record-names-no-box, so a vmName-less record joined by a runId-named
    // live box (a dispatch crash between driver.create() and the vmName
    // persist) would refuse every tick forever, undrivable by construction —
    // that leaked box is DF2.6's reaper arm's to collect, not this sweep's.
    .filter(
      (r) =>
        r.vmName !== undefined && r.closedAt === undefined && r.extensions?.approval === undefined && joinedBox(r, boxes) !== undefined,
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)); // oldest-first: a refusing head cannot starve the tail
  summary.candidates_enumerated = candidates.length;

  const maxCandidates = deps.maxCandidatesPerPass ?? MAX_CANDIDATES_PER_PASS;
  const budgetMs = deps.wallClockBudgetMs ?? SWEEP_WALL_CLOCK_BUDGET_MS;
  /** AC4d's in-pass retire: engine-dead candidates are excluded from subsequent enumeration WITHIN the pass — nothing is persisted, so a later tick re-enumerates and re-refuses, counted each time. */
  const retiredInPass = new Set<string>();
  const rebootRuns = new Set<string>();
  const unknownRuns = new Set<string>();
  let chainStore: RunRecordStore = deps.store;
  let writableOpened = false;
  let processed = 0;

  /**
   * Drive ONE candidate under its own acquire/release of the per-run lock.
   * Sets exactly one disposition counter — the identity
   * `dispositions + candidates_skipped === candidates_enumerated` holds by
   * construction and is pinned in tests.
   */
  const driveOne = async (rec: RunRecord): Promise<void> => {
    const runId = rec.runId;
    const vm = rec.vmName!; // the candidate filter guarantees vmName (see record-names-no-box note above)

    // AC2c/AC2d: the sweep takes the lock itself, one candidate at a time. A
    // busy or stale lock is a counted skip inside a pass that still completes
    // (the exit code belongs to the invocation, which did not fail); a STALE
    // one is its own remediated outcome on its own line, never a benign skip.
    let handle: RunLockHandle;
    try {
      handle = acquireRunLock(deps.runsDir, runId, "fleet observe --all");
    } catch (e) {
      if (e instanceof RunLockedError) {
        summary.lock_refused += 1;
        sweepLine(deps.requestId, {
          runId,
          event: "lock-refused",
          stale: e.stale,
          error: logText(e.message),
          remediation: logText(e.remediation),
          sweep_ms: el(),
        });
        return;
      }
      throw e; // re-entrant or a raw errno: a pass-level defect, not a per-run outcome
    }

    let chainCtx: SweepChainCtx | undefined;
    try {
      // In-lock re-read — UNCONDITIONAL (AC3): a record open at enumeration
      // and closedAt here was collected between the two (the reaper, a
      // concurrent fleet teardown — both hold this same lock since DF2.11).
      // No witnessed-re-entry branch exists: the re-read precedes the chain's
      // only marker read, so no invocation can have witnessed a marker for a
      // record collected before the lock.
      let nowRec: RunRecord;
      try {
        nowRec = deps.store.get(runId);
      } catch (e) {
        summary.completion_unwitnessed += 1;
        sweepLine(deps.requestId, {
          runId,
          event: "completion-unwitnessed",
          code: "completion-unwitnessed",
          message: logText(`record unreadable or gone between enumeration and lock acquisition (${errText(e)}) — the collection window, not a witness`),
          remediation: "the run was collected by whichever invocation removed it; nothing was mutated by this sweep",
          sweep_ms: el(),
        });
        return;
      }
      if (typeof nowRec.closedAt === "string") {
        summary.completion_unwitnessed += 1;
        sweepLine(deps.requestId, {
          runId,
          event: "completion-unwitnessed",
          code: "completion-unwitnessed",
          message: logText(`record collected between enumeration and lock acquisition (closedAt ${nowRec.closedAt}) — the collection window, not a witness`),
          remediation: "the run was harvested by whichever invocation closed it; nothing was mutated by this sweep",
          sweep_ms: el(),
        });
        return;
      }

      // Reboot measurement (AC4): hostNow is sampled per candidate,
      // immediately before its uptime read (a serial pass spans minutes; a
      // per-pass sample drifts against every candidate but the first), and it
      // is MEASUREMENT ONLY — unreadable or unparseable is `uptime_unknown`,
      // never "no reboot".
      const hostNow = Date.now();
      const createdAtMs = Date.parse(nowRec.createdAt);
      const ageMs = hostNow - createdAtMs;
      let uptimeSeconds: number | null = null;
      // F1: readBoxFile DOCUMENTS a rejection path (withTimeout's TimeoutError,
      // a driver exec throw — the reason readMarkerVerdict wraps its reads), so
      // a rejected read is a failed measurement (uptime_unknown + a null
      // evidence entry), never a pass abort — the chain's own read then
      // classifies the box.
      const upRead = await readBoxFile(deps.driver, vm, "/proc/uptime", DEFAULT_PER_CALL_DEADLINE_MS).catch(() => null);
      if (upRead !== null && upRead.kind === "content") {
        uptimeSeconds = parseUptimeSeconds(upRead.content);
        const uptimeMs = uptimeSeconds === null ? null : Math.round(uptimeSeconds * 1000);
        summary.uptime_evidence.push({
          runId,
          hostNow,
          createdAt: nowRec.createdAt,
          uptimeSeconds,
          provisionLagMs: uptimeMs === null ? null : ageMs - uptimeMs,
        });
        // AC4a: the comparison is written ONCE, in milliseconds on both sides.
        // Inside (or above) the margin is uptime_unknown — a first boot is
        // indistinguishable from an instant reboot, and the sweep never
        // scores "no reboot".
        if (uptimeMs !== null && Number.isFinite(ageMs) && uptimeMs < ageMs - PROVISION_LAG_MARGIN_MS) {
          rebootRuns.add(runId); // the counter claims a reboot, never a confirmed marker loss (AC4b)
          // AC4b: for the candidate in hand the reboot also DECIDES. /run is
          // tmpfs so any marker is gone, and the unit has Restart=no and NO
          // [Install] section, so no engine will restart and no marker will
          // ever appear. One marker-presence read decides: absent → lost.
          // F1: a rejected marker read reads as NOT absent — the chain's own
          // classified read (a rejection there is a skip verdict →
          // sweep-box-unreachable) decides; never a pass abort.
          const marker = await readBoxFile(deps.driver, vm, boxMarkerPath(runId), DEFAULT_PER_CALL_DEADLINE_MS).catch(() => null);
          if (marker !== null && marker.kind === "absent") {
            summary.runs_lost_to_reboot += 1;
            sweepLine(deps.requestId, {
              runId,
              event: "run-lost-to-reboot",
              code: "run-lost-to-reboot",
              box: vm,
              message: logText(
                `box ${vm} rebooted after dispatch (uptime ${uptimeSeconds}s < run age − margin) and the tmpfs marker at ${boxMarkerPath(runId)} is gone — no marker can ever appear (Restart=no, no [Install] section)`,
              ),
              remediation: logText(
                `inspect the box's $HOME evidence, then fleet teardown ${runId} — the box is left alive and listable; this refusal is the operator's cue, not a licence to destroy`,
              ),
              sweep_ms: el(),
            });
            // The candidate STAYS: liveness cannot distinguish started-then-
            // rebooted from never-started-then-rebooted (both read inactive/
            // unknown for the same no-[Install] reason), and retiring on that
            // reading would permanently refuse a run `fleet run` would start.
            return;
          }
          // Marker present in any shape → the chain's own classified read decides.
        } else {
          unknownRuns.add(runId);
        }
      } else {
        // F5: absent/unreadable/oversized/rejected — a failed measurement is
        // not a zero, and the box still earns its null-valued evidence entry
        // (AC4a's "raw values per box so the margin can be re-derived"
        // includes the unknown boxes).
        unknownRuns.add(runId);
        summary.uptime_evidence.push({ runId, hostNow, createdAt: nowRec.createdAt, uptimeSeconds: null, provisionLagMs: null });
      }

      // The chain context, built INSIDE the lock (fail-closed before the
      // chain's teardown leg; the reads above are observations, the same
      // ones `fleet status` makes with no key at all).
      chainCtx = deps.buildChainCtx(nowRec);
      if (deps.writableStore !== undefined && !writableOpened) {
        chainStore = deps.writableStore();
        writableOpened = true;
      }

      let outcome: ChainOutcome | undefined;
      try {
        outcome = await observeAndDriveChain(runId, {
          driver: deps.driver,
          store: chainStore,
          runsDir: deps.runsDir,
          hostRoot: deps.hostRoot,
          runLock: handle,
          keyApi: chainCtx.keyApi,
          // The RECORD's dispatch stamp is the join key; the empty-string
          // fallback — never the sweep's own id — when the record carries
          // none, so the sweep mints no correlation the run never had (the
          // fleet.ts single-run comment and the Observability Contract's
          // empty-string rule).
          requestId: nowRec.requestId ?? "", // dp:ok "" is the honest value: an unstamped record carries no dispatch correlation and the sweep must not invent one (fleet.ts:1837-1843)
          costLedger: chainCtx.costLedger,
          recordAuditLink: chainCtx.recordAuditLink,
          maxTicks: 1, // a sweep is not a wait — one read, then the next candidate
        });
      } catch (e) {
        // Never let one run kill the pass.
        summary.runs_chain_failed += 1;
        sweepLine(deps.requestId, { runId, event: "sweep-chain-failed", error: errText(e), sweep_ms: el() });
        return;
      }

      if (outcome.kind === "driven") {
        summary.runs_observed += 1;
        const line: Record<string, unknown> = { runId, event: "run-observed", chain_ms: outcome.chainMs, sweep_ms: el() };
        if (outcome.markerOk !== undefined) line.marker_ok = outcome.markerOk;
        sweepLine(deps.requestId, line);
      } else if (outcome.kind === "unsettled") {
        if (outcome.terminal !== undefined && outcome.terminal.code === "run-engine-dead") {
          // The sweep's own disposition for the one unambiguous liveness
          // reading — deliberately NOT DF3.7's event name: DF3.7's terminal
          // carries marker_poll_ms on the single-run channel; this is a
          // per-pass disposition carrying sweep_ms. Retires in-pass only.
          summary.runs_engine_dead += 1;
          retiredInPass.add(runId);
          sweepLine(deps.requestId, {
            runId,
            event: "sweep-engine-dead",
            code: "run-engine-dead",
            error: logText(outcome.terminal.message),
            remediation: logText(outcome.terminal.remediation),
            sweep_ms: el(),
          });
        } else if (outcome.verdict.kind === "skip") {
          // A skip at maxTicks 1 can never reach DF3.7's six-skip streak —
          // the sweep reports its own per-pass disposition and keeps the
          // candidate, never folding it into runs_unsettled where a dead
          // network would masquerade as a healthy run still walking.
          summary.runs_box_unreachable += 1;
          sweepLine(deps.requestId, { runId, event: "sweep-box-unreachable", code: "sweep-box-unreachable", sweep_ms: el() });
        } else {
          // Absent marker, run still walking / never started — the healthy
          // still-running shape: no refusal line, the candidate simply
          // re-enumerates next tick. (An "unusable" verdict also lands here
          // at maxTicks 1 — one tick cannot reach DF3.7's three-consecutive
          // terminal, so the misfiling is bounded by the tick and heals on
          // the next pass's fresh read.)
          summary.runs_unsettled += 1;
        }
      } else if (outcome.kind === "refused") {
        // Design decision of record: the chain-side pre-flight refusals that
        // remain REACHABLE here — approval-already-registered,
        // approval-state-unrecognized, run-already-closed (record-names-no-box
        // is unreachable: candidates carry vmName) — are each the "another
        // invocation, or a hand edit, got there between enumeration and lock"
        // window AC3 names, and fold into completion_unwitnessed so the
        // counter identity holds (the Observability Contract: the dispositions
        // account for candidates_enumerated minus the partial-pass remainder).
        // A future DF3.7 refusal code lands here too — its verbatim code
        // rides the line, so a misfiled new code stays visible even when its
        // counter is this one.
        summary.completion_unwitnessed += 1;
        sweepLine(deps.requestId, {
          runId,
          event: "completion-unwitnessed",
          code: outcome.code,
          error: logText(outcome.message),
          remediation: logText(outcome.remediation),
          sweep_ms: el(),
        });
      } else if (outcome.kind === "vetoed") {
        summary.runs_vetoed += 1;
        sweepLine(deps.requestId, { runId, event: "sweep-vetoed", error: logText(outcome.reason), sweep_ms: el() });
      } else if (outcome.kind === "approval-failed") {
        summary.runs_approval_failed += 1;
        sweepLine(deps.requestId, { runId, event: "sweep-approval-failed", error: logText(outcome.error), sweep_ms: el() });
      } else if (outcome.kind === "chain-failed") {
        summary.runs_chain_failed += 1;
        sweepLine(deps.requestId, { runId, event: "sweep-chain-failed", step: outcome.step, error: logText(outcome.error), sweep_ms: el() });
      } else {
        summary.runs_handed_off += 1;
        sweepLine(deps.requestId, { runId, event: "sweep-handed-off", outcome: logText(outcome.outcome), sweep_ms: el() });
      }
    } catch (e) {
      // F2: the net under everything above the chain's own typed outcomes —
      // chain-context construction (buildChainCtx/writableStore: no key env on
      // a keyed record, ledger construction) and any unexpected residual. A
      // per-candidate failure is counted and the pass CONTINUES: oldest-first
      // would otherwise wedge every tick at the same head and starve the tail,
      // the exact starvation the partial-pass design exists to prevent. The
      // error's own code rides the line verbatim when it carries one.
      summary.runs_chain_failed += 1;
      const c = (e as { code?: unknown }).code;
      sweepLine(deps.requestId, {
        runId,
        event: "sweep-chain-failed",
        ...(typeof c === "string" && c !== "" ? { code: c } : {}),
        error: errText(e),
        sweep_ms: el(),
      });
    } finally {
      // Close the per-run handles first (best-effort by contract), then the
      // lock — in a finally per candidate, so every path above releases.
      try {
        chainCtx?.close();
      } catch {
        // close is best-effort; its typed notes are the caller's
      }
      try {
        releaseRunLock(handle);
      } catch {
        // A destructive-window mark the chain armed and did not clear
        // (chain-failed teardown) — the lock is deliberately left for the
        // operator, withRunLock's own leave-for-operator posture.
      }
    }
  };

  for (const rec of candidates) {
    if (retiredInPass.has(rec.runId)) continue; // AC4d's in-pass retire — vacuous today (ids are unique per pass), structural by intent
    // Bounds are checked BETWEEN candidates: exceeding either is a counted,
    // logged partial pass naming the count left behind — and the next tick
    // makes progress, because a driven run leaves the candidate set.
    if (processed >= maxCandidates || Date.now() - passStart >= budgetMs) {
      summary.candidates_skipped = candidates.length - processed;
      // chain_ms is ABSENT here, never 0 — the pass never reached these runs.
      sweepLine(deps.requestId, {
        event: "candidate-skipped",
        left_behind: summary.candidates_skipped,
        reason: processed >= maxCandidates ? "max-candidates-per-pass" : "wall-clock-budget",
        sweep_ms: el(),
      });
      break;
    }
    await driveOne(rec);
    processed += 1;
  }

  summary.box_reboot_after_dispatch = rebootRuns.size; // per DISTINCT runId (AC4c)
  summary.uptime_unknown = unknownRuns.size;
  summary.sweep_ms = el();
  // sweep-complete carries ALL counters (the raw uptime evidence stays on the
  // per-box log lines and the returned summary — the line needs the counts).
  const { uptime_evidence: _evidence, sweep_ms: _ms, ...counters } = summary;
  sweepLine(deps.requestId, { event: "sweep-complete", ...counters, sweep_ms: summary.sweep_ms });
  return { kind: "sweep", summary };
}
