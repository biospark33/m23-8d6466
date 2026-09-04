/**
 * T3.2 — many-stories LIVE (t3-test-plan.md §T3.2, recon/stories-port.md).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 (liveGate("2") — T3 tests run on
 * the same substrate class as TIER-2; the "tier3" filename labels the audit
 * wave, not a new gate value). Operator approves spend OUT of band first.
 *
 * TWO tests, in this order:
 *
 * 1. `$0 probes` — validation refusals (pre-lock, pre-mint: no boxes, no
 *    keys, no spend) plus the P1 grouped-arithmetic refusal, the LIVE proof
 *    of the F15b fix (fanout pre-flight groups briefs by canonical
 *    (repoSlug, issueId) and refuses pre-mint when a LATER brief's issue is
 *    short — the pre-fix block read only briefList[0] and never checked it).
 *
 * 2. `happy path` — a COSTED run (halt for the operator's "go" before
 *    invoking): 2 briefs sharing one issue, perIssueOverrides declaring the
 *    2×cap aggregate, both arms through the full dispatch gates on real
 *    boxes, then harvest+teardown both. Many-stories deltas pinned vs
 *    best-of-n (T2.2): record pin === null, arms carry briefHash but NO
 *    rosterId, briefHashes distinct, NO auto-rank line, per-arm commitSha
 *    from each brief's own pin.
 *
 * NO FAKES anywhere in this file.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
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
  scratchClone,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

const T3_CAP_MICRO_USD = 50_000;
const T3_BOX_HOUR_RATE_MICRO_USD = 230_000;
const ISSUE_KEY = "Quantum-Digital-Solutions/QDS-Factory#46";

interface ArmLine {
  fanoutId: string;
  arm: number;
  runId: string;
  outcome: string;
  vmName?: string;
}

test.todoIf(liveTodoOff())(
  "T3.2 many-stories $0 probes: validation refusals + P1 grouped-arithmetic pre-mint refusal",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const workspace = tmpWorkspace("t32probe");
    let outcome = "pass";
    /** The body's own error, HELD so the cleanup verdict below renders on the red path too. */
    let failure: unknown;
    /** Cleanup problems (the evidence write is the only one this $0 probe can have). */
    const cleanupProblems: string[] = [];
    try {
      const fanoutsDir = join(workspace, "fanouts");
      const recordsDir = join(workspace, "runs");
      mkdirSync(fanoutsDir, { recursive: true });
      mkdirSync(recordsDir, { recursive: true });

      // Two briefs on TWO different issues. #46's override declares the
      // 2-arm aggregate; #47 is deliberately SHORT (30k < cap) — the P1
      // probe below expects the pre-mint refusal to name #47 with #47's own
      // numbers, and NOT #46 (which fits).
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({
          defaultCapMicroUsd: T3_CAP_MICRO_USD,
          boxHourRateMicroUsd: T3_BOX_HOUR_RATE_MICRO_USD,
          perIssueOverrides: { [ISSUE_KEY]: 2 * T3_CAP_MICRO_USD, "Quantum-Digital-Solutions/QDS-Factory#47": 30_000 },
        }),
      );
      const brief46 = {
        repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
        issueId: 46,
        commitSha: ctx.sha,
        manifestPath: "config/rosters/t2.pipeline.json",
        repoUrl: ctx.repoUrl,
      };
      const brief47 = { ...brief46, issueId: 47 };
      const briefsPath = join(workspace, "briefs.json");
      writeFileSync(briefsPath, JSON.stringify({ briefs: [brief46, brief47] }));

      const before = (await ctx.driver.list()).map((b) => b.name);
      evidence.push({ phase: "ls-before", boxes: before.filter((n) => n.startsWith("e2e-") || n.startsWith("qds-")) });

      // All four negative probes refuse BEFORE the lock: exit 2, JSON
      // envelope on stderr, zero boxes minted. They are run in ONE workspace
      // so the final fanoutsDir listing asserts no fan-*.json side effect.
      // `want` is a stderr SUBSTRING, not always the code: the CLI's own
      // mirror guard (fleet.ts:1577-1585) refuses --roster before the
      // primitive sees it, as code "usage" — the message is the stable
      // surface on that one.
      const neg = async (name: string, extra: string[], want: string, n = "2") => {
        const r = await runFleet(
          [
            "fanout", "--pattern", "many-stories", "--n", n,
            "--brief", briefsPath, "--cap-micro-usd", String(T3_CAP_MICRO_USD),
            "--driver", "exedev", "--dir", fanoutsDir, ...extra,
          ],
          { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: 120_000 },
        );
        evidence.push({ phase: name, exitCode: r.exitCode, stderrTail: r.stderr.trim().slice(-500) });
        expect(r.exitCode).toBe(2);
        expect(r.stderr).toContain(want);
      };
      await neg("neg-roster", ["--roster", "lead,fixer"], "--roster is not valid for many-stories");
      await neg("neg-pin", ["--pin", ctx.sha], "pin-mismatch");
      await neg("neg-count", [], "brief-count-mismatch", "3");
      // n=1 is LEGAL for many-stories (minN=1): two briefs against n=1 must
      // refuse on COUNT, not on invalid-n — the $0 proof n=1 passed the n-gate.
      await neg("neg-n1-legal", [], "brief-count-mismatch", "1");

      // P1 — the LIVE F15b proof. Grouped arithmetic: #46 (one arm, 50k
      // needed, 100k available) fits; #47 (one arm, 50k needed, 30k
      // available) is short → exit 5 PRE-MINT naming #47 with 50000/30000,
      // never #46. Pre-fix this exact invocation sailed past the pre-flight
      // (it read only brief 0 = #46, need n×cap=100k ≤ 100k) and arm 1's
      // real admitIssue refused budget-exceeded mid-flight — under-protection.
      const p1 = await runFleet(
        [
          "fanout", "--pattern", "many-stories", "--n", "2",
          "--brief", briefsPath, "--cap-micro-usd", String(T3_CAP_MICRO_USD),
          "--driver", "exedev", "--dir", fanoutsDir,
        ],
        { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: 120_000 },
      );
      evidence.push({ phase: "p1-grouped-refusal", exitCode: p1.exitCode, stderrTail: p1.stderr.trim().slice(-900) });
      expect(p1.exitCode).toBe(5);
      expect(p1.stderr).toContain("issue-ceiling-insufficient");
      expect(p1.stderr).toContain("Quantum-Digital-Solutions/QDS-Factory#47");
      expect(p1.stderr).toContain("50000");
      expect(p1.stderr).toContain("30000");
      expect(p1.stderr).not.toContain("Quantum-Digital-Solutions/QDS-Factory#46"); // the fitting group is not named

      // Zero side effects across every probe: nothing minted, nothing boxed.
      expect(readdirSync(fanoutsDir).filter((f) => f.startsWith("fan-"))).toEqual([]);
      const after = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
      evidence.push({ phase: "ls-after", boxes: after });
      expect(after).toEqual(before.filter((n) => n.startsWith("e2e-") || n.startsWith("qds-")));
    } catch (e) {
      outcome = "fail";
      // HELD, not re-thrown, so the evidence-write verdict below is reachable.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // F11: this `writeEvidence` was the last unguarded one in the directory.
      // It throws on ENOSPC and on the secret-scrub REFUSAL, and a throw here
      // — inside the `finally` — REPLACED the body's own refusal assertion and
      // skipped the `rmSync` on the next line.
      writeEvidenceQuietly("T3.2-probes", "t3-2-manystories-probes", { test: "T3.2 probes", outcome, phases: evidence }, cleanupProblems);
      // GUARDED: the LAST statement of the `finally`, so an EBUSY/EPERM throw
      // here would discard the held `failure` and skip `settleRun`.
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        // workspace cleanup is best-effort; evidence is already written
      }
    }

    // No box half and no key half, both by PROOF: every probe is a PRE-MINT
    // validation refusal, and the body asserts the absence of side effects
    // against the live provider (`ls-after` equals `before`, no `fan-` record).
    settleRun(failure, cleanupProblems);
  },
  600_000,
);

