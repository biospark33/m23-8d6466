/**
 * exe.dev shared transport (DF2.2) — the LOW module every exedev layer imports.
 *
 * Layering (review round 1): driver.ts composes the high-level lifecycle
 * (`fill`/`setup`) out of fill.ts and setup-gate.ts, while those modules need
 * the driver's own runtime primitives (shQuote, the error shape, …) back — a
 * module cycle driver → fill → driver (extended to a triangle via setup-gate.ts)
 * that CJS output and bundlers can observe as partially-initialized bindings.
 * The cycle is broken by rank: everything two or more layers need at runtime
 * lives HERE, imports nothing from the sibling modules, and each of driver.ts /
 * fill.ts / setup-gate.ts imports it one-way. fill.ts and setup-gate.ts import
 * driver.ts TYPE-ONLY (erased at compile time), so no runtime edge points up.
 */

import type { ExecResult } from "../driver.ts";
import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../bounded-exec.ts";
import { withTimeout } from "../timeout.ts";
import { ProviderError } from "../errors.ts";

/** DF2.3's error shape: machine `code`, human message, literal next command. */
export class ExeDevDriverError extends ProviderError {
  constructor(code: string, message: string, remediation: string) {
    super(code, message, remediation);
    this.name = "ExeDevDriverError";
  }
}

// ─── the command seam ───────────────────────────────────────────────────────

/**
 * One process invocation (argv + optional stdin + timeout). Structural seam:
 * the fake substrate in tests/providers/exedev/fixtures/fake-exedev.ts provides
 * a structurally identical function without importing this module.
 */
export type ExeCommand = (
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<ExecResult>;

/** Default per-command ceiling; the gate passes tighter, per-assertion budgets. */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/**
 * The production seam: run argv (ssh/scp) via Bun.spawn. `timeout` + SIGKILL
 * bound every call — `POST https://exe.dev/exec` is capped at 30 s / 64 KB
 * [VERIFY], which is exactly why every exec path here is SSH instead.
 */
export function sshCommand(defaultTimeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS): ExeCommand {
  return async (argv, opts) => { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    // Headless host-key handling (official exe.dev skill + docs/faq/host-key):
    // first contact with a fresh `<vm>.exe.xyz` prompts for a host key, and with
    // stdin ignored the prompt is unreadable — every exec to a NEW VM would die
    // "Host key verification failed" (exit 255). TOFU via accept-new is the
    // skill's own recommendation for non-interactive agents. (Fingerprint
    // pinning — SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo — is
    // deployment hardening, an ssh_config/known_hosts concern, not the driver's.)
    const cmd =
      argv[0] === "ssh" || argv[0] === "scp"
        ? [argv[0], "-o", "StrictHostKeyChecking=accept-new", ...argv.slice(1)]
        : argv;
    const proc = Bun.spawn({
      cmd,
      env: process.env,
      stdin: opts?.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: Math.max(1, opts?.timeoutMs ?? defaultTimeoutMs), /* dp:ok defensive clamp; callers pass validated budgets */
      killSignal: "SIGKILL",
    });
    const kill = () => {
      proc.kill(9);
    };
    const [out, err, exitCode] = await Promise.all([
      readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, { kill, exited: proc.exited }),
      readBounded(proc.stderr, EXEC_MAX_OUTPUT_BYTES, { kill, exited: proc.exited }),
      proc.exited,
    ]);
    return {
      stdout: out.text,
      stderr: err.text,
      exitCode,
      ...(out.truncated || err.truncated ? { truncated: true } : {}),
    };
  };
}

/** POSIX single-quote wrapping — the only serializer used on the box side. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * F017: the ONE quoter. `fanout-primitive.ts`, `scripts/pipeline-run-remote.ts`
 * and `tests/fleet/patterns.test.ts` each carried a byte-identical hand-written
 * copy under this name; they now import this one.
 *
 * ponytail: an ALIAS, not a rename — `shQuote` has 9 upstream call sites
 * (gitnexus impact: CRITICAL) including its own pinned suite and
 * `scripts/cap-hit-demo.ts`. One implementation, one extra name; collapse to
 * `shellQuote` when those call sites are in scope to touch.
 */
export const shellQuote = shQuote;

/**
 * Read one file OFF a box: presence probe, then `cat`, each bounded by its own
 * `deadlineMs`. Lives HERE, in the providers layer, because it is the only
 * place the `sh -c` strings may be BUILT — `src/fleet/dispatch.ts:63-66` states
 * the DoD as "no substrate command string under `src/fleet/`", and the fanout
 * race probes used to break it.
 *
 * "absent" is a CLEAN read (the file is simply not there), distinct from
 * "unreadable" (present at `test -f`, nonzero at `cat`) — the fanout race
 * counts those differently and must not conflate them.
 */
export type BoxFileRead =
  | { kind: "absent" }
  | { kind: "unreadable"; exitCode: number; stderr: string }
  | { kind: "content"; content: string };

export async function readBoxFile(
  driver: { exec: (vm: string, argv: string[], stdin?: string) => Promise<ExecResult> },
  vm: string,
  path: string,
  deadlineMs: number,
): Promise<BoxFileRead> { // dp:ok sole caller probeArm (fanout-primitive.ts:738) wraps the call in try/catch and records a skipped tick
  const probe = await withTimeout(driver.exec(vm, ["sh", "-c", `test -f ${shellQuote(path)}`]), deadlineMs, "race-probe");
  if (probe.exitCode !== 0) return { kind: "absent" };
  // MEASURED live 2026-08-26 (fan-20260826-f04c3c): the read goes through the
  // SAME exec channel as the presence probe. copyFile is box-RELATIVE by
  // driver contract (assertBoxPathSafe) while `runMarkerPath()` is ABSOLUTE
  // (/run/journal/final.json) — a copyFile read died "remote-path-invalid" on
  // every tick and the race spun to its ceiling with the marker present and
  // the winner never claimed.
  const read = await withTimeout(driver.exec(vm, ["sh", "-c", `cat ${shellQuote(path)}`]), deadlineMs, "race-read");
  if (read.exitCode !== 0) return { kind: "unreadable", exitCode: read.exitCode, stderr: read.stderr };
  // A capped read is a PREFIX. Handing it back as `content` would let a
  // half-written marker parse as a whole one — unreadable is the honest kind.
  if (read.truncated) {
    return { kind: "unreadable", exitCode: read.exitCode, stderr: `output exceeded the ${EXEC_MAX_OUTPUT_BYTES}-byte capture cap` };
  }
  return { kind: "content", content: read.stdout };
}
