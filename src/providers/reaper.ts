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

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { SBX_OWNERSHIP_TAG, type ProviderDriver, type ProviderVm } from "./driver.ts";
import {
  LIST_TIMEOUT_MS,
  loadQuotaLimits,
  withTimeout,
  type QuotaLimitsError,
  type LoadedQuotaLimits,
  type QuotaLimits,
  type QuotaLimitsSource,
} from "./quota.ts";
import type { RunRecord, RunRecordStore } from "./run-record.ts";
import { teardownSandbox, type TeardownDeps } from "./teardown.ts";

/**
 * The generated run-id grammar (`<slug>-<YYYYMMDD>-<6 hex>`, run-record.ts
 * newId). A VM name outside it can never be a factory box.
 */
export const RUN_ID_SHAPE = /^[a-z0-9][a-z0-9-]*-\d{8}-[0-9a-f]{6}$/;

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
  /** Default REAP_PHASE_BUDGET_MS — wall-clock cap on the whole apply phase. */
  reapBudgetMs?: number;
}

export interface SweepOptions {
  /** Dry-run by default: identical rows/actions, zero calls. */
  yes?: boolean;
}

export class SweepError extends Error {
  /** Machine-readable failure class; also the `code` in every log line. */
  readonly code: "list-unverified" | "record-unreadable" | "quota-limits-error";
  /** The literal next step, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(
    code: "list-unverified" | "record-unreadable" | "quota-limits-error",
    message: string,
    remediation: string,
  ) {
    super(message);
    this.name = "SweepError";
    this.code = code;
    this.remediation = remediation;
  }
}

const DEFAULT_REAP_DIR = ".sandbox/reap";
/** At most 25 executed reap actions per sweep; the rest report as skipped. */
const MAX_ACTIONS_PER_SWEEP = 25;
/** ≥3 consecutive failed reap attempts per runId ⇒ reap-blocked (zero calls). */
const REAP_BLOCKED_AFTER = 3;
/**
 * Per-unit budget in the apply loop — one teardown/destroy/revoke, including
 * its pre-destroy rechecks. Generous over the enumeration budget because a
 * teardown is multi-step (harvest fetch + destroy + revoke). A unit that
 * exceeds it lands in `failures` with its counter identity, like any thrown
 * provider error.
 */
const REAP_ACTION_TIMEOUT_MS = 60_000;
/**
 * Wall-clock budget for the whole apply phase. Without it, 25 capped units ×
 * a wedged provider each waiting its full action timeout is a 25-minute
 * sweep; expiry stops STARTING new units (their rows report `skipped`, the
 * same semantics as the action cap — retry targets, not failures).
 */
const REAP_PHASE_BUDGET_MS = 300_000;
/**
 * Only the newest N report files feed the streak counters (countReapBlocked)
 * — a streak needs 3 consecutive failures, so evidence older than N
 * operator-invoked sweeps is stale, and unbounded parsing grows with the
 * reap dir forever.
 */
const REAP_HISTORY_MAX_REPORTS = 200;

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
 * report files in reapDir (a dry-run attempts nothing, so its reports never
 * move the counter). Files are ordered by mtime — the report filename's
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

function countReapBlocked(reapDir: string): Map<string, { count: number; last: ReapFailure }> {
  const streaks = new Map<string, { count: number; last: ReapFailure }>();
  if (!existsSync(reapDir)) return streaks;
  const files = readdirSync(reapDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const p = join(reapDir, f);
      try {
        return { f, p, mtimeMs: statSync(p).mtimeMs };
      } catch {
        return undefined; // vanished between readdir and stat — skip it
      }
    })
    .filter((x): x is { f: string; p: string; mtimeMs: number } => x !== undefined)
    .sort((a, b) => (a.mtimeMs !== b.mtimeMs ? a.mtimeMs - b.mtimeMs : a.f < b.f ? -1 : 1))
    .slice(-REAP_HISTORY_MAX_REPORTS);
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
    records = deps.store.list();
  } catch (e) {
    // The store already names the offending file (INV-4). Propagate loudly —
    // a dropped record is a key nobody revokes.
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
    vms = await withTimeout(deps.driver.list(), LIST_TIMEOUT_MS, "driver.list()");
  } catch (e) {
    throw new SweepError(
      "list-unverified",
      `could not enumerate the provider VM list: ${(e as Error).message} — an uncounted population is never reaped`,
      "re-run once the provider list answers; check the driver/substrate by hand if it repeats",
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
    // Foreign by grammar, or shape-matching without the ownership tag: reported
    // for manual remediation, NEVER destroyed (INV-1 fail-safe — exedev's ls
    // reports no tag, so its boxes all land here).
    if (!RUN_ID_SHAPE.test(vm.name) || vm.tag !== SBX_OWNERSHIP_TAG) {
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
      // never reported is UNKNOWN, not young: report, never revoke (AC7).
      if (key.createdAt === undefined) {
        rows.push({ ...base, class: "key-age-unavailable", action: "report" });
      } else if (aged(key.createdAt)) {
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
    if (rec.closedAt !== undefined) continue; // closed ⇒ nothing to claim
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
  // the invoking cwd (teardown's harvest fetch target).
  const teardownDeps: TeardownDeps = {
    driver: deps.driver,
    store: deps.store,
    keyApi: deps.keyApi,
    requestId,
    gitCwd: process.cwd(),
    runsDir: deps.store.dir,
  };
  const credDeps: CredentialDeps = { keyApi: deps.keyApi, driver: deps.driver, store: deps.store, requestId };

  const tReap = Date.now();
  const actionTimeoutMs = deps.actionTimeoutMs ?? REAP_ACTION_TIMEOUT_MS;
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
          await withTimeout(teardownSandbox(teardownDeps, unit.id), actionTimeoutMs, `teardownSandbox(${unit.id})`);
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
          const current = (await withTimeout(deps.driver.list(unit.id), actionTimeoutMs, `driver.list(${unit.id})`))[0];
          // Store re-read AFTER the provider re-read — the order is the whole
          // point. INV-1 writes the record before the VM, so any VM the
          // provider recheck just confirmed has a record that predates this
          // later read and is guaranteed to be seen here; a createRun that
          // landed between classification and now is refused instead of
          // destroyed out from under its claim. A closed record still means
          // leaked: teardown destroys before closing, so closed + live ⇒ the
          // destroy never landed.
          let claimed: RunRecord | undefined;
          try {
            claimed = deps.store.get(unit.id);
          } catch {
            // absent/unreadable record — the classification-time verdict stands
          }
          if (current === undefined || !RUN_ID_SHAPE.test(current.name) || current.tag !== SBX_OWNERSHIP_TAG) {
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
          }
        } else if (unit.hash !== undefined) {
          executed.revoke.push(unit.id);
          // Full hash in memory only; the sbx- prefix re-assert happens inside
          // revokeHash (credentials.ts:429-435) — not reimplemented here.
          await withTimeout(revokeAndVerify(credDeps, unit.hash), actionTimeoutMs, `revokeAndVerify(${unit.id})`);
        }
      } catch (e) {
        const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
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
          remediation: scrub(err.remediation ?? "re-run the sweep after fixing the above — the other items were unaffected"),
        });
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
  for (let i = 1; ; i++) {
    report.reportFile = join(reapDir, name);
    try {
      writeFileSync(report.reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      name = `${stamp}-${i}.json`;
    }
  }

  return report;
}
