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
// The divergence floor the close step's alarm is gated by (F032): a remainder
// at or under it is rounding-class and stays silent. The per-arm expectation
// below keys off it.
import { SPEND_DIVERGENCE_TOLERANCE_MICRO_USD } from "../../../src/providers/teardown.ts";
import {
  REPO_ROOT,
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  ledgerRows,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  runFleet,
  runIdFor,
  scratchClone,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

// 2026-11-06: 50_000 µ$ capped BELOW this leg's real measured spend (~76k µ$
// per arm — the M1.2 T2 live round's authed-call profile, same fleet shape).
// Authored-expectation defect, same family as M1.2's: the phase fail looked
// "transient" but was the cap biting. 500_000 = $0.50/arm headroom.
const T2_CAP_MICRO_USD = 500_000;
const T2_BOX_HOUR_RATE_MICRO_USD = 230_000;

interface ArmLine {
  fanoutId: string;
  arm: number;
  runId: string;
  outcome: string;
  vmName?: string;
}

test.todoIf(liveTodoOff())(
  "T2.2 fanout best-of-n N=2 (real arms, real spend ≤ 2×500,000 µ$) → harvest both → teardown both → rank",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const probe = runIdFor("t22probe");
    let workspace = "";
    let armRunIds: string[] = [];
    let armVms: string[] = [];
    let fanOut = "";
    let fanErr = "";
    let fanoutId = "";
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
      workspace = tmpWorkspace("t22");
      const fanoutsDir = join(workspace, "fanouts");
      const recordsDir = join(workspace, "runs");
      mkdirSync(fanoutsDir, { recursive: true });
      mkdirSync(recordsDir, { recursive: true });
      // Records follow the env chain in the SUBPROCESS (QDS_RUNS_DIR); the
      // cost config sits beside that records dir (costLedgerOpts).
      //
      // BOTH arms share the brief's ONE issueId, and admitIssue budgets per
      // (repoSlug, issueId) — measured live twice (gates ff6d64/b37e88): with
      // only defaultCap=50,000, arm 0's reservation consumed the whole issue
      // ceiling and arm 1 was refused `budget-exceeded` before provisioning.
      // The issue override is therefore n × per-arm: --cap-micro-usd stays the
      // PER-ARM key cap, the override declares the AGGREGATE the operator is
      // willing to spend on this issue's best-of-n.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({
          defaultCapMicroUsd: T2_CAP_MICRO_USD,
          boxHourRateMicroUsd: T2_BOX_HOUR_RATE_MICRO_USD,
          perIssueOverrides: { "Quantum-Digital-Solutions/QDS-Factory#46": 2 * T2_CAP_MICRO_USD },
        }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
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
      fanOut = fan.stdout;
      fanErr = fan.stderr;
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

      // ── 5.5 per-arm committed work — harvest counts COMMITS on sbx/<runId> ──
      // First live T2.2 (fan-20260825-df0ab4) proved both arms + the rank
      // contract but harvest reported "harvested: none": the arms' manifest is
      // a probe (echo/true), so no arm ever committed anything, and a bundle
      // never existed to verify. Same lesson as T2.1's commit-fix: the HARNESS
      // gives each arm its verified work product — one distinct file per arm,
      // committed on-box with distinct content so the two bundles differ.
      for (let i = 0; i < armVms.length; i++) {
        const c = await ctx.driver.exec(armVms[i] as string, [
          "sh", "-c",
          `cd "$HOME/src" && printf 'arm %s of fanout %s\\n' "${i}" "${fanoutId}" > t2_arm_${i}_note.txt && git add t2_arm_${i}_note.txt && git -c user.name=t2-e2e -c user.email=t2-e2e@local commit -q -m "t2.2 arm ${i} work product" && git rev-parse --short HEAD`, // live-mirror: $HOME/src = DEFAULT_FILL_WORKDIR delivery root (fill.ts)
        ]);
        evidence.push({ phase: "arm-work", arm: i, exitCode: c.exitCode, sha: c.stdout.trim() });
        expect(c.exitCode).toBe(0);
      }

      // ── 6. harvest BOTH arms (both diffs are the artifact), teardown BOTH ─
      const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      /** Each arm's teardown stderr, for the per-arm divergence-alarm check below. */
      const td2Stderrs: string[] = [];
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
        td2Stderrs.push(td.stderr);

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
      // DF2.12 G10 (2026-09-12): THESE ARMS ARE DISPATCH-ONLY BY DESIGN — the
      // fanout arms end at the dispatch ack (fill + setup gate + expose), no
      // engine ever runs, so no engine log exists and ZERO token rows per arm
      // is the CORRECT outcome. History: W2-1/W2-2 (PR #253 review) hardened
      // a `toBeGreaterThan(0)` whose premise — "a priced run leaves token
      // rows" — presupposes an engine run these arms never perform; measured
      // live, first post-flip attempt. The engine-bearing per-arm attribution
      // proof (rows per cost event, priced-SUM cross-check at the
      // SPEND_DIVERGENCE_TOLERANCE_MICRO_USD tolerance) lives in
      // tier2-df212-attribution.live.test.ts (T2.7).
      //
      // What these arms prove instead, live, PER ARM (the W2-1 per-arm lesson
      // retained — a two-id aggregate hides a one-arm gap): a priced arm whose
      // spend cannot be attributed SHOUTS — each arm's teardown close step
      // fires the spend-divergence line `unwired`, naming the provider figure
      // beside zero token rows.
      const tokenRowsPerArm = armRunIds.map((id, i) => {
        const row = ledgerRows(
          recordsDir,
          "SELECT COUNT(*) AS n FROM cost_events WHERE kind = 'tokens' AND run_id = ?",
          id,
        )[0] as { n: number } | undefined;
        const arm = {
          runId: id,
          rows: row?.n ?? -1,
          spendMicroUsd: spends[i] ?? 0,
        };
        expect(arm.rows).toBe(0);
        // The setup gate's C/D pings charged the run key even with no engine.
        expect(arm.spendMicroUsd).toBeGreaterThan(0);
        return arm;
      });
      // The alarm is TOLERANCE-GATED (F032): an unattributed remainder within
      // SPEND_DIVERGENCE_TOLERANCE_MICRO_USD is rounding-class and the close
      // step stays SILENT — measured live: these arms' gate-ping spend was
      // 72 µ$ each, far under the 1 000 µ$ floor. So the per-arm expectation
      // follows the arm's own spend: above the floor the unwired line MUST
      // have fired (measured on T2.1's engine-external worker spend); below
      // it the close is silent, and that silence is the pin.
      const unwiredPerArm = td2Stderrs.map((stderr) =>
        stderr.split("\n").filter((l) => {
          try {
            const parsed = JSON.parse(l) as { code?: string; outcome?: string };
            return parsed.code === "spend-divergence" && parsed.outcome === "unwired";
          } catch {
            return false;
          }
        }).length,
      );
      evidence.push({
        phase: "ledger",
        boxHours,
        tokenRowsPerArm,
        unwiredPerArm,
      });
      for (let i = 0; i < tokenRowsPerArm.length; i++) {
        const arm = tokenRowsPerArm[i]!;
        const fired = (unwiredPerArm[i] ?? 0) > 0;
        if (arm.spendMicroUsd > SPEND_DIVERGENCE_TOLERANCE_MICRO_USD) {
          expect(fired).toBe(true); // above-floor remainder: the alarm fired
        } else {
          expect(fired).toBe(false); // rounding-class remainder: silent close
        }
      }
      expect(existsSync(join(recordsDir, `${armRunIds[0]}.bundle`))).toBeTrue();
      expect(existsSync(join(recordsDir, `${armRunIds[1]}.bundle`))).toBeTrue();
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // Same lessons as T2.1's finally (F12/F13): recover arm ids from BOTH
      // streams when the verb refused mid-flight, and filter the leak check
      // over dispatch's real `qds-…` names, not just `e2e-…`.
      if (armRunIds.length === 0 || armVms.length === 0) {
        const combined = `${fanOut}\n${fanErr}`;
        const ids = [...combined.matchAll(/(?:qds|e2e)-[0-9]{8}-[a-z0-9]{6}/g)].map((m) => m[0]);
        armRunIds = [...new Set(ids)];
        armVms = [...armRunIds];
        evidence.push({ phase: "finally-id-recovery", runIds: armRunIds });
      }
      for (let i = 0; i < armRunIds.length; i++) {
        const id = armRunIds[i] as string;
        if (workspace !== "") {
          // `teardownQuietly`, not a bare `runFleet` (F2), and the fanout tiers
          // are where the unguarded shape cost the most: the rejection escaped
          // AT THE AWAIT, so arm 0's timeout skipped arm 1's teardown AND the
          // whole `armVms` destroy loop below — 2+ boxes leaked from one clock.
          const torn = await teardownQuietly(
            ["teardown", id, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
            { timeoutMs: 180_000 },
            evidence,
            { at: "teardown-arm", arm: i, runId: id },
          );
          if (!torn.ok) destroyFailures.push(`${id}: ${torn.error}`);
        }
      }
      for (const vm of armVms) {
        if (vm === "") continue;
        const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vm}: ${destroyed.error}`);
      }
      // The hand-rolled 5 × 8 s poll that used to live here is now
      // `fleetLeftovers` — SAME numbers, same `final-ls-retry` phase (the
      // r7-T-h1 measurement: destroy `rm` exits 0 while the box stays listed
      // 25 s+). It additionally DESTROYS what this run owns before reporting
      // it, and demotes every other `e2e-`/`qds-` box in the account to a
      // warning it has already surfaced — `strays` must NOT be folded into the
      // verdict, or one box stranded by a previous round fails every test in
      // this one. BOTH arm names AND the recovered run ids are passed: on the
      // refusal path the id recovery above sets `armVms = armRunIds`, so the
      // union is what this run can own. It never throws, so no try/catch: a
      // failed listing comes back as `owned: undefined`, which
      // `fleetCleanupProblems` renders as a problem, and a local catch would
      // swallow exactly that.
      finalBoxes = (await fleetLeftovers(ctx.driver, [...armVms, ...armRunIds], evidence)).owned;
      // The store the key verdict needs, built ABOVE the call and in its own
      // try. As an argument expression it was the one throw-capable call left
      // unguarded in this `finally`: the write-mode constructor runs
      // `assertDirMode0700` → `chmodSync`, `assertExclusiveCreateSupported()`
      // and `cleanStaleTemps()` (run-record.ts), and an EPERM/EROFS from any of
      // them escaped the `finally` at that line — discarding the accumulated
      // box-leak verdict for BOTH arms and skipping the evidence write and
      // `settleRun`, which is the exact F2/F11 shape the rest of this file
      // removes. `undefined` on throw is the truthful fallback.
      let recordStore: RunRecordStore | undefined;
      try {
        if (workspace !== "") recordStore = new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
      }
      // `hashesBefore` is ACCOUNT-WIDE, so a key minted between the two listings
      // by a CONCURRENT round (a second operator, a parallel tier) lands in this
      // run's delta and is reported as this run's leak — a false red on a clean
      // paid round, which the fallback revoke never clears because it only
      // revokes THIS run's runIds. So: attribute first. Only the hashes this
      // run's ARM RECORDS name are provably ours; the rest of the delta is
      // folded into the baseline and RECORDED as a warning, the same
      // report-wide/act-narrow split `fleetLeftovers` applies to stray boxes.
      // Stated cost: a key an arm minted whose hash never reached its record now
      // warns instead of failing — `mintRunKey` persists `keyHash` before its
      // own later refusals can throw, so that window is the record write itself.
      let keyBaseline: ReadonlySet<string> = hashesBefore;
      try {
        const ours = new Set<string>();
        for (const id of armRunIds) {
          if (id === "") continue;
          try {
            const recorded = recordStore?.get(id).keyHash;
            if (recorded !== undefined && recorded !== "") ours.add(recorded);
          } catch {
            // unreadable/absent record — its hash stays unattributed, i.e. a warning
          }
        }
        const foreign = [...(await listedKeyHashes())].filter((h) => !hashesBefore.has(h) && !ours.has(h));
        if (foreign.length > 0) {
          evidence.push({
            phase: "key-hash-delta-foreign",
            foreign,
            note: "in the account delta but NOT attributable to this run's arm records — WARNING only, does not fail this run",
          });
          keyBaseline = new Set([...hashesBefore, ...foreign]);
        }
      } catch (e) {
        // The attribution listing failed; fall back to the account-wide
        // baseline, which can only report MORE, never less — the fail-closed
        // direction.
        evidence.push({ phase: "key-hash-delta-foreign", ok: false, error: (e as Error).message });
      }
      // The KEY leak verdict, beside the box one (F17): every arm minted its own.
      keyProblems = await keyLeakProblems(
        keyBaseline,
        { driver: ctx.driver, store: recordStore, runIds: armRunIds },
        evidence,
      );
      // `writeEvidenceQuietly` (F11): an evidence-write throw — the secret-scrub
      // refusal above all — used to propagate out of this `finally` and make
      // `settleRun` below unreachable.
      writeEvidenceQuietly("T2.2", "t2-2-fanout-bestofn", { test: "T2.2", outcome, fanoutId, runIds: armRunIds, capMicroUsdPerArm: T2_CAP_MICRO_USD, phases: evidence }, destroyFailures);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // ── the post-`finally` verdict (EB3), in ONE place: `settleRun` fails a
    // green run on a cleanup problem, and on a RED one ATTACHES the problem to
    // the body's own error instead of throwing over the top of it — the bare
    // `expect(destroyFailures)` this replaces discarded the held failure
    // whenever a leak and a real regression happened on the same run.
    //
    // `evidence` as the third argument folds every `finally-revoke ok:false`
    // entry into the verdict — a `revokeQuietly` that could not prove an arm's
    // key was dead used to be evidence prose nothing asserted.  ──────────────
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // Budget audit (the tier2-image-contract shape), priced at DECLARED CEILINGS
  // — not at typical latency. A bun test-timeout abort is the ONE path where
  // the `finally` above does not execute, so it is the one path that leaves
  // BOTH arm boxes billing and BOTH minted keys live. This file used to be
  // budgeted at 2 400 000 ms against 3 060 s of its own inner ceilings
  // (fanout 1 800 + rank 60 + harvest 300 × 2 arms + teardown 300 × 2 arms),
  // i.e. the body alone could not fit, let alone the cleanup.
  //
  //   ls-before          1 control ls at 120                             120 s
  //   fanout verb        runFleet timeoutMs 1_800_000                  1 800 s
  //   boxes-live ls      1 control ls at 120                             120 s
  //   rank verb          runFleet timeoutMs 60_000                        60 s
  //   arm work           2 arms × driver.exec at 120                     240 s
  //   scratchClone       one real clone of the pinned sha, allowance     180 s
  //   harvest × 2 arms   2 × runFleet timeoutMs 300_000                  600 s
  //   teardown × 2 arms  2 × runFleet timeoutMs 300_000                  600 s
  //   per-arm verify     2 × (listedKeyHashes + control ls), allowance   480 s
  //   ledger + records   local SQLite/JSON reads                          10 s
  //                                                              body ────────
  //                                                                    4 210 s
  //   teardownQuietly    2 arms × timeoutMs 180_000                      360 s
  //   destroyQuietly     2 arms × 1 control rm at 120                    240 s
  //   fleetLeftovers     5 × (control ls 120 + 8 s wait) + its destroy
  //                      pass (2 arms) + the confirming re-list        1 000 s
  //   key attribution    one listedKeyHashes, allowance                  120 s
  //   keyLeakProblems    delta list + 2 fallback revokes + recheck list  480 s
  //   evidence + rmSync  local                                            10 s
  //                                                           finally ────────
  //                                                                    2 210 s
  //                                                                   ────────
  //                                                                    6 420 s
  //
  // Hence 6 480 s. Every inner ceiling FIRING is safe — it rejects into the
  // catch and the `finally` still runs — so the fail-safe direction for this
  // number is UP: it is what a fully degraded round may consume before the one
  // abort that skips cleanup, not a target. A healthy round finishes far inside
  // it. WHOEVER RAISES AN INNER CEILING OR ADDS A CLEANUP STEP MUST RE-ADD IT
  // HERE — this file is two boxes and two keys, so an abort here costs double.
  6_480_000,
);
