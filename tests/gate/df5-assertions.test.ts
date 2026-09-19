/**
 * Consolidated DF5.4 lights-on-gate assertion tests (story DF5.4).
 *
 * One section per source unit:
 *   - "verdict lib" — the shared helpers in src/gate/assertions/lib/verdict.ts
 *     (leaf-1.1.1). Every test targets one false-green class: a dropped line
 *     counted as absent, a non-canonical timestamp silently compared across
 *     time bases, the wrong reverify report bound to an approval, or a read
 *     failure reported as evidence.
 *   - execution clauses (P1, C1-C4), boundary clauses (C5-C8) and accounting
 *     clauses (C9, C10, V1) — pure auditors AND check closures against the
 *     frozen run of record (copied into mkdtemp scratches; the fixture itself
 *     is never modified). Every removed-field mutant named in the leaf gates
 *     has its own red test, including the two-layer negative control (G3):
 *     in-box gate_results are claims, never proof — the truth layer is C6.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join, resolve } from "node:path";
import * as path from "node:path";

import { AUDIT_HOPS, OQ4_VOID_REASON, type ChainReport, type HopOutcome } from "../../src/audit/index.ts";
import { runGate } from "../../src/gate/gate-runner.ts";
import type { GateAssertion, GateCheckOutcome } from "../../src/gate/gate-runner.ts";
import type { ReverifyReport } from "../../src/reverify/report.ts";
import {
  auditChainReport,
  boundStderrTail,
  type Df5AccountingDeps,
  df5AccountingAssertions,
  scrubSecrets,
} from "../../src/gate/assertions/df5-accounting.ts";
import { df5BoundaryAssertions } from "../../src/gate/assertions/df5-boundary.ts";
import {
  auditChannel,
  auditFleet,
  auditGateResults,
  auditTeamEnvelope,
  df5ExecutionAssertions,
} from "../../src/gate/assertions/df5-execution.ts";
import {
  readJsonEvidence,
  scanNdjson,
  selectBoundReport,
  strictBeforeMs,
} from "../../src/gate/assertions/lib/verdict.ts";
// ---------------------------------------------------------------------------
// verdict lib — scanNdjson
// ---------------------------------------------------------------------------

describe("verdict lib — scanNdjson classifies every line, drops none", () => {
  test("empty text yields both arrays empty", () => {
    const scan = scanNdjson("");
    expect(scan.wellFormed).toEqual([]);
    expect(scan.malformed).toEqual([]);
  });

  test("mixed text: exact well-formed/malformed counts, blanks ignored, 1-based line numbers", () => {
    const text = [
      '{"seq":1}', //      line 1 — well-formed
      "", //               line 2 — blank, ignored
      '{"seq":2,}', //     line 3 — malformed (trailing comma)
      "   ", //            line 4 — whitespace-only, ignored
      '{"seq":3}', //      line 5 — well-formed
      "not json at all", // line 6 — malformed
    ].join("\n");

    const scan = scanNdjson(text);
    expect(scan.wellFormed).toEqual([{ seq: 1 }, { seq: 3 }]);
    expect(scan.malformed).toHaveLength(2);
    expect(scan.malformed[0]?.line).toBe(3);
    expect(scan.malformed[1]?.line).toBe(6);
    for (const entry of scan.malformed) {
      expect(typeof entry.error).toBe("string");
      expect(entry.error.length).toBeGreaterThan(0);
    }
  });

  test("no line silently dropped: wellFormed + malformed equals the non-blank line count", () => {
    const text = '{"ok":1}\n{bad\n\n{"ok":2}\n  \n[1,2]\ntrail\n';
    const scan = scanNdjson(text);
    expect(scan.wellFormed).toHaveLength(3);
    expect(scan.malformed).toHaveLength(2);
    expect(scan.wellFormed.length + scan.malformed.length).toBe(5);
  });

  test("whitespace-only lines are ignored, never malformed", () => {
    const scan = scanNdjson(" \t \n\n\x0c\n");
    expect(scan.wellFormed).toEqual([]);
    expect(scan.malformed).toEqual([]);
  });

  test("CRLF endings split cleanly; a bare trailing \\r stays parseable JSON whitespace", () => {
    // \r\n is a line separator...
    const crlf = scanNdjson('{"a":1}\r\n{"b":2}\r\n');
    expect(crlf.wellFormed).toEqual([{ a: 1 }, { b: 2 }]);
    expect(crlf.malformed).toEqual([]);
    // ...but a lone \r mid-text is part of the line: it only condemns the
    // line when JSON.parse itself rejects it. A trailing \r is JSON
    // whitespace, so this line stays well-formed.
    const bareCr = scanNdjson('{"a":1}\r');
    expect(bareCr.wellFormed).toEqual([{ a: 1 }]);
    // Two values jammed together with a bare \r between them do not parse.
    const jammed = scanNdjson('{"a":1}\r{"b":2}');
    expect(jammed.wellFormed).toEqual([]);
    expect(jammed.malformed).toHaveLength(1);
    expect(jammed.malformed[0]?.line).toBe(1);
  });

  test("non-object JSON scalars count as well-formed lines", () => {
    const scan = scanNdjson('42\n"a string"\ntrue\nnull\n[]\n');
    expect(scan.wellFormed).toEqual([42, "a string", true, null, []]);
    expect(scan.malformed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// verdict lib — strictBeforeMs
// ---------------------------------------------------------------------------

describe("verdict lib — strictBeforeMs refuses non-canonical stamps with null", () => {
  test("canonical Z stamps return the positive delta in ms", () => {
    expect(strictBeforeMs("2026-09-18T02:49:54Z", "2026-09-18T02:49:55Z")).toBe(1000);
    expect(strictBeforeMs("2026-09-18T02:49:54.123Z", "2026-09-19T02:49:54.123Z")).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  test("equality of stamps yields 0 — callers treat <= 0 as an F10 ordering violation", () => {
    expect(strictBeforeMs("2026-09-18T02:49:54Z", "2026-09-18T02:49:54Z")).toBe(0);
  });

  test("a reversed pair yields a negative delta, not null and not a silent false", () => {
    expect(strictBeforeMs("2026-09-18T02:49:55Z", "2026-09-18T02:49:54Z")).toBe(-1000);
  });

  test("space-separated 'YYYY-MM-DD HH:MM:SS' is local-time guesswork: null, never a number", () => {
    // Date.parse accepts it as LOCAL time — comparing it against a Z stamp
    // shifts by the host offset. The round-trip check must refuse it.
    expect(strictBeforeMs("2026-09-18 02:49:54", "2026-09-18T02:49:55Z")).toBeNull();
    expect(strictBeforeMs("2026-09-18T02:49:54Z", "2026-09-18 02:49:55")).toBeNull();
  });

  test("empty-string stamp yields null on either side", () => {
    expect(strictBeforeMs("", "2026-09-18T02:49:54Z")).toBeNull();
    expect(strictBeforeMs("2026-09-18T02:49:54Z", "")).toBeNull();
  });

  test("date-only and offset-form spellings fail the toISOString round-trip: null", () => {
    expect(strictBeforeMs("2026-09-18", "2026-09-19T00:00:00Z")).toBeNull();
    expect(strictBeforeMs("2026-09-18T04:49:54+02:00", "2026-09-18T04:49:55+02:00")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verdict lib — selectBoundReport
// ---------------------------------------------------------------------------

interface FakeReport {
  reverifyId: string;
  verdict: string;
}

const REPORTS: ReadonlyArray<FakeReport> = [
  { reverifyId: "rv-old", verdict: "red" },
  { reverifyId: "rv-bound", verdict: "green" },
  { reverifyId: "rv-other", verdict: "green" },
];

describe("verdict lib — selectBoundReport binds reportId, never a superseded id", () => {
  test("picks the report whose reverifyId === approval.reportId over superseded ids", () => {
    const picked = selectBoundReport(REPORTS, { reportId: "rv-bound", supersededReportIds: ["rv-old", "rv-other"] }, "/evidence/run.jsonl");
    expect(picked).toEqual({ report: { reverifyId: "rv-bound", verdict: "green" } });
  });

  test("absent bound id: reason is 'bound-report-absent:<id>:<path>' naming the evidence file", () => {
    const picked = selectBoundReport(REPORTS, { reportId: "rv-gone", supersededReportIds: [] }, ".sandbox/reverify/run-1.jsonl");
    expect(picked).toEqual({ reason: "bound-report-absent:rv-gone:.sandbox/reverify/run-1.jsonl" });
  });

  test("bound id itself listed in supersededReportIds: reason is 'bound-report-superseded:<id>'", () => {
    const picked = selectBoundReport(REPORTS, { reportId: "rv-old", supersededReportIds: ["rv-old"] }, "/evidence/run.jsonl");
    expect(picked).toEqual({ reason: "bound-report-superseded:rv-old" });
  });

  test("absent wins over superseded when the id is both missing from reports and listed", () => {
    // Pins the check order: a listed-but-absent id names the absent reason
    // (id + path), because the first-order problem is that no line resolves.
    const picked = selectBoundReport(REPORTS, { reportId: "rv-gone", supersededReportIds: ["rv-gone"] }, "/evidence/run.jsonl");
    expect(picked).toEqual({ reason: "bound-report-absent:rv-gone:/evidence/run.jsonl" });
  });

  test("empty reports array yields the absent reason", () => {
    const picked = selectBoundReport([] as FakeReport[], { reportId: "rv-any", supersededReportIds: [] }, "/evidence/run.jsonl");
    expect(picked).toEqual({ reason: "bound-report-absent:rv-any:/evidence/run.jsonl" });
  });
});

// ---------------------------------------------------------------------------
// verdict lib — readJsonEvidence
// ---------------------------------------------------------------------------

describe("verdict lib — readJsonEvidence returns undefined on any failure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qds-verdict-"));

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("parses a valid JSON file", () => {
    const file = path.join(tmp, "ok.json");
    fs.writeFileSync(file, JSON.stringify({ runId: "run-1", n: 3 }), "utf8");
    expect(readJsonEvidence(file)).toEqual({ runId: "run-1", n: 3 });
  });

  test("missing file yields undefined", () => {
    expect(readJsonEvidence(path.join(tmp, "does-not-exist.json"))).toBeUndefined();
  });

  test("malformed JSON yields undefined", () => {
    const file = path.join(tmp, "broken.json");
    fs.writeFileSync(file, '{"runId": "run-1",}', "utf8");
    expect(readJsonEvidence(file)).toBeUndefined();
  });
});

// ===========================================================================
// df5-execution (P1, C1-C4) - leaf-1.1.3
// ===========================================================================

const RUN_ID = "qds-20260918-cc93a3";
const REQUEST_ID = "894bcb72-837e-4560-9826-4aec24875c8d";
const FIXTURE = path.join(import.meta.dir, "fixtures", "df5-run-of-record");

/** Full fixture copy — the happy-path runsDir (fixture stays immutable). */
let fixtureCopyDir = "";
const scratchDirs: string[] = [];

