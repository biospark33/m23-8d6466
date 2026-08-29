/**
 * Env merge + log-safe env key handling (INV-1 / INV-3). Extracted verbatim
 * from runner.ts (#62) — pure, independently testable, no behaviour change.
 */

export type EnvMap = Record<string, string>;

/** Max env key names shown in the log line (INV-3: key names only). */
export const MAX_LOGGED_ENV_KEYS = 50;

/**
 * True when routine observability output should be muted: `bun test` sets
 * NODE_ENV=test and the noise buried real failures (#53). `QDS_LOG_VERBOSE=1`
 * brings it back for a suite. Read at call time, not module load, so a test
 * can toggle it. Mirrors src/swarmclaw/log.ts's logMuted() — same predicate,
 * duplicated rather than imported because cli-anything is a separate package
 * with its own tsconfig and is excluded from the root project.
 */
export function logMuted(): boolean {
  return process.env.NODE_ENV === "test" && !process.env.QDS_LOG_VERBOSE;
}

/**
 * Routine per-run diagnostics (env key names, provider-key presence). Quiet
 * under `bun test` (Bun sets NODE_ENV=test) because they buried real failures
 * in test output (#53); `QDS_LOG_VERBOSE=1` brings them back for a suite.
 * Warnings and errors do NOT go through here — they always print.
 */
export function diag(message: string): void {
  if (logMuted()) return;
  console.error(message);
}

/** Drop undefined-valued entries — process.env values may be undefined. */
export function cleanEnv(env: NodeJS.ProcessEnv): EnvMap {
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
export function sanitizeLogKey(key: string): string {
  return key.replace(/[\p{Cc}\u2028\u2029]/gu, "?");
}
