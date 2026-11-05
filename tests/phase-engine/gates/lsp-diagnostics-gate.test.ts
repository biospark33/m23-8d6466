/**
 * P1.7 — post-edit lsp_diagnostics gate (unit, DI fakes; no network, no pi-lens).
 *
 * DoD map: waiver shape (R5-1), error-block, clean pass, no-lsp fallback
 * ladder (ast-grep + test-pass, vacuous-pass V1), no-evaluator fail-closed
 * (AC5), freshness re-query + 10 s fail-closed (AC6), rpc-timeout block, the
 * init-timeout fallback route, availability-is-not-a-PATH-probe, the
 * single-paths-invocation contract (P1.7-L4), the 50-file cap, waiver
 * persistence, and the Gate adapter.
 *
 * Fixtures render the parser's real line format (`path:line:col:
 * severity[tool]: msg`) — the same text `parseBatchDiagnosticsText` (P0.6)
 * consumes; no second parser.
 */
import { describe, expect, test } from "bun:test";
import {
  createLspDiagnosticsGate,
  evaluateLspDiagnosticsGate,
  type DiagnosticEntry,
  type LspCallResult,
  type LspGateDeps,
} from "../../../src/phase-engine/gates/lsp-diagnostics-gate.ts";
import { parseBatchDiagnosticsText } from "../../../scripts/lsp-verify.ts";

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

interface Diag {
  line: number;
  severity: "error" | "warning";
  message: string;
}

function batchText(opts: {
  files?: Array<{ file: string; diags: Diag[] }>;
  fileErrors?: Array<{ path: string; reason: string }>;
}): string {
  const lines: string[] = [];
  if (opts.fileErrors?.length) {
    lines.push("File errors:");
    for (const e of opts.fileErrors) lines.push(`${e.path}: ${e.reason}`);
  }
  for (const f of opts.files ?? []) {
    for (const d of f.diags) {
      lines.push(`${f.file}:${d.line}:1: ${d.severity}[typescript]: ${d.message}`);
    }
  }
  lines.push(`Files checked: ${opts.files?.length ?? 0}`);
  lines.push(`Total diagnostics: ${(opts.files ?? []).reduce((n, f) => n + f.diags.length, 0)}`);
  // Fixture guard: every fixture must round-trip through the REAL parser.
  parseBatchDiagnosticsText(lines.join("\n"));
  return lines.join("\n");
}

interface FakeState {
  responses: LspCallResult[];
  staleFirst: boolean;
  unstable: boolean;
  lastServed?: LspCallResult;
  calls: string[][];
  astGrepAvailable: boolean;
  astGrepFindings: DiagnosticEntry[];
  astGrepScans: number;
  hasTestSuite: boolean;
  testResult: boolean;
  testRuns: number;
  waivers: Array<{ reason: string; files: string[] }>;
  nowMs: number;
  sleepLog: number[];
}

function makeDeps(over: Partial<FakeState> = {}): { deps: LspGateDeps; state: FakeState } {
  const state: FakeState = {
    responses: [],
    staleFirst: false,
    unstable: false,
    calls: [],
    astGrepAvailable: true,
    astGrepFindings: [],
    astGrepScans: 0,
    hasTestSuite: false,
    testResult: true,
    testRuns:0,
    waivers: [],
    nowMs: 0,
    sleepLog: [],
    ...over,
  };
  const deps: LspGateDeps = {
    callLspDiagnostics: async (paths) => {
      state.calls.push([...paths]);
      if (state.unstable) {
        // Never stabilizes: alternating snapshots, the deadline-path model.
        const odd = state.calls.length % 2 === 1;
        return {
          text: odd
            ? batchText({ files: [{ file: "a.ts", diags: [{ line: 1, severity: "error", message: "one" }] }] })
            : batchText({ files: [{ file: "a.ts", diags: [{ line: 2, severity: "error", message: "two" }] }] }),
          timedOut: null,
        };
      }
      if (state.staleFirst) {
        // Exactly ONE stale (pre-edit) response first, then the stable
        // post-edit set — the stale-first-response model.
        const stale = state.calls.length === 1;
        return {
          text: stale
            ? batchText({ files: [{ file: "a.ts", diags: [{ line: 1, severity: "error", message: "stale-error" }] }] })
            : batchText({ files: [{ file: "a.ts", diags: [] }] }),
          timedOut: null,
        };
      }
      // Queue exhausted → repeat the LAST served response (a stable server);
      // with nothing served yet, a stable clean response.
      const queued = state.responses.shift();
      if (queued) {
        state.lastServed = queued;
        return queued;
      }
      return state.lastServed ?? { text: batchText({ files: [] }), timedOut: null };
    },
    astGrepAvailable: async () => state.astGrepAvailable,
    astGrepScan: async (files) => {
      state.astGrepScans += 1;
      void files;
      return state.astGrepFindings;
    },
    hasTestSuite: async () => state.hasTestSuite,
    runTestSuite: async () => {
      state.testRuns += 1;
      return state.testResult;
    },
    retainWaiverEvent: async (event) => {
      state.waivers.push({ reason: event.reason, files: [...event.files] });
    },
    now: () => state.nowMs,
    sleep: async (ms) => {
      state.sleepLog.push(ms);
      state.nowMs += ms;
    },
  };
  return { deps, state };
}

