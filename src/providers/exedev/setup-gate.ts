/**
 * exe.dev five-assertion setup gate (DF2.2).
 *
 * `setup` clears the stale readiness sentinel, provisions the run environment
 * (QDS_TEAM_RUNNER=local beside DF2.3's key file), then runs the gate:
 *
 *   A  git integrity by content   — HEAD prefix-matches the recorded SHA AND
 *                                   `git status --porcelain` is empty (a
 *                                   truncated clone measured 5,641 zero-byte
 *                                   files while reporting success)
 *   B  pi registry loaded         — `command -v pi`, then `--list-models`
 *                                   non-empty AND not "No models available"
 *                                   (which pi prints while exiting 0)
 *   C  live ping per roster model — real chat/completions, zdr + deny, accepts
 *                                   content OR reasoning
 *   D  cost table loaded          — real `pi -p --mode json` cost.total > 0,
 *                                   and every models.json model priced with
 *                                   all four cost keys
 *   E  capped credit remaining    — GET /api/v1/key, remaining COMPUTED as
 *                                   limit - usage; null limit = uncapped = fail
 *
 * C/D/E run as ONE script inside the box (assertions-in-box.sh) so the runtime
 * key never crosses the wire (INV-4) and the gate exercises the box's own
 * egress. The roster is an ARGUMENT, never an environment variable — `ssh
 * host 'cmd'` carries no environment.
 *
 * Failure contract (AC1): `setup` is a driver METHOD, not a process — it
 * RETURNS `{ready:false, failedItem, assertionCode, assertions[]}` (plus AC1c's
 * typed `error:{code,message,remediation}` when the failing assertion carried
 * one), leaves the VM alive (INV-5: destroying it throws away the evidence),
 * and carries the debug + teardown commands in the payload. No code path here
 * calls process.exit; only a scripts/-level caller maps assertionCode to a
 * process exit status (DF3.1 keeps it in the payload instead). The one step
 * whose transport can REJECT rather than return (B0's marker read, which
 * `withTimeout` bounds) is caught at its call site so that contract holds.
 *
 * Sequential by design (INV-2): A runs before anything that spends money, and
 * the gate stops at the first failure — `assertions[]` carries exactly the
 * items that executed, pass and fail alike.
 *
 * Evidence: the result is written to `.sandbox/setup-gate/<runId>.json`
 * (0700/0600). DEVIATION from the story's `.sandbox/runs/<run-id>-setup.json`:
 * the runs dir is parsed exclusively by RunRecordStore.list(), which THROWS on
 * any non-record .json there (INV-4) — a sibling artifact would brick every
 * store consumer including the reaper.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../swarmclaw/log.ts";
import { parseRoster, ROSTER_MAX_BYTES, RosterError } from "../../phase-engine/roster/schema.ts";
import { assertValidRunId } from "../run-record.ts";
import { KEY_ENV_FILE } from "../credentials.ts";
import { DEFAULT_FILL_WORKDIR } from "./fill.ts";
import type { ExeDevDriver } from "./driver.ts";
import {
  ExeDevDriverError,
  IMAGE_MARKER_PATH,
  imageMarkerFailure,
  type MarkerFailure,
  readBoxFile,
  shQuote,
} from "./transport.ts";
import { assertPlainBoxPath } from "../path-guard.ts";

// ─── the contract ───────────────────────────────────────────────────────────

export type AssertionItem = "A" | "B" | "C" | "D" | "E";

/** Source-fixed exit codes: A and B deliberately SHARE 1 — the failing `item`
 *  is the discriminator and the code never is (AC1, DF3.1 relies on this). */
export const ASSERTION_CODE: Readonly<Record<AssertionItem, 1 | 2 | 3 | 4>> = {
  A: 1,
  B: 1,
  C: 2,
  D: 3,
  E: 4,
};

export interface AssertionResult {
  item: AssertionItem;
  ok: boolean;
  note: string;
}

