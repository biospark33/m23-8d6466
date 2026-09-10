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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { acquireRunLock, releaseRunLock, RunLockedError } from "../../../scripts/lib/run-lock.ts";
import {
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  liveGate,
  liveTodoOff,
  preflight,
  REPO_ROOT,
  runFleet,
  runIdFor,
  settleRun,
  tmpWorkspace,
  writeEvidence,
  writeEvidenceQuietly,
} from "./live-harness.ts";

test.todoIf(liveTodoOff())(
  "T1.6 concurrent teardowns of one run: exactly one wins, the other refuses exit 5 run-locked",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("t16");
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
      // The invocation lock acquireRunLock creates is <recordsDir>/<runId>.lock
      // (run-lock.ts:945 — `resolve(runsDir, `${runId}.lock`)`). Fixed 2026-08-28:
      // this barrier used to poll the STORE's row lock `<runId>.json.lock`
      // (run-record.ts:1071), a different artifact the teardown only touches
      // transiently mid-verb — it passed 2026-08-24 on timing luck and missed
      // deterministically today.
      const lockPath = join(recordsDir, `${runId}.lock`);
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
      // HELD, not re-thrown: the post-`finally` verdict must render on the red
      // path too — a run that died mid-contention is the one holding a box.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      try {
        const still = await ctx.driver.list(runId);
        if (still.some((b) => b.name === runId)) {
          // Through `destroyQuietly`, not a bare `driver.destroy` inside a
          // swallowing `catch {}`: that shape ate BOTH failures it could see —
          // a list that threw AND a destroy that threw — so a box still billing
          // left no verdict anywhere and this test reported green. Both halves
          // are now accumulated and rendered after the `finally`.
          const destroyed = await destroyQuietly(ctx.driver, runId, evidence);
          if (!destroyed.ok) destroyFailures.push(`${runId}: ${destroyed.error}`);
        }
      } catch (e) {
        evidence.push({ phase: "finally-direct-destroy", ok: false, error: (e as Error).message });
        destroyFailures.push(`${runId}: list-before-destroy failed: ${(e as Error).message}`);
      }
      // The absolute backstop, which no `list(runId)` filter can give: the
      // contending teardowns run as REAL subprocesses, and a half-run loser is
      // exactly the shape that can leave a box under a name this test never
      // held in a variable.
      // Through `fleetLeftovers` (P127/P128/R4): the poll answers the measured
      // 25 s+ destroy lag that made this single-shot listing cry leak on clean
      // paid rounds, owned survivors are destroyed before the verdict is
      // rendered, and a box belonging to some OTHER round is a warning rather
      // than a red on this one. Never throws — safe as a bare await here.
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId], evidence)).owned;
      // `writeEvidenceQuietly` (F11): a throw from the secret-scrub refusal or
      // ENOSPC used to escape this `finally` and replace the body's own error.
      writeEvidenceQuietly("T1.6", "t1-6-run-lock", { test: "T1.6", outcome, runId, phases: evidence }, writeProblems);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // No key half: the record is minimal by design (`store.create` + a
    // `vmName` set by hand — the header's "no keyHash" premise, which is also
    // why the winner may legitimately exit 6). Nothing here mints, so there is
    // no key population for `keyLeakProblems` to diff.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes), ...writeProblems]);
  },
  600_000,
);

/**
 * The holder subprocess used by T1.6b/T1.6c: a REAL second process that
 * acquires `<runsDir>/<runId>.lock` through the production primitive and then
 * does what its mode says. argv: `<runsDir> <runId> <mode> <readyFile>`.
 *
 *   hold             — stay alive holding the lock (the BUSY contender)
 *   destructive-exit — mark destructive, then exit 0: `releaseHeldRunLocks`
 *                      must REFUSE to release and print the operator line
 *   plain-exit       — no mark, exit 0: the lock is released automatically
 *                      (the control that proves the MARK, not the exit, is
 *                      what keeps the file)
 *
 * The ready SIGNAL is a file: a holder in `hold` mode never exits, so stdout
 * EOF is not something a waiter can wait for.
 */
const HOLDER_SCRIPT = `\
import { acquireRunLock, markRunLockDestructive } from "#HOLDER_IMPORTS#";
import { writeFileSync } from "node:fs";
const [, , runsDir, runId, mode, readyFile] = process.argv;
const lock = acquireRunLock(runsDir, runId, "e2e-lock-holder");
if (mode === "destructive-exit") markRunLockDestructive(lock);
writeFileSync(readyFile, String(process.pid));
if (mode === "hold") {
  setInterval(() => {}, 30_000);
} else {
  process.exit(0);
}
`;