const F1 = "src/auth.ts";

describe("P1.7 waiver shape (R5-1)", () => {
  test("clean pass: waiver 0, waiverReason absent, gateResult agrees with passed", async () => {
    const { deps } = makeDeps({
      responses: [
        { text: batchText({ files: [{ file: F1, diags: [{ line: 3, severity: "warning", message: "unused" }] }] }), timedOut: null },
      ],
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r.gateResult).toBe("passed");
    expect(r.passed).toBe(true);
    expect(r.waiver).toBe(0);
    expect("waiverReason" in r).toBe(false);
  });

  test("lsp-timeout: waiver 1, matching reason, gateResult agrees", async () => {
    const { deps } = makeDeps({ responses: [{ text: "", timedOut: "rpc" }] });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ gateResult: "blocked", passed: false, waiver: 1, waiverReason: "lsp-timeout" });
  });

  test("stale-diagnostics past deadline: waiver 1, blocked, never passes on stale", async () => {
    const { deps, state } = makeDeps({ unstable: true });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: ["a.ts"] });
    expect(r).toMatchObject({ gateResult: "blocked", passed: false, waiver: 1, waiverReason: "stale-diagnostics" });
    expect(state.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("no-lsp vacuous pass (V1): waiver 1, passed, waiver PERSISTED (INV-DIAG-2)", async () => {
    const { deps, state } = makeDeps({
      responses: [{ text: batchText({ fileErrors: [{ path: F1, reason: "no LSP server resolved" }] }), timedOut: null }],
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ gateResult: "passed", passed: true, waiver: 1, waiverReason: "no-lsp" });
    expect(state.waivers).toHaveLength(1);
    expect(state.waivers[0]?.reason).toBe("no-lsp");
    // The persisted file keys are the PATHS pi-lens reported, not raw
    // "path: reason" lines (the shared parser splits on the first ": ").
    expect(state.waivers[0]?.files).toEqual([F1]);
  });

  test("no-evaluator: waiver 1, blocked (AC5 fail-closed)", async () => {
    const { deps } = makeDeps({
      responses: [{ text: batchText({ fileErrors: [{ path: F1, reason: "no LSP server resolved" }] }), timedOut: null }],
      astGrepAvailable: false,
      hasTestSuite: false,
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ gateResult: "blocked", passed: false, waiver: 1, waiverReason: "no-evaluator" });
  });
});

