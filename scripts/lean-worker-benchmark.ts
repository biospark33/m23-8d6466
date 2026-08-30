#!/usr/bin/env bun
/**
 * DF1.9 — Lean Worker Profile benchmark.
 *
 * Runs the SAME manifest twice: a control arm (no lean flags) and a lean arm
 * (`--no-extensions --no-skills`), ≥3 iterations each, interleaved (control,
 * lean, control, lean, …) so the two arms see the same cache regime rather
 * than one arm inheriting a cache warmed entirely by the other. It parses
 * FIRST-TURN input tokens per worker out of each arm's captured NDJSON and
 * writes the measured ratio to `<artifactsDir>/lean-worker-benchmark.json`,
 * where artifactsDir is `.sandbox/bench/` unless $QDS_BENCH_ARTIFACTS_DIR says
 * otherwise (F100 — it used to default into the tracked-evidence `artifacts/`).
 *
 * **The deliverable is the measurement.** The 5-6× payoff is the hypothesis
 * under test — its own source (gates report §3.3) marks the elimination figure
 * "untested"; only the 37,279 tok/turn overhead is measured. This harness
 * records `supported`, `refuted` or `inconclusive` with equal willingness, and
 * never reports a saving it did not compute (INV-5).
 *
 * Measures FIRST-TURN input tokens, not run totals: the cold prompt — system
 * prompt plus discovered extensions and skills plus the task — is exactly what
 * these flags remove. First-turn is the correct instrument for the overhead
 * term regardless of what run totals do.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { RAW_CAPTURE_TRUNCATION_MARKER } from "../cli-anything/scripts/team-lead-driver.ts";
import { writeArtifactAtomic } from "../cli-anything/src/team-events.ts";
import type { ExitStatus } from "../cli-anything/src/types.ts";

/** `supported` at this ratio or better. The hypothesis, not a target. */
export const SUPPORTED_RATIO = 5.0;
/** Minimum iterations per arm for the result to count (AC1). */
export const MIN_RUNS_PER_ARM = 3;
/** Hard cap on iterations per arm — bounds spend. */
export const MAX_RUNS_PER_ARM = 5;

export type ArmName = "control" | "lean";

export interface RunObservation {
  iteration: number;
  agentId: string;
  model: string;
  /** Input tokens on the worker's FIRST usage-bearing turn. */
  firstTurnInputTokens: number;
  usageBearingTurns: number;
  /** Whole-iteration wall clock — the arms run one harness per iteration, so
   * every worker in an iteration shares it. Not a per-worker timing. */
  durationMs: number;
  /** The run's CC-1 exitStatus, shared by every worker in the iteration. */
  exitStatus: ExitStatus;
  /** The capture hit the 8 MiB cap, so the first-turn reading is unreliable. */
  captureTruncated?: boolean;
}

export interface ArmResult {
  arm: ArmName;
  /**
   * Iterations that actually produced at least one observation — NOT the
   * number attempted. An arm whose every iteration crashed reports n=0 and
   * fails the >=3 gate, instead of reporting the loop bound and passing it
   * vacuously.
   */
  n: number;
  startedAt: string;
  durationMs: number;
  runs: RunObservation[];
}

export interface BenchError {
  code: string;
  message: string;
  arm?: ArmName;
  agentId?: string;
}

/**
 * First-turn input tokens for the FIRST usage-bearing assistant turn in one
 * captured pi NDJSON stream, or null if the stream has none.
 *
 * Deliberately independent of DF2.7's session accumulator: this reads the
 * FIRST turn, that one sums ALL of them. Both read `message_end` only, because
 * pi repeats the same usage on message_start/message_update/turn_end and
 * replays it in agent_end.
 */
export function firstTurnInputTokens(
  ndjson: string,
): { inputTokens: number; usageBearingTurns: number } | null {
  let first: number | null = null;
  let usageBearingTurns = 0;
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const e = event as Record<string, unknown>;
    if (e.type !== "message_end") continue;
    // `?? e.assistantMessage` mirrors harvestPiStream. Without it the two
    // parsers disagree over the same stream: DF2.7's cost accounting would
    // keep working while this reads zero usage-bearing turns for every worker
    // and reports `inconclusive` forever, with an error message pointing at
    // spawn failure rather than at the parser mismatch.
    const message = (e.message ?? e.assistantMessage) as
      | Record<string, unknown>
      | undefined;
    const role = message?.role;
    if (typeof role === "string" && role !== "assistant") continue;
    const usage = (message?.usage ?? e.usage) as Record<string, unknown> | null | undefined;
    if (usage == null || typeof usage !== "object" || Array.isArray(usage)) continue;
    const raw = usage.input ?? usage.inputTokens;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) continue;
    usageBearingTurns++;
    if (first === null) first = raw;
  }
  if (first === null) return null;
  return { inputTokens: first, usageBearingTurns };
}

