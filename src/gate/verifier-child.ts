/**
 * Spawning helper for the Phase-0 gate (Story P0.11).
 *
 * Several Phase-0 stories already ship their own verifier that emits a
 * `{results, summary}` verdict on stdout and sets an exit code. The gate
 * REUSES those rather than re-probing, per P0.11's own instruction for P0.6.
 *
 * They must be spawned, never imported: both `scripts/lsp-verify.ts` and
 * `scripts/pi-lens-verify.ts` mutate `process.env.PILENS_DATA_DIR` on the
 * CURRENT process, so importing them would corrupt the gate's own env.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Shape execFile attaches to its rejection when a child exits non-zero. */
interface ExecFileError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals;
  stdout?: string;
  stderr?: string;
}

export interface VerifierCheck {
  ac: string;
  name: string;
  status: "pass" | "fail" | "skip";
  evidence?: Record<string, unknown>;
  reason?: string;
  optional?: boolean;
  storyLevelStatus?: "met" | "partial";
  storyLevelNote?: string;
}

export interface VerifierVerdict {
  results?: VerifierCheck[];
  summary?: Record<string, unknown>;
}

export interface VerifierRun {
  /** null when the child could not be spawned at all. */
  exitCode: number | null;
  verdict?: VerifierVerdict;
  stdout: string;
  stderrTail: string;
  spawnError?: string;
  parseError?: string;
}

/**
 * Spawns a bun script and parses its JSON verdict. Never throws.
 *
 * Async (not `spawnSync`) on purpose: a synchronous spawn blocks the event
 * loop, which would make the gate runner's per-assertion timeout structurally
 * unable to fire and would serialise the whole assertion pool.
 */
export async function runVerifier(
  scriptPath: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<VerifierRun> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  let spawnError: string | undefined;

  try {
    const res = await execFileAsync("bun", [scriptPath, ...args], {
      cwd: opts.cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: opts.env ?? process.env,
    });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err) {
    const e = err as ExecFileError;
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    if (typeof e.code === "number") {
      // A non-zero exit is a normal verdict, not a spawn failure.
      exitCode = e.code;
    } else if (e.killed === true) {
      exitCode = null;
      spawnError = `verifier exceeded its ${opts.timeoutMs}ms budget and was killed`;
    } else {
      exitCode = null;
      spawnError = e.message;
    }
  }

  const stderrTail = stderr.slice(-2000);
  if (spawnError !== undefined) {
    return { exitCode: null, stdout, stderrTail, spawnError };
  }

  let verdict: VerifierVerdict | undefined;
  let parseError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed !== null && typeof parsed === "object") verdict = parsed as VerifierVerdict;
    else parseError = "verdict was not a JSON object";
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  return { exitCode, verdict, stdout, stderrTail, parseError };
}

/** Finds a named check in a verifier verdict, by its `ac` field. */
export function findCheck(run: VerifierRun, ac: string): VerifierCheck | undefined {
  return run.verdict?.results?.find((c) => c.ac === ac);
}

/**
 * The leading, human-meaningful line of a stderr dump.
 *
 * A raw tail slice cuts into the middle of a stack-trace path and reads as
 * gibberish in the gate's failure list; the first non-empty line is the actual
 * error message.
 */
function leadingError(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("at "));
  return (line ?? stderr.trim().split("\n")[0] ?? "no stderr").slice(0, 300);
}

/** One-line summary of why a verifier run was not usable, or undefined if it was. */
export function verifierUnusable(run: VerifierRun): string | undefined {
  if (run.spawnError) return `could not spawn verifier: ${run.spawnError}`;
  // Exit 2 is the shared "fatal before any check ran" code in this repo's
  // harnesses (e.g. pi-lens could not be resolved at all).
  if (run.exitCode === 2) return `verifier exited 2 (fatal before checks ran): ${leadingError(run.stderrTail)}`;
  if (run.parseError) return `verifier emitted no parseable JSON verdict (${run.parseError})`;
  if (!run.verdict?.results) return "verifier verdict contained no results array";
  return undefined;
}