describe("P1.7 core ladder", () => {
  test("error diagnostic blocks (INV-DIAG-1): waiver 0, no reason, diagnostics carried", async () => {
    const { deps } = makeDeps({
      responses: [
        { text: batchText({ files: [{ file: F1, diags: [{ line: 4, severity: "error", message: "TS2322: bad" }] }] }), timedOut: null },
      ],
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ gateResult: "blocked", passed: false, waiver: 0 });
    expect("waiverReason" in r).toBe(false);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", message: "TS2322: bad", source: "lsp" }));
  });

  test("fallback blocked when ast-grep reports an error (AC4)", async () => {
    const { deps, state } = makeDeps({
      responses: [{ text: batchText({ fileErrors: [{ path: F1, reason: "no LSP server resolved" }] }), timedOut: null }],
      astGrepFindings: [{ file: F1, line: 2, severity: "error", message: "hardcoded secret", source: "ast-grep" }],
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ gateResult: "blocked", passed: false, waiverReason: "no-lsp" });
    expect(state.astGrepScans).toBe(1);
    expect(state.waivers).toHaveLength(1);
  });

  test("fallback passes when ast-grep clean + test suite passes (waiver 1, no-lsp)", async () => {
    const { deps, state } = makeDeps({
      responses: [{ text: batchText({ fileErrors: [{ path: F1, reason: "no LSP server resolved" }] }), timedOut: null }],
      hasTestSuite: true,
      testResult: true,
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ gateResult: "passed", passed: true, waiver: 1, waiverReason: "no-lsp" });
    expect(state.testRuns).toBe(1);
  });

  test("fallback blocked when ast-grep clean but test suite fails (AC4)", async () => {
    const { deps } = makeDeps({
      responses: [{ text: batchText({ fileErrors: [{ path: F1, reason: "no LSP server resolved" }] }), timedOut: null }],
      hasTestSuite: true,
      testResult: false,
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ gateResult: "blocked", passed: false, waiver: 1, waiverReason: "no-lsp" });
  });

  test("ast-grep absent + failing test suite: blocked with no-lsp (a suite ran and failed — not a no-evaluator census)", async () => {
    const { deps } = makeDeps({
      responses: [{ text: batchText({ fileErrors: [{ path: F1, reason: "no LSP server resolved" }] }), timedOut: null }],
      astGrepAvailable: false,
      hasTestSuite: true,
      testResult: false,
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ gateResult: "blocked", passed: false, waiver: 1, waiverReason: "no-lsp" });
  });
});

describe("P1.7 freshness (AC6)", () => {
  test("stale first response: re-queries at 250 ms, passes once fresh", async () => {
    const { deps, state } = makeDeps({ staleFirst: true });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: ["a.ts"] });
    expect(r.passed).toBe(true);
    expect(r.waiver).toBe(0);
    expect(state.calls.length).toBe(3); // stale + fresh + confirming re-query
    expect(state.sleepLog).toEqual([250, 250]);
  });

  test("holds stale past the 10 s deadline: blocked, persisted", async () => {
    // Never-stabilizing responses: every round a DIFFERENT snapshot (the
    // stale/fresh texts alternate forever via the staleFirst mode flipping
    // parity — wait, staleFirst stabilizes at round 2). So build a custom
    // fake whose texts never repeat, and let the fake clock cross the
    // 10 s deadline (250 ms per round → 41 rounds).
    const { deps, state } = makeDeps({});
    const textA = batchText({ files: [{ file: "a.ts", diags: [{ line: 1, severity: "error", message: "one" }] }] });
    const textB = batchText({ files: [{ file: "a.ts", diags: [{ line: 2, severity: "error", message: "two" }] }] });
    let i = 0;
    deps.callLspDiagnostics = async (paths) => {
      state.calls.push([...paths]);
      const odd = i % 2 === 1;
      i += 1;
      return { text: odd ? textB : textA, timedOut: null };
    };
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: ["a.ts"] });
    expect(r).toMatchObject({ gateResult: "blocked", passed: false, waiver: 1, waiverReason: "stale-diagnostics" });
    expect(state.nowMs).toBeGreaterThanOrEqual(10_000);
    expect(state.waivers).toHaveLength(1);
    expect(state.waivers[0]?.reason).toBe("stale-diagnostics");
  });
});

