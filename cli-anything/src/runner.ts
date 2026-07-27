import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ComsLogCollector } from "./coms-log.ts";
import { parseManifestFile, parseTeamManifestFile } from "./manifest.ts";
import {
  buildMergedOutput,
  createPending,
  redactDeep,
  unionChangedFiles,
  validateWorkerOutput,
} from "./merger.ts";
import type {
  CostEvent,
  ExitClass,
  HarnessResult,
  Manifest,
  MergedError,
  MergedOutput,
  TeamManifest,
  Waiver,
  WorkerOutput,
} from "./types.ts";

/** Default wall-clock timeout for a harness invocation: 10 minutes. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Hard cap on captured subprocess stdout kept in memory / emitted. */
export const MAX_STDOUT_EXCERPT = 256 * 1024;

/** Hard cap on the extracted QDS_PROBE value. */
const MAX_PROBE_RESULT_LEN = 1024;

/** Max env key names shown in the log line (INV-3: key names only). */
const MAX_LOGGED_ENV_KEYS = 50;

/**
 * Routine per-run diagnostics (env key names, provider-key presence). Quiet
 * under `bun test` (Bun sets NODE_ENV=test) because they buried real failures
 * in test output (#53); `QDS_LOG_VERBOSE=1` brings them back for a suite.
 * Warnings and errors do NOT go through here — they always print.
 */
function diag(message: string): void {
  if (process.env.NODE_ENV === "test" && !process.env.QDS_LOG_VERBOSE) return;
  console.error(message);
}

/**
 * Parent-env KEY NAMES whose values look secret-ish. Values under such keys
 * are redacted from stdout_excerpt / env_probe_result (INV-2 hardening).
 * Heuristic: high-signal secret-bearing key patterns only, plus the
 * MIN_REDACTABLE_VALUE_LEN floor below.
 */
const SECRET_KEY_RE =
  /SECRET|TOKEN|PASS|CRED|API[_-]?KEY|PRIVATE|CERT|DSN|DATABASE_URL|SSH|SIGNING|AUTH|[_-]KEY|[_-]URL|[_-]URI/i;

/** Short values are ignored to avoid mangling output with false positives. */
const MIN_REDACTABLE_VALUE_LEN = 8;

/** Minimum trailing-prefix length redacted at the truncation cut boundary. */
const MIN_BOUNDARY_PREFIX_LEN = MIN_REDACTABLE_VALUE_LEN;

const PROBE_KEY = "QDS_PROBE=";

/**
 * Enforce the excerpt cap (measured in UTF-16 code units, matching
 * String.prototype.length) without leaving a trailing unpaired surrogate
 * from a sliced pair.
 */