test.todoIf(liveTodoOff())(
  "T3.2 many-stories happy path N=2 (real arms, spend ≤ 2×50,000 µ$) → harvest both → teardown both",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
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
      workspace = tmpWorkspace("t32");
      const fanoutsDir = join(workspace, "fanouts");
      const recordsDir = join(workspace, "runs");
      mkdirSync(fanoutsDir, { recursive: true });
      mkdirSync(recordsDir, { recursive: true });
      // BOTH briefs share ONE issue (#46) → F15b group count 2 → the operator
      // declares the 2×cap aggregate on that issue, exactly T2.2's shape.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({
          defaultCapMicroUsd: T3_CAP_MICRO_USD,
          boxHourRateMicroUsd: T3_BOX_HOUR_RATE_MICRO_USD,
          perIssueOverrides: { [ISSUE_KEY]: 2 * T3_CAP_MICRO_USD },
        }),
      );
      // Two briefs on the SAME issue, made DISTINCT via issueUrl — an opaque
      // human-facing link (schema: "a link, not a lookup") that changes each
      // brief's JSON and therefore its briefHash without touching spend
      // identity, pins or manifests. brief46b is written in the SCHEMA's key
      // order (repoSlug, issueId, issueUrl, commitSha, requestId,
      // manifestPath, repoUrl): the primitive hashes the Zod-PARSED brief,
      // and Zod emits keys in schema order — a literal in any other order
      // hashes differently and the recompute assertion below would fail on
      // KEY ORDER, not content.
      const brief46 = {
        repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
        issueId: 46,
        commitSha: ctx.sha,
        manifestPath: "config/rosters/t2.pipeline.json",
        repoUrl: ctx.repoUrl,
      };
      const brief46b = {
        repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
        issueId: 46,
        issueUrl: "https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/46",
        commitSha: ctx.sha,
        manifestPath: "config/rosters/t2.pipeline.json",
        repoUrl: ctx.repoUrl,
      };
      const briefs = [brief46, brief46b];
      const briefsPath = join(workspace, "briefs.json");
      writeFileSync(briefsPath, JSON.stringify({ briefs }));
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T3_CAP_MICRO_USD, aggregateCapMicroUsd: 2 * T3_CAP_MICRO_USD });

      const fan = await runFleet(
        [
          "fanout", "--pattern", "many-stories", "--n", "2",
          "--brief", briefsPath, "--cap-micro-usd", String(T3_CAP_MICRO_USD),
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

      // NO auto-rank for many-stories (best-of-n-only): stdout is EXACTLY the
      // arm lines — no scores array anywhere.
      const lines = fan.stdout.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as ArmLine & { scores?: unknown });
      const armLines = lines.filter((l) => typeof l.arm === "number").sort((a, b) => a.arm - b.arm);
      const rankLine = lines.find((l) => Array.isArray(l.scores));
      expect(rankLine).toBeUndefined();
      expect(armLines.length).toBe(2);
      expect(armLines.every((l) => l.outcome === "ready")).toBe(true);
      fanoutId = armLines[0]?.fanoutId ?? "";
      expect(fanoutId).toMatch(/^fan-/);
      armRunIds = armLines.map((l) => l.runId);
      armVms = armLines.map((l) => l.vmName ?? "");
      expect(new Set(armRunIds).size).toBe(2);
      evidence.push({ phase: "arms", fanoutId, armLines, autoRankLine: null });

      // ── both boxes LIVE on the real provider ─────────────────────────────
      const live = (await ctx.driver.list()).map((b) => b.name);
      for (const vm of armVms) expect(live).toContain(vm);
      evidence.push({ phase: "boxes-live", ok: true, vms: armVms });

      // ── FanoutRecord: the many-stories contract vs best-of-n ─────────────
      const fans = readdirSync(fanoutsDir).filter((f) => f.startsWith("fan-"));
      expect(fans).toEqual([`${fanoutId}.json`]);
      const rec0 = JSON.parse(readFileSync(join(fanoutsDir, `${fanoutId}.json`), "utf8")) as {
        pattern: string;
        n: number;
        pin: string | null;
        arms: Array<{ arm: number; runId: string; rosterId?: string; briefHash?: string }>;
        winner: number | null;
        closedAt?: string;
        rankedAt?: string | null;
      };
      expect(rec0.pattern).toBe("many-stories");
      expect(rec0.n).toBe(2);
      expect(rec0.pin).toBe(null); // per-arm pins ride each brief — the record pins nothing
      expect(rec0.arms.map((a) => a.runId)).toEqual(armRunIds);
      for (const a of rec0.arms) expect(a.rosterId).toBeUndefined(); // --roster forbidden → no rosterId key
      expect(rec0.winner).toBe(null); // many-stories has no winner semantics
      expect(rec0.closedAt ?? "").not.toBe("");
      // briefHash contract (primitive): sha256(JSON.stringify(brief)) per arm,
      // DISTINCT because the briefs are distinct.
      const hashes = rec0.arms.map((a) => a.briefHash ?? "");
      expect(hashes.every((h) => h.length)).toBe(true);
      expect(new Set(hashes).size).toBe(2);
      for (let i = 0; i < 2; i++) {
        expect(hashes[i]).toBe(createHash("sha256").update(JSON.stringify(briefs[i])).digest("hex"));
      }
      evidence.push({ phase: "fanout-record", ok: true, arms: rec0.arms });

      // ── per-arm run records: each arm pinned by ITS OWN brief ────────────
      const store = new RunRecordStore({ dir: recordsDir });
      for (const id of armRunIds) {
        const r = store.get(id);
        expect(r.keyHash ?? "").not.toBe("");
        expect(r.limitMicroUsd).toBe(T3_CAP_MICRO_USD);
        expect(r.commitSha).toBe(ctx.sha); // both briefs pin the same SHA here — each arm stamps its own brief's
      }
      evidence.push({ phase: "arm-records", ok: true, runIds: armRunIds });

      // ── per-arm committed work (harvest counts COMMITS on sbx/<runId>) ───
      for (let i = 0; i < armVms.length; i++) {
        const c = await ctx.driver.exec(armVms[i] as string, [
          "sh", "-c",
          `cd "$HOME/src" && printf 'many-stories arm %s of %s\\n' "${i}" "${fanoutId}" > t3_ms_arm_${i}_note.txt && git add t3_ms_arm_${i}_note.txt && git -c user.name=t3-e2e -c user.email=t3-e2e@local commit -q -m "t3.2 arm ${i} work product" && git rev-parse --short HEAD`,
        ]);
        evidence.push({ phase: "arm-work", arm: i, exitCode: c.exitCode, sha: c.stdout.trim() });
        expect(c.exitCode).toBe(0);
      }

      // ── harvest BOTH stories, teardown BOTH boxes ────────────────────────
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
        expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(T3_CAP_MICRO_USD);
        expect(await listedKeyHashes()).not.toContain(closed.keyHash);
        expect((await ctx.driver.list()).map((b) => b.name)).not.toContain(armVms[i]);
      }
      const spends = armRunIds.map((id) => new RunRecordStore({ dir: recordsDir }).get(id).spendMicroUsd ?? 0);
      const total = spends.reduce((a, b) => a + b, 0);
      evidence.push({ phase: "spend", capPerArmMicroUsd: T3_CAP_MICRO_USD, aggregateCapMicroUsd: 2 * T3_CAP_MICRO_USD, spends, total });
      expect(total).toBeLessThanOrEqual(2 * T3_CAP_MICRO_USD);

      const boxHours = ledgerRows(
        recordsDir,
        "SELECT run_id, cost_micro_usd, unpriced FROM cost_events WHERE kind = 'box_hours' AND run_id IN (?, ?)",
        armRunIds[0] as string,
        armRunIds[1] as string,
      );
      expect(boxHours.length).toBe(2);
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
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // T2.2's F12/F13 lessons verbatim: recover ids from both streams, tear
      // everything down, sweep the box list to empty.
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
          // `teardownQuietly`, not a bare `runFleet` (F2): arm 0's 180 s ceiling
          // REJECTED out of this `finally` at the await, skipping arm 1's
          // teardown AND the `armVms` destroy loop below — 2 boxes from 1 clock.
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
      // `fleetLeftovers` carries the same 5 × 8 s lag poll this site hand-rolled
      // (r7-T-h1's measured 25 s+ destroy lag) and adds the two halves it was
      // missing: owned survivors are DESTROYED before the verdict is rendered,
      // and the verdict is scoped to what this run OWNS — the hand-rolled loop
      // was account-wide, so one box stranded by a concurrent operator failed a
      // clean paid round. Each arm's box name is its run id, so the arm rosters
      // (including the id-recovery above) ARE the ownership proof. It never
      // throws; a try/catch here would swallow the `owned: undefined` that
      // `fleetCleanupProblems` renders as "an unmeasured fleet is never clean".
      finalBoxes = (await fleetLeftovers(ctx.driver, [...armVms, ...armRunIds], evidence)).owned;
      // The KEY leak verdict, beside the box one (F17): every arm minted its own.
      keyProblems = await keyLeakProblems(
        hashesBefore,
        {
          driver: ctx.driver,
          store: workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") }),
          runIds: armRunIds,
        },
        evidence,
      );
      // `writeEvidenceQuietly` (F11): an evidence-write throw used to propagate
      // out of this `finally` and make `settleRun` below unreachable.
      writeEvidenceQuietly("T3.2", "t3-2-manystories", { test: "T3.2 happy path", outcome, fanoutId, runIds: armRunIds, capMicroUsdPerArm: T3_CAP_MICRO_USD, phases: evidence }, destroyFailures);
      // GUARDED: `force: true` swallows ENOENT but not EBUSY/EPERM (an open
      // handle on a harvested bundle — this test harvests two), and this is the
      // LAST statement of the `finally`: a throw discards the held `failure`
      // and skips `settleRun` entirely.
      try {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
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
  2_400_000,
);
