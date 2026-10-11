/**
 * A5 yield-KPI module tests — AC1–AC4 (leaf-1.1; CLI/e2e arms extend this
 * file in leaf-1.2).
 *
 * The G4 ledger, by named test: pairing refusal, zero-fill refusal,
 * render-vs-store guard, strict gateway-import money rows (float / unsafe /
 * unknown-field / keyless), direction literals, the four absence arms,
 * spend-join completeness in both import arms, charged-vs-uncharged fix
 * attempts, unattributed signals, denominator-0 absence, windowId and
 * payload-hash determinism, stableStringify determinism.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KpiError,
  absentDimension,
  buildRunIdentities,
  joinSpend,
  readDispatchLog,
  readGatewaySpendImport,
  readJsonlDimension,
  type DispatchEntry,
  type FactorySpendRow,
  type GatewayImport,
  type KpiErrorCode,
  type RunIdentity,
  type RunRecordLike,
} from "../../src/kpi/join.ts";
import {
  COUNTER_PAIRS,
  KPI_DIRECTIONS,
  KpiObjectSchema,
  KpiSnapshotSchema,
  CounterMetricSchema,
  assembleSnapshot,
  computeRetryStats,
  countChargedFixAttempts,
  parseWindow,
  payloadHashHex,
  stableStringify,
  type KpiObject,
  type SnapshotInput,
} from "../../src/kpi/kpis.ts";

const NOW = new Date("2026-10-08T12:34:56.000Z");

/** Typed-throw assertion: a wrong-typed or missing throw fails the test. */
const throwsKpi = (fn: () => unknown, code: KpiErrorCode): void => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(KpiError);
    expect((e as KpiError).code).toBe(code);
    return;
  }
  throw new Error(`expected KpiError(${code}) — no throw`);
};

/** Schema-refusal assertion: the parse must throw, carrying the fragment. */
const throwsSchema = (fn: () => unknown, fragment: string): void => {
  expect(fn).toThrow(fragment);
};

const rec = (runId: string, over: Partial<RunRecordLike> = {}): RunRecordLike => ({
  runId,
  createdAt: "2026-10-02T00:00:00.000Z",
  ...over,
});

const fixLoop = (fields: Record<string, unknown>): RunRecordLike["extensions"] => ({
  fixLoop: { schemaVersion: 1, ...fields },
});

const dispatchEntry = (over: Partial<DispatchEntry>): DispatchEntry => ({
  timestamp: "2026-10-03T01:00:00.000Z",
  repoSlug: "o/r",
  issueId: null,
  requestId: null,
  code: "fleet-busy",
  message: "m",
  ...over,
});

/** The rich seeded fixture: one approved parent with a charged fix attempt, one first-pass run, one open run. */
const richInput = (): SnapshotInput => ({
  window: parseWindow("7d", NOW),
  records: [
    rec("run-parent", {
      closedAt: "2026-10-03T00:00:00.000Z",
      requestId: "req-1",
      extensions: {
        approval: { schemaVersion: 2, state: "approved" },
        ...(fixLoop({ fixAttemptRunIds: ["run-fix1"] }) as RunRecordLike["extensions"]),
      },
    }),
    rec("run-fix1", { extensions: fixLoop({ fixOutcomeClass: "ci-red" }) }),
    rec("run-solo", {
      closedAt: "2026-10-04T00:00:00.000Z",
      requestId: "req-2",
      extensions: { approval: { schemaVersion: 2, state: "approved" } },
    }),
    rec("run-open", {}),
  ],
  recordsSkipped: 0,
  dispatch: {
    status: "present",
    entries: [
      dispatchEntry({ issueId: 1, requestId: "req-1" }),
      dispatchEntry({ issueId: 2, requestId: "req-2", timestamp: "2026-10-03T02:00:00.000Z" }),
      dispatchEntry({ issueId: 1, code: "invalid-run-id", timestamp: "2026-10-03T03:00:00.000Z" }),
    ],
  },
  factorySpendRows: [
    { runId: "run-parent", workKey: "w:1", microUsd: 1000, eventCount: 3 },
    { runId: "run-solo", workKey: "w:2", microUsd: 500, eventCount: 2 },
  ],
  gatewayImport: {
    status: "present",
    rows: [{ workKey: "w:1", runId: "run-parent", issueId: "1", botId: "home-bot", cost_micro_usd: 250 }],
  },
  dimensions: [
    absentDimension("j3-routing-log"),
    absentDimension("a2-qa-findings"),
    absentDimension("z2-observe-artifacts"),
  ],
  audit: {
    status: "present",
    reports: [
      {
        runs: {
          "run-parent": {
            hops: {
              "run-reverify": { status: "resolved", detail: { verdict: "red" } },
            },
          },
        },
      },
    ],
  },
});

const emptyInput = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  window: parseWindow("7d", NOW),
  records: [],
  recordsSkipped: "absent",
  dispatch: { status: "absent" },
  factorySpendRows: [],
  gatewayImport: { status: "absent" },
  dimensions: [],
  audit: { status: "absent" },
  ...over,
});

describe("parseWindow", () => {
  test("7d → UTC day-truncated bounds + windowId slug", () => {
    const w = parseWindow("7d", NOW);
    expect(w.startUtc).toBe("2026-10-01T00:00:00.000Z");
    expect(w.endUtc).toBe("2026-10-08T00:00:00.000Z");
    expect(w.windowId).toBe("20261001-20261008");
  });

  test("2w → 14 days", () => {
    expect(parseWindow("2w", NOW).startUtc).toBe("2026-09-24T00:00:00.000Z");
  });

  test("garbage specs → kpi-window-invalid", () => {
    for (const spec of ["7x", "month", "", "0d", "-3d", "d7"]) {
      throwsKpi(() => parseWindow(spec, NOW), "kpi-window-invalid");
    }
  });

  test("same UTC day → same windowId (idempotent-retain key)", () => {
    const early = parseWindow("7d", new Date("2026-10-08T00:00:01.000Z"));
    const late = parseWindow("7d", new Date("2026-10-08T23:59:59.000Z"));
    expect(early.windowId).toBe(late.windowId);
  });
});

