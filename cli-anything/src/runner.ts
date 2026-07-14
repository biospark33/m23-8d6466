import { type ChildProcess, execFile, spawn } from "node:child_process";
import { delimiter as PATH_DELIM } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseManifestFile } from "./manifest.ts";
import type { HarnessResult, Manifest } from "./types.ts";

/** Default wall-clock timeout for a harness invocation: 10 minutes. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Hard cap on captured subprocess stdout kept in memory / emitted. */
export const MAX_STDOUT_EXCERPT = 256 * 1024;

/** Max env key names shown in the log line (INV-3: key names only). */
const MAX_LOGGED_ENV_KEYS = 50;

/**
 * Parent-env KEY NAMES whose values look secret-ish. Values under such keys
 * are redacted from stdout_excerpt / env_probe_result (INV-2 hardening).
 * Heuristic: high-signal secret-bearing key patterns only, plus the
 * MIN_REDACTABLE_VALUE_LEN floor below.
 */
const SECRET_KEY_RE =
  /SECRET|TOKEN|PASS|CRED|API[_-]?KEY|PRIVATE|CERT|DSN|DATABASE_URL/i;

/** Short values are ignored to avoid mangling output with false positives. */
const MIN_REDACTABLE_VALUE_LEN = 8;

/** Minimum trailing-prefix length redacted at the truncation cut boundary. */
const MIN_BOUNDARY_PREFIX_LEN = MIN_REDACTABLE_VALUE_LEN;

/**
 * Enforce the excerpt cap (measured in UTF-16 code units, matching
 * String.prototype.length) without leaving a trailing unpaired surrogate
 * from a sliced pair.
 */
function capExcerpt(text: string): string {
  return text.slice(0, MAX_STDOUT_EXCERPT).replace(/[\uD800-\uDBFF]$/, "");
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
 * PATH leaves the parent PATH unchanged (no dangling delimiter). On win32 the
 * PATH key is matched case-insensitively in BOTH the manifest and the parent
 * env, the parent's original key casing is preserved, and case-variant
 * duplicate keys are collapsed. Every other key follows plain last-wins
 * `{ ...parent, ...manifest }` merge.
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
      const mergedPath =
        manifestPath === ""
          ? parentPath // Empty manifest PATH: leave the parent PATH unchanged.
          : parentPath
            ? `${parentPath}${PATH_DELIM}${manifestPath}`
            : manifestPath;
      if (platform === "win32") {
        // Collapse case-variant duplicates (e.g. parent `Path` + manifest `PATH`).
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
 * Redact secret-looking PARENT env values from a string (INV-2 hardening).
 * Only the pre-merge parent env is consulted: manifest-supplied values (e.g.
 * the QDS_PROBE probe) are never redacted.
 */
export function redactSecrets(text: string, parentEnv: EnvMap): string {
  let out = text;
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value.length >= MIN_REDACTABLE_VALUE_LEN && SECRET_KEY_RE.test(key)) {
      out = out.split(value).join(`[REDACTED:${key}]`);
    }
  }
  return out;
}

/**
 * Redact a TRAILING partial prefix of a secret value left at the truncation
 * cut boundary (INV-2). When the excerpt was capped mid-value, the full value
 * no longer matches — but its prefix at the cut still leaks. Checks the
 * longest proper prefix first so the biggest leak is redacted. Prefixes
 * shorter than MIN_BOUNDARY_PREFIX_LEN are left alone: redacting 1-char
 * fragments would mangle ordinary output and spray key names everywhere.
 */
function redactBoundaryPrefix(text: string, parentEnv: EnvMap): string {
  let out = text;
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value.length < MIN_REDACTABLE_VALUE_LEN || !SECRET_KEY_RE.test(key)) {
      continue;
    }
    for (let k = value.length - 1; k >= MIN_BOUNDARY_PREFIX_LEN; k--) {
      if (out.endsWith(value.slice(0, k))) {
        out = `${out.slice(0, out.length - k)}[REDACTED:${key}]`;
        break;
      }
    }
  }
  return out;
}

/** Build the `warren run <command> <args...>` invocation for a manifest. */
export function buildSpawn(manifest: Manifest): { file: string; argv: string[] } {
  return {
    file: "warren",
    argv: ["run", manifest.command, ...(manifest.args ?? [])],
  };
}

