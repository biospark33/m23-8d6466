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
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

      // ponytail: deterministic barrier ensures the second teardown contends while
      // the first still holds the lock. Without this, if the first completes before
      // the second even attempts acquisition, both may win and the test flakes.
      // The lock file <recordsDir>/<runId>.json.lock appears the instant acquireRunLock
      // succeeds, so we poll for it before launching the contender.
      const lockPath = join(recordsDir, `${runId}.json.lock`);
      const teardownArgv = ["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"] as const;
      const a = runFleet(teardownArgv, { timeoutMs: 240_000 });
      // Barrier: wait for lock file evidence (max 5s, 50ms ticks) before launching b.
      const barrierDeadline = Date.now() + 5_000;
      let lockSighted = false;
      while (!lockSighted && Date.now() < barrierDeadline) {
        if (existsSync(lockPath)) {
          lockSighted = true;
        } else {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      // r7-T-f1: only throw if the first teardown is still running without lock sighted.
      // If the first already exited (fast path), let the final assertions decide.
      if (!lockSighted) {
        const aExited = await Promise.race([
          a.then(() => "exited"),
          new Promise<string>((resolve) => setTimeout(() => resolve("running"), 0)),
        ]);
        if (aExited === "running") {
          throw new Error("barrier: first teardown still running without lock sighted after 5s — cannot test contention");
        }
        evidence.push({ phase: "barrier-lock-not-sighted", note: "first teardown completed before poll observed lock file; proceeding to final assertions" });
      }
      const b = runFleet(teardownArgv, { timeoutMs: 240_000 });
      const [aResult, bResult] = await Promise.all([a, b]);
      evidence.push({
        phase: "concurrent-teardowns",
        a: { exitCode: aResult.exitCode, stdout: aResult.stdout.trim().slice(0, 120), stderrHasRunLocked: aResult.stderr.includes("run-locked") },
        b: { exitCode: bResult.exitCode, stdout: bResult.stdout.trim().slice(0, 120), stderrHasRunLocked: bResult.stderr.includes("run-locked") },
      });

      // Winner: 0, or the designed 6 key-unattributable note, with "torn down".
      // Loser: 5 with the run-locked diagnostic. Exactly one of each.
      const winner = (aResult.exitCode ?? -1) === 5 ? bResult : aResult;
      const loser = winner === aResult ? bResult : aResult;
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
