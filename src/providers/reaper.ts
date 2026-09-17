/**
 * Reaper (DF2.6) — the fleet-wide backstop: enumerate everything, classify it
 * by the three-way join (VM × key × record on the derived runId), and reap
 * what nobody owns.
 *
 * Lifted from inkwell's reap.just (R4 §3.4) — which shipped unrun upstream, so
 * the safety posture is re-proven here, not inherited: dry-run by default
 * (reap.just:12-32), fail-closed preflight (line 34 → driver whoami in the
 * CLI), pagination fail-closed (:40-42), an unreadable record is a hard exit
 * (:69-73), and the sbx- prefix re-asserted at the point of deletion
 * (:106-110 — already enforced inside revokeAndVerify, credentials.ts:429-435;
 * not reimplemented here).
 *
 * Every mutating call routes through the existing DF2.5/DF2.3 machinery —
 * teardownSandbox per collapsed runId, driver.destroy per leaked VM,
 * revokeAndVerify per record-less leaked key — so the reaper owns
 * classification and orchestration only. NO key value is ever logged; rows and
 * reports carry `keyHashPrefix` (first 12 hex) with the full hash in memory
 * only for the duration of a revoke call.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { log, newRequestId } from "../swarmclaw/log.ts";
import {
  MAX_VERIFY_PAGES,
  revokeAndVerify,
  SBX_KEY_PREFIX,
  type CredentialDeps,
  type KeyApi,
  type KeyEntry,
} from "./credentials.ts";
import {
  auditRepoSlug,
  driverListing,
  emitAuditLink,
  ProvisionRefusedError,
  RUN_ID_SHAPE,
  SBX_OWNERSHIP_TAG,
  unverifiedVmListingRefusal,
  type ProviderAuditLink,
  type ProviderDriver,
  type ProviderVm,
} from "./driver.ts";
import {
  loadQuotaLimits,
  type QuotaLimitsError,
  type LoadedQuotaLimits,
  type QuotaLimits,
  type QuotaLimitsSource,
} from "./quota.ts";
import type { RunRecord, RunRecordStore } from "./run-record.ts";
import { teardownSandbox, type TeardownDeps } from "./teardown.ts";
import { LIST_TIMEOUT_MS, TimeoutError, withTimeout } from "./timeout.ts";
import { ProviderError } from "./errors.ts";
// DF2.11: the per-run invocation lock wraps every teardown unit the sweep
// issues (ONE teardown per run at a time — the same guarantee the operator
// CLIs already give each other). Runtime import, not type-only: the sweep
// calls withRunLock and classifies its RunLockedError refusal.
import { RunLockedError, withRunLock } from "../../scripts/lib/run-lock.ts";

/**
 * The generated run-id grammar — now declared in driver.ts beside
 * `isFactoryOwnedVm`, which `reapRuns` needs too. Re-exported here so every
 * existing importer of `reaper.ts` is unchanged.
 */
export { RUN_ID_SHAPE };

/**
 * The sweep's ownership test — driver.ts's `isFactoryOwnedVm` widened on the
 * NAME half to the grammar a record already on disk may carry, WITHOUT letting
 * the legacy grammar swallow co-tenants.
 *
 * Generated shape (`RUN_ID_SHAPE`) + tag ⇒ owned outright: only `newId`
 * produces those names, so the pair is a two-factor proof and a record-less
 * such box is a leak — and record-less ⇒ destroyed exactly as before (the
 * generated shape IS the corroboration; no record reference is needed).
 *
 * Legacy-only shape (fits run-record.ts's `LEGACY_RUN_ID_RE` read grammar but
 * not the generated one — this file no longer tests against it, since the
 * `hasRecordClaim` half already carries the whole legacy arm) +
 * tag is NOT sufficient on its own: `[a-z0-9][a-z0-9-]*` matches any lowercase
 * co-tenant name (`ci-runner-2`), and `SBX_OWNERSHIP_TAG` is a fixed constant
 * shared by every deployment of this code — a sibling deployment, a manually
 * tagged box or a relocated runs dir all present as tagged legacy names this
 * factory never minted. Destroying one of those is unrecoverable, so the
 * legacy arm demands corroboration THIS deployment can see: a run record in
 * its own store resolving under the box's name (`hasRecordClaim`). A record
 * whose box this store knows by that exact id is evidence no third party can
 * plant from outside; absent it, tagged-legacy is report-only, which is the
 * pre-widening verdict for every non-generated name.
 */
function isReaperOwnedVm(vm: ProviderVm, hasRecordClaim: boolean): boolean {
  if (vm.tag !== SBX_OWNERSHIP_TAG) return false;
  return RUN_ID_SHAPE.test(vm.name) || hasRecordClaim;
}

export type RowClass =
  | "paired" | "leaked-vm" | "leaked-key" | "stale-record"
  | "paired-pending" | "key-age-unavailable" | "foreign";
export type RowAction = "report" | "teardown" | "destroy" | "revoke" | "skipped" | "reap-blocked";

export interface SweepRow {
  kind: "vm" | "key" | "record";
  /** vm name | key name | runId. */
  id: string;
  /** Derived join key when factory-owned. */
  runId?: string;
  class: RowClass;
  action: RowAction;
  /** First 12 hex of the key hash — NEVER the full hash at rest. */
  keyHashPrefix?: string;
  /** Set when the row's action is executed per-run, not per-item. */
  sharedActionRunId?: string;
  /** record.keyHash ≠ joined key's hash ⇒ the runId is reap-suppressed. */
  keyHashMismatch?: true;
  failure?: { code: string; message: string; remediation: string };
}

export interface SweepReport {
  requestId: string;
  mode: "dry-run" | "apply";
  limitsSource: QuotaLimitsSource;
  ceilings: QuotaLimits;
  liveVms: number;
  liveKeys: number;
  records: number;
  timings: { list_vms_ms: number; list_keys_ms: number; read_records_ms: number; reap_ms: number };
  rows: SweepRow[];
  /** runIds | vm names | keyHashPrefixes — calls ISSUED (predictions in dry-run). */
  executed: { teardown: string[]; destroy: string[]; revoke: string[] };
  /**
   * Each failure carries the counter identity of its unit — teardown: runId,
   * destroy: vm, revoke: keyHashPrefix — so a perpetually failing item of ANY
   * class escalates to reap-blocked instead of being retried forever. Message
   * and remediation are scrubbed to the 12-hex prefix: a full key hash is
   * never persisted at rest, even inside a failure (credentials errors embed
   * it verbatim; reaper.ts contract line).
   *
   * One row is NOT a failed unit: `code: "run-locked"` is a REFUSAL — the
   * teardown never started (AC4/INV-LOCK-3), the unit is absent from
   * `executed`, and the sweep continued past it. It still lands here (and
   * still makes an apply run exit 1) because a run the sweep could not touch
   * is exactly what an operator must see; cron/CI consumers distinguish
   * refusal-noise from real failure by this code — sandbox-reap prints the
   * distinct summary line when any are present.
   */
  failures: { runId?: string; vm?: string; keyHashPrefix?: string; code: string; message: string; remediation: string }[];
  /** Zero rows with action ∈ {teardown, destroy, revoke, reap-blocked}. */
  nothingToReap: boolean;
  /** `.sandbox/reap/<ISO-with-dashes>.json` — written in BOTH modes. */
  reportFile: string;
}

