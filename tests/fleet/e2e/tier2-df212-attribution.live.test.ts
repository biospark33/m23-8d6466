/**
 * T2.7 — DF2.12 AC1 arm (b): the END-TO-END token attribution proof, live.
 *
 * The story's own E2E Slice shape, on the real substrate: a dispatched run
 * whose manifest carries a `dispatch_task` phase (lead + TWO workers), the
 * DF3.3 resident armed by the delivered run-context, walked IN-BOX by
 * `qds-engine` under `qds-run@<runId>.service`, then torn down through
 * `scripts/sandbox-teardown.ts` — the CLI surface the story names — and read
 * back out of the cost ledger.
 *
 * WHAT THIS PROVES (nothing else in the live tree does):
 *  - `dispatchTask`'s cost arm and steering's meter site emit exactly one
 *    `cost_attribution` line per cost event, tee'd by `moneyLineTee()` onto
 *    the durable engine log (INV-COST-10's real shape — the F1 fix this file
 *    is the live proof of);
 *  - the harvested log drives `CostLedger.ingestCostEvent` once per line at
 *    teardown's close step (the DF2.12 host bridge), landing role-split
 *    `kind='tokens'` rows — lead, BOTH workers, resident;
 *  - `qds cost` renders the run's TOKENS cell `✓` beside a multi-role split;
 *  - the priced token SUM matches the record's provider-authoritative spend
 *    at `SPEND_DIVERGENCE_TOLERANCE_MICRO_USD` — the round-6 hardened
 *    assertion shape, live;
 *  - a teardown re-run to completion adds ZERO rows (AC2 idempotency, live).
 *
 * FIRST-LIVE STATUS: `dispatch_task` has never been exercised in-box by any
 * prior live round — tier2-in-box-engine's manifest is `code`-only by charter
 * and says so. This file is that half's first live proof. An engine-side
 * failure here is a FINDING, not a flake: triage per the qds-live-e2e
 * protocol before re-running.
 *
 * WHY THE IMAGE MATTERS: the in-box engine is the IMAGE-baked
 * `/usr/local/bin/qds-engine`, not the delivered clone — so this round only
 * means something on the current pin (`DEFAULT_IMAGE_REF` at HEAD), which is
 * post-DF2.12 by construction (the publish ran after the merge). `preflight`
 * stamps the image pair into the evidence.
 *
 * SPEND (operator-approved 2026-09-12, ~$0.65 worst case): 1 run key ×
 * 50,000 µ$ cap (team + resident + the setup gate's C/D pings all land on it,
 * twice-capped by budget admission) + 1 box ≤ the budget audit at the foot of
 * this file. Healthy round: minutes.
 *
 * NO FAKES anywhere in this file. Model output is nondeterministic in CONTENT
 * but the assertions below are structural (rows, roles, sums), never textual.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
// The divergence tolerance the close step itself reports against — the priced
// token-SUM cross-check below compares at the SAME threshold, one source of
// truth.
import { SPEND_DIVERGENCE_TOLERANCE_MICRO_USD } from "../../../src/providers/teardown.ts";
import {
  REPO_ROOT,
  awaitBoxAbsent,
  boxHome,
  destroyQuietly,
  emittedRunId,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  lastJsonLine,
  ledgerRows,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  preflight,
  recoverDispatchIds,
  runFleet,
  runIdFor,
  settleRun,
  shellQuote,
  teardownQuietly,
  tmpWorkspace,
  writeEvidenceQuietly,
} from "./live-harness.ts";

/** Plan default (e2e-plan.md §TIER-2): 50,000 µ$ = $0.05 worst-case per key. */
const T2_CAP_MICRO_USD = 50_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const T2_BOX_HOUR_RATE_MICRO_USD = 230_000;

/**
 * The manifest `fleet dispatch` delivers and the in-box engine walks: ONE
 * `dispatch_task` phase (lead + two workers, per the roster it names) plus a
 * free closing `code` phase. Budget arithmetic (manifest.ts
 * `requiredBudgetMs`): (retries+1)×(PARSE_FIX_ATTEMPTS+1)×maxDurationMs per
 * phase + phases×ROUTING_MARGIN_MS = 1×3×300 000 + 1×3×1 000 + 2×5 000 =
 * 913 000, so `runBudgetMs` is 930 000 — required + 17 s, sized the T4 way,
 * not padded.
 */