describe("P1.7 timeouts and invocation contract", () => {
  test("rpc timeout does NOT route to the ast-grep fallback", async () => {
    const { deps, state } = makeDeps({ responses: [{ text: "", timedOut: "rpc" }] });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r.waiverReason).toBe("lsp-timeout");
    expect(state.astGrepScans).toBe(0);
    expect(state.waivers).toHaveLength(1);
  });

  test("init timeout routes to fallback with no-lsp (AC3a)", async () => {
    const { deps } = makeDeps({ responses: [{ text: "", timedOut: "init" }] });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ passed: true, waiver: 1, waiverReason: "no-lsp" });
  });

  test("ONE paths invocation per fresh round carrying the full union (P1.7-L4)", async () => {
    const { deps, state } = makeDeps({
      responses: [
        { text: batchText({ files: [{ file: F1, diags: [] }] }), timedOut: null },
      ],
    });
    await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1, "src/util.ts"] });
    expect(state.calls.length).toBe(2); // freshness confirming re-query, still ONE per round
    expect(state.calls[0]).toEqual([F1, "src/util.ts"]);
    expect(state.calls[1]).toEqual([F1, "src/util.ts"]);
  });

  test("availability is not a PATH probe: LSP answers clean while ast-grep absent → no no-lsp waiver", async () => {
    const { deps } = makeDeps({
      responses: [
        { text: batchText({ files: [{ file: F1, diags: [{ line: 1, severity: "warning", message: "hint" }] }] }), timedOut: null },
      ],
      astGrepAvailable: false,
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ passed: true, waiver: 0 });
    expect(r.waiverReason).toBeUndefined();
  });

  test("changed-file union capped at 50: truncate, evaluate, RECORD the truncation", async () => {
    const { deps, state } = makeDeps({
      responses: [{ text: batchText({ files: [] }), timedOut: null }],
    });
    const many = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: many });
    expect(r.passed).toBe(true);
    expect(r.truncated).toBe(10);
    expect(state.calls[0]?.length).toBe(50);
  });

  test("empty changedFiles: vacuous pass with waiver 0 (nothing to gate)", async () => {
    const { deps, state } = makeDeps({
      responses: [{ text: batchText({ files: [] }), timedOut: null }],
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [] });
    expect(r).toMatchObject({ passed: true, waiver: 0 });
    expect(state.calls.length).toBe(0); // no LSP call for an empty union
  });

  test("zero-coverage response (no changed file parsed) is NOT a clean pass — degrades to fallback", async () => {
    const { deps } = makeDeps({
      responses: [
        // The text parses and names ONLY a file outside the changed set —
        // a real diagnostic line so the parser keys it as foreign.
        { text: batchText({ files: [{ file: "other/unrelated.ts", diags: [{ line: 1, severity: "warning", message: "foreign" }] }] }), timedOut: null },
      ],
      astGrepFindings: [],
    });
    const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(r).toMatchObject({ passed: true, waiver: 1, waiverReason: "no-lsp" });
  });

  test("waiver persistence: fires on waiver>0, not on clean pass", async () => {
    const { deps, state } = makeDeps({ responses: [{ text: "", timedOut: "rpc" }] });
    await evaluateLspDiagnosticsGate(deps, { changedFiles: [F1] });
    expect(state.waivers).toHaveLength(1);

    const clean = makeDeps({
      responses: [{ text: batchText({ files: [{ file: F1, diags: [] }] }), timedOut: null }],
    });
    await evaluateLspDiagnosticsGate(clean.deps, { changedFiles: [F1] });
    expect(clean.state.waivers).toHaveLength(0);
  });
});

describe("P1.7 Gate adapter", () => {
  test("maps a blocked evaluation to a failed GateReport", async () => {
    const { deps } = makeDeps({ responses: [{ text: "", timedOut: "rpc" }] });
    const gate = createLspDiagnosticsGate(deps);
    const report = await gate.run({ changedFiles: [F1] } as never, { runRoot: "/tmp" });
    expect(report.passed).toBe(false);
  });

  test("resolves burrow-relative changedFiles against the pinned runRoot (INV-3)", async () => {
    const { deps, state } = makeDeps({
      responses: [{ text: batchText({ files: [{ file: "/run/xyz/src/auth.ts", diags: [] }] }), timedOut: null }],
    });
    const gate = createLspDiagnosticsGate(deps);
    await gate.run({ changedFiles: ["src/auth.ts"] } as never, { runRoot: "/run/xyz" });
    expect(state.calls[0]?.[0]).toBe("/run/xyz/src/auth.ts");
  });

  test("truncation lands in the GateReport note", async () => {
    const { deps } = makeDeps({
      responses: [{ text: batchText({ files: [] }), timedOut: null }],
    });
    const gate = createLspDiagnosticsGate(deps);
    const many = Array.from({ length: 60 }, (_, i) => `/run/f${i}.ts`);
    const report = await gate.run({ changedFiles: many } as never, { runRoot: "/" });
    expect(report.passed).toBe(true);
    expect(report.checks.some((c) => c.note.includes("NOT evaluated"))).toBe(true);
  });
});
