/**
 * A3 · the mandatory live first-firing round (story DoD "Test (e2e demo)") —
 * Tier 2, deliberately: ONE box, ONE sweep, ONE parked brief.
 *
 * The factory half of the round, end to end on the real substrate:
 *   1. the REAL sweep pass (`bun scripts/maintenance-sweep.ts --max-briefs 1`)
 *      — real graph leg under A6's shared lock, real audit walk, real
 *      `fleet submit` (dispatch + engine start) of exactly one brief;
 *   2. `fleet observe <runId>` — DF3.7's chain, the same entry point the
 *      operator's DF3.8 `observe --all` cron drives in production, scoped to
 *      THIS run so the round never drives anyone else's open records —
 *      harvest → teardown → reverify → the gate's own requestApproval;
 *   3. the record rests at `extensions.approval.state = "awaiting-approval"`,
 *      `closedAt` set, bundle present; no PR merged; the sweep's report record
 *      persisted `pending` for the wake to deliver.
 *
 * THE WAKE LEG IS OPERATOR-SIDE: the bot wake fires from the E21 Home's
 * persisted schedule row (fork config, A1's surface) — this repo codes none of
 * it. The operator confirms the Maintenance manager bot's report turn named
 * this sweep's `sweepId` and flipped the record to `delivered`; the evidence
 * JSON carries the sweepId to check against.
 *
 * NO-MERGE BY CONSTRUCTION: nothing here approves. The parked run is left for
 * the operator's human decision (`fleet approve`/`reject` — scrypt-gated,
 * token-on-stdin, human-only, INV-A3-GATE). The box is destroyed by the
 * chain's own teardown; a run that never reached the chain is torn down in
 * `finally`.
 *
 * GATING: `QDS_E2E_LIVE=1 QDS_E2E_TIER=2` + the substrate env (`liveGate`
 * throws on a half-configured env). Plain `bun test`/CI: todo. HEAD must be
 * pushed (the brief pins `git rev-parse HEAD`), and a manager config of record
 * must sit at `QDS_A3_LIVE_CONFIG` (default config/manager.json).
 *
 * SPEND (operator GO required, e2e budget protocol): ONE key capped at
 * 50 000 µ$ by the default dispatch cap + the roster's model calls for one
 * 600 s maintain phase, ONE box for at most the 1 900 s run budget plus the
 * chain (≈ 0.6 h at 230 000 µ$/h ≈ 140 000 µ$). Worst case ≈ $0.25 + key cap.
 */

import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { killTree } from "../../../scripts/lib/kill-tree.ts";
import { liveGate, liveTodoOff, preflight, REPO_ROOT, runFleet, teardownQuietly, writeEvidenceQuietly } from "./live-harness.ts";

/** One brief, worst case: a 40-min submit child + one same-id replay, plus the legs. */
const SWEEP_CEILING_MS = 100 * 60_000;
const OBSERVE_CEILING_MS = 60 * 60_000;

