#!/usr/bin/env bun
/**
 * DF2.4 — cap-hit demo: provider cap detection, overflow classification,
 * wall-clock race, teardown on every verdict, artifact redaction, and the
 * mandatory e2e demo (live: real capped key, real spend, verified kill).
 *
 * Usage:
 *   cap-hit-demo [--cap µ$] [--roster path] [--driver name] [--dir runs-dir]
 *                 [--repo-url url] [--sha commit] [--wall-clock-ms ms]
 *                 [--budget-cap µ$] [--ceiling µ$]
 *
 * Evidence artifact written to .sandbox/evidence/df2-4-cap-hit-<runId>.json
 * (dir 0700, file 0600, atomic tmp+rename).
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import {
  captureSpend,
  createRun,
  deliverRunKey,
  executeRun,
  fillRun,
  mintRunKey,
  openRouterKeyApi,
  resolveDriver,
  teardownSandbox,
  type BoxFile,
  type KeyApi,
  type ProviderDriver,
  type ExecResult,
} from "../src/providers/index.ts";
import { newId, RunRecordStore, type RunRecord } from "../src/providers/run-record.ts";
import { shQuote } from "../src/providers/exedev/transport.ts";
import { log, newRequestId, setLogSink } from "../src/swarmclaw/log.ts";
import {
  classifyRunExit,
  redactKeyManagementUrls,
  redactWithKey,
  type InBoxExit,
  type TerminationProvenance,
} from "../src/providers/cap-rejection.ts";

// Structured logs go to stderr so stdout carries only the result JSON.
if (import.meta.main) {
  setLogSink((entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  });
}

// ---------------------------------------------------------------------------
// Public contracts (tests import these)
// ---------------------------------------------------------------------------

export interface CapHitDemoDeps {
  driver: ProviderDriver;
  keyApi: KeyApi;
  store: RunRecordStore;
  requestId?: string;
  evidenceDir?: string;
  now?: () => Date;
  /** Override envFile path for key delivery (default: /home/agent/app/.env). */
  envFile?: string;
  /**
   * Host-side re-probe override (AC2): one cheap chat call with the retained
   * runtime key after the workload ends and BEFORE revoke. Default resolution:
   * deps.probe ?? keyApi.chatComplete (fake substrate) ?? openRouterChatProbe
   * (production — the provider the key lives on).
   */
  probe?: (key: string, model: string) => Promise<{ status: number; body: string }>;
}

export interface CapHitDemoOptions {
  /** Key cap in microdollars (default 50_000 = $0.05). */
  capMicroUsd?: number;
  /** Wall-clock ceiling in ms (default 900_000 = 15 min). */
  wallClockMs?: number;
  /** Inner control: run budget cap (artifact field only). */
  runBudgetCapMicros?: number;
  /** Inner control: resident ceiling (artifact field only). */
  residentCeilingMicros?: number;
  /** Workload argv (default: fake substrate uses ["true"], live loads from fixture). */
  workloadArgv?: string[];
  /** Fixture path for live substrate workload YAML (default: loopy-workload.yaml). */
  fixturePath?: string;
  /** Repo URL for live substrate fill/setup. */
  repoUrl?: string;
  /** Commit SHA for live substrate fill/setup. */
  commitSha?: string;
  /** Roster path for live substrate setup. */
  rosterPath?: string;
  /** Evidence directory path for artifact output. */
  evidenceDir?: string;
}

export interface CapHitTimings {
  mint_ms: number;
  setup_ms: number;
  workload_ms: number;
  reprobe_ms: number;
  capture_spend_ms: number;
  teardown_ms: number;
}

export interface CapHitArtifact {
  story: "df2-4";
  runId: string;
  requestId: string;
  substrate: string;
  capMicroUsd: number;
  spendMicroUsd: number;
  turnsCompleted: number;
  turnsSource: "in-box";
  rejectionStatus: string | null;
  providerCapRejected: boolean;
  terminationProvenance: TerminationProvenance;
  /** Workload exit classification; null when no workload exit ever happened. */
  exitStatus: InBoxExit | null;
  killOrigin: "provider-cap" | "wall-clock" | "host-error" | null;
  revocationVerified: boolean;
  closedAt: string | null;
  verdict: "demonstrated" | "inconclusive";
  reason: string | null;
  runBudgetCapMicros: number;
  residentCeilingMicros: number;
  keyHash: string;
  timings: CapHitTimings;
  recordedAt: string;
}

export interface CapHitDemoResult {
  runId: string;
  verdict: "demonstrated" | "inconclusive";
  reason: string | null;
  artifactPath: string;
  artifact: CapHitArtifact;
}

// ponytail: defaults inline — no separate defaults object
const DEFAULT_CAP_MICRO_USD = 50_000;
const DEFAULT_WALL_CLOCK_MS = 900_000;
const DEFAULT_RUN_BUDGET_CAP = 40_000;
const DEFAULT_RESIDENT_CEILING = 30_000;
const DEFAULT_FIXTURE_PATH = "tests/providers/fixtures/loopy-workload.yaml";