beforeAll(() => {
  fixtureCopyDir = fs.mkdtempSync(path.join(os.tmpdir(), "df54-exec-fixture-"));
  fs.cpSync(FIXTURE, fixtureCopyDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(fixtureCopyDir, { recursive: true, force: true });
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function newScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df54-exec-"));
  scratchDirs.push(dir);
  return dir;
}

function fixtureRecord(): Record<string, unknown> {
  const record = readJsonEvidence(path.join(FIXTURE, `${RUN_ID}.json`));
  if (record === null || typeof record !== "object") throw new Error("fixture record unparseable");
  return record as Record<string, unknown>;
}

/** Scratch runsDir carrying a mutated record, optionally the harvested trace subtree. */
function scratchWithRecord(
  mutate: (record: Record<string, unknown>) => void,
  opts: { trace?: boolean } = {},
): string {
  const dir = newScratch();
  const record = fixtureRecord();
  mutate(record);
  fs.writeFileSync(path.join(dir, `${RUN_ID}.json`), JSON.stringify(record), "utf8");
  if (opts.trace) {
    fs.cpSync(
      path.join(FIXTURE, `${RUN_ID}-artifacts`),
      path.join(dir, `${RUN_ID}-artifacts`),
      { recursive: true },
    );
  }
  return dir;
}

/** Scratch runsDir whose synthetic trace.db holds exactly these gate_results rows. */
function scratchWithTraceDb(rows: Array<{ request_id: string; passed: number | null }>): string {
  const dir = newScratch();
  fs.writeFileSync(
    path.join(dir, `${RUN_ID}.json`),
    JSON.stringify({ runId: RUN_ID, requestId: REQUEST_ID }),
    "utf8",
  );
  const traceDir = path.join(dir, `${RUN_ID}-artifacts`, "trace");
  fs.mkdirSync(traceDir, { recursive: true });
  const db = new Database(path.join(traceDir, "trace.db"));
  db.exec(`CREATE TABLE gate_results (
    id INTEGER PRIMARY KEY,
    request_id TEXT NOT NULL,
    phase_id TEXT,
    attempt INTEGER,
    gate TEXT,
    passed INTEGER,
    violations_json TEXT,
    checks_json TEXT
  )`);
  const insert = db.prepare("INSERT INTO gate_results (request_id, gate, passed) VALUES (?, 'synthetic', ?)");
  for (const row of rows) insert.run(row.request_id, row.passed);
  db.close();
  return dir;
}

async function runCheck(id: string, runsDir: string): Promise<GateCheckOutcome> {
  const assertion = df5ExecutionAssertions({ runId: RUN_ID, runsDir }).find((a) => a.id === id);
  if (!assertion) throw new Error(`no assertion ${id}`);
  return assertion.check();
}

async function expectFail(id: string, runsDir: string, ...needles: string[]): Promise<string> { // dp:ok - a rejection here IS the test failure (bun:test surfaces it red)
  const out = await runCheck(id, runsDir);
  expect(out.pass).toBe(false);
  expect(out.skip).toBeUndefined();
  expect(typeof out.detail).toBe("string");
  for (const needle of needles) expect(out.detail).toContain(needle);
  return out.detail ?? ""; // dp:ok - detail-or-empty for an assertion that already failed; the needles are checked above
}

async function expectSkip(id: string, runsDir: string, ...needles: string[]): Promise<void> { // dp:ok - a rejection here IS the test failure (bun:test surfaces it red)
  const out = await runCheck(id, runsDir);
  expect(out.pass).toBe(false);
  expect(out.skip).toBe(true);
  for (const needle of needles) expect(out.detail).toContain(needle);
}

// ---------------------------------------------------------------------------
// factory shape
// ---------------------------------------------------------------------------

describe("df5ExecutionAssertions factory", () => {
  test("returns the five execution clauses with chassis-required metadata", () => {
    const assertions = df5ExecutionAssertions({ runId: RUN_ID, runsDir: fixtureCopyDir });
    expect(assertions.map((a) => a.id)).toEqual(["DF5.4-P1", "DF5.4-C1", "DF5.4-C2", "DF5.4-C3", "DF5.4-C4"]);
    const [p1, c1, c2, c3, c4] = assertions;
    expect(p1?.group).toBe("preflight");
    expect(p1?.story).toBe("DF5.4");
    expect(p1?.prd_clause).toBe("§8 step 5 — run of record");
    expect(c1?.group).toBe("main");
    expect(c1?.story).toBe("DF3.1/DF2.8");
    expect(c1?.prd_clause).toBe("§8 step 5 — channel");
    expect(c2?.group).toBe("main");
    expect(c2?.story).toBe("DF3.1/DF2.2/DF2.5");
    expect(c2?.prd_clause).toBe("§8 step 5 — fleet");
    expect(c3?.group).toBe("main");
    expect(c3?.story).toBe("DF1.6");
    expect(c3?.prd_clause).toBe("§8 step 5 — team");
    expect(c4?.group).toBe("main");
    expect(c4?.story).toBe("DF1.2/DF1.4");
    expect(c4?.prd_clause).toBe("§8 step 5 — gates");
    for (const a of assertions) expect(a.description.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DF5.4-P1 — preflight: the run of record
// ---------------------------------------------------------------------------

describe("DF5.4-P1 preflight — run of record", () => {
  test("green on the fixture copy, provenance names the record path", async () => {
    const out = await runCheck("DF5.4-P1", fixtureCopyDir);
    expect(out.pass).toBe(true);
    expect(out.skip).toBeUndefined();
    expect(out.detail).toContain(RUN_ID);
    expect(out.detail).toContain("evidence-of-record");
    expect(out.detail).toContain(path.join(fixtureCopyDir, `${RUN_ID}.json`));
  });

  test("mutant: missing record → skip naming the path (red, never green)", async () => {
    await expectSkip("DF5.4-P1", newScratch(), "not readable");
  });

  test("mutant: unreadable record (mode 000) → skip naming the path", async () => {
    const dir = scratchWithRecord(() => {});
    fs.chmodSync(path.join(dir, `${RUN_ID}.json`), 0o000);
    await expectSkip("DF5.4-P1", dir, `${RUN_ID}.json`);
  });

  test("mutant: unparseable record → fail (present and readable, not JSON)", async () => {
    const dir = newScratch();
    fs.writeFileSync(path.join(dir, `${RUN_ID}.json`), '{"runId": "x",', "utf8");
    await expectFail("DF5.4-P1", dir, "not valid JSON");
  });

  test("mutant: parses but runId is not a string → fail naming runId", async () => {
    const dir = newScratch();
    fs.writeFileSync(path.join(dir, `${RUN_ID}.json`), JSON.stringify({ runId: 42 }), "utf8");
    await expectFail("DF5.4-P1", dir, "runId=");
  });
});

// ---------------------------------------------------------------------------
// DF5.4-C1 — channel
// ---------------------------------------------------------------------------

describe("DF5.4-C1 channel — requestId + admitted budget", () => {
  test("auditor green on the fixture record", () => {
    const audit = auditChannel(fixtureRecord());
    expect(audit.failures).toEqual([]);
    expect(audit.requestId).toBe(REQUEST_ID);
    expect(audit.admittedCeilingMicroUsd).toBe(50_000);
  });

  test("mutant: no requestId → fails naming requestId", () => {
    const failures = auditChannel({ ...fixtureRecord(), requestId: undefined }).failures;
    expect(failures.some((f) => f.includes("requestId="))).toBe(true);
  });

  test("mutant: no extensions.budget block → fails naming extensions.budget (a run nothing admitted is a run nothing capped)", () => {
    const record = fixtureRecord();
    (record as { extensions?: Record<string, unknown> }).extensions = {};
    const failures = auditChannel(record).failures;
    expect(failures.some((f) => f.includes("extensions.budget.repoSlug"))).toBe(true);
    expect(failures.some((f) => f.includes("admittedCeilingMicroUsd"))).toBe(true);
  });

  test("mutant: admittedCeilingMicroUsd = 0 → fails (positive assertion; 0 is not an admission)", () => {
    const record = fixtureRecord();
    const budget = (record.extensions as Record<string, unknown>).budget as Record<string, unknown>;
    budget.admittedCeilingMicroUsd = 0;
    expect(auditChannel(record).failures.some((f) => f.includes("admittedCeilingMicroUsd=0"))).toBe(true);
  });

  test("mutant: admittedCeilingMicroUsd absent → fails", () => {
    const record = fixtureRecord();
    const budget = (record.extensions as Record<string, unknown>).budget as Record<string, unknown>;
    const { admittedCeilingMicroUsd: _removed, ...rest } = budget;
    (record.extensions as Record<string, unknown>).budget = rest;
    expect(auditChannel(record).failures.some((f) => f.includes("admittedCeilingMicroUsd=absent"))).toBe(true);
  });

  test("mutant: repoSlug not a string → fails naming repoSlug", () => {
    const record = fixtureRecord();
    const budget = (record.extensions as Record<string, unknown>).budget as Record<string, unknown>;
    budget.repoSlug = 7;
    expect(auditChannel(record).failures.some((f) => f.includes("repoSlug=7"))).toBe(true);
  });

  test("auditor survives a scalar record (untrusted disk data: no throw, every leg fails)", () => {
    expect(auditChannel(42).failures.length).toBeGreaterThan(0);
    expect(auditChannel(null).failures.length).toBeGreaterThan(0);
  });

  test("check green on the fixture copy with provenance suffix", async () => {
    const out = await runCheck("DF5.4-C1", fixtureCopyDir);
    expect(out.pass).toBe(true);
    expect(out.detail).toContain("evidence-of-record");
    expect(out.detail).toContain(path.join(fixtureCopyDir, `${RUN_ID}.json`));
  });

  test("check with unreadable record → skip naming the path", async () => {
    await expectSkip("DF5.4-C1", newScratch(), `${RUN_ID}.json`);
  });
});

// ---------------------------------------------------------------------------
// DF5.4-C2 — fleet
// ---------------------------------------------------------------------------

describe("DF5.4-C2 fleet — closed, pinned, gate-green, approved, spent", () => {
  test("auditor green on the fixture record", () => {
    const audit = auditFleet(fixtureRecord());
    expect(audit.failures).toEqual([]);
    expect(audit.approvalState).toBe("approved");
    expect(audit.spendMicroUsd).toBe(2184);
  });

  test("mutant: missing closedAt → names the closedAt leg", () => {
    const failures = auditFleet({ ...fixtureRecord(), closedAt: undefined }).failures;
    expect(failures.some((f) => f.startsWith("closedAt="))).toBe(true);
  });

  test("mutant: missing commitSha → names the commitSha leg", () => {
    const failures = auditFleet({ ...fixtureRecord(), commitSha: undefined }).failures;
    expect(failures.some((f) => f.startsWith("commitSha="))).toBe(true);
  });

  test("mutant: extensions.gate present → names the negated-field leg", () => {
    const record = fixtureRecord();
    (record.extensions as Record<string, unknown>).gate = {
      schemaVersion: 1,
      outcome: "failed",
      failedItem: "setup",
      assertionCode: 3,
      failedAt: "2026-09-18T02:48:00.000Z",
    };
    const failures = auditFleet(record).failures;
    expect(failures.filter((f) => f.startsWith("extensions.gate present")).length).toBe(1);
  });

  test("mutant: approval.state = pausing → names the approval leg (closed-but-not-finished)", () => {
    const record = fixtureRecord();
    const approval = (record.extensions as Record<string, unknown>).approval as Record<string, unknown>;
    approval.state = "pausing";
    const failures = auditFleet(record).failures;
    expect(failures.some((f) => f.includes('approval.state="pausing"'))).toBe(true);
  });

  test("mutant: spendMicroUsd = 0 and absent → both fail the positive assertion", () => {
    const zero = auditFleet({ ...fixtureRecord(), spendMicroUsd: 0 }).failures;
    expect(zero.some((f) => f.startsWith("spendMicroUsd=0"))).toBe(true);
    const absent = auditFleet({ ...fixtureRecord(), spendMicroUsd: undefined }).failures;
    expect(absent.some((f) => f.startsWith("spendMicroUsd=absent"))).toBe(true);
  });

  test("mutant: extensions absent entirely → survives, fails on approval.state, gate-absent leg does not fail", () => {
    const failures = auditFleet({ ...fixtureRecord(), extensions: undefined }).failures;
    expect(failures.some((f) => f.includes("approval.state=absent"))).toBe(true);
    expect(failures.some((f) => f.startsWith("extensions.gate present"))).toBe(false);
  });

  test("auditor survives a scalar record (untrusted disk data: no throw)", () => {
    expect(auditFleet("a string").failures.length).toBeGreaterThan(0);
  });

  test("check green on the fixture copy with provenance suffix", async () => {
    const out = await runCheck("DF5.4-C2", fixtureCopyDir);
    expect(out.pass).toBe(true);
    expect(out.detail).toContain("evidence-of-record");
  });

  test("check mutant: extensions.gate present → fail naming that leg", async () => {
    const dir = scratchWithRecord((record) => {
      (record.extensions as Record<string, unknown>).gate = { schemaVersion: 1, outcome: "failed" };
    });
    await expectFail("DF5.4-C2", dir, "extensions.gate present");
  });
});

// ---------------------------------------------------------------------------
// DF5.4-C3 — team envelope (harvested events.jsonl)
// ---------------------------------------------------------------------------

describe("DF5.4-C3 team — harvested NDJSON envelope, claim-integrity only", () => {
  test("auditor green on the fixture scan", () => {
    const text = fs.readFileSync(path.join(FIXTURE, `${RUN_ID}-artifacts`, "trace", "events.jsonl"), "utf8");
    const audit = auditTeamEnvelope({ exists: true, ...scanNdjson(text) });
    expect(audit.skip).toBeUndefined();
    expect(audit.failures).toEqual([]);
    expect(audit.wellFormed.length).toBeGreaterThan(0);
  });

  test("auditor exists=false → skip (missing evidence is red, never green)", () => {
    const audit = auditTeamEnvelope({ exists: false, wellFormed: [], malformed: [] });
    expect(audit.skip).toContain("no harvested team envelope");
    expect(audit.failures).toEqual([]);
  });

  test("mutant: zero-line events.jsonl → fails on the >=1 well-formed conjunct", () => {
    const audit = auditTeamEnvelope({ exists: true, ...scanNdjson("") });
    expect(audit.failures.some((f) => f.includes("wellFormed lines=0"))).toBe(true);
  });

  test("mutant: malformed NDJSON line → fails naming the malformed count", () => {
    const audit = auditTeamEnvelope({ exists: true, ...scanNdjson('{"ok":1}\nnot-json\n') });
    expect(audit.failures.some((f) => f.includes("malformed lines=1"))).toBe(true);
  });

  test("check green on the fixture copy: detail proves arrival intact, never truth", async () => {
    const out = await runCheck("DF5.4-C3", fixtureCopyDir);
    expect(out.pass).toBe(true);
    expect(out.detail).toContain("claim-integrity");
    expect(out.detail).toContain("arrived intact");
    expect(out.detail).toContain("never that it is true");
    expect(out.detail).toContain("evidence-of-record");
    expect(out.detail).toContain(path.join(fixtureCopyDir, `${RUN_ID}-artifacts`, "trace", "events.jsonl"));
  });

  test("check mutant: missing events.jsonl → skip naming the path", async () => {
    await expectSkip("DF5.4-C3", scratchWithRecord(() => {}), "events.jsonl");
  });

  test("check mutant: zero-line events.jsonl (C3's own fixture) → fail", async () => {
    const dir = scratchWithRecord(() => {});
    const traceDir = path.join(dir, `${RUN_ID}-artifacts`, "trace");
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(path.join(traceDir, "events.jsonl"), "", "utf8");
    await expectFail("DF5.4-C3", dir, "wellFormed lines=0");
  });

  test("check mutant: malformed NDJSON line → fail", async () => {
    const dir = scratchWithRecord(() => {});
    const traceDir = path.join(dir, `${RUN_ID}-artifacts`, "trace");
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(path.join(traceDir, "events.jsonl"), '{"ok":1}\nnot-json\n', "utf8");
    await expectFail("DF5.4-C3", dir, "malformed lines=1");
  });
});

// ---------------------------------------------------------------------------
// DF5.4-C4 — gates (harvested trace.db, claim-integrity only)
// ---------------------------------------------------------------------------

describe("DF5.4-C4 gates — harvested gate_results rows, claim-integrity only", () => {
  test("auditor green on the fixture's rows", () => {
    const audit = auditGateResults([{ passed: 1 }], true);
    expect(audit.failures).toEqual([]);
    expect(audit.rowCount).toBe(1);
  });

  test("G3 diversity: a synthetic two-row fixture [1, 0] passes — a fail row is a lawful claim", () => {
    const audit = auditGateResults([{ passed: 1 }, { passed: 0 }], true);
    expect(audit.failures).toEqual([]);
    expect(audit.rowCount).toBe(2);
  });

  test("mutant: NULL passed row → fails (NULL is an unproven verdict)", () => {
    expect(auditGateResults([{ passed: 1 }, { passed: null }], true).failures.some((f) => f.includes("NULL"))).toBe(true);
  });

  test("mutant: passed=2 row → fails the literal 0/1 requirement", () => {
    expect(auditGateResults([{ passed: 2 }], true).failures.some((f) => f.includes("passed=2"))).toBe(true);
  });

  test("mutant: zero rows → fails the >=1 conjunct", () => {
    expect(auditGateResults([], true).failures.some((f) => f.includes("rows=0"))).toBe(true);
  });

  test("mutant: non-numeric passed junk → fails closed (NaN, never a silent pass)", () => {
    expect(auditGateResults([{ passed: Number.NaN }], true).failures.length).toBe(1);
  });

  test("join impossible (joinedOnRequestId=false) → skip, never a silent zero-row fail", () => {
    const audit = auditGateResults([], false);
    expect(audit.skip).toContain("requestId");
    expect(audit.failures).toEqual([]);
  });

  test("G3 two-layer control: a ReverifyReport cannot be fed to C4 (type-level, INV-GATE-4)", () => {
    const report = {
      reverifyId: "rv-1",
      verdict: "green",
      completedAt: "2026-09-18T02:49:30.702Z",
    } as ReverifyReport;
    // @ts-expect-error — C4 audits gate_results claims; a ReverifyReport (the
    // truth layer's own input) has no `passed` field and must not typecheck.
    const audit = auditGateResults([report], true);
    expect(audit.failures.length).toBeGreaterThan(0);
  });

  test("check green on the fixture copy: claim-integrity named, artifacts dir gains no -shm/-wal", async () => {
    const traceDir = path.join(fixtureCopyDir, `${RUN_ID}-artifacts`, "trace");
    const before = fs.readdirSync(traceDir).sort();
    const out = await runCheck("DF5.4-C4", fixtureCopyDir);
    expect(out.pass).toBe(true);
    expect(out.detail).toContain("claim-integrity");
    expect(out.detail).toContain("INV-GATE-4");
    expect(out.detail).toContain("evidence-of-record");
    expect(out.detail).toContain(path.join(traceDir, "trace.db"));
    expect(fs.readdirSync(traceDir).sort()).toEqual(before);
  });

  test("check mutant: missing trace.db → skip naming the path", async () => {
    await expectSkip("DF5.4-C4", scratchWithRecord(() => {}), "trace.db");
  });

  test("check mutant: NULL passed row (synthetic db) → fail", async () => {
    await expectFail("DF5.4-C4", scratchWithTraceDb([{ request_id: REQUEST_ID, passed: null }]), "NULL");
  });

  test("check mutant: passed=2 row (synthetic db) → fail", async () => {
    await expectFail("DF5.4-C4", scratchWithTraceDb([{ request_id: REQUEST_ID, passed: 2 }]), "passed=2");
  });

  test("check mutant: zero gate_results rows (synthetic db) → fail", async () => {
    await expectFail("DF5.4-C4", scratchWithTraceDb([]), "rows=0");
  });

  test("check mutant: request_id join miss (rows under another request_id) → fail", async () => {
    await expectFail(
      "DF5.4-C4",
      scratchWithTraceDb([{ request_id: "some-other-request", passed: 1 }]),
      "rows=0",
    );
  });

  test("check mutant: TEXT-typed passed value in the db → fails closed, not coerced to green", async () => {
    const dir = scratchWithTraceDb([]);
    const db = new Database(path.join(dir, `${RUN_ID}-artifacts`, "trace", "trace.db"));
    // "1" would be INTEGER-affinity-coerced to 1 before storage; non-numeric text stays TEXT.
    db.prepare("INSERT INTO gate_results (request_id, gate, passed) VALUES (?, 'synthetic', ?)").run(REQUEST_ID, "yes");
    db.close();
    await expectFail("DF5.4-C4", dir, "passed=NaN");
  });
});

// ===========================================================================
// df5-boundary (C5-C8) - leaf-1.1.4
// ===========================================================================

const REPO = resolve(import.meta.dir, "../..");

/** The frozen bound report's reverifyId (record.extensions.approval.reportId). */
const BOUND_ID = "rv-qds-20260918-cc93a3-2026-09-18t02-49-30-702z-gyiyex";
const HEAD_SHA = "4762832d618a2eae924b17dc96fec1ebe4fdfaa3";

interface Scratch {
  root: string;
  runsDir: string;
  reverifyDir: string;
  prBodyFile: string;
  gitDir: string;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function boundScratch(): Scratch {
  const root = fs.mkdtempSync(join(os.tmpdir(), "df5-boundary-"));
  roots.push(root);
  const runsDir = join(root, "runs");
  const reverifyDir = join(root, "reverify");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(reverifyDir, { recursive: true });
  fs.copyFileSync(join(FIXTURE, `${RUN_ID}.json`), join(runsDir, `${RUN_ID}.json`));
  // .reverify. infix -> readReports' `<runId>.jsonl` convention.
  fs.copyFileSync(join(FIXTURE, `${RUN_ID}.reverify.jsonl`), join(reverifyDir, `${RUN_ID}.jsonl`));
  fs.copyFileSync(join(FIXTURE, "pr-body.txt"), join(root, "pr-body.txt"));
  return { root, runsDir, reverifyDir, prBodyFile: join(root, "pr-body.txt"), gitDir: join(FIXTURE, "refs.git") };
}

function rvPath(s: Scratch): string {
  return join(s.reverifyDir, `${RUN_ID}.jsonl`);
}

function recordPath(s: Scratch): string {
  return join(s.runsDir, `${RUN_ID}.json`);
}

function editRecord(s: Scratch, edit: (rec: any) => void): void {
  const rec = JSON.parse(fs.readFileSync(recordPath(s), "utf8")); // dp:ok - parses a file this test wrote; a throw is the red test
  edit(rec);
  fs.writeFileSync(recordPath(s), `${JSON.stringify(rec, null, 2)}\n`);
}

/** Edits the BOUND report (the line whose reverifyId the approval carries). */
function editBoundReport(s: Scratch, edit: (rep: any) => void): void {
  const file = rvPath(s);
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  const bound = lines.findIndex((l) => JSON.parse(l).reverifyId === BOUND_ID); // dp:ok - parses the bound line this test located; a throw is the red test
  if (bound < 0) throw new Error("bound report line not found in scratch jsonl");
  const rep = JSON.parse(lines[bound] as string); // dp:ok - parses the bound line this test located; a throw is the red test
  edit(rep);
  lines[bound] = JSON.stringify(rep);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/** Appends a full, schema-valid report line (readReports drops invalid lines). */
function appendReportLine(s: Scratch, rep: any): void {
  fs.appendFileSync(rvPath(s), `${JSON.stringify(rep)}\n`);
}

function cloneBoundReport(s: Scratch): any {
  const lines = fs.readFileSync(rvPath(s), "utf8").trimEnd().split("\n");
  const bound = lines.find((l) => JSON.parse(l).reverifyId === BOUND_ID); // dp:ok - parses a file this test wrote; a throw is the red test
  if (!bound) throw new Error("bound report line not found in scratch jsonl");
  return JSON.parse(bound); // dp:ok - parses a file this test wrote; a throw is the red test
}

function editPrBody(s: Scratch, edit: (lines: string[]) => string[]): void {
  const lines = fs.readFileSync(s.prBodyFile, "utf8").split("\n");
  fs.writeFileSync(s.prBodyFile, edit(lines).join("\n"));
}

function prCreatedAt(s: Scratch): string {
  return JSON.parse(fs.readFileSync(recordPath(s), "utf8")).extensions.pr.createdAt; // dp:ok - parses a file this test wrote; a throw is the red test
}

function assertions(s: Scratch): GateAssertion[] {
  return df5BoundaryAssertions({
    runId: RUN_ID,
    runsDir: s.runsDir,
    gitDir: s.gitDir,
    reverifyDir: s.reverifyDir,
    prBodyFile: s.prBodyFile,
  });
}

async function check(s: Scratch, id: string): Promise<GateCheckOutcome> {
  const assertion = assertions(s).find((a) => a.id === id);
  if (!assertion) throw new Error(`no assertion ${id}`);
  return assertion.check();
}

function expectOutcomePass(out: GateCheckOutcome, ...needles: string[]): void {
  expect(out.pass).toBe(true);
  expect(out.skip).toBeUndefined();
  for (const needle of needles) expect(out.detail).toContain(needle);
}

function expectOutcomeFail(out: GateCheckOutcome, ...needles: string[]): void {
  expect(out.pass).toBe(false);
  expect(out.skip).not.toBe(true);
  for (const needle of needles) expect(out.detail).toContain(needle);
}

function expectOutcomeSkip(out: GateCheckOutcome, ...needles: string[]): void {
  expect(out.pass).toBe(false);
  expect(out.skip).toBe(true);
  for (const needle of needles) expect(out.detail).toContain(needle);
}

describe("df5BoundaryAssertions — clause map metadata", () => {
  test("exports C5..C8 with story/prd_clause/group per the clause map", () => {
    const rows = assertions(boundScratch()).map((a) => [a.id, a.story, a.prd_clause, a.group]);
    expect(rows).toEqual([
      ["DF5.4-C5", "DF2.5", "§8 step 5 — bundle", "main"],
      ["DF5.4-C6", "DF5.1", "§8 step 5 — host-side re-verify", "main"],
      ["DF5.4-C7", "DF3.4", "§8 step 5 — approval", "main"],
      ["DF5.4-C8", "DF5.2", "§8 step 5 — PR", "main"],
    ]);
  });
});

describe("fixture happy path (frozen run of record)", () => {
  test("C5: refs/sandbox/<runId> resolves in the fixture bare repo, sha named", async () => {
    const s = boundScratch();
    const out = await check(s, "DF5.4-C5");
    expectOutcomePass(out, HEAD_SHA, `refs/sandbox/${RUN_ID}`, s.gitDir);
  });

  test("C6: bound report green and strictly before pr.createdAt, provenance names the bound selection", async () => {
    const s = boundScratch();
    const out = await check(s, "DF5.4-C6");
    expectOutcomePass(out, BOUND_ID, rvPath(s));
  });

  test("C7: approved, ordered bound < decidedAt < pr.createdAt, provenance names the record", async () => {
    const s = boundScratch();
    const out = await check(s, "DF5.4-C7");
    expectOutcomePass(out, recordPath(s));
  });

  test("C8: frozen PR body carries runId, Issue: line and cost line", async () => {
    const s = boundScratch();
    const out = await check(s, "DF5.4-C8");
    expectOutcomePass(out, s.prBodyFile);
  });
});

describe("C5 mutants (bundle ref)", () => {
  test("ref unresolvable in an empty bare repo → C5 fails naming gitDir + ref", async () => {
    const s = boundScratch();
    const emptyGit = join(s.root, "empty.git");
    fs.mkdirSync(emptyGit, { recursive: true });
    const init = Bun.spawn(["git", "init", "--bare", emptyGit], { stdout: "pipe", stderr: "pipe" });
    await init.exited;
    s.gitDir = emptyGit;
    const out = await check(s, "DF5.4-C5");
    expectOutcomeFail(out, `refs/sandbox/${RUN_ID}`, emptyGit);
  });
});

describe("C6 mutants (host-side re-verify)", () => {
  test("reverify file deleted → C6 skips naming the jsonl path", async () => {
    const s = boundScratch();
    fs.rmSync(rvPath(s));
    const out = await check(s, "DF5.4-C6");
    expectOutcomeSkip(out, rvPath(s));
  });

  test("bound reportId resolves to no line → C6 skips naming id + path", async () => {
    const s = boundScratch();
    editRecord(s, (rec) => {
      rec.extensions.approval.reportId = "rv-not-in-file";
    });
    const out = await check(s, "DF5.4-C6");
    expectOutcomeSkip(out, "bound-report-absent:rv-not-in-file", rvPath(s));
  });

  test("bound id listed in supersededReportIds → C6 skips naming the reason", async () => {
    const s = boundScratch();
    editRecord(s, (rec) => {
      rec.extensions.approval.supersededReportIds = [BOUND_ID];
    });
    const out = await check(s, "DF5.4-C6");
    expectOutcomeSkip(out, `bound-report-superseded:${BOUND_ID}`);
  });

  test("bound verdict red → C6 fails naming the verdict (two-layer doctrine)", async () => {
    const s = boundScratch();
    editBoundReport(s, (rep) => {
      rep.verdict = "red";
    });
    const out = await check(s, "DF5.4-C6");
    expectOutcomeFail(out, 'verdict=red', '"green"');
  });

  test("bound verdict error → C6 fails naming the verdict", async () => {
    const s = boundScratch();
    editBoundReport(s, (rep) => {
      rep.verdict = "error";
    });
    const out = await check(s, "DF5.4-C6");
    expectOutcomeFail(out, "verdict=error");
  });

  test("completedAt AFTER pr.createdAt → C6 fails on F10 (existence-only impls fail here)", async () => {
    const s = boundScratch();
    const afterPr = new Date(Date.parse(prCreatedAt(s)) + 1000).toISOString();
    editBoundReport(s, (rep) => {
      rep.completedAt = afterPr;
    });
    const out = await check(s, "DF5.4-C6");
    expectOutcomeFail(out, "F10", afterPr);
  });

  test("EQUALITY stamps → C6 fails (equality is a violation, never a pass)", async () => {
    const s = boundScratch();
    editBoundReport(s, (rep) => {
      rep.completedAt = prCreatedAt(s);
    });
    const out = await check(s, "DF5.4-C6");
    expectOutcomeFail(out, "F10");
  });

  test("non-canonical stamp → C6 fails naming the non-canonical value", async () => {
    const s = boundScratch();
    editBoundReport(s, (rep) => {
      // Parses as an instant but is not canonical ISO — not orderable host-side.
      rep.completedAt = "2026-09-18T02:49:31.080+00:00";
    });
    const out = await check(s, "DF5.4-C6");
    expectOutcomeFail(out, "canonical", "2026-09-18T02:49:31.080+00:00");
  });
});

describe("C7 mutants (approval)", () => {
  test("decidedAt after pr.createdAt → C7 fails while C6 stays green", async () => {
    const s = boundScratch();
    const afterPr = new Date(Date.parse(prCreatedAt(s)) + 5000).toISOString();
    editRecord(s, (rec) => {
      rec.extensions.approval.decidedAt = afterPr;
    });
    const c6 = await check(s, "DF5.4-C6");
    expectOutcomePass(c6);
    const out = await check(s, "DF5.4-C7");
    expectOutcomeFail(out, "F10", afterPr);
  });

  test("decidedAt equals bound completedAt → C7 fails (strict ordering)", async () => {
    const s = boundScratch();
    editRecord(s, (rec) => {
      rec.extensions.approval.decidedAt = "2026-09-18T02:49:31.080Z";
    });
    const out = await check(s, "DF5.4-C7");
    expectOutcomeFail(out, "F10", "2026-09-18T02:49:31.080Z");
  });

  test("state awaiting-approval → C7 fails (non-terminal state)", async () => {
    const s = boundScratch();
    editRecord(s, (rec) => {
      rec.extensions.approval.state = "awaiting-approval";
    });
    const out = await check(s, "DF5.4-C7");
    expectOutcomeFail(out, "state=awaiting-approval", '"approved"');
  });

  test("approverId missing → C7 fails", async () => {
    const s = boundScratch();
    editRecord(s, (rec) => {
      rec.extensions.approval.approverId = undefined;
    });
    const out = await check(s, "DF5.4-C7");
    expectOutcomeFail(out, "approverId");
  });

  test("decidedAt missing → C7 fails", async () => {
    const s = boundScratch();
    editRecord(s, (rec) => {
      rec.extensions.approval.decidedAt = undefined;
    });
    const out = await check(s, "DF5.4-C7");
    expectOutcomeFail(out, "decidedAt");
  });

  test("approval-shaped file on disk + no extensions.approval → C7 FAILS (fs-reading impl must not pass)", async () => {
    const s = boundScratch();
    fs.mkdirSync(join(s.root, ".sandbox", "approvals"), { recursive: true });
    fs.writeFileSync(
      join(s.root, ".sandbox", "approvals", `${RUN_ID}.json`),
      JSON.stringify({ state: "approved", approverId: "ghost", decidedAt: "2026-09-18T02:49:51.924Z" }),
    );
    editRecord(s, (rec) => {
      rec.extensions.approval = undefined;
    });
    const out = await check(s, "DF5.4-C7");
    expectOutcomeFail(out, "extensions.approval");
  });
});

describe("C8 mutants (PR body shape)", () => {
  test("pr-body missing → C8 skips naming the path", async () => {
    const s = boundScratch();
    fs.rmSync(s.prBodyFile);
    const out = await check(s, "DF5.4-C8");
    expectOutcomeSkip(out, s.prBodyFile);
  });

  test("no Issue: line → C8 fails", async () => {
    const s = boundScratch();
    editPrBody(s, (lines) => lines.filter((l) => !/^Issue:/.test(l)));
    const out = await check(s, "DF5.4-C8");
    expectOutcomeFail(out, "Issue:");
  });

  test("Issue: unresolved → C8 PASSES (shape, never mapping quality)", async () => {
    const s = boundScratch();
    editPrBody(s, (lines) => lines.map((l) => l.replace(/^Issue: .*$/, "Issue: unresolved")));
    const out = await check(s, "DF5.4-C8");
    expectOutcomePass(out);
  });

  test("no cost line → C8 fails", async () => {
    const s = boundScratch();
    editPrBody(s, (lines) => lines.filter((l) => !/cost/i.test(l)));
    const out = await check(s, "DF5.4-C8");
    expectOutcomeFail(out, "cost");
  });

  test("runId absent from body → C8 fails", async () => {
    const s = boundScratch();
    editPrBody(s, (lines) => lines.map((l) => l.replaceAll(RUN_ID, "qds-some-other-run")));
    const out = await check(s, "DF5.4-C8");
    expectOutcomeFail(out, RUN_ID);
  });
});

describe("edge hunt — untrusted record, append-only jsonl", () => {
  test("LAST line red but bound report earlier+green → C6 (and C7) still pass — bound-only selection", async () => {
    const s = boundScratch();
    const later = cloneBoundReport(s);
    later.reverifyId = "rv-qds-20260918-cc93a3-later-red";
    later.verdict = "red";
    later.completedAt = "2026-09-18T02:49:40.000Z";
    appendReportLine(s, later);
    expectOutcomePass(await check(s, "DF5.4-C6"), BOUND_ID);
    expectOutcomePass(await check(s, "DF5.4-C7"));
  });

  test("extensions.approval absent entirely → C6 skips cleanly, C7 fails cleanly", async () => {
    const s = boundScratch();
    editRecord(s, (rec) => {
      rec.extensions.approval = undefined;
    });
    expectOutcomeSkip(await check(s, "DF5.4-C6"), "approval");
    expectOutcomeFail(await check(s, "DF5.4-C7"), "extensions.approval");
  });
});

// ===========================================================================
// df5-accounting (C9, C10, V1) - leaf-1.1.5
// ===========================================================================

/** Every scratch this file creates, removed in afterAll. */
const scratches: string[] = [];

interface ScratchOptions {
  /** Remove audit.db from the copy (C9's absent-store arm). */
  withoutAuditDb?: boolean;
  /** Read-write mutation of the copied audit.db (triggers may be dropped). */
  mutateAuditDb?: (db: Database) => void;
  /** Mutation of the copied run record AFTER JSON.parse, re-serialized. */
  mutateRecord?: (record: Record<string, unknown>) => void;
  /** Mutation of the copied cost-ledger.db (triggers may be dropped). */
  mutateLedger?: (db: Database) => void;
  /** Leave a fabricated hot `-wal` beside the copied ledger. */
  fabricateWal?: boolean;
}

/**
 * Copies the frozen fixture into a fresh mkdtemp scratch, renames the frozen
 * `<run>.reverify.jsonl` to the `<reverifyDir>/<run>.jsonl` layout the walker
 * expects, and applies the arm's mutations. Returns the seam set.
 */
function makeScratch(opts: ScratchOptions = {}): Df5AccountingDeps {
  const root = mkdtempSync(join(os.tmpdir(), "df5-accounting-"));
  scratches.push(root);
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.mkdirSync(join(root, "reverify"), { recursive: true });
  fs.renameSync(join(root, `${RUN_ID}.reverify.jsonl`), join(root, "reverify", `${RUN_ID}.jsonl`));
  if (opts.withoutAuditDb) fs.rmSync(join(root, "audit.db"));
  if (opts.mutateAuditDb) {
    const db = new Database(join(root, "audit.db"));
    opts.mutateAuditDb(db);
    db.close();
  }
  if (opts.mutateRecord) {
    const file = join(root, `${RUN_ID}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; // dp:ok - parses a file this test wrote; a throw is the red test
    opts.mutateRecord(record);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  if (opts.mutateLedger) {
    const db = new Database(join(root, "cost-ledger.db"));
    opts.mutateLedger(db);
    db.close();
  }
  if (opts.fabricateWal) {
    // A non-empty -wal with no -shm sibling is exactly DF2.11's hot-WAL
    // refusal shape; the bytes need not be a valid WAL because the read path
    // refuses BEFORE attaching.
    fs.writeFileSync(join(root, "cost-ledger.db-wal"), "not-a-real-wal-frame");
  }
  return {
    runId: RUN_ID,
    runsDir: root,
    auditDb: join(root, "audit.db"),
    ledger: join(root, "cost-ledger.db"),
    reverifyDir: join(root, "reverify"),
  };
}

afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// auditChainReport — the pure ChainReport shape checker (C9's depth, unit level)
// ---------------------------------------------------------------------------

/** A synthetic resolved hop; linkId/detail overridden per test. */
function resolved(hop: string, extra: Partial<Extract<HopOutcome, { status: "resolved" }>> = {}): HopOutcome {
  return { status: "resolved", hop: hop as HopOutcome["hop"], runId: RUN_ID, subjectId: "subj", ...extra };
}

/** The three hops whose emitted audit_links rows C9 requires by name. */
const LINK_BEARING = new Set(["run-credential", "run-box", "run-bundle"]);

function synthReport(overrides: {
  runId?: string | null;
  perHop?: (hop: string, base: HopOutcome) => HopOutcome;
  hops?: Record<string, HopOutcome>;
  extraHop?: string;
  dropHop?: string;
} = {}): ChainReport {
  const base = Object.fromEntries(
    AUDIT_HOPS.map((hop) => {
      const b: HopOutcome =
        hop === "memory-retain-receipt"
          ? { status: "void", hop, reason: OQ4_VOID_REASON }
          : LINK_BEARING.has(hop)
            ? resolved(hop, { linkId: 3711 })
            : resolved(hop);
      return [hop, overrides.perHop ? overrides.perHop(hop, b) : b];
    }),
  ) as Record<string, HopOutcome>;
  const hops = { ...(overrides.hops ?? base) };
  if (overrides.dropHop) delete hops[overrides.dropHop];
  if (overrides.extraHop) hops[overrides.extraHop] = resolved(overrides.extraHop);
  return {
    ref: RUN_ID,
    refKind: "run-id",
    generatedAt: "2026-09-18T02:50:00.000Z",
    complete: true,
    timings: { prFetchMs: 1, perHopMs: {} },
    runs: {
      [RUN_ID]: {
        runId: overrides.runId === undefined ? RUN_ID : overrides.runId,
        complete: true,
        hops: hops as Record<(typeof AUDIT_HOPS)[number], HopOutcome>,
      },
    },
  };
}

describe("auditChainReport — synthetic shape mutants", () => {
  test("green synthetic ten-hop chain yields zero violations", () => {
    expect(auditChainReport(synthReport(), RUN_ID)).toEqual([]);
  });

  test("credential link ids counted from detail.linkIds when linkId is absent", () => {
    // The (e) arm's second counting path: an emitted link row id surfaced as
    // detail.linkIds rather than a top-level linkId.
    const report = synthReport({
      perHop: (hop, base) =>
        hop === "run-box" && base.status === "resolved"
          ? { ...base, detail: { linkIds: [41, 42] } }
          : hop === "run-bundle" && base.status === "resolved"
            ? { ...base, detail: { linkIds: [7] } }
            : base,
    });
    expect(auditChainReport(report, RUN_ID)).toEqual([]);
  });

  test("missing credential link rows (unlinked hop) violates, naming the hop and status", () => {
    const report = synthReport({
      perHop: (hop, base) =>
        hop === "run-credential"
          ? { status: "unlinked", hop, emitter: "mintRunKey", diagnostic: "no audit_links row" }
          : hop === "memory-retain-receipt"
            ? { status: "void", hop, reason: OQ4_VOID_REASON }
            : base,
    });
    const violations = auditChainReport(report, RUN_ID);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("run-credential");
    expect(violations[0]).toContain("unlinked");
  });

  test("resolved credential hop with NEITHER linkId NOR detail.linkIds violates", () => {
    // The depth mutant's exact shape if the walker still resolves the hop but
    // the link rows carry no id: resolved, green status, zero link evidence.
    const report = synthReport({ perHop: (hop, base) => (hop === "run-credential" ? { ...base, linkId: undefined } : base) });
    const violations = auditChainReport(report, RUN_ID);
    expect(violations.join("; ")).toContain("run-credential");
  });

  test.each(["broken", "unlinked", "hop-timeout", "evidence-mismatch", "evidence-not-harvested"] as const)(
    "hop status %s violates",
    (status) => {
      const report = synthReport({
        perHop: (hop) =>
          hop === "run-cost"
            ? ({ status, hop, reason: "x", expected: "e", actual: "a", diagnostic: "d", evidencePath: "p", emitter: "em", ceilingMs: 1, elapsedMs: 1, budget: "hop", expectedDigest: "ed", actualDigest: "ad" } as HopOutcome)
            : hop === "memory-retain-receipt"
              ? { status: "void", hop, reason: OQ4_VOID_REASON }
              : resolved(hop),
      });
      expect(auditChainReport(report, RUN_ID).join("; ")).toContain(`run-cost: status ${status}`);
    },
  );

  test("not-applicable on a link-bearing hop violates the emitted-link requirement", () => {
    const report = synthReport({
      perHop: (hop) =>
        hop === "run-box" ? { status: "not-applicable", hop, reason: "no box" } : hop === "memory-retain-receipt" ? { status: "void", hop, reason: OQ4_VOID_REASON } : resolved(hop),
    });
    expect(auditChainReport(report, RUN_ID).join("; ")).toContain("run-box");
  });

  test("nine-hop chain violates, naming the expected count of ten", () => {
    const report = synthReport({ dropHop: "run-cost" });
    const violations = auditChainReport(report, RUN_ID);
    expect(violations.some((v) => v.includes("9") && v.includes("10"))).toBe(true);
    expect(violations.some((v) => v.includes("run-cost") && v.includes("missing"))).toBe(true);
  });

  test("eleven-hop chain violates", () => {
    const report = synthReport({ extraHop: "run-extra" });
    expect(auditChainReport(report, RUN_ID).some((v) => v.includes("11"))).toBe(true);
  });

  test("hop 10 not void violates", () => {
    const report = synthReport();
    report.runs[RUN_ID]!.hops["memory-retain-receipt"] = resolved("memory-retain-receipt");
    const violations = auditChainReport(report, RUN_ID);
    expect(violations.some((v) => v.includes("memory-retain-receipt") && v.includes("void"))).toBe(true);
  });

  test("runs map without the parent runId violates (fallback key holds prUrl, runId null)", () => {
    const report = synthReport({ runId: null });
    const chain = report.runs[RUN_ID]!;
    report.runs = { "https://github.com/Quantum-Digital-Solutions/qds-audit-demo/pull/10": chain };
    const violations = auditChainReport(report, RUN_ID);
    expect(violations.some((v) => v.includes(RUN_ID))).toBe(true);
  });

  test("every violation under EVERY key, not just the parent", () => {
    const report = synthReport();
    const fixKey = { ...report.runs[RUN_ID]! };
    const brokenFix = {
      runId: "qds-fix-attempt-1",
      complete: false,
      hops: { ...fixKey.hops, "run-credential": { status: "broken", hop: "run-credential", expected: "e", actual: "a", diagnostic: "d" } as HopOutcome },
    };
    report.runs["qds-fix-attempt-1"] = brokenFix;
    expect(auditChainReport(report, RUN_ID).some((v) => v.includes("qds-fix-attempt-1"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-GATE-2 — stderr tail bounding + token scrubbing
// ---------------------------------------------------------------------------

describe("boundStderrTail / scrubSecrets — INV-GATE-2 redaction", () => {
  test("obvious token shapes never survive the scrub", () => {
    const poisoned = [
      "token ghp_0123456789abcdefghijklmnopqrstuv leaked",
      "pat github_pat_11AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq",
      "key sk-proj-abcdefghijklmnop1234567890 and sk_ant-xyz",
      "slack xoxb-1234567890abcdefghijklmn",
      "aws AKIAABCDEFGHIJKLMNOP",
    ].join("\n");
    const scrubbed = scrubSecrets(poisoned);
    expect(scrubbed).not.toContain("ghp_0123456789");
    expect(scrubbed).not.toContain("github_pat_11Aa");
    expect(scrubbed).not.toContain("sk-proj-abc");
    expect(scrubbed).not.toContain("xoxb-123456");
    expect(scrubbed).not.toContain("AKIAABCDEFGHIJ");
    expect(scrubbed).toContain("[redacted]");
  });

  test("ordinary diagnostics pass through untouched", () => {
    const text = "audit-store-absent: no audit store at /tmp/x/audit.db";
    expect(scrubSecrets(text)).toBe(text);
  });

  test("tail is bounded to ~400 chars even for a 10 KB stderr", () => {
    const huge = `${"x".repeat(10_000)} ghp_0123456789abcdefghijklmn tail-marker`;
    const tail = boundStderrTail(huge);
    expect(tail.length).toBeLessThanOrEqual(430);
    expect(tail).toContain("tail-marker");
    expect(tail).not.toContain("ghp_0123456789");
  });
});

// ---------------------------------------------------------------------------
// DF5.4-C9 — spawned walk (integration)
// ---------------------------------------------------------------------------

describe("DF5.4-C9 — spawned qds-audit walk", () => {
  test("happy path: frozen run of record walks green end-to-end", async () => {
    const deps = makeScratch();
    const [c9] = df5AccountingAssertions(deps).filter((a) => a.id === "DF5.4-C9");
    expect(c9).toBeDefined();
    const outcome = await c9!.check();
    expect(outcome).toEqual({ pass: true, detail: expect.stringContaining("ten-hop") });
  }, 90_000);

  test("absent audit.db: FAIL (not skip) naming audit-store-absent, and the file is STILL absent (INV-GATE-1)", async () => {
    const deps = makeScratch({ withoutAuditDb: true });
    const [c9] = df5AccountingAssertions(deps).filter((a) => a.id === "DF5.4-C9");
    const outcome = await c9!.check();
    expect(outcome.pass).toBe(false);
    expect(outcome.skip).toBeUndefined();
    expect(outcome.detail).toContain("audit-store-absent");
    expect(outcome.detail).toContain("2"); // the walker's exit code is named too
    expect(fs.existsSync(deps.auditDb)).toBe(false); // no-create proof
  }, 90_000);

  test("depth mutant: run-credential link rows deleted from the scratch audit.db — C9 fails naming the hop", async () => {
    const deps = makeScratch({
      mutateAuditDb: (db) => {
        // INV-AUDIT-4 triggers guard the real store; a mutant drops them on
        // the COPY only — the fixture itself is never touched.
        for (const t of db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]) {
          db.run(`DROP TRIGGER "${t.name}"`);
        }
        db.run("DELETE FROM audit_links WHERE hop = 'run-credential'");
      },
    });
    const [c9] = df5AccountingAssertions(deps).filter((a) => a.id === "DF5.4-C9");
    const outcome = await c9!.check();
    expect(outcome.pass).toBe(false);
    expect(outcome.detail).toContain("run-credential");
  }, 90_000);
});

// ---------------------------------------------------------------------------
// DF5.4-C10 — ledger + budget
// ---------------------------------------------------------------------------

describe("DF5.4-C10 — read-only ledger + separate spend meter", () => {
  test("green on the frozen ledger: hasEvents, non-zero total, spend under ceiling", async () => {
    const deps = makeScratch();
    const [c10] = df5AccountingAssertions(deps).filter((a) => a.id === "DF5.4-C10");
    const outcome = await c10!.check();
    expect(outcome).toEqual({ pass: true, detail: expect.any(String) });
    // INV-GATE-2: aggregate meters only — no per-role or per-token figures.
    expect(outcome.detail).not.toContain("perRole");
    expect(outcome.detail).not.toContain("inputTokens");
    expect(outcome.detail).not.toContain("outputTokens");
    expect(outcome.detail).toContain("µ$");
  }, 30_000);

  test("absent ledger: skip naming the path AND the code, and NO file is created", async () => {
    const deps = makeScratch();
    const absent = join(deps.runsDir, "no-such-ledger.db");
    const [c10] = df5AccountingAssertions({ ...deps, ledger: absent }).filter((a) => a.id === "DF5.4-C10");
    const outcome = await c10!.check();
    expect(outcome.pass).toBe(false);
    expect(outcome.skip).toBe(true);
    expect(outcome.detail).toContain(absent);
    expect(outcome.detail).toContain("ledger-absent");
    expect(fs.existsSync(absent)).toBe(false); // the constructor never ran
  }, 30_000);

  test("hot-WAL shape: skip naming ledger-wal-recovery-required", async () => {
    const deps = makeScratch({ fabricateWal: true });
    const [c10] = df5AccountingAssertions(deps).filter((a) => a.id === "DF5.4-C10");
    const outcome = await c10!.check();
    expect(outcome.skip).toBe(true);
    expect(outcome.detail).toContain("ledger-wal-recovery-required");
    expect(outcome.detail).toContain(deps.ledger);
  }, 30_000);

  test("zero totalMicroUsd with events present: fail naming the total", async () => {
    const deps = makeScratch({
      mutateLedger: (db) => {
        db.run("DROP TRIGGER cost_events_no_update");
        db.run("UPDATE cost_events SET cost_micro_usd = 0 WHERE run_id = ?", [RUN_ID]);
      },
    });
    const [c10] = df5AccountingAssertions(deps).filter((a) => a.id === "DF5.4-C10");
    const outcome = await c10!.check();
    expect(outcome.pass).toBe(false);
    expect(outcome.skip).toBeUndefined();
    expect(outcome.detail).toContain("total");
  }, 30_000);

  test("no ledger events for the run: fail naming hasEvents", async () => {
    const deps = makeScratch({
      mutateLedger: (db) => {
        db.run("DROP TRIGGER cost_events_no_delete");
        db.run("DELETE FROM cost_events WHERE run_id = ?", [RUN_ID]);
      },
    });
    const [c10] = df5AccountingAssertions(deps).filter((a) => a.id === "DF5.4-C10");
    const outcome = await c10!.check();
    expect(outcome.pass).toBe(false);
    expect(outcome.detail).toContain("hasEvents");
  }, 30_000);

  test("record spendMicroUsd over admittedCeilingMicroUsd: fail (record mutant)", async () => {
    const deps = makeScratch({
      mutateRecord: (record) => {
        (record as { spendMicroUsd?: number }).spendMicroUsd = 50_001; // ceiling is 50000
      },
    });
    const [c10] = df5AccountingAssertions(deps).filter((a) => a.id === "DF5.4-C10");
    const outcome = await c10!.check();
    expect(outcome.pass).toBe(false);
    expect(outcome.detail).toContain("admittedCeilingMicroUsd");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// DF5.4-V1 — VOID parity
// ---------------------------------------------------------------------------

describe("DF5.4-V1 — VOID with the imported reason", () => {
  function v1() {
    const deps = makeScratch();
    return { deps, assertion: df5AccountingAssertions(deps).find((a) => a.id === "DF5.4-V1")! };
  }

  test("void_reason is the imported OQ4_VOID_REASON, byte-identically", () => {
    const { assertion } = v1();
    expect(assertion.void_reason).toBe(OQ4_VOID_REASON);
    expect(assertion.void_reason).toContain("OQ-4 unresolved");
  });

  test("check never invoked and no void_reason key reaches the report (chassis parity)", async () => {
    const { assertion } = v1();
    let invoked = 0;
    const wrapped = { ...assertion, check: async () => { invoked++; return { pass: true }; } };
    const report = await runGate([wrapped], { assertionTimeoutMs: 1_000, totalTimeoutMs: 5_000 });
    const row = report.assertions.find((r) => r.id === "DF5.4-V1")!;
    expect(invoked).toBe(0); // the chassis contract: presence ⇒ never invoked
    expect(row.status).toBe("void");
    expect(row.pass).toBe(false);
    expect(row.detail).toBe(`VOID — ${OQ4_VOID_REASON}`);
    expect(Object.keys(row)).not.toContain("void_reason");
    expect(JSON.stringify(report)).not.toContain("void_reason");
  });

  test("a copied string literal would fail: the module IMPORTS the constant (grep parity)", () => {
    const source = fs.readFileSync(join(REPO, "src/gate/assertions/df5-accounting.ts"), "utf8");
    expect(source).toMatch(/import\s*\{[^}]*OQ4_VOID_REASON[^}]*\}\s*from\s*["'][^"']*audit\/index\.ts["']/);
    // ChainReport is imported too, never re-declared (C9's parse target).
    expect(source).toMatch(/import\s*(type\s*)?\{[^}]*ChainReport[^}]*\}\s*from\s*["'][^"']*audit\/index\.ts["']/);
    expect(source).not.toMatch(/(interface|type)\s+ChainReport\s*[={]/);
  });
});