const T2_MANIFEST_PATH = "config/rosters/df212-team.pipeline.json";

/** The dispatch verb's ceiling: tier2-in-box-engine's measured figure for the SAME verb. */
const T2_DISPATCH_TIMEOUT_MS = 900_000;
/** `fleet run` returns at the FORK (startRun issues one `systemctl start`); 180 s covers the verb. */
const T2_RUN_TIMEOUT_MS = 180_000;

/**
 * How long the engine may take to settle, as status polls. Sized to the
 * manifest, not guessed: the team phase's own 300 s attempt timer + the
 * dual-gate it opens with + TWO resident solicitations (run_start, run_end)
 * + the engine's start-up — the manifest's 930 s budget bounds the walking
 * time, and 40 × 20 s of polling + verb time reaches past it. A poll that
 * never gives up is a paid box that never gets torn down.
 */
const STATUS_POLL_ATTEMPTS = 40;
const STATUS_POLL_WAIT_MS = 20_000;
const STATUS_VERB_TIMEOUT_MS = 60_000;
/** Tolerated non-zero `fleet status` exits before the poll breaks (L14, one cold-ssh tick class). */
const STATUS_EXIT_TOLERANCE = 2;

/** The sandbox-teardown CLI's ceiling: artifacts pull + harvest + close on a team run. */
const TEARDOWN_TIMEOUT_MS = 300_000;

/** The issue the run's budget attribution names — the T2/T3 precedent. */
const REPO_SLUG = "Quantum-Digital-Solutions/QDS-Factory";
const ISSUE_ID = 46;

interface AttributionLine {
  type: string;
  requestId?: string;
  runId?: string;
  agentId?: string;
  role?: string;
  invocationSeq?: number;
  model?: string;
  costMicroUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  timestamp?: string;
}

/**
 * The terminal-verdict poll, sized for THIS file: `fleet status` until the
 * marker-backed vocabulary reports a settled state. Settled = "ok" | "not-ok"
 * — the AC5 InBoxState vocabulary (`src/fleet/status.ts`); "running" is a
 * transient the loop keeps polling past, unlike `statusStateSettled`, which
 * returns on the FIRST parseable state and cannot drive a wait-to-terminal.
 * // live-mirror: "ok"/"not-ok" = InBoxState terminal values (src/fleet/status.ts)
 */
async function pollTerminalState(
  runId: string,
  recordsDir: string,
  evidence: Record<string, unknown>[],
): Promise<string> {
  const SETTLED_STATES: ReadonlySet<string> = new Set(["ok", "not-ok"]);
  const seenStates: string[] = [];
  let exitFailures = 0;
  let lastState = "";
  for (let attempt = 1; attempt <= STATUS_POLL_ATTEMPTS; attempt += 1) {
    let res: Awaited<ReturnType<typeof runFleet>>;
    try {
      res = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: STATUS_VERB_TIMEOUT_MS,
      });
    } catch (e) {
      exitFailures += 1;
      seenStates.push(`(threw: ${e instanceof Error ? e.message : String(e)})`);
      if (exitFailures > STATUS_EXIT_TOLERANCE) break;
      if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
      continue;
    }
    if (res.exitCode !== 0) {
      exitFailures += 1;
      seenStates.push(`(status exit ${String(res.exitCode)})`);
      if (exitFailures > STATUS_EXIT_TOLERANCE) break;
      if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
      continue;
    }
    let row: { runId?: string; state?: string };
    try {
      row = lastJsonLine<{ runId?: string; state?: string }>(res.stdout);
    } catch {
      seenStates.push("(unparseable)");
      if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
      continue;
    }
    expect(row.runId).toBe(runId);
    const state = row.state ?? "";
    seenStates.push(state);
    lastState = state;
    if (SETTLED_STATES.has(state)) break;
    if (attempt < STATUS_POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, STATUS_POLL_WAIT_MS));
  }
  evidence.push({ phase: "status-poll", seenStates, exitFailures });
  return lastState;
}

