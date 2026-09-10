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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Database } from "bun:sqlite";

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
  runIdFor,
  scratchClone,
  settleRun,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

const CAP = 50_000;
const BOX_HOUR_RATE = 230_000;
// 12 kill attempts' too-late residue is priced against the issue FOREVER; the
// young-control refusal below needs (ceiling − orphan CAP − residue) < ask =
// ceiling − 5k, i.e. residue < 45k across all attempts. 5×CAP leaves that
// much room where 3×CAP starved at attempt 3-6 (run4).
const CEILING = 5 * CAP;

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

/**
 * A run record's `vmName`, or `null` when the record cannot be read.
 *
 * This test SIGKILLs dispatches mid-flight, which is exactly how a truncated
 * `<id>.json` appears, and `teardownQuietly` can remove the file between the
 * `existsSync` that admitted the id and the read. Both cleanup loops below read
 * records they have just torn down, so the read must be total: an unreadable
 * record is "no vmName I can act on", never a throw that skips the REMAINING
 * runs' teardowns.
 */
function readVmName(recordPath: string): { vmName?: string } | null {
  try {
    return JSON.parse(readFileSync(recordPath, "utf8")) as { vmName?: string };
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
    /** The body's own error, HELD so the post-finally verdicts run on the failing path too (EB3). */
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const destroyFailures: string[] = [];
    /** The final leak listing, hoisted: its verdict is asserted OUTSIDE the finally's catch. */
    let finalBoxes: string[] | undefined;
    /**
     * The key population BEFORE this run — the F17 delta, rendered in the
     * finally. This test SIGKILLs dispatches mid-flight, so it is the tier most
     * likely to strand a minted key behind a teardown that still exits 0.
     */
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    /** Every run id this test's cleanup touched — the fallback revoke's roster. */
    const sweptRunIds: string[] = [];
    try {
      workspace = tmpWorkspace("t34a");
      const runsDir = join(workspace, "runs");
      // The REAL ledger contract (scripts/lib/cost-ledger-opts.ts): the db
      // lives INSIDE the records dir, the operator's cost-config.json is its
      // SIBLING — no QDS_COST_* overrides, so the test proves the resolution
      // every production verb uses.
      const ledgerPath = join(runsDir, "cost-ledger.db");
      mkdirSync(runsDir, { recursive: true });
      // A FRESH issue (#48) with SLACK: CEILING (5× the per-arm cap). Retirement
      // prices each too-late attempt's REAL box lifetime against the issue
      // FOREVER (MEASURED fake-driver: run 1 priced 231 µ$ and run 2's
      // admission ceiling came back 49769) — a ceiling of exactly one cap left
      // zero room for that residue and run4's attempts 3-6 all refused exit 5
      // before the kill window could be retried. The orphan-still-reserves
      // control below asks for MORE than the slack can ever allow instead.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: CAP, boxHourRateMicroUsd: BOX_HOUR_RATE, perIssueOverrides: { "Quantum-Digital-Solutions/QDS-Factory#48": CEILING } }),
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
            repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
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
      // MEASURED (runs 1-6): the window is ~1-3 ms — the admission row commits
      // ~1 ms before store.create fires. The old poller (fresh readonly open
      // per try + 5 ms race + 5 ms sleep ≈ 10 ms/cycle) caught it once in 13
      // attempts. Tightened: ONE persistent readonly WAL connection (reopened
      // only when the file resets underneath us), a hot spin of back-to-back
      // SELECTs between event-loop turns (the turn lets proc.exited resolve),
      // proc.kill() on first row sight, 12 attempts, 5×CAP ceiling.
      let orphan: { runId: string; decidedAt: string } | null = null;
      const ATTEMPTS = 12;
      let db: Database | null = null;
      const getRow = (requestId: string): { id: string; at: string } | null => {
        if (db === null) {
          if (!existsSync(ledgerPath)) return null;
          try {
            const d = new Database(ledgerPath, { readonly: true });
            d.query("SELECT 1 FROM gate_admissions LIMIT 1").get(); // schema-init window guard
            db = d;
          } catch {
            return null; // no table yet / WAL mid-checkpoint (SQLITE_CANTOPEN)
          }
        }
        try {
          return (db.query("SELECT run_id AS id, decided_at AS at FROM gate_admissions WHERE request_id = ?").get(requestId) as { id: string; at: string } | undefined) ?? null;
        } catch {
          try {
            db.close();
          } catch {
            /* already closed */
          }
          db = null; // WAL reset underneath us — the next call reopens
          return null;
        }
      };
      for (let attempt = 1; attempt <= ATTEMPTS && orphan === null; attempt++) {
        const brief = briefFor();
        getRow("warmup"); // open the reader pre-spawn so the spin starts hot
        const proc = spawnScript("scripts/fleet.ts", ["dispatch", "--driver", "exedev", "--brief", brief.path], env);
        let exited: number | null = null;
        void proc.exited.then(
          (c) => {
            exited = c;
          },
          () => {
            exited = -1;
          },
        );
        const t0 = Date.now();
        let row: { id: string; at: string } | null = null;
        while (row === null && exited === null && Date.now() - t0 < 180_000) {
          for (let i = 0; i < 256 && row === null && exited === null; i += 1) {
            row = getRow(brief.requestId);
          }
          if (row !== null || exited !== null) break;
          // db not open yet (child boot / schema init) → idle cadence; hot
          // spin only once the reader is live. Event-loop turn either way so
          // the exited flag can resolve.
          await new Promise((r) => setTimeout(r, db === null ? 5 : 0));
        }
        const msFromRow = row !== null ? Date.now() - t0 : null;
        if (row !== null) {
          proc.kill(); // SIGKILL — the row is committed, nothing else may land
          if (!existsSync(join(runsDir, `${row.id}.json`))) {
            orphan = { runId: row.id, decidedAt: row.at };
            evidence.push({ phase: "kill-landed", attempt, msFromRow, runId: row.id, decidedAt: row.at });
          } else {
            evidence.push({ phase: "kill-too-late", attempt, msFromRow, runId: row.id, note: "record existed — tearing down, retrying" });
          }
        } else {
          proc.kill();
          evidence.push({ phase: exited === null ? "attempt-timeout" : "attempt-exited-early", attempt, exitCode: exited });
          if (exited === 5) {
            // Headroom refusal mid-loop: residue already ate the ceiling —
            // further attempts are identical refusals. Fail with forensics.
            evidence.push({ phase: "headroom-refused", attempt, note: "ceiling exhausted by too-late residue" });
            break;
          }
        }
        await proc.exited.catch(() => null);
        const { stderr } = await proc.output;
        evidence.push({ phase: "attempt", attempt, stderrTail: stderr.trim().slice(-600) });
        // Clean the attempt's residue (a too-late kill leaves record+box).
        for (const id of admittedRunIds(ledgerPath)) {
          if (orphan !== null && id === orphan.runId) continue;
          if (existsSync(join(runsDir, `${id}.json`))) {
            // RECORDED, not promoted to a run-failing verdict (F12). This is
            // in-BODY best-effort cleanup of residue a deliberately SIGKILLed
            // dispatch left behind: a half-written record, run-lock contention
            // with the corpse, an already-torn-down run all exit non-zero here
            // and none of them is a defect of the thing under test. The leak
            // gate is the `destroyQuietly` below (a real box), the nameless
            // sweep in the `finally`, and `final-ls` — none of which this
            // swallows. Promoting it failed a 1.5 M ms real-money run whose
            // body passed and whose boxes were all gone.
            const torn = await teardownQuietly(
              ["teardown", id, "--driver", "exedev", "--dir", runsDir, "--no-harvest"],
              { env, timeoutMs: 180_000 },
              evidence,
              { at: "attempt-cleanup", id, bestEffort: true },
            );
            if (!torn.ok) evidence.push({ phase: "attempt-cleanup-imperfect", id, error: torn.error, note: "best-effort residue cleanup — the box destroy and the final sweep are the leak gates" });
            sweptRunIds.push(id);
            // Re-read GUARDED: the `existsSync` that admitted this id ran BEFORE
            // the teardown just above, and teardown may remove or truncate the
            // record. The teardown is deliberately best-effort; the read that
            // follows it was not, so a record that vanished between the two
            // marked a run failed for cleanup that actually worked.
            const rec = readVmName(join(runsDir, `${id}.json`));
            if (rec === null) evidence.push({ phase: "attempt-cleanup-record-gone", id, note: "record unreadable after teardown — the finally sweep and final-ls are the leak gates" });
            else if (rec.vmName !== undefined) {
              const destroyed = await destroyQuietly(ctx.driver, rec.vmName, evidence);
              if (!destroyed.ok) destroyFailures.push(`${rec.vmName}: ${destroyed.error}`);
            }
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
        JSON.stringify({ defaultCapMicroUsd: CEILING - 5_000, boxHourRateMicroUsd: BOX_HOUR_RATE, perIssueOverrides: { "Quantum-Digital-Solutions/QDS-Factory#48": CEILING } }),
      );
      const control = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefFor().path],
        { cwd: REPO_ROOT, env, timeoutMs: 180_000 },
      );
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: CAP, boxHourRateMicroUsd: BOX_HOUR_RATE, perIssueOverrides: { "Quantum-Digital-Solutions/QDS-Factory#48": CEILING } }),
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
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // `admittedRunIds` (a real sqlite read) can throw, so the ID LISTING is
      // guarded — but the per-run body is guarded PER ITERATION, not per loop.
      // The whole loop used to sit in one `try`, so the first throwing id
      // skipped `teardownQuietly` + `destroyQuietly` for EVERY later admitted
      // run (a leak) and pushed a `destroyFailures` entry that reddened an
      // otherwise clean round. This test SIGKILLs dispatches mid-flight, which
      // is exactly how a truncated `<id>.json` — the throwing statement —
      // appears, so that was the expected path, not the exotic one.
      let admitted: string[] = [];
      try {
        admitted = workspace !== "" && existsSync(join(workspace, "runs", "cost-ledger.db"))
          ? admittedRunIds(join(workspace, "runs", "cost-ledger.db"))
          : [];
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        evidence.push({ phase: "finally-run-sweep-error", error });
        destroyFailures.push(`per-run cleanup sweep could not list admissions: ${error}`);
      }
      for (const id of admitted) {
        try {
          if (!existsSync(join(workspace, "runs", `${id}.json`))) continue;
          // `teardownQuietly`, not a bare `runFleet`: a thrown teardown (the
          // 180 s ceiling) escaped this finally and skipped every later cleanup
          // — the per-run box destroy below, the nameless-orphan sweep, the
          // evidence write — while replacing the held body error. A non-zero
          // exit was recorded and never asserted. Both are verdicts now.
          const torn = await teardownQuietly(
            ["teardown", id, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
            { env: { QDS_RUNS_DIR: join(workspace, "runs") }, timeoutMs: 180_000 },
            evidence,
            { id },
          );
          if (!torn.ok) destroyFailures.push(`${id}: ${torn.error}`);
          sweptRunIds.push(id);
          // Total read (see readVmName): the teardown above may have removed
          // the record the `existsSync` two lines up admitted.
          const rec = readVmName(join(workspace, "runs", `${id}.json`));
          if (rec === null) evidence.push({ phase: "finally-record-gone", id, note: "record unreadable after teardown — the leftover sweep and final-ls are the leak gates" });
          else if (rec.vmName !== undefined) {
            const destroyed = await destroyQuietly(ctx.driver, rec.vmName, evidence);
            if (!destroyed.ok) destroyFailures.push(`${rec.vmName}: ${destroyed.error}`);
          }
        } catch (e) {
          // PER ITERATION: continue to the next id. One bad record must not
          // strand every remaining run's box.
          const error = e instanceof Error ? e.message : String(e);
          evidence.push({ phase: "finally-run-sweep-error", id, error });
          destroyFailures.push(`per-run cleanup failed for ${id}: ${error}`);
        }
      }
      // Kill-window orphans can be NAMELESS — a dispatch SIGKILLed between the
      // admission commit and `store.create` leaves a box no run record names
      // (run1 leaked qds-20260826-27c13b this way). But the admission COMMITS
      // first, so its run id is in `gate_admissions` even when the record is
      // not on disk, and the fleet creates boxes as driver.create(runId): the
      // ledger's admission roster IS this run's ownership proof, and it covers
      // the nameless case the old account-wide `qds-|e2e-` destroy was reaching
      // for. Scoping to it is what stops a concurrent round's live box being
      // destroyed mid-body by this `finally`.
      //
      // `fleetLeftovers` then carries the 5 × 8 s poll against the MEASURED
      // 25 s+ destroy lag (r7-T-h1) this site never had, destroys owned
      // survivors before rendering the verdict, and warns — never fails — on
      // everything else. It never throws, so no try/catch: one here would
      // swallow the `owned: undefined` that `fleetCleanupProblems` renders as
      // "an unmeasured fleet is never a clean one".
      finalBoxes = (await fleetLeftovers(ctx.driver, [...new Set([...admitted, ...sweptRunIds])], evidence)).owned;
      // The KEY leak verdict, beside the box one (F17): a dispatch SIGKILLed
      // after its mint leaves a live key no box names.
      keyProblems = await keyLeakProblems(
        hashesBefore,
        {
          driver: ctx.driver,
          store: workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") }),
          runIds: [...new Set(sweptRunIds)],
        },
        evidence,
      );
      // `writeEvidenceQuietly` (F11): an evidence-write throw used to propagate
      // out of this `finally` and make `settleRun` below unreachable.
      writeEvidenceQuietly("T3.4a", "t3-4a-orphan-expiry", { test: "T3.4a", outcome, phases: evidence }, destroyFailures);
      // Keep the workspace on failure — the ledger's admission rows are the
      // forensics; re-spending boxes to reproduce is the worse trade.
      // GUARDED: `force: true` swallows ENOENT but not EBUSY/EPERM, and this is
      // the LAST statement of the `finally` — a throw here discards the held
      // `failure` and skips `settleRun` entirely.
      try {
        if (workspace !== "" && outcome === "pass") rmSync(workspace, { recursive: true, force: true });
        else if (workspace !== "") process.stderr.write(`[T3.4a] workspace kept for forensics: ${workspace}\n`);
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
      workspace = tmpWorkspace("t34b");
      const runsDir = join(workspace, "runs");
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: CAP, boxHourRateMicroUsd: BOX_HOUR_RATE, perIssueOverrides: { "Quantum-Digital-Solutions/QDS-Factory#49": CAP } }),
      );
      // The REAL config knob: a scratch limits file with a 60s stale window,
      // pointed ONLY at this test's isolated runs dir via env.
      const limitsFile = join(workspace, "quota-limits.json");
      writeFileSync(limitsFile, JSON.stringify({ staleAfterMs: 60_000 }));
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
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
      // Ownership armed BEFORE the assertion that can throw — `dispatch` names a
      // box before it can still fail, so binding ownership to the success ack
      // below leaves a failure path with a live box nobody owns. See
      // `emittedRunId`.
      const emitted = emittedRunId(d.stdout, d.stderr);
      if (emitted !== undefined) runId = emitted;
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
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      if (runId !== "" && workspace !== "" && existsSync(join(workspace, "runs", `${runId}.json`))) {
        // `teardownQuietly`, not a bare `runFleet` (F2): the 180 s ceiling
        // REJECTS out of this `finally` at the await, skipping the box destroy
        // below, the nameless-orphan sweep, the evidence write and `settleRun`.
        const torn = await teardownQuietly(
          ["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"],
          { env: { QDS_RUNS_DIR: join(workspace, "runs") }, timeoutMs: 180_000 },
          evidence,
          { at: "teardown", runId },
        );
        if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
      }
      if (vm !== "") {
        const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
        if (!destroyed.ok) destroyFailures.push(`${vm}: ${destroyed.error}`);
      }
      // OWNERSHIP, not the account: this leg's dispatch may fail before its ack
      // names the box, but it writes the run record BEFORE the box exists, so
      // every `<id>.json` in THIS workspace names a box that is ours — and the
      // fleet creates boxes as driver.create(runId), so the file name IS the box
      // name. The old shape destroyed every `qds-`/`e2e-` box in the ACCOUNT on
      // the premise that no concurrent live round exists, which is a skill-doc
      // mandate rather than a lock: two of these files running at once had each
      // `finally` destroying the other's live box mid-body.
      let ownedIds: string[] = [runId, vm].filter((n) => n !== "");
      if (workspace !== "") {
        try {
          ownedIds = [
            ...new Set([
              ...ownedIds,
              ...readdirSync(join(workspace, "runs")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)),
            ]),
          ];
        } catch (e) {
          // The records dir is unreadable; [runId, vm] is still a real roster.
          evidence.push({ phase: "finally-owned-ids-error", error: (e as Error).message });
        }
      }
      // `fleetLeftovers` carries the 5 × 8 s poll against the MEASURED 25 s+
      // destroy lag (r7-T-h1) this site never had, destroys owned survivors
      // before rendering the verdict, and warns — never fails — on everything
      // else. It never throws; a try/catch here would swallow the
      // `owned: undefined` that `fleetCleanupProblems` renders as "an unmeasured
      // fleet is never a clean one".
      finalBoxes = (await fleetLeftovers(ctx.driver, ownedIds, evidence)).owned;
      // The KEY leak verdict, beside the box one (F17): "key revoked" is half
      // of this test's own title, and it was only ever asserted on the happy
      // path — a reap that destroyed the box and exited 0 without revoking
      // reported clean from the `finally` onward.
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
      writeEvidenceQuietly("T3.4b", "t3-4b-sandbox-reap", { test: "T3.4b", outcome, runId, phases: evidence }, destroyFailures);
      // GUARDED: `force: true` swallows ENOENT but not EBUSY/EPERM (this leg
      // makes a scratch clone), and this is the LAST statement of the
      // `finally` — a throw discards the held `failure` and skips `settleRun`.
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
  1_500_000,
);

