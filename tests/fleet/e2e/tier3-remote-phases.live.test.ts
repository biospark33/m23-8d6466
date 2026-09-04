/**
 * T3.5 — manifest phases executing ON THE BOX, orchestrated FROM THE HOST
 * (t3-test-plan.md §T3.5, recon/phase-engine.md §4A).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2. Operator approves spend OUT of
 * band first: 1 key × capMicroUsd + 1 box.
 *
 * WHAT IS REAL HERE: `fleet dispatch` provisions a real box (fill delivers
 * the STAMPED manifest + witness, setup gates run on the run key), then
 * `scripts/pipeline-run-remote.ts` — the honest host-side shim — fetches the
 * DELIVERED manifest + run-context.json off the box (proving the stamp rode
 * out), runs the production `loadManifest` + `runContextFrom` witness
 * reconciliation unchanged, and executes every `code` phase ON THE BOX
 * (`sh -c` in $HOME/src via driver.exec) through the production
 * Run/walkPhases/FileJournal. The journal and terminal marker land host-side;
 * the third phase commits a tracked marker file, and the REAL harvest bundle
 * must carry it.
 *
 * HONEST LABEL (in the plan's words): phases execute ON THE BOX orchestrated
 * FROM THE HOST — all production code paths, no fake substrate. The IN-BOX
 * executor remains a proposed story (G1–G3 stay open).
 *
 * PF-2 proof rides phase 1: the journal value's bounded stdoutTail must carry
 * the echoed marker (pre-PF-2 the value was {exitCode} only).
 *
 * NO FAKES anywhere in this file.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  emittedRunId,
  keyLeakProblems,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  runFleet,
  scratchClone,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

const T3_CAP_MICRO_USD = 50_000;
const T3_BOX_HOUR_RATE_MICRO_USD = 230_000;
const ISSUE_KEY = "Quantum-Digital-Solutions/QDS-Factory#46";

test.todoIf(liveTodoOff())(
  "T3.5 remote phases: dispatch → shim drives manifest phases on-box → journal+marker → harvest carries marker → teardown",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let runId = "";
    let vm = "";
    let hostRepo = "";
    let outcome = "pass";
    /** The body's own error, HELD so the post-finally verdicts run on the failing path too (EB3). */
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const destroyFailures: string[] = [];
    /** The final leak listing, hoisted: its verdict is asserted OUTSIDE the finally's catch. */
    let finalBoxes: string[] | undefined;
    /** The key population BEFORE this run — the F17 delta, rendered in the finally. */
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    try {
      workspace = tmpWorkspace("t35");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({
          defaultCapMicroUsd: T3_CAP_MICRO_USD,
          boxHourRateMicroUsd: T3_BOX_HOUR_RATE_MICRO_USD,
          perIssueOverrides: { [ISSUE_KEY]: T3_CAP_MICRO_USD },
        }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: "config/rosters/t3.pipeline.json",
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T3_CAP_MICRO_USD });

      // ── 1. dispatch: box + key + delivered stamped manifest + gates ──────
      const d = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath],
        { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: 1_800_000 },
      );
      evidence.push({ phase: "dispatch-verb", exitCode: d.exitCode, stdout: d.stdout.trim().slice(0, 400), stderrTail: d.stderr.trim().slice(-400) });
      // OWNERSHIP IS ARMED HERE — BEFORE the exit-code assertion, not from the
      // `ack` below it. Same shape as the F1 BLOCKER fixed in AC4 this round
      // (`posCreated` set after `create()` returned): `dispatch` reaches the
      // substrate and NAMES A BOX well before it can still fail, so binding
      // ownership to the success path leaves every failure path with a live box
      // nobody owns. Observed on 2026-09-03: dispatch died on a 60 s
      // `driver.create` timeout, `runId` stayed "", the `finally`'s teardown
      // fallback is guarded on `runId !== ""` so it never ran, and
      // `fleetLeftovers([vm, ""])` could not match the box — so a REAL leak was
      // downgraded to the non-failing "not this run's" stray warning and the
      // box was left billing. The stray split is right; what was wrong is that
      // this run never claimed what it created.
      //
      // Both the success ack and the failure envelopes carry the id, so it is
      // read from the raw output rather than from parsed JSON that only exists
      // on the happy path. `runId` is reassigned from `ack` below — same value,
      // kept so the ack stays the authority when there IS one.
      const emitted = emittedRunId(d.stdout, d.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(d.exitCode).toBe(0);
      const ack = JSON.parse(d.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) as string) as {
        runId: string;
        vmName: string;
        httpsUrl?: string;
        state: string;
      };
      expect(ack.state).toBe("ready");
      runId = ack.runId;
      vm = ack.vmName;
      evidence.push({ phase: "dispatch-ack", ack });

      // ── 2. the shim: production engine, phases exec ON THE BOX ───────────
      // Direct spawn — the shim is a script, not a fleet verb: runFleet routes
      // argv[0] through scripts/fleet.ts, which refuses it as an unknown verb
      // and prints the FLEET usage (run2's 3 ms exit 2). --budget-ms must be
      // ≥ the manifest's declared runBudgetMs (150000) or loadManifest
      // refuses "runBudgetMs exceeds callerBudgetMs".
      const shimProc = Bun.spawn({
        cmd: ["bun", join(REPO_ROOT, "scripts/pipeline-run-remote.ts"), "--vm", vm, "--run-id", runId, "--records-dir", recordsDir, "--budget-ms", "180000"],
        cwd: REPO_ROOT,
        env: { ...(process.env as Record<string, string>) },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [shimExit, shimStdout, shimStderr] = await Promise.all([
        shimProc.exited,
        new Response(shimProc.stdout).text(),
        new Response(shimProc.stderr).text(),
      ]);
      evidence.push({ phase: "shim", exitCode: shimExit, stdout: shimStdout.trim().slice(0, 400), stderrTail: shimStderr.trim().slice(-400) });
      expect(shimExit).toBe(0);

      // ── 3. journal rows ordered+settled; steps.json carries PF-2 tails ───
      // FileJournal persists ONE JournalFile object (pretty-printed JSON — the
      // ".jsonl" name is the engine's own filename convention, not a line
      // format; see FileJournal.flush), so parse the whole body, not per line.
      const journalPath = join(recordsDir, runId, "journal.jsonl");
      expect(existsSync(journalPath)).toBeTrue();
      const journalBody = JSON.parse(readFileSync(journalPath, "utf8")) as {
        ok?: boolean;
        phases?: Array<{ name?: string; status?: string }>;
      };
      const phaseRows = journalBody.phases ?? [];
      evidence.push({ phase: "journal", ok: journalBody.ok, rows: phaseRows.length });
      expect(journalBody.ok).toBe(true);
      expect(phaseRows.map((r) => r.name)).toEqual(["t3-probe", "t3-verify", "t3-marker"]);
      expect(phaseRows.every((r) => r.status === "success")).toBe(true);
      // PF-2: the echoed marker survives as the phase value's bounded stdout
      // tail, persisted by the shim to steps.json (the journal's PhaseRecord
      // is metadata-only — pre-PF-2 the value was {exitCode} and dropped).
      const steps = JSON.parse(readFileSync(join(recordsDir, runId, "steps.json"), "utf8")) as Array<{
        phase: string;
        exitCode: number | null;
        stdoutTail: string | null;
      }>;
      evidence.push({ phase: "steps", steps });
      expect(steps.map((s) => s.phase)).toEqual(["t3-probe", "t3-verify", "t3-marker"]);
      expect(steps.every((s) => s.exitCode === 0)).toBe(true);
      expect(steps[0]?.stdoutTail ?? "").toContain("t3-remote-engine-ran");

      // ── 4. terminal marker host-side under <records>/<runId>/journal/ ────
      const marker = join(recordsDir, runId, "journal", "final.json");
      expect(existsSync(marker)).toBeTrue();
      const markerBody = JSON.parse(readFileSync(marker, "utf8")) as { ok?: boolean };
      expect(markerBody.ok).toBe(true);

      // ── 5. money identity: delivered manifest stamp == witness == record ─
      const delivered = readFileSync(join(recordsDir, runId, "delivered", "pipeline.yaml"), "utf8");
      const deliveredLimit = (JSON.parse(delivered) as { limitMicroUsd?: number }).limitMicroUsd;
      const witness = JSON.parse(readFileSync(join(recordsDir, runId, "delivered", "run-context.json"), "utf8")) as { effectiveCeilingMicros?: number };
      const rec = new RunRecordStore({ dir: recordsDir }).get(runId);
      evidence.push({ phase: "money-identity", deliveredLimit, witnessCeiling: witness.effectiveCeilingMicros, recordLimit: rec.limitMicroUsd });
      expect(deliveredLimit).toBe(T3_CAP_MICRO_USD); // the stamp rode OUT
      expect(witness.effectiveCeilingMicros).toBe(deliveredLimit); // reconciliation input agreed
      expect(rec.limitMicroUsd).toBe(deliveredLimit); // ceiling == limitMicroUsd

      // ── 6. the REAL harvest bundle carries the on-box committed marker ──
      hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      const h = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, timeoutMs: 300_000 });
      evidence.push({ phase: "harvest", exitCode: h.exitCode, stdout: h.stdout.trim().slice(0, 200) });
      expect(h.exitCode).toBe(0);
      const show = Bun.spawnSync({ cmd: ["git", "show", `refs/sandbox/${runId}:t3_phase_marker.txt`], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      evidence.push({ phase: "marker-in-bundle", exitCode: show.exitCode, body: show.stdout.toString().trim() });
      expect(show.exitCode).toBe(0);
      expect(show.stdout.toString()).toContain("t3 phase marker");

      // ── 7. teardown: spend ≤ cap, key revoked, box gone ──────────────────
      const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, timeoutMs: 300_000 });
      evidence.push({ phase: "teardown", exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-300) });
      expect(td.exitCode).toBe(0);
      const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      expect(closed.spendMicroUsd ?? 0).toBeLessThanOrEqual(T3_CAP_MICRO_USD);
      expect(await listedKeyHashes()).not.toContain(closed.keyHash);
      expect((await ctx.driver.list()).map((b) => b.name)).not.toContain(vm);
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      if (runId !== "" && workspace !== "") {
        // `teardownQuietly`, not a bare `runFleet`: the 180 s ceiling firing
        // used to throw straight OUT of this finally, skipping the box destroy
        // and the evidence write below it (leaking a billing box) and replacing
        // the held body error with a teardown timeout. A non-zero exit was
        // recorded and never asserted, so a teardown that failed to revoke the
        // key shipped green. Both are now verdicts in `destroyFailures`.
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: 180_000 },
          evidence,
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      if (vm !== "") {
        const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vm}: ${destroyed.error}`);
      }
      // `fleetLeftovers`, not a single-shot `list()`: the substrate's destroy
      // lag is MEASURED at 25 s+ (r7-T-h1), so listing once milliseconds after
      // the destroy turned a correct cleanup into a failed real-money round.
      // It carries the 5×8 s poll, destroys owned survivors before rendering a
      // verdict, and warns (never fails) on boxes this run cannot prove it
      // owns. It NEVER throws, so no try/catch — one here would swallow the
      // `owned: undefined` that `fleetCleanupProblems` renders as "unmeasured".
      finalBoxes = (await fleetLeftovers(ctx.driver, [vm, runId], evidence)).owned;
      // The KEY leak verdict, beside the box one (F17): the teardown above can
      // exit 0 having destroyed the box and skipped the revoke, and only the
      // happy path's `not.toContain` would ever have noticed.
      keyProblems = await keyLeakProblems(
        hashesBefore,
        {
          driver: ctx.driver,
          store: workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") }),
          runIds: [runId],
        },
        evidence,
      );
      // `writeEvidenceQuietly` (F11): an evidence-write throw used to propagate
      // out of this `finally` and make `settleRun` below unreachable.
      writeEvidenceQuietly("T3.5", "t3-5-remote-phases", { test: "T3.5", outcome, runId, capMicroUsd: T3_CAP_MICRO_USD, phases: evidence }, destroyFailures);
      // Keep the workspace on failure — journal/steps/marker forensics beat
      // re-spending a box to reproduce. Cleaned up on the next green run.
      // GUARDED: `force: true` swallows ENOENT but not EBUSY/EPERM (an open
      // handle on a harvested bundle), and this is the LAST statement of the
      // `finally` — a throw here discards the held `failure` and skips
      // `settleRun`, reporting an rmSync error where the regression was.
      try {
        if (workspace !== "" && outcome === "pass") rmSync(workspace, { recursive: true, force: true });
        else if (workspace !== "") process.stderr.write(`[T3.5] workspace kept for forensics: ${workspace}\n`);
      } catch {
        // workspace cleanup is best-effort; evidence is already written
      }
    }

    // ── the post-`finally` verdict (EB3), in ONE place: `settleRun` fails a
    // green run on a cleanup problem, and on a RED one ATTACHES the problem to
    // the body's own error instead of throwing over the top of it — the bare
    // `expect(destroyFailures)` this replaces discarded the held failure
    // whenever a leak and a real regression happened on the same run. ────────
    // `evidence` as the third arg folds `finally-revoke ok:false` entries into
    // the verdict — the fold-in T5.1 was doing by hand and every other tier
    // was missing, so a fallback revoke that failed was evidence prose only.
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  1_800_000,
);