describe("stableStringify + payloadHashHex", () => {
  test("key order irrelevant → identical bytes", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  test("array order preserved", () => {
    expect(stableStringify({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });
});

describe("gateway import reader (AC2 strict money)", () => {
  let dir: string;
  const write = (name: string, text: string): string => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-kpi-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const row = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ workKey: "w:1", runId: "run-a", issueId: null, botId: "home-bot", cost_micro_usd: 100, ...over });

  test("ENOENT → absent, never an error", () => {
    expect(readGatewaySpendImport(join(dir, "missing.jsonl"))).toEqual({ status: "absent" });
  });

  test("valid rows + blank lines tolerated → present", () => {
    const p = write("imp.jsonl", `${row()}\n\n${row({ cost_micro_usd: 50 })}\n`);
    const imp = readGatewaySpendImport(p);
    expect(imp.status).toBe("present");
    if (imp.status === "present") expect(imp.rows).toHaveLength(2);
  });

  test("float money refuses the strict parse", () => {
    const p = write("imp.jsonl", `${row({ cost_micro_usd: 1.5 })}\n`);
    throwsKpi(() => readGatewaySpendImport(p), "gateway-import-invalid");
  });

  test("cost_micro_usd beyond MAX_SAFE_INTEGER refuses", () => {
    const p = write("imp.jsonl", `${row({ cost_micro_usd: 2 ** 53 })}\n`);
    throwsKpi(() => readGatewaySpendImport(p), "gateway-import-invalid");
  });

  test("unknown extra field refuses (missing-and-extra-fail)", () => {
    const p = write("imp.jsonl", `${row({ tokenCount: 9000 })}\n`);
    throwsKpi(() => readGatewaySpendImport(p), "gateway-import-invalid");
  });

  test("row with neither runId nor issueId refuses (join key would lose a component)", () => {
    const p = write("imp.jsonl", `${row({ runId: null, issueId: null })}\n`);
    throwsKpi(() => readGatewaySpendImport(p), "gateway-import-invalid");
  });

  test("malformed JSON line throws, never skip-and-continue", () => {
    const p = write("imp.jsonl", `${row()}\n{not json}\n`);
    throwsKpi(() => readGatewaySpendImport(p), "gateway-import-invalid");
  });

  test("empty botId refuses", () => {
    const p = write("imp.jsonl", `${row({ botId: "" })}\n`);
    throwsKpi(() => readGatewaySpendImport(p), "gateway-import-invalid");
  });
});

describe("dispatch log reader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-kpi-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("ENOENT → absent", () => {
    expect(readDispatchLog(join(dir, "missing.jsonl"))).toEqual({ status: "absent" });
  });

  test("blank lines tolerated; issueId number/string/null all legal", () => {
    const p = join(dir, "log.jsonl");
    writeFileSync(
      p,
      `${[
        JSON.stringify({ timestamp: "t", repoSlug: "o/r", issueId: 1, requestId: "r1", code: "fleet-busy", message: "m" }),
        "",
        JSON.stringify({ timestamp: "t", repoSlug: null, issueId: "w:abc", requestId: null, code: "c", message: "m" }),
      ].join("\n")}\n`,
    );
    const log = readDispatchLog(p);
    expect(log.status).toBe("present");
    if (log.status === "present") expect(log.entries).toHaveLength(2);
  });

  test("malformed line → dispatch-log-invalid (the store exists; corruption is a fault)", () => {
    const p = join(dir, "log.jsonl");
    writeFileSync(p, "{oops\n");
    throwsKpi(() => readDispatchLog(p), "dispatch-log-invalid");
  });

  test("wrong-shape line (missing code) → dispatch-log-invalid", () => {
    const p = join(dir, "log.jsonl");
    writeFileSync(p, `${JSON.stringify({ timestamp: "t", repoSlug: null, issueId: null, requestId: null })}\n`);
    throwsKpi(() => readDispatchLog(p), "dispatch-log-invalid");
  });
});

describe("readJsonlDimension + absentDimension (AC4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-kpi-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("ENOENT → {source, status: absent}, never 0, never an error", () => {
    expect(readJsonlDimension("j3-routing-log", join(dir, "nope.jsonl"))).toEqual({
      source: "j3-routing-log",
      status: "absent",
    });
  });

  test("present → joined with non-blank line count", () => {
    const p = join(dir, "routing.jsonl");
    writeFileSync(p, '{"a":1}\n\n{"b":2}\n');
    expect(readJsonlDimension("j3-routing-log", p)).toEqual({ source: "j3-routing-log", status: "joined", count: 2 });
  });

  test("absentDimension types a named source", () => {
    expect(absentDimension("z2-observe-artifacts")).toEqual({ source: "z2-observe-artifacts", status: "absent" });
  });
});

describe("buildRunIdentities (requestId join)", () => {
  const entries: DispatchEntry[] = [
    dispatchEntry({ repoSlug: "o/r", issueId: 42, requestId: "req-1" }),
    dispatchEntry({ repoSlug: "o/other", issueId: 7, requestId: "req-2" }),
  ];

  test("record.requestId ↔ dispatch entry → workKey w:<issueId> + repoSlug", () => {
    const ids = buildRunIdentities([rec("run-a", { requestId: "req-1" })], entries);
    expect(ids).toEqual([{ runId: "run-a", workKey: "w:42", repoSlug: "o/r", requestId: "req-1" }]);
  });

  test("no dispatch match → workKey null (unattributed, never dropped)", () => {
    const ids = buildRunIdentities([rec("run-b", { requestId: "req-x" }), rec("run-c")], entries);
    expect(ids[0]?.workKey).toBeNull();
    expect(ids[1]?.workKey).toBeNull();
  });
});

