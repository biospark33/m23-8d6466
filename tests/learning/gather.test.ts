import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GatherFault, gatherEvidence, MAX_KPI_SNAPSHOTS, MAX_RUN_RECORDS } from "../../src/learning/gather.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gather-evidence-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pathSet = () => ({
  routingLogPath: join(root, "routing-log.jsonl"),
  kpiSnapshotsDir: join(root, "kpi-snapshots"),
  runsDir: join(root, "runs"),
});

const routingLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    workKey: "w:42",
    runId: "qds-20261011-000001",
    shape: "single-story",
    risk_tier: "low",
    applied_tier: "t1",
    score: { complexity: 0.4 },
    jev_recommendation: null,
    created_at: "2026-10-11T00:00:00.000Z",
    ...over,
  });

const seedRoutingLog = (lines: string[]) => writeFileSync(pathSet().routingLogPath, `${lines.join("\n")}\n`);

const seedKpiSnapshots = (bodies: Record<string, unknown>) => {
  const dir = pathSet().kpiSnapshotsDir;
  mkdirSync(dir);
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(dir, name), JSON.stringify(body));
};

const seedRuns = (names: string[]) => {
  const dir = pathSet().runsDir;
  mkdirSync(dir);
  for (const name of names) {
    writeFileSync(join(dir, name), JSON.stringify({ runId: name.replace(/\.json$/, ""), createdAt: "2026-10-11T00:00:00.000Z" }));
  }
};

const sha = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Whole-store byte + listing fingerprint: every seeded file's content hash and each dir's entry names. */
const storeFingerprint = (): string => {
  const { routingLogPath, kpiSnapshotsDir, runsDir } = pathSet();
  const capture: Record<string, string> = {};
  const captureFile = (p: string) => {
    capture[p] = sha(readFileSync(p));
  };
  const captureNames = (d: string) => {
    capture[`dir:${d}`] = readdirSync(d).sort().join(",");
  };
  captureFile(routingLogPath);
  captureNames(kpiSnapshotsDir);
  captureNames(runsDir);
  for (const name of readdirSync(kpiSnapshotsDir).sort()) captureFile(join(kpiSnapshotsDir, name));
  for (const name of readdirSync(runsDir).sort()) captureFile(join(runsDir, name));
  return JSON.stringify(capture);
};

const faultOf = (run: () => unknown): GatherFault => {
  try {
    run();
  } catch (e) {
    if (e instanceof GatherFault) return e;
    throw e;
  }
  throw new Error("expected a GatherFault, none thrown");
};

// ─── absence law ─────────────────────────────────────────────────────────────

describe("gatherEvidence — absence typing", () => {
  test("all three inputs absent → three typed absences, zero entries, no throw", () => {
    const ev = gatherEvidence(pathSet());
    expect(ev.absentSources).toEqual([
      { source: "routing-log", status: "absent" },
      { source: "kpi-snapshots", status: "absent" },
      { source: "run-records", status: "absent" },
    ]);
    expect(ev.routingLines).toEqual([]);
    expect(ev.kpiSnapshots).toEqual([]);
    expect(ev.runRecords).toEqual([]);
    expect(readdirSync(root).sort()).toEqual([]); // nothing created
  });

  test("kpi snapshots dir absent while others present → one absence entry, others filled", () => {
    seedRoutingLog([routingLine()]);
    seedRuns(["qds-20261011-000001.json"]);
    const ev = gatherEvidence(pathSet());
    expect(ev.absentSources).toEqual([{ source: "kpi-snapshots", status: "absent" }]);
    expect(ev.routingLines).toHaveLength(1);
    expect(ev.runRecords).toHaveLength(1);
  });

  test("empty-but-existing routing log file → zero lines, no absence entry", () => {
    writeFileSync(pathSet().routingLogPath, "");
    const ev = gatherEvidence(pathSet());
    expect(ev.routingLines).toEqual([]);
    expect(ev.absentSources.map((a) => a.source)).toEqual(["kpi-snapshots", "run-records"]);
  });
});

// ─── routing log parsing ─────────────────────────────────────────────────────

