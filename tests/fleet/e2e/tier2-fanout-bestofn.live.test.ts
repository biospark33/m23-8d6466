/**
 * T2.2 — fanout best-of-N (N=2) with REAL model arms + rank (e2e-plan.md
 * §TIER-2, paths 11+12).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 (liveGate("2") throws otherwise).
 * Operator approves spend OUT of band first: 2 keys × capMicroUsd + 2 boxes.
 *
 * WHAT IS REAL HERE: `fleet fanout --pattern best-of-n --n 2 --roster
 * lead,fixer --pin <sha> --brief <brief> --cap-micro-usd 50000` as a real
 * subprocess — two full dispatch arms (fill + setup gate C/D real chat spend
 * per arm, each on its own minted capped key), the fan-*.json FanoutRecord,
 * per-arm run records via QDS_RUNS_DIR, then BOTH arms harvested + torn down
 * through the real verbs, and `fleet rank` over the real record.
 *
 * WINNER SEMANTICS (verified from source, stated because the mission brief
 * assumed an auto-winner): best-of-N has NONE. Only the race pattern disposes
 * losers (fanout-primitive.ts disposeLosers); best-of-n returns every arm
 * `ready` with winner:null and ranking is ADVISORY (rank.ts: "ranking
 * authorizes NOTHING; the diff is the artifact and a human closes the loop",
 * fan_out_n.md:136-140). rank() stamps rankedAt only — it never sets winner.
 * So the honest live flow is: harvest BOTH arms (both diffs are the artifact),
 * tear down BOTH boxes. This test pins exactly that contract.
 *
 * STEPS-JSON (rank's step-output source): arms are dispatch-to-gate runs —
 * no engine step output exists for them in this workload (the step producer
 * would be the dispatch_task engine, which has no in-box runner today; see
 * T2.1's engine-path note). So the NULL-SCORE path is the real contract:
 * `fleet rank <id>` with no --steps-json exits 0, lists every arm with
 * score:null and an explanatory rationale, and stamps rankedAt. Pinned here.
 *
 * NO FAKES anywhere in this file.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  destroyQuietly,
  ledgerRows,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  runFleet,
  runIdFor,
  scratchClone,
  tmpWorkspace,
  writeEvidence,
} from "./live-harness.ts";

const T2_CAP_MICRO_USD = 50_000;
const T2_BOX_HOUR_RATE_MICRO_USD = 230_000;

interface ArmLine {
  fanoutId: string;
  arm: number;
  runId: string;
  outcome: string;
  vmName?: string;
}

test.todoIf(liveTodoOff())(
  "T2.2 fanout best-of-n N=2 (real arms, real spend ≤ 2×50,000 µ$) → harvest both → teardown both → rank",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const probe = runIdFor("t22probe");
    let workspace = "";
    let armRunIds: string[] = [];
    let armVms: string[] = [];
    let fanoutId = "";
    let evidencePath = "";
    let outcome = "pass";
    try {
      workspace = tmpWorkspace("t22");
      const fanoutsDir = join(workspace, "fanouts");
      const recordsDir = join(workspace, "runs");
      mkdirSync(fanoutsDir, { recursive: true });
      mkdirSync(recordsDir, { recursive: true });
      // Records follow the env chain in the SUBPROCESS (QDS_RUNS_DIR); the
      // cost config sits beside that records dir (costLedgerOpts).
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: T2_CAP_MICRO_USD, boxHourRateMicroUsd: T2_BOX_HOUR_RATE_MICRO_USD }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "biospark33/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: "config/rosters/t2.pipeline.json",
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T2_CAP_MICRO_USD, perArm: true, aggregateCapMicroUsd: 2 * T2_CAP_MICRO_USD });

      const before = (await ctx.driver.list()).map((b) => b.name);
      evidence.push({ phase: "ls-before", boxes: before.filter((n) => n.startsWith("e2e-")), probe });

      // ── 1. the fanout verb — N=2 best-of-n, pinned, capped ────────────────
      const fan = await runFleet(
        [
          "fanout", "--pattern", "best-of-n", "--n", "2",
          "--roster", "lead,fixer", "--pin", ctx.sha,
          "--brief", briefPath, "--cap-micro-usd", String(T2_CAP_MICRO_USD),
          "--driver", "exedev", "--dir", fanoutsDir,
        ],
        { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: 1_800_000 },
      );
      evidence.push({
        phase: "fanout-verb",
        exitCode: fan.exitCode,
        stdout: fan.stdout.trim().slice(0, 1200),
        stderrTail: fan.stderr.trim().slice(-800),
      });
      expect(fan.exitCode).toBe(0);

      const lines = fan.stdout.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as ArmLine & { scores?: unknown });
      const armLines = lines.filter((l) => typeof l.arm === "number").sort((a, b) => a.arm - b.arm);
      const rankLine = lines.find((l) => Array.isArray(l.scores));
      expect(armLines.length).toBe(2); // one JSON line per arm
      expect(armLines.every((l) => l.outcome === "ready")).toBe(true);
      fanoutId = armLines[0]?.fanoutId ?? "";
      expect(fanoutId).toMatch(/^fan-/);
      armRunIds = armLines.map((l) => l.runId);
      armVms = armLines.map((l) => l.vmName ?? "");
      evidence.push({ phase: "arms", fanoutId, armLines, autoRankLine: rankLine ?? null });
      // Auto-rank (advisory, in-verb): every arm unscored — the documented
      // no-steps-source contract, SAME one the rank verb pins below.
      if (rankLine !== undefined) {
        const scores = rankLine.scores as Array<{ runId: string; score: number | null }>;
        expect(scores.every((s) => s.score === null)).toBe(true);
      }

      // ── 2. BOTH boxes were LIVE on the real provider ──────────────────────
      const live = (await ctx.driver.list()).map((b) => b.name);
      for (const vm of armVms) expect(live).toContain(vm);
      evidence.push({ phase: "boxes-live", ok: true, vms: armVms });

      // ── 3. the FanoutRecord carries both runIds + roster provenance ───────
      const fans = readdirSync(fanoutsDir).filter((f) => f.startsWith("fan-"));
      expect(fans).toEqual([`${fanoutId}.json`]);
      const rec0 = JSON.parse(readFileSync(join(fanoutsDir, `${fanoutId}.json`), "utf8")) as {
        pattern: string;
        n: number;
        pin: string | null;
        arms: Array<{ arm: number; runId: string; rosterId?: string }>;
        winner: number | null;
        closedAt?: string;
        rankedAt?: string | null;
      };
      expect(rec0.pattern).toBe("best-of-n");
      expect(rec0.n).toBe(2);
      expect(rec0.pin).toBe(ctx.sha);
      expect(rec0.arms.map((a) => a.runId)).toEqual(armRunIds);
      expect(rec0.arms.map((a) => a.rosterId)).toEqual(["lead", "fixer"]);
      expect(rec0.winner).toBe(null); // advisory rank never sets winner — the human closes the loop
      expect(rec0.closedAt ?? "").not.toBe("");
      evidence.push({ phase: "fanout-record", ok: true, arms: rec0.arms });

      // ── 4. per-arm run records: money identity on both ────────────────────
      const store = new RunRecordStore({ dir: recordsDir });
      for (const id of armRunIds) {
        const r = store.get(id);
        expect(r.keyHash ?? "").not.toBe("");
        expect(r.limitMicroUsd).toBe(T2_CAP_MICRO_USD);
        expect(r.commitSha).toBe(ctx.sha);
      }
      evidence.push({ phase: "arm-records", ok: true, runIds: armRunIds });

      // ── 5. rank over the REAL record — the null-score steps contract ──────
      const rank = await runFleet(["rank", fanoutId, "--dir", fanoutsDir], { timeoutMs: 60_000 });
      evidence.push({ phase: "rank-verb", exitCode: rank.exitCode, stdout: rank.stdout.trim().slice(0, 800), stderrTail: rank.stderr.trim().slice(-400) });
      expect(rank.exitCode).toBe(0);
      const ranked = JSON.parse(
        rank.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) as string,
      ) as { fanoutId: string; scores: Array<{ arm: number; runId: string; score: number | null }>; tie: boolean; rationale: string };
      expect(ranked.fanoutId).toBe(fanoutId);
      expect(ranked.scores.map((s) => s.runId).sort()).toEqual([...armRunIds].sort());
      expect(ranked.scores.every((s) => s.score === null)).toBe(true); // no steps producer exists for these arms
      expect(ranked.rationale.trim().length).toBeGreaterThan(0);
      const rec1 = JSON.parse(readFileSync(join(fanoutsDir, `${fanoutId}.json`), "utf8")) as { rankedAt?: string | null };
      expect(rec1.rankedAt ?? "").not.toBe(""); // rank stamped it

      // ── 6. harvest BOTH arms (both diffs are the artifact), teardown BOTH ─
      const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      for (let i = 0; i < armRunIds.length; i++) {
        const id = armRunIds[i] as string;
        const h = await runFleet(["harvest", id, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, timeoutMs: 300_000 });
        evidence.push({ phase: "harvest-arm", arm: i, exitCode: h.exitCode, stdout: h.stdout.trim().slice(0, 200) });
        expect(h.exitCode).toBe(0);
        const v = Bun.spawnSync({ cmd: ["git", "bundle", "verify", join(recordsDir, `${id}.bundle`)], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
        expect(v.exitCode).toBe(0);

        const td = await runFleet(["teardown", id, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, timeoutMs: 300_000 });
        evidence.push({ phase: "teardown-arm", arm: i, exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-300) });
        expect(td.exitCode).toBe(0);

        const closed = new RunRecordStore({ dir: recordsDir }).get(id);
        expect(closed.closedAt ?? "").not.toBe("");
        expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0);
        expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(T2_CAP_MICRO_USD);
        expect(await listedKeyHashes()).not.toContain(closed.keyHash);
        expect((await ctx.driver.list()).map((b) => b.name)).not.toContain(armVms[i]);
      }
      const spends = armRunIds.map((id) => new RunRecordStore({ dir: recordsDir }).get(id).spendMicroUsd ?? 0);
      const total = spends.reduce((a, b) => a + b, 0);
      evidence.push({ phase: "spend", capPerArmMicroUsd: T2_CAP_MICRO_USD, aggregateCapMicroUsd: 2 * T2_CAP_MICRO_USD, spends, total });
      expect(total).toBeLessThanOrEqual(2 * T2_CAP_MICRO_USD);

      const boxHours = ledgerRows(
        recordsDir,
        "SELECT run_id, cost_micro_usd, unpriced FROM cost_events WHERE kind = 'box_hours' AND run_id IN (?, ?)",
        armRunIds[0] as string,
        armRunIds[1] as string,
      );
      expect(boxHours.length).toBe(2); // one priced fractional row per arm (post-F8)
      expect(boxHours.every((r) => r.unpriced === 0)).toBe(true);
      const tokensRows = ledgerRows(
        recordsDir,
        "SELECT COUNT(*) AS n FROM cost_events WHERE kind = 'tokens' AND run_id IN (?, ?)",
        armRunIds[0] as string,
        armRunIds[1] as string,
      )[0]?.n ?? -1;
      evidence.push({ phase: "ledger", boxHours, tokensRows, tokensRowsGap: "ingestCostEvent has no production caller — see run report" });
      expect(tokensRows).toBe(0);
      expect(existsSync(join(recordsDir, `${armRunIds[0]}.bundle`))).toBeTrue();
      expect(existsSync(join(recordsDir, `${armRunIds[1]}.bundle`))).toBeTrue();
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      for (let i = 0; i < armRunIds.length; i++) {
        const id = armRunIds[i] as string;
        if (workspace !== "") {
          const td = await runFleet(["teardown", id, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"], { timeoutMs: 180_000 });
          evidence.push({ phase: "finally-teardown-arm", arm: i, exitCode: td.exitCode });
        }
      }
      for (const vm of armVms) if (vm !== "") await destroyQuietly(ctx.driver, vm, evidence);
      try {
        const final = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-"));
        evidence.push({ phase: "final-ls", e2eBoxes: final });
        expect(final).toEqual([]);
      } catch (e) {
        evidence.push({ phase: "final-ls-error", error: (e as Error).message });
      }
      try {
        evidencePath = writeEvidence("t2-2-fanout-bestofn", { test: "T2.2", outcome, fanoutId, runIds: armRunIds, capMicroUsdPerArm: T2_CAP_MICRO_USD, phases: evidence });
        process.stderr.write(`[T2.2] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  2_400_000,
);