test.todoIf(liveTodoOff())(
  "A3 live: one weekly sweep parks exactly one maintenance brief at awaiting-approval — zero merges",
  async () => {
    liveGate("2");
    await preflight("2");
    const worstCase = "1 key ≤ 50 000 µ$ + 1 box ≤ ~0.6 h (≈ 140 000 µ$) — worst case ≈ $0.25 + key cap";
    process.stderr.write(`[a3-live] spend estimate: ${worstCase}\n`);

    const stateDir = join(REPO_ROOT, ".sandbox", `a3-live-${Date.now()}`);
    const config = process.env.QDS_A3_LIVE_CONFIG ?? join(REPO_ROOT, "config", "manager.json");
    const evidence: Record<string, unknown>[] = [];
    const problems: string[] = [];
    let runId: string | undefined;
    let sweepId: string | undefined;
    let parked = false;

    try {
      // ── 1. the real sweep pass, capped at one brief ──
      const proc = Bun.spawn(["bun", join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "--config", config, "--max-briefs", "1"], {
        cwd: REPO_ROOT,
        detached: true,
        // Relative to the repo root: the CLI's containment check compares REAL
        // paths, and an absolute path through a symlinked checkout would not match.
        env: { ...(process.env as Record<string, string>), QDS_LOG_VERBOSE: "1", QDS_SWEEP_STATE_DIR: relative(REPO_ROOT, stateDir) },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Detached + killTree: a ceiling kill reaches the submit child too.
      const timer = setTimeout(() => killTree(proc as unknown as ChildProcess), SWEEP_CEILING_MS);
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timer);
      const events = stdout
        .split("\n")
        .filter((l) => l.includes('"operation":"maintenance.sweep"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      evidence.push({ leg: "sweep", exitCode: code, events, stderrTail: stderr.slice(-2000) });
      // runId FIRST: if the pass dispatched and then failed, `finally` must
      // still know the box to tear down.
      const plan = events.find((e) => e.event === "sweep-plan");
      sweepId = typeof plan?.sweepId === "string" ? plan.sweepId : undefined;
      const dispatched = events.find((e) => e.event === "brief-dispatched");
      if (dispatched !== undefined) runId = String(dispatched.runId);
      expect(code).toBe(0);
      if (dispatched === undefined) {
        throw new Error(
          `the sweep dispatched no brief (plan: ${JSON.stringify(plan)}) — run the round on a fresh graph (A6 refresh inside 8h) or with windowed audit signal`,
        );
      }
      runId = String(dispatched.runId);
      expect(dispatched.botId).toMatch(/^bot-/);
      expect(String(dispatched.workKey)).toMatch(/^w:maint\//);

      // ── 2. DF3.7's chain — the entry point DF3.8's observe --all drives ──
      const obs = await runFleet(["observe", runId, "--driver", "exedev"], { timeoutMs: OBSERVE_CEILING_MS });
      evidence.push({ leg: "observe", exitCode: obs.exitCode, stdoutTail: obs.stdout.slice(-2000) });
      expect(obs.exitCode).toBe(0);

      // ── 3. parked, never merged ──
      const rec = new RunRecordStore({ create: false }).get(runId);
      const approval = rec.extensions?.approval as { state?: unknown } | undefined;
      expect(approval?.state).toBe("awaiting-approval"); // live-mirror: ApprovalState union (src/reverify/approval.ts, written by approval-gate.ts — A3 asserts, never writes it)
      expect(typeof rec.closedAt).toBe("string");
      expect(existsSync(join(new RunRecordStore({ create: false }).dir, `${runId}.bundle`))).toBe(true);
      parked = true;
      // No PR exists to merge: a PR is opened host-side only AFTER a human
      // approves (D8), and the push leg records it as extensions.pr. A parked
      // run's record carries none.
      expect(rec.extensions?.pr).toBeUndefined();

      // ── 4. the durable handoff awaits the wake ──
      const report = JSON.parse(readFileSync(join(stateDir, "sweep-reports", `${sweepId}.json`), "utf8")) as Record<string, unknown>;
      expect(report.deliveryState).toBe("pending"); // live-mirror: SweepReport.deliveryState (src/maintenance/sweep-plan.ts)
      evidence.push({ leg: "report", sweepId, deliveryState: report.deliveryState, operatorStep: "confirm the Maintenance bot's wake turn delivered this sweepId" });
    } finally {
      if (runId !== undefined && !parked) {
        await teardownQuietly(["teardown", runId, "--driver", "exedev"], { okExitCodes: [0, 4, 5] }, evidence, { leg: "cleanup" });
      }
      // The state dir is KEPT (gitignored .sandbox/): the wake leg's operator
      // check reads the report record there.
      writeEvidenceQuietly("a3-live", `a3-maintenance-sweep-${Date.now()}.json`, { runId, sweepId, parked, stateDir, evidence }, problems);
    }
    expect(problems).toEqual([]);
  },
  2 * 60 * 60_000,
);
