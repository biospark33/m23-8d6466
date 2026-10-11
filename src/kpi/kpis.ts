/**
 * A5 — the four v4 yield KPI computations and the snapshot assembly. Pure and
 * synchronous: every store read happens in the CLI script (leaf-1.2), which
 * hands `assembleSnapshot` pre-read inputs. The zod schemas and the
 * direction/pair tables live in ./schema.ts and are re-exported here so this
 * module keeps its locked API surface.
 *
 * Terminal/accepted semantics (PINNED): a terminal run is one whose record
 * carries `closedAt` (`close()` is the terminal transition,
 * src/providers/run-record.ts:1718, first-close-wins); an accepted run is a
 * terminal run whose `extensions.approval.state === "approved"` (the DF3.4
 * pre-PR approval gate's terminal states, run-record.ts:323-325). The box-exit
 * convention those sit beside is `classifyRunExit` / `InBoxExit`
 * (src/providers/cap-rejection.ts:75/:18) — a pure classifier that is not
 * persisted on the record, so acceptance is read from the approval extension,
 * never from an exit string. Named tests pin both.
 *
 * Denominator contract (story Technical Notes): a KPI whose denominator count
 * is 0 is `absent` with its source named — never 0, the same absent-not-0 law
 * as every missing source. Money is integer µ$ end-to-end (INV-A5-2); derived
 * money ratios are `Math.floor` with both raw totals in the payload.
 */
import type { z } from "zod";

import { CHARGED_CLASSES, parseFixOutcomeClass } from "../fixloop/escalation.ts";
import {
  KpiError,
  buildRunIdentities,
  joinSpend,
  type DimensionSchema,
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
 * KNOWN dispatch/fixloop taxonomy: the `FleetError` code literals constructed
 * across src/fleet (class at src/fleet/dispatch.ts:327; the dispatch log's
 * `code` field carries exactly these — every `refuse()` site logs its code,
 * dispatch.ts:1126) plus the `EscalationClass` union
 * (src/fixloop/escalation.ts:45). A dispatch-failure code outside this set is
 * an UNCLASSIFIED restart — the retry-rate counter's signal.
 */
const KNOWN_RESTART_CODES: ReadonlySet<string> = new Set<string>([
  // FleetError codes (src/fleet, collected 2026-10-11)
  "budget-group-exceeded", "fanout-not-found", "fleet-busy", "fleet-identity-unobservable",
  "fleet-lock-dir-mode", "fleet-lock-invalid-request", "fleet-lock-reentrant", "invalid-fanout-record",
  "invalid-list-timeout", "invalid-marker-deadline", "invalid-run-id", "invalid-step-output",
  "list-unavailable", "record-read-failed", "record-store-unreadable", "run-id-check-failed",
  "run-not-found",
  // EscalationClass union (src/fixloop/escalation.ts:45-60)
  "green", "ci-red", "ci-verdict-unavailable", "transient", "lead_failure", "approval-timed-out",
  "overflow", "orphaned", "dispatch-refused", "out-of-scope-diff", "scope-requires-privilege",
  "approval-rejected", "bot-response-to-fix", "fix-scope-missing",
]);

// ─── charged fix attempts (AC3) ──────────────────────────────────────────────

const fixAttemptIds = (parent: RunRecordLike): string[] => {
  const ids = parent.extensions?.fixLoop?.fixAttemptRunIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
};

/** Per-parent attempt counts — first-pass-accept needs the per-run charged split. */
function attemptCountsByParent(
  records: RunRecordLike[],
): Map<string, { charged: number; uncharged: number; unattributed: number }> {
  const byRunId = new Map(records.map((r) => [r.runId, r]));
  const perParent = new Map<string, { charged: number; uncharged: number; unattributed: number }>();
  for (const parent of records) {
    let charged = 0;
    let uncharged = 0;
    let unattributed = 0;
    for (const id of fixAttemptIds(parent)) {
      const target = byRunId.get(id);
      if (target === undefined) {
        unattributed++; // orphan ledger id — no outcome linkage
        continue;
      }
      const raw = target.extensions?.fixLoop?.fixOutcomeClass;
      const cls = parseFixOutcomeClass(raw);
      if (cls !== undefined) {
        if (CHARGED_CLASSES.has(cls)) charged++;
        else uncharged++; // valid EscalationClass, charging nothing
      } else if (typeof raw === "string") {
        unattributed++; // written class outside the EscalationClass union
      } else {
        uncharged++; // no written class yet: attempt not terminal — neither charged nor a signal
      }
    }
    perParent.set(parent.runId, { charged, uncharged, unattributed });
  }
  return perParent;
}

/**
 * Count fix attempts via the per-attempt `fixOutcomeClass` taxonomy: CHARGED =
 * {ci-red, ci-verdict-unavailable} (src/fixloop/escalation.ts:69). A class
 * string outside the EscalationClass union and a `fixAttemptRunIds` entry
 * resolving to no record are both UNATTRIBUTED — the TDI counter's signal
 * kind. A resolved attempt with no written class is uncharged (not terminal,
 * no defect signal yet).
 */
export function countChargedFixAttempts(
  records: RunRecordLike[],
): { charged: number; uncharged: number; unattributed: number } {
  const counts = { charged: 0, uncharged: 0, unattributed: 0 };
  for (const perParent of attemptCountsByParent(records).values()) {
    counts.charged += perParent.charged;
    counts.uncharged += perParent.uncharged;
    counts.unattributed += perParent.unattributed;
  }
  return counts;
}

// ─── retry stats ─────────────────────────────────────────────────────────────

export interface RetryStats {
  attemptedWorkKeys: number;
  retriedWorkKeys: number;
  unclassifiedRestarts: number;
  restartsTotal: number | "absent";
}

/**
 * A workKey is attempted once per record mapped to it plus once per dispatch
 * FAILURE entry whose requestId joined no record (a dispatch that never
 * produced a run — the log is the only witness); retried = more than one
 * attempt. Restarts are dispatch failure entries beyond a workKey's FIRST
 * attempt; a restart whose code sits outside KNOWN_RESTART_CODES is
 * unclassified. An absent dispatch log makes restartsTotal `absent`, never 0.
 */
export function computeRetryStats(
  identities: RunIdentity[],
  _records: RunRecordLike[],
  dispatch: DispatchLog,
): RetryStats {
  const attempts = new Map<string, number>();
  const bump = (key: string): void => {
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  };
  for (const id of identities) if (id.workKey !== null) bump(id.workKey);

  let restartsTotal: number | "absent" = "absent";
  let unclassifiedRestarts = 0;
  if (dispatch.status === "present") {
    const joinedRequestIds = new Set(
      identities.map((i) => i.requestId).filter((r): r is string => r !== null),
    );
    const failuresPerKey = new Map<string, DispatchEntry[]>();
    for (const e of dispatch.entries) {
      if (e.issueId === null) continue; // unmappable to a workKey — unattributed, not counted
      const key = `w:${e.issueId}`;
      const prior = failuresPerKey.get(key) ?? [];
      prior.push(e);
      failuresPerKey.set(key, prior);
      if (e.requestId === null || !joinedRequestIds.has(e.requestId)) bump(key);
    }
    restartsTotal = 0;
    for (const entries of failuresPerKey.values()) {
      for (let i = 1; i < entries.length; i++) {
        restartsTotal++;
        if (!KNOWN_RESTART_CODES.has((entries[i] as DispatchEntry).code)) unclassifiedRestarts++;
      }
    }
  }

  let retriedWorkKeys = 0;
  for (const n of attempts.values()) if (n > 1) retriedWorkKeys++;
  return { attemptedWorkKeys: attempts.size, retriedWorkKeys, unclassifiedRestarts, restartsTotal };
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
  const endMs = dayFloor(now);
  const startMs = dayFloor(new Date(now.getTime() - days * DAY_MS));
  const slug = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
    windowId: `${slug(startMs)}-${slug(endMs)}`,
  };
}

