/**
 * A5 — the four v4 yield KPI computations and the snapshot assembly. Pure and
 * synchronous: every store read happens in the CLI script (leaf-1.2), which
 * hands `assembleSnapshot` pre-read inputs. The zod schemas and direction/pair
 * tables live in ./schema.ts, re-exported here to keep the locked API surface.
 *
 * Terminal/accepted semantics (PINNED): a terminal run is one whose record
 * carries `closedAt` (`close()` is the terminal transition, run-record.ts:1718,
 * first-close-wins); an accepted run is a terminal run whose
 * `extensions.approval.state === "approved"` (the DF3.4 pre-PR approval gate's
 * terminal states, run-record.ts:323-325). `classifyRunExit`/`InBoxExit`
 * (cap-rejection.ts:75/:18) is a pure classifier NOT persisted on the record —
 * acceptance is read from the approval extension, never an exit string; named
 * tests pin both.
 *
 * Denominator contract (story Technical Notes): a KPI whose denominator count
 * is 0 is `absent` with its source named — never 0, the same absent-not-0 law
 * as every missing source. Money is integer µ$ end-to-end (INV-A5-2); derived
 * money ratios use integer floor division with both raw totals in the payload.
 */
import type { z } from "zod";

import type { DimensionSchema } from "./dimensions.ts";
import {
  KpiError,
  attemptCountsByParent,
  buildRunIdentities,
  countChargedFixAttempts,
  guardedMicroUsd,
  joinSpend,
  type DispatchEntry,
  type DispatchLog,
  type FactorySpendRow,
  type GatewayImport,
  type RunIdentity,
  type RunRecordLike,
} from "./join.ts";
import {
  COUNTER_PAIRS,
  KPI_DIRECTIONS,
  KpiSnapshotSchema,
  type CounterMetric,
  type KpiName,
  type KpiObject,
  type KpiSnapshotPayload,
  type PerKpiFailure,
} from "./schema.ts";

// Re-exported so the locked module surface (leaf-1.2's import contract) is
// unchanged by the schema.ts split.
export {
  COUNTER_PAIRS,
  KPI_DIRECTIONS,
  KPI_NAMES,
  CounterMetricSchema,
  KpiObjectSchema,
  KpiSnapshotSchema,
  KpiValueSchema,
  PerKpiFailureSchema,
} from "./schema.ts";
// Locked surface: these were defined here pre-split — re-exported from join.ts.
export { countChargedFixAttempts, payloadHashHex, stableStringify } from "./join.ts";
export type {
  CounterMetric,
  KpiName,
  KpiObject,
  KpiSnapshotPayload,
  KpiValue,
  PerKpiFailure,
} from "./schema.ts";

// ─── the restart taxonomy (unclassified-restart counter) ─────────────────────

/**
 * KNOWN restart taxonomy, rebuilt from the REAL `refuse()` vocabulary
 * (round-1 F-002 — the prior set carried invented FleetError-style names that
 * appear in no refuse site, so the first real dispatch failure classified
 * unclassified). Every code below is grep-verified as a `refuse()` second-arg
 * literal that reaches `appendDispatchFailure` (the dispatch log's `code`
 * field carries exactly the refuse code — src/fleet/dispatch.ts:1126-1131):
 * dispatch/correlation: dispatch.ts:1326 dispatch-timeout, :1566
 * manifest-rejected, :2867 correlation-rejected, :2878 correlation-failed,
 * :2955 env-file-invalid, :4301 dispatch-refused | dispatch-failed; identity:
 * :2723 timeout-invalid, :2731 port-invalid, :2744 invalid-brief, :2796
 * invalid-request-id, :2972 run-id-not-minted, :3049 run-id-in-use, :3062
 * run-id-unmintable, :1603 roster-missing, :1621 roster-path-unsafe, :1702
 * roster-rejected, :3039 record-read-failed; budget/cap: :3340 no-ceiling,
 * :3377 resident-ceiling-unfundable, :3407 resident-cap-above-backstop, :3427
 * budget-exceeded, :3101 quota-intent-in-flight, :3130 headroom-failed, :3146
 * no-headroom, :3171 invalid-cap, fanout-primitive.ts:254 ledger-failed,
 * :268 admission-failed; provision/gates/delivery: :3752 provision-failed,
 * :3557 audit-store-unavailable, :4096 setup-gate-invalid, :4196
 * setup-gate-failed, :2402 expose-no-url, :1977 key-delivery-refused |
 * key-delivery-failed, :3447 ledger-failed; fixloop-side refuse vocabulary:
 * src/fixloop/feedback-run.ts:670 fix-context-invalid. Plus the
 * `EscalationClass` union (src/fixloop/escalation.ts:45-60, the fixOutcomeClass
 * side). A dispatch-failure code outside this set is an UNCLASSIFIED restart —
 * the retry-rate counter's signal.
 */
