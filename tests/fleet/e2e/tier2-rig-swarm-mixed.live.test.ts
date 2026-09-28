/**
 * T2.9 — S2.6: dispatch → in-box engine → `rig_swarm` phase (1 Pi lead + 1
 * claude worker) → settled-swarm gate → harvest → out-of-box reverify →
 * teardown, with REAL per-seat per-runtime spend: the pi lead prices from its
 * session JSONL, the claude worker prices via the OpenRouter key API (the
 * S2.6 cost-row proof).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 — liveGate("2") throws on a tier
 * mismatch or a half-configured substrate env. Normal `bun test`/CI: todo.
 *
 * SPEND PROTOCOL (operator "go" BEFORE this runs): 1 run key × 1_200_000 µ$
 * ceiling + 2 seat keys × 500_000 µ$ each ($1.00 model worst-case) + box
 * hours. Evidence runs with
 * `QDS_E2E_EVIDENCE_DIR=$PWD/_bmad-output/evidence/openrig-s2`.
 *
 * MANIFEST: config/rosters/s2-mixed.pipeline.json (delivered from
 * QDS_EXEDEV_SHA by dispatch — commit + push it BEFORE dispatching). The
 * roster the setup gate reads is `config/rosters/roster.yaml` beside it.
 *
 * IMAGE: buildId c56de37e27f03812 — the FIRST image carrying the member-env
 * patch (S2.2 key delivery for non-pi seats) and the pinned claude CLI. A
 * round green on an older image proves nothing about S2.
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
const MANIFEST_PATH = "config/rosters/s2-mixed.pipeline.json";

const DISPATCH_TIMEOUT_MS = 2_100_000;
const BUDGET_HEADROOM_MS = 60_000;

test.todoIf(liveTodoOff())(
  "T2.9 dispatch→rig_swarm(pi lead + claude worker)→gate→harvest→reverify→teardown — real box, per-runtime cost rows, caps $1.20 run + 2×$0.50 seats",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const probe = runIdFor("t29probe"); // never provisioned; ls baseline anchor
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
      workspace = tmpWorkspace("t29");
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
          // dual-role: dispatch wall clock AND callerBudgetMs ceiling (T2.8's
          // third-round death: runBudgetMs must fit UNDER it with headroom).
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
      const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(dispatch.exitCode).toBe(0);
      const ackLine = dispatch.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
      expect(ackLine).toBeDefined();
      const ack = JSON.parse(ackLine as string) as { runId: string; vmName: string; state: string };
      expect(ack.runId).toBe(runId);
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
      // Seat mode shape-D: no core keyHash; one per-seat hash each.
      expect(rec.keyHash ?? "").toBe("");
      const seatKeyHashes = (rec.extensions?.swarmSeats?.keyHashes as string[] | undefined) ?? [];
      expect(seatKeyHashes).toHaveLength(2);
      for (const h of seatKeyHashes) expect(h).not.toBe("");
      expect(rec.extensions?.swarmSeats?.seats).toEqual(["lead", "worker"]);
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
      expect(items.every((a) => a.ok)).toBe(true);

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
      const deliveryLines = delivery.stdout.trim().split("\n");
      expect(deliveryLines[0]).toBe("600"); // keys file mode
      expect(deliveryLines[1]).toBe("1"); // env pointer, exactly one

      const qdsDir = `${home}/${DEFAULT_FILL_WORKDIR}/${QDS_IN_BOX_DIR}`;
      const witnessBoxPath = `${qdsDir}/run-context.json`; // live-mirror: qdsDir = $HOME/<DEFAULT_FILL_WORKDIR>/<QDS_IN_BOX_DIR> (fill.ts imports)
      const journalBoxPath = `${home}/${runId}.journal.jsonl`; // live-mirror: $HOME/<runId>.journal.jsonl (pipeline-run.ts)
      const engineLogBoxPath = `${home}/${runId}.engine.log`;
      const markerBoxPath = boxMarkerPath(runId);
      // NOTE (attempt-1 lesson): $OPENRIG_HOME/member-env.json is written by
      // the PHASE BODY (inside fleet run), not by dispatch — a read here is
      // always ENOENT and attempt 1 burned a probe round proving it. The
      // member-env patch is instead proven operationally below: the claude
      // seat's swarm_seat_up trace (runtime=claude) + its priced
      // openrouter-key-api cost row — no env delivery ⇒ no auth ⇒ no spend ⇒
      // no settled run, so reaching those assertions IS the delivery proof.

      const witnessText = await ctx.driver.exec(vmName, ["sh", "-c", `cat ${shellQuote(witnessBoxPath)}`]);
      expect(witnessText.exitCode).toBe(0);
      const witness = JSON.parse(witnessText.stdout) as { budgetMs: number; effectiveCeilingMicros: number };
      expect(witness.effectiveCeilingMicros).toBe(RUN_CAP_MICRO_USD);
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
      expect(settledPayload.reason).toBe("lead-closed");
      expect(settledPayload.timeoutFallback).toBe(false);
      // S2.6 core assertion: BOTH runtimes price a swarm_seat_cost row, and
      // the claude worker's row NAMES its source — the OpenRouter key API —
      // proving the per-runtime cost path, not just per-seat parity.
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
        .map((r) => JSON.parse(r.payloadJson) as { session: string; role: string; totalMicroUsd: number; runtime?: string; source?: string });
      evidence.push({ phase: "swarm-seat-cost-traces", rows: seatCostRows });
      expect(seatCostRows.map((r) => r.role).sort()).toEqual(["lead", "worker"]);
      const workerCostRow = seatCostRows.find((r) => r.role === "worker");
      expect(workerCostRow?.source).toBe("openrouter-key-api");
      expect(workerCostRow?.runtime).toBe("claude-code");
      // (The swarm_seat_up TRACE rows do not survive to the engine log —
      // the settle wipe removes the pre-settle trace stream, the round-18
      // class; only swarm_settled and swarm_seat_cost mirror there. The
      // worker cost row's runtime field IS the seeding proof — attempt 6
      // burned on asserting the wrong surface.)

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
      const worktree = join(workspace, "reverify");
      const wt = Bun.spawnSync({
        cmd: ["git", "worktree", "add", worktree, `refs/sandbox/${runId}`],
        cwd: hostRepo,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(wt.exitCode).toBe(0);
      const reverify = Bun.spawnSync({
        cmd: ["python3", "s2_mixed_marker_test.py"],
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
      expect(reverify.stdout.toString()).toContain("s2-marker-test-passed");

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

      // Per-runtime cost_attribution in the LEDGER (the DF2.12 bridge): the
      // pi lead's rows come from parseSeatSessionJsonl; the claude worker's
      // row comes from the key-API cost row the phase emitted. Both priced
      // (unpriced = 0) is the stage DoD's "per-seat per-runtime cost rows".
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
      keyProblems = await keyLeakProblems(
        hashesBefore,
        { driver: ctx.driver, store: recordStore, runIds: [runId] },
        evidence,
      );
      writeEvidenceQuietly("T2.9", "t2-9-rig-swarm-mixed", { test: "T2.9", outcome, runId, runCapMicroUsd: RUN_CAP_MICRO_USD, seatCapMicroUsd: SEAT_CAP_MICRO_USD, evidenceDir: EVIDENCE_DIR, phases: evidence }, destroyFailures);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems]);
  },
  // Same ceiling arithmetic as T2.8's audit (identical structure; the only
  // additions are the member-env read — one driver.exec at 120 s — and the
  // same-armed teardown), rounded up: WHOEVER RAISES AN INNER CEILING OR ADDS
  // A CLEANUP STEP MUST RE-ADD IT HERE.
  11_700_000,
);