// Live-substrate layout, measured on the exe.dev image (boldsoftware/exeuntu,
// 2026-08-19 probe): the user is `exedev`, home /home/exedev — there is NO
// /home/agent (the inkwell layout DF2.2/DF2.3 defaults assume). Their override
// knobs carry the corrected paths; no predecessor code changes.
const LIVE_HOME = "/home/exedev";
const LIVE_ENV_FILE = `${LIVE_HOME}/.env`;
const LIVE_WORKDIR = `${LIVE_HOME}/src`;

// ---------------------------------------------------------------------------
// Core demo function
// ---------------------------------------------------------------------------

/** Atomic artifact write: tmp file (0600) + rename. Dir created 0700. */
function writeArtifactFile(evidenceDir: string, artifact: CapHitArtifact): string {
  mkdirSync(evidenceDir, { recursive: true });
  chmodSync(evidenceDir, 0o700);
  const filename = `df2-4-cap-hit-${artifact.runId}.json`;
  const path = join(evidenceDir, filename);
  const tmp = join(evidenceDir, `.tmp-${filename}`);
  writeFileSync(tmp, JSON.stringify(artifact, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Cheap probe model (fixture model on the live path overrides this). */
const DEFAULT_PROBE_MODEL = "deepseek/deepseek-v4-flash-0731";
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Production host-side re-probe (AC2): one minimal chat call with the retained
 * RUNTIME key, after the workload terminates and before revoke. The provider's
 * cap-rejection answer sets providerCapRejected — two modes count: HTTP 402
 * "Insufficient credits" (account-level, docs/api_reference/limits) and HTTP
 * 403 "Key limit exceeded" (per-key spend cap, MEASURED live 2026-08-19); any
 * other outcome leaves it false. The probe's own cost is inside the cap by
 * construction (the key is exhausted).
 */
async function openRouterChatProbe(key: string, model: string): Promise<{ status: number; body: string }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "1" }], max_tokens: 1 }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text() };
}