export interface SetupGateResult {
  ready: boolean;
  /** Present iff not ready: the first failing item (the discriminator). */
  failedItem?: AssertionItem;
  /** Present iff not ready: the failing assertion's source-fixed code. */
  assertionCode?: 1 | 2 | 3 | 4;
  /** Every EXECUTED assertion, pass and fail alike, in execution order. */
  assertions: AssertionResult[];
  /**
   * AC1c: present iff the failing assertion carried a TYPED refusal — the
   * machine `code`, the message, and the literal next command. `assertionCode`
   * stays the DF3.1-owned 1|2|3|4 discriminator dispatch keys on (A and B
   * deliberately share 1); this is the field that says WHICH B failure it was.
   */
  error?: { code: string; message: string; remediation: string };
  /** Operator commands that diagnose THIS failure (never run by the driver). */
  debugCommands: string[];
  /** The only VM-destroying path is DF2.5's teardown — named, never invoked. */
  teardownCommand: string;
  vm: string;
}

export interface SetupGateOptions {
  runId: string;
  /**
   * INV-4-bis: the DISPATCH's correlation id, so the gate's log lines join to
   * the dispatch ack. Falls back to `requestId` — the driver instance's
   * own id, which is a different id from the ack's whenever the driver was not
   * constructed by this dispatch, and a run that dies at the gate then cannot
   * be joined to the dispatch that started it.
   */
  requestId?: string;
  /** The ACTIVE roster — an argument, never an environment variable. */
  rosterPath: string;
  /** The recorded commit SHA the clone must be pinned to (assertion A). */
  commitSha: string;
  workdir?: string;
  /** The box's env file (DF2.3's key contract). Override is a test knob. */
  envFile?: string;
  sentinelPath?: string;
  evidenceDir?: string;
  assertTimeoutMs?: number;
  gateTimeoutMs?: number;
}

export const DEFAULT_ASSERT_TIMEOUT_MS = 60_000;
export const DEFAULT_GATE_TIMEOUT_MS = 300_000;
export const DEFAULT_SENTINEL_PATH = "/tmp/PROVISION_READY";
/** DF2.3's constant, imported — the delivery contract is single-sourced. */
export const DEFAULT_ENV_FILE = KEY_ENV_FILE;
export const DEFAULT_EVIDENCE_DIR = ".sandbox/setup-gate";

/** The in-box C/D/E script ships beside this module and is read once. */
let inBoxScript: string | null = null;
function assertionsInBox(): string {
  if (inBoxScript === null) {
    inBoxScript = readFileSync(join(import.meta.dir, "assertions-in-box.sh"), "utf8");
  }
  return inBoxScript;
}

// ─── validation ─────────────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{7,64}$/i;
const SLUG_RE = /^[A-Za-z0-9._/-]+$/;

/** A path that will be interpolated into a remote sh command or its argv. */
function assertPathSafe(kind: string, p: string): void {
  // F034: shared grammar (round 6's "// and trailing-slash are not plain
  // paths" is part of it). Unchanged message. Newly refused: a leading "-".
  try {
    assertPlainBoxPath(kind, p);
  } catch {
    throw new ExeDevDriverError(
      `${kind}-invalid`,
      `${kind} ${JSON.stringify(p)} is not a plain path (charset [A-Za-z0-9._/-], no "..", no empty segments)`,
      `pass a plain ${kind} without shell metacharacters`,
    );
  }
}

/** Parse the roster host-side (DF1.5's closed-schema parser) and derive the
 *  bare model ids the in-box C pings. Single source: the rosterPath ARGUMENT. */