describe("joinSpend (AC2 — DD-20 canonical key)", () => {
  const rows: FactorySpendRow[] = [
    { runId: "run-a", workKey: "w:1", microUsd: 1000, eventCount: 3 },
    { runId: "run-b", workKey: "w:2", microUsd: 500, eventCount: 2 },
  ];

  test("wholly-absent import → gateway fields null, missing_gateway_rows itself absent, spend_incomplete", () => {
    const j = joinSpend(rows, { status: "absent" });
    expect(j.gateway_row_count).toBeNull();
    expect(j.gateway_micro_usd_total).toBeNull();
    expect(j.missing_gateway_rows).toBeNull();
    expect(j.unmatched_gateway_rows).toBeNull();
    expect(j.matched_gateway_rows).toBe(0);
    expect(j.spend_incomplete).toBe(true);
    expect(j.factory_micro_usd_total).toBe(1500);
    expect(j.factory_event_count).toBe(5);
    expect(j.join_key).toBe("workKey+runId+botId");
  });

  test("full join on (workKey, runId) → complete, no flag", () => {
    const imp: GatewayImport = {
      status: "present",
      rows: [
        { workKey: "w:1", runId: "run-a", issueId: "1", botId: "home-bot", cost_micro_usd: 250 },
        { workKey: "w:2", runId: "run-b", issueId: "2", botId: "home-bot", cost_micro_usd: 100 },
      ],
    };
    const j = joinSpend(rows, imp);
    expect(j.gateway_micro_usd_total).toBe(350);
    expect(j.matched_gateway_rows).toBe(2);
    expect(j.unmatched_gateway_rows).toBe(0);
    expect(j.missing_gateway_rows).toBe(0);
    expect(j.spend_incomplete).toBe(false);
  });

  test("runId-null import row fills its key via issueId↔workKey correspondence (AC2 parenthetical)", () => {
    const imp: GatewayImport = {
      status: "present",
      rows: [{ workKey: "w:1", runId: null, issueId: "1", botId: "home-bot", cost_micro_usd: 75 }],
    };
    const j = joinSpend(rows, imp);
    expect(j.matched_gateway_rows).toBe(1);
    expect(j.missing_gateway_rows).toBe(1); // run-b still lacks its own import row
    expect(j.spend_incomplete).toBe(true);
  });

  test("wrong runId does not match even with the right workKey — no key component dropped", () => {
    const imp: GatewayImport = {
      status: "present",
      rows: [{ workKey: "w:1", runId: "run-zz", issueId: "1", botId: "home-bot", cost_micro_usd: 75 }],
    };
    const j = joinSpend(rows, imp);
    expect(j.matched_gateway_rows).toBe(0);
    expect(j.unmatched_gateway_rows).toBe(1);
    expect(j.missing_gateway_rows).toBe(2);
    expect(j.spend_incomplete).toBe(true);
  });

  test("partial import → missing_gateway_rows COUNTED (decision (1) default)", () => {
    const imp: GatewayImport = {
      status: "present",
      rows: [{ workKey: "w:1", runId: "run-a", issueId: "1", botId: "home-bot", cost_micro_usd: 250 }],
    };
    const j = joinSpend(rows, imp);
    expect(j.missing_gateway_rows).toBe(1);
    expect(j.spend_incomplete).toBe(true);
  });

  test("orphan gateway row (ADR-1 accepted-gap w:-only key) → unmatched, never dropped", () => {
    const imp: GatewayImport = {
      status: "present",
      rows: [
        { workKey: "w:1", runId: "run-a", issueId: "1", botId: "home-bot", cost_micro_usd: 250 },
        { workKey: "w:99", runId: null, issueId: "99", botId: "home-bot", cost_micro_usd: 10 },
      ],
    };
    const j = joinSpend(rows, imp);
    expect(j.unmatched_gateway_rows).toBe(1);
    expect(j.gateway_micro_usd_total).toBe(260);
  });
});

describe("countChargedFixAttempts (AC3 charged-ness)", () => {
  test("only CHARGED_CLASSES count; transient is uncharged", () => {
    const records = [
      rec("parent", { extensions: fixLoop({ fixAttemptRunIds: ["fix-1", "fix-2"] }) }),
      rec("fix-1", { extensions: fixLoop({ fixOutcomeClass: "ci-red" }) }),
      rec("fix-2", { extensions: fixLoop({ fixOutcomeClass: "transient" }) }),
    ];
    expect(countChargedFixAttempts(records)).toEqual({ charged: 1, uncharged: 1, unattributed: 0 });
  });

  test("ci-verdict-unavailable is charged too", () => {
    const records = [
      rec("parent", { extensions: fixLoop({ fixAttemptRunIds: ["fix-1"] }) }),
      rec("fix-1", { extensions: fixLoop({ fixOutcomeClass: "ci-verdict-unavailable" }) }),
    ];
    expect(countChargedFixAttempts(records).charged).toBe(1);
  });

  test("unattributed: class outside the EscalationClass union + orphan fixAttemptRunIds", () => {
    const records = [
      rec("parent", { extensions: fixLoop({ fixAttemptRunIds: ["fix-weird", "fix-orphan"] }) }),
      rec("fix-weird", { extensions: fixLoop({ fixOutcomeClass: "definitely-not-a-class" }) }),
      // fix-orphan resolves to no record
    ];
    expect(countChargedFixAttempts(records)).toEqual({ charged: 0, uncharged: 0, unattributed: 2 });
  });

  test("fix run with no written class yet → uncharged (not terminal, no defect signal)", () => {
    const records = [
      rec("parent", { extensions: fixLoop({ fixAttemptRunIds: ["fix-open"] }) }),
      rec("fix-open", { extensions: fixLoop({ fixContext: "{}" }) }),
    ];
    expect(countChargedFixAttempts(records)).toEqual({ charged: 0, uncharged: 1, unattributed: 0 });
  });
});

describe("computeRetryStats", () => {
  const identities: RunIdentity[] = [
    { runId: "r1", workKey: "w:1", repoSlug: "o/r", requestId: "req-1" },
    { runId: "r2", workKey: "w:1", repoSlug: "o/r", requestId: "req-2" },
    { runId: "r3", workKey: "w:2", repoSlug: "o/r", requestId: null },
  ];
  const records = [rec("r1", { requestId: "req-1" }), rec("r2", { requestId: "req-2" }), rec("r3")];

  test("attempted/retried from records + unjoined dispatch; restarts beyond first; unknown code unclassified", () => {
    const stats = computeRetryStats(identities, records, {
      status: "present",
      entries: [
        dispatchEntry({ issueId: 1, requestId: "req-1" }), // joined r1 — same attempt
        dispatchEntry({ issueId: 1, requestId: "req-2" }), // joined r2 — same attempt
        dispatchEntry({ issueId: 1, requestId: null, code: "mystery-crash" }), // unjoined → new attempt
        dispatchEntry({ issueId: 2, requestId: null, code: "mystery-crash" }), // unjoined → new attempt
      ],
    });
    expect(stats.attemptedWorkKeys).toBe(2);
    expect(stats.retriedWorkKeys).toBe(2);
    // w:1: 3 failure entries → restarts = 2 (2nd known, 3rd unknown); w:2: 1 entry → 0
    expect(stats.restartsTotal).toBe(2);
    expect(stats.unclassifiedRestarts).toBe(1);
  });

  test("absent dispatch log → restartsTotal absent, never 0", () => {
    const stats = computeRetryStats(identities, records, { status: "absent" });
    expect(stats.restartsTotal).toBe("absent");
    expect(stats.attemptedWorkKeys).toBe(2);
    expect(stats.retriedWorkKeys).toBe(1); // w:1 has r1+r2
  });
});

