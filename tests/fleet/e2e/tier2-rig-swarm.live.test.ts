/**
 * T2.8 — R0.7: dispatch → in-box engine → `rig_swarm` phase (2 Pi seats) →
 * settled-swarm gate → harvest → out-of-box reverify → teardown, with REAL
 * per-seat model spend (roadmap R0.7; first live round for the S1 phase).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 — liveGate("2") throws on a tier
 * mismatch or a half-configured substrate env. Normal `bun test`/CI: todo.
 *
 * SPEND PROTOCOL (operator "go" BEFORE this runs): 1 run key × 1_200_000 µ$
 * ceiling + 2 seat keys × 500_000 µ$ each ($1.00 model worst-case) + box
 * hours. S0 (the spike this round productionizes) spent $0.41 on the same
 * two seats. Evidence runs with
 * `QDS_E2E_EVIDENCE_DIR=$PWD/_bmad-output/evidence/openrig-s1` so the round's
 * JSON lands in the R0 evidence dir, not df3-e2e.
 *
 * MANIFEST: config/rosters/r0-swarm.pipeline.json (delivered from
 * QDS_EXEDEV_SHA by dispatch — commit + push it BEFORE dispatching). The
 * roster the setup gate reads is `config/rosters/roster.yaml` beside it.
 *
 * NO FAKES: real ssh exec, real systemd engine, real OpenRouter run key +
 * per-seat keys, real SQLite ledger, real `bun scripts/fleet.ts`
 * subprocesses. Verbatim failures in evidence.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { boxMarkerPath, classifyMarkerRead, DEFAULT_PER_CALL_DEADLINE_MS } from "../../../src/fleet/fanout-primitive.ts";
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "../../../src/providers/exedev/fill.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";
import { KEY_ENV_FILE } from "../../../src/providers/credentials.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { redactSecrets } from "../../../src/providers/step-log.ts";
import { pollInBoxRun } from "./in-box-status-poll.ts";
import {
  EVIDENCE_DIR,
  REPO_ROOT,
  awaitBoxAbsent,
  boxHome,
  destroyQuietly,
  emittedRunId,
  fleetCleanupProblems,
  fleetLeftovers,
  fleetPartialOutput,
  keyLeakProblems,
  ledgerRows,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  recoverDispatchIds,
  runFleet,
  runIdFor,
  scratchClone,
  settleRun,
  shellQuote,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/**
 * The admitted run ceiling: Σ(seat caps) 1_000_000 µ$ must fit UNDER it, and
 * it is also the run key's mint cap (the run key pays the setup gate's roster
 * pings and the engine's run_start/run_end solicitations, not seat work).
 */
const RUN_CAP_MICRO_USD = 1_200_000;
/** Per-seat cap, authored in the manifest's seatBudgets ($0.50 each). */
const SEAT_CAP_MICRO_USD = 500_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const BOX_HOUR_RATE_MICRO_USD = 230_000;
const MANIFEST_PATH = "config/rosters/r0-swarm.pipeline.json";
// The two seat models (S0-proven slugs) live ONLY in the manifest — the box
// walks the pushed sha's copy, so re-typing them here would be a second
// source that could silently drift. The poll bounds live in
// in-box-status-poll.ts (the measured tier2-in-box-engine vocabulary).

// The test's kill ceiling on the dispatch call must exceed BOTH the manifest's
// runBudgetMs (1_840_000 — dispatch's --timeout-ms must admit it, the first
// live round's exit-2) and the --timeout-ms the call itself carries
// (1_840_000 + 60_000 headroom), with slack for harvest and the ack round trip.
const DISPATCH_TIMEOUT_MS = 2_100_000;
// dispatch's callerBudgetMs = --timeout-ms MINUS setup elapsed (dispatch.ts
// passes what is left of the flag); the third live round failed at +0ms slack
// ("runBudgetMs 1840000 exceeds callerBudgetMs 1839991"). One minute of
// headroom covers loader startup with orders of magnitude to spare.
const BUDGET_HEADROOM_MS = 60_000;