export interface PerWorker {
  agentId: string;
  models: string[];
  controlMeanFirstTurnInputTokens: number;
  leanMeanFirstTurnInputTokens: number;
  /** Absolute tokens removed. Present whenever both arms are computable. */
  deltaTokens: number;
  /** Omitted entirely when the lean mean is 0 — never Infinity, never null. */
  ratio?: number;
}

export interface Verdict {
  requestId: string;
  recordedAt: string;
  manifest: string;
  hypothesisVerdict: "supported" | "refuted" | "inconclusive";
  /** Omitted entirely when inconclusive (AC1, INV-5). */
  ratio?: number;
  deltaTokens?: number;
  perWorker: PerWorker[];
  arms: Record<ArmName, { n: number; startedAt: string; durationMs: number; runs: RunObservation[] }>;
  control_arm_ms: number;
  lean_arm_ms: number;
  durationMs: number;
  errors: BenchError[];
  notes: string[];
  /**
   * The actual arm/iteration execution order with per-iteration timestamps, so
   * a reader can verify interleaving from the artifact rather than trusting a
   * prose note (Infra Prerequisites: "arm order and start timestamps recorded
   * in the artifact").
   */
  iterationOrder?: Array<{ iteration: number; arm: ArmName; startedAt: string }>;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Aggregate both arms into the verdict artifact.
 *
 * Fail-closed (AC4, INV-5). `inconclusive` with NO `ratio` field whenever:
 *   - either arm has fewer than MIN_RUNS_PER_ARM runs;
 *   - any worker produced zero usage-bearing turns in either arm;
 *   - a worker is missing from one arm;
 *   - the lean mean is exactly 0 (zero denominator — same rule as an arm that
 *     cannot be computed at all, never a division yielding Infinity).
 * A missing measurement is never reported as a saving, and the surviving arm
 * is never averaged on its own.
 */
export function aggregate(
  requestId: string,
  manifest: string,
  control: ArmResult,
  lean: ArmResult,
  errors: BenchError[],
  notes: string[] = [],
  /**
   * The agents the measurement is ABOUT, from the manifest — not from whatever
   * happened to survive. Deriving the set from the observed runs makes a
   * worker that vanished (spawn failure, empty stream, timeout) disappear from
   * the report instead of failing it, which is precisely the AC4 fail-open.
   */
  expectedWorkerIds?: string[],
): Verdict {
  const base = {
    requestId,
    recordedAt: new Date().toISOString(),
    manifest,
    arms: {
      control: {
        n: control.n,
        startedAt: control.startedAt,
        durationMs: control.durationMs,
        runs: control.runs,
      },
      lean: {
        n: lean.n,
        startedAt: lean.startedAt,
        durationMs: lean.durationMs,
        runs: lean.runs,
      },
    },
    control_arm_ms: control.durationMs,
    lean_arm_ms: lean.durationMs,
    durationMs: control.durationMs + lean.durationMs,
    notes,
  };
  const fail = (extra: BenchError[]): Verdict => ({
    ...base,
    hypothesisVerdict: "inconclusive",
    perWorker: [],
    errors: [...errors, ...extra],
  });

  for (const a of [control, lean] as const) {
    if (a.n < MIN_RUNS_PER_ARM) {
      return fail([
        {
          code: "arm_underpowered",
          arm: a.arm,
          message: `${a.arm} arm has n=${a.n}, need ${MIN_RUNS_PER_ARM}`,
        },
      ]);
    }
  }

  const agentIds = (
    expectedWorkerIds !== undefined && expectedWorkerIds.length > 0
      ? [...new Set(expectedWorkerIds)]
      : [...new Set([...control.runs, ...lean.runs].map((r) => r.agentId))]
  ).sort();
  if (agentIds.length === 0) {
    return fail([
      { code: "no_workers", arm: "control", message: "no worker runs were observed" },
    ]);
  }

  const perWorker: PerWorker[] = [];
  const problems: BenchError[] = [];
  for (const agentId of agentIds) {
    const c = control.runs.filter((r) => r.agentId === agentId);
    const l = lean.runs.filter((r) => r.agentId === agentId);
    // Checked for BOTH arms, and per worker: `n` counts iterations attempted,
    // so an arm can report n=3 while a given worker produced one observation.
    // The ≥3 requirement is about that worker's measurement, not the loop.
    let missing = false;
    for (const [armName, runs] of [
      ["control", c],
      ["lean", l],
    ] as const) {
      if (runs.length === 0) {
        problems.push({
          code: "worker_missing_from_arm",
          arm: armName,
          agentId,
          message: `worker ${agentId} produced no runs in the ${armName} arm`,
        });
        missing = true;
      } else if (runs.length < MIN_RUNS_PER_ARM) {
        problems.push({
          code: "worker_underpowered",
          arm: armName,
          agentId,
          message: `worker ${agentId} produced ${runs.length} runs in the ${armName} arm, need ${MIN_RUNS_PER_ARM}`,
        });
        missing = true;
      }
    }
    if (missing) continue;
    const dead = [...c, ...l].find(
      (r) => r.usageBearingTurns === 0 || r.captureTruncated === true,
    );
    if (dead !== undefined) {
      problems.push({
        code: dead.captureTruncated === true ? "capture_truncated" : "zero_usage_bearing_turns",
        arm: c.includes(dead) ? "control" : "lean",
        agentId,
        message:
          dead.captureTruncated === true
            ? `worker ${agentId} capture was truncated at the 8 MiB cap (iteration ${dead.iteration}); the first-turn reading cannot be trusted`
            : `worker ${agentId} produced zero usage-bearing turns (iteration ${dead.iteration})`,
      });
      continue;
    }
    const controlMean = mean(c.map((r) => r.firstTurnInputTokens));
    const leanMean = mean(l.map((r) => r.firstTurnInputTokens));
    const entry: PerWorker = {
      agentId,
      models: [...new Set([...c, ...l].map((r) => r.model))],
      controlMeanFirstTurnInputTokens: controlMean,
      leanMeanFirstTurnInputTokens: leanMean,
      deltaTokens: controlMean - leanMean,
    };
    // Zero denominator is inconclusive, not Infinity and not a null ratio.
    // A zero CONTROL mean is equally broken: it passes every other guard and
    // would otherwise yield ratio 0, a negative deltaTokens and a confident
    // "refuted" — a broken instrument reported as a measured refutation of the
    // very hypothesis under test.
    if (leanMean > 0 && controlMean > 0) entry.ratio = controlMean / leanMean;
    if (leanMean <= 0)
      problems.push({
        code: "zero_lean_mean",
        arm: "lean",
        agentId,
        message: `worker ${agentId} lean-arm mean first-turn input tokens is 0`,
      });
    if (controlMean <= 0)
      problems.push({
        code: "zero_control_mean",
        arm: "control",
        agentId,
        message: `worker ${agentId} control-arm mean first-turn input tokens is 0`,
      });
    perWorker.push(entry);
  }

  // NOTE: on an inconclusive run a SURVIVING worker keeps its own per-worker
  // `ratio` — it was genuinely computed and is useful for diagnosis. Only the
  // top-level `ratio` is withheld, which is what AC1 governs. A reader
  // grepping the artifact for "ratio" must check `hypothesisVerdict` first.
  if (problems.length > 0) return { ...fail(problems), perWorker };
  // A caller-reported error is a failed measurement even if the arithmetic
  // worked; `aggregate` is exported, so its fail-closed contract must not
  // depend on `main` happening to pass an empty array.
  if (errors.length > 0) return { ...fail([]), perWorker };

  const ratios = perWorker.map((w) => w.ratio).filter((r): r is number => r !== undefined);
  if (ratios.length !== perWorker.length || ratios.length === 0) {
    return { ...fail([{ code: "ratio_incomputable", message: "not every worker yielded a ratio" }]), perWorker };
  }
  const ratio = mean(ratios);
  return {
    ...base,
    hypothesisVerdict: ratio >= SUPPORTED_RATIO ? "supported" : "refuted",
    ratio,
    deltaTokens: perWorker.reduce((a, w) => a + w.deltaTokens, 0),
    perWorker,
    errors,
  };
}

/**
 * Preflight (INV-5): both flags present and the pinned pi major/minor, or exit
 * 2 BEFORE any spend. F13 pins pi libs 0.55.x; a different pi is a different
 * measurement, so it fails closed rather than quietly producing a number
 * against an untested binary. `QDS_BENCH_ALLOW_PI_VERSION=1` runs anyway and
 * records the actual version in the artifact.
 */
export function preflight(
  version: string,
  help: string,
  env: Record<string, string | undefined>,
): { ok: true; notes: string[] } | { ok: false; reason: string } {
  const notes: string[] = [];
  for (const flag of ["--no-extensions", "--no-skills"]) {
    if (!help.includes(flag)) {
      return { ok: false, reason: `pi does not expose ${flag} (found neither in --help)` };
    }
  }
  if (!version.startsWith("0.55.")) {
    if (env.QDS_BENCH_ALLOW_PI_VERSION !== "1") {
      return {
        ok: false,
        reason: `pi is ${version}, expected 0.55.x (F13 pin). Set QDS_BENCH_ALLOW_PI_VERSION=1 to measure against this version anyway.`,
      };
    }
    notes.push(
      `pi version ${version} is not the F13-pinned 0.55.x; measured under QDS_BENCH_ALLOW_PI_VERSION=1.`,
    );
  }
  if (env.OPENROUTER_API_KEY === undefined || env.OPENROUTER_API_KEY === "") {
    return {
      ok: false,
      reason:
        "OPENROUTER_API_KEY is unset; the benchmark roster is OpenRouter-only and refuses to run rather than produce a one-armed comparison. Nothing was spent.",
    };
  }
  return { ok: true, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Materialise the arm's manifest: the SAME manifest, with `lean` set on every
 * worker for the lean arm and removed for the control arm.
 *
 * Done by rewriting the manifest rather than by adding a driver-side env
 * override, so the only difference between the arms is the manifest key the
 * story actually ships — no second configuration path that production never
 * uses. The control arm is byte-identical to a manifest with no lean key,
 * which is what AC3 pins.
 */
export function manifestForArm(sourceYaml: string, arm: ArmName): string {
  const doc = parseYaml(sourceYaml) as {
    team?: { workers?: Array<Record<string, unknown>> };
  };
  if (doc.team?.workers !== undefined) {
    // Rebuild without the key rather than assigning undefined: yaml would
    // serialise that as `lean: null`, and TeamRoleSchema's z.boolean()
    // rejects null — the control arm would fail validation before spawning.
    doc.team.workers = doc.team.workers.map((w) => {
      const { lean: _dropped, ...rest } = w;
      return arm === "lean" ? { ...rest, lean: true } : rest;
    });
  }
  return stringifyYaml(doc);
}

/** The agentIds `lean` is applied to — the workers, never the lead. */
export function workerAgentIds(sourceYaml: string): string[] {
  return Object.keys(workerModels(sourceYaml));
}

/** agentId -> model slug, from the manifest (AC1 records the slugs used). */
export function workerModels(sourceYaml: string): Record<string, string> {
  const doc = parseYaml(sourceYaml) as {
    team?: { workers?: Array<{ agentId?: unknown; model?: unknown }> };
  };
  const out: Record<string, string> = {};
  for (const w of doc.team?.workers ?? []) {
    if (typeof w.agentId === "string" && w.agentId.length > 0) {
      out[w.agentId] = typeof w.model === "string" ? w.model : "(unknown)";
    }
  }
  return out;
}

/** Per-iteration wall-clock bound on the harness subprocess (AC4: never hang). */
export const HARNESS_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The run's real `exitStatus` from the merged JSON the runner prints, falling
 * back to a conservative classification when there is no parseable output.
 */
export function mergedExitStatus(
  stdout: string | null,
  status: number | null,
  error?: Error,
): ExitStatus {
  if (error !== undefined) return "transient";
  if (stdout !== null && stdout !== "") {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (typeof parsed === "object" && parsed !== null) {
        const s = (parsed as Record<string, unknown>).exitStatus;
        if (
          s === "success" ||
          s === "transient" ||
          s === "overflow" ||
          s === "logic" ||
          s === "lead_failure"
        ) {
          return s;
        }
      }
    } catch {
      // Not JSON — fall through.
    }
  }
  // status null means killed (our timeout, or a signal): not a logic error.
  return status === 0 ? "success" : status === null ? "transient" : "logic";
}

/** One harness invocation for one arm; returns that iteration's observations. */
function runIteration(
  arm: ArmName,
  armManifest: string,
  iteration: number,
  requestId: string,
  models: Record<string, string>,
): RunObservation[] {
  const rawDir = mkdtempSync(join(tmpdir(), `lean-bench-${arm}-`));
  const runStart = Date.now();
  const observations: RunObservation[] = [];
  try {
    const proc = spawnSync(
      "bun",
      ["cli-anything/src/index.ts", "run", "--manifest", armManifest],
      {
        encoding: "utf8",
        // AC4 says the harness never hangs. The inner runner's wallClockCapMs
        // is one layer down and does not bind if the runner wedges before
        // arming its timers, or if `bun` itself hangs.
        timeout: HARNESS_RUN_TIMEOUT_MS,
        env: {
          ...process.env,
          QDS_TEAM_RUNNER: "local",
          QDS_TEAM_RAW_WORKER_DIR: rawDir,
          QDS_BENCH_REQUEST_ID: requestId,
        },
      },
    );
    const durationMs = Date.now() - runStart;
    // The 5-value CC-1 enum, read from the runner's own merged output rather
    // than collapsed from the process status — a run killed by the wall-clock
    // cap is `overflow`, not `logic`.
    const exitStatus = mergedExitStatus(proc.stdout, proc.status, proc.error);
    for (const file of readdirSync(rawDir)) {
      if (!file.endsWith(".ndjson")) continue;
      const agentId = file.slice(0, -".ndjson".length);
      // The driver captures the LEAD's stream too, but `lean` is a per-worker
      // flag and the lead is never leaned — averaging its unchanged 1.0 ratio
      // into the result silently drags the measurement toward "refuted" while
      // the lever worked perfectly on every worker. Measure only the agents
      // the flag was applied to.
      // hasOwn, not `in`: `"toString" in models` is true via the prototype
      // chain, so a capture file named for an Object.prototype key would pass.
      if (!Object.hasOwn(models, agentId)) continue;
      const body = readFileSync(join(rawDir, file), "utf8");
      const parsed = firstTurnInputTokens(body);
      const observation: RunObservation = {
        iteration,
        agentId,
        model: models[agentId] ?? "(unknown)",
        firstTurnInputTokens: parsed?.inputTokens ?? 0,
        usageBearingTurns: parsed?.usageBearingTurns ?? 0,
        durationMs,
        exitStatus,
      };
      // A capture that hit the 8 MiB cap may have lost the very turn we read
      // — treat it as an unusable measurement, not a number (INV-5).
      if (body.includes(RAW_CAPTURE_TRUNCATION_MARKER)) observation.captureTruncated = true;
      observations.push(observation);
      console.error(`lean-bench: ${JSON.stringify({ requestId, ...observation, arm })}`);
    }
    if (observations.length === 0) {
      console.error(
        `lean-bench: ${JSON.stringify({ requestId, arm, iteration, exitStatus, durationMs, error: { code: "no_capture", message: "no worker capture files were produced" } })}`,
      );
    }
  } finally {
    rmSync(rawDir, { recursive: true, force: true });
  }
  return observations;
}

async function main(): Promise<never> {
  const manifestPath =
    process.argv[2] ?? join("cli-anything", "manifests", "lean-benchmark.yaml");
  const requestId = `lean-bench-${Date.now().toString(36)}`;
  // F100: the default is `.sandbox/bench/` (already gitignored), NOT the repo's
  // `artifacts/` sink — that directory holds TRACKED evidence
  // (artifacts/df1-3-e2e-event-stream.json), so a benchmark writing there put
  // scratch one `git add -A` away from being committed as evidence.
  // $QDS_BENCH_ARTIFACTS_DIR still overrides, for tests and for operators who
  // want the output somewhere specific.
  const artifactsDir =
    process.env.QDS_BENCH_ARTIFACTS_DIR ?? join(process.cwd(), ".sandbox", "bench");

  const version = (
    spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout ?? ""
  ).trim();
  const help = spawnSync("pi", ["--help"], { encoding: "utf8" }).stdout ?? "";
  const pre = preflight(version, help, process.env);
  if (!pre.ok) {
    // Exit 2 BEFORE any spend. No artifact: a preflight failure is not a
    // measurement, and writing one would invite it being read as a result.
    console.error(`lean-bench: preflight failed — ${pre.reason}`);
    console.error(`lean-bench: ${JSON.stringify({ requestId, piVersion: version })}`);
    process.exit(2);
  }

  // Bounded parse (same discipline as the driver's PI_COMS_TIMEOUT_MS guard):
  // a bare Number() turns QDS_BENCH_RUNS=abc into NaN, and NaN survives
  // Math.min/max — the loop then never runs AND `NaN < MIN_RUNS_PER_ARM` is
  // false, so the underpowered guard does not trip either.
  const runsRaw = Number(process.env.QDS_BENCH_RUNS ?? MIN_RUNS_PER_ARM);
  const iterations = Number.isInteger(runsRaw)
    ? Math.min(Math.max(runsRaw, MIN_RUNS_PER_ARM), MAX_RUNS_PER_ARM)
    : MIN_RUNS_PER_ARM;

  const source = readFileSync(manifestPath, "utf8");
  const models = workerModels(source);
  const workerIds = Object.keys(models);
  if (workerIds.length === 0) {
    console.error("lean-bench: manifest declares no workers; nothing to measure");
    process.exit(2);
  }

  // One temp manifest per arm, prepared up front.
  const armDir = mkdtempSync(join(tmpdir(), "lean-bench-manifests-"));
  const armManifests: Record<ArmName, string> = {
    control: join(armDir, "control.yaml"),
    lean: join(armDir, "lean.yaml"),
  };
  const arms: Record<ArmName, ArmResult> = {
    control: {
      arm: "control",
      n: 0,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      runs: [],
    },
    lean: {
      arm: "lean",
      n: 0,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      runs: [],
    },
  };
  const harnessErrors: BenchError[] = [];
  const iterationLog: Array<{ iteration: number; arm: ArmName; startedAt: string }> = [];
  try {
    for (const arm of ["control", "lean"] as const) {
      writeFileSync(armManifests[arm], manifestForArm(source, arm), "utf8");
    }
    // INTERLEAVED (C,L,C,L,…), not arm-after-arm: running one arm to
    // completion first gives the second arm every provider-side prompt-cache
    // effect the first one warmed, and that lands entirely on the lever's
    // side of the comparison. Interleaving costs nothing and removes the
    // confound the Infra Prerequisites row asks for ("warm-cache parity").
    for (let i = 1; i <= iterations; i++) {
      for (const arm of ["control", "lean"] as const) {
        const t0 = Date.now();
        iterationLog.push({ iteration: i, arm, startedAt: new Date().toISOString() });
        try {
          const observations = runIteration(arm, armManifests[arm], i, requestId, models);
          arms[arm].runs.push(...observations);
          // n counts iterations that actually yielded an observation.
          if (observations.length > 0) arms[arm].n++;
        } catch (err) {
          // Real provider spend has already happened by this point; losing the
          // artifact would throw away every observation bought so far. Record
          // and keep going — aggregate fails closed on the error anyway.
          harnessErrors.push({
            code: "harness_error",
            arm,
            message: `iteration ${i} threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        arms[arm].durationMs += Date.now() - t0;
      }
    }
  } finally {
    rmSync(armDir, { recursive: true, force: true });
  }

  const verdict = aggregate(
    requestId,
    manifestPath,
    arms.control,
    arms.lean,
    harnessErrors,
    [
      `pi ${version}`,
      ...pre.notes,
      `Arms are INTERLEAVED, actual order: ${iterationLog.map((e) => `${e.arm}#${e.iteration}`).join(", ")} — neither arm inherits the other's warm prompt cache.`,
      "n counts iterations that produced at least one observation, not iterations attempted.",
      "ratio = control mean first-turn input tokens / lean mean, per worker then averaged; deltaTokens is the absolute tokens removed. A large task prompt inflates BOTH arms' first-turn totals and can push the ratio under 5 while the lever worked exactly as claimed — read deltaTokens beside the verdict, not the ratio alone.",
    ],
    workerIds,
  );
  verdict.iterationOrder = iterationLog;

  mkdirSync(artifactsDir, { recursive: true });
  writeArtifactAtomic(artifactsDir, "lean-worker-benchmark", verdict);
  console.error(
    `lean-bench: ${verdict.hypothesisVerdict}${verdict.ratio !== undefined ? ` (ratio ${verdict.ratio.toFixed(2)}, delta ${verdict.deltaTokens} tok)` : ""} -> ${join(artifactsDir, "lean-worker-benchmark.json")}`,
  );
  // INV-5: a run that could not measure both arms exits non-zero (AC4).
  process.exit(verdict.hypothesisVerdict === "inconclusive" ? 1 : 0);
}

if (import.meta.main) await main();
