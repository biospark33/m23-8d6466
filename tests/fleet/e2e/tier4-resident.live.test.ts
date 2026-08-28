/**
 * T4 — DF3.3 resident orchestrator LIVE (PR #135 pre-merge round).
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2. Operator approved spend out of
 * band: 1 dispatch key (cap 50 000 µ$) + 1 resident key (cap 50 000 µ$) +
 * 1 box. Worst case ≈ $0.10 model + ~1 box-hour.
 *
 * WHAT IS REAL HERE: `fleet dispatch` provisions a real box, mints a real
 * capped run key, and delivers the STAMPED manifest + run-context.json (the
 * resident's brief witness) onto the box. The DELIVERED pair is then fetched
 * back off the box and fed to the PRODUCTION `scripts/pipeline-run.ts` —
 * the full DF3.3 wiring: resident arming from the witness brief, real host
 * `pi` (0.55.x, --provider openrouter --mode json), REAL OpenRouter steering
 * calls on a separately-minted capped key, engine-metered integer-µ$
 * telemetry, redacted pre-execution artifacts. NO fake pi emulator anywhere
 * in this file — the fake-resident fixture is DF3.3's offline e2e territory.
 *
 * WHY THE PHASE BODIES RUN HOST-SIDE: pipeline-run.ts execs `code` phases
 * where it runs (the in-box executor is proposed story DF1.10; T3.5 already
 * proved on-box exec of the same production Run/walkPhases). What THIS test
 * adds is the resident substrate no prior tier touched: the delivered brief
 * riding out of a real dispatch, a real model steering a real run, and the
 * full journal/telemetry contract on live replies.
 *
 * THREE LEGS share one dispatch (the S28 witness window is ±30 min):
 *   L1 control    — --no-resident: status "disabled", deterministic run.
 *   L2 steered    — armed: real directives at the three solicitation points;
 *                   AC1b invariants (phase order, evidence-derived verdicts,
 *                   no unearned promotion), telemetry, artifacts, metering.
 *   L3 degraded   — QDS_RESIDENT_TIMEOUT_MS=50: every solicitation dies at
 *                   the timeout, status "degraded", run completes fully
 *                   deterministic, ZERO gates skipped (INV-RES-5 live).
 *
 * Model output is nondeterministic: L2 asserts ENGINE invariants conditional
 * on the directive actions the model actually chose (an abort must land the
 * engine's own fail transition, never a skipped gate), and records the action
 * sequence as evidence. Byte-identity (AC1a) is deliberately NOT asserted
 * live — that is the offline fake-pi e2e's deterministic territory.
 *
 * NO FAKES anywhere in this file.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { mintRunKey, openRouterKeyApi, revokeAndVerify } from "../../../src/providers/credentials.ts";
import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import {
  REPO_ROOT,
  destroyQuietly,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  runFleet,
  tmpWorkspace,
  writeEvidence,
  runIdFor,
} from "./live-harness.ts";

const T4_CAP_MICRO_USD = 50_000;
const T4_BOX_HOUR_RATE_MICRO_USD = 230_000;
const ISSUE_KEY = "biospark33/QDS-Factory#46";
const T4_MANIFEST_PATH = "config/rosters/t4.resident.pipeline.json";
/** Round-7 S2-6: timeout discriminator gates on >25 ms; 50 ms is above it and
 * far below any real model latency — every L3 call dies at the timeout. */
const T4_DEGRADE_TIMEOUT_MS = 50;
const LEG_TIMEOUT_MS = 600_000;

interface JournalBody {
  version?: string;
  runId?: string;
  ok?: boolean;
  completedAt?: string;
  phases?: Array<{ name?: string; status?: string }>;
  gateEvents?: Array<{ runId?: string; phaseId?: string; type?: string }>;
  resident?: {
    status?: string;
    directives?: number;
    directivesRejected?: number;
    steeringIterations?: Record<string, number>;
    spendMicros?: number;
    exitStatus?: string | null;
    tripwires?: Array<Record<string, unknown>>;
  };
}

