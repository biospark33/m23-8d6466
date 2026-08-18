import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ComsLogCollector } from "./coms-log.ts";
import {
  cleanEnv,
  diag,
  logEnvKeys,
  MAX_LOGGED_ENV_KEYS,
  mergeEnv,
  sanitizeLogKey,
} from "./env.ts";
import { parseManifestFile, parseTeamManifestFile } from "./manifest.ts";
import {
  buildMergedOutput,
  createPending,
  redactDeep,
  unionChangedFiles,
  validateWorkerOutput,
} from "./merger.ts";
import {
  startRssWatchdog,
  type WatchdogHandle,
  WATCHDOG_GRACE_MS,
} from "./watchdog.ts";
import {
  capExcerpt,
  capProbe,
  MAX_STDOUT_EXCERPT,
  redactBoundaryPrefix,
  redactSecrets,
} from "./redact.ts";
import {
  buildTeamSpawn,
  parseTeamEventLine,
  splitRoleModel,
  writeArtifactAtomic,
  type TeamEvent,
} from "./team-events.ts";
import type {
  ExitClass,
  HarnessResult,
  Manifest,
  MergedError,
  MergedOutput,
  Waiver,
  WorkerOutput,
} from "./types.ts";

// Public surface is unchanged (#62): these moved to sibling modules and are
// re-exported so every existing `from "./runner.ts"` import keeps working.
export {
  cleanEnv,
  type EnvMap,
  logEnvKeys,
  mergeEnv,
} from "./env.ts";
export {
  capExcerpt,
  capProbe,
  MAX_PROBE_RESULT_LEN,
  MAX_STDOUT_EXCERPT,
  redactBoundaryPrefix,
  redactSecrets,
} from "./redact.ts";
export {
  buildTeamSpawn,
  parseTeamEventLine,
  splitRoleModel,
  type TeamEvent,
  writeArtifactAtomic,
} from "./team-events.ts";

/** Default wall-clock timeout for a harness invocation: 10 minutes. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const PROBE_KEY = "QDS_PROBE=";

/**
 * Watchdog grace after a kill before force-settling (grandchild stdout-hold).
 * Single source: watchdog.ts (re-exported so existing `from "./runner.ts"`
 * imports keep working).
 */
export { WATCHDOG_GRACE_MS };

/**
 * Kill a whole child tree: process group on POSIX (SIGKILL, not
 * SIGTERM→SIGKILL), `taskkill /T /F` on win32, direct-child fallback on
 * failure. Extracted from runManifest (P0.1-hardened contract, CC-R8-8) so
 * the P0.3 team path reuses the same primitive (Wave 1 Reuse Mandate).
 */
export function killTree(child: ChildProcess | null): void {
  const c = child;
  if (c === null) return;
  if (c.pid === undefined) {
    try {
      c.kill("SIGKILL");
    } catch {
      // Process already gone.
    }
    return;
  }
  if (process.platform === "win32") {
    // Tree kill on win32; if it fails, fall back to killing the direct child.
    execFile("taskkill", ["/pid", String(c.pid), "/T", "/F"], (err) => {
      if (err) {
        try {
          c.kill("SIGKILL");
        } catch {
          // Process already gone.
        }
      }
    });
  } else {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      // Process group already gone; fall back to the direct child.
      try {
        c.kill("SIGKILL");
      } catch {
        // Process already gone.
      }
    }
  }
}

/** Build the `warren run <command> <args...>` invocation for a manifest. */
export function buildSpawn(manifest: Manifest): { file: string; argv: string[] } {
  return {
    file: "warren",
    argv: ["run", manifest.command, ...(manifest.args ?? [])],
  };
}

/**
 * Classify the subprocess exit given the timeout flag and the raw close
 * event values. Extracted so the race-prone classification logic can be
 * unit-tested deterministically.
 */
export function classifyExit(
  timedOut: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
): { exit_class: ExitClass; signal: string | null; exit_code: number | null } {
  if (timedOut && code === null) {
    return { exit_class: "timeout", signal: signal ?? "SIGKILL", exit_code: null };
  }
  return {
    exit_class: code === 0 ? "ok" : "nonzero",
    signal: signal ?? null,
    exit_code: code,
  };
}

/** Pull the QDS_PROBE value out of complete lines of subprocess stdout. */
function extractProbe(stdout: string, truncated: boolean): string | null {
  // When truncated, the final line is partial and may cut the probe value:
  // only consider complete lines (up to and including the last newline).
  if (truncated && !stdout.includes("\n")) return null;
  const completeLines = truncated
    ? stdout.slice(0, stdout.lastIndexOf("\n") + 1)
    : stdout;
  // Scan for the probe key at a line start via indexOf instead of split("\n"):
  // splitting a 256 KB excerpt allocates one string per line to find one match.
  let index = completeLines.indexOf(PROBE_KEY);
  while (index !== -1) {
    if (index === 0 || completeLines[index - 1] === "\n") {
      const endIndex = completeLines.indexOf("\n", index);
      const line =
        endIndex === -1
          ? completeLines.slice(index)
          : completeLines.slice(index, endIndex);
      const value = line.slice(PROBE_KEY.length).replace(/\r$/, "");
      return value.length > 0 ? value : null;
    }
    index = completeLines.indexOf(PROBE_KEY, index + 1);
  }
  return null;
}