describe("counter + KPI object schemas (AC1/AC3 structural refusal)", () => {
  const measuredValue = { status: "measured", value: 1, denominator: 2, sources: ["run-records"] } as const;

  test("counter value 0 with source null refuses (the zero-fill signature)", () => {
    throwsSchema(
      () => CounterMetricSchema.parse({ name: "unattributed_signal_count", value: 0, source: null }),
      "zero-fill",
    );
  });

  test("absent counter with named source passes", () => {
    expect(
      CounterMetricSchema.parse({ name: "escaped_defect_rate", value: "absent", source: "a2-qa-findings" }),
    ).toBeTruthy();
  });

  test("KPI object without its counter refuses (the NFR-OBS-6 failure)", () => {
    throwsSchema(
      () =>
        KpiObjectSchema.parse({
          name: "tdi_proxy",
          direction: "down",
          sources: ["run-records"],
          value: measuredValue,
        }),
      "Required",
    );
  });

  test("counter with the WRONG pair name refuses", () => {
    throwsSchema(
      () =>
        KpiObjectSchema.parse({
          name: "tdi_proxy",
          direction: "down",
          sources: ["run-records"],
          value: measuredValue,
          counter: { name: "escaped_defect_rate", value: "absent", source: "a2-qa-findings" },
        }),
      "FR-LEARN-33",
    );
  });

  test("flipped direction refuses (AC3 negative control)", () => {
    throwsSchema(
      () =>
        KpiObjectSchema.parse({
          name: "first_pass_accept",
          direction: "down", // v4 says up
          sources: ["run-records"],
          value: measuredValue,
          counter: { name: "escaped_defect_rate", value: "absent", source: "a2-qa-findings" },
        }),
      "direction",
    );
  });

  test("every direction literal is pinned per KPI", () => {
    expect(KPI_DIRECTIONS).toEqual({
      tdi_proxy: "down",
      cost_per_story: "down",
      first_pass_accept: "up",
      retry_rate: "down",
    });
    expect(COUNTER_PAIRS).toEqual({
      tdi_proxy: "unattributed_signal_count",
      cost_per_story: "cost_per_accepted_pr",
      first_pass_accept: "escaped_defect_rate",
      retry_rate: "unclassified_restart_rate",
    });
  });
});

describe("assembleSnapshot — rich fixture", () => {
  const payload = () => assembleSnapshot(richInput());

  test("4/4 paired KPIs with canonical names + directions, schema-valid", () => {
    const p = payload();
    expect(KpiSnapshotSchema.safeParse(p).success).toBe(true);
    expect(p.kpis.map((k) => k.name).sort()).toEqual([
      "cost_per_story",
      "first_pass_accept",
      "retry_rate",
      "tdi_proxy",
    ]);
    for (const k of p.kpis) {
      expect(k.direction).toBe(KPI_DIRECTIONS[k.name]);
      expect(k.counter.name).toBe(COUNTER_PAIRS[k.name]);
    }
  });

  test("terminal = closedAt set; accepted = approval.state approved (PINNED semantics)", () => {
    const p = payload();
    expect(p.run_accounting.records_in_window).toBe(4);
    expect(p.run_accounting.terminal_runs).toBe(2); // run-parent, run-solo (run-open not closed)
    expect(p.run_accounting.accepted_runs).toBe(2);
  });

  test("tdi_proxy = (reverify vetoes + charged fix attempts) / accepted stories", () => {
    const tdi = payload().kpis.find((k) => k.name === "tdi_proxy") as KpiObject;
    expect(tdi.value).toEqual({
      status: "measured",
      value: 1, // 1 veto + 1 charged attempt over 2 accepted stories
      denominator: 2,
      sources: ["run-records", "audit-chain"],
    });
    expect(tdi.counter).toEqual({ name: "unattributed_signal_count", value: 0, source: "run-records" });
  });

  test("cost_per_story = integer µ$ floor over BOTH ledgers / accepted stories", () => {
    const cost = payload().kpis.find((k) => k.name === "cost_per_story") as KpiObject;
    expect(cost.value).toEqual({
      status: "measured",
      value: 875, // (1500 factory + 250 gateway) / 2
      denominator: 2,
      sources: ["cost-ledger", "gateway-import"],
    });
    const p = payload();
    expect(p.spend.factory_micro_usd_total).toBe(1500);
    expect(p.spend.gateway_micro_usd_total).toBe(250);
    expect(p.spend.missing_gateway_rows).toBe(1); // run-solo has no import row → partial import
    expect(p.spend.spend_incomplete).toBe(true);
  });

  test("first_pass_accept: accepted terminal run with a charged attempt is NOT first-pass", () => {
    const fpa = payload().kpis.find((k) => k.name === "first_pass_accept") as KpiObject;
    expect(fpa.value).toEqual({
      status: "measured",
      value: 0.5, // run-solo only; run-parent carries the ci-red attempt
      denominator: 2,
      sources: ["run-records"],
    });
    expect(fpa.counter).toEqual({
      name: "escaped_defect_rate",
      value: "absent",
      source: "a2-qa-findings",
      detail: "A2 QA findings store not landed (decision 3) — absent, never 0",
    });
  });

  test("retry_rate from records + dispatch; restart counter measured", () => {
    const retry = payload().kpis.find((k) => k.name === "retry_rate") as KpiObject;
    expect(retry.value).toEqual({
      status: "measured",
      value: 0.5, // w:1 retried (parent + unjoined null-requestId entry), w:2 single
      denominator: 2,
      sources: ["run-records", "dispatch-log"],
    });
    expect(retry.counter.name).toBe("unclassified_restart_rate");
    expect(retry.counter.value).toBe(0); // 1 restart, classified (invalid-run-id)
    expect(retry.counter.source).toBe("dispatch-log");
  });
});

describe("assembleSnapshot — determinism (AC5 payload purity)", () => {
  test("same window data → byte-identical payload + same hash", () => {
    expect(payloadHashHex(assembleSnapshot(richInput()))).toBe(payloadHashHex(assembleSnapshot(richInput())));
  });

  test("same bounds, different data → same windowId, different payload hash (new documentId)", () => {
    const a = assembleSnapshot(richInput());
    const mutated = richInput();
    mutated.records = [...mutated.records, rec("run-extra", { closedAt: "2026-10-05T00:00:00.000Z" })];
    const b = assembleSnapshot(mutated);
    expect(a.window.window_id).toBe(b.window.window_id);
    expect(payloadHashHex(a)).not.toBe(payloadHashHex(b));
  });

  test("payload carries no snapshot_path / wall-clock / invocation-order field", () => {
    const p = assembleSnapshot(richInput()) as unknown as Record<string, unknown>;
    for (const banned of ["snapshot_path", "generatedAt", "writtenAt", "invocation", "duration_ms"]) {
      expect(banned in p).toBe(false);
    }
  });
});

