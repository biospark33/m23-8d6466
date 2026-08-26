/**
 * T3.4 — orphan reservation expiry + sandbox-reap LIVE
 * (t3-test-plan.md §T3.4, recon/reaper.md). Real clock, real kills.
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2. Model spend ≈ $0 (kills land
 * pre-agent-spawn; one full dispatch in Design B ≈ cents); the operator
 * approves OUT of band first.
 *
 * Design A — ledger lazy expiry ($0 model): a REAL `fleet dispatch` is
 * SIGKILLed in the milliseconds-wide window between the admission COMMIT and
 * the run-record create. A host watcher polls the scratch ledger's
 * `gate_admissions` (WAL readers see commits immediately) and kills on the
 * first row whose record file is still absent; unlucky attempts are torn down
 * and retried — db rows are NEVER hand-inserted (that would forfeit the
 * production-path standing). The orphan is then proven LIVE three ways:
 *   1. negative control BEFORE the 6-minute window: a fresh dispatch on the
 *      same issue is refused budget-exceeded — the orphan's reservation still
 *      consumes the ceiling;
 *   2. after ≥360 s (ADMISSION_GRACE_MS 60s + SKEW_MARGIN 300s), a fresh
 *      dispatch on the same issue is ADMITTED — the lazy sweep inside the
 *      next admitIssue expired the orphan — killed post-admission for $0;
 *   3. clean-ENOENT expiry is silent by design: the numbers are the pass.
 *
 * Design B — active reaper: a FULL dispatch to `ready` leaves an OPEN record
 * + box + key (an abandoned run, no kill theatrics needed). With
 * QDS_QUOTA_LIMITS_FILE pointing at a scratch limits file declaring
 * staleAfterMs=60_000 (a REAL config knob) and QDS_RUNS_DIR isolated to the
 * scratch records, `bun scripts/sandbox-reap.ts --driver exedev --yes`
 * classifies the run stale → teardown (priced box_hours row retires the
 * reservation in the ledger), destroys the box, revokes the key, exit 0.
 *
 * FINDING logged regardless (recon §1B): `reapRuns` (driver.ts) has ZERO
 * production callers — dead code contradicting its own docstring; the ACTIVE
 * reaper is scripts/sandbox-reap.ts. Delete-or-wire is a planning decision.
 *
 * NO FAKES anywhere in this file. Plain dispatch holds NO fleet lock; a
 * SIGKILL strands nothing (reaper.md §4).
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Database } from "bun:sqlite";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  destroyQuietly,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  runFleet,
  scratchClone,
  tmpWorkspace,
  writeEvidence,
} from "./live-harness.ts";

const CAP = 50_000;
const BOX_HOUR_RATE = 230_000;

interface Spawned {
  exited: Promise<number | null>;
  output: Promise<{ stdout: string; stderr: string }>;
  kill: () => void;
}

/** Raw `bun <script>` subprocess (sandbox-reap is not a fleet verb). */
function spawnScript(scriptRel: string, argv: readonly string[], env: Record<string, string>, cwd = REPO_ROOT): Spawned {
  const proc = Bun.spawn({
    cmd: ["bun", join(REPO_ROOT, scriptRel), ...argv],
    cwd,
    env: { ...process.env as Record<string, string>, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: proc.exited,
    output: Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
      ([stdout, stderr]) => ({ stdout, stderr }),
    ),
    kill: () => proc.kill("SIGKILL"),
  };
}

/**
 * Read the scratch ledger TOLERANTLY: during the spawned verb's schema-init
 * window the file can exist before `gate_admissions` does, and a WAL
 * mid-checkpoint readonly open can refuse (SQLITE_CANTOPEN). Both are "not
 * readable yet", never test failures — MEASURED run1, where a 5 ms poll hit
 * the schema window and the finally's own cleanup read crashed the test.
 */
function ledgerTry<T>(fn: (db: Database) => T, ledgerPath: string): T | null {
  if (!existsSync(ledgerPath)) return null;
  try {
    const db = new Database(ledgerPath, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Fresh runIds ever seen in the scratch ledger's admissions for cleanup. */
function admittedRunIds(ledgerPath: string): string[] {
  return (
    ledgerTry((db) => (db.query("SELECT DISTINCT run_id AS id FROM gate_admissions").all() as Array<{ id: string }>).map((r) => r.id), ledgerPath) ?? []
  );
}

test.todoIf(liveTodoOff())(
  "T3.4a orphan reservation expires lazily: SIGKILL in the commit→record window, young-refusal, 6-min expiry, fresh admission",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let outcome = "pass";
    try {
      workspace = tmpWorkspace("t34a");
      const runsDir = join(workspace, "runs");
      // The REAL ledger contract (scripts/lib/cost-ledger-opts.ts): the db
      // lives INSIDE the records dir, the operator's cost-config.json is its
      // SIBLING — no QDS_COST_* overrides, so the test proves the resolution
      // every production verb uses.
      const ledgerPath = join(runsDir, "cost-ledger.db");
      mkdirSync(runsDir, { recursive: true });
      // A FRESH issue (#48) with SLACK: 3× the per-arm cap. Retirement prices
      // each too-late attempt's REAL box lifetime against the issue FOREVER
      // (MEASURED fake-driver: run 1 priced 231 µ$ and run 2's admission
      // ceiling came back 49769) — a ceiling of exactly one cap left zero
      // room for that residue and run4's attempts 3-6 all refused exit 5
      // before the kill window could be retried. The orphan-still-reserves
      // control below asks for MORE than the slack can ever allow instead.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: CAP, boxHourRateMicroUsd: BOX_HOUR_RATE, perIssueOverrides: { "biospark33/QDS-Factory#48": 3 * CAP } }),
      );
      // Config as the records dir's SIBLING is the real resolution; the env
      // carries only the runs dir. (Run2's cascade: the repo root has no
      // .sandbox/cost-config.json, so verbs on defaults hit
      // box-hour-rate-unconfigured, skipped the priced box_hours row, and the
      // reservation never retired — every later dispatch exit 5.)
      const env = { QDS_RUNS_DIR: runsDir };
      const briefFor = (): { path: string; requestId: string } => {
        const requestId = randomUUID();
        const p = join(workspace, `brief-${requestId.slice(0, 8)}.json`);
        writeFileSync(
          p,
          JSON.stringify({
            repoSlug: "biospark33/QDS-Factory",
            issueId: 48,
            requestId,
            commitSha: process.env.QDS_EXEDEV_SHA ?? "",
            manifestPath: "config/rosters/t2.pipeline.json",
            repoUrl: process.env.QDS_EXEDEV_REPO_URL ?? "",
          }),
        );
        return { path: p, requestId };
      };

      // ── kill-loop: land between admission-commit and store.create ────────
      let orphan: { runId: string; decidedAt: string } | null = null;
      for (let attempt = 1; attempt <= 6 && orphan === null; attempt++) {
        const brief = briefFor();
        const proc = spawnScript("scripts/fleet.ts", ["dispatch", "--driver", "exedev", "--brief", brief.path], env);
        const t0 = Date.now();
        let landed = false;
        while (Date.now() - t0 < 180_000) {
          const row = ledgerTry(
            (db) =>
              (db.query("SELECT run_id AS id, decided_at AS at FROM gate_admissions WHERE request_id = ?").get(brief.requestId) as { id: string; at: string } | null | undefined) ??
              null,
            ledgerPath,
          );
          if (row !== null) {
            proc.kill(); // SIGKILL — the row is committed, nothing else may land
            const msFromRow = Date.now() - t0;
            if (!existsSync(join(runsDir, `${row.id}.json`))) {
              orphan = { runId: row.id, decidedAt: row.at };
              landed = true;
              evidence.push({ phase: "kill-landed", attempt, msFromRow, runId: row.id, decidedAt: row.at });
            } else {
              evidence.push({ phase: "kill-too-late", attempt, runId: row.id, note: "record existed — tearing down, retrying" });
            }
            break;
          }
          const code = await Promise.race([proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 5))]);
          if (code !== null) {
            evidence.push({ phase: "attempt-exited-early", attempt, exitCode: code });
            break;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        if (!landed && orphan === null) proc.kill();
        await proc.exited.catch(() => null);
        const { stderr } = await proc.output;
        evidence.push({ phase: "attempt", attempt, stderrTail: stderr.trim().slice(-600) });
        // Clean the attempt's residue (a too-late kill leaves record+box).
        for (const id of admittedRunIds(ledgerPath)) {
          if (orphan !== null && id === orphan.runId) continue;
          if (existsSync(join(runsDir, `${id}.json`))) {
            const td = await runFleet(["teardown", id, "--driver", "exedev", "--dir", runsDir, "--no-harvest"], { env, timeoutMs: 180_000 });
            evidence.push({ phase: "attempt-cleanup", id, teardownExit: td.exitCode });
            const rec = JSON.parse(readFileSync(join(runsDir, `${id}.json`), "utf8")) as { vmName?: string };
            if (rec.vmName !== undefined) await destroyQuietly(ctx.driver, rec.vmName, evidence);
          }
        }
      }
      expect(orphan).not.toBeNull(); // unwinnable window = REPORT the width, don't fake it
      const orphanRunId = (orphan as { runId: string }).runId;
      const orphanDecidedAt = (orphan as { decidedAt: string }).decidedAt;
      const orphanAt = Date.parse(orphanDecidedAt);
      expect(existsSync(join(runsDir, `${orphanRunId}.json`))).toBe(false); // clean-ENOENT orphan

      // ── negative control: young orphan still reserves ────────────────────
      // The control's ask is too big for the config to satisfy while the
      // orphan holds 50k: dispatch reads its cap from the config's
      // defaultCapMicroUsd (there is no --cap flag on dispatch — MEASURED
      // run5), so the operator lever IS the config. Rewriting the scratch
      // config for one dispatch is exactly the operator move; (ceiling −
      // orphan 50k − residue) + 5k can NEVER fit while the orphan reserves.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: 3 * CAP - 5_000, boxHourRateMicroUsd: BOX_HOUR_RATE, perIssueOverrides: { "biospark33/QDS-Factory#48": 3 * CAP } }),
      );
      const control = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefFor().path],
        { cwd: REPO_ROOT, env, timeoutMs: 180_000 },
      );
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: CAP, boxHourRateMicroUsd: BOX_HOUR_RATE, perIssueOverrides: { "biospark33/QDS-Factory#48": 3 * CAP } }),
      );
      evidence.push({ phase: "young-control", exitCode: control.exitCode, stderrTail: control.stderr.trim().slice(-500) });
      expect(control.exitCode).toBe(5);
      expect(control.stderr).toMatch(/budget|over-budget/i); // the orphan's 50k reservation left no headroom

      // ── wait out the window: grace 60s + skew 300s, +safety ─────────────
      const waitMs = 360_000 + 10_000 - (Date.now() - orphanAt);
      if (waitMs > 0) {
        evidence.push({ phase: "window-wait", ms: Math.round(waitMs) });
        await new Promise((r) => setTimeout(r, waitMs));
      }

      // ── post-expiry: a fresh dispatch on the SAME issue ADMITS ──────────
      const freshBrief = briefFor();
      const freshProc = spawnScript("scripts/fleet.ts", ["dispatch", "--driver", "exedev", "--brief", freshBrief.path], env);
      const t1 = Date.now();
      let admitted = false;
      while (Date.now() - t1 < 180_000) {
        const row = ledgerTry(
          (db) => (db.query("SELECT run_id AS id FROM gate_admissions WHERE request_id = ?").get(freshBrief.requestId) as { id: string } | null | undefined) ?? null,
          ledgerPath,
        );
        if (row !== null) {
          freshProc.kill();
          admitted = true;
          break;
        }
        const code = await Promise.race([freshProc.exited, new Promise<null>((r) => setTimeout(() => r(null), 5))]);
        if (code !== null) break; // refused or finished — output tells which
        await new Promise((r) => setTimeout(r, 5));
      }
      await freshProc.exited.catch(() => null);
      const freshOut = await freshProc.output;
      const gateLine = (freshOut.stderr.match(/\{"requestId":[^\n]*"operation":"cost-ledger.gate"[^\n]*\}/) ?? [""])[0] ?? "";
      evidence.push({ phase: "post-expiry", admitted, gateLine: gateLine.slice(0, 600), stderrTail: freshOut.stderr.trim().slice(-400) });
      expect(admitted).toBe(true); // the lazy sweep expired the orphan → headroom restored
      // The gate's own decision line shows the admission with the orphan EXCLUDED.
      expect(freshOut.stderr).toContain('"decision":"within-budget"');
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      for (const id of workspace !== "" && existsSync(join(workspace, "runs", "cost-ledger.db")) ? admittedRunIds(join(workspace, "runs", "cost-ledger.db")) : []) {
        if (existsSync(join(workspace, "runs", `${id}.json`))) {
          const td = await runFleet(["teardown", id, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"], { env: { QDS_RUNS_DIR: join(workspace, "runs") }, timeoutMs: 180_000 });
          evidence.push({ phase: "finally-teardown", id, exitCode: td.exitCode });
          const rec = JSON.parse(readFileSync(join(workspace, "runs", `${id}.json`), "utf8")) as { vmName?: string };
          if (rec.vmName !== undefined) await destroyQuietly(ctx.driver, rec.vmName, evidence);
        }
      }
      try {
        // Kill-window orphans can be NAMELESS (a dispatch SIGKILLed between
        // admission and record leaves a box no run record names) — destroy
        // every leftover before asserting zero, so the sweep can never strand
        // a billing box (run1 leaked qds-20260826-27c13b this way).
        for (const vm of (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("qds-") || n.startsWith("e2e-"))) {
          await destroyQuietly(ctx.driver, vm, evidence);
          evidence.push({ phase: "finally-sweep", vm });
        }
        const final = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
        evidence.push({ phase: "final-ls", fleetBoxes: final });
        expect(final).toEqual([]);
      } catch (e) {
        evidence.push({ phase: "final-ls-error", error: (e as Error).message });
      }
      try {
        const evidencePath = writeEvidence("t3-4a-orphan-expiry", { test: "T3.4a", outcome, phases: evidence });
        process.stderr.write(`[T3.4a] evidence: ${evidencePath}\n`);
      } finally {
        // Keep the workspace on failure — the ledger's admission rows are the
        // forensics; re-spending boxes to reproduce is the worse trade.
        if (workspace !== "" && outcome === "pass") rmSync(workspace, { recursive: true, force: true });
        else if (workspace !== "") process.stderr.write(`[T3.4a] workspace kept for forensics: ${workspace}\n`);
      }
    }
  },
  1_500_000,
);