export interface SweepDeps {
  driver: ProviderDriver;
  store: RunRecordStore;
  keyApi: KeyApi;
  /** Default loadQuotaLimits(). */
  limits?: LoadedQuotaLimits;
  /** Default ".sandbox/reap". */
  reapDir?: string;
  requestId?: string;
  /** D6: no fake timers — the clock is injectable instead. */
  now?: () => Date;
  /** Default REAP_ACTION_TIMEOUT_MS — per-unit provider-op budget in --yes. */
  actionTimeoutMs?: number;
  /**
   * Default REAP_TEARDOWN_TIMEOUT_MS — the teardown unit's own budget, kept
   * separate from `actionTimeoutMs` because a teardown's legs (two
   * TAR_MAX_BYTES-growable copyFile pulls, several 120 s-ceiling transport
   * execs) do not fit a single provider op's ceiling. Overrides the destroy/
   * revoke budget here would make wedged-teardown tests 10 minutes long, so
   * this seam exists for exactly that.
   */
  teardownTimeoutMs?: number;
  /** Default REAP_PHASE_BUDGET_MS — wall-clock cap on the whole apply phase. */
  reapBudgetMs?: number;
  /**
   * DF2.8's box-hours ledger for the sweep's teardown units. The CLI wires it
   * exactly as sandbox-teardown does (costLedgerOpts(store.dir) + the store's
   * own readRunRecord) — without it a reaped run's teardown closes the record
   * but never writes the priced box_hours row, so the dispatch's reservation
   * stays open against the budget cap forever (MEASURED live 2026-08-26,
   * T3.4b: "teardown 1" yet zero cost_events rows and the issue's headroom
   * never restored). Optional only so non-CLI embedders keep compiling.
   */
  costLedger?: TeardownDeps["costLedger"];
  /**
   * DF5.3: the audit emit seam, required so an unwired construction fails at
   * compile time. It serves the orphan-path `reap` link here and rides the
   * sweep's `teardownDeps` so a reaper-initiated `teardownSandbox` emits its
   * own `teardown` link. See `ProviderAuditLink` (driver.ts).
   */
  recordAuditLink: (link: ProviderAuditLink) => void;
}

export interface SweepOptions {
  /** Dry-run by default: identical rows/actions, zero calls. */
  yes?: boolean;
}

export class SweepError extends ProviderError {
  /**
   * Machine-readable failure class; also the `code` in every log line.
   * `declare` — the base already OWNS and assigns this field; this narrows its
   * declared type for callers that switch on the union. A redeclaration
   * WITHOUT `declare` would emit a class field (target ES2022 ⇒
   * useDefineForClassFields) that overwrites the base's assignment with
   * undefined after super() returns.
   */
  declare readonly code: "list-unverified" | "record-unreadable" | "quota-limits-error" | "budget-invalid";

  constructor(
    code: "list-unverified" | "record-unreadable" | "quota-limits-error" | "budget-invalid",
    message: string,
    remediation: string,
  ) {
    super(code, message, remediation);
    this.name = "SweepError";
  }
}

const DEFAULT_REAP_DIR = ".sandbox/reap";
/** At most 25 executed reap actions per sweep; the rest report as skipped. */
const MAX_ACTIONS_PER_SWEEP = 25;
/** ≥3 consecutive failed reap attempts per runId ⇒ reap-blocked (zero calls). */
const REAP_BLOCKED_AFTER = 3;
/**
 * Per-unit budget in the apply loop for the SINGLE-CALL ops — a destroy (with
 * its pre-destroy rechecks) or a revoke-and-verify. A unit that exceeds it
 * lands in `failures` with its counter identity, like any thrown provider
 * error. NOT the teardown budget — see REAP_TEARDOWN_TIMEOUT_MS.
 */
const REAP_ACTION_TIMEOUT_MS = 60_000;
/**
 * The TEARDOWN unit's own budget. It cannot share REAP_ACTION_TIMEOUT_MS
 * because a teardown is not one provider call: `teardownSandbox` runs
 * stopVisualizer + the artifacts tar build + the bundle-create exec (each a
 * transport exec with its own DEFAULT_EXEC_TIMEOUT_MS = 120 s ceiling), TWO
 * `copyFile` pulls that a workload can legitimately grow to TAR_MAX_BYTES =
 * 512 MiB each, several host-side git calls, revoke+verify and destroy. A
 * 60 s whole-teardown ceiling is therefore BELOW the transport's own
 * per-exec ceiling: a merely-slow artifacts pull (a 512 MiB copy at ~3 MB/s
 * is ~170 s) hit it, `withTimeout` abandoned the teardown BEFORE destroy, and
 * the sweep re-abandoned the same unit on every subsequent sweep — an
 * immortal billing box, which is the exact outcome the reaper exists to end.
 *
 * 600 s = 5 transport ceilings: one max-size copy pair plus the remaining
 * exec legs at realistic speeds, still a hard bound. Worst sweep wall-clock
 * stays bounded by construction: REAP_PHASE_BUDGET_MS stops STARTING units,
 * so the ceiling is (phase budget + one in-flight teardown budget) ≈ 15 min.
 */
const REAP_TEARDOWN_TIMEOUT_MS = 600_000;
/**
 * Wall-clock budget for the whole apply phase. Without it, 25 capped units ×
 * a wedged provider each waiting its full action timeout is a sweep bounded
 * only by the cap; expiry stops STARTING new units (their rows report
 * `skipped`, the same semantics as the action cap — retry targets, not
 * failures). The budget is checked BEFORE a unit starts, never mid-flight, so
 * the true worst wall-clock is this budget plus one in-flight unit's own
 * ceiling (REAP_TEARDOWN_TIMEOUT_MS for a teardown unit — a sweep whose first
 * teardown legitimately runs long will start few further units; they stay
 * skipped retry targets, which is the safe direction).
 */
const REAP_PHASE_BUDGET_MS = 300_000;
/**
 * Only the newest N report files feed the streak counters (countReapBlocked)
 * — a streak needs 3 consecutive failures, so evidence older than N
 * operator-invoked sweeps is stale, and unbounded parsing grows with the
 * reap dir forever.
 */
export const REAP_HISTORY_MAX_REPORTS = 200;
/**
 * Max retry attempts for an atomic report-file write under the same timestamp.
 * A pathological same-stamp collision storm (frozen clock + concurrent writer)
 * could otherwise loop forever — each retry uses a fresh name, so the loop
 * terminates in practice, but this guards against the theoretical unbounded case.
 */
