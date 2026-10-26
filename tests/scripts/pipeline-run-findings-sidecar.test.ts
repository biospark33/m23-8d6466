/**
 * #467: pipeline-run's findings-sidecar call site. `persistPhaseFindings` is
 * driven in-process (a spawned `main` cannot reach it offline: dispatch_task's
 * roster gate 2 fetches OpenRouter's live model list), and a structural slice
 * pins that `main` calls it after the walk and BEFORE `run.finish` writes the
 * marker — the ordering that keeps a marker-keyed harvest from racing it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistPhaseFindings } from "../../scripts/pipeline-run.ts";

const FINDINGS = [{ finding_text: "off-by-one", diff_context_ref: "src/x.ts:1" }];
const IDS = { runId: "run-467", requestId: "req-467" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function journalDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pr-467-")), "journal");
  dirs.push(join(dir, ".."));
  mkdirSync(dir);
  return dir;
}

function run(values: unknown[]): { dir: string; lines: Record<string, unknown>[] } {
  const dir = journalDir();
  const lines: Record<string, unknown>[] = [];
  persistPhaseFindings(join(dir, "final.json"), values, IDS, (l) => lines.push(JSON.parse(l)));
  return { dir, lines };
}

describe("persistPhaseFindings", () => {
  test("a dispatch value carrying agentOutputs.<id>.findings writes findings.json beside final.json and logs it", () => {
    const { dir, lines } = run([{ exitCode: 0 }, { agentOutputs: { fixer: { summary: "s", findings: FINDINGS } } }]);
    expect(JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"))).toEqual({ schemaVersion: 1, findings: FINDINGS });
    expect(lines).toEqual([expect.objectContaining({ event: "findings_sidecar", level: "info", written: true, count: 1, ...IDS, phaseId: null })]);
  });

  test("a run without findings leaves no findings.json and stays quiet", () => {
    const { dir, lines } = run([{ exitCode: 0 }, { agentOutputs: { fixer: { summary: "s" } } }]);
    expect(existsSync(join(dir, "findings.json"))).toBe(false);
    expect(lines).toEqual([]);
  });

  test("malformed findings write nothing and log a warn line", () => {
    const { dir, lines } = run([{ agentOutputs: { fixer: { findings: "none" } } }]);
    expect(existsSync(join(dir, "findings.json"))).toBe(false);
    expect(lines).toEqual([expect.objectContaining({ event: "findings_sidecar", level: "warn", written: false, reason: "malformed" })]);
  });

  test("a throwing log sink never escapes", () => {
    const dir = journalDir();
    const res = persistPhaseFindings(join(dir, "final.json"), [{ agentOutputs: { a: { findings: FINDINGS } } }], IDS, () => {
      throw new Error("EPIPE");
    });
    expect(res.written).toBe(true);
  });
});

describe("main's call site (structural slice)", () => {
  test("main calls persistPhaseFindings after the walk and before run.finish", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "scripts", "pipeline-run.ts"), "utf8");
    const main = src.slice(src.indexOf("async function main("));
    const walk = main.indexOf("await walkPhases(");
    const call = main.indexOf("persistPhaseFindings(markerPath, outcomes.map((o) => o.value)");
    const finish = main.indexOf("run.finish(");
    expect(walk).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(walk);
    expect(finish).toBeGreaterThan(call);
  });
});