/**
 * T3.4c/d/e — DF2-11's sweep-side lock contract and the reap-history ceiling,
 * on real boxes and real files (AC4 + the REAP_HISTORY_MAX_REPORTS ceiling).
 *
 * Unlike T3.4b above (whose setup is a full PAID dispatch), these legs build
 * their runs the TIER-1 way — `store.create` + a real `driver.create` box, no
 * dispatch, no key, no model call — and make them stale by back-dating the
 * record's `createdAt` past the scratch limits file's `staleAfterMs` (the same
 * knob T3.4b drives with a real 70 s wait; back-dating is what makes the aged
 * classification deterministic instead of a sleep). The record files are the
 * real store's own format on disk — a hand-edited field, not a fake store.
 *
 * ZERO model spend, TIER-1 by the gate: boxes are created and destroyed, keys
 * are enumerated but never minted or revoked.
 */

/** Back-date a record's `createdAt` so `aged()` classifies it stale on sight. */
function backdateRecord(runsDir: string, runId: string, ageMs: number): void {
  const p = join(runsDir, `${runId}.json`);
  const rec = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  rec.createdAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(p, JSON.stringify(rec, null, 2));
}

/**
 * The lock holder for the sweep legs — same shape T1.6b/c use: a REAL second
 * process holding `<runsDir>/<runId>.lock` through the production primitive.
 */