interface SolicitLine {
  level?: string;
  event?: string;
  runId?: string;
  requestId?: string | null;
  phase?: string | null;
  point?: string;
  directiveAction?: string;
  model?: string;
  accepted?: boolean;
  spendMicros?: number;
  durationMs?: number;
  error?: string;
}

/** POSIX single-quote wrapping — mirrored from pipeline-run-remote.ts. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

async function boxExec(vm: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await new ExeDevDriver().exec(vm, [...args]);
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/** Read one file OFF the box (pipeline-run-remote.ts's fetchBoxFile shape). */
async function fetchBoxFile(vm: string, boxPath: string): Promise<string> {
  const r = await boxExec(vm, ["sh", "-c", `cat ${shellQuote(boxPath)}`]);
  if (r.exitCode !== 0) {
    throw new Error(`box read of ${boxPath} failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 300)}`);
  }
  return r.stdout;
}

/** The box's $HOME resolved ON THE BOX (pipeline-run-remote.ts's boxHome). */
async function boxHome(vm: string): Promise<string> {
  const r = await boxExec(vm, ["sh", "-c", 'printf %s "$HOME"']);
  const home = r.stdout.trim();
  if (r.exitCode !== 0 || !/^[A-Za-z0-9._/-]+$/.test(home) || !home.startsWith("/")) {
    throw new Error(`could not resolve $HOME on ${vm} (exit ${r.exitCode}): ${home.slice(0, 120)}`);
  }
  return home;
}

interface LegResult {
  leg: string;
  runId: string;
  exitCode: number | null;
  journal: JournalBody;
  solicits: SolicitLine[];
  stdoutHead: string;
  stderrTail: string;
  legDir: string;
  artifacts: string[];
  markerOk: boolean | null;
}

/**
 * Run the PRODUCTION pipeline-run.ts against the DELIVERED manifest+witness
 * pair under <workspace>/delivered/. Fresh TMPDIR per leg isolates the build
 * testCommand's state-file counter. The resident's persist/session dir is
 * dirname(--journal) = the leg dir, so artifacts land there directly.
 */
async function runLeg(
  leg: string,
  deliveredDir: string,
  witnessRequestId: string,
  env: Record<string, string>,
  extraArgs: readonly string[] = [],
): Promise<LegResult> {
  const legDir = join(deliveredDir, "..", leg);
  mkdirSync(legDir, { recursive: true });
  const tmp = join(legDir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const runId = runIdFor(`t4-${leg}`);
  const journalPath = join(legDir, "journal.jsonl");
  const proc = Bun.spawn({
    cmd: [
      "bun",
      join(REPO_ROOT, "scripts/pipeline-run.ts"),
      "--manifest",
      join(deliveredDir, "pipeline.yaml"),
      "--journal",
      journalPath,
      "--run-id",
      runId,
      "--request-id",
      witnessRequestId,
      "--budget-ms",
      "200000",
      "--run-root",
      legDir,
      ...extraArgs,
    ],
    cwd: REPO_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      TMPDIR: tmp,
      QDS_RUN_ROOT: legDir,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [exitCode, stdout, stderr] = await Promise.all([
    Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`leg ${leg} timed out after ${LEG_TIMEOUT_MS} ms`)),
          LEG_TIMEOUT_MS,
        );
      }),
    ]).catch(async (e) => {
      proc.kill();
      throw e;
    }) as Promise<number | null>,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  const journal: JournalBody = existsSync(journalPath)
    ? (JSON.parse(readFileSync(journalPath, "utf8")) as JournalBody)
    : {};
  const solicits: SolicitLine[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.includes("resident_solicit")) continue;
    try {
      const parsed = JSON.parse(line) as SolicitLine;
      if (parsed.event === "resident_solicit") solicits.push(parsed);
    } catch {
      // a torn trailing line is noise; the journal block is the record
    }
  }
  const artifacts = existsSync(legDir)
    ? readdirSync(legDir)
        .filter((f) => f.includes("-solicit-"))
        .map((f) => join(legDir, f))
    : [];
  const markerPath = join(legDir, "journal", "final.json");
  const markerOk = existsSync(markerPath)
    ? (JSON.parse(readFileSync(markerPath, "utf8")) as { ok?: boolean }).ok ?? null
    : null;
  return {
    leg,
    runId,
    exitCode,
    journal,
    solicits,
    stdoutHead: stdout.trim().slice(0, 300),
    stderrTail: stderr.trim().slice(-600),
    legDir,
    artifacts,
    markerOk,
  };
}