/** Pull the QDS_PROBE value out of subprocess stdout, if present. */
function extractProbe(stdout: string): string | null {
  const line = stdout.split("\n").find((l) => l.startsWith("QDS_PROBE="));
  if (line === undefined) return null;
  const value = line.slice("QDS_PROBE=".length).replace(/\r$/, "");
  return value.length > 0 ? value : null;
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
  const timeoutMs = Math.min(
    Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 0),
    2_147_483_647,
  );

  // INV-3: log key names only — never values, never a process.env dump.
  const keys = logEnvKeys(env);
  const shown =
    keys.length > MAX_LOGGED_ENV_KEYS
      ? [...keys.slice(0, MAX_LOGGED_ENV_KEYS), "..."]
      : keys;
  console.error(`cli-anything: env keys -> ${shown.join(",")}`);

  return await new Promise<HarnessResult>((resolve) => {
    let child: ChildProcess;
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
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      resolve({
        exit_class: "spawn_error",
        stdout_excerpt: "",
        env_probe_result: null,
        spawn_error_code: code ?? null,
        exit_code: null,
      });
      return;
    }

    const decoder = new StringDecoder("utf8");
    let stdout = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    /** Kill the whole child tree: process group on POSIX, taskkill /T on win32. */
    const killChildTree = (): void => {
      if (child.pid === undefined) {
        child.kill("SIGKILL");
        return;
      }
      if (process.platform === "win32") {
        // Tree kill on win32; swallow errors (process may already be gone).
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Process group already gone.
        }
      }
    };

    /** Forward a harness-terminating signal to the child tree, then re-raise. */
    const onSigint = (): void => handleSignal("SIGINT");
    const onSigterm = (): void => handleSignal("SIGTERM");
    const removeSignalHandlers = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    const handleSignal = (sig: "SIGINT" | "SIGTERM"): void => {
      removeSignalHandlers();
      killChildTree();
      // Re-raise against ourselves so the harness dies from the same signal.
      process.kill(process.pid, sig);
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const timer = setTimeout(() => {
      // The child may have exited (or been killed) between the timer firing
      // and this callback running: don't misclassify a natural exit as a
      // timeout, and don't signal a possibly-reused process group.
      if (child.exitCode !== null || child.killed) return;
      timedOut = true;
      killChildTree();
    }, timeoutMs);

    /** Resolve exactly once, redacting secrets on the way out (INV-2). */
    const settle = (result: HarnessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeSignalHandlers();
      let stdout_excerpt = redactSecrets(result.stdout_excerpt, parent);
      if (result.truncated === true) {
        // The cap may have cut a secret value in half: redact its trailing prefix.
        stdout_excerpt = redactBoundaryPrefix(stdout_excerpt, parent);
      }
      // Redaction can grow the excerpt ([REDACTED:key] is longer than the
      // matched value): re-apply the cap so the contract always holds.
      stdout_excerpt = capExcerpt(stdout_excerpt);
      const probe = result.env_probe_result;
      resolve({
        ...result,
        stdout_excerpt,
        env_probe_result: probe === null ? null : redactSecrets(probe, parent),
      });
    };

    child.stdout!.on("data", (d: Buffer) => {
      if (truncated) return;
      const remaining = MAX_STDOUT_EXCERPT - stdout.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (d.length > remaining) {
        // Bound the decode to the remaining capacity: a single oversized
        // chunk is never fully materialized past the cap (decoded UTF-16
        // code units <= input bytes, so the cap still holds).
        stdout += decoder.write(d.subarray(0, remaining));
        truncated = true;
      } else {
        stdout += decoder.write(d);
      }
    });

    child.stdout!.on("error", (err: NodeJS.ErrnoException) => {
      // Stream read failure: settle as spawn_error (guarded against double-settle).
      settle({
        exit_class: "spawn_error",
        stdout_excerpt: stdout,
        env_probe_result: null,
        spawn_error_code: err.code ?? null,
        exit_code: null,
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
        truncated,
      });
    });

    child.on("close", (code, signal) => {
      // Skip decoder.end() once truncated: after a mid-sequence cut it would
      // append U+FFFD. The cap is re-applied in settle either way.
      if (!truncated) stdout += decoder.end();
      // Prefer the real exit code when present: a child that exited naturally
      // at the instant the timeout fired is NOT a timeout.
      const exit_class =
        timedOut && code === null ? "timeout" : code === 0 ? "ok" : "nonzero";
      settle({
        exit_class,
        stdout_excerpt: stdout,
        // When truncated, the QDS_PROBE line may be cut mid-value and the full
        // pre-cap buffer is not retained: never report a silently truncated
        // probe as complete (and never leak a secret prefix through it).
        env_probe_result: truncated ? null : extractProbe(stdout),
        truncated,
        signal: signal ?? null,
        exit_code: code,
      });
    });
  });
}