export interface RunOptions {
  /** Parent env to merge from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock timeout in ms. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Parse a manifest file, spawn `warren run` with the merged env, capture
 * stdout (capped at MAX_STDOUT_EXCERPT), and return the structured harness
 * result with secret-looking parent env values redacted (INV-2).
 *
 * NOTE(goal): real warren binary unavailable on host — tests provide a PATH
 * shim (test/fixtures/bin/warren) that exec's `warren run <cmd...>`. The env
 * merge and propagation exercised here are real; only the `warren` entrypoint
 * is stubbed for test.
 */
export async function runManifest(
  manifestPath: string,
  opts: RunOptions = {},
): Promise<HarnessResult> {
  const manifest = parseManifestFile(manifestPath);
  const parent = cleanEnv(opts.env ?? process.env);
  const env = mergeEnv(parent, manifest.env);
  const { file, argv } = buildSpawn(manifest);
  // Clamp to the setTimeout range: values > 2^31-1 overflow to ~1ms.
  const timeoutMs =
    opts.timeoutMs !== undefined &&
    Number.isFinite(opts.timeoutMs) &&
    opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, 2_147_483_647)
      : DEFAULT_TIMEOUT_MS;

  // INV-3: log key names only — never values, never a process.env dump.
  const keys = logEnvKeys(env);
  const shown =
    keys.length > MAX_LOGGED_ENV_KEYS
      ? [...keys.slice(0, MAX_LOGGED_ENV_KEYS), "..."]
      : keys;
  diag(`cli-anything: env keys -> ${shown.map(sanitizeLogKey).join(",")}`);

