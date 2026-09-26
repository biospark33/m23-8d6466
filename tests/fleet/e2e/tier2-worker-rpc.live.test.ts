/**
 * P0.8 — live round for the HARDENED worker-rpc transport (roadmap P0.8):
 * dispatch → in-box engine → code phase running worker-rpc-live-runner.ts
 * (real `pi --mode rpc`, real model turn + a real prompt error) → read the
 * runner's summary off the box → teardown. No rig_swarm seats: the spend is
 * one run key (gate pings + two haiku-scale turns).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 — liveGate("2") throws on a
 * mismatch; plain `bun test`/CI: todo.
 *
 * SPEND PROTOCOL (operator "go" BEFORE this runs): 1 run key × 50_000 µ$
 * ceiling + box hours (~230_000 µ$/h; the round is minutes). Expected actual
 * ≈ 5_000 µ$ of model calls. NO FAKES: real ssh, real pi, real key.
 *
 * MANIFEST: config/rosters/p0-worker-rpc.pipeline.json (delivered from
 * QDS_EXEDEV_SHA — commit + push BEFORE dispatching). Runner: delivered
 * cli-anything/scripts/worker-rpc-live-runner.ts. Evidence:
 * QDS_E2E_EVIDENCE_DIR (the R0 evidence dir).
 */
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { redactSecrets } from "../../../src/providers/step-log.ts";
import { pollInBoxRun } from "./in-box-status-poll.ts";
import {
  awaitBoxAbsent,
  boxHome,
  destroyQuietly,
  EVIDENCE_DIR,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  recoverDispatchIds,
  runFleet,
  scratchClone,
  settleRun,
  shellQuote,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/** The run key's mint cap: gate pings + two haiku-scale turns. */
const RUN_CAP_MICRO_USD = 50_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const BOX_HOUR_RATE_MICRO_USD = 230_000;
const MANIFEST_PATH = "config/rosters/p0-worker-rpc.pipeline.json";
// live-mirror: the phase cwd is the fill run-root (DEFAULT_FILL_WORKDIR / QDS_IN_BOX_DIR, fill.ts)
const SUMMARY_BOX_PATH = "src/worker-rpc-summary.json";

test.todoIf(liveTodoOff())(
  "P0.8 dispatch→code(runner: healthy settle + prompt-error)→teardown — real box, real pi, cap 50_000 µ$",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let runId = "";
    let vmName = "";
    let dispatchOut = "";
    let dispatchErr = "";
    let outcome = "pass";
    let failure: unknown;
    const destroyFailures: string[] = [];
    let finalBoxes: string[] | undefined;
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    try {
      workspace = tmpWorkspace("p08");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: RUN_CAP_MICRO_USD, boxHourRateMicroUsd: BOX_HOUR_RATE_MICRO_USD }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoUrl: ctx.repoUrl,
          commitSha: ctx.sha,
          repoSlug: "quantum-digital-solutions/qds-factory",
          issueId: 46,
          manifestPath: MANIFEST_PATH,
        }),
      );
      evidence.push({ phase: "ls-before", boxes: await ctx.driver.list() });

      // ── dispatch (mints the run key, fills, runs the setup gate) ──
      const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      const dispatch = await runFleet(
        [
          "dispatch",
          "--brief",
          briefPath,
          "--driver",
          "exedev",
          "--dir",
          recordsDir,
          "--timeout-ms",
          "1100000",
        ],
        { cwd: hostRepo, timeoutMs: 960_000 },
      );
      dispatchOut = dispatch.stdout;
      dispatchErr = dispatch.stderr;
      // FULL stderr, not a tail: a refusal envelope lost to truncation cost
      // three diagnosis cycles on this round family (#320's finding 3).
      evidence.push({
        phase: "dispatch-verb",
        exitCode: dispatch.exitCode,
        stdoutTail: redactSecrets(dispatch.stdout.trim().slice(-600)),
        stderr: redactSecrets(dispatch.stderr),
      });
      expect(dispatch.exitCode).toBe(0);
      const ids = recoverDispatchIds(dispatch.stdout, dispatch.stderr);
      runId = ids.runId;
      vmName = ids.vmName;
      expect(runId).not.toBe("");
      evidence.push({ phase: "ack", runId, vmName });
      const home = await boxHome(ctx.driver, vmName);

      // ── run + poll to a settled verdict (the shared AC5 poll) ──
      const run = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 120_000,
      });
      evidence.push({ phase: "run-verb", exitCode: run.exitCode });
      expect(run.exitCode).toBe(0);

      // live-mirror: the engine log box path is <HOME>/<runId>.engine.log (pipeline-run.ts)
      const engineLogBoxPath = `${home}/${runId}.engine.log`;
      const poll = await pollInBoxRun(ctx.driver, vmName, {
        recordsDir,
        runId,
        engineLogBoxPath,
        evidence,
        attempts: 30,
        waitMs: 20_000,
      });
      evidence.push({ phase: "status-poll", seenStates: poll.seenStates, terminal: poll.terminal, statusExitFailures: poll.statusExitFailures });
      // live-mirror: the measured tier2-in-box-engine status vocabulary
      expect(poll.terminal).toBe("ok");

      // ── the runner's own summary, read OFF THE BOX (never trusted home-side) ──
      // live-mirror: the phase cwd is the fill run-root beside src/
      const summaryText = await ctx.driver.exec(vmName, ["sh", "-c", `cat ${shellQuote(SUMMARY_BOX_PATH)} 2>&1`]);
      expect(summaryText.exitCode).toBe(0);
      let summary: {
        healthy: { drainReason: string; exitCode: number | null; settled: boolean };
        promptError: { drainReason: string; exitCode: number | null };
      };
      try {
        summary = JSON.parse(summaryText.stdout);
      } catch (e) {
        throw new Error(`runner summary unparseable: ${(e as Error).message}: ${summaryText.stdout.slice(0, 400)}`);
      }
      evidence.push({ phase: "worker-summary", summary: redactSecrets(JSON.stringify(summary)) });
      // P0.6/P0.1: the healthy turn drained via get_state; the impossible
      // model settled the worker immediately as a prompt error.
      expect(summary.healthy.drainReason).toBe("get-state-idle");
      expect(summary.healthy.settled).toBe(true);
      expect(summary.promptError.drainReason).toBe("prompt-error");

      // ── teardown: keys revoked, spend captured, record closed ──
      const teardown = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 300_000,
      });
      evidence.push({
        phase: "teardown-verb",
        exitCode: teardown.exitCode,
        stdout: teardown.stdout.trim().slice(0, 300),
        stderrTail: redactSecrets(teardown.stderr.trim().slice(-400)),
      });
      expect(teardown.exitCode).toBe(0);

      const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0);
      expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(RUN_CAP_MICRO_USD);
      evidence.push({ phase: "spend", runCapMicroUsd: RUN_CAP_MICRO_USD, actualMicroUsd: closed.spendMicroUsd });

      // Single-key run: the CORE keyHash is the one that must be gone.
      expect(await listedKeyHashes()).not.toContain(closed.keyHash ?? "");
      const gone = await awaitBoxAbsent(ctx.driver, vmName, evidence, { maxAttempts: 4, retryDelayMs: 10_000 });
      expect(gone.absent).toBeTrue();
    } catch (e) {
      outcome = "fail";
      failure = e;
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      if (runId === "" || vmName === "") {
        const recovered = recoverDispatchIds(dispatchOut, dispatchErr);
        if (runId === "") runId = recovered.runId;
        if (vmName === "") vmName = recovered.vmName;
        evidence.push({ phase: "finally-id-recovery", runId, vmName });
      }
      if (runId !== "") {
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { timeoutMs: 180_000 },
          evidence,
          { at: "teardown-verb", runId },
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      if (vmName !== "") {
        const destroyed = await destroyQuietly(ctx.driver, vmName, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vmName}: ${destroyed.error}`);
      }
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId, vmName], evidence)).owned;
      keyProblems = await keyLeakProblems(hashesBefore, { driver: ctx.driver, runIds: [runId] }, evidence);
      writeEvidenceQuietly(
        "P0.8",
        "p0-8-worker-rpc",
        { test: "P0.8", outcome, runId, runCapMicroUsd: RUN_CAP_MICRO_USD, evidenceDir: EVIDENCE_DIR, phases: evidence },
        destroyFailures,
      );
    }
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // Budget audit, priced at DECLARED CEILINGS (tier2-dispatch-engine shape):
  // dispatch 960 s + poll 600 s + teardown 300 s + cleanup slack ≈ 2 200 s.
  // A bun test-timeout abort is the ONE path where the finally does not run,
  // so this ceiling must outlive every inner one. WHOEVER RAISES AN INNER
  // CEILING MUST RE-ADD IT HERE.
  2_300_000,
);