export async function runCapHitDemo(
  deps: CapHitDemoDeps,
  opts: CapHitDemoOptions = {},
): Promise<CapHitDemoResult> {
  const nowFn = (() => new Date());
  const requestId = deps.requestId ?? newRequestId();
  const substrate = deps.driver.name;
  const isLive = substrate === "exedev";

  // Resolve opts with defaults
  const capMicroUsd = opts.capMicroUsd ?? DEFAULT_CAP_MICRO_USD;
  const wallClockMs = opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const runBudgetCapMicros = opts.runBudgetCapMicros ?? DEFAULT_RUN_BUDGET_CAP;
  const residentCeilingMicros = opts.residentCeilingMicros ?? DEFAULT_RESIDENT_CEILING;
  // Precedence: injected deps (test seam) beat opts beat env — the seam wins.
  const evidenceDir = deps.evidenceDir ?? opts.evidenceDir ?? process.env.QDS_EVIDENCE_DIR ?? ".sandbox/evidence";
  // Substrate-correct key file: DF2.3's default (/home/agent/app/.env) is the
  // inkwell layout; the exe.dev image has no /home/agent. The fake substrate
  // keeps its box-relative path.
  const envFile = deps.envFile ?? (isLive ? LIVE_ENV_FILE : "app/.env");

  // ---- 1. VM creation (INV-1: record → VM → key) ----
  // createRun does store.create internally
  const runId = newId("df2-4-cap-hit", nowFn());

  // A record read that must never strand a live key: mid-run store/corruption
  // errors fall back to a shell so teardown + revocation still run (AC3).
  const readRecordSafe = (): Partial<RunRecord> => {
    try {
      return deps.store.get(runId);
    } catch {
      return {};
    }
  };

  const vm = await createRun(deps.driver, deps.store, { runId });
  const vmName = vm.vmName ?? runId;

  // Teardown + artifact write for any verdict — or failure — reached BEFORE
  // the workload ran (AC3: no path skips the teardown call; where teardown
  // itself aborts, DF2.5 semantics leave the box alive and the record open for
  // DF2.6's reaper, and the artifact says teardown-aborted). exitStatus is
  // null: no workload exit ever happened (INV-2 honesty — assert no box exit).
  const finishEarly = async (reason: string, setupElapsedMs: number): Promise<CapHitDemoResult> => {
    let teardownOk = true;
    try {
      await teardownSandbox(
        { driver: deps.driver, store: deps.store, keyApi: deps.keyApi, requestId, gitCwd: process.cwd() },
        runId,
        {},
      );
    } catch {
      teardownOk = false;
    }
    const recAfter = readRecordSafe();
    const finalReason = teardownOk ? reason : "teardown-aborted";
    const artifact: CapHitArtifact = {
      story: "df2-4",
      runId,
      requestId,
      substrate,
      capMicroUsd: recAfter.limitMicroUsd ?? capMicroUsd,
      spendMicroUsd: recAfter.spendMicroUsd ?? 0,
      turnsCompleted: 0,
      turnsSource: "in-box",
      rejectionStatus: null,
      providerCapRejected: false,
      terminationProvenance: null,
      exitStatus: null,
      killOrigin: null,
      revocationVerified: teardownOk && recAfter.keyHash !== undefined && recAfter.closedAt !== undefined,
      closedAt: recAfter.closedAt ?? null,
      verdict: "inconclusive",
      reason: finalReason,
      runBudgetCapMicros,
      residentCeilingMicros,
      keyHash: recAfter.keyHash ?? keyHash,
      timings: { mint_ms: mintMs, setup_ms: setupElapsedMs, workload_ms: 0, reprobe_ms: 0, capture_spend_ms: 0, teardown_ms: 0 },
      recordedAt: nowFn().toISOString(),
    };
    return {
      runId,
      verdict: "inconclusive",
      reason: finalReason,
      artifactPath: writeArtifactFile(evidenceDir, artifact),
      artifact,
    };
  };

  // ---- 3. Mint key ----
  let keyHash = "";
  let key = "";
  let mintMs = 0;
  {
    const started = Date.now();
    try {
      const minted = await mintRunKey(
        { keyApi: deps.keyApi, driver: deps.driver, store: deps.store, requestId, capMicroUsd, envFile },
        runId,
      );
      key = minted.key;
      keyHash = minted.hash;
      mintMs = Date.now() - started;
      log({
        requestId,
        operation: "demo.mint",
        agentId: null,
        timestamp: nowFn().toISOString(),
        runId,
        step: "mint",
        keyHashPrefix: keyHash.slice(0, 8),
        duration: mintMs,
        durationMs: mintMs,
        status: "ok",
        outcome: "ok",
        mint_ms: mintMs,
      });
    } catch (e) {
      mintMs = Date.now() - started;
      const err = e as { code?: string; message?: string; remediation?: string };
      log({
        requestId,
        operation: "demo.mint",
        agentId: null,
        timestamp: nowFn().toISOString(),
        runId,
        step: "mint",
        duration: mintMs,
        durationMs: mintMs,
        status: "error",
        error: { code: err.code ?? "mint_error", message: err.message ?? String(e) },
        remediation: err.remediation ?? null,
        outcome: "error",
        mint_ms: mintMs,
      });
      // Mint failed: nothing is spendable (no key material exists host-side),
      // but the box from step 1 is live — teardown destroys it and closes the
      // record rather than orphaning it to the reaper.
      return finishEarly("mint-failed", mintMs);
    }
  }

  // ---- 4. Deliver key ----
  {
    const started = Date.now();
    try {
      await deliverRunKey(
        { keyApi: deps.keyApi, driver: deps.driver, store: deps.store, requestId, envFile },
        vmName,
        key,
      );
    } catch (e) {
      // The key IS minted and live here — teardown's spend→revoke→verify
      // bracket is exactly DF2.3's delivery-failure compensation, so route
      // through it instead of rethrowing past a spendable key.
      log({
        requestId,
        operation: "demo.deliver",
        agentId: null,
        timestamp: nowFn().toISOString(),
        runId,
        step: "deliver",
        duration: Date.now() - started,
        durationMs: Date.now() - started,
        status: "error",
        error: { code: "deliver-failed", message: (e as Error).message },
        outcome: "error",
      });
      return finishEarly("deliver-failed", Date.now() - started);
    }
  }

  // ---- 5. Substrate-specific setup ----
  let setupMs = 0;
  if (isLive) {
    const started = Date.now();
    try {
      const exedevDriver = deps.driver as {
        fill?: (vm: string, opts: { runId: string; repoUrl: string; commitSha: string; workdir?: string }) => Promise<void>;
        setup?: (vm: string, opts: { runId: string; rosterPath: string; commitSha: string; workdir?: string; envFile?: string; assertTimeoutMs?: number; gateTimeoutMs?: number }) => Promise<{ ready: boolean }>;
      };
      if (!opts.repoUrl || !opts.commitSha || !opts.rosterPath) {
        // Missing live params — teardown and record an inconclusive artifact
        return finishEarly("setup-gate-not-ready", Date.now() - started);
      }
      // The image ships NO ~/.pi/agent/models.json (measured 2026-08-19) but
      // gate D asserts its cost table in-box: place the host's priced catalog
      // (public data, no secret) via DF2.1's generic file verb before the gate.
      // Shape: the D-check (and the pi line it mirrors) reads
      // {models:{<slug>:{cost:{input,output,cacheRead,cacheWrite}}}} — the
      // host's pi 0.55.0 writes {providers:{openrouter:{models:[...]}}} — so
      // transform here. pi 0.84.2 in the box ignores the file (its live cost
      // reporting is D's first half); the file is the declared cost table.
      const modelsJsonPath = process.env.QDS_MODELS_JSON ?? join(homedir(), ".pi", "agent", "models.json");
      try {
        const parsed = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as {
          providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
          models?: unknown;
        };
        const list = parsed.providers?.openrouter?.models;
        let content: string;
        if (Array.isArray(list)) {
          const byslug: Record<string, Record<string, unknown>> = {};
          for (const m of list) {
            if (typeof m.id === "string") byslug[m.id] = m;
          }
          content = JSON.stringify({ models: byslug });
        } else {
          // already the dict-by-slug shape — place verbatim
          content = JSON.stringify({ models: parsed.models ?? {} });
        }
        const files: BoxFile[] = [{ path: ".pi/agent/models.json", content }];
        await fillRun(deps.driver, vmName, files);
      } catch {
        return finishEarly("models-json-missing", Date.now() - started);
      }
      await exedevDriver.fill?.(vmName, { runId, repoUrl: opts.repoUrl, commitSha: opts.commitSha, workdir: LIVE_WORKDIR });
      // Warm pi's streaming path BEFORE the gate: on a FRESH box the first pi
      // calls nondeterministically stall (no request timeout in pi's client);
      // curl-based paths never stall, and a box that has run pi once stops
      // stalling (measured runs 9-12 + probe box, 2026-08-19). Loop until one
      // pi turn succeeds (≤4 × 120 s), then proceed.
      {
        const warmCmd =
          `set -a; . ${shQuote(envFile)}; set +a; timeout 120 pi -p --mode json --thinking off --provider ${shQuote("openrouter")} --model ${shQuote("deepseek/deepseek-v3.2")} 'Reply with the single word: warm' >/dev/null 2>&1; exit \$?`;
        const execTimedFn = (deps.driver as ProviderDriver & { execTimed?: (vm: string, argv: readonly string[], timeoutMs: number) => Promise<ExecResult> }).execTimed;
        for (let attempt = 1; attempt <= 4; attempt++) {
          const r = await (execTimedFn
            ? execTimedFn.call(deps.driver, vmName, ["sh", "-c", warmCmd], 150_000)
            : executeRun(deps.driver, vmName, ["true"]));
          if (r.exitCode === 0) break;
          log({
            requestId,
            operation: "demo.pi_warmup",
            agentId: null,
            timestamp: nowFn().toISOString(),
            runId,
            step: "pi_warmup",
            keyHashPrefix: keyHash.slice(0, 8),
            duration: 0,
            durationMs: 0,
            status: "ok",
            outcome: `stall-retry-${attempt}`,
          });
        }
      }
      // Cold-start pi (first invocation: extension init + catalog fetch) is
      // slow on a fresh box — measured >55 s. The gate's 60 s per-assertion
      // default SIGKILLs the C/D/E script mid-D (exit 137). Widen the knobs:
      // D's own internal budget still bounds the pi call itself.
      const gateOpts = {
        runId,
        rosterPath: opts.rosterPath,
        commitSha: opts.commitSha,
        workdir: LIVE_WORKDIR,
        envFile,
        assertTimeoutMs: 180_000,
        gateTimeoutMs: 600_000,
      } as const;
      let setupResult = await exedevDriver.setup?.(vmName, gateOpts);
      // One retry after a pause: a not-ready D from a stalled fresh-box pi
      // call is substrate flake, not an unreadied box — the gate itself stays
      // the gate (its evidence file is overwritten by the retry).
      if (!setupResult?.ready) {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        setupResult = await exedevDriver.setup?.(vmName, gateOpts);
      }
      setupMs = Date.now() - started;
      log({
        requestId,
        operation: "demo.setup",
        agentId: null,
        timestamp: nowFn().toISOString(),
        runId,
        step: "setup",
        keyHashPrefix: keyHash.slice(0, 8),
        duration: setupMs,
        durationMs: setupMs,
        status: "ok",
        outcome: setupResult?.ready ? "ok" : "not-ready",
        setup_ms: setupMs,
      });
      // Defensive: if !ready, teardown and inconclusive
      if (!setupResult?.ready) {
        return finishEarly("setup-gate-not-ready", Date.now() - started);
      }
    } catch (e) {
      setupMs = Date.now() - started;
      log({
        requestId,
        operation: "demo.setup",
        agentId: null,
        timestamp: nowFn().toISOString(),
        runId,
        step: "setup",
        keyHashPrefix: keyHash.slice(0, 8),
        duration: setupMs,
        durationMs: setupMs,
        status: "error",
        error: { code: "setup-error", message: (e as Error).message },
        outcome: "error",
        setup_ms: setupMs,
      });
      // Setup error — teardown and inconclusive
      return finishEarly("setup-failed", Date.now() - started);
    }
  } else {
    setupMs = 0; // fake: no-op
  }

  // ---- 6. Workload argv ----
  let argv: string[];
  let probeModel = DEFAULT_PROBE_MODEL;
  if (opts.workloadArgv) {
    argv = opts.workloadArgv;
  } else if (isLive) {
    // Load from fixture YAML. A malformed fixture here would strand a live key
    // on a live box — route through finishEarly, never rethrow past the mint.
    try {
      const fixturePath = opts.fixturePath ?? DEFAULT_FIXTURE_PATH;
      const fixtureContent = readFileSync(fixturePath, "utf8");
      const fixture = parse(fixtureContent) as { model?: unknown; provider?: unknown; prompt?: unknown; paddingBytes?: unknown };
      if (typeof fixture.model !== "string" || fixture.model === "" ||
          typeof fixture.prompt !== "string" || fixture.prompt === "") {
        return finishEarly("workload-fixture-invalid", setupMs);
      }
      probeModel = fixture.model;
      // The workload is a raw curl chat loop, not pi: pi's node streaming
      // client stalls nondeterministically on exe.dev boxes (runs 9-16), while
      // gate C's curl path never stalled once. Each turn = one chat POST with
      // fresh random padding (fixture `paddingBytes`, cache-busting, sized so
      // the cap arrives well inside the 900 s ceiling). The key rides curl's
      // stdin config (-K -), never argv (INV-CRED-3). The loop ends on the
      // provider's refusal (402/403 — MEASURED 2026-08-19: the key-limit
      // rejection is 403 "Key limit exceeded", lagging the crossing by ~4
      // requests); any other non-200 gets a short backoff and a retry. One
      // `turn_end` marker per completed paid turn — the artifact's only in-box
      // figure (INV-2: downgrade-only; classification still uses ONLY the
      // host-side re-probe).
      const rawPadding = Number(fixture.paddingBytes ?? 0);
      const paddingBytes = Number.isFinite(rawPadding) ? Math.max(0, rawPadding) : 0;
      argv = [
        "sh",
        "-c",
        `set -a; . ${shQuote(envFile)}; set +a; n=0; while :; do head -c ${paddingBytes} /dev/urandom | base64 | tr -d '\\n' > /tmp/df24-pad.txt; python3 -c 'import json,sys; json.dump({"model": sys.argv[1], "messages": [{"role": "user", "content": open(sys.argv[2]).read() + " " + sys.argv[3]}], "max_tokens": 16}, open(sys.argv[4], "w"))' ${shQuote(fixture.model)} /tmp/df24-pad.txt ${shQuote(fixture.prompt)} /tmp/df24-req.json; code=$(printf 'header = "Authorization: Bearer %s"\\nheader = "Content-Type: application/json"\\n' "\$OPENROUTER_API_KEY" | curl -sS -o /dev/null -w '%{http_code}' --max-time 60 -K - -X POST https://openrouter.ai/api/v1/chat/completions -d @/tmp/df24-req.json); case "\$code" in 200) n=\$((n+1)); echo turn_end;; 402|403) break;; *) sleep 2;; esac; done; echo "loop ended after \$n turns (HTTP \$code)"; exit 0`,
      ];
    } catch (e) {
      return finishEarly("workload-fixture-invalid", setupMs);
    }
  } else {
    argv = ["true"]; // fake substrate default
  }

  // ---- 7. Workload execution with wall-clock race ----
  let workloadMs = 0;
  let terminationProvenance: TerminationProvenance = null;
  let inBoxExit: InBoxExit = "success";
  let turnsCompleted = 0;

  {
    const started = Date.now();
    try {
      // The wall-clock ceiling must KILL the workload, not merely stop waiting
      // (INV-3). On the live substrate the budget goes into the exec itself
      // (`execTimed` → Bun.spawn timeout + SIGKILL), so the loser dies with the
      // race; the race timer is a +1s backstop for substrates without a
      // per-call timeout (fake). Bun reports a SIGKILLed child as exit 137
      // (128+9), never null — that is the kill signature below.
      const execWithBudget = (
        deps.driver as ProviderDriver & {
          execTimed?: (vm: string, argv: readonly string[], timeoutMs: number, stdin?: string) => Promise<ExecResult>;
        }
      ).execTimed;
      const workloadPromise = execWithBudget
        ? execWithBudget.call(deps.driver, vmName, argv, wallClockMs)
        : executeRun(deps.driver, vmName, argv);

      const wallClockMarker = new Promise<"wall-clock">((resolve) => {
        setTimeout(() => resolve("wall-clock"), wallClockMs + 1_000);
      });

      // Race between workload and wall-clock
      const raceResult = await Promise.race<{ type: "workload" | "wall-clock"; result?: ExecResult }>([
        workloadPromise.then(
          (res) => ({ type: "workload" as const, result: res }),
          (err: unknown) => {
            // Guard: if the wall-clock marker already won the race, the loser's
            // late rejection must not overwrite the recorded provenance.
            if (terminationProvenance === null) {
              terminationProvenance = "host-error";
              workloadMs = Date.now() - started;
            }
            throw err;
          },
        ),
        wallClockMarker.then(() => ({ type: "wall-clock" as const })),
      ]);

      if (raceResult.type === "wall-clock") {
        terminationProvenance = "wall-clock";
        inBoxExit = "success"; // no actual exit; classification keeps provenance
      } else {
        workloadMs = Date.now() - started;
        const res = raceResult.result!;
        if (res.exitCode === 137) {
          // SIGKILL from the exec budget = the wall-clock guard fired on the
          // substrate that supports per-call timeouts.
          terminationProvenance = "wall-clock";
          inBoxExit = "transient";
        } else {
          inBoxExit = res.exitCode === 0 ? "success" : "transient";
        }
        // Count turns (if any) — the artifact's one box-reported figure
        if (typeof res.stdout === "string") {
          turnsCompleted = (res.stdout.match(/turn_end/g) ?? []).length;
        }
      }
    } catch (e) {
      workloadMs = Date.now() - started;
      // host-error was set by the workload rejection handler above; anything
      // else that escapes the race is treated as a wall-clock bound.
      if (terminationProvenance === null) {
        terminationProvenance = "wall-clock";
      }
    }
    log({
      requestId,
      operation: "demo.workload",
      agentId: null,
      timestamp: nowFn().toISOString(),
      runId,
      step: "workload",
      keyHashPrefix: keyHash.slice(0, 8),
      duration: workloadMs,
      durationMs: workloadMs,
      status: "ok",
      outcome: "completed",
      workload_ms: workloadMs,
      terminationProvenance,
      inBoxExit,
    });
  }

  // ---- 8. Re-probe (BEFORE revoke, key still live) ----
  // Both classifier inputs here are HOST-produced (AC2/INV-2): the probe is a
  // host-side chat call with the retained run key — never the box's output.
  // Resolution order: explicit deps.probe, then the fake substrate's
  // chatComplete, then the production OpenRouter probe.
  // MEASURED (2026-08-19): the key-limit rejection is HTTP 403
  // {"error":{"message":"Key limit exceeded (total limit)..."}}, not the 402
  // "Insufficient credits" the account-level docs describe; enforcement lags
  // the crossing by ~4 requests / 15-30 s. Both signatures count.
  const isCapRejection = (status: number): boolean => status === 402 || status === 403;
  let providerCapRejected = false;
  let rejectionStatus: string | null = null;
  let reprobeMs = 0;
  {
    const started = Date.now();
    const fakeChat = (deps.keyApi as KeyApi & { chatComplete?: (key: string) => Promise<{ status: number; body: string }> }).chatComplete;
    const probeFn = deps.probe ?? (fakeChat ? (k: string) => fakeChat.call(deps.keyApi, k) : openRouterChatProbe);
    try {
      const probeResult = await probeFn(key, probeModel);
      reprobeMs = Date.now() - started;
      providerCapRejected = isCapRejection(probeResult.status);
      // Verbatim provider status + redacted body — the redaction input is the
      // run key itself (AC5), plus the key-management URL strip: the 403 body
      // embeds openrouter.ai/.../keys/<hash>; the hash stays published in the
      // structured keyHash field, the deep-link does not.
      rejectionStatus = `${probeResult.status}: ${redactKeyManagementUrls(redactWithKey(probeResult.body, key))}`;
    } catch (e) {
      reprobeMs = Date.now() - started;
      // A probe that cannot be issued fails closed: providerCapRejected stays
      // false and the classifier maps that to inconclusive (AC2). rejectionStatus
      // records WHY there is no provider signal — transport failure is not a
      // no-rejection answer. Message redacted with the run key AND the
      // key-management URL strip (AC5): a thrown error can embed the request
      // URL, whose /keys/<id> segment is a management deep-link.
      rejectionStatus = `probe-error: ${redactKeyManagementUrls(redactWithKey(String((e as Error).message ?? e), key))}`;
    }
    log({
      requestId,
      operation: "demo.reprobe",
      agentId: null,
      timestamp: nowFn().toISOString(),
      runId,
      step: "reprobe",
      keyHashPrefix: keyHash.slice(0, 8),
      duration: reprobeMs,
      durationMs: reprobeMs,
      status: "ok",
      outcome: "completed",
      reprobe_ms: reprobeMs,
      providerCapRejected,
    });
  }

  // ---- 9. Capture spend ----
  let spendMicroUsd = 0;
  let captureSpendMs = 0;
  {
    const started = Date.now();
    try {
      spendMicroUsd = await captureSpend(
        { keyApi: deps.keyApi, driver: deps.driver, store: deps.store, requestId },
        runId,
      );
      captureSpendMs = Date.now() - started;
    } catch (e) {
      captureSpendMs = Date.now() - started;
      // Spend capture failure — leave at 0
    }
    log({
      requestId,
      operation: "demo.capture_spend",
      agentId: null,
      timestamp: nowFn().toISOString(),
      runId,
      step: "capture_spend",
      keyHashPrefix: keyHash.slice(0, 8),
      duration: captureSpendMs,
      durationMs: captureSpendMs,
      status: "ok",
      outcome: "completed",
      capture_spend_ms: captureSpendMs,
      spendMicroUsd,
    });
  }

  // ---- 10. Classification ----
  // The cap the verdict rests on is the provider-ECHOED limit DF2.3 mint wrote
  // to the record (DF2.1 limitMicroUsd — DOD: "read from DF2.1's
  // limitMicroUsd"), never the operator's requested --cap: a provider that
  // clamps or rounds the limit would otherwise be judged against a cap that
  // was never enforced (INV-2).
  // `??` alone does not catch NaN/Infinity (a corrupted record) — a non-finite
  // cap makes every `>=` false and silently buries the verdict; fall back to
  // the operator's requested cap instead (fail-closed direction).
  const echoedCap = readRecordSafe().limitMicroUsd;
  const effectiveCapMicroUsd =
    echoedCap !== undefined && Number.isFinite(echoedCap) ? echoedCap : capMicroUsd;
  const classification = classifyRunExit({
    inBoxExit,
    usageMicroUsd: spendMicroUsd,
    capMicroUsd: effectiveCapMicroUsd,
    providerCapRejected,
    terminationProvenance,
  });

  // ---- 11. Teardown (ALWAYS) ----
  let teardownMs = 0;
  let teardownOk = true;
  {
    const started = Date.now();
    try {
      await teardownSandbox(
        { driver: deps.driver, store: deps.store, keyApi: deps.keyApi, requestId, gitCwd: process.cwd() },
        runId,
        {},
      );
      teardownMs = Date.now() - started;
    } catch (e) {
      teardownMs = Date.now() - started;
      teardownOk = false;
    }
    log({
      requestId,
      operation: "demo.teardown",
      agentId: null,
      timestamp: nowFn().toISOString(),
      runId,
      step: "teardown",
      keyHashPrefix: keyHash.slice(0, 8),
      duration: teardownMs,
      durationMs: teardownMs,
      status: teardownOk ? "ok" : "error",
      outcome: teardownOk ? "ok" : "error",
      teardown_ms: teardownMs,
    });
  }

  // ---- 12. Read final record for revocation verification ----
  const rec = readRecordSafe();
  const revocationVerified = teardownOk && rec.keyHash !== undefined && rec.closedAt !== undefined;
  const closedAt = rec.closedAt ?? null;

  // ---- 13. Verdict ----
  let verdict: "demonstrated" | "inconclusive";
  let reason: string | null = null;

  if (teardownOk && classification.exitStatus === "overflow" && classification.killOrigin === "provider-cap" && turnsCompleted >= 1) {
    verdict = "demonstrated";
    reason = null;
  } else {
    verdict = "inconclusive";
    // Reason priority: teardown-aborted > host-error > wall-clock-first > cap-below-first-turn > no-rejection
    if (!teardownOk) {
      reason = "teardown-aborted";
    } else if ((terminationProvenance as TerminationProvenance) === "host-error") {
      reason = "host-error";
    } else if ((terminationProvenance as TerminationProvenance) === "wall-clock") {
      reason = "wall-clock-first";
    } else if (turnsCompleted === 0 && classification.exitStatus === "overflow") {
      reason = "cap-below-first-turn";
    } else if (classification.exitStatus !== "overflow") {
      // Classification was NOT overflow (even if providerCapRejected true, spend < cap)
      reason = "no-rejection";
    } else if (!providerCapRejected) {
      reason = "no-rejection";
    } else {
      reason = "no-live-account"; // fallback
    }
  }

  // ---- 14. Build artifact ----
  const artifact: CapHitArtifact = {
    story: "df2-4",
    runId,
    requestId,
    substrate,
    capMicroUsd: effectiveCapMicroUsd,
    spendMicroUsd,
    turnsCompleted,
    turnsSource: "in-box",
    rejectionStatus,
    providerCapRejected,
    terminationProvenance,
    exitStatus: classification.exitStatus,
    killOrigin: classification.killOrigin,
    revocationVerified,
    closedAt,
    verdict,
    reason,
    runBudgetCapMicros,
    residentCeilingMicros,
    keyHash: rec.keyHash ?? keyHash,
    timings: {
      mint_ms: mintMs,
      setup_ms: setupMs,
      workload_ms: workloadMs,
      reprobe_ms: reprobeMs,
      capture_spend_ms: captureSpendMs,
      teardown_ms: teardownMs,
    },
    recordedAt: nowFn().toISOString(),
  };

  // ---- 15. Write artifact (atomic tmp + rename; dir 0700, file 0600) ----
  return {
    runId,
    verdict,
    reason,
    artifactPath: writeArtifactFile(evidenceDir, artifact),
    artifact,
  };
}