/** One `bun scripts/sandbox-teardown.ts` invocation, the story's named CLI surface. */
async function runSandboxTeardown(
  runId: string,
  recordsDir: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ["bun", "scripts/sandbox-teardown.ts", runId, "--driver", "exedev", "--dir", recordsDir],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

/** The qds cost report for the run's issue, as plain text (a read-only CLI). */
function runQdsCost(recordsDir: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(
    ["bun", "scripts/qds-cost.ts", `${REPO_SLUG}#${ISSUE_ID}`, "--dir", recordsDir],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Parse the cost_attribution family off an engine log's text. */
function parseAttributionLines(text: string): { lines: AttributionLine[]; refused: number } {
  const lines: AttributionLine[] = [];
  let refused = 0;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: AttributionLine;
    try {
      parsed = JSON.parse(trimmed) as AttributionLine;
    } catch {
      continue; // engine-log noise (stack traces) — the bridge ignores it too
    }
    if (parsed.type === "cost_attribution") lines.push(parsed);
    else if (parsed.type === "cost_attribution_refused") refused += 1;
  }
  return { lines, refused };
}

test.todoIf(liveTodoOff())(
  "T2.7 DF2.12 end-to-end: dispatch_task team (lead + 2 workers) + armed resident in-box → sandbox-teardown → role-split token rows, priced-SUM cross-check, qds cost ✓, idempotent re-teardown",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    const probe = runIdFor("t27probe"); // never provisioned; ls baseline anchor
    let workspace = "";
    let runId = "";
    let vmName = "";
    let dispatchOut = "";
    let dispatchErr = "";
    let outcome = "pass";
    /** The body's own error, HELD so the post-finally verdicts render on the red path too (EB3). */
    let failure: unknown;
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const destroyFailures: string[] = [];
    let finalBoxes: string[] | undefined;
    const hashesBefore = await listedKeyHashes();
    let keyProblems: string[] = [];
    /** Token-row count captured between the two teardowns — the idempotency baseline. */
    let tokenRowsBeforeReTeardown = -1;
    try {
      workspace = tmpWorkspace("t27");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // R4: the operator's cost config sits BESIDE the records dir
      // (costLedgerOpts → dirname(recordsDir)/cost-config.json). Without it,
      // admission falls back to defaultCapMicroUsd 5,000,000 µ$ ($5!) and the
      // mint would be capped five dollars high, not fifty cents of a cent.
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({ defaultCapMicroUsd: T2_CAP_MICRO_USD, boxHourRateMicroUsd: T2_BOX_HOUR_RATE_MICRO_USD }),
      );
      // R3: the frozen brief shape. repoSlug canonically matches repoUrl's
      // path; commitSha = the pinned pushed sha; manifestPath repo-relative,
      // resolved against the dispatch subprocess cwd (= REPO_ROOT).
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: REPO_SLUG,
          issueId: ISSUE_ID,
          commitSha: ctx.sha,
          manifestPath: T2_MANIFEST_PATH,
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T2_CAP_MICRO_USD, boxHourRateMicroUsd: T2_BOX_HOUR_RATE_MICRO_USD, manifestPath: T2_MANIFEST_PATH });

      const before = (await ctx.driver.list()).map((b) => b.name);
      evidence.push({ phase: "ls-before", boxes: before.filter((n) => n.startsWith("e2e-")), probe });

      // ── 1. dispatch: box + fill + the manifest pair + the setup gate ──────
      const dispatch = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", recordsDir],
        { cwd: REPO_ROOT, timeoutMs: T2_DISPATCH_TIMEOUT_MS },
      );
      dispatchOut = dispatch.stdout;
      dispatchErr = dispatch.stderr;
      evidence.push({
        phase: "dispatch-verb",
        exitCode: dispatch.exitCode,
        stdoutTail: dispatch.stdout.trim().slice(-400),
        stderrTail: dispatch.stderr.trim().slice(-600),
      });
      const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
      if (emitted !== undefined) runId = emitted;
      expect(dispatch.exitCode).toBe(0);
      const ackLine = dispatch.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
      expect(ackLine).toBeDefined();
      const ack = JSON.parse(ackLine as string) as { runId: string; vmName: string; state: string };
      runId = ack.runId;
      vmName = ack.vmName;
      expect(ack.state).toBe("ready");
      expect(runId).toMatch(/^qds-/);
      evidence.push({ phase: "ack", runId, vmName });

      // ── 2. start the in-box engine: qds-run@<runId>.service ──────────────
      // `startRun` issues one `systemctl start` and returns at the FORK (no
      // poll, no marker read), so this exit 0 says STARTED, never SUCCEEDED.
      const start = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: T2_RUN_TIMEOUT_MS,
      });
      evidence.push({ phase: "run-verb", exitCode: start.exitCode, stdoutTail: start.stdout.trim().slice(-200) });
      expect(start.exitCode).toBe(0);
      expect(start.stdout).toContain(`started: ${runId}`);

      // ── 3. poll to the terminal marker-backed verdict ────────────────────
      // SETTLED = "ok" | "not-ok" — the AC5 vocabulary. This run must END ok:
      // a failed team phase is an engine/substrate finding, not a flake to
      // retry around (see the header's FIRST-LIVE STATUS).
      const settled = await pollTerminalState(runId, recordsDir, evidence);
      evidence.push({ phase: "settled", state: settled });
      // live-mirror: "ok" = InBoxState terminal vocabulary (src/fleet/status.ts)
      expect(settled).toBe("ok");

      // ── 4. the engine log, read ON THE BOX before anything moves it ──────
      // live-mirror: $HOME/<runId>.engine.log = inBoxEngineLogPath (scripts/pipeline-run.ts derives it from the unit's %i)
      const home = await boxHome(ctx.driver, vmName);
      const engineLogBoxPath = `${home}/${runId}.engine.log`;
      const logRead = await ctx.driver.exec(vmName, ["sh", "-c", `cat ${shellQuote(engineLogBoxPath)}`]);
      evidence.push({ phase: "engine-log-read", exitCode: logRead.exitCode, bytes: logRead.stdout.length });
      expect(logRead.exitCode).toBe(0);
      const parsed = parseAttributionLines(logRead.stdout);
      evidence.push({
        phase: "attribution-lines",
        count: parsed.lines.length,
        refused: parsed.refused,
        roles: parsed.lines.map((l) => l.role),
        agents: [...new Set(parsed.lines.map((l) => l.agentId))],
      });
      // INV-COST-10 live: the money seam reached the DURABLE log.
      expect(parsed.lines.length).toBeGreaterThan(0);
      // INV-COST-8 live: a roster the dispatcher controls refuses nothing.
      expect(parsed.refused).toBe(0);
      // The wire's closed role vocabulary — a fourth value is a guessed role.
      for (const line of parsed.lines) {
        expect(
          typeof line.role === "string" && (["lead", "worker", "resident"] as string[]).includes(line.role),
        ).toBe(true);
      }

      // ── 5. the story's named CLI surface: sandbox-teardown ───────────────
      const td = await runSandboxTeardown(runId, recordsDir, TEARDOWN_TIMEOUT_MS);
      evidence.push({
        phase: "sandbox-teardown",
        exitCode: td.exitCode,
        stdoutTail: td.stdout.trim().slice(-400),
        stderrTail: td.stderr.trim().slice(-600),
      });
      expect(td.exitCode).toBe(0);

      const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
      expect(closed.closedAt ?? "").not.toBe("");
      expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0);
      expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(T2_CAP_MICRO_USD);
      evidence.push({ phase: "spend", capMicroUsd: T2_CAP_MICRO_USD, actualMicroUsd: closed.spendMicroUsd });

      // The HARVESTED copy of the log is what the bridge read — same parseable
      // attribution line count as the in-box original proves the artifacts
      // pull delivered every line (live-mirror: <runsDir>/<runId>-artifacts/<runId>.engine.log = cost-ledger-bridge.ts's harvestedAtLogPath).
      const harvestedLogPath = join(recordsDir, `${runId}-artifacts`, `${runId}.engine.log`);
      expect(existsSync(harvestedLogPath)).toBeTrue();
      const harvested = parseAttributionLines(readFileSync(harvestedLogPath, "utf8"));
      evidence.push({ phase: "harvested-log", count: harvested.lines.length, refused: harvested.refused });
      expect(harvested.lines.length).toBe(parsed.lines.length);

      // ── 6. the ledger: role-split token rows, exactly one per cost event ─
      const tokenRows = ledgerRows<{
        agent_id: string;
        role: string;
        model: string;
        invocation_seq: number;
        cost_micro_usd: number;
        unpriced: number;
      }>(
        recordsDir,
        "SELECT agent_id, role, model, invocation_seq, cost_micro_usd, unpriced FROM cost_events WHERE run_id = ? AND kind = 'tokens' ORDER BY agent_id, invocation_seq",
        runId,
      );
      evidence.push({ phase: "token-rows", rows: tokenRows });
      // One row PER cost event — the log's parseable attribution lines are the
      // event inventory, and every one landed (zero refusals asserted above).
      expect(tokenRows.length).toBe(parsed.lines.length);

      const roles = new Set(tokenRows.map((r) => r.role));
      // AC1: the lead and BOTH workers are attributed, by roster role — the
      // shared worker model cannot and did not blur the two agents together.
      expect(tokenRows.filter((r) => r.role === "lead").length).toBeGreaterThanOrEqual(1);
      const workerAgentIds = new Set(tokenRows.filter((r) => r.role === "worker").map((r) => r.agent_id));
      expect(workerAgentIds.has("worker-a")).toBe(true);
      expect(workerAgentIds.has("worker-b")).toBe(true);
      // AC3: the ARMED resident's metered spend is its own row.
      expect(roles.has("resident")).toBe(true);
      // AC2: two genuine invocations of one agent stay distinct — no
      // (agent_id, invocation_seq) pair repeats (a dedup collapse would show
      // here as one row where the log carried two).
      const seqKeys = tokenRows.map((r) => `${r.agent_id}#${r.invocation_seq}`);
      expect(new Set(seqKeys).size).toBe(seqKeys.length);

      const boxHours = ledgerRows<{ cost_micro_usd: number; unpriced: number }>(
        recordsDir,
        "SELECT cost_micro_usd, unpriced FROM cost_events WHERE run_id = ? AND kind = 'box_hours'",
        runId,
      );
      expect(boxHours.length).toBe(1); // fractional µ$ row (post-F8), priced
      expect(boxHours[0]?.unpriced).toBe(0);

      // AC1's exactness: the priced SUM equals the sum of the individual rows.
      // Then the W2-2 hardened shape: that SUM against the record's
      // provider-authoritative figure at the SAME tolerance
      // reportSpendDivergence runs at close — a partial or unpriced-only
      // harvest cannot pass this.
      const pricedSum = ledgerRows<{ s: number }>(
        recordsDir,
        "SELECT COALESCE(SUM(CASE WHEN unpriced = 0 THEN cost_micro_usd ELSE 0 END), 0) AS s FROM cost_events WHERE run_id = ? AND kind = 'tokens'",
        runId,
      )[0]?.s ?? -1;
      const pricedTokenMicroUsd = Number(pricedSum);
      evidence.push({
        phase: "ledger",
        tokenRowCount: tokenRows.length,
        pricedTokenMicroUsd,
        spendMicroUsd: closed.spendMicroUsd,
        boxHours,
        crossCheck: "SUM(cost_micro_usd WHERE unpriced = 0) vs the record's captureSpend figure, tolerance from teardown's SPEND_DIVERGENCE_TOLERANCE_MICRO_USD",
      });
      expect(Math.abs((closed.spendMicroUsd ?? 0) - pricedTokenMicroUsd)).toBeLessThanOrEqual(
        SPEND_DIVERGENCE_TOLERANCE_MICRO_USD,
      );
      tokenRowsBeforeReTeardown = tokenRows.length;

      // ── 7. qds cost: the TOKENS cell + the multi-role split ──────────────
      const cost = runQdsCost(recordsDir);
      evidence.push({ phase: "qds-cost", exitCode: cost.exitCode, stdout: cost.stdout, stderrTail: cost.stderr.trim().slice(-300) });
      expect(cost.exitCode).toBe(0);
      // Multi-role split: the PER ROLE block names lead, worker AND resident.
      const perRoleBlock = cost.stdout.split("PER ROLE:")[1]?.split("PER RUN:")[0] ?? "";
      expect(perRoleBlock).toMatch(/\blead\b/);
      expect(perRoleBlock).toMatch(/\bworker\b/);
      expect(perRoleBlock).toMatch(/\bresident\b/);
      // The run's row: TOKENS cell renders ✓ (round-6 CLI-1: refusal evidence
      // would ride a suffix — "✓ (refused n)" — and still start with ✓).
      const runLine = cost.stdout.split("\n").find((l) => l.includes(runId));
      expect(runLine).toBeDefined();
      const tokensCell = (runLine as string).slice((runLine as string).indexOf(runId) + 30).trim().split(/\s{2,}/).at(-1) ?? "";
      evidence.push({ phase: "tokens-cell", tokensCell });
      expect(tokensCell.startsWith("✓")).toBe(true);

      // ── 8. AC2 idempotency: the re-run adds ZERO rows ────────────────────
      const td2 = await runSandboxTeardown(runId, recordsDir, TEARDOWN_TIMEOUT_MS);
      evidence.push({ phase: "sandbox-teardown-retry", exitCode: td2.exitCode, stdoutTail: td2.stdout.trim().slice(-200) });
      expect(td2.exitCode).toBe(0);
      const tokenRowsAfter = ledgerRows<{ n: number }>(
        recordsDir,
        "SELECT COUNT(*) AS n FROM cost_events WHERE run_id = ? AND kind = 'tokens'",
        runId,
      )[0]?.n ?? -1;
      expect(tokenRowsAfter).toBe(tokenRowsBeforeReTeardown);

      // ── 9. the key is gone and the box is gone ───────────────────────────
      expect(await listedKeyHashes()).not.toContain(closed.keyHash);
      const gone = await awaitBoxAbsent(ctx.driver, vmName, evidence, { maxAttempts: 4, retryDelayMs: 10_000 });
      expect(gone.absent).toBeTrue();
    } catch (e) {
      outcome = "fail";
      failure = e;
      evidence.push({ phase: "test-error", error: String((e as Error)?.message ?? e) });
    } finally {
      // F12 lesson: recover ids from BOTH streams so a dispatch that
      // provisioned then refused still cleans up its box.
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
      } catch {
        recordStore = undefined;
      }
      const fallback = {
        driver: ctx.driver,
        store: recordStore,
        runIds: runId === "" ? [] : [runId],
      };
      keyProblems = await keyLeakProblems(hashesBefore, fallback, evidence);
      const cleanupProblems = fleetCleanupProblems(destroyFailures, finalBoxes);
      writeEvidenceQuietly("df212-g10", "t2-7-token-attribution", {
        outcome,
        sha: ctx.sha,
        runId,
        vmName,
        evidence,
      }, [...cleanupProblems, ...keyProblems]);
      settleRun(failure, [...cleanupProblems, ...keyProblems]);
    }
    // Asserted AFTER the finally (F2/#189): the cleanup verdict is the round's
    // verdict, not prose beside it.
    expect(destroyFailures).toEqual([]);
    expect(keyProblems).toEqual([]);
    expect(finalBoxes).toEqual([]);
  }
);

/**
 * BUDGET AUDIT (the foot-of-file figure the header's spend statement prices):
 * dispatch 900 000 + run 180 000 + status polls 40 × (60 000 verb + 20 000
 * wait) = 3 200 000 + sandbox-teardown 300 000 + qds-cost ~60 000 + the
 * idempotent re-teardown 300 000 ≈ 4 940 000 ms worst case ≈ 1.4 h of box at
 * 230 000 µ$/h ≈ 315 000 µ$, plus 1 key × 50 000 µ$ cap ≈ $0.37 worst case,
 * inside the operator's ~$0.65 envelope. A HEALTHY round: dispatch ~5 min,
 * engine ~6 min, teardown ~1 min — minutes and cents.
 */