describe("assembleSnapshot — absence arms (AC4: absence is typed, never 0, never an error)", () => {
  test("routing-log absent → dimension {source, status:'absent'}, snapshot green", () => {
    const p = assembleSnapshot(emptyInput({ dimensions: [absentDimension("j3-routing-log")] }));
    expect(p.dimensions).toEqual([{ source: "j3-routing-log", status: "absent" }]);
  });

  test("QA findings absent → escaped_defect_rate counter absent with named source", () => {
    const p = assembleSnapshot(emptyInput({ dimensions: [absentDimension("a2-qa-findings")] }));
    const fpa = p.kpis.find((k) => k.name === "first_pass_accept") as KpiObject;
    expect(fpa.counter.value).toBe("absent");
    expect(fpa.counter.source).toBe("a2-qa-findings");
  });

  test("observe artifacts absent → typed absent with named source", () => {
    const p = assembleSnapshot(emptyInput({ dimensions: [absentDimension("z2-observe-artifacts")] }));
    expect(p.dimensions).toEqual([{ source: "z2-observe-artifacts", status: "absent" }]);
  });

  test("gateway import wholly absent → degraded factory-only curve green, spend_incomplete, gateway fields null", () => {
    const p = assembleSnapshot(emptyInput());
    expect(p.spend.spend_incomplete).toBe(true);
    expect(p.spend.gateway_row_count).toBeNull();
    expect(p.spend.missing_gateway_rows).toBeNull();
    expect(KpiSnapshotSchema.safeParse(p).success).toBe(true);
    const cost = p.kpis.find((k) => k.name === "cost_per_story") as KpiObject;
    expect(cost.value.status).toBe("absent"); // zero accepted stories — denominator 0
    expect(cost.sources).toEqual(["cost-ledger"]); // gateway not named as a source when absent
  });

  test("empty window → every KPI absent (denominator 0 is absent, never 0)", () => {
    const p = assembleSnapshot(emptyInput());
    for (const k of p.kpis) {
      expect(k.value.status).toBe("absent");
      expect(k.counter.source).toBeTruthy(); // source named on every absent arm
    }
    expect(p.per_kpi_failures).toEqual([]);
  });

  test("partial import on an otherwise-empty window still counts missing rows", () => {
    const p = assembleSnapshot(
      emptyInput({
        factorySpendRows: [{ runId: "run-a", workKey: "w:1", microUsd: 100, eventCount: 1 }],
        gatewayImport: { status: "present", rows: [] },
      }),
    );
    expect(p.spend.missing_gateway_rows).toBe(1);
    expect(p.spend.spend_incomplete).toBe(true);
  });
});

describe("render-vs-store guard (AC1 third negative control)", () => {
  test("assembled payload validates; tampered copies refuse", () => {
    const p = assembleSnapshot(richInput());
    expect(KpiSnapshotSchema.safeParse(p).success).toBe(true);

    const noCounter = structuredClone(p);
    // biome-ignore lint/performance/noDelete: removing the pair is the tamper under test
    delete (noCounter.kpis[0] as Partial<KpiObject>).counter;
    expect(KpiSnapshotSchema.safeParse(noCounter).success).toBe(false);

    const unknownField = { ...p, render_hint: "looks great" } as unknown;
    expect(KpiSnapshotSchema.safeParse(unknownField).success).toBe(false);

    const flipped = structuredClone(p);
    (flipped.kpis[2] as KpiObject).direction = "down"; // first_pass_accept is "up"
    expect(KpiSnapshotSchema.safeParse(flipped).success).toBe(false);

    const zeroFill = structuredClone(p);
    (zeroFill.kpis[2] as KpiObject).counter = {
      name: "escaped_defect_rate",
      value: 0,
      source: null,
      detail: "rendered but never measured",
    };
    expect(KpiSnapshotSchema.safeParse(zeroFill).success).toBe(false);
  });
});

// ─── leaf-1.2: CLI + e2e arms (scripts/qds-kpi.ts) ────────────────────────────
//
// The G4 ledger, by named test: e2e seeded arm (both-ledger provenance), e2e
// empty-imports arm (spend_incomplete, degraded factory-only green), append-only
// second invocation (first snapshot byte-identical, 0600/0700 posture),
// idempotent retain (same data → same documentId; mutated → new; env absent →
// no call), same-ms collision refusal, --help cron line, usage exits 2,
// store-absent arms (never creates ledger/runs), ledger-absent + import
// (every import row unmatched), repoSlug derivation (unit + git remote).

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { CostLedger } from "../../src/providers/cost-ledger.ts";
import { repoSlugFromRemoteUrl } from "../../scripts/qds-kpi.ts";

const KPI_CLI = join(process.cwd(), "scripts", "qds-kpi.ts");
const T0 = new Date("2026-10-08T12:34:56.789Z"); // frozen clock → window 20261001-20261008
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Child env: the parent's env minus every var that would pin a QDS path or gate. */
function childEnv(over: Record<string, string> = {}): Record<string, string> {
  const {
    QDS_RUNS_DIR, QDS_COST_LEDGER_FILE, QDS_AUDIT_DB, QDS_REPO_SLUG, QDS_KPI_NOW,
    QDS_KPI_RETAIN_CAPTURE, HINDSIGHT_BASE_URL, HINDSIGHT_BEARER_TOKEN, HINDSIGHT_API_KEY,
    NODE_ENV, ...rest
  } = process.env;
  void QDS_RUNS_DIR; void QDS_COST_LEDGER_FILE; void QDS_AUDIT_DB; void QDS_REPO_SLUG;
  void QDS_KPI_NOW; void QDS_KPI_RETAIN_CAPTURE; void HINDSIGHT_BASE_URL;
  void HINDSIGHT_BEARER_TOKEN; void HINDSIGHT_API_KEY; void NODE_ENV;
  return { ...(rest as Record<string, string>), ...over };
}

const runKpi = (args: string[], opts: SpawnSyncOptions = {}): ReturnType<typeof spawnSync> =>
  spawnSync(KPI_CLI, args, { timeout: 30_000, ...opts });

/** stdout JSON log lines, parsed — the observability contract's surface. */
const logLines = (res: ReturnType<typeof spawnSync>): Record<string, unknown>[] =>
  res.stdout.toString().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
const obsLine = (res: ReturnType<typeof spawnSync>): Record<string, unknown> => {
  const found = logLines(res).find((l) => l.operation === "kpi-snapshot-written");
  if (found === undefined) throw new Error(`no kpi-snapshot-written line in:\n${res.stdout.toString()}`);
  return found;
};

interface SeededSandbox {
  root: string;
  runsDir: string;
  snapshotsDir: string;
  importPath: string;
}

/**
 * The e2e fixture: one approved parent (charged ci-red fix attempt + PR), one
 * first-pass accepted run, one open run, a ledger with two priced rows, a
 * dispatch log joining both requestIds, and (optionally) a 1-row gateway import.
 */