function rosterModels(rosterPath: string): string[] {
  // Same ceiling loadRoster enforces: this read is synchronous on the event
  // loop, so an oversized roster would wedge the gate outside every deadline
  // (the dispatch pre-check caps its own read; this is the second copy of the
  // same hazard — brief-steered path, repo-root containment only).
  //
  // Every fs failure below is TYPED (RosterError), never a bare Node error:
  // the gate's contract is refusals an operator can act on, and a bare
  // ENOENT/EACCES/EISDIR escaping here classified as an unhandled crash.
  //
  // ONE verified file descriptor end to end: the path is opened once, proven
  // a regular file under the ceiling BY THE DESCRIPTOR (fstat, not a
  // path-based stat that can name a different inode than the one read), and
  // read through that same descriptor under a hard byte cap. The old
  // stat-path → read-path → re-stat-path sequence verified and consumed three
  // potentially different files; here growth past the ceiling between fstat
  // and read cannot wedge the loop, because the read itself is capped at
  // ceiling+1 bytes and anything longer is the same typed over-ceiling
  // refusal the re-stat used to produce.
  let fd: number | undefined;
  try {
    try {
      fd = openSync(rosterPath, "r");
    } catch (e) {
      throw unreadableRoster(rosterPath, e);
    }
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new RosterError(
        [`roster path is not a regular file (${stat.isDirectory() ? "a directory" : "other"}) — cannot parse it as a roster`],
        rosterPath,
        "roster_unreadable",
      );
    }
    if (stat.size > ROSTER_MAX_BYTES) {
      throw overCeilingRoster(rosterPath, stat.size);
    }
    // +1 byte of slack: a file grown past the ceiling since the fstat shows up
    // as an overlong read here, not as an unbounded buffer.
    const buf = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break; // EOF — a file shrunk since the fstat reads short
      read += n;
    }
    if (read > ROSTER_MAX_BYTES) {
      throw overCeilingRoster(rosterPath, read);
    }
    const text = buf.subarray(0, read).toString("utf8");
    return parseRosterSlugs(text, rosterPath);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The typed verdict above is already decided; a failing close on a
        // read-only fd must not replace it.
      }
    }
  }
}

/** Shared tail of `rosterModels`: parse, then validate the derived slugs. */
function parseRosterSlugs(text: string, rosterPath: string): string[] {
  const roster = parseRoster(text, rosterPath);
  const slugs = [...new Set(roster.roles.map((r) => r.slug))];
  return slugs.map((slug) => {
    if (!SLUG_RE.test(slug)) {
      throw new ExeDevDriverError(
        "model-slug-invalid",
        `roster slug ${JSON.stringify(slug)} is outside the model-id charset [A-Za-z0-9._/-]`,
        "fix the roster entry — the slug is interpolated into the in-box ping",
      );
    }
    // R4 §3.4: strip the pi provider prefix so the API gets the bare model id.
    return slug.startsWith("openrouter/") ? slug.slice("openrouter/".length) : slug;
  });
}

// ─── timing ────────────────────────────────────────────────────────────────

/** A roster read that failed before parsing could see it — typed, with the errno named. */
function unreadableRoster(rosterPath: string, e: unknown): RosterError {
  const err = e as NodeJS.ErrnoException;
  return new RosterError(
    [`roster could not be read (${err.code ?? (e instanceof Error ? e.message : String(e))}) — the gate parses it host-side before any spend`],
    rosterPath,
    "roster_unreadable",
  );
}

/** The roster exceeded the byte ceiling — at the fstat, or as an overlong capped read. */
function overCeilingRoster(rosterPath: string, size: number): RosterError {
  return new RosterError(
    [`roster is ${size} bytes, over the ${ROSTER_MAX_BYTES}-byte (256 KiB) ceiling`],
    rosterPath,
    "roster_unreadable",
  );
}

function emitGate(
  requestId: string,
  runId: string,
  vm: string,
  item: string,
  ms: number,
  outcome: "ok" | "error",
  /** Extra sub-timings the Observability Contract names by hand and the
   *  `${item}_ms` key cannot produce (B0's `marker_assert_ms`, whose item must
   *  stay `gate_*` so the gate filters pick the line up at all). */
  extra?: Record<string, number>,
): void {
  log({
    requestId,
    operation: "exedev.gate",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: ms,
    status: outcome,
    runId,
    driver: "exedev",
    vm,
    item,
    outcome,
    gate_ms: ms,
    [`${item.toLowerCase()}_ms`]: ms,
    ...extra,
  });
}

// ─── the gate ───────────────────────────────────────────────────────────────

