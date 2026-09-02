/**
 * T3.1 — race pattern LIVE (t3-test-plan.md §T3.1, recon/race.md §3).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 (liveGate("2") — same substrate
 * class as TIER-2; the "tier3" filename labels the audit wave). Operator
 * approves spend OUT of band first: 2 keys × capMicroUsd + 2 boxes.
 *
 * WHAT IS REAL HERE: the race verb as a spawn-without-await subprocess
 * (spawnFleet) — two full dispatch arms (fill + setup gates, real chat spend,
 * one capped key each), then the REAL poller deciding the race off a REAL
 * marker: the test reads each arm's gate evidence
 * (.sandbox/setup-gate/<runId>.json) and execs `{"ok":true}` onto the
 * LOWEST-INDEX GATE-READY arm's box (/run/journal/final.json), and the
 * primitive's probe→exec-cat→parse→first-writer-claim chain runs unmodified
 * (5s ticks, 1h ceiling — no CLI knobs exist, by design). Gate B can flake
 * on a fresh box (pi registry still initializing — MEASURED att6): a
 * single-entrant race is then asserted in full (sole entrant claims, its box
 * alive, the gate-failed arm setupFailed with box+key ALIVE, INV-5); the
 * loser-teardown/ledger surface is asserted only on a full field.
 *
 * The verb holds .sandbox/fleet.lock across its ENTIRE run including the
 * race poll window — this test needs an exclusive execution window (no other
 * fleet verb may run in this repo until it finishes).
 *
 * ASSERTIONS BEYOND THE VERB: losers are torn down BY THE PRIMITIVE (not the
 * test), loser teardown prices box_hours rows through the REAL lazy loser
 * ledger hook (the DF2.8 unit proof only had a spy object), exactly one
 * "won" event / zero cross-process events, winner box left ALIVE for the
 * test's finally, and `fleet rank` afterwards stamps rankedAt while winner
 * stays untouched.
 *
 * NO FAKES anywhere in this file.
 */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  destroyQuietly,
  fleetCleanupProblems,
  keyLeakProblems,
  ledgerRows,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  runFleet,
  spawnFleet,
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