function capExcerpt(text: string): string {
  return text.slice(0, MAX_STDOUT_EXCERPT).replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * Enforce the probe-result cap (measured in UTF-16 code units) without
 * leaving a trailing unpaired surrogate.
 */
function capProbe(value: string): string {
  return value.slice(0, MAX_PROBE_RESULT_LEN).replace(/[\uD800-\uDBFF]$/, "");
}

type EnvMap = Record<string, string>;

/** Drop undefined-valued entries — process.env values may be undefined. */
function cleanEnv(env: NodeJS.ProcessEnv): EnvMap {
  const out: EnvMap = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Merge manifest env onto parent env — INV-1: additive merge, never a bare
 * assignment. A manifest with no env block still inherits the full parent env
 * (PATH, credentials, ...), so this is a non-regression by construction.
 *
 * PATH is special-cased (AC3): a manifest PATH does NOT replace the parent
 * PATH — it is APPENDED (`parent + delimiter + manifest`). An EMPTY manifest
 * PATH leaves the parent PATH unchanged (no dangling delimiter). On win32,
 * PATH is special-cased again: the PATH key is matched case-insensitively in
 * BOTH the manifest and the parent env, the parent's original key casing is
 * preserved, and case-variant duplicate PATH keys are collapsed. Every other
 * key follows plain last-wins `{ ...parent, ...manifest }` merge.
 *
 * The `platform` parameter exists so the win32 branch is unit-testable.
 */
export function mergeEnv(
  parent: EnvMap,
  manifestEnv: EnvMap | undefined,
  platform: NodeJS.Platform = process.platform,
): EnvMap {
  const merged: EnvMap = { ...parent, ...manifestEnv };
  if (manifestEnv !== undefined) {
    const pathKey = Object.keys(manifestEnv).find((k) =>
      platform === "win32" ? k.toLowerCase() === "path" : k === "PATH",
    );
    if (pathKey !== undefined) {
      const manifestPath = manifestEnv[pathKey]!;
      // Find the parent's PATH key case-insensitively (win32 uses `Path`) so
      // we read the real parent value and keep the original key casing.
      const parentPathKey = Object.keys(parent).find((k) =>
        platform === "win32" ? k.toLowerCase() === "path" : k === "PATH",
      );
      const parentPath =
        parentPathKey !== undefined ? parent[parentPathKey]! : "";
      const targetKey = parentPathKey ?? pathKey;
      const pathDelim = platform === "win32" ? ";" : ":";
      const mergedPath =
        manifestPath === ""
          ? parentPath // Empty manifest PATH: leave the parent PATH unchanged.
          : parentPath
            ? `${parentPath}${pathDelim}${manifestPath}`
            : manifestPath;
      if (platform === "win32") {
        // Collapse case-variant duplicate PATH keys (e.g. parent `Path` + manifest `PATH`).
        for (const k of Object.keys(merged)) {
          if (k !== targetKey && k.toLowerCase() === "path") delete merged[k];
        }
      }
      merged[targetKey] = mergedPath;
    }
  }
  return merged;
}

/**
 * Env KEY NAMES only, for logging — INV-2/INV-3. Never returns values, so no
 * secret can reach a log line or the structured result through this path.
 */
export function logEnvKeys(env: EnvMap): string[] {
  return Object.keys(env).sort();
}

/**
 * Replace control characters that could forge log lines when embedded in env
 * key names (INV-3). The real env keys are untouched; only the log line is
 * sanitized.
 */
function sanitizeLogKey(key: string): string {
  return key.replace(/[\p{Cc}\u2028\u2029]/gu, "?");
}

/**
 * Redact secret-looking PARENT env values from a string (INV-2 hardening).
 * Only the pre-merge parent env is consulted: manifest-supplied values (e.g.
 * the QDS_PROBE probe) are never redacted.
 *
 * Candidates are processed longest-value-first so a shorter secret that is a
 * substring of a longer one cannot replace inside the longer occurrence and
 * leave the longer secret's tail leaking.
 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export function redactSecrets(text: string, parentEnv: EnvMap): string {
  const entries = Object.entries(parentEnv)
    .filter(
      ([key, value]) =>
        value.length >= MIN_REDACTABLE_VALUE_LEN && SECRET_KEY_RE.test(key),
    )
    .sort((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) return text;

  const valueToKey = new Map<string, string>();
  const patterns: string[] = [];
  for (const [key, value] of entries) {
    if (!valueToKey.has(value)) {
      valueToKey.set(value, key);
      patterns.push(escapeRegex(value));
    }
  }
  const re = new RegExp(patterns.join("|"), "g");
  return text.replace(re, (match) => `[REDACTED:${valueToKey.get(match)!}]`);
}

/**
 * Length of the longest prefix of `value` that is also a suffix of `text`
 * (0 if no non-empty prefix qualifies). Linear time via the KMP automaton:
 * O(value.length) to build the failure function, O(text.length) to scan — so
 * boundary redaction of an arbitrarily long secret is O(text.length +
 * value.length) per env var, not the O(text × value) quadratic the naive
 * suffix scan hits on adversarial divergent input. Only tests UTF-16 code-unit
 * equality, never slices into the middle of a surrogate pair.
 */
function longestPrefixSuffix(text: string, value: string): number {
  if (value.length === 0 || text.length === 0) return 0;
  // KMP failure function for the pattern (value).
  const pi = new Array<number>(value.length).fill(0);
  for (let i = 1, k = 0; i < value.length; i++) {
    while (k > 0 && value[i] !== value[k]) k = pi[k - 1]!;
    if (value[i] === value[k]) k++;
    pi[i] = k;
  }
  // Drive the automaton over text; the terminal state is the longest prefix of
  // `value` that is a suffix of `text`. On a full match mid-text, reset j to the
  // longest proper border so the scan can keep looking for further matches — but
  // at the terminal position PRESERVE j === value.length: if text ends with the
  // complete value, the longest qualifying prefix is the value itself, not a
  // smaller border. The caller's `k >= value.length` fallback decides policy
  // (redactSecrets already removed complete occurrences); the helper just reports
  // the true prefix-suffix length.
  let j = 0;
  for (let i = 0; i < text.length; i++) {
    while (j > 0 && text[i] !== value[j]) j = pi[j - 1]!;
    if (text[i] === value[j]) j++;
    if (j === value.length && i < text.length - 1) j = pi[j - 1]!;
  }
  return j;
}

/**
 * Redact a TRAILING partial prefix of a secret value left at the truncation
 * cut boundary (INV-2). When the excerpt was capped mid-value, the full value
 * no longer matches — but its prefix at the cut still leaks.
 *
 * If the trailing fragment is at least MIN_BOUNDARY_PREFIX_LEN, it is replaced
 * with a redaction marker. If it is shorter than that minimum, the fragment is
 * stripped entirely (no marker, no leaked secret characters, no output
 * mangling).
 */
export function redactBoundaryPrefix(text: string, parentEnv: EnvMap): string {
  let bestRedact: { key: string; len: number } | null = null;
  let bestStrip = 0;

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value.length < MIN_REDACTABLE_VALUE_LEN || !SECRET_KEY_RE.test(key)) {
      continue;
    }
    // Largest k where text ends with value[0..k) — the true prefix-suffix
    // length, in linear time. The previous capped scan (maxK ≤ 4096) leaked the
    // WHOLE fragment when a >4KB secret prefix sat at the truncation cut: no
    // k ≤ 4096 matched the true length, so nothing was redacted. KMP has no cap,
    // so the full boundary prefix is redacted regardless of secret length.
    let k = longestPrefixSuffix(text, value);
    if (k === 0) continue;
    // Complete occurrences are already removed by redactSecrets() before this
    // scan; cap defensively excludes a full trailing match.
    if (k >= value.length) k = value.length - 1;
    if (k >= MIN_BOUNDARY_PREFIX_LEN) {
      if (bestRedact === null || k > bestRedact.len) {
        bestRedact = { key, len: k };
      }
    } else if (k > bestStrip) {
      bestStrip = k;
    }
  }

  if (bestRedact !== null) {
    return `${text.slice(0, text.length - bestRedact.len)}[REDACTED:${bestRedact.key}]`;
  }
  if (bestStrip > 0) {
    return text.slice(0, text.length - bestStrip);
  }
  return text;
}

