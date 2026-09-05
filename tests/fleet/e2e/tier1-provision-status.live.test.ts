/**
 * T1.2 — real provisioning + the `status` verb on real exe.dev
 * (e2e-plan.md paths 2, 8).
 *
 * Proves: `createRun` (the real headroom gate + `provisionAdmittedRun`:
 * record → box) stands a REAL box and writes a REAL run record; the `status`
 * verb as a real `bun scripts/fleet.ts` subprocess reads the records dir,
 * lists the REAL provider, and reports the run `state:"not-running"` — DF1.10
 * AC5's in-box vocabulary, read off the completion marker AND the run unit
 * against a REAL `ExeDevDriver`; whole-fleet `status` exits 0 alongside it.
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
  statusStateSettled,
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
    /** E2-3: the approval-echo record's id, armed in the body and CLOSED in the
     *  `finally` — on the leg's red path too, not only its green one. The store
     *  handle rides along for the same reason (the body's own is body-scoped). */
    let approvalRunId = "";
    let approvalStore: RunRecordStore | undefined;
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
      approvalStore = store;

      // ── createRun: headroom (real driver.list) + record → real box ────────
      const record = await createRun(ctx.driver, store, { runId });
      evidence.push({ phase: "createRun", ok: true, runId, vmName: record.vmName });
      expect(record.vmName).toBe(runId);

      const listed = await ctx.driver.list(runId);
      expect(listed.some((b) => b.name === runId)).toBeTrue();
      evidence.push({ phase: "box-in-list", count: listed.length });

      // ── status <runId> verb, real subprocess ──────────────────────────────
      // Through `statusStateSettled`, not one shot. The row is now TWO bounded
      // ssh round trips (the marker read, then the unit probe that corroborates
      // its absence) against a box created seconds ago, and `unknown` is AC5's
      // fail-closed reading of "neither answered" — which a cold first ssh
      // multiplex produces far more often than a fault does. The helper retries
      // `unknown` and a flaky verb exit and returns the LAST state it saw, so a
      // persistent `unknown` still fails the assertion below naming itself.
      const single = await statusStateSettled(runId, recordsDir, evidence);
      expect(single.exitCode).toBe(0);
      expect(single.row.runId).toBe(runId);
      // `not-running`, and it is READ OUT OF THE SOURCE rather than picked from
      // AC5's vocabulary. The chain, for a box `createRun` provisioned and no
      // `fleet run` has ever touched:
      //
      //  - `markerReader` (status.ts) resolves because `ExeDevDriver` has
      //    `execTimed`, so `withInBoxState` OVERRIDES the `live` row this record
      //    would otherwise produce. `live` therefore is NOT the expected value
      //    here — it is what a driver with no marker channel (FakeDriver)
      //    reports, and seeing it back on this real-driver row would mean AC5 is
      //    not wired at all.
      //  - the engine never ran, so `/run/journal/final.json` is not there and
      //    `test -f` exits 1 — the ONE probe status treats as a clean miss
      //    (`classifyMarkerRead` ⇒ `{kind:"absent"}`).
      //  - DF1.10 CHANGED WHAT HAPPENS NEXT, and this assertion moved with it.
      //    `absent` no longer collapses to `running`: `inBoxState` corroborates
      //    it with `systemctl is-active qds-run@<runId>.service`, because four
      //    different things produce an absent marker and only one of them is
      //    "still walking its phases". `fleet run` was never invoked on this
      //    record, so the template instance has never been loaded and systemd
      //    answers `inactive` — which `unitActivity` maps to `inactive` and
      //    `inBoxState` maps to `not-running`. That is a STRONGER statement than
      //    the old `running`: it says the box is up and nothing is running on
      //    it, which is exactly what this test provisioned.
      //
      // The one thing that would flip this answer, and why it does not apply:
      // an APPROVAL-echoed state is never probed. `rowForRecord` returns `live`
      // as its own flag rather than re-reading `row.state` precisely so that a
      // record carrying `extensions.approval.state: "live"` keeps its echoed
      // word unprobed — the approval gate stays host-side by construction, so
      // its state is a fact about the record, not about the box. `createRun`
      // writes a bare record with no approval extension, so `approvalRowFields`
      // returns undefined and the ordinary live arm — the probed one — is what
      // this row goes through.
      //
      // The other values this row could truthfully take are `unknown` (neither
      // probe answered inside the deadline — retried above, so reaching it here
      // is a substrate fault to report) and `engine-failed` (the unit exists and
      // is `failed`, which on a run nothing ever started would mean the box came
      // up with a pre-failed instance).
      expect(single.state).toBe("not-running");
      expect(single.row.vmName).toBe(runId);

      // ── whole-fleet status verb ───────────────────────────────────────────
      // POLLED (round 3, E2-1): the whole-fleet read is probed per live row
      // (`withInBoxState`, 2 ssh legs each) and a cold/flaky ssh answers
      // neither probe ⇒ that row renders `unknown` — the exact flake
      // `statusStateSettled` exists to absorb, and this one-shot read used to
      // reintroduce one assertion later. Retry until the row is not `unknown`
      // (bounded); a persistent `unknown` IS a real fault and fails below.
      let rows: Array<{ runId?: string; state?: string }> = [];
      let allExit = -1;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const all = await runFleet(["status", "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 120_000 });
        allExit = all.exitCode ?? -1;
        if (all.exitCode === 0) {
          rows = all.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { runId?: string; state?: string });
          const ours = rows.find((r) => r.runId === runId);
          if (ours !== undefined && ours.state !== "unknown") {
            evidence.push({ phase: "status-all", exitCode: all.exitCode, attempt, stdout: all.stdout.trim().slice(0, 500) });
            break;
          }
          evidence.push({ phase: "status-all-retry", attempt, state: ours?.state ?? "(absent row)" });
        } else {
          evidence.push({ phase: "status-all-failed", attempt, exitCode: all.exitCode });
        }
      }
      expect(allExit).toBe(0);
      // The SAME state the single-run read above asserted, and that identity is
      // the point rather than a copy: `withInBoxState` is applied by BOTH entry
      // points precisely so `fleet status` and `fleet status <id>` can never
      // report two states for one record. A whole-fleet row that still said
      // `live` here while the single row said `not-running` would be that split,
      // live. Read from `single.state` rather than re-typed, so the two can only
      // ever be compared and never independently drift.
      expect(rows.some((r) => r.runId === runId && r.state === single.state)).toBeTrue();
      expect(rows.some((r) => r.state === "listUnavailable")).toBeFalse();

      // ── leaf-1.3.1:G12 — an approval-echoed state is NEVER probed, LIVE ────
      // leaf-1.1.3 proved this at unit level, where the marker read is skipped
      // anyway (a FakeDriver has no `execTimed`, so `markerReader` resolves
      // nothing and NO row is probed). The property only has teeth in the one
      // configuration where probing is possible at all — a real `ExeDevDriver`
      // against a real box — which is here.
      //
      // The discriminator is the word itself, and it is why this record names
      // the box the single-run read above PROBED to `not-running` rather than a
      // box of its own: same substrate, same absent marker, same driver, one
      // difference. Probed, this row would read `not-running` too (absent
      // marker + `inactive` unit, post-AC5 vocabulary). It reads `live`
      // only if `approvalRowFields` echoed the record's own word and
      // `rowForRecord` returned `live` as its OWN flag instead of re-reading
      // `row.state` (status.ts:862-874). Probing it would overwrite a
      // fail-VISIBLE approval signal with a run state while `attachToRun` goes
      // on refusing the same record `run-not-attachable` — the two-verdicts-on-
      // one-record contradiction that arm exists to prevent.
      //
      // `live` here is NOT the pre-AC5 vocabulary regression G11 forbids: that
      // one is a row whose state was DERIVED as `live` because the marker read
      // never ran. This one is a state the RECORD carries, echoed verbatim.
      // The `not-running` row above is what proves the derivation still happens.
      // (Round 3, E2-2: this comment used to argue in the pre-AC5 `running`
      // vocabulary — the assertion was already post-AC5; the prose was not.)
      approvalRunId = runIdFor("t12a");
      store.create(approvalRunId);
      // `state: "live"` is deliberately a word this build's approval vocabulary
      // does NOT mint (it writes pausing/awaiting-approval/approved/rejected/
      // timed-out). It is the adversarial case: a hand-migrated or newer
      // writer's word that COLLIDES with a run-state word. A settled word would
      // fall through to the ordinary arms and prove nothing.
      store.set(approvalRunId, { vmName: runId, extensions: { approval: { state: "live" } } });
      const approvalStatus = await runFleet(
        ["status", approvalRunId, "--driver", "exedev", "--dir", recordsDir],
        { timeoutMs: 120_000 },
      );
      const approvalRow = JSON.parse(approvalStatus.stdout.trim().split("\n").at(-1) ?? "{}") as {
        runId?: string;
        state?: string;
      };
      evidence.push({
        phase: "approval-echo-unprobed",
        exitCode: approvalStatus.exitCode,
        runId: approvalRunId,
        vmName: runId,
        state: approvalRow.state,
      });
      expect(approvalStatus.exitCode).toBe(0);
      expect(approvalRow.runId).toBe(approvalRunId);
      expect(approvalRow.state).toBe("live");
      // CLOSED as soon as it has served its purpose (L17). `store.create` +
      // `store.set({vmName: runId})` mints a SECOND OPEN record pointing at the
      // SAME box, and the `finally` tears down only `runId` — so for the rest of
      // the round two open records name one VM, and the whole-fleet `status`
      // this test asserts on sees both. Nothing leaks a box, but the only thing
      // keeping that benign was placing this leg AFTER those assertions, and
      // nothing enforced that ordering. Closing here does — and since round 3
      // (E2-3) it closes on the RED path too: the close used to be the leg's
      // LAST statement, so any failure above it (a non-zero verb exit, a state
      // mismatch) skipped it and left the two-open-records hazard it exists to
      // prevent live until the round ended. The finally below now owns it.
      evidence.push({ phase: "approval-echo-closed", runId: approvalRunId, deferredTo: "finally" });
    } catch (e) {
      outcome = "fail";
      // HELD, not re-thrown: the post-`finally` verdict must render on the red
      // path too — the failing run is the one that actually leaks.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // E2-3: the approval-echo record closes HERE so a red body cannot skip
      // it — guarded, because `close` on a store that failed to create it is
      // itself a throw, and this finally's job is the box teardown below.
      if (approvalRunId !== "" && approvalStore !== undefined) {
        try {
          approvalStore.close(approvalRunId);
        } catch (closeError) {
          evidence.push({
            phase: "approval-echo-close-failed",
            error: closeError instanceof Error ? closeError.message : String(closeError),
          });
        }
      }
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