/** Poll every `intervalMs` until `pred` or `boundMs`; returns last value or throws with `what`. */
async function pollUntil<T>(
  what: string,
  pred: () => Promise<T | null>,
  boundMs: number,
  intervalMs = 2000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await pred();
    if (v !== null) return v;
    if (Date.now() - start > boundMs) throw new Error(`pollUntil(${what}) exceeded ${boundMs} ms bound`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test.todoIf(liveTodoOff())(
  "T3.1 race N=2 live: marker decides, primitive tears losers down, loser ledger rows price, rank stamps rankedAt",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let verb: ReturnType<typeof spawnFleet> | undefined;
    let armRunIds: string[] = [];
    let armVms: string[] = [];
    let fanoutId = "";
    let outcome = "pass";
    let lastRecSnap: Record<string, unknown> = {};
    /** The body's own error, HELD so the post-finally verdicts run on the failing path too (EB3). */
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const destroyFailures: string[] = [];
    /** The final leak listing, hoisted: its verdict is asserted OUTSIDE the finally's catch. */
    let finalBoxes: string[] | undefined;
    /**
     * The key population BEFORE this run — the F17 delta, rendered in the
     * finally. The degraded field deliberately leaves the gate-failed arm's key
     * LIVE during the body (INV-5, :384); the finally's teardown owns it, so
     * zero survivors after cleanup is still the verdict.
     */
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    try {
      workspace = tmpWorkspace("t31");
      const fanoutsDir = join(workspace, "fanouts");
      const recordsDir = join(workspace, "runs");
      mkdirSync(fanoutsDir, { recursive: true });
      mkdirSync(recordsDir, { recursive: true });
      // Race expands ONE brief ×2 → one (repoSlug, issueId) group of count 2
      // → the F15b pre-flight demands the 2×cap aggregate on that issue.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({
          defaultCapMicroUsd: T3_CAP_MICRO_USD,
          boxHourRateMicroUsd: T3_BOX_HOUR_RATE_MICRO_USD,
          perIssueOverrides: { [ISSUE_KEY]: 2 * T3_CAP_MICRO_USD },
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
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T3_CAP_MICRO_USD, aggregateCapMicroUsd: 2 * T3_CAP_MICRO_USD });

      // ── 1. spawn the verb WITHOUT awaiting (the lock is now held) ─────────
      verb = spawnFleet(
        [
          "fanout", "--pattern", "race", "--n", "2",
          "--roster", "lead,fixer", "--pin", ctx.sha,
          "--brief", briefPath, "--cap-micro-usd", String(T3_CAP_MICRO_USD),
          "--driver", "exedev", "--dir", fanoutsDir,
        ],
        { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir } },
      );

      // ── 2. map arm→runId from the LOCAL fan record (written pre-mint) ────
      const armMap = await pollUntil(
        "fan record arms",
        async () => {
          const files = readdirSync(fanoutsDir).filter((f) => f.startsWith("fan-"));
          if (files.length !== 1) return null;
          const rec = JSON.parse(readFileSync(join(fanoutsDir, files[0] as string), "utf8")) as {
            fanoutId: string;
            arms: Array<{ arm: number; runId: string; rosterId?: string }>;
          };
          if (rec.arms.length !== 2) return null;
          return rec;
        },
        600_000,
      );
      fanoutId = armMap.fanoutId;
      armRunIds = armMap.arms.sort((a, b) => a.arm - b.arm).map((a) => a.runId);
      evidence.push({ phase: "fan-record-early", fanoutId, arms: armMap.arms });

      // ── 3. wait until BOTH boxes exist (names == runIds), then plant ──────
      await pollUntil(
        "both boxes listed",
        async () => {
          const names = new Set((await ctx.driver.list()).map((b) => b.name));
          return armRunIds.every((id) => names.has(id)) ? names : null;
        },
        600_000,
      );
      armVms = [...armRunIds];
      evidence.push({ phase: "boxes-listed", vms: armVms });

      // ── 3.5 WHO may enter the race: read the REAL gate outcomes ─────────
      // MEASURED att6 (fan-20260826-cee620): a fresh box's pi registry can
      // still be initializing when gate B runs — "No models available. Use
      // /login" — while its sibling box, created 2 s apart, passes A–E. The
      // gate is fail-closed by design (DF2.2): that arm becomes setupFailed
      // (exit 3), its box stays ALIVE (INV-5), and it is NEVER an entrant.
      // att6 planted the marker on arm 0 blindly and raced a poller against
      // the one arm that could not win. The gate writes host-side evidence at
      // .sandbox/setup-gate/<runId>.json — read REALITY, plant on the
      // lowest-index READY arm, and expect THAT winner.
      const gateStates = await pollUntil(
        "gate evidence for both arms",
        async () => {
          const states = armVms.map((vm) => {
            try {
              const g = JSON.parse(readFileSync(join(REPO_ROOT, ".sandbox", "setup-gate", `${vm}.json`), "utf8")) as { ready?: unknown };
              return typeof g.ready === "boolean" ? g.ready : null;
            } catch {
              return null;
            }
          });
          return states.every((s) => s !== null) ? states : null;
        },
        360_000, // the gate's own budget is 300 s per arm (arms gate in parallel) + slop
      );
      const readyArms = gateStates.flatMap((ready, i) => (ready ? [i] : []));
      const fullField = readyArms.length === 2;
      if (readyArms.length === 0) {
        throw new Error(`substrate flake: BOTH gates failed, no entrants possible — gate evidence ${JSON.stringify(gateStates)}`);
      }
      const plantArm = readyArms[0] as number; // index-order probing: lowest READY arm wins any tie
      const winnerExpect = plantArm;
      const otherArm = 1 - plantArm;
      evidence.push({ phase: "gates", ready: gateStates, readyArms, fullField, plantArm });

      // Marker write. Bounded retries: a marker that never lands parks the
      // poller at the 1h CEILING holding the fleet lock with both boxes
      // billing — abort loudly instead.
      //
      // /run is root:root 755 on the real image and the ssh user is uid 1000
      // (MEASURED 2026-08-26: plain mkdir → "Permission denied"; sudo -n
      // works, exedev is in the sudo group) — so the write goes through
      // `sudo -n`. The written file is world-readable, which is all the
      // poller's probe (`test -f`) and exec-cat read need. This is itself a
      // FINDING: the poller's marker path is unwritable by the box's default
      // user, so until the proposed in-box executor ships (running privileged
      // or with its own marker root), only a sudo-capable writer can ever
      // decide a race on real substrate.
      const markerCmd = `sudo -n sh -c 'mkdir -p /run/journal && printf "{\\"ok\\":true}\\n" > /run/journal/final.json'`;
      await pollUntil(
        "winner marker written",
        async () => {
          const r = await ctx.driver.exec(armVms[plantArm] as string, ["sh", "-c", markerCmd]);
          return r.exitCode === 0 ? r.stdout.trim() : null;
        },
        180_000,
        5000,
      );
      evidence.push({ phase: "marker-planted", vm: armVms[plantArm], marker: "/run/journal/final.json" });

      // ── 4. the REAL poller claims: local record winner flips to 0 ────────
      // Bound is generous (10 min): the poller only starts once BOTH arms'
      // gates settle, and fresh-box gate B's first `pi --list-models` fetch
      // can burn minutes before that. While polling, capture DIAGNOSTICS every
      // ~30 s — a test-side marker probe (is the marker still there, readable
      // exactly as probeArm reads it?) and the arms' run records (vmName set ⇒
      // that arm's dispatch acked; closedAt ⇒ closed) — so a timeout names
      // WHERE the verb was. On timeout, KILL the verb and capture its stderr:
      // the poller logs race-probe-failed/race-probe-timeout per skipped tick,
      // which distinguishes "poller probing and failing" from "poller never
      // started (arms still gating)".
      let winner: number | null = null;
      {
        const t0 = Date.now();
        let tick = 0;
        for (;;) {
          const rec = JSON.parse(readFileSync(join(fanoutsDir, `${fanoutId}.json`), "utf8")) as { winner: number | null; closedAt?: string | null };
          lastRecSnap = { winner: rec.winner, closedAt: rec.closedAt ?? null, t: Math.round((Date.now() - t0) / 1000) };
          if (rec.winner !== null) {
            winner = rec.winner;
            break;
          }
          if (Date.now() - t0 > 600_000) break;
          if (tick % 15 === 0) {
            const probe = await ctx.driver.exec(armVms[0] as string, ["sh", "-c", "test -f /run/journal/final.json && cat /run/journal/final.json"]);
            const armRecs = armRunIds.map((id) => {
              try {
                const r = new RunRecordStore({ dir: join(workspace, "runs") }).get(id);
                return { vmName: r.vmName ?? null, closedAt: r.closedAt ?? null };
              } catch {
                return { absent: true };
              }
            });
            evidence.push({ phase: "winner-poll-diag", t: Math.round((Date.now() - t0) / 1000), markerProbe: probe.exitCode === 0 ? probe.stdout.trim() : `absent(exit ${probe.exitCode}, ${probe.stderr.trim().slice(0, 120)})`, arms: armRecs });
          }
          tick += 1;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      evidence.push({ phase: "record-snapshot-at-claim-or-timeout", record: lastRecSnap });
      if (winner === null) {
        verb.kill();
        const diag = await verb.output;
        evidence.push({ phase: "verb-stderr-on-timeout", tail: diag.stderr.trim().slice(-2500) });
        throw new Error(`race poller never claimed a winner in 600 s — record ${JSON.stringify(lastRecSnap)}`);
      }
      evidence.push({ phase: "winner-claimed", winner });
      expect(winner).toBe(winnerExpect);

      // Best-effort late marker on the OTHER arm — harmless; the lostRace
      // flip is unconditional for non-winner ready entrants (and a no-op on a
      // setupFailed arm the poller never probes).
      try {
        await ctx.driver.exec(armVms[otherArm] as string, ["sh", "-c", markerCmd]);
        evidence.push({ phase: "late-marker-other-arm", arm: otherArm, ok: true });
      } catch (e) {
        evidence.push({ phase: "late-marker-other-arm", arm: otherArm, ok: false, error: (e as Error).message });
      }

      // ── 5. verb exit: 0 on a full field; 1 when a gate-failed arm is collected
      const exitCode = await verb.exited;
      const { stdout, stderr } = await verb.output;
      evidence.push({ phase: "verb-exit", exitCode, fullField, stdout: stdout.trim().slice(0, 1200), stderrBytes: stderr.length });
      expect(exitCode).toBe(fullField ? 0 : 1);

      // The winner is ready; the other arm lost the race (full field) or
      // never entered it (gate flake — setupFailed is EXPECTED then).
      const lines = stdout.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as ArmLine);
      const armLines = lines.filter((l) => typeof l.arm === "number").sort((a, b) => a.arm - b.arm);
      expect(armLines.length).toBe(2);
      const byArm = new Map(armLines.map((l) => [l.arm, l]));
      expect(byArm.get(plantArm)?.outcome).toBe("ready");
      expect(byArm.get(otherArm)?.outcome).toBe(fullField ? "lostRace" : "setupFailed");
      if (fullField) {
        expect(armLines.filter((l) => ["setupFailed", "armFailed", "armUnknown"].includes(l.outcome))).toEqual([]);
      }
      evidence.push({ phase: "arm-lines", armLines });

      // Record: race contract — winner set, closedAt set, rankedAt NULL (race
      // gets no auto-rank; the rank add-on below stamps it).
      const recFinal = JSON.parse(readFileSync(join(fanoutsDir, `${fanoutId}.json`), "utf8")) as {
        pattern: string;
        winner: number | null;
        closedAt?: string;
        rankedAt?: string | null;
        arms: Array<{ arm: number; runId: string; rosterId?: string }>;
      };
      expect(recFinal.pattern).toBe("race");
      expect(recFinal.winner).toBe(winnerExpect);
      expect(recFinal.closedAt ?? "").not.toBe("");
      expect(recFinal.rankedAt ?? null).toBe(null);
      expect(recFinal.arms.map((a) => a.rosterId)).toEqual(["lead", "fixer"]);

      // ── 6. events: exactly ONE won, zero cross-process ────────────────────
      const wonEvents = (stderr.match(/"event":"won"/g) ?? []).length;
      const crossEvents = (stderr.match(/race-lost-cross-process/g) ?? []).length;
      evidence.push({ phase: "events", wonEvents, crossEvents });
      expect(wonEvents).toBe(1);
      expect(crossEvents).toBe(0);

      // ── 7. boxes: winner ALIVE; loser destroyed (full field) or gate-failed
      // arm STILL ALIVE (INV-5 LIVE — the race never touches it) ────────────
      const winnerVm = armVms[plantArm] as string;
      const otherVm = armVms[otherArm] as string;
      const store = new RunRecordStore({ dir: recordsDir });
      if (fullField) {
        await pollUntil(
          "loser destroyed",
          async () => {
            const names = (await ctx.driver.list()).map((b) => b.name);
            return names.includes(otherVm) ? null : names;
          },
          300_000,
        ).then((names) => evidence.push({ phase: "loser-destroyed", ok: true, listedCount: names.length }));
        const afterLoss = (await ctx.driver.list()).map((b) => b.name);
        expect(afterLoss).toContain(winnerVm);
        expect(afterLoss).not.toContain(otherVm);
      } else {
        const after = (await ctx.driver.list()).map((b) => b.name);
        expect(after).toContain(winnerVm);
        expect(after).toContain(otherVm); // INV-5: a gate-failed arm's box is never destroyed by the race
        evidence.push({ phase: "failed-arm-alive-inv5", vm: otherVm, listed: true });
      }

      if (fullField) {
        // ── 8. loser record closed + key revoked ────────────────────────────
        const loserId = armRunIds[otherArm] as string;
        const loserRec = store.get(loserId);
        expect(loserRec.closedAt ?? "").not.toBe("");
        expect(loserRec.spendMicroUsd ?? 0).toBeGreaterThan(0);
        expect(loserRec.spendMicroUsd ?? 1).toBeLessThanOrEqual(T3_CAP_MICRO_USD);
        expect(await listedKeyHashes()).not.toContain(loserRec.keyHash);

        // ── 9. THE DF2.8 PROOF: loser box_hours rows via the REAL lazy hook ─
        const loserRows = ledgerRows(
          recordsDir,
          "SELECT run_id, cost_micro_usd, unpriced FROM cost_events WHERE kind = 'box_hours' AND run_id = ?",
          loserId,
        );
        evidence.push({ phase: "loser-ledger", rows: loserRows });
        expect(loserRows.length).toBeGreaterThanOrEqual(1);
        expect(loserRows.every((r) => r.unpriced === 0)).toBe(true);
        expect(loserRows.every((r) => Number(r.cost_micro_usd) > 0)).toBe(true);
      } else {
        // Degraded field: the gate-failed arm's record stays OPEN with its
        // key STILL LIVE — teardown owns both, and the race must not preempt.
        const failedId = armRunIds[otherArm] as string;
        const failedRec = store.get(failedId);
        expect(failedRec.closedAt ?? "").toBe("");
        expect(failedRec.spendMicroUsd ?? 1).toBeLessThanOrEqual(T3_CAP_MICRO_USD);
        expect(failedRec.keyHash).toBeDefined();
        expect(await listedKeyHashes()).toContain(failedRec.keyHash as string);
        evidence.push({ phase: "failed-arm-record-open-inv5", runId: failedId, spendMicroUsd: failedRec.spendMicroUsd ?? null });
      }

      // Aggregate token spend ≤ 2×cap across BOTH arms' records.
      const winnerId = armRunIds[plantArm] as string;
      const winnerSpend = store.get(winnerId).spendMicroUsd ?? 0;
      const otherSpend = store.get(armRunIds[otherArm] as string).spendMicroUsd ?? 0;
      const totalSpend = winnerSpend + otherSpend;
      evidence.push({ phase: "spend", capPerArm: T3_CAP_MICRO_USD, aggregateCap: 2 * T3_CAP_MICRO_USD, winnerSpend, otherSpend, totalSpend });
      expect(totalSpend).toBeLessThanOrEqual(2 * T3_CAP_MICRO_USD);

      // ── 10. rank add-on: stamps rankedAt, winner stays 0 ─────────────────
      const rank = await runFleet(["rank", fanoutId, "--dir", fanoutsDir], { timeoutMs: 60_000 });
      evidence.push({ phase: "rank-verb", exitCode: rank.exitCode, stdout: rank.stdout.trim().slice(0, 500) });
      expect(rank.exitCode).toBe(0);
      const recRanked = JSON.parse(readFileSync(join(fanoutsDir, `${fanoutId}.json`), "utf8")) as { rankedAt?: string | null; winner: number | null };
      expect(recRanked.rankedAt ?? "").not.toBe("");
      expect(recRanked.winner).toBe(winnerExpect); // rank NEVER sets winner
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (EB3): the post-finally verdicts below must render on
      // the red path too — the failing run is the one most likely to leak.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message, record: lastRecSnap });
    } finally {
      // The primitive disposed the loser; the WINNER is ours. Kill an
      // outstanding verb first — its lock releases with the process.
      if (verb !== undefined) {
        try {
          verb.kill();
        } catch {
          /* already exited */
        }
      }
      if (armRunIds.length === 0 && workspace !== "") {
        try {
          const files = readdirSync(fanoutsDirSafe(workspace)).filter((f) => f.startsWith("fan-"));
          for (const f of files) {
            const rec = JSON.parse(readFileSync(join(fanoutsDirSafe(workspace), f), "utf8")) as { arms?: Array<{ runId: string }> };
            armRunIds.push(...(rec.arms ?? []).map((a) => a.runId));
          }
          evidence.push({ phase: "finally-id-recovery", runIds: armRunIds });
        } catch {
          /* nothing ever landed */
        }
      }
      armVms = armVms.length > 0 ? armVms : [...armRunIds];
      for (let i = 0; i < armRunIds.length; i++) {
        const id = armRunIds[i] as string;
        if (workspace !== "") {
          // `teardownQuietly`, not a bare `runFleet` (F2): arm 0's 180 s ceiling
          // REJECTED out of this `finally` at the await, skipping arm 1's
          // teardown AND the `armVms` destroy loop below — and in the degraded
          // field arm 1 is the one whose key is still LIVE by design.
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
      try {
        const maxAttempts = 5;
        const retryDelayMs = 8000;
        let final: string[] = [];
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          final = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
          if (final.length === 0) break;
          if (attempt < maxAttempts) {
            evidence.push({ phase: "final-ls-retry", attempt, remaining: final });
            await new Promise((r) => setTimeout(r, retryDelayMs));
          }
        }
        evidence.push({ phase: "final-ls", fleetBoxes: final, attempts: maxAttempts });
        finalBoxes = final; // asserted BELOW the finally — an expect here was swallowed by the catch (round-2 F1)
      } catch (e) {
        evidence.push({ phase: "final-ls-error", error: (e as Error).message });
      }
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
      writeEvidenceQuietly("T3.1", "t3-1-fanout-race", { test: "T3.1 race", outcome, fanoutId, runIds: armRunIds, capMicroUsdPerArm: T3_CAP_MICRO_USD, phases: evidence }, destroyFailures);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // ── the post-`finally` verdict (EB3), in ONE place: `settleRun` fails a
    // green run on a cleanup problem, and on a RED one ATTACHES the problem to
    // the body's own error instead of throwing over the top of it — the bare
    // `expect(destroyFailures)` this replaces discarded the held failure
    // whenever a leak and a real regression happened on the same run. ────────
    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes), ...keyProblems]);
  },
  2_700_000,
);

function fanoutsDirSafe(workspace: string): string {
  return join(workspace, "fanouts");
}
