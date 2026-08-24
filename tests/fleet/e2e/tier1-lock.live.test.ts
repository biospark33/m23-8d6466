/**
 * T1.6 — the per-run lock under REAL concurrency on real exe.dev
 * (e2e-plan.md path 7, K8 family).
 *
 * Two `fleet teardown` subprocesses launched simultaneously against the same
 * run: the run lock (`<recordsDir>/<runId>.lock`, acquireRunLock) must admit
 * exactly one — the other refuses exit 5 `run-locked` before mutating
 * anything. The winner performs a REAL teardown of a REAL box.
 *
 * Minimal record (vmName, no keyHash): the winner exits 0 or 6 — 6 is the
 * designed `key-unattributable` note (fleet.ts:2051) when no key was ever
 * minted; either way the box must be destroyed and the loser must never have
 * touched it. ZERO model spend.
 */
import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { liveGate, liveTodoOff, preflight, runFleet, runIdFor, tmpWorkspace, writeEvidence } from "./live-harness.ts";

test.todoIf(liveTodoOff())(
  "T1.6 concurrent teardowns of one run: exactly one wins, the other refuses exit 5 run-locked",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("t16");
    let workspace = "";
    let evidencePath = "";
    let outcome = "pass";
    try {
      workspace = tmpWorkspace("t16");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });

      const store = new RunRecordStore({ dir: recordsDir });
      store.create(runId);
      const vm = (await ctx.driver.create(runId)).name;
      store.set(runId, { vmName: vm });
      evidence.push({ phase: "provision", ok: true, vm });

      const teardownArgv = ["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"] as const;
      const [a, b] = await Promise.all([
        runFleet(teardownArgv, { timeoutMs: 240_000 }),
        runFleet(teardownArgv, { timeoutMs: 240_000 }),
      ]);
      evidence.push({
        phase: "concurrent-teardowns",
        a: { exitCode: a.exitCode, stdout: a.stdout.trim().slice(0, 120), stderrHasRunLocked: a.stderr.includes("run-locked") },
        b: { exitCode: b.exitCode, stdout: b.stdout.trim().slice(0, 120), stderrHasRunLocked: b.stderr.includes("run-locked") },
      });

      // Winner: 0, or the designed 6 key-unattributable note, with "torn down".
      // Loser: 5 with the run-locked diagnostic. Exactly one of each.
      const winner = (a.exitCode ?? -1) === 5 ? b : a;
      const loser = winner === a ? b : a;
      expect([0, 6]).toContain(winner.exitCode ?? -1);
      expect(winner.stdout).toContain("torn down");
      expect(loser.exitCode).toBe(5);
      expect(loser.stderr).toContain("run-locked");

      // The box is gone either way — the loser never raced a half-dead box.
      const boxes = await ctx.driver.list(runId);
      expect(boxes.some((x) => x.name === runId)).toBeFalse();
      evidence.push({ phase: "box-gone", ok: true });
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      try {
        const still = await ctx.driver.list(runId);
        if (still.some((b) => b.name === runId)) {
          await ctx.driver.destroy(runId);
          evidence.push({ phase: "finally-direct-destroy", ok: true });
        }
      } catch {
        // list failure must not mask the test's own result
      }
      try {
        evidencePath = writeEvidence("t1-6-run-lock", { test: "T1.6", outcome, runId, phases: evidence });
        process.stderr.write(`[T1.6] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  600_000,
);