test.todoIf(liveTodoOff())(
  "T2.8 dispatch→rig_swarm(2 Pi seats)→gate→harvest→reverify→teardown — real box, real per-seat spend, caps $1.20 run + 2×$0.50 seats",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const probe = runIdFor("t28probe"); // never provisioned; ls baseline anchor
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
      workspace = tmpWorkspace("t28");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // The ceiling must ADMIT Σ seat caps (dispatch clamps authored budgets
      // down to the ceiling; 50k-class ceilings would strangle the swarm).
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: RUN_CAP_MICRO_USD, boxHourRateMicroUsd: BOX_HOUR_RATE_MICRO_USD }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: MANIFEST_PATH,
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({
        phase: "setup",
        ok: true,
        runCapMicroUsd: RUN_CAP_MICRO_USD,
        seatCapMicroUsd: SEAT_CAP_MICRO_USD,
      });

      const before = (await ctx.driver.list()).map((b) => b.name);
      evidence.push({ phase: "ls-before", boxes: before.filter((n) => n.startsWith("e2e-")), probe });

      // ── 1. dispatch: box + fill + manifest pair + setup gate + SEAT KEYS ──
      // The `.catch` is the L1 fix (tier2-dispatch-engine): `runFleet`'s
      // ceiling REJECTS, and `dispatch` is the verb that creates a real box
      // before it can still fail — the partial streams are where the ids and
      // the box name live on that path.
      // `--timeout-ms` (dispatch's OWN flag — `--budget-ms` is not a dispatch
      // verb; the second live round died on it in the CLI usage printer) is
      // dual-role: the verb's wall clock AND the manifest loader's
      // callerBudgetMs ceiling. The loader spends some of it on setup before
      // the runBudgetMs check, so it needs HEADROOM over runBudgetMs (read
      // from the manifest itself — the single source), not equality.
      const manifestBudgetMs = (
        JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { runBudgetMs: number }
      ).runBudgetMs;
      const dispatch = await runFleet(
        [
          "dispatch",
          "--driver",
          "exedev",
          "--brief",
          briefPath,
          "--dir",
          recordsDir,
          // dual-role: dispatch wall clock AND callerBudgetMs ceiling. The loader
      // passes what is LEFT of the flag to the manifest check (dispatch.ts:
      // setup elapsed is subtracted first), so the flag must exceed
      // runBudgetMs by more than startup overhead — the third live round died
      // at +0ms slack: "runBudgetMs 1840000 exceeds callerBudgetMs 1839991".
          "--timeout-ms",
          String(manifestBudgetMs + BUDGET_HEADROOM_MS),
        ],
        { cwd: REPO_ROOT, timeoutMs: DISPATCH_TIMEOUT_MS },
      ).catch((e: unknown) => {
        const partial = fleetPartialOutput(e);
        dispatchOut = partial.stdout;
        dispatchErr = partial.stderr;
        evidence.push({ phase: "dispatch-verb-timeout", error: (e as Error).message, recoveredBytes: partial.stdout.length + partial.stderr.length });
        throw e;
      });
      dispatchOut = dispatch.stdout;
      dispatchErr = dispatch.stderr;
      evidence.push({
        phase: "dispatch-verb",
        exitCode: dispatch.exitCode,
        stdoutTail: redactSecrets(dispatch.stdout.trim().slice(-400)),
        stderrTail: redactSecrets(dispatch.stderr.trim().slice(-2400)),
      });
      // Ownership armed BEFORE the assertion that can throw.
      const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(dispatch.exitCode).toBe(0);
      const ackLine = dispatch.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
      expect(ackLine).toBeDefined();
      const ack = JSON.parse(ackLine as string) as { runId: string; vmName: string; state: string };
      expect(ack.runId).toBe(runId); // the two id reads must AGREE (E1-8)
      runId = ack.runId;
      vmName = ack.vmName;
      expect(ack.state).toBe("ready");
      evidence.push({ phase: "ack", runId, vmName });

      const live = (await ctx.driver.list()).map((b) => b.name);
      expect(live).toContain(vmName);
      evidence.push({ phase: "box-live", ok: true, vmName });

      const store = new RunRecordStore({ dir: recordsDir });
      const rec = store.get(runId);
      expect(rec.vmName).toBe(vmName);
      expect(rec.commitSha).toBe(ctx.sha);
      // Seat mode: NO core keyHash (shape-D — keyHash and swarmSeats never
      // coexist on one record); the per-seat hashes ride the extension, one
      // per seat, in delivery order. Round 7 died on the stale single-key
      // assertion here.
      expect(rec.keyHash ?? "").toBe("");
      const seatKeyHashes = (rec.extensions?.swarmSeats?.keyHashes as string[] | undefined) ?? [];
      expect(seatKeyHashes).toHaveLength(2);
      for (const h of seatKeyHashes) expect(h).not.toBe("");
      expect(rec.extensions?.swarmSeats?.seats).toEqual(["lead", "worker"]);
      // NO core limitMicroUsd either (run-record.ts: a swarm run carries no
      // core key fields) — the ceiling is proven by the witness assertion
      // below, per-seat caps by the mint.
      expect(rec.limitMicroUsd).toBeUndefined();
      evidence.push({
        phase: "record",
        ok: true,
        seatKeyHashes: seatKeyHashes.length,
        swarmSeats: rec.extensions?.swarmSeats?.seats,
      });

      const gatePath = join(REPO_ROOT, ".sandbox", "setup-gate", `${runId}.json`);
      expect(existsSync(gatePath)).toBeTrue();
      const gate = JSON.parse(readFileSync(gatePath, "utf8")) as {
        ready: boolean;
        assertions?: Array<{ item: string; ok: boolean; note: string }>;
      };
      evidence.push({ phase: "gate-evidence", gate });
      expect(gate.ready).toBe(true);
      const items = gate.assertions ?? [];
      expect(items.map((a) => a.item)).toEqual(["A", "B", "C", "D", "E"]);
      expect(items.every((a) => a.ok)).toBe(true); // C + D = roster models answered on real money

      // ── 2. seat-keys delivery is ON the box (deliverSeatKeys ran) ─────────
      const home = await boxHome(ctx.driver, vmName);
      const envFileBox = `${home}/${KEY_ENV_FILE}`; // live-mirror: <KEY_ENV_FILE> = unit EnvironmentFile (credentials.ts)
      const keysFileBox = `/opt/qds/swarm-keys/${runId}.json`; // live-mirror: <SWARM_KEYS_DIR>/<runId>.json (credentials.ts)
      const delivery = await ctx.driver.exec(vmName, [
        "sh",
        "-c",
        `cat ${shellQuote(keysFileBox)} >/dev/null && stat -c '%a' ${shellQuote(keysFileBox)} && grep -c '^QDS_SWARM_KEYS_FILE=' ${shellQuote(envFileBox)}`,
      ]);
      evidence.push({ phase: "seat-keys-delivery", exitCode: delivery.exitCode, stdout: delivery.stdout.trim(), stderrTail: redactSecrets(delivery.stderr.trim().slice(-200)) });
      expect(delivery.exitCode).toBe(0);
      expect(delivery.stdout.trim().split("\n")[0]).toBe("600"); // keys file mode
      expect(delivery.stdout.trim().split("\n")[1]).toBe("1"); // env pointer, exactly one
      // Env-append IDEMPOTENCY (R0.7's second in-round verify): re-run the
      // deliverSeatKeys append script by hand and the pointer count must not
      // move. Free (no model spend), on the real box.
      const reappend = await ctx.driver.exec(vmName, [
        "sh",
        "-c",
        `grep -q '^QDS_SWARM_KEYS_FILE=' ${shellQuote(envFileBox)} 2>/dev/null || printf '%s\\n' 'QDS_SWARM_KEYS_FILE=${keysFileBox}' >> ${shellQuote(envFileBox)}; grep -c '^QDS_SWARM_KEYS_FILE=' ${shellQuote(envFileBox)}`,
      ]);
      expect(reappend.exitCode).toBe(0);
      expect(reappend.stdout.trim()).toBe("1");
      evidence.push({ phase: "env-append-idempotent", ok: true });

      const qdsDir = `${home}/${DEFAULT_FILL_WORKDIR}/${QDS_IN_BOX_DIR}`;
      const witnessBoxPath = `${qdsDir}/run-context.json`; // live-mirror: qdsDir = $HOME/<DEFAULT_FILL_WORKDIR>/<QDS_IN_BOX_DIR> (fill.ts imports)
      const journalBoxPath = `${home}/${runId}.journal.jsonl`; // live-mirror: $HOME/<runId>.journal.jsonl (pipeline-run.ts)
      const engineLogBoxPath = `${home}/${runId}.engine.log`;
      const markerBoxPath = boxMarkerPath(runId);
      const witnessText = await ctx.driver.exec(vmName, ["sh", "-c", `cat ${shellQuote(witnessBoxPath)}`]);
      expect(witnessText.exitCode).toBe(0);
      const witness = JSON.parse(witnessText.stdout) as { budgetMs: number; effectiveCeilingMicros: number };
      expect(witness.effectiveCeilingMicros).toBe(RUN_CAP_MICRO_USD);
      expect(Number.isSafeInteger(witness.budgetMs) && witness.budgetMs > 0).toBeTrue();
      evidence.push({ phase: "witness", budgetMs: witness.budgetMs, effectiveCeilingMicros: witness.effectiveCeilingMicros });

      // ── 3. fleet run: start the in-box engine and RETURN (AC1) ────────────
      const start = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: 180_000,
      });
      evidence.push({ phase: "run-verb", exitCode: start.exitCode, stdout: redactSecrets(start.stdout.trim().slice(0, 300)), stderrTail: redactSecrets(start.stderr.trim().slice(-2400)) });
      expect(start.exitCode).toBe(0);
      expect(start.stdout).toContain(`started: ${runId}`);

      // ── 4. poll status to a settled verdict (the shared AC5 poll) ─────────
      // 30 attempts ≈ 15 min of ceiling over the swarm phase's own 600 s
      // queue deadline — the poll outlives the phase, never the reverse.
      const poll = await pollInBoxRun(ctx.driver, vmName, {
        recordsDir,
        runId,
        engineLogBoxPath,
        evidence,
        attempts: 30,
        waitMs: 20_000,
      });
      evidence.push({ phase: "status-poll", seenStates: poll.seenStates, terminal: poll.terminal, statusExitFailures: poll.statusExitFailures });
      if (poll.terminal !== "ok") {
        // Fetch the journal NOW: the finally destroys the box, and the journal
        // is the ONLY artifact that names the failed phase's error (rounds
        // 12–13 each burned a probe round re-deriving it post-destroy).
        // Guarded: a dead box must not replace the run's own failure with a
        // read failure.
        let journalTail = "";
        try {
          journalTail = (
            await ctx.driver.execTimed(vmName, ["sh", "-c", `tail -c 4000 ${shellQuote(journalBoxPath)} 2>&1`], 30_000)
          ).stdout;
        } catch (e) {
          journalTail = `(journal read failed: ${e instanceof Error ? e.message : String(e)})`;
        }
        evidence.push({ phase: "failed-run-journal", runId, vmName, journalTail: redactSecrets(journalTail).slice(-4000) });
        throw new Error(
          `in-box run did not settle to \`ok\` (states seen: ${poll.seenStates.join(" → ") || "none"}). \`not-ok\` means the engine settled and the run FAILED — the failed-run-journal evidence phase names the phase.`,
        );
      }

      // ── 5. the journal proves the SWARM settled lead-closed ───────────────
      const markerRead = classifyMarkerRead(
        await readBoxFile(ctx.driver, vmName, markerBoxPath, DEFAULT_PER_CALL_DEADLINE_MS),
        runId,
      );
      expect(markerRead.kind).toBe("settled");
      // The settled/seat-cost TRACE rows are read from the ENGINE LOG, not the
      // journal: the engine's final journal doc (version/resident/phases)
      // REPLACES the pre-settle JSONL stream at settle, wiping trace rows —
      // round 18 read a fully-settled-ok journal and found zero swarm rows.
      // stderr survives as <runId>.engine.log, and the phase mirrors both rows
      // there. The journal itself stays as evidence (the phase doc names
      // status/error per phase).
      const engineLogText = await ctx.driver.exec(vmName, ["sh", "-c", `cat ${shellQuote(engineLogBoxPath)} 2>&1`]);
      expect(engineLogText.exitCode).toBe(0);
      const journalText = await ctx.driver.exec(vmName, ["sh", "-c", `cat ${shellQuote(journalBoxPath)}`]);
      expect(journalText.exitCode).toBe(0);
      evidence.push({ phase: "journal-doc", journalHead: redactSecrets(journalText.stdout.trim().slice(0, 1200)) });
      const settledRows = engineLogText.stdout
        .split("\n")
        .filter((l) => l.includes('"swarm_settled"'))
        .map((l) => {
          try {
            return JSON.parse(l) as { name?: string; payloadJson?: string };
          } catch {
            return undefined;
          }
        })
        .filter((r): r is { name: string; payloadJson: string } => r?.name === "swarm_settled");
      evidence.push({ phase: "swarm-settled-rows", count: settledRows.length, payloads: settledRows.map((r) => r.payloadJson) });
      expect(settledRows.length).toBeGreaterThanOrEqual(1);
      const settledPayload = JSON.parse(settledRows.at(-1)!.payloadJson) as { reason: string; qid: string; timeoutFallback: boolean };
      // Fail-closed: only a lead-closed queue item is success. A
      // timeout-fallback or failed closure would have made the phase fail and
      // the run settle not-ok — reaching here with anything but lead-closed
      // means the marker lied, which is exactly what this round exists to catch.
      expect(settledPayload.reason).toBe("lead-closed");
      expect(settledPayload.timeoutFallback).toBe(false);
      const seatCostRows = engineLogText.stdout
        .split("\n")
        .filter((l) => l.includes('"swarm_seat_cost"'))
        .map((l) => {
          try {
            return JSON.parse(l) as { payloadJson?: string };
          } catch {
            return undefined;
          }
        })
        .filter((r): r is { payloadJson: string } => r?.payloadJson !== undefined)
        .map((r) => JSON.parse(r.payloadJson) as { session: string; role: string; totalMicroUsd: number });
      evidence.push({ phase: "swarm-seat-cost-traces", rows: seatCostRows });
      expect(seatCostRows.map((r) => r.role).sort()).toEqual(["lead", "worker"]);

      // ── 6. harvest: bundle → tip → OUT-OF-BOX reverify on the harvested tip ──
      const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, workspace);
      const harvest = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 300_000,
      });
      evidence.push({ phase: "harvest-verb", exitCode: harvest.exitCode, stdout: harvest.stdout.trim().slice(0, 300), stderrTail: redactSecrets(harvest.stderr.trim().slice(-400)) });
      expect(harvest.exitCode).toBe(0);
      const bundle = join(recordsDir, `${runId}.bundle`);
      expect(existsSync(bundle)).toBeTrue();
      const v = Bun.spawnSync({ cmd: ["git", "bundle", "verify", bundle], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      expect(v.exitCode).toBe(0);
      const tip = Bun.spawnSync({ cmd: ["git", "rev-parse", "--verify", `refs/sandbox/${runId}`], cwd: hostRepo, stdout: "pipe", stderr: "pipe" });
      expect(tip.exitCode).toBe(0);
      // Out-of-box reverify: the gate's OWN testCommand, run on the HOST in a
      // clean worktree of the harvested tip — never trusting the box's word.
      const worktree = join(workspace, "reverify");
      const wt = Bun.spawnSync({
        cmd: ["git", "worktree", "add", worktree, `refs/sandbox/${runId}`],
        cwd: hostRepo,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(wt.exitCode).toBe(0);
      const reverify = Bun.spawnSync({
        cmd: ["python3", "r0_swarm_e2e_marker_test.py"],
        cwd: worktree,
        stdout: "pipe",
        stderr: "pipe",
      });
      evidence.push({
        phase: "out-of-box-reverify",
        tip: tip.stdout.toString().trim(),
        exitCode: reverify.exitCode,
        stdout: reverify.stdout.toString().slice(0, 200),
        stderr: reverify.stderr.toString().slice(0, 200),
      });
      expect(reverify.exitCode).toBe(0);
      expect(reverify.stdout.toString()).toContain("marker-test-passed");

      // ── 7. teardown: full chain, spend captured, keys revoked, box gone ───
      const teardown = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: hostRepo,
        timeoutMs: 300_000,
      });
      evidence.push({ phase: "teardown-verb", exitCode: teardown.exitCode, stdout: teardown.stdout.trim().slice(0, 300), stderrTail: redactSecrets(teardown.stderr.trim().slice(-400)) });
      expect(teardown.exitCode).toBe(0);

      const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0);
      expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(RUN_CAP_MICRO_USD);
      evidence.push({ phase: "spend", runCapMicroUsd: RUN_CAP_MICRO_USD, actualMicroUsd: closed.spendMicroUsd });

      // Per-seat cost_attribution: role-split token rows in the ledger (the
      // DF2.12 bridge, driven off the engine log's cost_attribution lines the
      // phase's emitSeatCosts emitted). Exactly the T2.7 shape.
      const tokenRows = ledgerRows<{ agent_id: string; role: string; cost_micro_usd: number; unpriced: number }>(
        recordsDir,
        "SELECT agent_id, role, cost_micro_usd, unpriced FROM cost_events WHERE run_id = ? AND kind = 'tokens' ORDER BY role, agent_id",
        runId,
      );
      evidence.push({ phase: "ledger", tokenRows, spendMicroUsd: closed.spendMicroUsd });
      expect(tokenRows.filter((r) => r.role === "lead").length).toBeGreaterThanOrEqual(1);
      expect(tokenRows.filter((r) => r.role === "worker").length).toBeGreaterThanOrEqual(1);
      expect(tokenRows.every((r) => r.unpriced === 0)).toBeTrue();
      const seatSpend = tokenRows.reduce((sum, r) => sum + r.cost_micro_usd, 0);
      expect(seatSpend).toBeLessThanOrEqual(2 * SEAT_CAP_MICRO_USD);

      // Seat mode: no core keyHash to revoke — assert each recorded seat hash
      // is gone from the provider list (teardown's compensate-mint arm).
      for (const h of ((closed.extensions?.swarmSeats?.keyHashes as string[] | undefined) ?? [])) {
        expect(await listedKeyHashes()).not.toContain(h);
      }
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
      let recordStore: RunRecordStore | undefined;
      try {
        if (workspace !== "") recordStore = new RunRecordStore({ dir: join(workspace, "runs") });
      } catch (e) {
        evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
      }
      // Account-wide baseline: the seat keys are record-named (teardown's
      // compensate-mint arm revokes them), so the delta-vs-baseline check
      // catches any survivor the record lost — the same fail-closed shape
      // tier2-df212-attribution runs with its multi-key record.
      keyProblems = await keyLeakProblems(
        hashesBefore,
        { driver: ctx.driver, store: recordStore, runIds: [runId] },
        evidence,
      );
      writeEvidenceQuietly("T2.8", "t2-8-rig-swarm", { test: "T2.8", outcome, runId, runCapMicroUsd: RUN_CAP_MICRO_USD, seatCapMicroUsd: SEAT_CAP_MICRO_USD, evidenceDir: EVIDENCE_DIR, phases: evidence }, destroyFailures);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // Budget audit, priced at DECLARED CEILINGS (tier2-dispatch-engine shape).
  // A bun test-timeout abort is the ONE path where the finally does not run,
  // so this number is what a fully degraded round may consume before the one
  // abort that skips cleanup — fail-safe direction is UP.
  //
  //   ls-before          1 control ls at 120                             120 s
  //   dispatch verb      runFleet timeoutMs DISPATCH_TIMEOUT_MS 2_100_000
  //                      (fill + gate C/D + deliverSeatKeys; raised above the
  //                      manifest's runBudgetMs + headroom, rounds 1–3) 2 100 s
  //   box-live ls        1 control ls at 120                             120 s
  //   delivery + witness probes  3 × driver.exec at 120                  360 s
  //   run verb           runFleet timeoutMs 180_000                      180 s
  //   status polls       30 × (verb 120 + wait 20)                     4 200 s
  //                      (the swarm phase's own deadline is 600 s; 30 polls
  //                       cover it ~2.3× at ceiling)
  //   dead-unit probes   ≤ 30 × (30 probe + 30 marker/log)               900 s
  //   journal + marker reads  2 × driver.exec at 120                    240 s
  //   scratchClone       one real clone, allowance                       180 s
  //   harvest verb       runFleet timeoutMs 300_000                      300 s
  //   out-of-box reverify local (worktree + python3)                      60 s
  //   teardown verb      runFleet timeoutMs 300_000                      300 s
  //   box-absence poll   awaitBoxAbsent 4 × (ls 120 + 10 wait)           510 s
  //   post-teardown      listedKeyHashes, allowance                      240 s
  //   ledger + records   local SQLite/JSON reads                          10 s
  //                                                              body ────────
  //                                                                   10 120 s
  //   teardownQuietly    timeoutMs 180_000                               180 s
  //   destroyQuietly     1 control rm at 120                             120 s
  //   fleetLeftovers     5 × (ls 120 + 8 wait) + destroy + re-list       880 s
  //   keyLeakProblems    delta list + fallback revoke + recheck          360 s
  //   evidence + rmSync  local                                            10 s
  //                                                           finally ────────
  //                                                                    1 550 s
  //                                                                   ────────
  //                                                                   11 670 s
  //
  // Hence 11_700 s. Every inner ceiling FIRING is safe — it rejects into the
  // catch and the finally still runs. WHOEVER RAISES AN INNER CEILING OR ADDS
  // A CLEANUP STEP MUST RE-ADD IT HERE.
  11_700_000,
);