// ---------------------------------------------------------------------------
// CLI main()
// ---------------------------------------------------------------------------

const HELP = [
  "Usage: cap-hit-demo [options]",
  "",
  "  --cap <µ$>              Key cap in microdollars (default 50000 = $0.05)",
  "  --roster <path>         Roster path for live substrate setup",
  "  --driver <name>         Provider driver (default $QDS_PROVIDER_DRIVER or exedev)",
  "  --dir <path>            Records directory (default $QDS_RUNS_DIR)",
  "  --repo-url <url>        Repo URL for live substrate fill/setup",
  "  --sha <commit>          Commit SHA for live substrate fill/setup",
  "  --wall-clock-ms <ms>    Wall-clock ceiling in ms (default 900000)",
  "  --budget-cap <µ$>       Run budget cap (artifact field only, default 40000)",
  "  --ceiling <µ$>          Resident ceiling (artifact field only, default 30000)",
  "  --help                  Show this help",
  "",
  "Env: QDS_EVIDENCE_DIR (artifact dir), QDS_RUNS_DIR (records),",
  "     QDS_PROVIDER_DRIVER (default driver), OPENROUTER_PROVISIONING_KEY",
  "     (live mint), QDS_FAKE_KEY_API=1 (TEST-ONLY: use the in-repo FakeKeyApi",
  "     substrate instead of the real provider; requires tests/ to exist).",
];