  return await new Promise<HarnessResult>((resolve) => {
    let child: ChildProcess | null = null;
    const decoder = new StringDecoder("utf8");
    let stdout = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** Kill the whole child tree — delegates to the shared killTree primitive. */
    function killChildTree(): void {
      killTree(child);
    }

    function removeSignalHandlers(): void {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (process.platform !== "win32") {
        process.removeListener("SIGHUP", onSighup);
      }
    }

    /** Forward a harness-terminating signal to the child tree, then re-raise. */
    function handleSignal(sig: "SIGINT" | "SIGTERM" | "SIGHUP"): void {
      removeSignalHandlers();
      if (
        child !== null &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        killChildTree();
      }
      // Re-raise against ourselves so the harness dies from the same signal.
      try {
        process.kill(process.pid, sig);
      } catch {
        process.exit(1);
      }
    }

    const onSigint = (): void => handleSignal("SIGINT");
    const onSigterm = (): void => handleSignal("SIGTERM");
    const onSighup = (): void => handleSignal("SIGHUP");

    // Install handlers BEFORE spawn so a signal in the spawn-gap cannot orphan
    // a freshly detached tree. They no-op safely while `child` is still null.
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    if (process.platform !== "win32") {
      process.on("SIGHUP", onSighup);
    }

    function settle(result: HarnessResult): void {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      removeSignalHandlers();
      const redacted = redactSecrets(result.stdout_excerpt, parent);
      const excerpt =
        result.truncated === true
          ? redactBoundaryPrefix(redacted, parent)
          : redacted;
      let stdout_excerpt = capExcerpt(excerpt);
      // If the cap cut the excerpt or the original stdout was truncated, a
      // secret fragment may now sit at the new cut boundary: redact it and cap
      // again so nothing leaks.
      if (
        result.truncated === true ||
        stdout_excerpt.length < excerpt.length
      ) {
        stdout_excerpt = capExcerpt(
          redactBoundaryPrefix(stdout_excerpt, parent),
        );
      }
      const rawProbe = result.env_probe_result;
      const env_probe_result = rawProbe === null ? null : capProbe(rawProbe);
      resolve({
        ...result,
        stdout_excerpt,
        env_probe_result,
      });
    }

    function armWatchdog(
      classification: {
        exit_class: ExitClass;
        exit_code: number | null;
        signal: string | null;
      } = {
        exit_class: "timeout",
        exit_code: null,
        signal: "SIGKILL",
      },
    ): void {
      if (watchdog !== null || settled) return;
      watchdog = setTimeout(() => {
        if (settled) return;
        settle({
          exit_class: classification.exit_class,
          stdout_excerpt: stdout,
          env_probe_result: null,
          spawn_error_code: null,
          exit_code: classification.exit_code,
          signal: classification.signal,
          truncated,
        });
      }, WATCHDOG_GRACE_MS);
      watchdog.unref();
    }

    try {
      // stderr is ignored (not piped): the harness captures subprocess stdout
      // only, and an unread stderr pipe can delay `close` under some runtimes.
      // detached (POSIX) gives the child its own process group so a timeout
      // can kill the whole tree, not just the direct child.
      child = spawn(file, argv, {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      // Synchronous spawn failure (e.g. NUL bytes in argv/env → EINVAL).
      removeSignalHandlers();
      const code =
        err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      resolve({
        exit_class: "spawn_error",
        stdout_excerpt: "",
        env_probe_result: null,
        spawn_error_code: code ?? null,
        exit_code: null,
        signal: null,
        truncated: false,
      });
      return;
    }

    timer = setTimeout(() => {
      // The child may have exited (or been killed) between the timer firing
      // and this callback running: don't misclassify a natural exit as a
      // timeout, and don't signal a possibly-reused process group. Also guard
      // on harness state because the POSIX group kill does not set child.killed.
      if (
        child === null ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        settled ||
        timedOut
      ) {
        return;
      }
      timedOut = true;
      killChildTree();
      // If the kill fails or a descendant holds the stdout pipe open, `close`
      // may never fire; force-settle after a short grace period.
      armWatchdog();
    }, timeoutMs);

    child.stdout!.on("data", (d: Buffer) => {
      if (truncated) return;
      const remaining = MAX_STDOUT_EXCERPT - stdout.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (d.length > remaining) {
        // Bound the decode to the remaining capacity: a single oversized
        // chunk is never fully materialized past the cap. The final cap is
        // re-applied in settle (capExcerpt), which is the real invariant.
        stdout += decoder.write(d.subarray(0, remaining));
        truncated = true;
      } else {
        stdout += decoder.write(d);
      }
    });

    child.stdout!.on("error", (err: NodeJS.ErrnoException) => {
      // Stream read failure: kill the live child, then settle as spawn_error.
      killChildTree();
      settle({
        exit_class: "spawn_error",
        stdout_excerpt: stdout,
        env_probe_result: null,
        spawn_error_code: err.code ?? null,
        exit_code: null,
        signal: null,
        truncated,
      });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Flush the decoder even when truncated — append the final partial line
      // within the remaining cap budget (or drop cleanly). Keeps partial
      // output strictly ≤ cap.
      if (!truncated) {
        stdout += decoder.end();
      } else {
        // Truncated: decoder.end() would append U+FFFD after a mid-sequence cut.
        // Call it anyway to get the final partial line, then cap it cleanly.
        const tail = decoder.end();
        if (tail !== undefined) {
          const remaining = MAX_STDOUT_EXCERPT - stdout.length;
          if (remaining > 0) {
            stdout += tail.slice(0, remaining);
          }
        }
      }
      settle({
        exit_class: "spawn_error",
        stdout_excerpt: stdout,
        env_probe_result: null,
        spawn_error_code: err.code ?? null,
        exit_code: null,
        signal: null,
        truncated,
      });
    });

    child.on("exit", (code, signal) => {
      // The process exited but its stdio streams may still be held open by a
      // descendant. Record the real classification and arm a short watchdog to
      // force-settle if `close` never arrives.
      if (settled) return;
      armWatchdog(classifyExit(timedOut, code, signal));
    });

    child.on("close", (code, signal) => {
      // Flush the decoder even when truncated — append the final partial line
      // within the remaining cap budget (or drop cleanly). Keeps partial
      // output strictly ≤ cap.
      if (!truncated) {
        stdout += decoder.end();
      } else {
        // Truncated: decoder.end() would append U+FFFD after a mid-sequence cut.
        // Call it anyway to get the final partial line, then cap it cleanly.
        const tail = decoder.end();
        if (tail !== undefined) {
          const remaining = MAX_STDOUT_EXCERPT - stdout.length;
          if (remaining > 0) {
            stdout += tail.slice(0, remaining);
          }
        }
      }
      const classification = classifyExit(timedOut, code, signal);
      settle({
        exit_class: classification.exit_class,
        stdout_excerpt: stdout,
        // Extract the probe from complete lines only. When truncated, the
        // trailing partial line (which may be the probe line cut mid-value)
        // is excluded, so only a fully captured probe is reported.
        env_probe_result: extractProbe(stdout, truncated),
        spawn_error_code: null,
        exit_code: classification.exit_code,
        signal: classification.signal,
        truncated,
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// P0.3: 3-agent mixed-model team via Warren (merged-JSON demo)
// ─────────────────────────────────────────────────────────────────────────────

/** Budget kill threshold as a fraction of the team cap (P0.3 §Budget, 90%). */
export const BUDGET_KILL_FRACTION = 0.9;

/** Dollar threshold at which the budget kill fires for a given cap. */
export function budgetKillThresholdUsd(budgetCapUsd: number): number {
  return budgetCapUsd * BUDGET_KILL_FRACTION;
}

/** Running total tracked by the DF2.7 cost guard (INV-COST-2 / INV-COST-5). */
export interface CostGuardState {
  cumulativeCostUsd: number;
  costUnpriced: boolean;
}

/**
 * Pure accumulation step for one `cost` event: sums costUsd (SUM across
 * per-invocation session totals — no event restates another's spend,
 * INV-COST-2) and stickily sets costUnpriced once any event reports
 * unpricedTurns > 0 (INV-COST-5, never cleared by a later fully-priced
 * event). This is the ONLY place the guard's math lives — runTeamManifest's
 * live event loop and its unit tests both call it, so they cannot drift.
 *
 * A non-finite (NaN/Infinity) or negative costUsd is treated as unpriced
 * (INV-COST-5) and excluded from the sum: adding NaN would poison
 * cumulativeCostUsd for every subsequent event (NaN >= threshold is always
 * false, silently disabling the budget kill for the rest of the run), and
 * a negative value would understate spend and delay the kill.
 */
export function applyCostEvent(
  state: CostGuardState,
  event: { costUsd: number; unpricedTurns?: number },
): CostGuardState {
  const costValid = Number.isFinite(event.costUsd) && event.costUsd >= 0;
  return {
    cumulativeCostUsd: costValid
      ? state.cumulativeCostUsd + event.costUsd
      : state.cumulativeCostUsd,
    costUnpriced:
      state.costUnpriced || !costValid || (event.unpricedTurns ?? 0) > 0,
  };
}

/**
 * Hard cap on captured lead-run stdout kept in memory for the team path
 * (F15): unlike runManifest's byte-capped excerpt, the team handler parsed
 * NDJSON lines into an unbounded `lineBuffer` — a malicious/buggy lead
 * emitting an endless newline-less stream grew memory without bound (OOM).
 * 1 MiB is far above any legitimate event line; oversize lines are dropped.
 */
export const MAX_TEAM_STDOUT_BYTES = 1024 * 1024;

export interface TeamRunOptions {
  /** Parent env to merge from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override the manifest's per-message coms await timeout (tests). */
  comsAwaitTimeoutMs?: number;
  /** Override the manifest's wall-clock cap (tests). */
  wallClockCapMs?: number;
  /** Override the manifest's budget cap in USD (tests). */
  budgetCapUsd?: number;
  /** Override the per-line team stdout cap in bytes (tests). */
  teamStdoutCapBytes?: number;
  /** In-flight grace after the budget threshold before killTree (default 5 s). */
  graceMs?: number;
  /** Directory for lead-failure worker partials. Default `<cwd>/artifacts`. */
  artifactsDir?: string;
  /**
   * DF1.6 T5: Effective ceiling in microdollars (µ$). When provided,
   * the child harness cap becomes `budgetCapUsd = effectiveCeilingMicros / 1e6`,
   * clamped to the schema maximum (10 USD). Never raises the cap above the ceiling.
   * Absent → use existing budgetCapUsd path (S1 default). This is the DF2.7 boundary
   * where the tier-3 harness cap is raised to match the outer guard ceiling.
   */
  effectiveCeilingMicros?: number;
  /**
   * DF1.6 T5: Force QDS_TEAM_RUNNER=local in the child environment.
   * The caller (phase layer) enforces AC5 before calling runTeamManifest,
   * so this is minimal: when true, we construct the child env with QDS_TEAM_RUNNER=local
   * so buildTeamSpawn selects the local driver regardless of parent env.
   */
  forceLocalRunner?: boolean;
  /**
   * DF1.6 T7: per-line observer for the dispatch_task phase. Called once per
   * surviving stdout line with the parsed TeamEvent (or null when the parser
   * rejected the line — malformed), and once per line DROPPED at the byte cap
   * with a null event and droppedOversize: true (a dropped line never reaches
   * the parser, so it is never malformed). Purely additive: the internal
   * event loop is unchanged.
   */
  onTeamEvent?: (
    event: TeamEvent | null,
    meta: { droppedOversize: boolean },
  ) => void;
  /**
   * DF1.6 T7: raw exit facts for the phase layer's precedence classification
   * (story Technical Notes: how the process died > envelope > exit code).
   * Fired EXACTLY ONCE, from settle() — covering `close`, the wall-clock and
   * budget force-settles, and the stdout/spawn error paths (a force-settled
   * run whose `close` never arrives still reports facts). exitCode/termSignal
   * are the best-known values at settle time (null when the child never
   * reported an exit). killOrigin is "watchdog" only when the RSS watchdog
   * escalated; comsInitError is the parsed reason or null. The callback is
   * invoked inside a try/catch: a throwing observer must not hang the run.
   */
  onRunFacts?: (facts: {
    exitCode: number | null;
    termSignal: string | null;
    killOrigin: "watchdog" | null;
    comsInitError: string | null;
  }) => void;
  /**
   * DF1.6 T7: parent-side cancellation. When the signal fires (or has already
   * fired), the whole child tree is killed and the run settles transient —
   * a phase abort must not leave the team running until its own wall-clock cap.
   */
  abortSignal?: AbortSignal;
}

/**
 * Run a P0.3 team manifest: spawn the Warren lead run, parse its NDJSON event
 * stream (cost / coms / worker_output / merged), enforce the budget and
 * wall-clock hard guards (INV-2), track per-worker await slots with atomic
 * single-settle (P0.3-S-H5), and emit ONE MergedOutput covering exactly the
 * five exit paths of P0.3-M2.
 *
 * durationMs (P0.3-S-L1): measured from the lead-run spawn (the harness's
 * single subprocess, which spawns the workers inside the sandbox) to the
 * merged-JSON build — harness boot/parse excluded.
 */
export async function runTeamManifest(
  manifestPath: string,
  opts: TeamRunOptions = {},
): Promise<MergedOutput> {
  const manifest = parseTeamManifestFile(manifestPath);
  const parent = Object.fromEntries(
    Object.entries(opts.env ?? process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
  const env = mergeEnv(parent, manifest.env);

  // DF1.6 T5: Apply effective ceiling to budgetCapUsd
  // When effectiveCeilingMicros is provided (and finite + positive), set
  // budgetCapUsd = ceiling / 1e6, clamped to TeamManifestSchema max (10 USD).
  // Never raises cap above ceiling. A zero/negative/NaN ceiling is invalid at
  // this boundary: zero would arm the kill on the first cost poll
  // (0 >= 0.9*0) and NaN would disable it for the whole run
  // (cumulative >= NaN is always false) — both fall back to the manifest cap.
  // This is the DF2.7 boundary where the tier-3 harness cap matches the outer guard.
  let budgetCapUsd = opts.budgetCapUsd ?? manifest.team.budgetCapUsd;
  if (
    opts.effectiveCeilingMicros !== undefined &&
    Number.isFinite(opts.effectiveCeilingMicros) &&
    opts.effectiveCeilingMicros > 0
  ) {
    const ceilingUsd = opts.effectiveCeilingMicros / 1e6;
    // Clamp to schema maximum (10) — never above the ceiling
    budgetCapUsd = Math.min(ceilingUsd, 10);
  }

  // DF1.6 T5: Force QDS_TEAM_RUNNER=local when requested
  // AC5 is enforced by the caller (phase layer) before calling runTeamManifest,
  // but forceLocalRunner ensures the child env selects the local driver.
  // Never mutate process.env — only the child env.
  if (opts.forceLocalRunner) {
    env.QDS_TEAM_RUNNER = "local";
  }
  const killThresholdUsd = budgetKillThresholdUsd(budgetCapUsd);
  const wallClockCapMs = opts.wallClockCapMs ?? manifest.team.wallClockCapMs;
  const comsAwaitTimeoutMs =
    opts.comsAwaitTimeoutMs ?? manifest.team.comsAwaitTimeoutMs;
  // Grace override for tests/ops via env (bounded 0..60s), else 5 s default.
  const envGraceRaw = Number(env.QDS_TEAM_GRACE_MS);
  const envGraceMs =
    Number.isFinite(envGraceRaw) && envGraceRaw >= 0 && envGraceRaw <= 60_000
      ? envGraceRaw
      : undefined;
  const graceMs = opts.graceMs ?? envGraceMs ?? WATCHDOG_GRACE_MS;
  const artifactsDir = opts.artifactsDir ?? join(process.cwd(), "artifacts");
  // F15 per-line cap (tests): defaults to the 1 MiB constant; tests pass a
  // small value to exercise the oversized-multibyte-line boundary precisely.
  const teamStdoutCapBytes = opts.teamStdoutCapBytes ?? MAX_TEAM_STDOUT_BYTES;

  // Agent-team extension config for the workers (CC-2 amended): worker
  // role-models are NOT Warren CLI flags.
  env.QDS_AGENT_TEAM_CONFIG_JSON = JSON.stringify({
    lead: {
      agentId: manifest.team.lead.agentId,
      ...splitRoleModel(manifest.team.lead.model),
      prompt: manifest.team.lead.prompt,
    },
    workers: manifest.team.workers.map((w) => ({
      agentId: w.agentId,
      ...splitRoleModel(w.model),
      prompt: w.prompt,
      // DF1.9: opt-in lean profile. Spread conditionally so a manifest with no
      // `lean` key produces the exact config object it produced before this
      // story — the driver's default argv path stays byte-identical (AC3).
      ...(w.lean !== undefined ? { lean: w.lean } : {}),
      ...(w.extensions !== undefined ? { extensions: w.extensions } : {}),
    })),
    turnCap: manifest.team.turnCap,
  });
  env.PI_COMS_TIMEOUT_MS = String(comsAwaitTimeoutMs);

  // INV-1: presence-only logging for provider keys; never values.
  for (const key of ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) {
    diag(`cli-anything: ${key}: ${env[key] !== undefined ? "set" : "unset"}`);
  }

  const redact = (s: string): string => redactSecrets(s, parent);
  const runner = env.QDS_TEAM_RUNNER === "local" ? "local" : "warren";
  const { file, argv } = buildTeamSpawn(manifest, runner);

  return await new Promise<MergedOutput>((resolve) => {
    const comsLog = new ComsLogCollector();
    const workerOutputs = new Map<string, unknown>();
    const waivers: Waiver[] = [];
    let mergedResult: Record<string, unknown> | null = null;
    let comsInitError: string | null = null;
    let cumulativeCostUsd = 0;
    // DF2.7 / INV-COST-5: a `cost` event carrying unpricedTurns > 0 means its
    // totals are KNOWN-PARTIAL — an unmeasured turn is never priced at $0. The
    // cumulative total below is therefore under-counted, so every path that
    // reports it must say so rather than let a reader (or DF2.8's ledger) read
    // a partial figure as a complete one.
    let costUnpriced = false;
    let budgetKilled = false;
    let wallTimedOut = false;
    const watchdogKilled = false; // DF1.6 T4: RSS watchdog kill flag
    let settled = false;
    let child: ChildProcess | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    // Best-known exit facts, updated by `exit`/`close`; emitted once from
    // settle() so force-settled runs (close never arrived) still report them.
    let lastExitCode: number | null = null;
    let lastTermSignal: NodeJS.Signals | null = null;

    // DF1.6 T1: Collect partial output for failure paths (capped at 10KB)
    let partialOutputBuffer = "";
    const PARTIAL_OUTPUT_CAP = 10_000;

    // DF1.6 T4: RSS watchdog handle (started after spawn, stopped on settle)
    let watchdog: WatchdogHandle | null = null;

    // Per-worker single-settle await slots (P0.3-S-H5): worker_output settles
    // "response", the per-message timer settles "timeout" — first wins.
    const pendings = new Map<
      string,
      ReturnType<typeof createPending<"response" | "timeout">>
    >();
    for (const w of manifest.team.workers) {
      pendings.set(w.agentId, createPending<"response" | "timeout">());
    }

    const startedAt = Date.now();

    function arm(ms: number, fn: () => void): void {
      const t = setTimeout(fn, ms);
      t.unref();
      timers.push(t);
    }

    // DF1.6 T1: Return collected partial output for failure paths
    function collectPartialOutput(): string {
      return partialOutputBuffer;
    }

    function settle(
      exitStatus: MergedOutput["exitStatus"],
      partial: boolean,
      error: MergedError | null,
      agentOutputsOverride?: Record<string, unknown>,
    ): void {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      // DF1.6 T4: Stop RSS watchdog on settle (no kill after clean exit)
      if (watchdog !== null) {
        watchdog.stop();
        watchdog = null;
      }
      removeSignalHandlers();
      // DF1.6 T7: exit facts exactly once per run, from HERE — every settle
      // path (close, force-settle, stream/spawn error) reports them. A
      // throwing observer must not prevent the resolve below.
      try {
        opts.onRunFacts?.({
          exitCode: lastExitCode,
          termSignal: lastTermSignal,
          killOrigin: watchdogKilled ? "watchdog" : null,
          comsInitError: comsInitError ?? null,
        });
      } catch (err) {
        console.error("cli-anything: onRunFacts callback threw", err);
      }

      const validated: WorkerOutput[] = [];
      for (const [agentId, raw] of workerOutputs) {
        const v = validateWorkerOutput(agentId, raw);
        if (v.ok) validated.push(v.output);
      }
      const agentOutputs =
        agentOutputsOverride ??
        Object.fromEntries(validated.map((v) => [v.agentId, v.result]));
      const changedFiles =
        exitStatus === "success" || exitStatus === "transient"
          ? unionChangedFiles(validated.map((v) => v.changedFiles))
          : [];

      resolve(
        buildMergedOutput({
          exitStatus,
          partial,
          result: mergedResult ?? {},
          agentOutputs,
          changedFiles,
          comsLog: comsLog.entries,
          durationMs: Date.now() - startedAt,
          waivers,
          error,
          redact,
          // DF1.6 T1: New required fields with defaults for runner path
          testResults: { passed: 0, failed: 0 },
          testsExecuted: false,
          summary:
            typeof mergedResult?.summary === "string"
              ? (mergedResult as { summary: string }).summary
              : "",
          mulchPrimed: false,
          mulchPrimeError: null,
          artifacts: [],
          partialOutput: partial ? collectPartialOutput() : null,
        }),
      );
    }

    // Registered abort listener (assigned when opts.abortSignal wires one up);
    // removed by removeSignalHandlers so a never-fired listener cannot linger
    // on a long-lived signal after the run settles.
    let abortListener: (() => void) | null = null;

    function removeSignalHandlers(): void {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (process.platform !== "win32") {
        process.removeListener("SIGHUP", onSighup);
      }
      if (abortListener !== null) {
        opts.abortSignal?.removeEventListener("abort", abortListener);
        abortListener = null;
      }
    }

    const onSignal = (sig: NodeJS.Signals): void => {
      removeSignalHandlers();
      killTree(child);
      // Re-raise the signal we actually received so the harness exits with
      // the correct status (SIGINT stays SIGINT for parent orchestrators).
      try {
        process.kill(process.pid, sig);
      } catch {
        process.exit(1);
      }
    };
    const onSigint = (): void => onSignal("SIGINT");
    const onSigterm = (): void => onSignal("SIGTERM");
    const onSighup = (): void => onSignal("SIGHUP");

    // Signal handlers BEFORE spawn (hardened contract, CC-R8-8).
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    if (process.platform !== "win32") {
      process.on("SIGHUP", onSighup);
    }

    try {
      child = spawn(file, argv, {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        detached: process.platform !== "win32",
      });

      // DF1.6 T4: Start RSS watchdog after successful spawn
      // The child is the process group leader (detached:true on POSIX)
      // pgidOrGroup = child.pid for process group sampling. Threshold/poll/
      // grace come from startRssWatchdog's defaults (4 GB / 200 ms / 5 s).
      if (process.platform !== "win32" && child.pid !== undefined) {
        watchdog = startRssWatchdog({
          child,
          pgidOrGroup: child.pid,
          onEscalate: (_info) => {
            // watchdogKilled is now set synchronously by startRssWatchdog
            // before this callback runs (overflow-precedence fix).
            // The flag is already visible at classification decision time.
          },
          onUnwatchable: (reason) => {
            // Log but don't fail — watchdog becomes inactive
            console.error(`cli-anything: RSS watchdog unwatchable: ${reason}`);
          },
          log: (msg) => {
            // Use console.error for watchdog diagnostics (like existing cost warnings)
            console.error(msg);
          },
        });
      }
    } catch (err) {
      const code =
        err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      settle("transient", false, {
        reason: "transient",
        message: `warren spawn failed${code !== undefined ? ` (${code})` : ""}`,
      });
      return;
    }

    // DF1.6 T7: parent-side cancellation — a phase abort kills the team tree
    // instead of letting it run to its own wall-clock cap. Mirrors the
    // wall-clock leg: kill, then force-settle transient if `close` never
    // arrives (grandchild stdout-hold).
    if (opts.abortSignal !== undefined) {
      const abortTeam = (): void => {
        if (settled) return;
        killTree(child);
        arm(WATCHDOG_GRACE_MS, () => {
          settle("transient", false, {
            reason: "transient",
            message: "run aborted by parent signal",
          });
        });
      };
      if (opts.abortSignal.aborted) {
        abortTeam();
      } else {
        const optsSignal = opts.abortSignal; // Capture for closure
        optsSignal.addEventListener("abort", abortTeam, { once: true });
        abortListener = abortTeam;
        // Re-check after addEventListener: an abort between the check above
        // and addEventListener would have been missed. If already aborted,
        // invoke synchronously (the listener won't fire again due to once:true).
        if (optsSignal.aborted) abortTeam();
      }
    }

    // Wall-clock hard cap (INV-2): wall-clock wins over coms_await.
    arm(wallClockCapMs, () => {
      if (settled) return;
      wallTimedOut = true;
      killTree(child);
      // Force-settle if `close` never arrives (grandchild stdout-hold).
      arm(WATCHDOG_GRACE_MS, () => {
        settle("overflow", true, {
          reason: "overflow",
          message: `wall-clock cap ${wallClockCapMs} ms exceeded`,
          details: { cumulativeCostUsd, costUnpriced },
        });
      });
    });

    // Per-worker coms_await timers.
    for (const w of manifest.team.workers) {
      arm(comsAwaitTimeoutMs, () => {
        pendings.get(w.agentId)?.settle("timeout");
      });
    }

    function onBudgetThreshold(): void {
      if (budgetKilled || settled) return;
      budgetKilled = true;
      // In-flight requests get `graceMs` to complete, then the tree dies
      // (process-group SIGKILL via the hardened primitive).
      arm(graceMs, () => {
        if (settled) return;
        killTree(child);
        arm(WATCHDOG_GRACE_MS, () => {
          settle("overflow", true, {
            reason: "overflow",
            message: `budget kill threshold $${killThresholdUsd.toFixed(4)} reached (cap $${budgetCapUsd.toFixed(2)})`,
            details: { cumulativeCostUsd, costUnpriced },
          });
        });
      });
    }

    let lineBuffer = "";
    // Reassignable: a multibyte char split across chunks leaves partial bytes
    // buffered inside the decoder. When we discard an oversized line we must
    // drop those partial bytes too — otherwise they flush as a garbage prefix
    // onto the first resumed line and corrupt its NDJSON parse.
    let decoder = new StringDecoder("utf8");
    // F15 stdout-cap state — declared before the `data` handler that closes
    // over them, so there is no use-before-initialization window.
    let teamStdoutBytes = 0;
    let teamStdoutCapped = false;
    function processLine(line: string): void {
      {
        const event = parseTeamEventLine(line);
        // DF1.6 T7: observe every surviving line (null = parser rejection).
        // Observer failures must not take down the internal event loop — a
        // throwing callback inside a stream `data` handler is an uncaught
        // exception for the whole process.
        try {
          opts.onTeamEvent?.(event, { droppedOversize: false });
        } catch (err) {
          console.error("cli-anything: onTeamEvent callback threw", err);
        }
        if (event !== null) {
          switch (event.kind) {
            case "cost": {
              // Budget poll AFTER each turn (P0.3-S-H4): synchronous check.
              // DF2.7: costUsd is now the emitting subprocess's SESSION total
              // (one ledger row per event, SUM across rows) — no event
              // restates another's spend, so summing here is still exactly
              // right and is the ONLY accumulator the kill decision reads
              // (INV-COST-2). applyCostEvent is the single source of truth
              // for this math, shared with the unit tests in
              // runner.test.ts so the guard cannot drift from what's tested.
              const wasUnpriced = costUnpriced;
              ({ cumulativeCostUsd, costUnpriced } = applyCostEvent(
                { cumulativeCostUsd, costUnpriced },
                event.event,
              ));
              if (costUnpriced && !wasUnpriced) {
                // console.error, not diag(): diag is routine per-run
                // diagnostics and is silenced under NODE_ENV=test. A
                // known-partial billing total is a warning — on the success
                // path this line is the ONLY surface for it, because
                // MergedOutput's key set is frozen (P0.3-M2).
                console.error(
                  "cli-anything: cost event reports unpriced turns; cumulative total is partial (INV-COST-5)",
                );
              }
              if (cumulativeCostUsd >= killThresholdUsd) onBudgetThreshold();
              break;
            }
            case "coms":
              comsLog.push(event.raw);
              break;
            case "worker_output":
              // Security (CR #40): agentId rides an untrusted NDJSON event and
              // becomes an artifact filename — whitelist against the declared
              // worker set (which zod already constrained to safe path
              // components). Unknown/crafted ids are dropped, not written.
              if (!pendings.has(event.agentId)) {
                console.error(
                  "cli-anything: dropping worker_output for undeclared agentId",
                );
                break;
              }
              workerOutputs.set(event.agentId, event.output);
              pendings.get(event.agentId)?.settle("response");
              break;
            case "merged":
              mergedResult = event.result;
              break;
            case "coms_init_error":
              comsInitError = event.reason;
              break;
          }
        }
      }
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      // F15 (per-line cap): bound the CURRENT unterminated line, not cumulative
      // run output. A long legitimate run emits many small NDJSON lines that
      // would exhaust a cumulative 1 MiB budget and silently drop every later
      // event — including `merged`, misclassifying a clean run as
      // lead_failure/logic. An oversized line is discarded through its next
      // newline, then parsing resumes.
      let bytes: Buffer = chunk;
      // Resume after an oversized line: drop through its terminating newline,
      // which may sit inside this same chunk, then parse the tail.
      if (teamStdoutCapped) {
        const nl = bytes.indexOf(0x0a);
        if (nl === -1) return;
        bytes = bytes.subarray(nl + 1);
        teamStdoutCapped = false;
        teamStdoutBytes = 0;
        lineBuffer = "";
        // Defensive: drop any partial-char bytes buffered while the discarded
        // line was still being decoded, so they cannot prefix the resumed tail.
        decoder = new StringDecoder("utf8");
      }
      // Count raw Buffer bytes BEFORE decoding: decoded.length is UTF-16 code
      // units and undercounts multibyte UTF-8 (up to 4x), so a line of 3-byte
      // chars could slip past the cap and grow lineBuffer without bound.
      if (teamStdoutBytes + bytes.length > teamStdoutCapBytes) {
        console.error(
          `cli-anything: lead stdout line exceeded ${teamStdoutCapBytes} byte cap — line dropped, parsing resumes after next newline`,
        );
        // DF1.6 T7 (AC2): a cap-dropped line never reaches the parser — count
        // it as droppedOversize, never as malformed.
        try {
          opts.onTeamEvent?.(null, { droppedOversize: true });
        } catch (err) {
          console.error("cli-anything: onTeamEvent callback threw", err);
        }
        lineBuffer = "";
        teamStdoutBytes = 0;
        // Reset the decoder: earlier chunks of THIS oversized line may have
        // left a partial multibyte char buffered. Dropping it here stops those
        // stale bytes from corrupting the first line parsed after resume.
        decoder = new StringDecoder("utf8");
        // Discard the rest of this oversized line through its next newline. It
        // may be later in THIS chunk (drop in place + decode only the tail); if
        // it spans into the next chunk, stay in discard-mode until it lands.
        const nl = bytes.indexOf(0x0a);
        if (nl === -1) {
          teamStdoutCapped = true;
          return;
        }
        bytes = bytes.subarray(nl + 1);
      }
      // Decode exactly once: the full chunk in the normal path, or only the
      // tail that survived a discarded oversized line.
      if (bytes.length > 0) {
        const decoded = decoder.write(bytes);
        lineBuffer += decoded;
        teamStdoutBytes += bytes.length;
        // DF1.6 T1: Collect partial output for failure paths (capped at 10KB)
        if (partialOutputBuffer.length < PARTIAL_OUTPUT_CAP) {
          const remaining = PARTIAL_OUTPUT_CAP - partialOutputBuffer.length;
          partialOutputBuffer += decoded.slice(0, remaining);
        }
      }
      // Consume complete lines; reset the per-line byte counter for whatever
      // partial line remains after each newline.
      let nl = lineBuffer.indexOf("\n");
      while (nl !== -1) {
        processLine(lineBuffer.slice(0, nl));
        lineBuffer = lineBuffer.slice(nl + 1);
        teamStdoutBytes = Buffer.byteLength(lineBuffer, "utf8");
        nl = lineBuffer.indexOf("\n");
      }
    });

    // A stream read error with no listener crashes the whole harness —
    // settle as transient instead (parity with runManifest's stdout guard).
    child.stdout!.on("error", (err: NodeJS.ErrnoException) => {
      killTree(child);
      settle("transient", false, {
        reason: "transient",
        message: `lead stdout stream error (${err.code ?? err.message})`,
      });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle("transient", false, {
        reason: "transient",
        message: `warren spawn failed (${err.code ?? err.message})`,
      });
    });

    let closed = false;
    let finalizing = false;
    const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
      void (async () => {
        // F5: the exit-watchdog and `close` can both call finalize before
        // `settled` flips (the body awaits mid-way). Guard entry so the
        // artifact writes + pending loop run exactly once; settle()'s own
        // idempotency guard already protects the single resolve.
        if (settled || finalizing) return;
        finalizing = true;

        // Flush the decoder and any final line written WITHOUT a trailing
        // newline — otherwise a last `merged` event would sit unparsed in
        // lineBuffer and the run would misclassify as lead_failure/logic.
        // EOF mid-oversized-line: the decoder tail belongs to the discarded
        // line, so drop it instead of parsing a fragment.
        if (!teamStdoutCapped) {
          lineBuffer += decoder.end();
          if (lineBuffer.length > 0) {
            processLine(lineBuffer);
            lineBuffer = "";
          }
        }

        // Overflow paths win regardless of the raw classification (CC-1
        // precedence: budget/wall-clock/watchdog kill → overflow regardless of signal).
        // DF1.6 T4: watchdog kill also maps to overflow (precedence step 1)
        if (budgetKilled || wallTimedOut || watchdogKilled) {
          settle("overflow", true, {
            reason: "overflow",
            message: budgetKilled
              ? `budget kill threshold $${killThresholdUsd.toFixed(4)} reached (cap $${budgetCapUsd.toFixed(2)})`
              : wallTimedOut
                ? `wall-clock cap ${wallClockCapMs} ms exceeded`
                : "RSS watchdog 4 GB threshold exceeded",
            details: { cumulativeCostUsd, costUnpriced },
          });
          return;
        }

        // Coms init failure → transient, NO partial output (AC6 / P0.3-S-L2).
        if (comsInitError !== null) {
          settle(
            "transient",
            false,
            {
              reason: "transient",
              message: `coms init failed: ${comsInitError}`,
            },
            {},
          );
          return;
        }

        const classification = classifyExit(false, code, signal);

        if (mergedResult !== null && classification.exit_class === "ok") {
          // Validate every received worker output; a missing/unsafe
          // changedFiles is a NODE FAILURE (CORRECTNESS-C) → logic.
          for (const [agentId, raw] of workerOutputs) {
            const v = validateWorkerOutput(agentId, raw);
            if (!v.ok) {
              settle("logic", false, { reason: "logic", message: v.reason });
              return;
            }
          }
          // Resolve worker await slots: any timeout → partial (path 2,
          // populated variant). Slots are already settled ("response") for
          // every received output; unsettled ones settle "timeout" now that
          // the lead has exited (their timers may not have fired yet).
          const missingWorkers: Array<{ agentId: string; reason: string }> = [];
          for (const [agentId, pending] of pendings) {
            pending.settle("timeout");
            if ((await pending.promise) === "timeout") {
              missingWorkers.push({ agentId, reason: "timeout" });
            }
          }
          if (missingWorkers.length > 0) {
            settle("transient", true, {
              reason: "transient",
              message: `worker(s) missed the coms_await deadline: ${missingWorkers.map((m) => m.agentId).join(", ")}`,
              details: { missingWorkers },
            });
            return;
          }
          settle("success", false, null);
          return;
        }

        // Lead exited pre-emit while holding unmerged worker outputs →
        // lead_failure (classifyExit NOT consulted for the top-level status;
        // its classification is recorded in error details). Worker partials
        // are preserved in artifacts/ via atomic tmp+rename (P0.3-S-M4).
        if (mergedResult === null && workerOutputs.size > 0) {
          try {
            mkdirSync(artifactsDir, { recursive: true });
            for (const [agentId, raw] of workerOutputs) {
              // INV-3 parity with stdout: artifacts must not carry secrets.
              writeArtifactAtomic(artifactsDir, agentId, redactDeep(raw, redact));
            }
          } catch (err) {
            console.error(
              `cli-anything: failed to write artifacts: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          settle(
            "lead_failure",
            true,
            {
              reason: "lead_failure",
              message: "lead process exited before emitting merged output",
              details: {
                classification: classification.exit_class,
                exitCode: classification.exit_code,
                signal: classification.signal,
              },
            },
            {},
          );
          return;
        }

        // No merged output, no held worker outputs.
        if (classification.signal !== null) {
          settle("transient", false, {
            reason: "transient",
            message: `lead killed by signal ${classification.signal}`,
          });
          return;
        }
        settle("logic", false, {
          reason: "logic",
          message:
            classification.exit_class === "ok"
              ? "lead exited 0 without emitting merged output (contract violation)"
              : `lead exited non-zero (${classification.exit_code})`,
          details: { exitCode: classification.exit_code },
        });
      })();
    };

    // Gemini #40 (high): the lead may exit while a grandchild holds stdout
    // open — `close` never fires and the harness hangs until the wall-clock
    // cap. Mirror runManifest: on `exit`, arm an unref'd watchdog that
    // force-finalizes after WATCHDOG_GRACE_MS if `close` hasn't arrived.
    child.on("exit", (code, signal) => {
      lastExitCode = code;
      lastTermSignal = signal;
      if (settled || closed) return;
      arm(WATCHDOG_GRACE_MS, () => {
        if (!closed) finalize(code, signal);
      });
    });

    child.on("close", (code, signal) => {
      closed = true;
      lastExitCode = code;
      lastTermSignal = signal;
      finalize(code, signal);
    });
  });
}