const SWEEP_HOLDER_SCRIPT = `\
import { acquireRunLock } from "#HOLDER_IMPORTS#";
import { writeFileSync } from "node:fs";
const [, , runsDir, runId, readyFile] = process.argv;
acquireRunLock(runsDir, runId, "e2e-sweep-holder");
writeFileSync(readyFile, String(process.pid));
setInterval(() => {}, 30_000);
`;

async function spawnSweepHolder(
  scriptPath: string,
  runsDir: string,
  runId: string,
  readyFile: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; kill: () => void; exited: Promise<number> }> {
  const proc = Bun.spawn({
    cmd: ["bun", scriptPath, runsDir, runId, readyFile],
    cwd: REPO_ROOT,
    env: { ...process.env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 30_000;
  while (!existsSync(readyFile)) {
    if (Date.now() >= deadline) {
      proc.kill("SIGKILL");
      throw new Error(`sweep holder for ${runId} never became ready within 30s`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { proc, kill: () => proc.kill("SIGKILL"), exited: proc.exited };
}

/**
 * The shared body of both refusal legs. `holderMode` picks the contention:
 *
 *  - "busy"  — a LIVE holder process: the refusal is the ordinary contention
 *              flavor, and the leg's subject is AC4's CONTINUATION claim (the
 *              sweep keeps executing its remaining units past a refusal).
 *  - "stale" — the holder is SIGKILLed before the sweep: the refusal is the
 *              stale flavor, and the leg's subject is AC4's WORDING claim
 *              (the stale lock is reported with its own `rm` line, not folded
 *              into the benign skip).
 *
 * With `withSecondRun` the sweep also carries an UNLOCKED stale sibling, so
 * the busy leg can prove the sweep really continued past the refusal and
 * executed it (real teardown: record closed, box destroyed, priced box_hours).
 */
async function sweepRefusalLeg(
  label: "T3.4c" | "T3.4d",
  holderMode: "busy" | "stale",
  withSecondRun: boolean,
): Promise<void> {
  liveGate("1");
  const evidence: Record<string, unknown>[] = [];
  const ctx = await preflight();
  let workspace = "";
  let outcome = "fail";
  /** Box names this leg created — every one is destroyed in the finally. */
  const ownedVms: string[] = [];
  const ownedRunIds: string[] = [];
  let failure: unknown;
  let keyProblems: string[] = [];
  const destroyFailures: string[] = [];
  let finalBoxes: string[] | undefined;
  const hashesBefore = await listedKeyHashes();
  let holder: Awaited<ReturnType<typeof spawnSweepHolder>> | undefined;
  try {
    workspace = tmpWorkspace(label.toLowerCase());
    const runsDir = join(workspace, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(workspace, "cost-config.json"),
      JSON.stringify({ boxHourRateMicroUsd: BOX_HOUR_RATE }),
    );
    const limitsFile = join(workspace, "quota-limits.json");
    writeFileSync(limitsFile, JSON.stringify({ staleAfterMs: 60_000 }));
    const scriptPath = join(workspace, "holder.ts");
    writeFileSync(
      scriptPath,
      SWEEP_HOLDER_SCRIPT.replace("#HOLDER_IMPORTS#", JSON.stringify(join(REPO_ROOT, "scripts/lib/run-lock.ts"))),
    );

    // ── the runs: real boxes, real records, aged by back-dating ────────────
    const store = new RunRecordStore({ dir: runsDir });
    const lockedId = runIdFor("swp-lock");
    store.create(lockedId);
    const lockedVm = (await ctx.driver.create(lockedId)).name;
    ownedVms.push(lockedVm);
    ownedRunIds.push(lockedId);
    store.set(lockedId, { vmName: lockedVm });
    backdateRecord(runsDir, lockedId, 120_000);
    evidence.push({ phase: "provision-locked", runId: lockedId, vm: lockedVm });

    let executedId = "";
    let executedVm = "";
    if (withSecondRun) {
      executedId = runIdFor("swp-exec");
      store.create(executedId);
      executedVm = (await ctx.driver.create(executedId)).name;
      ownedVms.push(executedVm);
      ownedRunIds.push(executedId);
      store.set(executedId, { vmName: executedVm });
      backdateRecord(runsDir, executedId, 120_000);
      evidence.push({ phase: "provision-executed", runId: executedId, vm: executedVm });
    }

    // ── the contention ──────────────────────────────────────────────────────
    const readyFile = join(workspace, `${lockedId}.ready`);
    holder = await spawnSweepHolder(scriptPath, runsDir, lockedId, readyFile);
    if (holderMode === "stale") {
      holder.kill();
      await holder.exited;
      holder = undefined;
      // The stale artifact: the lock FILE remains over a dead pid.
      expect(existsSync(join(runsDir, `${lockedId}.lock`)), "the killed holder's lock file remains").toBeTrue();
    }

    // ── the sweep, --yes, REAL driver, cwd = workspace (reap dir + ledger) ─
    const reap = spawnScript(
      "scripts/sandbox-reap.ts",
      ["--driver", "exedev", "--yes"],
      { QDS_RUNS_DIR: runsDir, QDS_QUOTA_LIMITS_FILE: limitsFile },
      workspace,
    );
    const reapCode = await reap.exited;
    const reapOut = await reap.output;
    // Assert-before-record: the refusal lines name run ids and remediations,
    // never key material, but the whole stderr still goes through the same
    // containment check every verb stream in this file gets.
    expect(reapOut.stdout + reapOut.stderr).not.toContain("sk-or-");
    evidence.push({
      phase: "reap",
      exitCode: reapCode,
      stdout: reapOut.stdout.trim().slice(0, 900),
      stderrTail: reapOut.stderr.trim().slice(-900),
    });

    // THE EXIT CONTRACT — the part this round explicitly does NOT "fix": a
    // refusal-only sweep still exits 1, because refusals land in
    // `SweepReport.failures` and apply-mode failures drive exit 1. The
    // discriminator line on stdout is how a cron consumer tells refusal-noise
    // from real failure (round-2 D1, observability only).
    expect(reapCode).toBe(1);
    if (withSecondRun) {
      expect(reapOut.stdout).toContain("1 unit(s) refused run-locked");
      expect(reapOut.stdout).toContain("the sweep executed 1 unit(s)");
    } else {
      expect(reapOut.stdout).toContain("1 unit(s) refused run-locked");
    }

    // The report file, on disk, in the workspace's own reap dir.
    const reapDir = join(workspace, ".sandbox", "reap");
    const reports = readdirSync(reapDir).filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:-\d+)?\.json$/.test(f)).sort();
    expect(reports.length).toBeGreaterThanOrEqual(1);
    const report = JSON.parse(readFileSync(join(reapDir, reports.at(-1) as string), "utf8")) as {
      mode: string;
      failures: Array<{ runId?: string; code: string; remediation?: string; message: string }>;
      executed: { teardown: Array<{ id: string }>; destroy: unknown[]; revoke: unknown[] };
    };
    evidence.push({
      phase: "report",
      mode: report.mode,
      failures: report.failures.map((f) => ({ runId: f.runId, code: f.code })),
      executedTeardown: report.executed.teardown.map((t) => t.id),
      executedRevoke: report.executed.revoke.length,
    });
    expect(report.mode).toBe("apply");
    const lockedRow = report.failures.find((f) => f.code === "run-locked" && f.runId === lockedId);
    expect(lockedRow, `no run-locked failure row for ${lockedId}`).toBeDefined();
    // The account had no leaked keys and this leg minted none: the sweep must
    // have revoked nothing. (If this goes red, the account holds a stray aged
    // key — an honest hygiene finding, surfaced, not papered over.)
    expect(report.executed.revoke.length).toBe(0);

    if (holderMode === "stale") {
      // AC4's wording claim: the STALE refusal carries its own remediation —
      // "no live process holds it" and the exact rm line — not the busy
      // arm's "wait for that invocation".
      expect(lockedRow?.remediation ?? "").toContain("no live process holds it");
      expect(lockedRow?.remediation ?? "").toContain(`rm ${join(runsDir, `${lockedId}.lock`)}`);
      expect(lockedRow?.remediation ?? "").not.toContain("wait for that invocation to finish");
    } else {
      // The BUSY refusal stays the wait-arm; a live holder must never be
      // told "no live process holds it".
      expect(lockedRow?.remediation ?? "").toContain("wait for that invocation");
      expect(lockedRow?.remediation ?? "").not.toContain("no live process holds it");
    }

    if (withSecondRun) {
      // THE CONTINUATION CLAIM: the sweep went on and REALLY tore down the
      // unlocked sibling — record closed, box destroyed, priced box_hours.
      const closed = new RunRecordStore({ dir: runsDir }).get(executedId);
      expect(closed.closedAt ?? "").not.toBe("");
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (!(await ctx.driver.list()).map((b) => b.name).includes(executedVm)) break;
        await new Promise((r) => setTimeout(r, 8_000));
      }
      expect((await ctx.driver.list()).map((b) => b.name)).not.toContain(executedVm);
      const rows =
        ledgerTry(
          (db) =>
            db.query("SELECT cost_micro_usd, unpriced FROM cost_events WHERE kind = 'box_hours' AND run_id = ?").all(executedId) as Array<{
              cost_micro_usd: number;
              unpriced: number;
            }>,
          join(runsDir, "cost-ledger.db"),
        ) ?? [];
      evidence.push({ phase: "executed-legacy", boxHours: rows });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.unpriced === 0 && Number(r.cost_micro_usd) > 0)).toBeTrue();
    }

    // THE UNTOUCHED CLAIM (both arms): the refusal fired BEFORE any box
    // operation on the locked run — its box is alive and its record open.
    // INV-LOCK-3: the teardown never started.
    const lockedStill = new RunRecordStore({ dir: runsDir }).get(lockedId);
    expect(lockedStill.closedAt ?? "").toBe("");
    expect((await ctx.driver.list()).map((b) => b.name)).toContain(lockedVm);

    outcome = "pass";
  } catch (e) {
    failure = e;
    evidence.push({ phase: "test-error", error: (e as Error).message });
  } finally {
    if (holder !== undefined) {
      holder.kill();
      await holder.exited.catch(() => {});
    }
    for (const vm of ownedVms) {
      const destroyed = await destroyQuietly(ctx.driver, vm, evidence);
      if (!destroyed.ok) destroyFailures.push(`${vm}: ${destroyed.error}`);
    }
    try {
      finalBoxes = (await fleetLeftovers(ctx.driver, ownedRunIds, evidence)).owned;
    } catch (e) {
      evidence.push({ phase: "finally-leftovers", ok: false, error: (e as Error).message });
      finalBoxes = undefined;
    }
    keyProblems = await keyLeakProblems(
      hashesBefore,
      { driver: ctx.driver, store: workspace === "" ? undefined : new RunRecordStore({ dir: join(workspace, "runs") }), runIds: ownedRunIds },
      evidence,
    );
    writeEvidenceQuietly(label, `t3-4-${label.slice(-1).toLowerCase()}`, { test: label, outcome, phases: evidence }, destroyFailures);
    try {
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    } catch (e) {
      process.stderr.write(`[${label}] workspace cleanup failed: ${(e as Error).message}\n`);
    }
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  }
}

test.todoIf(liveTodoOff())(
  "T3.4c sweep continues past a run-locked refusal: locked unit is a named skip (exit 1 by design), unlocked sibling is REALLY torn down",
  () => sweepRefusalLeg("T3.4c", "busy", true),
  900_000,
);

test.todoIf(liveTodoOff())(
  "T3.4d a STALE lock in the sweep is reported with its own wording and its rm line, not folded into the benign skip",
  () => sweepRefusalLeg("T3.4d", "stale", false),
  900_000,
);

test.todoIf(liveTodoOff())(
  "T3.4e the reap dir keeps the newest 200 reports and nothing else: prune ceiling on a REAL dir, foreign files kept",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    let workspace = "";
    let outcome = "fail";
    let failure: unknown;
    try {
      workspace = tmpWorkspace("t34e");
      const runsDir = join(workspace, "runs");
      mkdirSync(runsDir, { recursive: true });
      // The reap dir the CLI resolves relative to its CWD (spawn cwd=workspace
      // below): seeded with 205 stamp-shaped reports + files a stranger left.
      const reapDir = join(workspace, ".sandbox", "reap");
      mkdirSync(reapDir, { recursive: true });
      const STAMPS = 205;
      const stampNames: string[] = [];
      for (let i = 0; i < STAMPS; i++) {
        // Distinct, REAP_REPORT_NAME_RE-shaped, and mtime-ordered old→new:
        // the prune keeps the newest 200 by mtime (name breaks ties), so the
        // 5 OLDEST must be the ones that vanish.
        const t = new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 1_000);
        const name = `${t.toISOString().replaceAll(":", "-").replaceAll(".", ".") .slice(0, 23)}Z-${String(i).padStart(3, "0")}.json`;
        stampNames.push(name);
        writeFileSync(join(reapDir, name), "{}");
      }
      // Ensure mtime order matches name order regardless of write speed.
      const { utimesSync } = await import("node:fs");
      stampNames.forEach((name, i) => {
        utimesSync(join(reapDir, name), new Date(1_700_000_000_000 + i), new Date(1_700_000_000_000 + i));
      });
      // A stranger's files: a JSON that is NOT a report, and a non-JSON that
      // carries a stamp-shaped name. The prune's name scope (round-3 C7 /
      // round-5 BE-3) must keep BOTH — `.json` alone is not a scope, and the
      // stamp regex alone is not a deletion licence for other suffixes.
      writeFileSync(join(reapDir, "operator-notes.json"), '{"mine": true}');
      writeFileSync(join(reapDir, "2026-09-02T00-00-00.000Z.json.txt"), "not a report");

      // The DRY sweep (no --yes): classifies an empty fleet, writes its own
      // report, prunes its own history — the round-5 EE-2 mode-gate removal —
      // and exits 0 (a clean dry run is exit 0 even though 205 stale stamps
      // sit in the dir; the stamps are history, not units).
      const reap = spawnScript("scripts/sandbox-reap.ts", ["--driver", "exedev"], { QDS_RUNS_DIR: runsDir }, workspace);
      const code = await reap.exited;
      const out = await reap.output;
      evidence.push({ phase: "dry-sweep", exitCode: code, stdout: out.stdout.trim().slice(0, 400) });
      expect(code).toBe(0);

      const after = readdirSync(reapDir).sort();
      const stampSurvivors = after.filter((f) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:-\d+)?\.json$/.test(f));
      evidence.push({
        phase: "post-prune",
        total: after.length,
        stampSurvivors: stampSurvivors.length,
        oldestKept: stampSurvivors[0],
        newestSeeded: stampNames.at(-1),
        foreignKept: after.filter((f) => f === "operator-notes.json" || f === "2026-09-02T00-00-00.000Z.json.txt"),
      });
      // THE CEILING: exactly 200 stamp-shaped reports remain — the ceiling
      // REAP_HISTORY_MAX_REPORTS promises, enforced on a real directory.
      expect(stampSurvivors.length).toBe(200);
      // The NEWEST seeded report is still there (the counters keep reading
      // the freshest history); the OLDEST five are gone.
      expect(stampSurvivors).toContain(stampNames.at(-1) as string);
      for (const gone of stampNames.slice(0, 5)) {
        expect(stampSurvivors, `oldest report ${gone} must be pruned`).not.toContain(gone);
      }
      // The stranger's files survive a mode whose verb is "destroy".
      expect(after).toContain("operator-notes.json");
      expect(after).toContain("2026-09-02T00-00-00.000Z.json.txt");

      outcome = "pass";
    } catch (e) {
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      try {
        writeEvidenceQuietly("T3.4e", "t3-4e-reap-prune-ceiling", { test: "T3.4e", outcome, phases: evidence }, []);
      } catch (e) {
        process.stderr.write(`[T3.4e] evidence write failed: ${(e as Error).message}\n`);
      }
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      settleRun(failure, []);
    }
  },
  300_000,
);