describe("gatherEvidence — routing log (J3 field set)", () => {
  test("3 valid lines parse with full field set (workKey, issueId, jev_skipped spellings)", () => {
    seedRoutingLog([
      routingLine(),
      routingLine({ workKey: undefined, issueId: 42, runId: "qds-20261011-000002" }),
      routingLine({
        workKey: undefined,
        issueId: "43",
        runId: "qds-20261011-000003",
        jev_recommendation: "t2",
        jev_requestId: "req-1",
      }),
      routingLine({
        workKey: undefined,
        issueId: "44",
        runId: "qds-20261011-000004",
        jev_recommendation: null,
        jev_skipped: { reason: "timeout" },
      }),
    ]);
    const ev = gatherEvidence(pathSet());
    expect(ev.absentSources.map((a) => a.source)).toEqual(["kpi-snapshots", "run-records"]);
    expect(ev.routingLines).toHaveLength(4);
    expect(ev.routingLines[0]!).toMatchObject({ workKey: "w:42", applied_tier: "t1", score: { complexity: 0.4 } });
    expect(ev.routingLines[1]!.issueId).toBe(42);
    expect(ev.routingLines[2]!.jev_requestId).toBe("req-1");
    expect(ev.routingLines[3]!.jev_skipped).toEqual({ reason: "timeout" });
  });

  test("torn final line (cut mid-JSON) tolerated and dropped, valid lines kept", () => {
    const torn = '{"runId": "qds-20261011-000009", "shape": "singl';
    writeFileSync(pathSet().routingLogPath, [routingLine(), routingLine(), torn].join("\n")); // no trailing newline
    const ev = gatherEvidence(pathSet());
    expect(ev.routingLines).toHaveLength(2);
    expect(ev.absentSources.map((a) => a.source)).toEqual(["kpi-snapshots", "run-records"]);
  });

  test("corrupt MID-FILE line faults routing-log-invalid", () => {
    seedRoutingLog([routingLine(), "this is not json {", routingLine()]);
    const fault = faultOf(() => gatherEvidence(pathSet()));
    expect(fault.code).toBe("routing-log-invalid");
    expect(fault.remediation).toContain("torn final line");
  });

  test("leading UTF-8 BOM stripped — single-line log still parses (F-015)", () => {
    writeFileSync(pathSet().routingLogPath, `\uFEFF${routingLine()}`);
    const ev = gatherEvidence(pathSet());
    expect(ev.routingLines).toHaveLength(1);
    expect(ev.absentSources.map((a) => a.source)).toEqual(["kpi-snapshots", "run-records"]);
  });

  test("leading UTF-8 BOM stripped — multi-line log does not fault as a corrupt first line (F-015)", () => {
    writeFileSync(pathSet().routingLogPath, `\uFEFF${[routingLine(), routingLine({ runId: "qds-20261011-000002" })].join("\n")}\n`);
    const ev = gatherEvidence(pathSet());
    expect(ev.routingLines).toHaveLength(2);
  });

  test("store path beneath a FILE parent (ENOTDIR) → typed absence, not a throw (F-016)", () => {
    writeFileSync(join(root, "not-a-dir"), "x"); // the "touch .sandbox" misprovisioning
    const blocked = {
      routingLogPath: join(root, "not-a-dir", "routing-log.jsonl"),
      kpiSnapshotsDir: join(root, "not-a-dir", "kpi-snapshots"),
      runsDir: join(root, "not-a-dir", "runs"),
    };
    const ev = gatherEvidence(blocked);
    expect(ev.absentSources).toEqual([
      { source: "routing-log", status: "absent" },
      { source: "kpi-snapshots", status: "absent" },
      { source: "run-records", status: "absent" },
    ]);
    expect(ev.routingLines).toEqual([]);
  });

  test("well-formed JSON refusing the strict schema faults mid-file (unknown field, severity-style)", () => {
    seedRoutingLog([
      routingLine(),
      routingLine({ severity: "high", runId: "qds-20261011-000008" }),
      routingLine(),
    ]);
    const fault = faultOf(() => gatherEvidence(pathSet()));
    expect(fault.code).toBe("routing-log-invalid");
  });
});

// ─── snapshots + run records ─────────────────────────────────────────────────