function seedSandbox(root: string, now: Date, withImport: boolean): SeededSandbox {
  const sandbox = join(root, ".sandbox");
  mkdirSync(sandbox, { recursive: true, mode: 0o700 });
  const runsDir = join(sandbox, "runs");
  const snapshotsDir = join(sandbox, "kpi-snapshots");
  const store = new RunRecordStore({ dir: runsDir, create: true });
  const ago = (d: number, h = 0): Date => new Date(now.getTime() - d * DAY + h * HOUR);
  store.create("qds-kpi-parent1", ago(2));
  store.set("qds-kpi-parent1", {
    requestId: "req-kpi-1",
    extensions: {
      approval: { state: "approved" },
      pr: { prUrl: "https://github.com/o/r/pull/7", prNumber: 7 },
      fixLoop: { fixAttemptRunIds: ["qds-kpi-fix1"] },
    },
  });
  store.close("qds-kpi-parent1", ago(2, 1));
  store.create("qds-kpi-fix1", ago(2, 2));
  store.set("qds-kpi-fix1", { extensions: { fixLoop: { fixOutcomeClass: "ci-red" } } });
  store.create("qds-kpi-solo1", ago(3));
  store.set("qds-kpi-solo1", {
    requestId: "req-kpi-2",
    extensions: { approval: { state: "approved" }, pr: { prUrl: "https://github.com/o/r/pull/8", prNumber: 8 } },
  });
  store.close("qds-kpi-solo1", ago(3, 1));
  store.create("qds-kpi-open1", ago(1));

  const ledger = new CostLedger({
    path: join(sandbox, "cost-ledger.db"),
    config: { defaultCapMicroUsd: 5_000_000 },
    readRunRecord: () => ({ keyHash: "kpi-hash", limitMicroUsd: 50_000_000, createdAt: "2026-10-01T00:00:00Z" }),
  });
  const ev = (costUsd: number, ts: string) => ({
    agentId: "lead-agent", model: "kpi/model", inputTokens: 10, outputTokens: 5, costUsd, durationMs: 0, timestamp: ts,
  });
  ledger.ingestCostEvent(ev(0.001, ago(2, 0).toISOString()), { runId: "qds-kpi-parent1", repoSlug: "o/r", issueId: "1", requestId: "req-kpi-1", role: "lead", invocationSeq: 0 });
  ledger.ingestCostEvent(ev(0.0005, ago(3, 0).toISOString()), { runId: "qds-kpi-solo1", repoSlug: "o/r", issueId: "2", requestId: "req-kpi-2", role: "lead", invocationSeq: 0 });
  ledger.close();

  writeFileSync(
    join(sandbox, "dispatch-log.jsonl"),
    `${JSON.stringify({ timestamp: ago(2).toISOString(), repoSlug: "o/r", issueId: 1, requestId: "req-kpi-1", code: "fleet-busy", message: "m" })}\n${JSON.stringify({ timestamp: ago(3).toISOString(), repoSlug: "o/r", issueId: 2, requestId: "req-kpi-2", code: "fleet-busy", message: "m" })}\n`,
  );
  writeFileSync(join(sandbox, "routing-log.jsonl"), `${JSON.stringify({ runId: "qds-kpi-parent1" })}\n`);
  mkdirSync(join(sandbox, "imports"), { recursive: true, mode: 0o700 });
  const importPath = join(sandbox, "imports", "gateway-spend-20261001-20261008.jsonl");
  if (withImport) {
    writeFileSync(importPath, `${JSON.stringify({ workKey: "w:1", runId: "qds-kpi-parent1", issueId: "1", botId: "home-bot", cost_micro_usd: 250 })}\n`);
  }
  return { root, runsDir, snapshotsDir, importPath };
}

describe("qds-kpi CLI — e2e seeded arm (both import arms, AC5 + e2e slice)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qds-kpi-e2e-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("seeded import arm: exit 0, 4/4 paired KPIs with directions, both-ledger provenance, typed absences, observability line", () => {
    seedSandbox(root, T0, true);
    const res = runKpi(["--window", "7d"], { cwd: root, env: childEnv({ QDS_KPI_NOW: T0.toISOString() }) });
    expect(res.status).toBe(0);
    const files = readdirSync(join(root, ".sandbox", "kpi-snapshots"));
    expect(files).toHaveLength(1);
    const snapPath = join(root, ".sandbox", "kpi-snapshots", files[0] as string);
    expect(statSync(snapPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, ".sandbox", "kpi-snapshots")).mode & 0o777).toBe(0o700);
    const p = JSON.parse(readFileSync(snapPath, "utf8")) as ReturnType<typeof assembleSnapshot>;
    expect(p.window.window_id).toBe("20261001-20261008");
    expect(p.kpis.map((k) => [k.name, k.direction])).toEqual([
      ["tdi_proxy", "down"], ["cost_per_story", "down"], ["first_pass_accept", "up"], ["retry_rate", "down"],
    ]);
    for (const k of p.kpis) expect(k.counter.name).toBe(COUNTER_PAIRS[k.name]);
    expect(p.run_accounting).toEqual({ records_in_window: 4, records_skipped: 0, terminal_runs: 2, accepted_runs: 2 });
    expect(p.spend).toMatchObject({
      factory_micro_usd_total: 1500, factory_event_count: 2,
      gateway_micro_usd_total: 250, gateway_row_count: 1,
      matched_gateway_rows: 1, missing_gateway_rows: 1, spend_incomplete: true,
    });
    const dims = new Map(p.dimensions.map((d) => [d.source, d]));
    expect(dims.get("j3-routing-log")).toEqual({ source: "j3-routing-log", status: "joined", count: 1 });
    expect(dims.get("a2-qa-findings")).toEqual({ source: "a2-qa-findings", status: "absent" });
    expect(dims.get("z2-observe-artifacts")).toEqual({ source: "z2-observe-artifacts", status: "absent" });
    const line = obsLine(res);
    expect(line.snapshot_path).toBe(join(".sandbox", "kpi-snapshots", files[0] as string)); // path as resolved from cwd
    expect(line.spend_incomplete).toBe(true);
    expect(line.missing_gateway_rows).toBe(1);
    expect(line.dimensions_present).toEqual(["j3-routing-log"]);
    expect(line.kpis).toBe(4);
    expect(line.pairs).toBe(4);
    expect(typeof line.duration_ms).toBe("number");
    expect(line.factory_ledger_absent).toBeUndefined();
  });

  test("empty-imports arm: spend_incomplete true, gateway fields null, degraded factory-only curve green, exit 0", () => {
    seedSandbox(root, T0, false);
    const res = runKpi(["--window", "7d"], { cwd: root, env: childEnv({ QDS_KPI_NOW: T0.toISOString() }) });
    expect(res.status).toBe(0);
    const files = readdirSync(join(root, ".sandbox", "kpi-snapshots"));
    const p = JSON.parse(readFileSync(join(root, ".sandbox", "kpi-snapshots", files[0] as string), "utf8")) as ReturnType<typeof assembleSnapshot>;
    expect(p.spend.spend_incomplete).toBe(true);
    expect(p.spend.gateway_micro_usd_total).toBeNull();
    expect(p.spend.gateway_row_count).toBeNull();
    expect(p.spend.missing_gateway_rows).toBeNull();
    const cost = p.kpis.find((k) => k.name === "cost_per_story");
    expect(cost?.value).toMatchObject({ status: "measured", value: 750, denominator: 2 });
    expect(cost?.sources).toEqual(["cost-ledger"]); // degraded default names only the ledger it has
    expect(obsLine(res).spend_incomplete).toBe(true);
  });
});

