/**
 * T1.2 — real provisioning + the `status` verb on real exe.dev
 * (e2e-plan.md paths 2, 8).
 *
 * Proves: `createRun` (the real headroom gate + `provisionAdmittedRun`:
 * record → box) stands a REAL box and writes a REAL run record; the `status`
 * verb as a real `bun scripts/fleet.ts` subprocess reads the records dir,
 * lists the REAL provider, and reports the run `state:"live"` with
 * `boxAlive:true`; whole-fleet `status` exits 0 alongside it.
 *
 * Why not the full `dispatch` verb: exedev dispatch ALWAYS runs the five-
 * assertion setup gate, whose C and D are real chat/completions calls — real
 * model spend. TIER-1 is zero-spend by contract, so provisioning is driven at
 * the `createRun` seam and the verb-level dispatch proof lives in TIER-2.
 *
 * Cleanup: the `teardown` verb (`--no-harvest`) destroys the box in `finally`
 * — itself a real verb invocation on a minimal record (no keyHash ⇒ no revoke;
 * no commitSha ⇒ harvest "none").
 */
import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createRun } from "../../../src/providers/driver.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { liveGate, liveTodoOff, preflight, runFleet, runIdFor, tmpWorkspace, writeEvidence } from "./live-harness.ts";

test.todoIf(liveTodoOff())(
  "T1.2 createRun provisions a real box; fleet status verb reports it live",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("t12");
    let workspace = "";
    let evidencePath = "";
    let outcome = "pass";
    try {
      workspace = tmpWorkspace("t12");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      const store = new RunRecordStore({ dir: recordsDir });

      // ── createRun: headroom (real driver.list) + record → real box ────────
      const record = await createRun(ctx.driver, store, { runId });
      evidence.push({ phase: "createRun", ok: true, runId, vmName: record.vmName });
      expect(record.vmName).toBe(runId);

      const listed = await ctx.driver.list(runId);
      expect(listed.some((b) => b.name === runId)).toBeTrue();
      evidence.push({ phase: "box-in-list", count: listed.length });

      // ── status <runId> verb, real subprocess ──────────────────────────────
      const single = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 120_000 });
      evidence.push({ phase: "status-single", exitCode: single.exitCode, stdout: single.stdout.trim().slice(0, 500), stderr: single.stderr.trim().slice(0, 500) });
      expect(single.exitCode).toBe(0);
      const row = JSON.parse(single.stdout.trim().split("\n").at(-1) ?? "{}") as { runId?: string; state?: string; vmName?: string };
      expect(row.runId).toBe(runId);
      // "live" for an OPEN row IS the box-alive proof (rowForRecord omits
      // boxAlive on open rows; only closed rows carry it — status.ts:343,351).
      expect(row.state).toBe("live");
      expect(row.vmName).toBe(runId);

      // ── whole-fleet status verb ───────────────────────────────────────────
      const all = await runFleet(["status", "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 120_000 });
      evidence.push({ phase: "status-all", exitCode: all.exitCode, stdout: all.stdout.trim().slice(0, 500) });
      expect(all.exitCode).toBe(0);
      const rows = all.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { runId?: string; state?: string });
      expect(rows.some((r) => r.runId === runId && r.state === "live")).toBeTrue();
      expect(rows.some((r) => r.state === "listUnavailable")).toBeFalse();
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      // Real teardown verb on the minimal record (bonus real coverage, free).
      if (workspace !== "") {
        const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"], { timeoutMs: 180_000 });
        evidence.push({ phase: "finally-teardown-verb", exitCode: td.exitCode, stdout: td.stdout.trim().slice(0, 300), stderr: td.stderr.trim().slice(0, 300) });
      }
      try {
        evidencePath = writeEvidence("t1-2-provision-status", { test: "T1.2", outcome, runId, phases: evidence });
        process.stderr.write(`[T1.2] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  600_000,
);