const REPORT_NAME_ATTEMPTS = 1000;

// ─── helpers ─────────────────────────────────────────────────────────────────

interface ReapUnit {
  type: "teardown" | "destroy" | "revoke";
  rows: SweepRow[];
  /** teardown: runId; destroy: vm name; revoke: keyHashPrefix. */
  id: string;
  /** revoke only: the FULL hash — in memory for the call, never at rest. */
  hash?: string;
  durationMs: number;
}

/** The record's keyHash for a teardown unit — the hash to scrub from its failures. */
function recordKeyHash(deps: Pick<SweepDeps, "store">, runId: string): string | undefined {
  try {
    return deps.store.get(runId).keyHash;
  } catch {
    return undefined; // the record itself failed to read — nothing to scrub against
  }
}

/**
 * Consecutive failed reap attempts per counter identity (teardown: runId,
 * destroy: vm name, revoke: keyHashPrefix), counted over the prior apply-mode
 * report files in reapDir — REPORT files only (sortedReapReports applies the
 * shared REAP_REPORT_NAME_RE scope, so an operator's own JSON in a shared
 * reapDir can neither feed nor reset a streak; round-5 BE-3/EE-1), and a
 * dry-run attempts nothing, so its reports never move the counter).
 * Files are ordered by mtime — the report filename's
 * timestamp is only millisecond-granular, and a fixed test clock can mint
 * several files under the same name stem — and only the newest
 * REAP_HISTORY_MAX_REPORTS are read. mtimes are precomputed with a guarded
 * statSync (a report can vanish between readdir and sort/read), and the
 * cached values do the sorting — statSync inside a comparator re-stats per
 * comparison and throws on a vanished file. A prior file that is missing or
 * unparseable is skipped: the worst it can hide is a failure we would have
 * counted, and one unreadable report must not stop the sweep from reaping
 * everything else.
 */
type ReapFailure = { code: string; message: string; remediation: string };

/**
 * The report name this file's own write loop mints: `<ISO-with-dashes>.json` or
 * its `-<n>` suffix. Shaped here so BOTH readers share one definition (BE-3/
 * round-5): the prune below must not delete anything else, and the streak
 * counter must not READ anything else — an operator's own JSON in a shared
 * reapDir once fed countReapBlocked, where a stranger's `executed`-without-
 * `failures` body could RESET a real failure streak (the blindfold direction
 * the filter removes).
 */
const REAP_REPORT_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:-\d+)?\.json$/;

/**
 * Every REPORT file in reapDir (name-scoped by REAP_REPORT_NAME_RE), oldest
 * first. mtimes are precomputed with a guarded statSync (a report can vanish
 * between readdir and sort/read), and the cached values do the sorting —
 * statSync inside a comparator re-stats per comparison and throws on a vanished
 * file. The filename stamp is only millisecond-granular and a fixed test clock
 * can mint several files under the same stem, so the name breaks mtime ties.
 */
function sortedReapReports(reapDir: string): Array<{ f: string; p: string; mtimeMs: number }> {
  if (!existsSync(reapDir)) return [];
  return readdirSync(reapDir)
    .filter((f) => REAP_REPORT_NAME_RE.test(f))
    .map((f) => {
      const p = join(reapDir, f);
      try {
        return { f, p, mtimeMs: statSync(p).mtimeMs };
      } catch {
        return undefined; // vanished between readdir and stat — skip it
      }
    })
    .filter((x): x is { f: string; p: string; mtimeMs: number } => x !== undefined)
    .sort((a, b) => (a.mtimeMs !== b.mtimeMs ? a.mtimeMs - b.mtimeMs : a.f < b.f ? -1 : 1));
}

/**
 * F043 — delete every report the counters can never read again. Only the newest
 * REAP_HISTORY_MAX_REPORTS feed countReapBlocked, but nothing ever removed the
 * rest: an operator sweeping hourly grew the dir forever, and countReapBlocked
 * then paid a readdir + one statSync per file over the WHOLE history each sweep
 * to slice off the same 200. Called after the new report is safely on disk, so
 * a failed write never costs history.
 *
 * Best-effort by construction: an unlink that fails (a report made read-only,
 * a racing sweep that already removed it) is skipped. Pruning is hygiene — it
 * must never turn a completed sweep into a failed one.
 *
 * Scope (round-3 C7): the ONLY candidates unlinked are files named like this
 * tool's own reports (`<ISO-stamp>.json`, plus its `-<n>` collision suffixes) —
 * the REAP_REPORT_NAME_RE filter lives inside sortedReapReports, so this and
 * the streak counter share one definition of "a report". The `.json` suffix
 * alone is not a scope — an operator who points reapDir at a directory that
 * also holds other JSON files must not have them deleted or counted.
 *
 * Runs in BOTH modes (round-5 EE-2): a dry-run still writes a report, and
 * once a sweep history passes the ceiling those dry-run reports are ballast
 * the counters can never read again. The name scope above is what keeps the
 * sweep non-destructive in prediction mode — the only files it can ever
 * remove are its own kind, and only past the ceiling.
 */
function pruneReapReports(reapDir: string): void {
  // The WHOLE body is guarded, not just the unlinks: sortedReapReports readdirs
  // and stats, and either can throw (the dir removed under us, a permission
  // change). The docblock's promise is that pruning never fails a completed
  // sweep, and a throw from the listing would have broken it just as surely as
  // a throw from an unlink. The next sweep tries again.
  try {
    const files = sortedReapReports(reapDir);
    for (const { p } of files.slice(0, Math.max(0, files.length - REAP_HISTORY_MAX_REPORTS))) {
      try {
        unlinkSync(p);
      } catch {
        // One unreadable/held report must not stop the rest from being pruned.
      }
    }
  } catch {
    // Hygiene only — never a verdict.
  }
}

function countReapBlocked(reapDir: string): Map<string, { count: number; last: ReapFailure }> {
  const streaks = new Map<string, { count: number; last: ReapFailure }>();
  // Guarded like pruneReapReports: the reap dir can be removed or made
  // unreadable between sortedReapReports' own existsSync and its readdir, and
  // a sweep that already verified its whole population must not die at the
  // streak read with a raw errno no SweepError code names (round-3 C8). An
  // unreadable history yields NO streaks — the sweep reaps, never less.
  let files: Array<{ f: string; p: string; mtimeMs: number }>;
  try {
    files = sortedReapReports(reapDir).slice(-REAP_HISTORY_MAX_REPORTS);
  } catch {
    return streaks;
  }
  for (const { p } of files) {
    let body: SweepReport;
    try {
      body = JSON.parse(readFileSync(p, "utf8")) as SweepReport;
    } catch {
      continue;
    }
    if (body.mode !== "apply") continue;
    const failed = new Map<string, ReapFailure>();
    for (const failure of body.failures ?? []) {
      const id = failure.runId ?? failure.vm ?? failure.keyHashPrefix;
      if (id !== undefined) failed.set(id, failure);
    }
    for (const id of [
      ...(body.executed?.teardown ?? []),
      ...(body.executed?.destroy ?? []),
      ...(body.executed?.revoke ?? []),
    ]) {
      const failure = failed.get(id);
      if (failure !== undefined) {
        const s = streaks.get(id) ?? { count: 0, last: failure };
        s.count += 1;
        s.last = failure;
        streaks.set(id, s);
      } else {
        streaks.delete(id); // the attempt succeeded — streak broken
      }
    }
  }
  return streaks;
}

