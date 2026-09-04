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
 * F017: the ONE quoter. `fanout-primitive.ts` and `tests/fleet/patterns.test.ts`
 * each carried a byte-identical hand-written copy under this name; they now
 * import this one. (A third copy lived in the host-driven remote runner DF1.10
 * AC7 deleted.) The rule outlives that deletion: a `sh -c` string built
 * anywhere in this repo quotes through here, never through a freshly written
 * local helper — byte-identical today is one edit away from silently not.
 *
 * ponytail: an ALIAS, not a rename — `shQuote` has 9 upstream call sites
 * (gitnexus impact: CRITICAL) including its own pinned suite and
 * `scripts/cap-hit-demo.ts`. One implementation, one extra name; collapse to
 * `shellQuote` when those call sites are in scope to touch.
 */
export const shellQuote = shQuote;

/**
 * Read one file OFF a box: presence probe, then `cat`, the PAIR bounded by ONE
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
     * Optional so a structural fake with only `exec` still satisfies this.
     *
     * The optionality cannot silently degrade a REAL driver: `fill.ts:269` and
     * `setup-gate.ts:401` already call `driver.execTimed(...)` UNCONDITIONALLY,
     * so a production driver that lost the method dies with a TypeError long
     * before it reaches here. The `exec` branch below is the test seam only. */
    execTimed?: (vm: string, argv: string[], timeoutMs: number, stdin?: string) => Promise<ExecResult>;
  },
  vm: string,
  path: string,
  deadlineMs: number,
): Promise<BoxFileRead> { // dp:ok EVERY caller handles a rejection: readMarkerVerdict (fanout-primitive.ts) wraps it in the try/catch that turns any throw into a `skip` verdict — and it is the read path BOTH marker callers share, probeArm (the race poller) and inBoxState (fleet status); setupGate (setup-gate.ts) converts a throw into the gate's refusal payload
  // ONE budget for the PAIR, not one each. `deadlineMs` used to be handed to
  // BOTH execs in full, so a hung box cost its caller up to 2 × deadlineMs:
  // setup-gate's B0 passes a single `budgetFree()` snapshot and then measures
  // the whole gate against `gateTimeoutMs`, and the fanout race ticks against a
  // per-tick deadline — neither has a second budget to spend here. An absolute
  // deadline taken once bounds the pair by the number the caller actually said.
  // Floored at 1 ms rather than skipped: a `cat` with no time left is killed at
  // the spawn and classified `unreadable`/rejected, both of which are already
  // fail-CLOSED at both call sites — refusing to issue it at all would need a
  // fifth BoxFileRead arm for a case those arms already cover.
  //
  // The floor is a CLAMP, not a diagnosis: a probe that ate the whole window
  // leaves the `cat` a 1 ms budget, and the SIGKILL that follows renders as
  // "the box never answered (exit 137 — SIGKILLed at the exec budget)" —
  // blaming the box for a budget the PROBE leg spent. The exhausted case is
  // therefore named before the read is issued (below), so the message says
  // what actually happened; the clamp survives for the merely-tight case.
  const until = Date.now() + deadlineMs;
  const left = (): number => Math.max(1, until - Date.now());
  const run = (argv: string[], ms: number): Promise<ExecResult> =>
    driver.execTimed === undefined ? driver.exec(vm, argv) : driver.execTimed(vm, argv, ms);
  const probeMs = left();
  const probe = await withTimeout(run(["sh", "-c", `test -f ${shellQuote(path)}`], probeMs), probeMs, "race-probe");
  if (probe.exitCode !== 0) return { kind: "absent", probeExit: probe.exitCode, probeStderr: probe.stderr };
  // MEASURED live 2026-08-26 (fan-20260826-f04c3c): the read goes through the
  // SAME exec channel as the presence probe. copyFile is box-RELATIVE by
  // driver contract (assertBoxPathSafe) while `runMarkerPath()` is ABSOLUTE
  // (/run/journal/final.json) — a copyFile read died "remote-path-invalid" on
  // every tick and the race spun to its ceiling with the marker present and
  // the winner never claimed.
  // The probe answered, but it spent the whole window doing it. Issuing the
  // `cat` anyway buys a 1 ms exec whose SIGKILL is indistinguishable from a
  // box that hung, and `imageMarkerFailure` would tell the operator to check
  // the network for a fault the CALLER's budget caused. `unreadable` is the
  // same fail-closed disposition either way (probeArm counts a skip tick,
  // setupGate refuses), so nothing loosens — only the sentence gets honest.
  // `exitCode: -1` because no process ever ran: a real status would be a lie.
  if (until - Date.now() <= 0) {
    return { kind: "unreadable", exitCode: -1, stderr: `read budget exhausted by the presence probe (${deadlineMs} ms shared by both legs)` };
  }
  const readMs = left();
  const read = await withTimeout(run(["sh", "-c", `cat ${shellQuote(path)}`], readMs), readMs, "race-read");
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
  // truncation is the stronger fact; it wins.
  //
  // Qualified by "and something was actually captured", because `truncated` is
  // `out.truncated || err.truncated` (sshCommand, above) and cannot tell the
  // two apart. A `cat` that FAILS while spewing >512 KiB to STDERR breached the
  // cap without the marker being oversized at all — and `oversized` is a
  // permanent verdict: `fanout-primitive.ts:817` maps it to "unusable", which
  // counts toward MARKER_UNUSABLE_TICKS_LIMIT and gives the arm up as corrupt,
  // where `unreadable` would have retried. It also carries no exitCode/stderr,
  // so the operator gets nothing to diagnose with. A non-empty stdout is the
  // one signal available here that the READ is what hit the cap.
  if (read.truncated && read.stdout.length > 0) {
    return { kind: "oversized" };
  }
  if (read.exitCode !== 0) return { kind: "unreadable", exitCode: read.exitCode, stderr: read.stderr };
  // Truncated, exit 0, and nothing on stdout: only the stderr breached the cap.
  // Not content (nothing was read) and not a failure the box reported — refuse
  // it unparsed, which is the fail-closed reading and cannot loop.
  if (read.truncated) return { kind: "oversized" };
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
 * POST-READ refusal ceiling for the marker (AC1c).
 *
 * The marker is six short strings — the shipped image's measured 238 bytes in
 * this story's live e2e round (the digest-pinned `imageRef` is most of it).
 * Anything over this is not our marker and is REFUSED rather than parsed.
 *
 * NOT a read cap, and the distinction matters: the `cat` is bounded by the
 * transport's own `EXEC_MAX_OUTPUT_BYTES` (512 KiB) and nothing else, so a box
 * that answers with 500 KiB has already been buffered into host memory by the
 * time this number is consulted. What this buys is that such bytes are never
 * PARSED, never compared, and never quoted into a note — not that they were
 * never held. The memory bound is `EXEC_MAX_OUTPUT_BYTES`'s job alone.
 * (`REGISTRY_AUTH_FILE_MAX_BYTES` in `driver.ts` is the other shape — an fstat
 * before the read — and is a genuine read cap; this one is not.)
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
 * never came up or died mid-flight. `driver.ts` IMPORTS these for its
 * steering-provision path (`steeringProvisionFailure`); the byte-identical
 * private pair it used to hold is gone, so the two paths can no longer drift
 * into classifying the same transport fault differently.
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
    // JSON.stringify, never the raw message — the same rule `tail()` applies to
    // box-controlled stderr below, and for the same reason. A V8/JSC
    // `SyntaxError` QUOTES a snippet of the input it choked on, and this input
    // is `/etc/qds-image.json` on a box the gate is in the middle of deciding
    // it does not trust. Raw, a marker of `{"a":\n\x1b[2K FAKE gate_b ok` puts
    // newlines and ANSI escapes into `assertions[].note`, into
    // `result.error.message`, into the gate's evidence artifact and into the
    // log — forging log lines from that very box. Sliced too: the snippet is
    // bounded by the marker's own byte ceiling, not by anything V8 promises.
    // (`assertRegistryAuthDeviation` in driver.ts refuses to relay the same
    // message class outright; there the quoted bytes could be a SECRET. Here
    // they are the box's own public marker, so the escaped snippet is kept —
    // it is the diagnostic an operator needs — and only neutered.)
    refuse(`is not parseable JSON: ${JSON.stringify((e as Error).message.slice(0, 200))}`);
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
 * DETECTS DRIFT, NOT TAMPERING, and the distinction is load-bearing for anyone
 * reading the sentence above as an integrity guarantee. `/etc/qds-image.json`
 * is an ordinary file the SUBJECT of the assertion authors, and the value an
 * attacker would have to forge (`buildId`) is printed by the build script and
 * quoted back in this function's own refusal text. So a wrong pull, a stale
 * pin or a half-set env pair are caught; a box whose root is compromised, or a
 * non-factory image that copied a known-good marker, is not. Binding identity
 * to something the box cannot mint (a host-side digest attestation recorded at
 * pull time, alongside the create event) is what would close that, and this
 * gate is not it.
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
  // A box that never cleanly ANSWERED is a transport fault, not a finding about
  // the image — and ONE rule decides that for BOTH legs of the read, stated
  // once here rather than argued twice below.
  //
  // Exit 1 is the only status either command produces as its own clean answer:
  // `test -f`'s "not there", and `cat`'s ordinary refusal of a file it could
  // not read (coreutils and busybox alike collapse every read failure onto 1).
  // Every OTHER non-zero exit is a signal or a remote shell that never ran the
  // command — 137 = SIGKILLed at the exec budget, 255 = ssh never came up or
  // dropped mid-flight, 143 = SIGTERM from a box shutting down, 126/127 = the
  // remote `sh` could not run `cat` at all — and none of them says anything
  // about what the box booted. Still fail-CLOSED (the box is refused either
  // way), but refused for the right reason, so the operator checks the network
  // instead of auditing the image pin. Same classification as
  // `steeringProvisionFailure` in driver.ts, for the reason stated there.
  //
  // The legs used to disagree: each named 137/255, then the probe leg fell
  // through to "absence unproven" while the read leg fell through to a finding
  // ABOUT THE IMAGE — so a `cat` SIGTERMed by a dying box (143) reached the
  // operator as an accusation against the pin, the exact miscategorisation the
  // probe leg had just been hardened against. Widening the named pair to admit
  // 143 would have bought one release: a rule that enumerates signals always
  // misses the next one, and "not exit 1" cannot. The named pair now survives
  // only to give 137/255 their own specific sentence, never to decide the
  // classification.
  const PROBE_THE_BOX =
    "ssh <vm>.exe.xyz true  # confirm the box answers at all, then re-create it; raise the gate budget only if the box is merely slow";
  /** JSON.stringify, not a raw slice: the stderr tail is box-controlled and this
   *  note is logged — a newline or an ANSI escape in it forges log lines from a
   *  machine the gate has just decided it does not trust. */
  const tail = (stderr: string): string => JSON.stringify(stderr.trim().slice(0, 200));
  /** Either leg's non-answer. `why` names the leg and what exit 1 would have
   *  meant there; the named pair overrides it with that status's own sentence. */
  const neverAnswered = (exitCode: number, stderr: string, why: string): MarkerFailure => ({
    code: "image-marker-unreachable",
    message: `${prefix} ${
      exitCode === EXEC_KILLED_EXIT || exitCode === EXEC_TRANSPORT_EXIT
        ? `could not be read because the box never answered (exit ${exitCode} — ${
            exitCode === EXEC_KILLED_EXIT ? "SIGKILLed at the exec budget" : "ssh connection failed or dropped mid-flight"
          })`
        : why
    }: ${tail(stderr)} — a box/transport fault, NOT evidence about the image this box booted`,
    remediation: PROBE_THE_BOX,
  });
  if (read.kind === "absent") {
    // (probeExit undefined — a caller that did not thread it — keeps the
    // absence reading: absence is still absence without it, per BoxFileRead.)
    if (read.probeExit !== undefined && read.probeExit !== 1) {
      return neverAnswered(
        read.probeExit,
        read.probeStderr ?? "",
        `presence probe exited ${read.probeExit} — not \`test -f\`'s clean miss (exit 1), so absence is unproven`,
      );
    }
    return finding(`${prefix} is absent — this box did not boot a factory image (INV-IBOX-2: a box that cannot state what it booted is not a factory box)`);
  }
  if (read.kind === "unreadable") {
    if (read.exitCode !== 1) {
      return neverAnswered(
        read.exitCode,
        read.stderr,
        `read exited ${read.exitCode} — not \`cat\`'s ordinary refusal (exit 1), so the marker was never read`,
      );
    }
    // Exit 1 on a path `test -f` just said exists IS a statement about the file
    // — a foreign image's root-only 0600 marker is the case this arm is for.
    return finding(`${prefix} could not be read (exit ${read.exitCode}): ${tail(read.stderr)}`);
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
    // `B: `, not `prefix`: `parseImageMarker`'s own `refuse` already opens the
    // message with IMAGE_MARKER_PATH, so re-applying the full prefix printed
    // the path twice ("B: /etc/qds-image.json: /etc/qds-image.json is not …").
    // The degraded bare-Error arm loses the path from the message and keeps it
    // in `remediation`, which is where an operator acts on it anyway.
    return { code: err.code ?? "image-marker-mismatch", message: `B: ${err.message}`, remediation: err.remediation ?? INSPECT_MARKER_CMD };
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
