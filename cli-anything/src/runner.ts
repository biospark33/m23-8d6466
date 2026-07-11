import { spawn } from "node:child_process";
import { delimiter as PATH_DELIM } from "node:path";
import { parseManifestFile } from "./manifest.ts";
import type { HarnessResult, Manifest } from "./types.ts";

/** Default wall-clock timeout for a harness invocation: 10 minutes. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

type EnvMap = Record<string, string>;

/**
 * Merge manifest env onto parent env — INV-1: additive merge, never a bare
 * assignment. A manifest with no env block still inherits the full parent env
 * (PATH, credentials, ...), so this is a non-regression by construction.
 *
 * PATH is special-cased (AC3): a manifest PATH does NOT replace the parent
 * PATH — it is APPENDED (`parent + delimiter + manifest`). This keeps the
 * parent's real binaries reachable while letting a step extend the search
 * path, and makes clobbering the inherited PATH impossible via the manifest.
 * Every other key follows plain last-wins `{ ...parent, ...manifest }` merge.
 */
export function mergeEnv(parent: EnvMap, manifestEnv: EnvMap | undefined): EnvMap {
  const merged: EnvMap = { ...parent, ...manifestEnv };
  if (manifestEnv?.PATH !== undefined) {
    const parentPath = parent.PATH ?? "";
    merged.PATH = parentPath
      ? `${parentPath}${PATH_DELIM}${manifestEnv.PATH}`
      : manifestEnv.PATH;
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
  const value = line.slice("QDS_PROBE=".length);
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
 * stdout, and return the structured harness result.
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
  const parent = (opts.env ?? process.env) as EnvMap;
  const env = mergeEnv(parent, manifest.env);
  const { file, argv } = buildSpawn(manifest);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // INV-3: log key names only — never values, never a process.env dump.
  console.error(`cli-anything: env keys -> ${logEnvKeys(env).join(",")}`);

  return await new Promise<HarnessResult>((resolve) => {
    // stderr is ignored (not piped): the harness captures subprocess stdout
    // only, and an unread stderr pipe can delay `close` under some runtimes.
    const child = spawn(file, argv, { env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exit_class: "spawn_error", stdout_excerpt: stdout, env_probe_result: null });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const exit_class = timedOut ? "timeout" : code === 0 ? "ok" : "nonzero";
      resolve({
        exit_class,
        stdout_excerpt: stdout,
        env_probe_result: extractProbe(stdout),
      });
    });
  });
}