const KNOWN_RESTART_CODES: ReadonlySet<string> = new Set<string>([
  "dispatch-timeout", "manifest-rejected", "correlation-rejected", "correlation-failed",
  "env-file-invalid", "dispatch-refused", "dispatch-failed", "timeout-invalid", "port-invalid",
  "invalid-brief", "invalid-request-id", "run-id-not-minted", "run-id-in-use", "run-id-unmintable",
  "roster-missing", "roster-path-unsafe", "roster-rejected", "record-read-failed", "no-ceiling",
  "resident-ceiling-unfundable", "resident-cap-above-backstop", "budget-exceeded",
  "quota-intent-in-flight", "headroom-failed", "no-headroom", "invalid-cap", "ledger-failed",
  "admission-failed", "provision-failed", "audit-store-unavailable", "setup-gate-invalid",
  "setup-gate-failed", "expose-no-url", "key-delivery-refused", "key-delivery-failed",
  "fix-context-invalid",
  // EscalationClass union (src/fixloop/escalation.ts:45-60)
  "green", "ci-red", "ci-verdict-unavailable", "transient", "lead_failure", "approval-timed-out",
  "overflow", "orphaned", "out-of-scope-diff", "scope-requires-privilege", "approval-rejected",
  "bot-response-to-fix", "fix-scope-missing",
]);

// ─── charged fix attempts (AC3) — lives in ./join.ts; re-exported below to keep this module's locked API surface.

// ─── retry stats ─────────────────────────────────────────────────────────────

export interface RetryStats {
  attemptedWorkKeys: number;
  retriedWorkKeys: number;
  unclassifiedRestarts: number;
  restartsTotal: number | "absent";
}

/**
 * Correlation-unit attempt model (round-1 F-003/F-004): per workKey, an
 * ATTEMPT is one distinct correlation unit — a non-null requestId seen on the
 * records mapped to that key OR on a dispatch entry carrying it, plus one
 * synthetic unit per dispatch entry whose requestId is null (a dispatch that
 * never correlated — the log is its only witness). N records sharing one
 * requestId are ONE attempt, and a joined entry is the SAME unit as its
 * record — never double-bumped, never double-counted as a restart. A RESTART
 * is an IN-WINDOW dispatch entry whose per-key position in the FULL log
 * (store order = array order) is beyond that key's first FULL-log entry and
 * that did not join a record's requestId (R2-05 — a boundary-straddling
 * workKey must not lose its first in-window failure); a restart whose code
 * sits outside KNOWN_RESTART_CODES is unclassified. An absent dispatch log
 * makes restartsTotal `absent`, never 0. `window` absent → every entry is
 * in-window (the caller already filtered).
 */
