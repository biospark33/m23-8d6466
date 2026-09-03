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
import {
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  liveGate,
  liveTodoOff,
  preflight,
  runFleet,
  runIdFor,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

test.todoIf(liveTodoOff())(
  "T1.2 createRun provisions a real box; fleet status verb reports it live",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("t12");
    let workspace = "";
    let outcome = "pass";
    /** The body's own error, HELD so the post-`finally` verdict renders on the red path too. */
    let failure: unknown;
    /** Cleanup legs that FAILED — rendered AFTER the `finally`, never only recorded (#189). */
    const destroyFailures: string[] = [];
    /** The cleanup-time leak listing; `undefined` means it FAILED, which is a problem, not a pass. */
    let finalBoxes: string[] | undefined;
    /**
     * Evidence-WRITE failures, kept OUT of `destroyFailures`: a secret-scrub
     * refusal is not a box that failed to die, and `fleetCleanupProblems`
     * renders that array as "cleanup failures: …".
     */
    const writeProblems: string[] = [];
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
      // HELD, not re-thrown: the post-`finally` verdict must render on the red
      // path too — the failing run is the one that actually leaks.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // Real teardown verb on the minimal record (bonus real coverage, free) —
      // through `teardownQuietly`, not a bare `runFleet`. The 180 s ceiling
      // firing (or a dead spawn) REJECTED straight out of this `finally`,
      // skipping the evidence write and the workspace cleanup below it and
      // replacing the body's held error with a teardown timeout; and a non-zero
      // exit was only ever pushed into `evidence`, which nothing reads during
      // the run, so a teardown that failed to destroy the box shipped green.
      //
      // 6 is a SUCCESS code here, not a tolerance: `createRun` mints no key, so
      // this record is `vmName` + open + no `keyHash` — precisely fleet.ts's
      // `key-unattributable` branch, which returns 6 on a teardown that did all
      // of its own work. (The pre-existing note calling 6 "harvest_waived" was
      // wrong: `--no-harvest` only prints that line, it never sets the code.)
      if (workspace !== "") {
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: 180_000, okExitCodes: [0, 6] },
          evidence,
          { at: "t1.2-cleanup", runId },
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      // The box half, which the teardown verb alone never guaranteed: a
      // teardown that refused (or was never run, because `workspace === ""`)
      // left a REAL box billing with nothing else in this file destroying it.
      try {
        if ((await ctx.driver.list(runId)).some((b) => b.name === runId)) {
          const destroyed = await destroyQuietly(ctx.driver, runId, evidence);
          if (!destroyed.ok) destroyFailures.push(`${runId}: ${destroyed.error}`);
        }
      } catch (e) {
        evidence.push({ phase: "finally-destroy", ok: false, error: (e as Error).message });
        destroyFailures.push(`${runId}: list-before-destroy failed: ${(e as Error).message}`);
      }
      // `fleetLeftovers` (P127/P128/R4) replaces the single-shot listing: it
      // polls the measured 25 s+ substrate destroy lag before calling a leak a
      // leak, destroys what this run owns and re-lists, and demotes another
      // round's stray box to a warning instead of failing this run on it. It
      // never throws; a failed listing returns `undefined`, which
      // `fleetCleanupProblems` renders as the problem it is.
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId], evidence)).owned;
      // `writeEvidenceQuietly` (F11): the secret-scrub REFUSAL and ENOSPC both
      // throw out of `writeEvidence`, and that throw used to replace the body's
      // real failure and skip the workspace cleanup.
      writeEvidenceQuietly("T1.2", "t1-2-provision-status", { test: "T1.2", outcome, runId, phases: evidence }, writeProblems);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // No key half: `createRun` provisions a box and writes a record but never
    // mints (`provisionAdmittedRun` touches no KeyApi), and the `status` verb
    // is a read. There is no key population for `keyLeakProblems` to diff.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes), ...writeProblems]);
  },
  600_000,
);