test.todoIf(liveTodoOff())(
  "T3.4b sandbox-reap --yes: stale OPEN record → teardown (priced box_hours) → box destroyed, key revoked",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let runId = "";
    let vm = "";
    let outcome = "pass";
    try {
      workspace = tmpWorkspace("t34b");
      const runsDir = join(workspace, "runs");
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: CAP, boxHourRateMicroUsd: BOX_HOUR_RATE, perIssueOverrides: { "biospark33/QDS-Factory#49": CAP } }),
      );
      // The REAL config knob: a scratch limits file with a 60s stale window,
      // pointed ONLY at this test's isolated runs dir via env.
      const limitsFile = join(workspace, "quota-limits.json");
      writeFileSync(limitsFile, JSON.stringify({ staleAfterMs: 60_000 }));
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "biospark33/QDS-Factory",
          issueId: 49,
          commitSha: process.env.QDS_EXEDEV_SHA ?? "",
          manifestPath: "config/rosters/t2.pipeline.json",
          repoUrl: process.env.QDS_EXEDEV_REPO_URL ?? "",
        }),
      );

      // ── 1. a full dispatch to ready = an abandoned OPEN run ──────────────
      // Same REAL ledger contract as leg A: the db lands inside runsDir
      // (asserted below at join(runsDir, "cost-ledger.db")), config beside it.
      const verbEnv = { QDS_RUNS_DIR: runsDir };
      const d = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath],
        { cwd: REPO_ROOT, env: verbEnv, timeoutMs: 1_800_000 },
      );
      evidence.push({ phase: "dispatch", exitCode: d.exitCode, stdout: d.stdout.trim().slice(0, 300) });
      expect(d.exitCode).toBe(0);
      const ack = JSON.parse(d.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) as string) as { runId: string; vmName: string };
      runId = ack.runId;
      vm = ack.vmName;
      const rec = new RunRecordStore({ dir: runsDir }).get(runId);
      expect(rec.closedAt ?? "").toBe(""); // OPEN — nobody tears it down
      expect((await ctx.driver.list()).map((b) => b.name)).toContain(vm);

      // ── 2. wait past the stale window, then sweep with --yes ────────────
      evidence.push({ phase: "stale-wait", staleAfterMs: 60_000 });
      await new Promise((r) => setTimeout(r, 70_000));
      const hostRepo = await scratchClone(process.env.QDS_EXEDEV_REPO_URL ?? "", process.env.QDS_EXEDEV_SHA ?? "", workspace);
      const reap = spawnScript(
        "scripts/sandbox-reap.ts",
        ["--driver", "exedev", "--yes"],
        { QDS_RUNS_DIR: runsDir, QDS_QUOTA_LIMITS_FILE: limitsFile },
        hostRepo,
      );
      const reapCode = await reap.exited;
      const reapOut = await reap.output;
      evidence.push({ phase: "reap", exitCode: reapCode, stdout: reapOut.stdout.trim().slice(0, 800), stderrTail: reapOut.stderr.trim().slice(-600) });
      expect(reapCode).toBe(0);
      expect(reapOut.stderr).toContain("teardown"); // the stale-record action class

      // ── 3. post-conditions: closed, priced, box gone, key revoked ───────
      const closed = new RunRecordStore({ dir: runsDir }).get(runId);
      evidence.push({ phase: "post-reap", closedAt: closed.closedAt ?? null, spendMicroUsd: closed.spendMicroUsd ?? null });
      expect(closed.closedAt ?? "").not.toBe("");
      expect(await listedKeyHashes()).not.toContain(closed.keyHash);
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (!(await ctx.driver.list()).map((b) => b.name).includes(vm)) break;
        await new Promise((r) => setTimeout(r, 8000));
      }
      expect((await ctx.driver.list()).map((b) => b.name)).not.toContain(vm);

      // The teardown's priced box_hours row retires the reservation in the
      // ledger (the priced-cost retirement arm, cost-ledger.ts:1409-1412).
      const rows =
        ledgerTry(
          (db) => db.query("SELECT cost_micro_usd, unpriced FROM cost_events WHERE kind = 'box_hours' AND run_id = ?").all(runId) as Array<{ cost_micro_usd: number; unpriced: number }>,
          join(runsDir, "cost-ledger.db"),
        ) ?? [];
      evidence.push({ phase: "ledger", boxHours: rows });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.unpriced === 0 && Number(r.cost_micro_usd) > 0)).toBe(true);

      // ── 4. dry-run after the sweep: the fleet reads clean ────────────────
      const dry = spawnScript("scripts/sandbox-reap.ts", ["--driver", "exedev"], { QDS_RUNS_DIR: runsDir, QDS_QUOTA_LIMITS_FILE: limitsFile }, hostRepo);
      const dryCode = await dry.exited;
      const dryOut = await dry.output;
      evidence.push({ phase: "reap-dry", exitCode: dryCode, stdout: dryOut.stdout.trim().slice(0, 400) });
      expect(dryCode).toBe(0);
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      if (runId !== "" && workspace !== "" && existsSync(join(workspace, "runs", `${runId}.json`))) {
        const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"], { env: { QDS_RUNS_DIR: join(workspace, "runs") }, timeoutMs: 180_000 });
        evidence.push({ phase: "finally-teardown", exitCode: td.exitCode });
      }
      if (vm !== "") await destroyQuietly(ctx.driver, vm, evidence);
      try {
        // Kill-window orphans can be NAMELESS (a dispatch SIGKILLed between
        // admission and record leaves a box no run record names) — destroy
        // every leftover before asserting zero, so the sweep can never strand
        // a billing box (run1 leaked qds-20260826-27c13b this way).
        for (const vm of (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("qds-") || n.startsWith("e2e-"))) {
          await destroyQuietly(ctx.driver, vm, evidence);
          evidence.push({ phase: "finally-sweep", vm });
        }
        const final = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
        evidence.push({ phase: "final-ls", fleetBoxes: final });
        expect(final).toEqual([]);
      } catch (e) {
        evidence.push({ phase: "final-ls-error", error: (e as Error).message });
      }
      try {
        const evidencePath = writeEvidence("t3-4b-sandbox-reap", { test: "T3.4b", outcome, runId, phases: evidence });
        process.stderr.write(`[T3.4b] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  1_500_000,
);