export function computeRetryStats(
  identities: RunIdentity[],
  _records: RunRecordLike[],
  dispatch: DispatchLog,
  window?: Window,
): RetryStats {
  // workKey → the record-side requestIds (the unit identities a run proves).
  // Identities with workKey ≠ null always carry requestId ≠ null
  // (buildRunIdentities derives the workKey from that requestId's entry).
  const recordUnits = new Map<string, Set<string>>();
  for (const id of identities) {
    if (id.workKey === null || id.requestId === null) continue;
    const s = recordUnits.get(id.workKey);
    if (s === undefined) recordUnits.set(id.workKey, new Set([id.requestId]));
    else s.add(id.requestId);
  }
  const units = new Map<string, number>();
  for (const [key, s] of recordUnits) units.set(key, s.size);

  let restartsTotal: number | "absent" = "absent";
  let unclassifiedRestarts = 0;
  if (dispatch.status === "present") {
    restartsTotal = 0;
    // R2-05: the script's in-window rule (unparseable timestamps kept).
    const startMs = window === undefined ? Number.NEGATIVE_INFINITY : Date.parse(window.startUtc);
    const endMs = window === undefined ? Number.POSITIVE_INFINITY : Date.parse(window.endUtc);
    const inWindow = (e: DispatchEntry): boolean => {
      if (window === undefined) return true;
      const t = Date.parse(e.timestamp);
      return Number.isNaN(t) || (t >= startMs && t < endMs);
    };
    const entriesPerKey = new Map<string, DispatchEntry[]>();
    for (const e of dispatch.entries) {
      if (e.issueId === null) continue; // unmappable to a workKey — unattributed, not counted
      const key = `w:${e.issueId}`;
      const prior = entriesPerKey.get(key) ?? [];
      prior.push(e);
      entriesPerKey.set(key, prior);
    }
    for (const [key, entries] of entriesPerKey) {
      const recordIds = recordUnits.get(key);
      const seen = new Set<string>(recordIds ?? []);
      let synthetic = 0;
      for (const [i, e] of entries.entries()) {
        const joined = e.requestId !== null && (recordIds?.has(e.requestId) ?? false);
        if (!inWindow(e)) continue; // pre-window history: baseline only — never an in-window unit or restart
        if (e.requestId !== null) seen.add(e.requestId);
        else synthetic++; // one synthetic unit per null-requestId entry
        if (i > 0 && !joined) {
          restartsTotal++;
          if (!KNOWN_RESTART_CODES.has(e.code)) unclassifiedRestarts++;
        }
      }
      const unitCount = seen.size + synthetic;
      if (unitCount > 0) units.set(key, unitCount); // a pre-window-only key proves no in-window attempt
    }
  }

  let retriedWorkKeys = 0;
  for (const n of units.values()) if (n > 1) retriedWorkKeys++;
  return { attemptedWorkKeys: units.size, retriedWorkKeys, unclassifiedRestarts, restartsTotal };
}

// ─── window ──────────────────────────────────────────────────────────────────

export interface Window {
  startUtc: string;
  endUtc: string;
  windowId: string;
}

const WINDOW_SPEC_RE = /^([1-9]\d*)([dw])$/;
const DAY_MS = 86_400_000;

/**
 * `Nd` / `Nw` → [now−N, now] floored to UTC day boundaries; `windowId` is the
 * `YYYYMMDD-YYYYMMDD` bounds slug — same-day re-invocation yields the same
 * windowId (the idempotent-retain key), and the slug never derives from the
 * bare `--window` label (AC5 negative control). Garbage throws typed.
 */
export function parseWindow(spec: string, now: Date = new Date()): Window {
  const m = WINDOW_SPEC_RE.exec(spec);
  if (m === null) {
    throw new KpiError(
      "kpi-window-invalid",
      `window spec ${JSON.stringify(spec)} does not match Nd | Nw (e.g. "7d", "2w")`,
      "pass --window as a day- or week-count spec",
    );
  }
  const days = Number(m[1]) * (m[2] === "w" ? 7 : 1);
  const dayFloor = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  try {
    const endMs = dayFloor(now);
    const startMs = dayFloor(new Date(now.getTime() - days * DAY_MS));
    const slug = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
    return {
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(endMs).toISOString(),
      windowId: `${slug(startMs)}-${slug(endMs)}`,
    };
  } catch (e) {
    // A day count past the representable range surfaces as a bare RangeError
    // ("Invalid time value") from toISOString — retype it like every garbage
    // spec (F-018).
    if (e instanceof RangeError) {
      throw new KpiError(
        "kpi-window-invalid",
        `window spec ${JSON.stringify(spec)} spans beyond the representable date range`,
        "pass a smaller day- or week-count",
      );
    }
    throw e;
  }
}

// ─── deterministic bytes + hash ──────────────────────────────────────────────

// stableStringify/payloadHashHex live in ./join.ts (round-1: the duplicate-row
// coalescing there needs stableStringify) — re-exported to keep the locked API.