describe("qds-kpi CLI — append-only posture (AC5)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qds-kpi-append-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("second invocation writes a NEW snapshot; the first is byte-identical, mtime untouched, 0600", () => {
    seedSandbox(root, new Date(), false); // real clock: two runs land different filenames
    const env = childEnv();
    const first = runKpi(["--window", "7d"], { cwd: root, env });
    expect(first.status).toBe(0);
    const dir = join(root, ".sandbox", "kpi-snapshots");
    const firstFile = readdirSync(dir)[0] as string;
    const firstPath = join(dir, firstFile);
    const firstBytes = readFileSync(firstPath);
    const firstMtime = statSync(firstPath).mtimeMs;
    const second = runKpi(["--window", "7d"], { cwd: root, env });
    expect(second.status).toBe(0);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files[1]).not.toBe(firstFile);
    expect(readFileSync(firstPath).equals(firstBytes)).toBe(true);
    expect(statSync(firstPath).mtimeMs).toBe(firstMtime);
    expect(statSync(join(dir, files[1] as string)).mode & 0o777).toBe(0o600);
  });

  test("same-ms collision: pre-existing target filename → exit 1 kpi-snapshot-exists, bytes unchanged, no second file", () => {
    seedSandbox(root, T0, true);
    const dir = join(root, ".sandbox", "kpi-snapshots");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${T0.toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(target, "PRE-EXISTING\n");
    const res = runKpi(["--window", "7d"], { cwd: root, env: childEnv({ QDS_KPI_NOW: T0.toISOString() }) });
    expect(res.status).toBe(1);
    expect(res.stdout.toString()).toContain("kpi-snapshot-exists");
    expect(readFileSync(target, "utf8")).toBe("PRE-EXISTING\n");
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe("qds-kpi CLI — idempotent retain (AC5, capture seam)", () => {
  let root: string;
  let capturePath: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qds-kpi-retain-"));
    capturePath = join(root, "retain-capture.jsonl");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const retainEnv = (): Record<string, string> => ({
    QDS_KPI_NOW: T0.toISOString(),
    HINDSIGHT_BASE_URL: "http://hindsight.invalid",
    HINDSIGHT_BEARER_TOKEN: "kpi-test-token",
    QDS_KPI_RETAIN_CAPTURE: capturePath,
  });
  const captureLines = (): Record<string, unknown>[] =>
    readFileSync(capturePath, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);

  test("two invocations over unchanged window data → SAME documentId, replace mode, identical content hash", () => {
    seedSandbox(root, T0, true);
    // The frozen clock pins the window; each invocation gets its own snapshots
    // dir so the same-ms filename guard never masks the retain under test.
    for (const snapDir of ["snap-a", "snap-b"]) {
      const res = runKpi(["--window", "7d", "--repo", "qds/demo", "--snapshots-dir", join(root, snapDir)], { cwd: root, env: childEnv(retainEnv()) });
      expect(res.status).toBe(0);
    }
    const lines = captureLines();
    expect(lines).toHaveLength(2);
    const documentId = lines[0]?.documentId as string;
    expect(documentId).toMatch(/^kpi-snapshot-20261001-20261008-[0-9a-f]{12}$/);
    expect(lines[1]?.documentId).toBe(documentId);
    expect(lines[1]?.content_sha256).toBe(lines[0]?.content_sha256);
    expect(lines[0]?.bankId).toBe("qds-demo"); // provisioned-family resolution ran for real
    const meta = lines[0]?.metadata as Record<string, unknown>;
    expect(meta.updateMode).toBe("replace");
    expect(meta.tags).toEqual(["kpi-snapshot", "20261001-20261008"]);
    // The documentId IS the payload hash fold — the tamper-alarm-unreachable proof.
    expect(documentId).toBe(`kpi-snapshot-20261001-20261008-${String(lines[0]?.content_sha256).slice(0, 12)}`);
  });

  test("mutated window data under the same bounds → NEW documentId, never the same doc", () => {
    seedSandbox(root, T0, true);
    runKpi(["--window", "7d", "--repo", "qds/demo", "--snapshots-dir", join(root, "snap-c")], { cwd: root, env: childEnv(retainEnv()) });
    const store = new RunRecordStore({ dir: join(root, ".sandbox", "runs"), create: true });
    store.create("qds-kpi-extra1", new Date(T0.getTime() - 1 * DAY));
    store.set("qds-kpi-extra1", { extensions: { approval: { state: "approved" } } });
    store.close("qds-kpi-extra1", new Date(T0.getTime() - 1 * DAY + HOUR));
    const res = runKpi(["--window", "7d", "--repo", "qds/demo", "--snapshots-dir", join(root, "snap-d")], { cwd: root, env: childEnv(retainEnv()) });
    expect(res.status).toBe(0);
    const lines = captureLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]?.documentId).not.toBe(lines[0]?.documentId);
  });

  test("env gate absent → no retain call at all (no capture file), skip line, exit 0", () => {
    seedSandbox(root, T0, true);
    const res = runKpi(["--window", "7d", "--repo", "qds/demo"], { cwd: root, env: childEnv({ QDS_KPI_NOW: T0.toISOString(), QDS_KPI_RETAIN_CAPTURE: capturePath }) });
    expect(res.status).toBe(0);
    expect(() => statSync(capturePath)).toThrow();
    const skip = logLines(res).find((l) => l.operation === "kpi-retain");
    expect((skip?.error as Record<string, unknown>)?.code).toBe("retain-skipped");
  });

  test("service unreachable → retain failure is a skip line, never a failed snapshot", () => {
    seedSandbox(root, T0, true);
    const res = runKpi(["--window", "7d", "--repo", "qds/demo"], {
      cwd: root,
      env: childEnv({ QDS_KPI_NOW: T0.toISOString(), HINDSIGHT_BASE_URL: "http://127.0.0.1:9", HINDSIGHT_BEARER_TOKEN: "t" }),
    });
    expect(res.status).toBe(0);
    expect(readdirSync(join(root, ".sandbox", "kpi-snapshots"))).toHaveLength(1);
    const skip = logLines(res).find((l) => l.operation === "kpi-retain");
    expect(["retain-failed", "retain-timeout"]).toContain(String((skip?.error as Record<string, unknown>)?.code));
  });
});

describe("qds-kpi CLI — usage surface", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qds-kpi-usage-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("--help → exit 0, usage carries the documented cron line", () => {
    const res = runKpi(["--help"], { cwd: root, env: childEnv() });
    expect(res.status).toBe(0);
    expect(res.stdout.toString()).toContain("Usage: qds-kpi");
    expect(res.stdout.toString()).toContain("cron");
    expect(res.stdout.toString()).toContain("--window 7d");
  });

  test("unknown flag → exit 2 kpi-flag-invalid", () => {
    const res = runKpi(["--window", "7d", "--bogus", "x"], { cwd: root, env: childEnv() });
    expect(res.status).toBe(2);
    expect(res.stdout.toString()).toContain("kpi-flag-invalid");
    expect(res.stdout.toString()).toContain("next:");
  });

  test("missing --window → exit 2", () => {
    const res = runKpi([], { cwd: root, env: childEnv() });
    expect(res.status).toBe(2);
    expect(res.stdout.toString()).toContain("kpi-window-missing");
  });

  test("bad window spec → exit 2 kpi-window-invalid; positional → exit 2", () => {
    const bad = runKpi(["--window", "7x"], { cwd: root, env: childEnv() });
    expect(bad.status).toBe(2);
    expect(bad.stdout.toString()).toContain("kpi-window-invalid");
    const pos = runKpi(["--window", "7d", "stray"], { cwd: root, env: childEnv() });
    expect(pos.status).toBe(2);
    expect(pos.stdout.toString()).toContain("kpi-usage-invalid");
  });
});