/** Phase (name,status) pairs — the promotion/order projection. */
function promotionOf(j: JournalBody): Array<[string | undefined, string | undefined]> {
  return (j.phases ?? []).map((p) => [p.name, p.status] as [string | undefined, string | undefined]);
}

/** (phaseId,type) pairs — the evidence-derived gate-verdict sequence. */
function gateSeqOf(j: JournalBody): Array<[string | undefined, string | undefined]> {
  return (j.gateEvents ?? []).map((e) => [e.phaseId, e.type] as [string | undefined, string | undefined]);
}

test.todoIf(liveTodoOff())(
  "T4 resident LIVE: dispatch → control/steered/degraded legs on the delivered brief → real OpenRouter steering",
  async () => {
    liveGate("2");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight("2");
    let workspace = "";
    let runId = "";
    let vm = "";
    let residentKeyHash = "";
    let store: RunRecordStore | undefined;
    let outcome = "pass";
    try {
      workspace = tmpWorkspace("t4res");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      writeFileSync(
        join(workspace, "cost-config.json"),
        JSON.stringify({
          defaultCapMicroUsd: T4_CAP_MICRO_USD,
          boxHourRateMicroUsd: T4_BOX_HOUR_RATE_MICRO_USD,
          perIssueOverrides: { [ISSUE_KEY]: T4_CAP_MICRO_USD },
        }),
      );
      const briefPath = join(workspace, "brief.json");
      writeFileSync(
        briefPath,
        JSON.stringify({
          repoSlug: "biospark33/QDS-Factory",
          issueId: 46,
          commitSha: ctx.sha,
          manifestPath: T4_MANIFEST_PATH,
          repoUrl: ctx.repoUrl,
        }),
      );
      evidence.push({ phase: "setup", ok: true, capMicroUsd: T4_CAP_MICRO_USD, manifestPath: T4_MANIFEST_PATH });

      // ── 1. dispatch: real box + real capped key + delivered stamped pair ─
      const d = await runFleet(
        ["dispatch", "--driver", "exedev", "--brief", briefPath],
        { cwd: REPO_ROOT, env: { QDS_RUNS_DIR: recordsDir }, timeoutMs: 1_800_000 },
      );
      evidence.push({ phase: "dispatch-verb", exitCode: d.exitCode, stdoutHead: d.stdout.trim().slice(0, 400), stderrTail: d.stderr.trim().slice(-400) });
      expect(d.exitCode).toBe(0);
      const ack = JSON.parse(d.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) as string) as {
        runId: string;
        vmName: string;
        state: string;
      };
      expect(ack.state).toBe("ready");
      runId = ack.runId;
      vm = ack.vmName;
      evidence.push({ phase: "dispatch-ack", ack });

      // ── 2. fetch the DELIVERED stamped pair OFF the box ─────────────────
      const home = await boxHome(vm);
      const manifestBytes = await fetchBoxFile(vm, `${home}/pipeline.yaml`);
      const witnessBytes = await fetchBoxFile(vm, `${home}/run-context.json`);
      const deliveredDir = join(workspace, "delivered");
      mkdirSync(deliveredDir, { recursive: true });
      writeFileSync(join(deliveredDir, "pipeline.yaml"), manifestBytes);
      writeFileSync(join(deliveredDir, "run-context.json"), witnessBytes);
      const witness = JSON.parse(witnessBytes) as {
        requestId?: string;
        effectiveCeilingMicros?: number;
        [k: string]: unknown;
      };
      expect(typeof witness.requestId).toBe("string");
      expect((witness.requestId ?? "").length).not.toBe(0);
      evidence.push({
        phase: "delivered-pair",
        witnessRequestId: witness.requestId,
        witnessCeiling: witness.effectiveCeilingMicros,
        deliveredLimit: (JSON.parse(manifestBytes) as { limitMicroUsd?: number }).limitMicroUsd,
        briefKeys: Object.keys(witness).sort(),
      });

      // ── 3. mint the resident's OWN capped key (never the dispatch key,
      //       never the provisioning key — INV-RES-3's shape on the host) ──
      store = new RunRecordStore({ dir: recordsDir });
      const residentRunId = `${runId}-resident`;
      // mintRunKey reads the record first (already-minted check) — a missing
      // record is an ENOENT throw, so create the row before minting (the same
      // create→mint ordering the harness's T1 mintCappedKey relies on).
      store.create(residentRunId);
      const minted = await mintRunKey(
        { store, keyApi: openRouterKeyApi(), driver: ctx.driver, capMicroUsd: T4_CAP_MICRO_USD },
        residentRunId,
      );
      residentKeyHash = minted.hash; // hash is a non-secret identifier; plaintext never leaves this scope
      evidence.push({ phase: "resident-key-minted", keyHash: minted.hash, capMicroUsd: T4_CAP_MICRO_USD });

      // ── 4. L1 CONTROL: --no-resident → disabled, deterministic ─────────
      const l1 = await runLeg("l1-control", deliveredDir, witness.requestId as string, {}, ["--no-resident"]);
      evidence.push({
        phase: "l1-control",
        exitCode: l1.exitCode,
        ok: l1.journal.ok,
        markerOk: l1.markerOk,
        phases: promotionOf(l1.journal),
        resident: l1.journal.resident,
        solicits: l1.solicits.length,
      });
      expect(l1.exitCode).toBe(0);
      expect(l1.journal.ok).toBe(true);
      expect(l1.markerOk).toBe(true);
      expect(promotionOf(l1.journal)).toEqual([
        ["plan", "success"],
        ["build", "success"],
      ]);
      expect(l1.journal.resident?.status).toBe("disabled");
      expect(l1.solicits).toEqual([]);
      expect(l1.artifacts).toEqual([]);
      // The control run still rides the real gate: fail@1 (counter=1) then
      // pass@2 (counter=2) — evidence-derived verdicts with no resident.
      expect(gateSeqOf(l1.journal)).toEqual([
        ["build", "gate_fail"],
        ["build", "gate_pass"],
      ]);

      // ── 5. L2 STEERED: real pi, real OpenRouter, real directives ───────
      const l2 = await runLeg("l2-steered", deliveredDir, witness.requestId as string, {
        OPENROUTER_API_KEY: minted.key,
      });
      const l2Actions = l2.solicits.map((s) => s.directiveAction);
      const l2Aborted = l2Actions.includes("abort");
      evidence.push({
        phase: "l2-steered",
        exitCode: l2.exitCode,
        ok: l2.journal.ok,
        markerOk: l2.markerOk,
        phases: promotionOf(l2.journal),
        resident: l2.journal.resident,
        solicitPoints: l2.solicits.map((s) => s.point),
        directiveActions: l2Actions,
        acceptedFlags: l2.solicits.map((s) => s.accepted),
        models: l2.solicits.map((s) => s.model),
        durationsMs: l2.solicits.map((s) => s.durationMs),
        cumulativeSpendMicros: l2.solicits.map((s) => s.spendMicros),
        stderrTail: l2.stderrTail,
      });
      // Exactly the three engine-owned solicitation points, in order.
      expect(l2.solicits.map((s) => s.point)).toEqual(["run_start", "post_gate_failure", "run_end"]);
      // Every line carries the run's identity and the armed model.
      for (const s of l2.solicits) {
        expect(s.runId).toBe(l2.runId);
        expect(s.requestId).toBe(witness.requestId);
        expect(s.model).toBe("deepseek/deepseek-v4-flash-0731");
      }
      // AC1b: phase order preserved; every gate verdict evidence-derived
      // (same fail@1 → pass@2 sequence the control produced); promotion no
      // broader than the control's on the same evidence — unless the model
      // legitimately aborted, in which case the engine's OWN fail transition
      // must show (ok:false, never a promoted phase after it).
      expect((l2.journal.phases ?? []).map((p) => p.name)).toEqual(["plan", "build"]);
      if (!l2Aborted) {
        expect(l2.exitCode).toBe(0);
        expect(l2.journal.ok).toBe(true);
        expect(l2.markerOk).toBe(true);
        expect(promotionOf(l2.journal)).toEqual(promotionOf(l1.journal));
        expect(gateSeqOf(l2.journal)).toEqual(gateSeqOf(l1.journal));
        expect(l2.journal.resident?.status).toBe("active");
        expect(l2.journal.resident?.exitStatus).toBe("success");
      } else {
        expect(l2.journal.ok).toBe(false);
        expect(l2.journal.resident?.status).toBe("active");
        evidence.push({ phase: "l2-abort-observed", note: "model chose abort; engine fail-transition asserted" });
      }
      // Telemetry contract (AC5): integer µ$ > 0 (real metered usage), the
      // directive partition sums to the three solicitations, and the final
      // cumulative observability line reconciles with the journal block.
      const r2 = l2.journal.resident;
      expect(Number.isSafeInteger(r2?.spendMicros)).toBe(true);
      expect(r2?.spendMicros ?? 0).toBeGreaterThan(0);
      expect(r2?.spendMicros ?? 0).toBeLessThanOrEqual(T4_CAP_MICRO_USD);
      expect((r2?.directives ?? 0) + (r2?.directivesRejected ?? 0)).toBe(3);
      expect(l2.solicits.at(-1)?.spendMicros).toBe(r2?.spendMicros);
      // steeringIterations only ever counts accepted post_gate_failure
      // retries for a phase that exists (build: 0 or 1 — recorded, both legal).
      const iterKeys = Object.keys(r2?.steeringIterations ?? {});
      for (const k of iterKeys) {
        expect(["plan", "build"]).toContain(k);
        expect(r2?.steeringIterations?.[k]).toBeGreaterThanOrEqual(0);
      }
      // Pre-execution persistence (DOD-Security): 3 prompts + 3 replies,
      // mode 0600, and NO key material in any artifact byte.
      expect(l2.artifacts.length).toBe(6);
      for (const a of l2.artifacts) {
        const st = statSync(a);
        expect(st.mode & 0o077).toBe(0);
        const body = readFileSync(a, "utf8");
        expect(body).not.toContain("sk-or-");
        expect(body).not.toContain(minted.key);
      }
      // The pi session file exists beside the artifacts (per-runId file).
      expect(existsSync(join(l2.legDir, `${l2.runId}.resident.jsonl`))).toBe(true);

      // ── 6. L3 DEGRADED: 50 ms timeout → degraded, deterministic, no
      //       skipped gates (INV-RES-5 live) ──────────────────────────────
      const l3 = await runLeg("l3-degraded", deliveredDir, witness.requestId as string, {
        OPENROUTER_API_KEY: minted.key,
        QDS_RESIDENT_TIMEOUT_MS: `${T4_DEGRADE_TIMEOUT_MS}`,
      });
      evidence.push({
        phase: "l3-degraded",
        exitCode: l3.exitCode,
        ok: l3.journal.ok,
        markerOk: l3.markerOk,
        phases: promotionOf(l3.journal),
        resident: l3.journal.resident,
        solicits: l3.solicits.map((s) => ({ point: s.point, action: s.directiveAction, accepted: s.accepted })),
      });
      expect(l3.exitCode).toBe(0);
      expect(l3.journal.ok).toBe(true);
      expect(l3.markerOk).toBe(true);
      expect(l3.journal.resident?.status).toBe("degraded");
      // Deterministic completion: identical promotion AND gate sequence to
      // the control — zero gates skipped, zero phases shortened.
      expect(promotionOf(l3.journal)).toEqual(promotionOf(l1.journal));
      expect(gateSeqOf(l3.journal)).toEqual(gateSeqOf(l1.journal));
      // All three hook points still solicited; none accepted a directive.
      expect(l3.solicits.length).toBe(3);
      expect(l3.solicits.every((s) => s.accepted === false)).toBe(true);
      expect(l3.journal.resident?.directives ?? -1).toBe(0);

      // ── 7. money identity: stamp == witness == record (t3.5 parity) ────
      const deliveredLimit = (JSON.parse(manifestBytes) as { limitMicroUsd?: number }).limitMicroUsd;
      const rec = store.get(runId);
      evidence.push({
        phase: "money-identity",
        deliveredLimit,
        witnessCeiling: witness.effectiveCeilingMicros,
        recordLimit: rec.limitMicroUsd,
        residentSpendMicros: l2.journal.resident?.spendMicros,
      });
      expect(deliveredLimit).toBe(T4_CAP_MICRO_USD);
      expect(witness.effectiveCeilingMicros).toBe(deliveredLimit);
      expect(rec.limitMicroUsd).toBe(deliveredLimit);

      // ── 8. teardown: spend ≤ cap, keys revoked, box gone ───────────────
      const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"], { cwd: REPO_ROOT, timeoutMs: 300_000 });
      evidence.push({ phase: "teardown", exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-300) });
      expect(td.exitCode).toBe(0);
      const closed = store.get(runId);
      expect(closed.spendMicroUsd ?? 0).toBeLessThanOrEqual(T4_CAP_MICRO_USD);
      await revokeAndVerify({ store, keyApi: openRouterKeyApi(), driver: ctx.driver }, residentKeyHash);
      const hashes = await listedKeyHashes();
      expect(hashes).not.toContain(closed.keyHash);
      expect(hashes).not.toContain(residentKeyHash);
      expect((await ctx.driver.list()).map((b) => b.name)).not.toContain(vm);
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      if (residentKeyHash !== "") {
        try {
          await revokeAndVerify(
            { store: store ?? new RunRecordStore({ dir: join(workspace || tmpdir(), "runs") }), keyApi: openRouterKeyApi(), driver: ctx.driver },
            residentKeyHash,
          );
          evidence.push({ phase: "finally-resident-revoke", ok: true });
        } catch (e) {
          evidence.push({ phase: "finally-resident-revoke", ok: false, error: (e as Error).message });
        }
      }
      if (runId !== "" && workspace !== "") {
        const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"], { timeoutMs: 180_000 });
        evidence.push({ phase: "finally-teardown", exitCode: td.exitCode });
      }
      if (vm !== "") await destroyQuietly(ctx.driver, vm, evidence);
      try {
        const final = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
        evidence.push({ phase: "final-ls", fleetBoxes: final });
        expect(final).toEqual([]);
      } catch (e) {
        evidence.push({ phase: "final-ls-error", error: (e as Error).message });
      }
      try {
        const evidencePath = writeEvidence("t4-resident-live", { test: "T4", outcome, runId, capMicroUsd: T4_CAP_MICRO_USD, phases: evidence });
        process.stderr.write(`[T4] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "" && outcome === "pass") rmSync(workspace, { recursive: true, force: true });
        else if (workspace !== "") process.stderr.write(`[T4] workspace kept for forensics: ${workspace}\n`);
      }
    }
  },
  2_400_000,
);