// ─── snapshot assembly ───────────────────────────────────────────────────────

/**
 * Per-run audit walk results as `walkAuditChain` returns them
 * (src/audit/chain.ts:726). Structural: a real `ChainReport` is assignable —
 * the KPI layer reads only `runs[*].hops["run-reverify"].detail.verdict`
 * (resolved hop 7 carries the bound ReverifyReport's verdict, chain.ts:1404).
 */
export interface AuditReportLike {
  runs: Record<string, { hops: Record<string, { status: string; detail?: unknown }> }>;
}

export type AuditInput = { status: "absent" } | { status: "present"; reports: AuditReportLike[] };

export interface SnapshotInput {
  window: Window;
  /** Records in-window, pre-filtered by the script. */
  records: RunRecordLike[];
  recordsSkipped: number | "absent";
  /** Records whose effective timestamp was unparseable — excluded from the window but COUNTED (F-009); "absent" when the records store itself is absent. */
  recordsUndated: number | "absent";
  /** True when the run-records store is wholly absent (script's runsDirAbsent) — the unattributed counter goes absent, never 0 (AC1). */
  recordsStoreAbsent: boolean;
  dispatch: DispatchLog;
  /** The FULL pre-window-filter dispatch log (R2-05) — the restart baseline reads store chronology. Falls back to `dispatch` when absent. */
  dispatchFull?: DispatchLog;
  factorySpendRows: FactorySpendRow[];
  gatewayImport: GatewayImport;
  dimensions: z.infer<typeof DimensionSchema>[];
  audit: AuditInput;
}

/** A reverify veto: the re-verifier's judgment said no — verdict !== "green" (run-completion.ts:491-494). */
function countReverifyVetoes(audit: AuditInput): number {
  if (audit.status === "absent") return 0;
  let vetoes = 0;
  for (const report of audit.reports) {
    for (const run of Object.values(report.runs)) {
      const hop = run.hops["run-reverify"];
      if (hop !== undefined && hop.status === "resolved") {
        const verdict = (hop.detail as { verdict?: unknown } | undefined)?.verdict;
        if (typeof verdict === "string" && verdict !== "green") vetoes++;
      }
    }
  }
  return vetoes;
}

/** PINNED: terminal = closedAt set (run-record.ts:1718). */
const isTerminalRun = (r: RunRecordLike): boolean => typeof r.closedAt === "string" && r.closedAt !== "";

/** PINNED: accepted = terminal AND approval.state === "approved" (run-record.ts:323-325). */
const isAcceptedRun = (r: RunRecordLike): boolean =>
  isTerminalRun(r) && r.extensions?.approval?.state === "approved";

/** Accepted PRs: distinct prUrl on records that also carry an approved approval extension. */
function countAcceptedPrs(records: RunRecordLike[]): number {
  const urls = new Set<string>();
  for (const r of records) {
    const prUrl = r.extensions?.pr?.prUrl;
    if (isAcceptedRun(r) && typeof prUrl === "string" && prUrl !== "") urls.add(prUrl);
  }
  return urls.size;
}

function absentKpi(name: KpiName, sources: string[], detail: string, counter: CounterMetric): KpiObject {
  return {
    name, direction: KPI_DIRECTIONS[name], sources,
    value: { status: "absent", source: sources[0] ?? name, detail }, counter,
  };
}

/** Integer floor division (F-020, INV-A5-2 no-float-arithmetic), sign-correct true floor in pure integer math (R2-04): JS `%` truncates toward zero, so the mathematical remainder is `((a % n) + n) % n` — floorDiv(-5, 2) = -3, not -2. */
const floorDiv = (total: number, n: number): number => {
  const rem = ((total % n) + n) % n;
  return (total - rem) / n;
};

function measuredKpi(
  name: KpiName, sources: string[], value: number, denominator: number, counter: CounterMetric,
): KpiObject {
  return {
    name, direction: KPI_DIRECTIONS[name], sources,
    value: { status: "measured", value, denominator, sources }, counter,
  };
}