const VALUE_FLAGS = [
  "--cap",
  "--roster",
  "--driver",
  "--dir",
  "--repo-url",
  "--sha",
  "--wall-clock-ms",
  "--budget-cap",
  "--ceiling",
] as const;

interface ParsedArgs {
  capMicroUsd?: string;
  rosterPath?: string;
  driver?: string;
  dir?: string;
  repoUrl?: string;
  commitSha?: string;
  wallClockMs?: string;
  runBudgetCapMicros?: string;
  residentCeilingMicros?: string;
}

async function parseArgs(argv: readonly string[]): Promise<ParsedArgs> {
  const out: ParsedArgs = {};
  const { tokenizeArgs, parseValueFlags } = await import("./lib/cli-args.ts");
  const { flagTokens } = tokenizeArgs(argv, { valueFlags: VALUE_FLAGS });
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      if (flag === "--cap") out.capMicroUsd = value;
      else if (flag === "--roster") out.rosterPath = value;
      else if (flag === "--driver") out.driver = value;
      else if (flag === "--dir") out.dir = value;
      else if (flag === "--repo-url") out.repoUrl = value;
      else if (flag === "--sha") out.commitSha = value;
      else if (flag === "--wall-clock-ms") out.wallClockMs = value;
      else if (flag === "--budget-cap") out.runBudgetCapMicros = value;
      else if (flag === "--ceiling") out.residentCeilingMicros = value;
    },
    help: HELP,
  });
  return out;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = await parseArgs(argv);
  const requestId = newRequestId();

  const driverName = args.driver ?? process.env.QDS_PROVIDER_DRIVER ?? "exedev";
  const driver = resolveDriver(driverName, { requestId });

  const store = new RunRecordStore({
    ...(args.dir === undefined ? {} : { dir: args.dir }),
    requestId,
  });

  // Resolve keyApi
  let keyApi: KeyApi;
  if (process.env.QDS_FAKE_KEY_API === "1") {
    // TEST-ONLY seam (default off; see HELP): swap the provider client for the
    // in-repo FakeKeyApi substrate so the script can be exercised end-to-end
    // without a live OpenRouter account. Requires tests/ to be present — a
    // deployment without tests/ must not set this flag.
    const { FakeKeyApi } = await import("../tests/providers/fixtures/fake-key-api.ts");
    keyApi = new FakeKeyApi() as KeyApi;
  } else {
    keyApi = openRouterKeyApi();
  }

  const evidenceDir = process.env.QDS_EVIDENCE_DIR ?? ".sandbox/evidence";
  // Fake driver uses box-relative paths; live substrate uses absolute contract
  // envFile is substrate-resolved inside runCapHitDemo (live: /home/exedev/.env).

  // Numeric flags fail closed: a NaN wall-clock would fire ~immediately and a
  // NaN budget/ceiling would render as null in the artifact.
  const positiveInt = (raw: string | undefined, flag: string): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      const err = new Error(`--${flag} must be a positive integer, got '${raw}'`) as Error & { code: string; remediation: string };
      err.code = "invalid-value";
      err.remediation = `re-run with a positive integer for --${flag}`;
      throw err;
    }
    return n;
  };

  const result = await runCapHitDemo(
    { driver, keyApi, store, requestId, evidenceDir },
    {
      capMicroUsd: positiveInt(args.capMicroUsd, "cap"),
      wallClockMs: positiveInt(args.wallClockMs, "wall-clock-ms"),
      runBudgetCapMicros: positiveInt(args.runBudgetCapMicros, "budget-cap"),
      residentCeilingMicros: positiveInt(args.residentCeilingMicros, "ceiling"),
      repoUrl: args.repoUrl,
      commitSha: args.commitSha,
      rosterPath: args.rosterPath,
    },
  );

  // Single-line JSON: stdout's last line is machine-parsed (tests/CI); humans
  // read the stderr step log.
  const output = { runId: result.runId, verdict: result.verdict, reason: result.reason, artifactPath: result.artifactPath, artifact: result.artifact };
  writeSync(1, `${JSON.stringify(output)}\n`);

  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    const err = e as { code?: string; message?: string; remediation?: string };
    writeSync(2, `!! ${err.code ?? "error"}: ${err.message ?? String(e)}\n`);
    if (err.remediation !== undefined) writeSync(2, `next: ${err.remediation}\n`);
    process.exit(1);
  }
}