// ─── deterministic bytes + hash ──────────────────────────────────────────────

/** Deterministic key-sorted JSON — same data, same bytes, whatever the key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStable(value));
}

function sortForStable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortForStable);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortForStable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** sha256 over stableStringify, hex — the payload hash behind the retain documentId. */
export function payloadHashHex(payload: unknown): string {
  return new Bun.CryptoHasher("sha256").update(stableStringify(payload)).digest("hex");
}

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
  dispatch: DispatchLog;
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
  const retry = computeRetryStats(identities, input.records, input.dispatch);
  const spend = joinSpend(input.factorySpendRows, input.gatewayImport);
  const vetoes = countReverifyVetoes(input.audit);
  const terminal = input.records.filter(isTerminalRun);
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
  const unattributedCounter: CounterMetric = {
    name: COUNTER_PAIRS.tdi_proxy, value: fixCounts.unattributed, source: "run-records",
  };
  const tdi = guarded("tdi_proxy", tdiSources, () =>
    acceptedStoryKeys.size === 0
      ? absentKpi("tdi_proxy", tdiSources, "no accepted stories in window — denominator 0 is absent, never 0", unattributedCounter)
      : measuredKpi("tdi_proxy", tdiSources, (vetoes + fixCounts.charged) / acceptedStoryKeys.size, acceptedStoryKeys.size, unattributedCounter));

  // Cost-per-story: integer µ$ only — total is the raw sum of both ledgers,
  // per-story is floor(total/accepted), and both raw totals ride the payload
  // (spend.*) so the ratio is auditable without float money (INV-A5-2).
  const costSources = ["cost-ledger", ...(input.gatewayImport.status === "present" ? ["gateway-import"] : [])];
  const totalMicroUsd = spend.factory_micro_usd_total + (spend.gateway_micro_usd_total ?? 0);
  const prCount = countAcceptedPrs(input.records);
  const cost = guarded("cost_per_story", costSources, () =>
    acceptedStoryKeys.size === 0
      ? absentKpi("cost_per_story", costSources, "no accepted stories in window — denominator 0 is absent, never 0", {
          name: COUNTER_PAIRS.cost_per_story, value: "absent", source: "run-records",
          detail: "no accepted stories — cost per accepted PR unmeasurable",
        })
      : measuredKpi("cost_per_story", costSources, Math.floor(totalMicroUsd / acceptedStoryKeys.size), acceptedStoryKeys.size,
          prCount === 0
            ? { name: COUNTER_PAIRS.cost_per_story, value: "absent", source: "run-records", detail: "no accepted PRs in window" }
            : { name: COUNTER_PAIRS.cost_per_story, value: Math.floor(totalMicroUsd / prCount), source: "cost-ledger" }));

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

  // Retry-rate + unclassified-restart counter.
  const retrySources = ["run-records", "dispatch-log"];
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