/**
 * Build and VALIDATE the closed snapshot. The payload is a pure function of
 * the window's data — no snapshot_path, no wall-clock stamp, no
 * invocation-order field (AC5). A per-KPI computation failure lands in
 * `per_kpi_failures` with that KPI `absent` and its source named — a failed
 * KPI never zeroes the snapshot (Observability Contract). The final
 * `KpiSnapshotSchema.parse` is the write-time structural guard: an unpaired
 * KPI, a zero-filled counter, or a flipped direction refuses here.
 */
export function assembleSnapshot(input: SnapshotInput): KpiSnapshotPayload {
  const dispatchEntries: DispatchEntry[] = input.dispatch.status === "present" ? input.dispatch.entries : [];
  const identities = buildRunIdentities(input.records, dispatchEntries);
  const fixCounts = countChargedFixAttempts(input.records);
  const chargedByParent = attemptCountsByParent(input.records);
  const retry = computeRetryStats(identities, input.records, input.dispatchFull ?? input.dispatch, input.window);
  const spend = joinSpend(input.factorySpendRows, input.gatewayImport);
  const vetoes = countReverifyVetoes(input.audit);
  // F-015: records carrying the fix-attempt marker (extensions.fixLoop.fixRun
  // === "true", the mint-time marker at src/providers/run-record.ts:223) are
  // sub-runs of a workKey's fix loop, charged via fixAttemptRunIds — they are
  // NOT standalone terminal/accepted runs and never enter those denominators.
  const standaloneRecords = input.records.filter((r) => r.extensions?.fixLoop?.fixRun !== "true");
  const terminal = standaloneRecords.filter(isTerminalRun);
  const accepted = terminal.filter(isAcceptedRun);
  const acceptedRunIds = new Set(accepted.map((a) => a.runId));
  const acceptedStoryKeys = new Set(
    identities.filter((i) => i.workKey !== null && acceptedRunIds.has(i.runId)).map((i) => i.workKey as string),
  );
  const failures: PerKpiFailure[] = [];

  const guarded = (name: KpiName, sources: string[], build: () => KpiObject): KpiObject => {
    try {
      return build();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push({
        kpi: name,
        code: "kpi-computation-failed",
        message,
        remediation: "inspect the KPI's named source stores; the snapshot stays green with this KPI absent",
      });
      return absentKpi(name, sources, message, {
        name: COUNTER_PAIRS[name], value: "absent", source: sources[0] ?? name, detail: message,
      });
    }
  };

  // TDI-proxy: defect signals per accepted story. The A2 QA-findings component
  // is absent today and is TYPED by the escaped_defect_rate counter (decision
  // 3) — it contributes 0 to the numerator without asserting a measured-clean
  // window. Audit absent → fix signals only; the supplementary walk's absence
  // is visible because "audit-chain" is not named in sources.
  const tdiSources = ["run-records", ...(input.audit.status === "present" ? ["audit-chain"] : [])];
  const unattributedCounter: CounterMetric = input.recordsStoreAbsent
    ? {
        name: COUNTER_PAIRS.tdi_proxy, value: "absent", source: "run-records",
        detail: "run-records store wholly absent — unattributed count unmeasurable, never 0 (AC1)",
      }
    : { name: COUNTER_PAIRS.tdi_proxy, value: fixCounts.unattributed, source: "run-records" };
  const tdi = guarded("tdi_proxy", tdiSources, () =>
    acceptedStoryKeys.size === 0
      ? absentKpi("tdi_proxy", tdiSources, "no accepted stories in window — denominator 0 is absent, never 0", unattributedCounter)
      : measuredKpi("tdi_proxy", tdiSources, (vetoes + fixCounts.charged) / acceptedStoryKeys.size, acceptedStoryKeys.size, unattributedCounter));

  // Cost-per-story: integer µ$ only — total is the raw sum of both ledgers
  // with the gateway side counted at its MATCHED rows only (unmatched import
  // spend never enters a ratio; it stays visible in spend.gateway_micro_usd_total
  // and unmatched_gateway_rows), per-story is floor(total/accepted), and both
  // raw totals ride the payload (spend.*) so the ratio is auditable without
  // float money (INV-A5-2).
  const costSources = ["cost-ledger", ...(input.gatewayImport.status === "present" ? ["gateway-import"] : [])];
  const prCount = countAcceptedPrs(standaloneRecords);
  const cost = guarded("cost_per_story", costSources, () => {
    // R2-03: each ledger total is F-017-guarded; the cross-ledger SUM guards too — never round.
    const totalMicroUsd = guardedMicroUsd(
      spend.factory_micro_usd_total + (spend.gateway_matched_micro_usd ?? 0),
      "cost_per_story cross-ledger numerator",
    );
    return acceptedStoryKeys.size === 0
      ? absentKpi("cost_per_story", costSources, "no accepted stories in window — denominator 0 is absent, never 0", {
          name: COUNTER_PAIRS.cost_per_story, value: "absent", source: "run-records",
          detail: "no accepted stories — cost per accepted PR unmeasurable",
        })
      : measuredKpi("cost_per_story", costSources, floorDiv(totalMicroUsd, acceptedStoryKeys.size), acceptedStoryKeys.size,
          prCount === 0
            ? { name: COUNTER_PAIRS.cost_per_story, value: "absent", source: "run-records", detail: "no accepted PRs in window" }
            : { name: COUNTER_PAIRS.cost_per_story, value: floorDiv(totalMicroUsd, prCount), source: "cost-ledger" });
  });

  // First-pass-accept: accepted terminal runs whose fix-loop ledger holds ZERO
  // charged attempts, over terminal runs.
  const fpaSources = ["run-records"];
  const escapedDefectCounter: CounterMetric = {
    name: COUNTER_PAIRS.first_pass_accept, value: "absent", source: "a2-qa-findings",
    detail: "A2 QA findings store not landed (decision 3) — absent, never 0",
  };
  const firstPassNumerator = accepted.filter((a) => (chargedByParent.get(a.runId)?.charged ?? 0) === 0).length;
  const firstPass = guarded("first_pass_accept", fpaSources, () =>
    terminal.length === 0
      ? absentKpi("first_pass_accept", fpaSources, "no terminal runs in window — denominator 0 is absent, never 0", escapedDefectCounter)
      : measuredKpi("first_pass_accept", fpaSources, firstPassNumerator / terminal.length, terminal.length, escapedDefectCounter));

  // Retry-rate + unclassified-restart counter. The dispatch log is named a
  // source only when present (F-023) — an absent log means the rate was
  // measured from records alone, mirroring costSources/tdiSources.
  const retrySources = ["run-records", ...(input.dispatch.status === "present" ? ["dispatch-log"] : [])];
  const retryKpi = guarded("retry_rate", retrySources, () =>
    retry.attemptedWorkKeys === 0
      ? absentKpi("retry_rate", retrySources, "no attempted workKeys in window — denominator 0 is absent, never 0", retryCounter(retry))
      : measuredKpi("retry_rate", retrySources, retry.retriedWorkKeys / retry.attemptedWorkKeys, retry.attemptedWorkKeys, retryCounter(retry)));

  const payload = {
    schema: "qds.kpi-snapshot",
    schema_version: 1,
    window: { start: input.window.startUtc, end: input.window.endUtc, window_id: input.window.windowId },
    kpis: [tdi, cost, firstPass, retryKpi],
    spend,
    dimensions: input.dimensions,
    run_accounting: {
      records_in_window: input.records.length,
      records_skipped: input.recordsSkipped,
      records_undated: input.recordsUndated,
      terminal_runs: terminal.length,
      accepted_runs: accepted.length,
    },
    per_kpi_failures: failures,
  };
  return KpiSnapshotSchema.parse(payload);
}

function retryCounter(retry: RetryStats): CounterMetric {
  if (retry.restartsTotal === "absent") {
    return {
      name: "unclassified_restart_rate", value: "absent", source: "dispatch-log",
      detail: "no dispatch log — absent, never 0",
    };
  }
  if (retry.restartsTotal === 0) {
    return {
      name: "unclassified_restart_rate", value: "absent", source: "dispatch-log",
      detail: "restarts_total=0 — denominator 0 is absent, never 0",
    };
  }
  return {
    name: "unclassified_restart_rate",
    value: retry.unclassifiedRestarts / retry.restartsTotal,
    source: "dispatch-log",
    detail: `restarts_total=${retry.restartsTotal}`,
  };
}
