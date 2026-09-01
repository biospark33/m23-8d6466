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
  /** Present, but permanently over the capture cap — never a transient read
   * failure, so callers must not retry it hoping for a different outcome. */
  | { kind: "oversized" }
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
  // half-written marker parse as a whole one. It is also not a TRANSIENT
  // failure like a nonzero `cat`: the marker is present and this size is
  // permanent, so a caller that retries on "unreadable" would poll it
  // forever instead of ever counting it against the arm's streak.
  if (read.truncated) {
    return { kind: "oversized" };
  }
  return { kind: "content", content: read.stdout };
}

// ─── factory image marker (DF2.10 INV-IBOX-2) ───────────────────────────────

// This contract lives in transport.ts, not driver.ts, for a LAYERING reason:
// driver.ts imports setup-gate.ts for `setupGate`, so a value import back the
// other way would be a real ESM cycle. transport.ts is the LOW module both
// already import one-way (header rationale), and `readBoxFile` — the reader
// this marker is read with — is right above. driver.ts re-exports all of it,
// so the module's public surface is unchanged.

/** Where the image states its own identity. The ONLY in-box identity source. */
export const IMAGE_MARKER_PATH = "/etc/qds-image.json";

/**
 * Read cap for the marker (AC1c).
 *
 * The marker is six short strings — the built image's is 154 bytes. Anything
 * over this is not our marker and is REFUSED rather than parsed. Note this is
 * far tighter than the transport's own `EXEC_MAX_OUTPUT_BYTES` (512 KiB): that
 * cap stops a box exhausting host memory, this one stops a box handing the gate
 * something it should never have been willing to consider.
 */
export const IMAGE_MARKER_MAX_BYTES = 4096;

/** The six keys `oci/exedev/Dockerfile` bakes into {@link IMAGE_MARKER_PATH}. */
export interface QdsImageMarker {
  imageRef: string;
  buildId: string;
  piVersion: string;
  bunVersion: string;
  builtAt: string;
  gitSha: string;
}

/**
 * The `sha256:…` half of a reference, or `null` for a tag pin (AC1b).
 *
 * Logged rather than asserted: it is the join key between a boot regression and
 * the image that caused it. `null` is not a failure — it is the honest record
 * that this box was pinned by immutable tag because `--image` refused a digest.
 */
export function imageDigestOf(ref: string): string | null {
  const at = ref.lastIndexOf("@");
  return at < 0 ? null : ref.slice(at + 1);
}

/**
 * Parse the in-box marker. Fail CLOSED: every arm refuses rather than defaults,
 * because a box that cannot state what it booted is not a factory box.
 */
export function parseImageMarker(text: string): QdsImageMarker {
  const refuse = (why: string): never => {
    throw new ExeDevDriverError(
      "image-marker-mismatch",
      `${IMAGE_MARKER_PATH} ${why}`,
      `ssh <vm> 'cat ${IMAGE_MARKER_PATH}'  # inspect what the box actually booted`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    refuse(`is not parseable JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse("is not a JSON object");
  }
  const rec = parsed as Record<string, unknown>;
  const keys: (keyof QdsImageMarker)[] = ["imageRef", "buildId", "piVersion", "bunVersion", "builtAt", "gitSha"];
  const missing = keys.filter((k) => typeof rec[k] !== "string" || (rec[k] as string).length === 0);
  if (missing.length > 0) {
    refuse(`is missing or empty for: ${missing.join(", ")}`);
  }
  return {
    imageRef: rec.imageRef as string,
    buildId: rec.buildId as string,
    piVersion: rec.piVersion as string,
    bunVersion: rec.bunVersion as string,
    builtAt: rec.builtAt as string,
    gitSha: rec.gitSha as string,
  };
}

/**
 * Judge a marker read against the repo pin — the whole of INV-IBOX-2's in-box
 * half. Returns a gate note on refusal, or `null` when the box proved itself.
 *
 * Fail-closed on EVERY arm: absent, unreadable, over-cap, unparseable, or
 * mismatched. A host-side pull check proves nothing about the box that actually
 * booted, so this is the only assertion in the system that can speak to image
 * identity at all — and a box that cannot state what it booted is refused
 * before any run is dispatched.
 */
export function imageMarkerFailure(read: BoxFileRead, expectedBuildId: string): string | null {
  const prefix = `B: ${IMAGE_MARKER_PATH}`;
  if (read.kind === "absent") {
    return `${prefix} is absent — this box did not boot a factory image (INV-IBOX-2: a box that cannot state what it booted is not a factory box)`;
  }
  if (read.kind === "unreadable") {
    return `${prefix} could not be read (exit ${read.exitCode}): ${read.stderr.trim().slice(0, 200)}`;
  }
  if (read.kind === "oversized") {
    return `${prefix} exceeds the transport read cap — refused unparsed`;
  }
  if (read.content.length > IMAGE_MARKER_MAX_BYTES) {
    return `${prefix} is ${read.content.length} bytes, over the ${IMAGE_MARKER_MAX_BYTES}-byte cap — refused unparsed`;
  }
  let marker: QdsImageMarker;
  try {
    marker = parseImageMarker(read.content);
  } catch (e) {
    return `${prefix}: ${(e as Error).message}`;
  }
  if (marker.buildId !== expectedBuildId) {
    return `${prefix} buildId ${JSON.stringify(marker.buildId)} != the repo pin ${JSON.stringify(expectedBuildId)} — the box booted an image this repo does not pin (imageRef in marker: ${marker.imageRef})`;
  }
  return null;
}