describe("gatherEvidence — snapshots and run records", () => {
  test("kpi snapshots read sorted by name, ref = filename, snapshot kept unknown", () => {
    seedKpiSnapshots({
      "2026-10-05T00-00-00-000Z.json": { week: "2026-W41", cost: 12 },
      "2026-10-04T00-00-00-000Z.json": { week: "2026-W40" },
    });
    const ev = gatherEvidence(pathSet());
    expect(ev.kpiSnapshots.map((s) => s.ref)).toEqual(["2026-10-04T00-00-00-000Z.json", "2026-10-05T00-00-00-000Z.json"]);
    expect(ev.kpiSnapshots[0]!.snapshot).toEqual({ week: "2026-W40" });
  });

  test("stray non-stamp *.json files are not evidence; snapshots bounded to the most recent 50 by name (F-022)", () => {
    seedKpiSnapshots({ "notes.json": { hostile: true } });
    const stamps = Array.from(
      { length: 55 },
      (_, i) => `2026-10-01T${String(Math.floor(i / 2)).padStart(2, "0")}-${String((i % 2) * 30).padStart(2, "0")}-00-000Z.json`,
    );
    const dir = pathSet().kpiSnapshotsDir;
    for (const name of stamps) writeFileSync(join(dir, name), "{}");
    const ev = gatherEvidence(pathSet());
    expect(ev.kpiSnapshots.every((s) => s.ref !== "notes.json")).toBe(true);
    expect(MAX_KPI_SNAPSHOTS).toBe(50);
    expect(ev.kpiSnapshots).toHaveLength(50);
    expect(ev.kpiSnapshots[0]!.ref).toBe(stamps[5]!); // first 5 dropped, most recent 50 kept
  });

  test("foreign names in the runs dir never crowd the recency window (F-019)", () => {
    seedRuns(["qds-20261011-000001.json"]);
    writeFileSync(join(pathSet().runsDir, "zzz-notes.json"), "{}");
    writeFileSync(join(pathSet().runsDir, "runs-index.json"), "{}");
    const ev = gatherEvidence(pathSet());
    expect(ev.runRecords.map((r) => r.ref)).toEqual(["qds-20261011-000001.json"]);
  });

  test("runs dir read bounded to the most-recent 50 by name; temp spellings excluded", () => {
    const names = Array.from({ length: 55 }, (_, i) => `qds-20261001-${String(i).padStart(4, "0")}.json`);
    seedRuns(names);
    writeFileSync(join(pathSet().runsDir, "qds-20261002-000001.json.lock.999.abc12345.tmp"), "{}");
    const ev = gatherEvidence(pathSet());
    expect(MAX_RUN_RECORDS).toBe(50);
    expect(ev.runRecords).toHaveLength(50);
    const refs = ev.runRecords.map((r) => r.ref);
    expect(refs[0]).toBe("qds-20261001-0005.json"); // first 5 dropped, most recent 50 kept
    expect(refs.at(-1)).toBe("qds-20261001-0054.json");
    expect(refs.some((r) => r.includes(".tmp"))).toBe(false);
  });

  test("unparsable run record faults run-record-invalid; unparsable snapshot faults kpi-snapshot-invalid", () => {
    seedRuns(["qds-20261011-000001.json"]);
    writeFileSync(join(pathSet().runsDir, "qds-20261011-000002.json"), "{torn");
    const runFault = faultOf(() => gatherEvidence(pathSet()));
    expect(runFault.code).toBe("run-record-invalid");

    seedKpiSnapshots({ "2026-10-05T00-00-00-000Z.json": { ok: true } });
    writeFileSync(join(pathSet().kpiSnapshotsDir, "2026-10-05T00-00-00-000Z.json"), "{torn");
    const snapFault = faultOf(() => gatherEvidence(pathSet()));
    expect(snapFault.code).toBe("kpi-snapshot-invalid");
  });
});

// ─── read-only guarantee (C4) ────────────────────────────────────────────────

describe("gatherEvidence — read-only proof", () => {
  test("consumed stores byte-identical (content hashes + dir listings) after gather", () => {
    seedRoutingLog([routingLine(), routingLine({ runId: "qds-20261011-000002" })]);
    seedKpiSnapshots({ "2026-10-05T00-00-00-000Z.json": { week: "2026-W41" } });
    seedRuns(["qds-20261011-000001.json", "qds-20261011-000002.json"]);
    const before = storeFingerprint();
    const ev = gatherEvidence(pathSet());
    expect(ev.routingLines).toHaveLength(2);
    expect(ev.kpiSnapshots).toHaveLength(1);
    expect(ev.runRecords).toHaveLength(2);
    expect(ev.absentSources).toEqual([]);
    expect(storeFingerprint()).toBe(before);
  });
});