describe("qds-kpi CLI — store-absent arms (absence typed, stores never created)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qds-kpi-absent-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("empty sandbox: exit 0, every KPI absent, dims typed absent, NO ledger or runs dir created", () => {
    const res = runKpi(["--window", "7d"], { cwd: root, env: childEnv() });
    expect(res.status).toBe(0);
    expect(() => statSync(join(root, ".sandbox", "cost-ledger.db"))).toThrow(); // read-only open never creates
    expect(() => statSync(join(root, ".sandbox", "runs"))).toThrow();
    const files = readdirSync(join(root, ".sandbox", "kpi-snapshots"));
    expect(files).toHaveLength(1);
    const p = JSON.parse(readFileSync(join(root, ".sandbox", "kpi-snapshots", files[0] as string), "utf8")) as ReturnType<typeof assembleSnapshot>;
    for (const k of p.kpis) expect(k.value.status).toBe("absent");
    expect(p.run_accounting.records_skipped).toBe("absent");
    for (const d of p.dimensions) expect(d.status).toBe("absent");
    const line = obsLine(res);
    expect(line.factory_ledger_absent).toBe(true);
    expect(line.runs_dir_absent).toBe(true);
  });

  test("ledger absent + import present: factory component absent-typed, every import row unmatched, spend_incomplete", () => {
    seedSandbox(root, T0, true);
    rmSync(join(root, ".sandbox", "cost-ledger.db"));
    const res = runKpi(["--window", "7d"], { cwd: root, env: childEnv({ QDS_KPI_NOW: T0.toISOString() }) });
    expect(res.status).toBe(0);
    const files = readdirSync(join(root, ".sandbox", "kpi-snapshots"));
    const p = JSON.parse(readFileSync(join(root, ".sandbox", "kpi-snapshots", files[0] as string), "utf8")) as ReturnType<typeof assembleSnapshot>;
    // Pinned semantics: factory-known keys = 0 → no key can match and none are "missing";
    // every import row is UNMATCHED and the join is flagged incomplete either way.
    expect(p.spend).toMatchObject({
      factory_micro_usd_total: 0, factory_event_count: 0,
      gateway_row_count: 1, matched_gateway_rows: 0, unmatched_gateway_rows: 1,
      missing_gateway_rows: 0, spend_incomplete: true,
    });
    expect(obsLine(res).factory_ledger_absent).toBe(true);
  });
});

describe("repoSlug derivation (--repo ?? $QDS_REPO_SLUG ?? git remote origin)", () => {
  test("repoSlugFromRemoteUrl: https .git, ssh scp-form, trailing slash", () => {
    expect(repoSlugFromRemoteUrl("https://github.com/Acme/widget.git")).toBe("widget");
    expect(repoSlugFromRemoteUrl("git@github.com:Acme/widget.git")).toBe("widget");
    expect(repoSlugFromRemoteUrl("https://github.com/Acme/widget/")).toBe("widget");
    expect(repoSlugFromRemoteUrl("widget.git")).toBe("widget");
  });

  test("spawned arm: git remote origin drives the retain bank when --repo and env are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "qds-kpi-slug-"));
    try {
      expect(spawnSync("git", ["init", "-q", "."], { cwd: root }).status).toBe(0);
      expect(spawnSync("git", ["remote", "add", "origin", "https://github.com/kpi-test/derived-slug.git"], { cwd: root }).status).toBe(0);
      const capturePath = join(root, "retain-capture.jsonl");
      const res = runKpi(["--window", "7d"], {
        cwd: root,
        env: childEnv({
          QDS_KPI_NOW: T0.toISOString(),
          HINDSIGHT_BASE_URL: "http://hindsight.invalid",
          HINDSIGHT_BEARER_TOKEN: "t",
          QDS_KPI_RETAIN_CAPTURE: capturePath,
        }),
      });
      expect(res.status).toBe(0);
      const line = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
      expect(line.bankId).toBe("derived-slug");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unresolvable slug (no --repo, no env, no git remote) → retain-skipped, no capture, exit 0", () => {
    const root = mkdtempSync(join(tmpdir(), "qds-kpi-noslug-"));
    try {
      const capturePath = join(root, "retain-capture.jsonl");
      const res = runKpi(["--window", "7d"], {
        cwd: root,
        env: childEnv({
          QDS_KPI_NOW: T0.toISOString(),
          HINDSIGHT_BASE_URL: "http://hindsight.invalid",
          HINDSIGHT_BEARER_TOKEN: "t",
          QDS_KPI_RETAIN_CAPTURE: capturePath,
        }),
      });
      expect(res.status).toBe(0);
      expect(() => statSync(capturePath)).toThrow();
      const skip = logLines(res).find((l) => l.operation === "kpi-retain");
      expect((skip?.error as Record<string, unknown>)?.message).toContain("no repo slug resolvable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