type HolderProc = { proc: ReturnType<typeof Bun.spawn>; kill: () => void; exited: Promise<number>; stderrText: Promise<string> };

/** Spawn the holder; resolve once its ready file lands (or throw). */
async function spawnHolder(
  scriptPath: string,
  runsDir: string,
  runId: string,
  mode: "hold" | "destructive-exit" | "plain-exit",
  readyFile: string,
): Promise<HolderProc> {
  const proc = Bun.spawn({
    cmd: ["bun", scriptPath, runsDir, runId, mode, readyFile],
    cwd: REPO_ROOT,
    env: { ...process.env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Captured HERE, where the options literal has narrowed the stream types —
  // the consumers only hold the widened `ReturnType<typeof Bun.spawn>`.
  const stderrText: Promise<string> = new Response(proc.stderr).text();
  const deadline = Date.now() + 30_000;
  while (!existsSync(readyFile)) {
    if (Date.now() >= deadline) {
      proc.kill("SIGKILL");
      const stderr = await stderrText;
      throw new Error(`holder ${runId} (${mode}) never became ready within 30s; stderr=${stderr.slice(-500)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { proc, kill: () => proc.kill("SIGKILL"), exited: proc.exited, stderrText };
}

test.todoIf(liveTodoOff())(
  "T1.6b run-lock refusal wording: BUSY (live holder) vs STALE (dead holder) on real cross-process contention (DF2.11 AC4)",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    let workspace = "";
    let outcome = "fail";
    try {
      workspace = tmpWorkspace("t16b");
      const runsDir = join(workspace, "runs");
      mkdirSync(runsDir, { recursive: true });
      const scriptPath = join(workspace, "holder.ts");
      writeFileSync(
        scriptPath,
        HOLDER_SCRIPT.replace(
          "#HOLDER_IMPORTS#",
          JSON.stringify(join(REPO_ROOT, "scripts/lib/run-lock.ts")),
        ),
      );

      // ── BUSY arm: a live holder → refusal without the stale claim ────────
      const busyRunId = runIdFor("t16b-busy");
      const busyReady = join(workspace, `${busyRunId}.ready`);
      const busyLock = join(runsDir, `${busyRunId}.lock`);
      const busy = await spawnHolder(scriptPath, runsDir, busyRunId, "hold", busyReady);
      expect(existsSync(busyLock), "the holder's lock file is on disk").toBeTrue();
      let busyErr: Error | undefined;
      try {
        acquireRunLock(runsDir, busyRunId, "e2e-contender");
        // Success here is the BUG this arm exists to catch: release whatever
        // landed and fail on the assertion below.
        releaseRunLock(busyLock, { force: true });
      } catch (e) {
        busyErr = e as Error;
      }
      const busyLocked = busyErr as RunLockedError | undefined;
      evidence.push({
        phase: "busy",
        code: busyLocked instanceof RunLockedError ? busyLocked.code : (busyErr?.message ?? "NO REFUSAL"),
        stale: busyLocked instanceof RunLockedError ? busyLocked.stale : null,
        remediation: busyLocked?.remediation ?? null,
      });
      expect(busyLocked, "a live holder must refuse a second acquire").toBeInstanceOf(RunLockedError);
      expect(busyLocked?.code).toBe("run-locked");
      // The machine-readable half: NOT stale — a live process holds it.
      expect(busyLocked?.stale).toBeFalse();
      // The wording half: the busy remediation says WAIT; it must NOT carry
      // the stale arm's "no live process holds it" claim, which would hand an
      // operator rm advice for a lock somebody holds.
      expect(busyLocked?.remediation).toContain("wait for that invocation to finish");
      expect(busyLocked?.remediation).not.toContain("no live process holds it");

      // ── STALE arm: SIGKILL the holder → same file, dead pid ──────────────
      busy.kill();
      await busy.exited;
      // SIGKILL runs no exit handler, so the FILE remains — the exact
      // post-crash artifact an operator is faced with.
      expect(existsSync(busyLock), "the killed holder's lock file remains").toBeTrue();
      let staleErr: Error | undefined;
      try {
        acquireRunLock(runsDir, busyRunId, "e2e-contender");
        releaseRunLock(busyLock, { force: true });
      } catch (e) {
        staleErr = e as Error;
      }
      const staleLocked = staleErr as RunLockedError | undefined;
      evidence.push({
        phase: "stale",
        code: staleLocked instanceof RunLockedError ? staleLocked.code : (staleErr?.message ?? "NO REFUSAL"),
        stale: staleLocked instanceof RunLockedError ? staleLocked.stale : null,
        remediation: staleLocked?.remediation ?? null,
      });
      expect(staleLocked, "a dead holder's lock must still refuse — this module never steals").toBeInstanceOf(RunLockedError);
      expect(staleLocked?.code).toBe("run-locked");
      // The machine-readable claim flips: no live process holds it.
      expect(staleLocked?.stale).toBeTrue();
      // The wording flips with it: the rm-then-re-run advice is the STALE
      // arm's, naming the exact file to remove.
      expect(staleLocked?.remediation).toContain("no live process holds it");
      expect(staleLocked?.remediation).toContain(`rm ${busyLock}`);

      outcome = "pass";
    } finally {
      try {
        writeEvidence("t1-6b-lock-wording", { test: "T1.6b", outcome, phases: evidence });
      } catch (e) {
        process.stderr.write(`[T1.6b] evidence write failed: ${(e as Error).message}\n`);
      }
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }
  },
  120_000,
);

test.todoIf(liveTodoOff())(
  "T1.6c the destructive mark leaves the lock for an operator across a real process exit (DF2.11 AC4)",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    let workspace = "";
    let outcome = "fail";
    try {
      workspace = tmpWorkspace("t16c");
      const runsDir = join(workspace, "runs");
      mkdirSync(runsDir, { recursive: true });
      const scriptPath = join(workspace, "holder.ts");
      writeFileSync(
        scriptPath,
        HOLDER_SCRIPT.replace(
          "#HOLDER_IMPORTS#",
          JSON.stringify(join(REPO_ROOT, "scripts/lib/run-lock.ts")),
        ),
      );

      // ── the MARKED arm: destructive mark + graceful exit ──────────────────
      const markedRunId = runIdFor("t16c-marked");
      const markedReady = join(workspace, `${markedRunId}.ready`);
      const markedLock = join(runsDir, `${markedRunId}.lock`);
      const marked = await spawnHolder(scriptPath, runsDir, markedRunId, "destructive-exit", markedReady);
      const markedExit = await marked.exited;
      const markedStderr = await marked.stderrText;
      expect(markedExit).toBe(0); // a graceful exit — the mark is what matters
      // The lock file REMAINS after a graceful exit: the mark overrides the
      // exit handler's release, leaving the operator to judge the run.
      expect(existsSync(markedLock), "a destructively-marked lock outlives its holder's exit").toBeTrue();
      // And the operator line names it: the module's own promise (AC4) is
      // that stderr says what happened and what NOT to do.
      evidence.push({ phase: "marked-exit", stderr: markedStderr.trim().slice(-800) });
      expect(markedStderr).toContain("lock-held");
      expect(markedStderr).toContain(markedLock);
      expect(markedStderr).toContain("NOT released");
      expect(markedStderr).toContain("only once you know the teardown state");
      // A later acquire still refuses — the lock is real, not a memory.
      let laterErr: Error | undefined;
      try {
        acquireRunLock(runsDir, markedRunId, "e2e-contender");
        releaseRunLock(markedLock, { force: true });
      } catch (e) {
        laterErr = e as Error;
      }
      expect(laterErr).toBeInstanceOf(RunLockedError);
      evidence.push({ phase: "marked-later-refusal", code: (laterErr as RunLockedError | undefined)?.code ?? null });

      // ── the UNMARKED control: same exit, no mark → released ───────────────
      // Without this, "the file remained" would be true of ANY exit and the
      // test would prove nothing about the mark.
      const plainRunId = runIdFor("t16c-plain");
      const plainReady = join(workspace, `${plainRunId}.ready`);
      const plainLock = join(runsDir, `${plainRunId}.lock`);
      const plain = await spawnHolder(scriptPath, runsDir, plainRunId, "plain-exit", plainReady);
      const plainExit = await plain.exited;
      expect(plainExit).toBe(0);
      // The destroy lag others poll for does not apply to a HOST-side file
      // unlink: after `exited` resolves, the exit handler has run to completion.
      expect(existsSync(plainLock), "an unmarked lock is released by its own holder's exit").toBeFalse();

      outcome = "pass";
    } finally {
      try {
        writeEvidence("t1-6c-destructive-mark", { test: "T1.6c", outcome, phases: evidence });
      } catch (e) {
        process.stderr.write(`[T1.6c] evidence write failed: ${(e as Error).message}\n`);
      }
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }
  },
  120_000,
);
