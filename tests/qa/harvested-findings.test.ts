/**
 * #467 — a QA hunt phase's findings persist beside the marker in-box
 * (findings-sidecar.ts), ride the artifacts pull home, and the host reader
 * (harvested-findings.ts) feeds normalizeHarvest → retainFindings. Every hop
 * below is merged code; only the box→host tar copy is simulated, by writing
 * the sidecar beside a marker path laid out the way the pull lands it
 * (`<runsDir>/<runId>-artifacts/journal/`, harvest.ts BOX_RUN_SOURCES).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMergedOutput, validateWorkerOutput } from "../../cli-anything/src/merger.ts";
import type { HindsightClient } from "../../src/hindsight/client.ts";
import type { ResultPayload } from "../../src/fleet/result.ts";
import { FINDINGS_SIDECAR_MAX_BYTES, writeFindingsSidecar } from "../../src/phase-engine/findings-sidecar.ts";
import { normalizeHarvest } from "../../src/qa/findings.ts";
import { harvestedFindingsPath, harvestForLens, readHarvestedFindings } from "../../src/qa/harvested-findings.ts";
import { retainFindings } from "../../src/qa/retain.ts";

const RUN_ID = "qds-20261020-abc467";
const FINDINGS = [
  { finding_text: "off-by-one in the retry loop", diff_context_ref: "src/qa/retain.ts:42" },
  { finding_text: "token literal left in a fixture", diff_context_ref: "tests/qa/fixture.ts:7" },
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A runs dir with the harvested journal dir in place; returns [runsDir, markerPath]. */
function runsDir(): [string, string] {
  const dir = mkdtempSync(join(tmpdir(), "qa-467-"));
  dirs.push(dir);
  const journal = join(dir, `${RUN_ID}-artifacts`, "journal");
  mkdirSync(journal, { recursive: true });
  return [dir, join(journal, "final.json")];
}

/** The hunt phase's value as dispatch_task builds it, from a raw worker reply. */
function mergedFrom(reply: unknown, redact: (s: string) => string = (s) => s) {
  const v = validateWorkerOutput("fixer", reply);
  if (!v.ok) throw new Error(v.reason);
  return buildMergedOutput({
    exitStatus: "success",
    partial: false,
    result: { summary: "merged" },
    agentOutputs: { [v.output.agentId]: v.output.result },
    changedFiles: v.output.changedFiles,
    comsLog: [],
    durationMs: 1,
    waivers: [],
    error: null,
    redact,
    testResults: { passed: 0, failed: 0 },
    testsExecuted: false,
    summary: "merged",
    mulchPrimed: false,
    mulchPrimeError: null,
    artifacts: [],
    partialOutput: null,
  });
}

describe("findings sidecar writer (in-box)", () => {
  test("a hunt value carrying findings under result writes them beside the marker", () => {
    const [, marker] = runsDir();
    const value = mergedFrom({ changedFiles: [], result: { summary: "s", findings: FINDINGS } });
    const res = writeFindingsSidecar(marker, [undefined, { exitCode: 0 }, value]);
    expect(res).toMatchObject({ written: true, count: 2 });
    expect(JSON.parse(readFileSync(join(marker, "..", "findings.json"), "utf8"))).toEqual({ schemaVersion: 1, findings: FINDINGS });
  });

  test("the merged path is redacted before the write (secret hygiene rides buildMergedOutput)", () => {
    const [, marker] = runsDir();
    const leaky = [{ finding_text: "key sk-live-SECRET123 is exposed", diff_context_ref: "src/x.ts:1" }];
    const value = mergedFrom({ changedFiles: [], result: { findings: leaky } }, (s) => s.replaceAll("sk-live-SECRET123", "[REDACTED]"));
    expect(writeFindingsSidecar(marker, [value]).written).toBe(true);
    const text = readFileSync(join(marker, "..", "findings.json"), "utf8");
    expect(text).not.toContain("SECRET123");
    expect(text).toContain("[REDACTED]");
  });

  test("a top-level findings reply is dropped by the worker contract — nothing to write (why the task nests under result)", () => {
    const [, marker] = runsDir();
    const value = mergedFrom({ changedFiles: [], findings: FINDINGS });
    expect(writeFindingsSidecar(marker, [value])).toEqual({ written: false, reason: "none" });
    expect(existsSync(join(marker, "..", "findings.json"))).toBe(false);
  });

  test.each([
    ["not an array", "none found"],
    [[{ finding_text: 1, diff_context_ref: "a" }], "wrong field type"],
    [["prose"], "non-object entry"],
  ])("malformed findings (%p) write nothing", (findings) => {
    const [, marker] = runsDir();
    const res = writeFindingsSidecar(marker, [{ agentOutputs: { fixer: { findings } } }]);
    expect(res).toMatchObject({ written: false, reason: "malformed" });
    expect(existsSync(join(marker, "..", "findings.json"))).toBe(false);
  });

  test("a later walk that yields no findings REMOVES an earlier walk's sidecar (no stale harvest)", () => {
    const [dir, marker] = runsDir();
    writeFindingsSidecar(marker, [mergedFrom({ changedFiles: [], result: { summary: "s", findings: FINDINGS } })]);
    expect(readHarvestedFindings(dir, RUN_ID).ok).toBe(true);
    expect(writeFindingsSidecar(marker, [mergedFrom({ changedFiles: [], result: { summary: "none" } })])).toMatchObject({ written: false, reason: "none" });
    expect(readHarvestedFindings(dir, RUN_ID)).toMatchObject({ ok: false, reason: "absent" });
  });

  test("oversized findings write nothing", () => {
    const [, marker] = runsDir();
    const big = [{ finding_text: "x".repeat(FINDINGS_SIDECAR_MAX_BYTES), diff_context_ref: "a" }];
    expect(writeFindingsSidecar(marker, [{ agentOutputs: { fixer: { findings: big } } }])).toMatchObject({ written: false, reason: "oversize" });
    expect(existsSync(join(marker, "..", "findings.json"))).toBe(false);
  });

  test("a write failure is reported, never thrown", () => {
    const res = writeFindingsSidecar(join(tmpdir(), "qa-467-no-such-dir", "journal", "final.json"), [{ agentOutputs: { fixer: { findings: [] } } }]);
    expect(res).toMatchObject({ written: false, reason: "write-failed" });
  });
});

