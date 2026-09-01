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
  /** `probeExit`/`probeStderr` carry the presence probe's own exit so a caller
   * can tell "the file is not there" from "the box never answered" — the probe
   * exiting 255 (ssh never connected) or 137 (SIGKILLed at the budget) is also
   * a non-zero `test -f`. Optional: absence is still absence without them. */
  | { kind: "absent"; probeExit?: number; probeStderr?: string }
  | { kind: "unreadable"; exitCode: number; stderr: string }
  /** Present, but permanently over the capture cap — never a transient read
   * failure, so callers must not retry it hoping for a different outcome. */
  | { kind: "oversized" }
  | { kind: "content"; content: string };

export async function readBoxFile(
  driver: {
    exec: (vm: string, argv: string[], stdin?: string) => Promise<ExecResult>;
    /** PREFERRED when present. `exec` hard-codes `DEFAULT_EXEC_TIMEOUT_MS`, so
     * `withTimeout` expiring only ABANDONS the ssh — the process keeps running
     * against the box for up to 120 s with its output discarded, past the very
     * deadline the caller set. `execTimed` passes `deadlineMs` down to the
     * spawn, so the budget kills the process instead of orphaning it.
     * Optional so a structural fake with only `exec` still satisfies this. */
    execTimed?: (vm: string, argv: string[], timeoutMs: number, stdin?: string) => Promise<ExecResult>;
  },
  vm: string,
  path: string,
  deadlineMs: number,
): Promise<BoxFileRead> { // dp:ok BOTH callers handle a rejection: probeArm (fanout-primitive.ts:743) wraps it in try/catch and records a skipped tick, setupGate (setup-gate.ts:478) converts it into the gate's refusal payload
  const run = (argv: string[]): Promise<ExecResult> =>
    driver.execTimed === undefined ? driver.exec(vm, argv) : driver.execTimed(vm, argv, deadlineMs);
  const probe = await withTimeout(run(["sh", "-c", `test -f ${shellQuote(path)}`]), deadlineMs, "race-probe");
  if (probe.exitCode !== 0) return { kind: "absent", probeExit: probe.exitCode, probeStderr: probe.stderr };
  // MEASURED live 2026-08-26 (fan-20260826-f04c3c): the read goes through the
  // SAME exec channel as the presence probe. copyFile is box-RELATIVE by
  // driver contract (assertBoxPathSafe) while `runMarkerPath()` is ABSOLUTE
  // (/run/journal/final.json) — a copyFile read died "remote-path-invalid" on
  // every tick and the race spun to its ceiling with the marker present and
  // the winner never claimed.
  const read = await withTimeout(run(["sh", "-c", `cat ${shellQuote(path)}`]), deadlineMs, "race-read");
  // A capped read is a PREFIX. Handing it back as `content` would let a
  // half-written marker parse as a whole one. It is also not a TRANSIENT
  // failure like a nonzero `cat`: the marker is present and this size is
  // permanent, so a caller that retries on "unreadable" would poll it
  // forever instead of ever counting it against the arm's streak.
  //
  // Checked BEFORE the exit code, deliberately: the cap breach KILLS the exec
  // (bounded-exec's `kill` seam, SIGKILL → exit 137), so a cap-hit read is
  // truncated AND non-zero at once. Exit-code-first classified it "unreadable",
  // and 137 upstream reads as a transport fault ("re-create the box") — a
  // retry loop against a condition this type documents as permanent. The
  // truncation is the stronger fact; it wins. (The flag cannot distinguish a
  // truncated stderr on a failed cat — exotic, and oversized is still the
  // fail-closed reading there.)
  if (read.truncated) {
    return { kind: "oversized" };
  }
  if (read.exitCode !== 0) return { kind: "unreadable", exitCode: read.exitCode, stderr: read.stderr };
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
 * The marker is six short strings — the shipped image's measured 238 bytes in
 * this story's live e2e round (the digest-pinned `imageRef` is most of it).
 * Anything over this is not our marker and is REFUSED rather than parsed. Note
 * this is far tighter than the transport's own `EXEC_MAX_OUTPUT_BYTES`
 * (512 KiB): that cap stops a box exhausting host memory, this one stops a box
 * handing the gate something it should never have been willing to consider.
 *
 * The cap is EXCLUSIVE and counted in BYTES, matching the producer:
 * `oci/exedev/Dockerfile` asserts `stat -c '%s' … -lt 4096`, so 4096 itself is
 * over the cap at both ends.
 */
export const IMAGE_MARKER_MAX_BYTES = 4096;

/**
 * Exit statuses that mean "the exec never got a real answer", not "the command
 * ran and refused". 137 is 128+SIGKILL (the exec budget, or a dropped
 * connection's local teardown); 255 is ssh's own exit for a connection that
 * never came up or died mid-flight. `driver.ts:113-114` holds a byte-identical
 * private pair for the steering-provision path — collapse them onto these when
 * that module is next in scope to touch.
 */
export const EXEC_KILLED_EXIT = 137;
export const EXEC_TRANSPORT_EXIT = 255;

/** The literal next command for any marker refusal the box could still answer. */
const INSPECT_MARKER_CMD = `ssh <vm> 'cat ${IMAGE_MARKER_PATH}'  # inspect what the box actually booted`;

/**
 * AC1c's payload shape — `ExeDevDriverError`'s three fields WITHOUT the throw.
 * A plain object, not the Error: this rides in `SetupGateResult`, which is
 * `JSON.stringify`d into the gate's evidence artifact, and an Error serialises
 * to `{}`.
 */
export interface MarkerFailure {
  /** Machine code (Observability Contract): `image-marker-mismatch` for a
   *  finding about the image, `image-marker-unreachable` for a transport fault. */
  code: string;
  message: string;
  remediation: string;
}

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
      INSPECT_MARKER_CMD,
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
 *
 * Returns AC1c's `{ code, message, remediation }` rather than a bare sentence:
 * the caller threads it into the gate payload, so a boot regression is
 * machine-classifiable (`code`) and self-remediating (`remediation`) instead of
 * an English string with a generic assertion code.
 */
export function imageMarkerFailure(read: BoxFileRead, expectedBuildId: string): MarkerFailure | null {
  const prefix = `B: ${IMAGE_MARKER_PATH}`;
  const finding = (message: string): MarkerFailure => ({
    code: "image-marker-mismatch",
    message,
    remediation: INSPECT_MARKER_CMD,
  });
  // A box that never ANSWERED is a transport fault, not a finding about the
  // image: `test -f` and `cat` both exit non-zero when ssh could not connect
  // (255) or the exec budget SIGKILLed the command (137), and neither says
  // anything about what the box booted. Still fail-CLOSED — the box is refused
  // either way — but refused for the right reason, so the operator checks the
  // network instead of auditing the image pin. Same classification (and the
  // same two statuses) as `steeringProvisionFailure` in driver.ts, for the
  // reason stated there: conflating a transport fault with a substrate finding
  // sends the operator to audit the wrong thing.
  const transportFault = (exitCode: number, stderr: string): MarkerFailure | null =>
    exitCode !== EXEC_KILLED_EXIT && exitCode !== EXEC_TRANSPORT_EXIT
      ? null
      : {
          code: "image-marker-unreachable",
          message: `${prefix} could not be read because the box never answered (exit ${exitCode} — ${
            exitCode === EXEC_KILLED_EXIT ? "SIGKILLed at the exec budget" : "ssh connection failed or dropped mid-flight"
          }): ${JSON.stringify(stderr.trim().slice(0, 200))} — a box/transport fault, NOT evidence about the image this box booted`,
          remediation:
            "ssh <vm>.exe.xyz true  # confirm the box answers at all, then re-create it; raise the gate budget only if the box is merely slow",
        };
  if (read.kind === "absent") {
    // "Absent" is a finding about the IMAGE only when the probe exited 1 —
    // `test -f`'s clean miss. 137/255 are the named transport statuses above;
    // every OTHER non-zero probe exit (143 = a box shutting down SIGTERMed the
    // probe, 126 = the remote sh itself failed) is a box that never cleanly
    // answered the question, and blaming the image for it sends the operator
    // to audit a pin the evidence says nothing about. Fail-closed either way.
    // (probeExit undefined — a caller that did not thread it — keeps the
    // absence reading: absence is still absence without it, per BoxFileRead.)
    if (read.probeExit !== undefined && read.probeExit !== 1) {
      return (
        transportFault(read.probeExit, read.probeStderr ?? "") ?? {
          code: "image-marker-unreachable",
          message: `${prefix} presence probe exited ${read.probeExit} — not \`test -f\`'s clean miss (exit 1), so absence is unproven: ${JSON.stringify((read.probeStderr ?? "").trim().slice(0, 200))} — a box/transport fault, NOT evidence about the image this box booted`,
          remediation:
            "ssh <vm>.exe.xyz true  # confirm the box answers at all, then re-create it; raise the gate budget only if the box is merely slow",
        }
      );
    }
    return finding(`${prefix} is absent — this box did not boot a factory image (INV-IBOX-2: a box that cannot state what it booted is not a factory box)`);
  }
  if (read.kind === "unreadable") {
    return (
      transportFault(read.exitCode, read.stderr) ??
      // JSON.stringify, not a raw slice: the stderr tail is box-controlled and
      // this note is logged — a newline or an ANSI escape in it forges log lines
      // from a machine the gate has just decided it does not trust.
      finding(`${prefix} could not be read (exit ${read.exitCode}): ${JSON.stringify(read.stderr.trim().slice(0, 200))}`)
    );
  }
  if (read.kind === "oversized") {
    return finding(`${prefix} exceeds the transport read cap — refused unparsed`);
  }
  // BYTES, not `.length`: `.length` counts UTF-16 code units, so a marker with
  // any non-ASCII (an IDN mirror host in `imageRef`) is measured in a different
  // unit from the producer's `stat -c '%s'`. `>=`, not `>`: the Dockerfile
  // asserts `-lt 4096`, so 4096 is over the cap there and must be here too.
  const bytes = Buffer.byteLength(read.content, "utf8");
  if (bytes >= IMAGE_MARKER_MAX_BYTES) {
    return finding(`${prefix} is ${bytes} bytes, at or over the ${IMAGE_MARKER_MAX_BYTES}-byte cap — refused unparsed`);
  }
  let marker: QdsImageMarker;
  try {
    marker = parseImageMarker(read.content);
  } catch (e) {
    // Partial: only `parseImageMarker` throws here and it always throws the
    // typed error, but a bare Error escaping must degrade to the generic code
    // rather than put `undefined` in the payload.
    const err = e as Error & Partial<ExeDevDriverError>;
    return { code: err.code ?? "image-marker-mismatch", message: `${prefix}: ${err.message}`, remediation: err.remediation ?? INSPECT_MARKER_CMD };
  }
  if (marker.buildId !== expectedBuildId) {
    // `marker.imageRef` is REPORTED, never compared (triage Q-4, deliberate): a
    // D7 tenant mirror pulls the same bytes under its own reference, so it
    // keeps the digest and the buildId but not the ref. Comparing it would
    // refuse a legitimate mirror; the buildId is the identity assertion.
    // JSON.stringify it too — up to 4 KiB of box-controlled text otherwise goes
    // raw into a logged note.
    return finding(
      `${prefix} buildId ${JSON.stringify(marker.buildId)} != the repo pin ${JSON.stringify(expectedBuildId)} — the box booted an image this repo does not pin (imageRef in marker: ${JSON.stringify(marker.imageRef)})`,
    );
  }
  return null;
}
