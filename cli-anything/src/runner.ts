import { type ChildProcess, execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { parseManifestFile } from "./manifest.ts";
import type { ExitClass, HarnessResult, Manifest } from "./types.ts";

/** Default wall-clock timeout for a harness invocation: 10 minutes. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Hard cap on captured subprocess stdout kept in memory / emitted. */
export const MAX_STDOUT_EXCERPT = 256 * 1024;

/** Hard cap on the extracted QDS_PROBE value. */
const MAX_PROBE_RESULT_LEN = 1024;

/** Max env key names shown in the log line (INV-3: key names only). */
const MAX_LOGGED_ENV_KEYS = 50;

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
    // ponytail: cap the boundary scan at 4096. The scan is O(text × value) in
    // the adversarial worst case (a long prefix that matches the text tail then
    // diverges mid-string defeats both early-breaks → ~10^10 comparisons on a
    // ~200KB secret). Known ceiling: a truncation-cut PARTIAL fragment of a
    // secret longer than 4KB (e.g. a PEM private key) leaks its leading
    // (len−4096) chars — complete occurrences are already removed by
    // redactSecrets() before this scan, so only that partial-at-the-cut case
    // escapes. Raising the cap re-opens the quadratic cost (~maxK²/2 ops), so
    // widen it only with a matching wall-clock regression test.
    const maxK = Math.min(text.length, value.length - 1, 4096);
    for (let k = maxK; k >= 1; k--) {
      // Compare characters directly instead of text.endsWith(value.slice(0, k)):
      // the slice form allocates a fresh string per k, which for multi-KB
      // secrets (certs, private keys) means thousands of transient strings.
      const offset = text.length - k;
      let match = true;
      for (let i = 0; i < k; i++) {
        if (text[offset + i] !== value[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        if (k >= MIN_BOUNDARY_PREFIX_LEN) {
          if (bestRedact === null || k > bestRedact.len) {
            bestRedact = { key, len: k };
          }
        } else if (k > bestStrip) {
          bestStrip = k;
        }
        break;
      }
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
  console.error(
    `cli-anything: env keys -> ${shown.map(sanitizeLogKey).join(",")}`,
  );

  return await new Promise<HarnessResult>((resolve) => {
    let child: ChildProcess | null = null;
    const decoder = new StringDecoder("utf8");
    let stdout = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** Kill the whole child tree: process group on POSIX, taskkill /T on win32. */
    function killChildTree(): void {
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
      }, 5000);
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