// ─── the sweep ───────────────────────────────────────────────────────────────

export async function sweep(deps: SweepDeps, opts: SweepOptions = {}): Promise<SweepReport> {
  const requestId = deps.requestId ?? newRequestId();
  const now = deps.now ?? (() => new Date());
  // P41 (round 4): same trust boundary as driver.ts's `action-timeout-invalid`
  // — `0`, a negative or a NaN budget makes `withTimeout` fire ~immediately,
  // so EVERY unit lands in `failures` wearing full provider-timeout
  // remediation, and REAP_BLOCKED_AFTER then turns live billing boxes
  // permanently reap-blocked off a config typo. Validated in BOTH modes: a
  // dry-run's predictions are only honest against budgets that could run.
  for (const [name, ms] of [
    ["actionTimeoutMs", deps.actionTimeoutMs],
    ["teardownTimeoutMs", deps.teardownTimeoutMs],
    ["reapBudgetMs", deps.reapBudgetMs],
  ] as const) {
    if (ms !== undefined && (!Number.isFinite(ms) || ms < 1)) {
      throw new SweepError(
        "budget-invalid",
        `${name} ${JSON.stringify(ms)} is not a finite number >= 1 ms`,
        "pass a positive millisecond budget, or omit the seam for its default",
      );
    }
  }
  let limits: LoadedQuotaLimits;
  try {
    limits = deps.limits ?? loadQuotaLimits();
  } catch (e) {
    const err = e as QuotaLimitsError;
    throw new SweepError(
      "quota-limits-error",
      err.message ?? String(e),
      err.remediation ?? "fix or remove .sandbox/quota-limits.json, then re-run the sweep",
    );
  }
  const staleAfterMs = limits.limits.staleAfterMs;

  // ── Phase A — enumerate. ANY failure here throws: nothing is deleted on an
  // unverified population (INV-2/AC3/AC4).
  const tRecords = Date.now();
  let records: RunRecord[];
  try {
    // `list()`, not `listWithAnomalies()`: this phase has nothing to DO with the
    // two halves. `list()` already refuses on a non-empty `skipped` and names
    // each file with the reason it was skipped, which is exactly the refusal
    // this catch re-wraps — reading the anomaly here would only rebuild that
    // message by hand, with less detail. `src/fleet/status.ts` reads the halves
    // because it RENDERS the anomaly; a destructive sweep only ever refuses on
    // it. (`reapRuns` in driver.ts refuses on the same input the same way.)
    records = deps.store.list();
  } catch (e) {
    // The store already names the offending file and why (INV-4). Propagate
    // loudly — a dropped record is a key nobody revokes.
    throw new SweepError(
      "record-unreadable",
      `${(e as Error).message} — refusing to reap anything until every record parses`,
      "repair or remove the malformed record named above, then re-run the sweep — a live box and key may sit behind it",
    );
  }
  const read_records_ms = Date.now() - tRecords;

  const tVms = Date.now();
  let vms: ProviderVm[];
  try {
    // `driverListing`, not `list`: a box the driver refused to name is not an
    // absent box, and this phase's whole contract is that nothing is deleted
    // on an unverified population. A skipped box is invisible spend — never
    // destroyed (it is never seen), never reported, never reaped.
    const listing = await withTimeout(driverListing(deps.driver), LIST_TIMEOUT_MS, "driver.list()");
    // The refusal for THIS input has one source (driver.ts) — `reapRuns` raises
    // the same one on the same listing, and the two used to word it, and its
    // remediation, differently by hand.
    if (listing.skipped.length > 0) throw unverifiedVmListingRefusal(deps.driver.name, listing.skipped);
    vms = listing.vms;
  } catch (e) {
    // The shared refusal already carries the message AND the remediation for an
    // unverified population; anything else here (a transport failure, the
    // timeout) gets the enumeration wording and this phase's own remediation.
    // `SweepError`'s `code` stays `list-unverified` either way — that is what
    // the CLI classifies on, and the shared refusal's own code is a
    // ProvisionRefusedError code, not one of this class's three.
    const shared = e instanceof ProvisionRefusedError ? e : undefined;
    throw new SweepError(
      "list-unverified",
      shared?.message ??
        `could not enumerate the provider VM list: ${(e as Error).message} — an uncounted population is never reaped`,
      shared?.remediation ?? "re-run once the provider list answers; check the driver/substrate by hand if it repeats",
    );
  }
  const list_vms_ms = Date.now() - tVms;

  const tKeys = Date.now();
  let keys: KeyEntry[];
  try {
    const res = await withTimeout(deps.keyApi.listAllKeys(MAX_VERIFY_PAGES), LIST_TIMEOUT_MS, "keyApi.listAllKeys()");
    if (res.truncated) throw new Error("the key list truncated inside the page budget");
    keys = res.entries;
  } catch (e) {
    throw new SweepError(
      "list-unverified",
      `could not fully enumerate the provider key list: ${(e as Error).message} — absence is never inferred from a partial page`,
      `re-list by hand with paging: curl 'https://openrouter.ai/api/v1/keys?offset=0' -H 'Authorization: Bearer $OPENROUTER_PROVISIONING_KEY'`,
    );
  }
  const list_keys_ms = Date.now() - tKeys;

  // ── Phase B — classify (AC1 table). Join keys: key `sbx-<runId>` → strip
  // the prefix; VM name = runId; record filename stem = runId.
  const nowMs = now().getTime();
  const keysByName = new Map(keys.map((k) => [k.name, k] as const));
  const recordsByRun = new Map(records.map((r) => [r.runId, r] as const));
  // keyHash confirmation: where a record carries keyHash and the joined key
  // exists, the hashes must agree — a mismatch is two credentials claiming one
  // run, and the whole runId is reap-suppressed.
  const mismatchRunIds = new Set<string>();
  for (const rec of records) {
    const joined = keysByName.get(`${SBX_KEY_PREFIX}${rec.runId}`);
    if (rec.keyHash !== undefined && joined !== undefined && joined.hash !== rec.keyHash) {
      mismatchRunIds.add(rec.runId);
    }
  }
  const aged = (createdAtIso: string): boolean => nowMs - Date.parse(createdAtIso) >= staleAfterMs;

  const rows: SweepRow[] = [];

  for (const vm of vms) {
    // Foreign by grammar, or tagged-or-not without a name this factory could
    // have generated: reported for manual remediation, NEVER destroyed
    // (INV-1 fail-safe — exedev's ls reports no tag, so its boxes all land
    // here). `isReaperOwnedVm` is `isFactoryOwnedVm` with the name half widened
    // to the legacy record grammar (see its docstring); the tag half — the
    // part INV-1 actually leans on — is unchanged, and the legacy arm demands
    // a record reference as corroboration before it ever votes destroy.
    if (!isReaperOwnedVm(vm, recordsByRun.has(vm.name))) {
      rows.push({ kind: "vm", id: vm.name, class: "foreign", action: "report" });
      continue;
    }
    const rec = recordsByRun.get(vm.name);
    if (rec === undefined || rec.closedAt !== undefined) {
      rows.push({ kind: "vm", id: vm.name, runId: vm.name, class: "leaked-vm", action: "destroy" });
      continue;
    }
    const stale = aged(rec.createdAt);
    rows.push({
      kind: "vm",
      id: vm.name,
      runId: vm.name,
      class: stale ? "stale-record" : "paired",
      action: stale ? "teardown" : "report",
      ...(stale ? { sharedActionRunId: vm.name } : {}),
    });
  }

  for (const key of keys) {
    const base = { kind: "key" as const, id: key.name, keyHashPrefix: key.hash.slice(0, 12) };
    // The sbx- prefix is the entire key-side safety model: an unprefixed key
    // is the operator's own and is never a candidate (reap.just:7-9).
    if (!key.name.startsWith(SBX_KEY_PREFIX)) {
      rows.push({ ...base, class: "foreign", action: "report" });
      continue;
    }
    const runId = key.name.slice(SBX_KEY_PREFIX.length);
    const rec = recordsByRun.get(runId);
    if (rec === undefined) {
      // No record ⇒ age is the only discriminator, and an age the provider
      // never reported — or reported in a form Date.parse cannot read (NaN) —
      // is UNKNOWN, not young: report, never revoke (AC7). An unparseable
      // timestamp classed paired-pending would be an orphan the sweep never
      // escalates, so it rides the same fail-safe branch as absence.
      const keyAgeMs = key.createdAt !== undefined ? Date.parse(key.createdAt) : Number.NaN;
      if (Number.isNaN(keyAgeMs)) {
        rows.push({ ...base, class: "key-age-unavailable", action: "report" });
      } else if (nowMs - keyAgeMs >= staleAfterMs) {
        rows.push({ ...base, runId, class: "leaked-key", action: "revoke" });
      } else {
        rows.push({ ...base, runId, class: "paired-pending", action: "report" });
      }
      continue;
    }
    if (rec.closedAt !== undefined) {
      // D3: routed through DF2.5 teardown per the AC1 table — the reaper never
      // revokes a record-claiming key itself. Teardown on a closed record
      // skips every step, so apply-mode records the failed attempt after.
      rows.push({ ...base, runId, class: "leaked-key", action: "teardown", sharedActionRunId: runId });
      continue;
    }
    const stale = aged(rec.createdAt);
    rows.push({
      ...base,
      runId,
      class: stale ? "stale-record" : "paired",
      action: stale ? "teardown" : "report",
      ...(stale ? { sharedActionRunId: runId } : {}),
    });
  }

  for (const rec of records) {
    if (rec.closedAt !== undefined) continue; // closed ⇒ no live box for the reaper; ledger-side, a fresh close still holds its ceiling until the retirement grace cutoff passes (cost-ledger.ts admitIssue)
    const stale = aged(rec.createdAt);
    rows.push({
      kind: "record",
      id: rec.runId,
      runId: rec.runId,
      class: stale ? "stale-record" : "paired",
      action: stale ? "teardown" : "report",
      ...(stale ? { sharedActionRunId: rec.runId } : {}),
    });
  }

  // Reap-suppression (keyHash mismatch): every row of the runId reports, and
  // no call is ever issued for it.
  for (const row of rows) {
    if (row.runId !== undefined && mismatchRunIds.has(row.runId)) {
      row.action = "report";
      row.sharedActionRunId = undefined;
      row.keyHashMismatch = true;
    }
  }

  // reap-blocked: ≥3 consecutive failed apply attempts ⇒ zero further calls
  // for that identity, rows carry the last failure, items stay in the counts.
  // The prior streaks are read in BOTH modes — reading is side-effect-free,
  // and a dry-run that predicted a teardown --yes would refuse to issue is a
  // lying prediction (DOD: dry run emits the same action values --yes
  // executes). Only apply-mode report files ever advanced the counters.
  const streaks = countReapBlocked(deps.reapDir ?? DEFAULT_REAP_DIR);
  for (const row of rows) {
    // Counter identity per action class: teardown collapses per-run, destroy
    // is per-VM, revoke is per-keyHashPrefix.
    const id =
      row.action === "teardown"
        ? row.sharedActionRunId
        : row.action === "destroy"
          ? row.id
          : row.action === "revoke"
            ? row.keyHashPrefix
            : undefined;
    if (id === undefined) continue;
    const streak = streaks.get(id);
    if (streak !== undefined && streak.count >= REAP_BLOCKED_AFTER) {
      row.action = "reap-blocked";
      row.sharedActionRunId = undefined;
      row.failure = streak.last;
    }
  }

  // ── Phase C — act. Per-run collapse first (one teardown per runId however
  // many rows claim it), then per-VM destroys, then per-key revokes — the
  // cap counts EXECUTED actions across all three; the remainder report as
  // skipped. Dry-run performs zero calls and lists the same predictions.
  const units: ReapUnit[] = [];
  const teardownUnits = new Map<string, ReapUnit>();
  for (const row of rows) {
    if (row.action === "teardown" && row.sharedActionRunId !== undefined) {
      let unit = teardownUnits.get(row.sharedActionRunId);
      if (unit === undefined) {
        unit = { type: "teardown", rows: [], id: row.sharedActionRunId, durationMs: 0 };
        teardownUnits.set(row.sharedActionRunId, unit);
        units.push(unit);
      }
      unit.rows.push(row);
    }
  }
  for (const row of rows) {
    if (row.action !== "destroy") continue;
    units.push({ type: "destroy", rows: [row], id: row.id, durationMs: 0 });
  }
  for (const row of rows) {
    if (row.action !== "revoke" || row.keyHashPrefix === undefined) continue;
    // The full hash is recovered by key NAME (unique), never by prefix — a
    // 12-hex prefix collision between two live keys must not collapse them
    // into one revoke while the other leaks. In memory only, never at rest.
    const unit: ReapUnit = {
      type: "revoke",
      rows: [row],
      id: row.keyHashPrefix,
      hash: keysByName.get(row.id)?.hash,
      durationMs: 0,
    };
    units.push(unit);
  }

  const capped = units.slice(0, MAX_ACTIONS_PER_SWEEP);
  for (const unit of units.slice(MAX_ACTIONS_PER_SWEEP)) {
    for (const row of unit.rows) row.action = "skipped";
  }

  const executed: SweepReport["executed"] = { teardown: [], destroy: [], revoke: [] };
  const failures: SweepReport["failures"] = [];

  // Teardown/credential deps are rebuilt from the sweep's own handles: the
  // runsDir follows the store (bundles land beside the records) and gitCwd is
  // the invoking cwd (teardown's harvest fetch target). costLedger rides only
  // when the CLI wired one — see SweepDeps.costLedger for why it must.
  const teardownDeps: TeardownDeps = {
    driver: deps.driver,
    store: deps.store,
    keyApi: deps.keyApi,
    requestId,
    gitCwd: process.cwd(),
    runsDir: deps.store.dir,
    // DF5.3: a reaper-initiated teardown emits its own `teardown` link through
    // the same seam the orphan-path `reap` emit below uses.
    recordAuditLink: deps.recordAuditLink,
    ...(deps.costLedger !== undefined ? { costLedger: deps.costLedger } : {}),
  };
  // W14B-3, narrowed. The posture is unchanged: `revokeAndVerify` runs under a
  // run-less step context (`runId: null`, credentials.ts) and
  // `audit_links.run_id` is NOT NULL, so a run-less revocation — the
  // record-less leaked key — has no hop to serve and INV-AUDIT-4 forbids
  // manufacturing one. What enforces it is that `revokeAndVerify` is not an
  // emit site BY CONSTRUCTION (`revokeHash`/`verifyHash` emit nothing;
  // `verifyRevoked`, which does emit, takes a runId and the sweep never calls
  // it). A `() => {}` bound HERE enforced nothing of the kind — it blinded the
  // whole deps object, so any present or future credential call routed through
  // it would silently drop a link INV-AUDIT-4 wanted written, which is the
  // exact failure mode this story exists to eliminate. The seam stays live; the
  // one non-emitting site stays non-emitting where that is actually decided.
  const credDeps: CredentialDeps = {
    keyApi: deps.keyApi,
    driver: deps.driver,
    store: deps.store,
    requestId,
    recordAuditLink: deps.recordAuditLink,
  };
  // R4-9: the lock path resolves through the SAME expression teardownSandbox's
  // head check uses (`deps.runsDir ?? deps.store.dir`) — the acquire below and
  // the head check inside the call must name one file, however the teardownDeps
  // construction drifts. Today `runsDir` is set to `deps.store.dir` right
  // above, so the value is identical; the shared expression is what keeps it
  // that way (the same identity disposeLosers pins in fanout-primitive.ts).
  const teardownRunsDir = teardownDeps.runsDir ?? teardownDeps.store.dir;

  const tReap = Date.now();
  const actionTimeoutMs = deps.actionTimeoutMs ?? REAP_ACTION_TIMEOUT_MS;
  // Separate seam (see REAP_TEARDOWN_TIMEOUT_MS): a teardown unit gets its own
  // budget, so a slow-but-healthy artifacts pull is not abandoned pre-destroy
  // and the destroy/revoke ops keep the tight single-call ceiling.
  const teardownTimeoutMs = deps.teardownTimeoutMs ?? REAP_TEARDOWN_TIMEOUT_MS;
  const reapBudgetMs = deps.reapBudgetMs ?? REAP_PHASE_BUDGET_MS;
  if (opts.yes) {
    for (const unit of capped) {
      // Wall-clock budget: a provider wedging one action to its full timeout
      // must not wedge the sweep for (capped units × timeout). Units not
      // started by expiry report `skipped` — the action-cap semantics: retry
      // targets for the next sweep, not failures.
      if (Date.now() - tReap > reapBudgetMs) {
        for (const row of unit.rows) row.action = "skipped";
        continue;
      }
      const started = Date.now();
      // The unit's full key hash, in memory only — used to scrub it out of any
      // failure this unit records (credential errors embed it verbatim, and a
      // full hash is never persisted at rest).
      const unitHash =
        unit.type === "revoke" ? unit.hash : unit.type === "teardown" ? recordKeyHash(deps, unit.id) : undefined;
      const scrub = (text: string): string =>
        unitHash === undefined ? text : text.split(unitHash).join(unitHash.slice(0, 12));
      try {
        if (unit.type === "teardown") {
          executed.teardown.push(unit.id);
          // D3: the call is routed per the AC1 table; on a closed record
          // teardown skips every step, so the sweep records the failed
          // attempt with operator remediation instead of revoking itself.
          const wasClosed = deps.store.get(unit.id).closedAt !== undefined;
          // DF2.11: the teardown unit holds `<runsDir>/<unitId>.lock` for the
          // length of the call — the sweep can no longer double-teardown a run
          // whose operator CLI (or a sibling sweep) is mid-teardown; the lock
          // refusal lands in `failures` below and the sweep continues.
          // `destructive: true` keeps the interrupt posture identical to the
          // CLIs: past teardownSandbox's first mutation a throw leaves the lock
          // for the operator, and a timeout (withTimeout rejecting while
          // withRunLock's fn is still in flight) leaves it the same way — the
          // zombie-teardown exposure the CLIs already accept, no worse.
          await withTimeout(
            withRunLock(teardownRunsDir, unit.id, "sandbox-reap", (h) => teardownSandbox(teardownDeps, unit.id, h), {
              destructive: true,
              requestId,
            }),
            teardownTimeoutMs,
            `teardownSandbox(${unit.id})`,
          );
          if (wasClosed) {
            failures.push({
              runId: unit.id,
              code: "teardown-skipped-closed-record",
              message: `record ${unit.id} is closed — teardown skipped every step, so the leaked key was neither spend-captured nor revoked`,
              remediation: `revoke the key by hand (the DF2.3 verb cannot reopen a closed record): inspect the provider console for ${SBX_KEY_PREFIX}${unit.id}`,
            });
          }
        } else if (unit.type === "destroy") {
          // INV-1 re-assert immediately before the DELETE-class call: the tag
          // was proven at classification time, but classification and action
          // are separated by every other sweep step — a box whose provenance
          // changed in between (or vanished) is refused, not destroyed.
          const listed = await withTimeout(deps.driver.list(unit.id), actionTimeoutMs, `driver.list(${unit.id})`);
          // Contract violation: a non-array list is unenumerable, and indexing
          // it would surface as an opaque TypeError — refuse with a named
          // failure instead. An EMPTY array is different: it means the box
          // vanished, which the present:false refusal below already covers.
          if (!Array.isArray(listed)) {
            unit.durationMs = Date.now() - started; // the continue below would skip the loop-tail assignment
            failures.push({
              vm: unit.id,
              code: "ownership-recheck-refused",
              message: `VM ${unit.id} failed the ownership re-check immediately before destroy (driver.list(${unit.id}) returned a non-array — not destroyed)`,
              remediation: `inspect ${unit.id} by hand and destroy it via the driver once its provenance is understood`,
            });
            continue;
          }
          const current = listed[0];
          // Store re-read AFTER the provider re-read — the order is the whole
          // point. INV-1 writes the record before the VM, so any VM the
          // provider recheck just confirmed has a record that predates this
          // later read and is guaranteed to be seen here; a createRun that
          // landed between classification and now is refused instead of
          // destroyed out from under its claim. A closed record still means
          // leaked: teardown destroys before closing, so closed + live ⇒ the
          // destroy never landed.
          let claimed: RunRecord | undefined;
          let recordError: string | undefined;
          try {
            claimed = deps.store.get(unit.id);
          } catch (e) {
            // readRecord preserves the errno on the wrapped error, so a typed
            // ENOENT is a KNOWN-absent record and the classification-time
            // verdict stands. Malformed JSON and other read failures carry no
            // code — the claim state is UNKNOWN, and treating unknown as
            // absent here would destroy a live run's VM out from under a
            // record the sweep merely failed to read. Fail closed instead.
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              recordError = (e as Error).message ?? String(e);
            }
          }
          // The re-check mirrors the classification-time predicate including
          // its record-corroboration arm: `claimed` here is THIS deployment's
          // re-read of the store, so a legacy-named tagged box destroyed under
          // the widened arm at classification is corroborated (or newly claimed,
          // caught two arms down) by the same evidence at the delete boundary.
          //
          // The READ failure is judged FIRST: a record the sweep cannot re-read
          // leaves the claim state unknown, and the ownership arm below would
          // otherwise score an unreadable record as "no record corroborates
          // this box" — reporting ownership-recheck-refused (inspect the box)
          // when the actionable verdict is record-recheck-failed (repair the
          // file; the box itself may be perfectly provably ours).
          if (recordError !== undefined) {
            failures.push({
              vm: unit.id,
              code: "record-recheck-failed",
              message: `record ${unit.id}.json could not be re-read before destroy (${recordError}) — not destroyed`,
              remediation: `repair or delete ${unit.id}.json by hand, then re-run the sweep — the next sweep also refuses to enumerate a malformed record (record-unreadable), so it cannot be worked around by retrying`,
            });
          } else if (current === undefined || !isReaperOwnedVm(current, claimed !== undefined)) {
            failures.push({
              vm: unit.id,
              code: "ownership-recheck-refused",
              message: `VM ${unit.id} failed the ownership re-check immediately before destroy (present: ${current !== undefined}, tag: ${JSON.stringify(current?.tag)}) — not destroyed`,
              remediation: `inspect ${unit.id} by hand and destroy it via the driver once its provenance is understood`,
            });
          } else if (claimed !== undefined && claimed.closedAt === undefined) {
            failures.push({
              vm: unit.id,
              code: "record-claim-refused",
              message: `VM ${unit.id} was record-less (or closed-record) at classification, but an open run record now claims it — not destroyed`,
              remediation: `re-run the sweep later; teardown owns ${unit.id} through its record now`,
            });
          } else {
            executed.destroy.push(unit.id);
            await withTimeout(deps.driver.destroy(unit.id), actionTimeoutMs, `driver.destroy(${unit.id})`);
            // DF5.3: the `reap` link (hop 5, run-box) — the ORPHAN PATH ONLY.
            // A cleanly torn-down run never reaches this arm (AC5 resolves
            // `reap` as not-applicable there), so an emitted link exists only
            // for a box the reaper actually collected. Emitted only when a
            // record resolves with a DF2.8 attribution: a record-less leak has
            // no runId/repoSlug/requestId to serve the NOT NULL columns, and
            // manufacturing a link for it is exactly what INV-AUDIT-4 forbids
            // (the run-less credential posture above is the same reasoning).
            //
            // The emit is guarded SEPARATELY from the unit's own try/catch,
            // because by this line the destroy has already SUCCEEDED and
            // `unit.id` is already in `executed.destroy`. A store refusal
            // (ENOSPC, SQLITE_BUSY from a concurrent dispatch, a closed handle)
            // falling through to the unit catch pushed
            // `{vm, code: "destroy-failed"}` WITHOUT splicing the id back out
            // of `executed` (the RunLockedError arm above does splice; that one
            // did not) — so one report counted the same box as destroyed AND as
            // failed to destroy, and sent the operator to destroy a box that no
            // longer exists. A dropped link is a real problem, but it is not a
            // failed destroy: log it and let the sweep finish. `SweepReport` has
            // no non-fatal channel to carry it (`failures` feeds the apply
            // exit code), and inventing one is not this fix's business.
            const reapRec = recordError === undefined ? claimed : undefined;
            const reapRepoSlug = auditRepoSlug(reapRec);
            // The RECORD's requestId, with no fallback to the sweep's own
            // (C5/option-c, the fourth emitter). `requestId` here is
            // `deps.requestId ?? newRequestId()` and sandbox-reap supplies a
            // minted one, so the fallback could only ever stamp a per-invocation
            // id — a FALSE join the walker acts on (it JOINs
            // `sessions.request_id` / `gate_results.request_id`), on the path
            // where the record is most likely to be incomplete.
            if (reapRec !== undefined && reapRepoSlug !== undefined && reapRec.requestId === undefined) {
              log({
                requestId,
                operation: "providers.audit-link-skipped",
                agentId: null,
                timestamp: new Date().toISOString(),
                duration: 0,
                status: "error",
                runId: reapRec.runId,
                vm: unit.id,
                event: "reap",
                reason: "no-request-id",
                message: `hop run-box goes unlinked for reaped box ${unit.id}: its record carries no requestId`,
              });
            } else if (reapRec?.requestId !== undefined && reapRepoSlug !== undefined) {
              try {
                emitAuditLink(deps.recordAuditLink, {
                  runId: reapRec.runId,
                  repoSlug: reapRepoSlug,
                  requestId: reapRec.requestId,
                  hop: "run-box",
                  event: "reap",
                  subjectId: unit.id,
                  subjectKind: "box",
                  detail: { vm: unit.id, class: "leaked-vm" },
                });
              } catch (e) {
                const err = (e ?? {}) as { code?: string; message?: string };
                log({
                  requestId,
                  operation: "providers.reap-audit-link-dropped",
                  agentId: null,
                  timestamp: new Date().toISOString(),
                  duration: 0,
                  status: "error",
                  runId: reapRec.runId,
                  vm: unit.id,
                  error: {
                    code: err.code ?? "audit-link-write-failed",
                    message: scrub(err.message ?? String(e)),
                  },
                });
              }
            }
          }
        } else if (unit.hash !== undefined) {
          executed.revoke.push(unit.id);
          // Full hash in memory only; the sbx- prefix re-assert happens inside
          // revokeHash (credentials.ts:429-435) — not reimplemented here.
          await withTimeout(revokeAndVerify(credDeps, unit.hash), actionTimeoutMs, `revokeAndVerify(${unit.id})`);
        } else {
          // Dead-branch guard: the hash is captured from the classification-time
          // list, so this only fires on a driver/list contract break.
          failures.push({
            keyHashPrefix: unit.id,
            code: "revoke-target-vanished",
            message: `revoke unit ${unit.id} has no recoverable hash — target vanished between classification and apply`,
            remediation: "inspect the provider console for the key by prefix and revoke by hand",
          });
        }
      } catch (e) {
        // AC4 (INV-LOCK-3): a lock refusal is a REFUSAL, not a failed teardown
        // — the unit is not counted as executed and the sweep continues with
        // the rest. Only teardown units take the lock, so only they can raise
        // RunLockedError; both message and remediation go through `scrub` (a
        // no-op for lock-path/pid text, which never contains the unit's key
        // hash) so the stale-holder wording ("no live process holds it … rm …")
        // stays distinguishable from the busy one ("wait for that invocation
        // to finish") in the report.
        if (unit.type === "teardown" && e instanceof RunLockedError) {
          const at = executed.teardown.lastIndexOf(unit.id);
          if (at !== -1) executed.teardown.splice(at, 1);
          failures.push({ runId: unit.id, code: "run-locked", message: scrub(e.message), remediation: scrub(e.remediation) });
        } else {
          const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
          // Round-3 C3: a teardown unit abandoned by its own budget leaves the
          // destructive window open — `withTimeout` discards the zombie's own
          // corrective rejection (`void p.catch(() => {})`), so the TimeoutError
          // the sweep sees carries no stranded-lock remediation, and the generic
          // "re-run the sweep" advice dead-ends on the lock `withRunLock`
          // deliberately left (or will leave, when the zombie settles) in place.
          // Attach it here, where the operator actually reads it. The CODE is
          // unchanged — a timeout keeps classifying as `teardown-failed`. R4-33
          // (round 4): the wording states BOTH dispositions — the zombie may
          // still complete after the deadline (success path: mark cleared, lock
          // released), so asserting "left in place" as a fact can be false.
          // Same both-arms wording disposeLosers carries (fanout-primitive.ts).
          const stranded =
            unit.type === "teardown" && e instanceof TimeoutError
              ? `the teardown for ${unit.id} was abandoned by this unit's timeout budget: if it is still mid-flight it may be past its first mutation, so the run lock ${join(teardownRunsDir, `${unit.id}.lock`)} was left in place on purpose; if it completed after the deadline it released the lock itself — after this process exits, judge ${join(teardownRunsDir, `${unit.id}.lock`)} by hand (a lock that is gone means the teardown completed) and rm it before re-running any sweep`
              : undefined;
          failures.push({
            ...(unit.type === "teardown"
              ? { runId: unit.id }
              : unit.type === "destroy"
                ? { vm: unit.id }
                : { keyHashPrefix: unit.id }),
            code:
              err.code ??
              (unit.type === "teardown" ? "teardown-failed" : unit.type === "destroy" ? "destroy-failed" : "revoke-failed"),
            message: scrub(err.message ?? String(e)),
            remediation: scrub(
              stranded ??
                err.remediation ??
                "re-run the sweep after fixing the above — the other items were unaffected",
            ),
          });
        }
      }
      unit.durationMs = Date.now() - started;
    }
  } else {
    // Dry-run: identical rows/actions, zero calls — executed lists predictions.
    for (const unit of capped) {
      if (unit.type === "teardown") executed.teardown.push(unit.id);
      else if (unit.type === "destroy") executed.destroy.push(unit.id);
      else executed.revoke.push(unit.id);
    }
  }
  const reap_ms = Date.now() - tReap;

  const report: SweepReport = {
    requestId,
    mode: opts.yes ? "apply" : "dry-run",
    limitsSource: limits.source,
    ceilings: limits.limits,
    liveVms: vms.length,
    liveKeys: keys.length,
    records: records.length,
    timings: { list_vms_ms, list_keys_ms, read_records_ms, reap_ms },
    rows,
    executed,
    failures,
    nothingToReap: !rows.some((r) => r.action === "teardown" || r.action === "destroy" || r.action === "revoke" || r.action === "reap-blocked"),
    reportFile: "",
  };

  // ── observability: header + one line per row. NEVER a key value or a full
  // hash — prefixes only.
  log({
    requestId,
    operation: "reap.header",
    agentId: null,
    timestamp: now().toISOString(),
    duration: reap_ms,
    status: "ok",
    mode: report.mode,
    limitsSource: limits.source,
    ceilings: limits.limits,
    liveVms: vms.length,
    liveKeys: keys.length,
    records: records.length,
  });
  const rowUnit = new Map<SweepRow, ReapUnit>();
  for (const unit of units) for (const row of unit.rows) rowUnit.set(row, unit);
  for (const row of rows) {
    const durationMs = rowUnit.get(row)?.durationMs ?? 0;
    log({
      requestId,
      operation: "reap.row",
      agentId: null,
      timestamp: now().toISOString(),
      duration: durationMs,
      durationMs,
      status: row.failure !== undefined ? "error" : "ok",
      class: row.class,
      action: row.action,
      ...(row.kind === "vm" ? { vm: row.id } : {}),
      ...(row.keyHashPrefix !== undefined ? { keyHashPrefix: row.keyHashPrefix } : {}),
      ...(row.runId !== undefined ? { runId: row.runId } : {}),
    });
  }

  // ── report file, both modes. Dir 0700, file 0600 — reports carry key-hash
  // prefixes and failure detail, not secrets, but they are not public either
  // (reap.just umask posture). The filename is claimed ATOMICALLY with the wx
  // (exclusive-create) flag: the previous existsSync loop was check-then-act,
  // so two concurrent sweeps under the same millisecond stamp could both pick
  // the same name and one silently overwrote the other's evidence. EEXIST ⇒
  // retry with the next -<n> suffix. The body is serialized after the winning
  // name is known, so the persisted JSON includes report.reportFile; 0o600
  // applies to every file this loop creates.
  const reapDir = deps.reapDir ?? DEFAULT_REAP_DIR;
  mkdirSync(reapDir, { recursive: true, mode: 0o700 });
  chmodSync(reapDir, 0o700);
  const stamp = now().toISOString().replace(/:/g, "-");
  let name = `${stamp}.json`;
  for (let i = 1; i <= REPORT_NAME_ATTEMPTS; i++) {
    report.reportFile = join(reapDir, name);
    try {
      writeFileSync(report.reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (i === REPORT_NAME_ATTEMPTS) {
        throw new Error(
          `report-file write exhausted ${REPORT_NAME_ATTEMPTS} name attempts for stamp ${stamp} in reap dir ${reapDir} — pathological collision storm`,
        );
      }
      name = `${stamp}-${i}.json`;
    }
  }
  // F043: the write succeeded, so the history is now one longer than the
  // counters will ever read. Trim it back to the ceiling. BOTH modes (round-5
  // EE-2): a dry-run's report is ballast the counters can never read once it
  // ages past the ceiling, and pruneReapReports only ever touches files named
  // like this tool's own reports — the name scope is the non-destructive
  // guarantee, not the mode gate.
  pruneReapReports(reapDir);

  return report;
}