export async function setupGate(
  driver: ExeDevDriver,
  vm: string,
  opts: SetupGateOptions,
): Promise<SetupGateResult> {
  assertValidRunId(opts.runId);
  assertValidRunId(vm);
  // Empty is ABSENT: `??` admits `""` (an unset env var, a trimmed field
  // threaded through by a caller), and an empty `requestId` on every
  // `emitGate`/`log` line for the run is precisely the un-joinable output this
  // parameter was added to prevent — worse than the driver's own id, which at
  // least correlates the gate's own lines to each other.
  //
  // `!= null`, not `!== undefined`: the type says `string | undefined`, but this
  // is a driver-boundary option bag that callers build from JSON and env, where
  // `null` is what an absent field deserialises to. `!== undefined` let it
  // through to `.trim()` and turned a missing id into a TypeError out of the
  // gate — a crash where the fallback was the whole point. The typeof guard is
  // the same posture one step further: a JSON-built bag can carry a NUMBER or
  // BOOLEAN id ({"requestId": 42}), which `.trim()` also TypeErrored on — any
  // non-string falls back to the driver's own id, never crashes the gate.
  const requestId =
    typeof opts.requestId === "string" && opts.requestId.trim().length > 0 ? opts.requestId : driver.requestId;
  if (!SHA_RE.test(opts.commitSha)) {
    throw new ExeDevDriverError(
      "commit-sha-invalid",
      `commitSha ${JSON.stringify(opts.commitSha)} is not 7-64 hex characters`,
      "pass the run record's commitSha verbatim",
    );
  }
  // SHA_RE is case-insensitive, but `git rev-parse HEAD` prints lowercase —
  // normalize ONCE so an uppercase recorded SHA still prefix-matches (A).
  const wantSha = opts.commitSha.toLowerCase();
  assertPathSafe("rosterPath", opts.rosterPath);
  const envFile = opts.envFile ?? DEFAULT_ENV_FILE;
  assertPathSafe("envFile", envFile);
  const sentinelPath = opts.sentinelPath ?? DEFAULT_SENTINEL_PATH;
  assertPathSafe("sentinelPath", sentinelPath);
  const workdir = opts.workdir ?? DEFAULT_FILL_WORKDIR;
  assertPathSafe("workdir", workdir);
  const assertTimeoutMs = opts.assertTimeoutMs ?? DEFAULT_ASSERT_TIMEOUT_MS;
  const gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  if (
    !Number.isFinite(assertTimeoutMs) || !Number.isFinite(gateTimeoutMs) ||
    assertTimeoutMs < 1 || gateTimeoutMs < 1
  ) {
    throw new ExeDevDriverError(
      "gate-timeout-invalid",
      `assertTimeoutMs (${assertTimeoutMs} ms) and gateTimeoutMs (${gateTimeoutMs} ms) must each be a finite number >= 1 ms`,
      "pass finite timeouts >= 1 ms",
    );
  }
  const models = rosterModels(opts.rosterPath); // throws on a malformed roster — before any spend

  const gateStart = Date.now();
  const deadline = gateStart + gateTimeoutMs;
  const assertions: AssertionResult[] = [];
  /** B0's typed refusal, threaded into the payload as AC1c's `{code, message,
   *  remediation}`. Only B0 produces one today: A and the C/D/E script report
   *  through notes the box itself wrote. */
  let markerError: MarkerFailure | null = null;
  const g = opts.runId;
  const host = driver.boxHost(vm);

  // ── timing budget: per-assertion AND whole-gate deadline (INV-2: no spend past budget)
  // Free phases (provision/A/B) keep a 1 s floor: they spend nothing, and a
  // deadline-truncated kill there would surface as a cryptic exit-137 rather
  // than the named "budget exhausted" notes the phase guards below emit. The
  // C/D/E script has NO floor — its remaining time is read immediately before
  // launch and the launch is REFUSED when none is left, so it never starts a
  // millisecond past the deadline (rounds 4-5: a 1 s floor used to hand the
  // script 1,000 ms when 1-999 ms remained, and a clamped max(1, …) would
  // launch a 1 ms spend after the deadline).
  const budgetFree = () => Math.min(assertTimeoutMs, Math.max(1_000, deadline - Date.now()));

  // ── provision: stale readiness is never read as this run's (AC6) ──────────
  // round 6 + AC6: if the sentinel is a directory (or rm fails otherwise), stale readiness silently survives
  const rmResult = await driver.execTimed(vm, ["rm", "-f", sentinelPath], budgetFree());
  if (rmResult.exitCode !== 0) {
    throw new ExeDevDriverError(
      "sentinel-clear-failed",
      `could not remove sentinel ${sentinelPath} on ${host} (exit ${rmResult.exitCode}): ${rmResult.stderr.trim() || "no stderr"} — AC6 violated`,
      `ssh ${host} "rm -f ${sentinelPath}" and inspect the box by hand`,
    );
  }
  // AC7: QDS_TEAM_RUNNER=local beside DF2.3's key line — the environment the
  // in-box engine inherits. Idempotent append, then verified by CONTENT.
  const writeRunner = `mkdir -p "$(dirname ${shQuote(envFile)})" && grep -qx 'QDS_TEAM_RUNNER=local' ${shQuote(envFile)} 2>/dev/null || printf 'QDS_TEAM_RUNNER=local\\n' >> ${shQuote(envFile)}`;
  await driver.execTimed(vm, ["sh", "-c", writeRunner], budgetFree());
  const runnerCheck = await driver.execTimed(
    vm,
    ["sh", "-c", `grep -qx 'QDS_TEAM_RUNNER=local' ${shQuote(envFile)}`],
    budgetFree(),
  );
  if (runnerCheck.exitCode !== 0) {
    throw new ExeDevDriverError(
      "run-env-write-failed",
      `could not write/verify QDS_TEAM_RUNNER=local in ${envFile} on ${host} (exit ${runnerCheck.exitCode}) — DF1.6 refuses to dispatch from a box without it`,
      `ssh ${host} "cat ${envFile}" and inspect the box by hand`,
    );
  }

  // ── A: git integrity by content (runs before anything that spends — INV-2) ─
  let t = Date.now();
  const head = await driver.execTimed(vm, ["git", "-C", workdir, "rev-parse", "HEAD"], budgetFree());
  const porcelain = await driver.execTimed(
    vm,
    ["git", "-C", workdir, "status", "--porcelain"],
    budgetFree(),
  );
  const headSha = head.stdout.trim();
  const dirty = porcelain.stdout.trim();
  const aOk = head.exitCode === 0 && porcelain.exitCode === 0 && headSha.startsWith(wantSha) && dirty.length === 0;
  emitGate(requestId, g, vm, "gate_a", Date.now() - t, aOk ? "ok" : "error");
  if (head.exitCode !== 0) {
    assertions.push({ item: "A", ok: false, note: `A: git rev-parse HEAD failed (exit ${head.exitCode}): ${head.stderr.trim()}` });
  } else if (porcelain.exitCode !== 0) {
    // A corrupt/truncated index makes `status --porcelain` exit 128 with EMPTY
    // stdout — empty output on a failed command is "unknown", never "clean".
    assertions.push({
      item: "A",
      ok: false,
      note: `A: git status --porcelain exited ${porcelain.exitCode} with empty output: ${porcelain.stderr.trim() || "the clone's index is unreadable — truncated or mutated"}`,
    });
  } else if (!headSha.startsWith(wantSha)) {
    assertions.push({ item: "A", ok: false, note: `A: HEAD ${headSha.slice(0, 7)} does not prefix-match the recorded ${wantSha.slice(0, 7)}` });
  } else if (dirty.length > 0) {
    const lines = dirty.split("\n");
    assertions.push({
      item: "A",
      ok: false,
      note: `A: HEAD ${headSha.slice(0, 7)} matches, but porcelain is dirty (${lines.length} entries — e.g. ${lines[0]}): the clone is truncated or mutated`,
    });
  } else {
    assertions.push({ item: "A", ok: true, note: `A: HEAD ${headSha.slice(0, 7)}, porcelain empty` });
  }

  // ── B: pi registry loaded — content, never $? (AC2's negative control) ────
  if (assertions[0]?.ok === true) {
    t = Date.now();
    if (Date.now() >= deadline) {
      assertions.push({ item: "B", ok: false, note: `B: gate budget exhausted before B ran (earlier phases consumed gateTimeoutMs=${gateTimeoutMs}ms)` });
      emitGate(requestId, g, vm, "gate_b", Date.now() - t, "error");
    } else {
      // ── B0 (DF2.10 AC1c): the box PROVES what it booted, before anything
      // else in B spends a command on it.
      //
      // INV-IBOX-2: a box cannot read the digest it was pulled from, and the
      // marker cannot carry that digest either (the digest is the hash of the
      // manifest containing it), so identity rests on a build-generated
      // `buildId`. The host enforces the digest at pull; this proves the box
      // that ACTUALLY booted matches the pin. A host-side pull check proves
      // nothing about the running box.
      //
      // Deliberately folded into B rather than given its own letter: the A–E
      // union and the 1|2|3|4 code table `dispatch.ts` keys on are DF3.1-owned
      // (AC1c). B already IS the image-contract gate, and B's code stays 1.
      //
      // Budget: B0 spends TWO free-phase budgets (`test -f`, then `cat`), the
      // same shape as A's two git calls — `budgetFree()`'s 1 s floor means
      // neither can hand a zero or negative timeout down, and the only SPEND
      // (the C/D/E launch) is still refused outright once the deadline passes.
      // `readBoxFile` routes through `execTimed`, so the budget kills the ssh
      // rather than `withTimeout` abandoning it to run on for 120 s.
      const markerT = Date.now();
      // The ONLY step in the gate whose transport can REJECT rather than return
      // a non-zero ExecResult: `readBoxFile` bounds each exec with
      // `withTimeout`, which rejects with a TimeoutError. Every other assertion
      // goes through `execTimed`, which returns. An escaping rejection would
      // break this module's whole failure contract (header: failure RETURNS a
      // payload) — dispatch.ts:2905 would never get a result object, the gate's
      // exit-3 refusal would land in the outer catch as an exit-1
      // `dispatch-failed`, and the run record's `extensions.gate` block would
      // never be written. Caught HERE, at the one call that can do it.
      let markerFailure: MarkerFailure | null;
      try {
        markerFailure = imageMarkerFailure(await readBoxFile(driver, vm, IMAGE_MARKER_PATH, budgetFree()), driver.imageBuildId);
      } catch (e) {
        markerFailure = {
          code: "image-marker-unreachable",
          message: `B: ${IMAGE_MARKER_PATH} could not be read within the gate budget: ${(e as Error).message} — a box/transport fault, NOT evidence about the image this box booted`,
          remediation: `ssh ${host} true  # confirm the box answers at all, then re-create it; raise gateTimeoutMs only if the box is merely slow`,
        };
      }
      emitGate(requestId, g, vm, "gate_b0", Date.now() - markerT, markerFailure === null ? "ok" : "error", {
        marker_assert_ms: Date.now() - markerT,
      });
      if (markerFailure !== null) {
        // Fail-CLOSED and as a PAYLOAD, never a throw and never a process exit
        // code (DF3.1 AC3): the caller gets {failedItem:"B", assertionCode:1},
        // the typed `{code, message, remediation}` in `result.error` (AC1c),
        // and the VM stays alive and listable (INV-5). No early return — the
        // C/D/E block is already guarded by `assertions.every(a => a.ok)`, so
        // falling through skips the paid assertions and lands in the same
        // result assembly every other B failure uses.
        markerError = markerFailure;
        assertions.push({ item: "B", ok: false, note: markerFailure.message });
      } else {
      const piPath = await driver.execTimed(vm, ["sh", "-c", "command -v pi"], budgetFree());
      if (piPath.exitCode !== 0 || piPath.stdout.trim().length === 0) {
        // DF2.10 AC2: the drift this story retires. The old text named pi
        // 0.55.0 — DF2.9's npm pin on the D7 enterprise image, a DIFFERENT
        // tier — while every measured exe.dev box ran 0.83.0 (2026-08-04) then
        // 0.84.4 (2026-08-31). The factory image now OWNS the version, so the
        // gate names the owned pin instead of a number no box ever ran.
        assertions.push({ item: "B", ok: false, note: "B: pi is not on the box PATH (command -v pi failed) — the factory image installs it at /usr/local/bin/pi at the pinned PI_VERSION" });
      } else {
        const listed = await driver.execTimed(vm, ["pi", "--list-models"], budgetFree());
        const out = listed.stdout.trim();
        if (out.length === 0) {
          assertions.push({ item: "B", ok: false, note: "B: pi --list-models printed nothing (content check — exit status is not the instrument)" });
        } else if (/no models available/i.test(out)) {
          assertions.push({ item: "B", ok: false, note: `B: pi --list-models says: ${out.split("\n")[0]} (exits 0 — the registry did NOT load; content decides, never $?)` });
        } else {
          assertions.push({ item: "B", ok: true, note: "B: pi registry loaded — list-models content present" });
        }
      }
      }
      emitGate(requestId, g, vm, "gate_b", Date.now() - t, assertions.at(-1)?.ok ? "ok" : "error");
    }
  }

  // ── C/D/E: ONE in-box script — the runtime key never crosses the wire ─────
  if (assertions.every((a) => a.ok)) {
    t = Date.now();
    const script = assertionsInBox();
    // Remaining is read HERE — after the adjacent synchronous script read, as
    // late as possible — and the launch is REFUSED when none is left: a
    // deadline expiring between the phase entry and this point must never be
    // clamped into a 1 ms post-deadline spend launch (round-5 review).
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const note = `gate budget exhausted before C/D/E ran (earlier phases consumed gateTimeoutMs=${gateTimeoutMs}ms)`;
      assertions.push(
        { item: "C", ok: false, note },
        { item: "D", ok: false, note },
        { item: "E", ok: false, note },
      );
      emitGate(requestId, g, vm, "gate_cde", Date.now() - t, "error");
    } else {
      const res = await driver.execTimed(
        vm,
        ["sh", "-c", script, "sh", opts.rosterPath, envFile, ...models],
        Math.min(assertTimeoutMs, remaining), // positive by the check above — never floored past the deadline
      );
      const KNOWN: ReadonlySet<string> = new Set(["A", "B", "C", "D", "E"]);
      const results = res.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
          try {
            const v = JSON.parse(line) as { item?: unknown; ok?: unknown; note?: unknown };
            if (
              typeof v.item === "string" &&
              KNOWN.has(v.item) && // an unknown item can never index ASSERTION_CODE — dropped, and the exit-code gate below stays closed
              typeof v.ok === "boolean" &&
              typeof v.note === "string"
            ) {
              return [{ item: v.item as AssertionItem, ok: v.ok, note: v.note }];
            }
          } catch {
            // a non-JSON line is script noise, not evidence — skipped, not fatal
          }
          return [];
        });
      // Exit-0 acceptance demands EXACTLY one well-formed result per C/D/E.
      // results.length === 3 with all three present pins "exactly one each" by
      // pigeonhole — partial evidence (exit 0 after only C's line) or duplicates
      // (a buggy/hostile box replaying a line) fall through to fail-closed below
      // (round-2 review: both shapes used to gate green).
      const cdeComplete =
        results.length === 3 &&
        (["C", "D", "E"] as const).every((it) => results.some((r) => r.item === it));
      if (res.exitCode === 125) {
        // A named missing dependency, never a false fail (Infra row 5). 125, not
        // 127: /bin/sh itself exits 127 for command-not-found, so a bare 127 must
        // remain free to mean "the gate did not run" — the fail-closed branch
        // below owns it.
        const deps = /missing dependency: (.+)/.exec(res.stderr)?.[1] ?? "unknown";
        assertions.push({
          item: "C",
          ok: false,
          note: `missing in-box dependency:${deps} (125-mapped) — the gate names it rather than false-failing`,
        });
      } else {
        // A CONTROLLED stop: the script's own contract is "exit = the first
        // failing item's code (2/3/4)". An exit that matches a FAILED line for
        // exactly that item is the designed sequential stop (INV-2) — the
        // remaining items simply never ran and are not fabricated.
        const code = res.exitCode as 2 | 3 | 4;
        const controlled =
          (code === 2 || code === 3 || code === 4) &&
          results.some((r) => !r.ok && r.item === ({ 2: "C", 3: "D", 4: "E" } as const)[code]);
        if (controlled) {
          assertions.push(...results);
        } else if (res.exitCode === 0 && cdeComplete) {
          assertions.push(...results);
        } else {
          // FAIL-CLOSED (AC1/INV-5): anything else — a SIGKILLed ssh, a dropped
          // connection (255), a crashed helper, an exit that disagrees with the
          // evidence — is NOT a pass. Everything not PROVEN is recorded failed:
          // all emitted lines first (pass and fail alike), then every missing
          // item, or the last item when the exit is non-zero despite full
          // evidence (incoherent evidence is unproven evidence).
          const emitted = results.map((r) => r.item);
          assertions.push(...results);
          const missing = (["C", "D", "E"] as const).filter((it) => !emitted.includes(it));
          const unproven: AssertionResult[] =
            missing.length > 0
              ? missing.map((it) => ({
                  item: it,
                  ok: false,
                  note: `in-box gate script exited ${res.exitCode} before this assertion produced evidence: ${res.stderr.trim().slice(0, 120) || "(no stderr — likely killed or disconnected)"}`,
                }))
              : [
                  {
                    item: "E",
                    ok: false,
                    note: `in-box gate script exited ${res.exitCode} despite complete evidence — treated as unproven, fail-closed`,
                  },
                ];
          assertions.push(...unproven);
        }
      }
      // The label states the gate's own conclusion, not the exit code alone:
      // exit 0 with NO evidence lines is the fail-closed branch above — an exit-0
      // script that proved nothing is never an "ok" (round-1 review). Round 2:
      // PARTIAL or DUPLICATED evidence is equally unproven — the same
      // complete-evidence predicate that admits the results decides the label.
      const cdeOk = res.exitCode === 0 && cdeComplete && results.every((r) => r.ok);
      emitGate(requestId, g, vm, "gate_cde", Date.now() - t, cdeOk ? "ok" : "error");
      }
  }

  // ── assemble: fail-closed, VM alive, evidence retained ────────────────────
  const firstFail = assertions.find((a) => !a.ok);
  const ready = firstFail === undefined;
  const result: SetupGateResult = {
    ready,
    ...(ready ? {} : { failedItem: firstFail.item, assertionCode: ASSERTION_CODE[firstFail.item] }),
    assertions,
    ...(ready || markerError === null ? {} : { error: markerError }),
    debugCommands: [
      "ssh exe.dev ls --json",
      `ssh ${host} 'git -C ${workdir} status --porcelain'`,
      // B0 (DF2.10 AC1c): the image the box actually booted — the first thing
      // to look at when B refuses, and the one command whose output the marker
      // assertion judged.
      `ssh ${host} 'cat ${IMAGE_MARKER_PATH}'`,
      `ssh ${host} 'pi --list-models'`,
      `ssh ${host} 'python3 -m json.tool ~/.pi/agent/models.json'`,
    ],
    teardownCommand: `ssh exe.dev rm ${vm}  # DF2.5 teardown — the only VM-destroying path; NEVER auto-run on gate failure (INV-5)`,
    vm,
  };

  const gateMs = Date.now() - gateStart;
  log({
    requestId: requestId,
    operation: "exedev.gate",
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: gateMs,
    status: ready ? "ok" : "error",
    runId: g,
    driver: "exedev",
    vm,
    ready,
    ...(ready ? {} : { failedItem: result.failedItem, assertionCode: result.assertionCode }),
    gate_ms: gateMs,
  });

  // Evidence artifact — see the header: NOT in .sandbox/runs.
  const evidenceDir = opts.evidenceDir ?? DEFAULT_EVIDENCE_DIR;
  try {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(evidenceDir, `${opts.runId}.json`),
      `${JSON.stringify({ runId: opts.runId, ...result, durationMs: gateMs, createdAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (e) {
    // Retaining the artifact must never turn a red gate green or crash the
    // caller — the evidence lives in the return value; log the write failure.
    log({
      requestId: requestId,
      operation: "exedev.gate",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "error",
      runId: g,
      driver: "exedev",
      vm,
      error: { code: "evidence-write-failed", message: (e as Error).message },
    });
  }

  return result;
}