/** Watchdog grace after a kill before force-settling (grandchild stdout-hold). */
export const WATCHDOG_GRACE_MS = 5000;

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
      // Skip decoder.end() once truncated: after a mid-sequence cut it would
      // append U+FFFD. The cap is re-applied in settle either way.
      if (!truncated) stdout += decoder.end();
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
      // Skip decoder.end() once truncated: after a mid-sequence cut it would
      // append U+FFFD. The cap is re-applied in settle either way.
      if (!truncated) stdout += decoder.end();
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

/**
 * Hard cap on captured lead-run stdout kept in memory for the team path
 * (F15): unlike runManifest's byte-capped excerpt, the team handler parsed
 * NDJSON lines into an unbounded `lineBuffer` — a malicious/buggy lead
 * emitting an endless newline-less stream grew memory without bound (OOM).
 * 1 MiB is far above any legitimate event line; oversize lines are dropped.
 */
export const MAX_TEAM_STDOUT_BYTES = 1024 * 1024;

/** Split a `provider/model` role string at the FIRST slash (CC-2 amended). */
export function splitRoleModel(roleModel: string): {
  provider: string;
  model: string;
} {
  const idx = roleModel.indexOf("/");
  // Defensive: zod validation requires a "/", but programmatic callers can
  // bypass it — without this guard, slice(0, -1) mangles both halves.
  if (idx === -1) {
    return { provider: "", model: roleModel };
  }
  return { provider: roleModel.slice(0, idx), model: roleModel.slice(idx + 1) };
}

/**
 * Build the real Warren 0.10.0 invocation for the team lead (CC-2 amended
 * 2026-07-20): `warren run pi <project> -p "<prompt>" --provider --model`.
 * Worker role-models ride in QDS_AGENT_TEAM_CONFIG_JSON env (agent-team
 * extension config), NOT in Warren CLI flags.
 *
 * Runtime provider selection (mirrors warren's own WARREN_RUNTIME pattern):
 * `QDS_TEAM_RUNNER=local` swaps the warren-server dispatch for the local
 * subprocess-RPC lead driver (`scripts/team-lead-driver.ts`, OQ-1 zero-infra
 * path) — same event protocol, same merged-output contract, no server.
 */