describe("harvested findings reader (host)", () => {
  test("absent is typed absence, not a throw", () => {
    const [dir] = runsDir();
    expect(readHarvestedFindings(dir, RUN_ID)).toMatchObject({ ok: false, reason: "absent" });
    expect(harvestForLens(dir, RUN_ID, "correctness")).toBeUndefined();
  });

  test.each([
    ["{not json", "malformed"],
    [JSON.stringify({ schemaVersion: 2, findings: [] }), "malformed"],
    [JSON.stringify({ schemaVersion: 1, findings: "none" }), "malformed"],
    [" ".repeat(FINDINGS_SIDECAR_MAX_BYTES + 1), "oversize"],
  ])("bad content %# is typed (%s)", (text, reason) => {
    const [dir] = runsDir();
    writeFileSync(harvestedFindingsPath(dir, RUN_ID), text);
    expect(readHarvestedFindings(dir, RUN_ID)).toMatchObject({ ok: false, reason });
  });

  test("a directory in the file's place is unreadable", () => {
    const [dir] = runsDir();
    mkdirSync(harvestedFindingsPath(dir, RUN_ID));
    expect(readHarvestedFindings(dir, RUN_ID)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("a dangling symlink is not mistaken for findings", () => {
    const [dir] = runsDir();
    symlinkSync(join(dir, "nowhere"), harvestedFindingsPath(dir, RUN_ID));
    expect(readHarvestedFindings(dir, RUN_ID).ok).toBe(false);
  });
});

describe("end to end: dispatch value → sidecar → reader → normalizeHarvest → retainFindings", () => {
  const RAN: ResultPayload = { schemaVersion: 1, runId: RUN_ID, requestId: null, status: "completed", terminal: true, artifacts: {} };

  test("the leg's findings reach retain attributed to (runId, lens)", async () => {
    const [dir, marker] = runsDir();
    writeFindingsSidecar(marker, [mergedFrom({ changedFiles: [], result: { summary: "s", findings: FINDINGS } })]);

    const norm = normalizeHarvest("correctness", RAN, harvestForLens(dir, RUN_ID, "correctness"));
    expect(norm).toEqual({
      legRan: true,
      lens: "correctness",
      runId: RUN_ID,
      findings: FINDINGS.map((f) => ({ runId: RUN_ID, lens: "correctness", ...f })),
    });
    if (!norm.legRan) throw new Error("unreachable");

    const retained: string[] = [];
    const client = {
      retain: async (bankId: string, content: string) => {
        retained.push(content);
        return { memoryId: "", bankId, status: "created" as const, durationMs: 0 };
      },
    } as unknown as Pick<HindsightClient, "retain">;
    const res = await retainFindings(
      { client },
      {
        repoBankId: "acme-widgets",
        runId: RUN_ID,
        lens: "correctness",
        commitSha: `${"a".repeat(39)}0`,
        repoSlug: "acme/widgets",
        requestId: "req-467",
        legRan: true,
        findings: norm.findings,
      },
    );
    expect(res.documentIds.length).toBe(2);
    expect(retained.join("\n")).toContain("off-by-one in the retry loop");
  });

  test("one mis-shaped entry is dropped and COUNTED, never costs the leg its valid findings", () => {
    const [dir, marker] = runsDir();
    const bad = [
      { finding_text: "ref is a call", diff_context_ref: "normalizeHarvest()" },
      { finding_text: "extra key", diff_context_ref: "src/x.ts:4", severity: "high" },
    ];
    writeFindingsSidecar(marker, [mergedFrom({ changedFiles: [], result: { summary: "s", findings: [...FINDINGS, ...bad] } })]);
    const dropped: number[] = [];
    const norm = normalizeHarvest("correctness", RAN, harvestForLens(dir, RUN_ID, "correctness", (n) => dropped.push(n)));
    expect(dropped).toEqual([2]);
    expect(norm.legRan && norm.findings.map((f) => f.finding_text)).toEqual(FINDINGS.map((f) => f.finding_text));
  });

  test("past the per-harvest cap the excess is dropped and counted (normalizeHarvest's own max would refuse it all)", () => {
    const [dir, marker] = runsDir();
    const many = Array.from({ length: 40 }, (_, i) => ({ finding_text: `f${i}`, diff_context_ref: `src/a.ts:${i + 1}` }));
    writeFindingsSidecar(marker, [mergedFrom({ changedFiles: [], result: { summary: "s", findings: many } })]);
    const dropped: number[] = [];
    const norm = normalizeHarvest("correctness", RAN, harvestForLens(dir, RUN_ID, "correctness", (n) => dropped.push(n)));
    expect(dropped).toEqual([8]);
    expect(norm.legRan && norm.findings.length).toBe(32);
  });

  test("a ran leg with no sidecar is refused by normalizeHarvest, never read as []", () => {
    const [dir] = runsDir();
    expect(() => normalizeHarvest("correctness", RAN, harvestForLens(dir, RUN_ID, "correctness"))).toThrow(/malformed/);
  });
});