export function buildTeamSpawn(
  manifest: TeamManifest,
  runner: "warren" | "local" = "warren",
): {
  file: string;
  argv: string[];
} {
  if (runner === "local") {
    return {
      file: "bun",
      argv: [join(import.meta.dir, "..", "scripts", "team-lead-driver.ts")],
    };
  }
  const lead = splitRoleModel(manifest.team.lead.model);
  return {
    file: "warren",
    argv: [
      "run",
      "pi",
      manifest.team.project,
      "-p",
      manifest.team.lead.prompt,
      "--provider",
      lead.provider,
      "--model",
      lead.model,
      "--trigger",
      "cli-anything",
    ],
  };
}

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
}

/** One parsed NDJSON event from the lead run's stdout. */
type TeamEvent =
  | { kind: "cost"; event: CostEvent }
  | { kind: "coms"; raw: unknown }
  | { kind: "worker_output"; agentId: string; output: unknown }
  | { kind: "merged"; result: Record<string, unknown> }
  | { kind: "coms_init_error"; reason: string };

/** Parse one stdout line into a team event; null for non-event lines. */
function parseTeamEventLine(line: string): TeamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case "cost": {
      const costUsd = o.costUsd;
      if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
        return null;
      }
      return {
        kind: "cost",
        event: {
          agentId: typeof o.agentId === "string" ? o.agentId : "unknown",
          model: typeof o.model === "string" ? o.model : "unknown",
          inputTokens: typeof o.inputTokens === "number" ? o.inputTokens : 0,
          outputTokens: typeof o.outputTokens === "number" ? o.outputTokens : 0,
          costUsd,
          durationMs: typeof o.durationMs === "number" ? o.durationMs : 0,
          timestamp: typeof o.timestamp === "string" ? o.timestamp : "",
        },
      };
    }
    case "coms":
      return { kind: "coms", raw: o };
    case "worker_output": {
      if (typeof o.agentId !== "string") return null;
      return { kind: "worker_output", agentId: o.agentId, output: o.output };
    }
    case "merged": {
      const result = o.result;
      return {
        kind: "merged",
        result:
          typeof result === "object" && result !== null && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : {},
      };
    }
    case "coms_init_error":
      return {
        kind: "coms_init_error",
        reason: typeof o.reason === "string" ? o.reason : "unknown",
      };
    default:
      return null;
  }
}

/** Atomic write: tmpfile + rename (P0.3-S-M4, mirrors writeRegistryAtomic). */
function writeArtifactAtomic(dir: string, name: string, data: unknown): void {
  const tmp = join(dir, `.${name}.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, join(dir, `${name}.json`));
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

  const budgetCapUsd = opts.budgetCapUsd ?? manifest.team.budgetCapUsd;
  const killThresholdUsd = budgetCapUsd * BUDGET_KILL_FRACTION;
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
    let budgetKilled = false;
    let wallTimedOut = false;
    let settled = false;
    let child: ChildProcess | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

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

    function settle(
      exitStatus: MergedOutput["exitStatus"],
      partial: boolean,
      error: MergedError | null,
      agentOutputsOverride?: Record<string, unknown>,
    ): void {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      removeSignalHandlers();

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
        }),
      );
    }

    function removeSignalHandlers(): void {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (process.platform !== "win32") {
        process.removeListener("SIGHUP", onSighup);
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
    } catch (err) {
      const code =
        err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      settle("transient", false, {
        reason: "transient",
        message: `warren spawn failed${code !== undefined ? ` (${code})` : ""}`,
      });
      return;
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
          details: { cumulativeCostUsd },
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
            details: { cumulativeCostUsd },
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
        if (event !== null) {
          switch (event.kind) {
            case "cost":
              // Budget poll AFTER each turn (P0.3-S-H4): synchronous check.
              cumulativeCostUsd += event.event.costUsd;
              if (cumulativeCostUsd >= killThresholdUsd) onBudgetThreshold();
              break;
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
        lineBuffer += decoder.write(bytes);
        teamStdoutBytes += bytes.length;
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
        // precedence: budget/wall-clock kill → overflow regardless of signal).
        if (budgetKilled || wallTimedOut) {
          settle("overflow", true, {
            reason: "overflow",
            message: budgetKilled
              ? `budget kill threshold $${killThresholdUsd.toFixed(4)} reached (cap $${budgetCapUsd.toFixed(2)})`
              : `wall-clock cap ${wallClockCapMs} ms exceeded`,
            details: { cumulativeCostUsd },
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
      if (settled || closed) return;
      arm(WATCHDOG_GRACE_MS, () => {
        if (!closed) finalize(code, signal);
      });
    });

    child.on("close", (code, signal) => {
      closed = true;
      finalize(code, signal);
    });
  });
}
