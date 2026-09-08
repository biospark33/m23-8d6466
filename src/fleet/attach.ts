/**
 * DF3.4 — the host→in-box steering transport (AC6).
 *
 * Two legs address ONE pair of absolute in-box paths:
 *
 *  - **host leg** (`attachToRun`, what `fleet attach` calls): the operator is
 *    outside the box, so both the append and the ack poll cross DF2.1's driver
 *    port — `driver.exec` with the payload on **stdin** and the ack read as
 *    `sh -c cat`. Deliberately NOT `driver.copyFile`: it is box-RELATIVE on
 *    both drivers (ExeDev's `assertBoxPathSafe` refuses a leading `/`,
 *    FakeDriver's escape check refuses the resolved absolute), and reading an
 *    ABSOLUTE in-box path through it is the exact bug that spun the fan-out
 *    race to its ceiling live on 2026-08-26 — see the measured note at
 *    `fanout-primitive.ts:688-696`, whose fix (`exec` + `cat`) this mirrors.
 *    The paths it addresses are resolved BY THE BOX (see
 *    `BOX_STEERING_ROOT_SH`), never interpolated from the host.
 *  - **engine leg** (`localSteeringInbox`, injected into `createSteering`):
 *    plain `fs` on the same absolute paths, exactly as `journal.ts` already
 *    writes `runMarkerPath(runId)` (`/run/qds-run/<runId>/journal/final.json`)
 *    with `writeFileSync`. The engine addresses in-box paths as local paths;
 *    that is the repo's settled convention, and it is why the engine needs no
 *    driver reference.
 *
 * The story specifies `copyFile` for the ack read and an in-box engine. The
 * first is corrected here on evidence — the two paragraphs above. The second
 * has since ARRIVED, and it VINDICATES this split rather than undoing it:
 * DF1.10 put the engine in the box (`fleet run` starts `qds-run@<runId>`,
 * whose ExecStart is `qds-engine run <runId>`, on the image's pinned bun),
 * which is exactly why the engine leg's plain `fs` is the right shape — it
 * addresses `/run/steering` as a local path because it genuinely runs there.
 * The host leg still crosses the driver port, because the operator does not.
 * At DF3.4 time nothing walked phases in-box — a host-driven remote runner
 * (since retired) drove them over the same driver port — so both legs were
 * written to hold either way rather than betting on the relocation. Hedging
 * was right: that host-side placement was a SILENT, UNRATIFIED deviation from
 * the original design, and the premise propping it up was folklore — bun had
 * never once been probed on a box, and the "exit 127" that supposedly proved
 * it only ever tested node. Measured and rescinded in
 * `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED).
 * Recorded in the Dev Agent Record.
 */
import { appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { acquireFileLock, isPidDead } from "../lib/file-lock.ts";
import { ATTACH_MESSAGE_CHAR_CEILING, type SteeringInbox } from "../phase-engine/steering.ts";
import { sanitizeForMessage } from "../phase-engine/types.ts";
import type { ProviderDriver } from "../providers/driver.ts";
import type { RunRecordStore } from "../providers/run-record.ts";
import { withTimeout } from "../providers/timeout.ts";

/**
 * Steering-channel root, as resolved by THIS process. `/run/steering` in the
 * box. `QDS_STEERING_ROOT` exists solely so the host-side suite can exercise
 * the real paths where `/run` is root-owned (Linux CI) or absent (darwin dev) —
 * the same role, and the same read-at-call-time discipline, as `journal.ts`'s
 * `runMarkerRoot()`.
 *
 * LOCAL CALLERS ONLY — the engine leg below (local `node:fs` IN the box) and
 * the suite. The host leg reaches the same files through the driver port
 * (`fleet attach`'s ssh session, which is its own environment ON the box, not
 * the engine's), and it must NEVER interpolate this into a script that runs
 * there: with the variable set in one box environment and unset in the other
 * the two legs addressed DIFFERENT files, `mkdir -p` created the wrong one,
 * `cat` exited 0, and the operator was told the message was queued in a box
 * that would drain the real path forever. The box resolves its own root — see
 * `BOX_STEERING_ROOT_SH`.
 */
export function steeringRoot(): string {
  // `||`, not `??`: an EMPTY `QDS_STEERING_ROOT` must fall through to the
  // default, exactly as the box leg's `${QDS_STEERING_ROOT:-/run/steering}`
  // does (`:-` substitutes on empty as well as unset). Under `??` an empty
  // host environment produced `""` here while the box script still resolved
  // `/run/steering` — the two legs split onto different files, which is the
  // split-brain this module's header documents in its unset form. Both
  // resolvers must agree on unset AND on empty.
  return process.env.QDS_STEERING_ROOT || "/run/steering";
}

/**
 * The same root, resolved BY THE BOX at exec time rather than by the host.
 *
 * `sh` parameter expansion, not a host interpolation, and that is the whole
 * point: whatever `QDS_STEERING_ROOT` means inside the box is what BOTH legs
 * see, because the engine leg (`steeringRoot()` above) runs in that same
 * environment. On a real box the variable is unset and both resolve
 * `/run/steering`; under the suite's FakeDriver the child inherits
 * `process.env` (`fake-driver.ts:358`), so the override still reaches the
 * host leg and the tests still exercise the real script.
 *
 * Double-quoted, so a root with spaces or globs cannot word-split — and an
 * expansion's RESULT is never re-parsed by `sh`, so nothing in the value can
 * become a command.
 */
const BOX_STEERING_ROOT_SH = 'root="${QDS_STEERING_ROOT:-/run/steering}"';

export function inboxPath(): string {
  return join(steeringRoot(), "inbox.ndjson");
}

export function acksPath(): string {
  return join(steeringRoot(), "acks.ndjson");
}

/** AC6's ack ceiling — 30 s without an ack is a reported outcome, never a retry. */
export const ATTACH_ACK_CEILING_MS = 30_000;
/** Ack poll interval. The ack is local to the box, so ticks are cheap. */
export const ATTACH_POLL_INTERVAL_MS = 500;
/** Per-`exec` deadline. MANDATORY: FakeDriver's exec has no ceiling of its own. */
export const ATTACH_PER_CALL_TIMEOUT_MS = 10_000;
/**
 * Consecutive ticks where the acks file exists but yields no parseable line
 * before attach stops polling it. Mirrors `MARKER_UNUSABLE_TICKS_LIMIT`
 * (fanout-primitive.ts:67): a file that never parses is CORRUPTION, not
 * latency, and polling it to the ceiling buys nothing.
 */
export const ACK_UNUSABLE_TICKS_LIMIT = 3;
/**
 * Floor under every caller-supplied millisecond value (`AttachOptions` is a
 * documented seam — `scripts/fleet.ts:267` — so these are reachable). A
 * `pollIntervalMs` of 0 hot-spins `exec` at the box back to back, and a
 * per-call timeout of 0 refuses the call before the driver can answer. Small
 * enough that the suite's 20 ms ticks are untouched.
 */
export const ATTACH_MIN_TICK_MS = 10;

/**
 * The NDJSON line `fleet attach` appends. `requestId` is OPTIONAL because the
 * record's is (`run-record.ts:134`): a dispatched run carries one, a bare
 * `provisionAdmittedRun` does not, and echoing `undefined` as a string would be
 * a fabricated correlation id. `JSON.stringify` drops the key when absent.
 */
export interface AttachLine {
  messageId: string;
  requestId?: string;
  runId: string;
  message: string;
  sentAt: string;
}

export interface AttachDeps {
  driver: ProviderDriver;
  store: RunRecordStore;
}

export interface AttachOptions {
  ceilingMs?: number;
  pollIntervalMs?: number;
  perCallTimeoutMs?: number;
  /** Injected for the dedupe test; production mints one per call. */
  messageId?: string;
  /** Monotonic clock seam, like `runRace`'s `performanceNow(deps)`. */
  now?: () => number;
}

/**
 * Why an ack was not observed. All four are the SAME operator posture — the
 * message may already be in the box, so a blind re-send double-delivers it (a
 * retry mints a fresh `messageId`, which is the one key the dedupe rests on) —
 * but they need different remediations, and collapsing them told an operator
 * whose box was destroyed that "the message IS queued in the box".
 *
 *  - `no-ack` — appended cleanly, no ack inside the ceiling. The append is
 *    established; the queue's survival is not (a reboot wipes it with the run).
 *    The engine may not yet have reached a solicitation point — or may never
 *    (run dead, fold budget spent, box rebooted). Even the append claim is
 *    earned only by a CLEAN read (`readAck` exit 0): attach refuses to make it
 *    when every poll came back `unreachable`, and reports `box-unreachable`
 *    instead — see the truthfulness guard in `attachToRun`.
 *  - `send-failed` — the append itself failed or timed out. `withTimeout` is a
 *    HOST-side deadline that cannot cancel the in-box `cat`, and a non-zero
 *    `cat` can follow a partial write, so the line MAY have landed.
 *  - `acks-unreadable` — the acks file is present and no line of it parses.
 *    Corruption, not latency (see `ACK_UNUSABLE_TICKS_LIMIT`).
 *  - `box-unreachable` — no poll produced evidence about the file: a read that
 *    did not come back at all, or one that came back and exited non-zero
 *    (unreadable acks file, wiped steering root). The box, not the file, is the
 *    thing that stopped answering.
 */
export type AttachNotAckedReason = "no-ack" | "send-failed" | "acks-unreadable" | "box-unreachable";

export type AttachResult =
  | { outcome: "attach-acked"; messageId: string; requestId?: string }
  | {
      outcome: "attach-not-acked";
      messageId: string;
      requestId?: string;
      reason: AttachNotAckedReason;
      /** Bounded transport text on `send-failed`, absent otherwise. */
      detail?: string;
    }
  | {
      /**
       * PERMANENT refusal — the message's POST-sanitize length is over
       * `ATTACH_MESSAGE_CHAR_CEILING`, which is what the fold's cap measures
       * (steering.ts's `sanitizeForMessage(message).slice(0, …)`), and no
       * retry of the same text can ever change that. It is a result arm, not
       * a throw, because the CLI's `report()` classifies an untyped throw as
       * transient/exit-1 "retry me" — the one posture this outcome must never
       * produce. Nothing was queued; `messageId` was minted but never
       * appended, so it is a correlation handle for the refusal output, not a
       * dedupe key in the box.
       */
      outcome: "message-over-ceiling";
      messageId: string;
      requestId?: string;
      /** The number the guard measured — AFTER `sanitizeForMessage`. */
      messageChars: number;
      ceilingChars: number;
    }
  | { outcome: "run-not-attachable"; state: string };

/**
 * Append-one-line, in-box. The argv carries only this fixed script; the payload
 * arrives on stdin, so `message`/`messageId`/`requestId` — none of them
 * sanitized — cannot break out of the command regardless of quotes, shell
 * metacharacters or embedded newlines. `cat` writes stdin verbatim and parses
 * nothing. Nothing host-supplied is interpolated at all: the path comes from
 * the box's own environment (see `BOX_STEERING_ROOT_SH`).
 *
 * `umask 077` runs FIRST so the file is 0600 from the instant `cat` creates it,
 * never briefly world-readable; `mkdir -p` is what creates `/run/steering/`;
 * the trailing `chmod` is belt-over-braces against a pre-existing lax file.
 * Lifted from `credentials.ts:347-358`'s `deliverScript`.
 *
 * The `tail -c1` clause is the newline guard. NDJSON is only NDJSON while every
 * line ends in a newline, and a `cat >>` that dies mid-write (ENOSPC, a killed
 * exec, a destroyed box) leaves the file without one. The next append then
 * concatenates onto that fragment and produces ONE unparseable line — so the
 * fragment does not merely lose itself, it takes the NEXT, fully valid message
 * down with it while the CLI reports that one as queued. `$(…)` strips trailing
 * newlines, so the test reads "the last byte is not a newline"; `-s` skips it
 * for a file that is absent or empty (`cat >>` creates it correctly).
 *
 * CONCURRENCY, and its ceiling: this append is SINGLE-WRITER BEST-EFFORT. The
 * guard and the `cat >>` run as separate shell steps with no lock (the box
 * carries no lockfile helper), so two concurrent appends to one box — two
 * `fleet attach` invocations, or an attach racing a resident write — can still
 * interleave. That risk is accepted rather than engineered away because the
 * payload is small enough to leave in one `write(2)` from an O_APPEND fd, which
 * the kernel serialises at the file offset; the guard runs before it, against a
 * file only appends ever change. The host-local leg does not share the
 * relaxation: `localSteeringInbox`'s writes take a real lock (`appendUnderAcksLock`).
 */
const APPEND_SCRIPT = [
  "umask 077",
  BOX_STEERING_ROOT_SH,
  'mkdir -p "$root"',
  'f="$root/inbox.ndjson"',
  '{ [ ! -s "$f" ] || [ "$(tail -c1 "$f")" = "" ] || echo >> "$f"; }',
  'cat >> "$f"',
  'chmod 600 "$f"',
].join(" && ");

/**
 * How much of the acks file one poll tick reads — the TAIL, where the newest
 * acks live. The file is append-only (`localSteeringInbox`'s `ack` appends per
 * message and nothing ever truncates it), so an unbounded read re-parses an
 * ever-growing file every 500 ms tick — and a driver stdout cap truncating
 * that read drops the TAIL, the exact end the newest matching ack sits at,
 * turning a delivered message into a 30 s `no-ack`. Same growth shape and
 * same answer as the inbox leg's `INBOX_READ_CAP_BYTES`. A windowed read can
 * open mid-line (or mid-UTF-8); `readAck`'s parse loop skips that partial
 * first line exactly like a torn one.
 *
 * The window is a CONTRACT with the exec layer, not a private taste: the
 * `tail -c` output rides `driver.exec`, whose reader caps captured stdout at
 * `EXEC_MAX_OUTPUT_BYTES` — so the window may never exceed that cap, or the
 * cap truncates this read from the front and the hazard above stops being
 * hypothetical. That bound is pinned by attach's own drift-guard test against
 * the exec layer's constant, so neither side can move alone.
 *
 * SIZED TO THE CAP, deliberately: `EXEC_MAX_OUTPUT_BYTES` is 512 KiB
 * (restored in bounded-exec.ts when this window's first, larger value was
 * recognised as the tail wagging seven unrelated consumers), and this window
 * matches it. Equality is safe — `readBounded` truncates only when bytes
 * EXCEED the cap, so an exactly-window-sized read arrives whole — and the
 * margin that matters is the other direction: at ~120 bytes per ack line,
 * 512 KiB is ~4 400 of the NEWEST acks, an order of magnitude past any
 * realistic append-to-ack gap. Growing this number further requires growing
 * the exec cap with it, which is a reviewed event, not a constant edit.
 */
export const ACKS_READ_CAP_BYTES = 512 * 1024;

/**
 * The ack read, on the box's own path for the reason the append script gives.
 * `tail -c` (already used by APPEND_SCRIPT's newline guard) bounds the read to
 * the newest bytes — see `ACKS_READ_CAP_BYTES`. The cap constant is the only
 * interpolation and it is a module-level numeric literal, so argv stays a
 * constant, payload-free script exactly like the `cat` it replaces.
 *
 * The script's two guards are what let `readAck` treat every non-zero exit as
 * a TRANSPORT FAULT (see `readAck`): they remove the two cases that would
 * otherwise reach the exit status of the last command for the wrong reason.
 *
 *  - an absent ACKS file. `tail` on a missing file exits 1, and "no acks
 *    written yet" is the NORMAL pre-ack state — the engine writes its first
 *    ack only at the first solicitation — so that case is short-circuited to
 *    exit 0 with no bytes, a clean read.
 *  - an absent INBOX, the opposite: `attachToRun` creates it before the poll
 *    starts and nothing in this module ever truncates or removes it, so a
 *    missing inbox can only mean the box's steering state was wiped (a reboot
 *    — `/run` is a tmpfs — or a rebuilt box). That is a fault, and it is
 *    reported as one (`exit 3`) rather than masquerading as a clean "no ack
 *    yet" that would let the operator be told the message IS queued in a box
 *    that no longer has it.
 */
const ACK_READ_SCRIPT = [
  BOX_STEERING_ROOT_SH,
  '[ -f "$root/inbox.ndjson" ] || exit 3',
  `if [ -f "$root/acks.ndjson" ]; then tail -c ${ACKS_READ_CAP_BYTES} "$root/acks.ndjson"; fi`,
].join(" && ");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * How much of the inbox one drain reads. The file is append-only by design (see
 * `localSteeringInbox`), so its size is bounded by nothing but the tmpfs it
 * sits on — and every solicitation read and re-parsed all of it.
 *
 * The TAIL, not the head, when the cap bites: steering guidance is operator
 * intent about what to do NEXT, so the newest messages are the ones that must
 * survive. The first (probably partial, and possibly mid-UTF-8) line of the
 * window is dropped rather than offered as a message. A drop is possible in
 * principle — an undelivered message a megabyte back — and it is strictly
 * better than the unbounded read it replaces: 1 MiB is ~250 messages at the
 * 4 000-char ceiling, so reaching it means the resident stopped draining long
 * ago, which is a fault of its own.
 */
const INBOX_READ_CAP_BYTES = 1_048_576;

function readInboxTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    // ONE bounded read loop for both branches. The old short path read the
    // whole file with `readFileSync`, unbounded after the stat: a `cat >>`
    // growing the file between `fstatSync` and the read filled memory with
    // bytes the cap had already judged irrelevant. Looping here too costs
    // nothing when the size holds (`readSync` fills in one call at EOF) and
    // bounds the window either way.
    const from = Math.max(0, size - INBOX_READ_CAP_BYTES);
    const buf = Buffer.alloc(Math.min(size, INBOX_READ_CAP_BYTES));
    let read = 0;
    // Loop the read: a single `readSync` may return FEWER bytes than asked
    // (signals, and platforms that return short reads routinely), and the
    // unfilled tail of `buf` is zeros — the OLDEST lines in the window would
    // then parse as garbage while the newest survived, the exact inversion of
    // "keep the newest" this window exists for. `readSync` returns 0 only at
    // EOF, which the size above says we have not reached.
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buf.toString("utf8", 0, read);
    if (size <= INBOX_READ_CAP_BYTES) return text;
    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  } finally {
    closeSync(fd);
  }
}

/**
 * One ack tick. "absent" is a CLEAN read (no acks yet — whether because the
 * acks file does not exist or because it holds none of ours) and resets both
 * streaks; "unusable" is a present file yielding no parseable line at all;
 * "unreachable" is any look that produced no evidence about the file — a call
 * that never came back, OR one that came back and exited non-zero.
 *
 * Both halves of that last clause matter. The thrown case was always treated
 * as unreachable; the non-zero exit was not — it used to be "absent", on the
 * theory that a `tail` which ran and failed was just "the file is not there
 * yet". But `ACK_READ_SCRIPT` already short-circuits the healthy absent-acks
 * case to exit 0, so a non-zero exit is the OTHER facts: an unreadable acks
 * file (permissions, a read error) or a wiped steering root (`exit 3`). Every
 * one of them is the box failing to report, not the resident lagging — and
 * reading them as "absent" reset the unreachable streak, set `answered`, and
 * let `attachToRun` report `no-ack`, i.e. "the message IS queued in the box",
 * over a message whose inbox had ceased to exist. Only an exit-0 read is
 * evidence about the file's contents.
 */
async function readAck(
  deps: AttachDeps,
  vm: string,
  messageId: string,
  timeoutMs: number,
): Promise<"acked" | "absent" | "unusable" | "unreachable"> {
  let stdout: string;
  try {
    const res = await withTimeout(deps.driver.exec(vm, ["sh", "-c", ACK_READ_SCRIPT]), timeoutMs, "attach-ack-read");
    if (res.exitCode !== 0) return "unreachable"; // the box answered but could not report — not evidence about the file
    stdout = res.stdout;
  } catch {
    return "unreachable"; // the box did not answer — not evidence about the file
  }
  if (stdout.trim().length === 0) return "absent";
  let parsedAny = false;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      // Parse AND dereference inside the guard: `JSON.parse("null")` SUCCEEDS,
      // so the `row.messageId` access on it throws a TypeError — which is why
      // the engine leg's `drain()` keeps its own access inside its try. With
      // the dereference outside, one literal `null` line escaped this poll as
      // an untyped throw → the CLI's transient/exit-1 "retry me" path. A row
      // whose access throws is not parseable for `parsedAny`'s purpose either.
      const row = JSON.parse(line) as { messageId?: unknown };
      if (row.messageId === messageId) return "acked";
      parsedAny = true;
    } catch {
      // torn, truncated, or non-object line — skip it (report.ts's rule)
    }
  }
  return parsedAny ? "absent" : "unusable";
}

/**
 * Queue one operator message for the run's resident and wait for the engine to
 * fold it into a solicitation.
 *
 * Refuses `run-not-attachable` for a run that is over — checked BEFORE anything
 * is queued, so a refusal leaves the extension and the inbox untouched.
 *
 * "Over" is EVERY approval state, not just the two paused ones, plus any record
 * carrying `closedAt`. `requestApproval` runs the REAL teardown *before* it
 * promotes to `awaiting-approval`, so `approved`, `rejected` and a persisted
 * `timed-out` are all strictly AFTER that teardown and their boxes are just as
 * gone as a `pausing` one's; `rec.vmName` survives on the record, so the
 * no-box guard below passes and the exec went to a VM that no longer exists.
 * `closedAt` is the same fact for a plainly torn-down run — it is what
 * `status.ts` treats as the authoritative "this run is over" marker, and attach
 * consulted it nowhere. Both produced a driver-shaped exception where the CLI
 * was written to render a clean `run-not-attachable`.
 *
 * THAT CHECK IS A FAST REFUSAL, NOT AN INVARIANT. The state is read below and
 * the append fires further down under no lock, while the approval gate mutates
 * that same state under `withApprovalLock` — so a run entering `pausing` inside
 * that window gets a message appended to a box that is being torn down. AC5
 * reads as an invariant and is not one. Left as a race deliberately: the whole
 * consequence is one steering message lost with the box it was queued for — no
 * state is corrupted, no extension is touched, nothing irreversible happens —
 * and taking the approval lock here would serialize every attach behind a gate
 * transition to buy nothing but a narrower window.
 */
export async function attachToRun(
  deps: AttachDeps,
  runId: string,
  message: string,
  opts: AttachOptions = {},
): Promise<AttachResult> {
  const rec = deps.store.get(runId);
  const state = rec.extensions?.approval?.state;
  // ANY value, including one this build does not know: an unrecognised approval
  // state is not evidence that the box survived, and the fail-safe reading of an
  // unknown state is the refusal, never the exec.
  if (state !== undefined) return { outcome: "run-not-attachable", state: String(state) };
  if (rec.closedAt !== undefined) return { outcome: "run-not-attachable", state: "closed" };
  const vm = rec.vmName;
  if (vm === undefined) return { outcome: "run-not-attachable", state: "no-box" };

  const messageId = opts.messageId ?? crypto.randomUUID();
  const requestId = rec.requestId;
  // Measure what the fold measures. The fold caps
  // `sanitizeForMessage(message).slice(0, ATTACH_MESSAGE_CHAR_CEILING)` —
  // POST-sanitize, and sanitize EXPANDS (a newline becomes 2 chars, \x7f and
  // the C1/U+2028 range 6) — so a raw-length guard would wave through an
  // escape-heavy message whose tail the fold then silently truncates while
  // the operator is told `attach-acked`: exactly the loss this check exists
  // to prevent. Guarding the sanitized length makes acceptance here imply no
  // truncation there. `ATTACH_MESSAGE_CHAR_CEILING`, never
  // `DIRECTIVE_TEXT_CHAR_CEILING` — steering.ts declares the two equal today
  // by coincidence, not by contract. A result arm, not a throw: over-ceiling
  // is PERMANENT, and an untyped throw reaches the CLI's `report()` as
  // transient/exit-1 "retry me" (see the NEITHER-arm-throws note below).
  const messageChars = sanitizeForMessage(message).length;
  if (messageChars > ATTACH_MESSAGE_CHAR_CEILING) {
    return {
      outcome: "message-over-ceiling",
      messageId,
      requestId,
      messageChars,
      ceilingChars: ATTACH_MESSAGE_CHAR_CEILING,
    };
  }
  // Floored, not trusted: `AttachOptions` is a documented seam and 0/NaN reach
  // here from it. See ATTACH_MIN_TICK_MS.
  const bounded = (v: number | undefined, dflt: number): number =>
    Number.isFinite(v) ? Math.max(ATTACH_MIN_TICK_MS, v as number) : dflt;
  const perCallTimeoutMs = bounded(opts.perCallTimeoutMs, ATTACH_PER_CALL_TIMEOUT_MS);
  const pollIntervalMs = bounded(opts.pollIntervalMs, ATTACH_POLL_INTERVAL_MS);
  // The ceiling gets no floor — a caller asking for 0 is asking for "one look,
  // do not wait", which the do-while below honours exactly — only a guard
  // against NaN, which would make every comparison false and skip the poll.
  const ceilingMs = Number.isFinite(opts.ceilingMs) ? Math.max(0, opts.ceilingMs as number) : ATTACH_ACK_CEILING_MS;
  const line: AttachLine = { messageId, requestId, runId, message, sentAt: new Date().toISOString() };

  // NEITHER arm throws. `withTimeout` is a HOST-side deadline with no abort
  // path into the box (`providers/timeout.ts`), so a timed-out `cat` may still
  // be writing — and a non-zero exit can follow a partial write. An untyped
  // throw here reached the CLI's `report()`, which classifies an unrecognised
  // error as transient = exit 1 = "retry me"; the retry mints a NEW
  // `crypto.randomUUID()` messageId, defeating the dedupe key this whole design
  // rests on and delivering the operator's guidance TWICE. `send-failed` is the
  // same "already done, still needs an operator" posture the not-acked arm
  // reasons its way to, and it carries the transport text so the operator can
  // see WHY.
  let sendDetail: string | undefined;
  try {
    const res = await withTimeout(
      deps.driver.exec(vm, ["sh", "-c", APPEND_SCRIPT], `${JSON.stringify(line)}\n`),
      perCallTimeoutMs,
      "attach-append",
    );
    if (res.exitCode !== 0) sendDetail = `exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`;
  } catch (e) {
    sendDetail = String((e as Error | null)?.message ?? e).slice(0, 200);
  }
  if (sendDetail !== undefined) {
    return { outcome: "attach-not-acked", messageId, requestId, reason: "send-failed", detail: sendDetail };
  }

  const now = opts.now ?? (() => performance.now());
  const baseline = now();
  let unusableTicks = 0;
  let unreachableTicks = 0;
  // Did the box ever answer a look at all? A clean "absent" is evidence it
  // did; used by the no-ack truthfulness guard below.
  let answered = false;
  let reason: AttachNotAckedReason = "no-ack";
  // do-while: one look always happens, so `ceilingMs: 0` means "no waiting",
  // not "no poll" (the old `while` evaluated false first and never read at all).
  do {
    // Bounded by what is LEFT, not just by the per-call constant: a tick
    // entered at 29.9 s could otherwise run a full 10 s timeout and make a
    // documented 30 s ceiling a ~40 s one. The exception is a look entered
    // with nothing LEFT at all — the single look a zero (or already-spent)
    // ceiling always makes. Clamping that remnant to `ATTACH_MIN_TICK_MS`
    // handed the one look a 10 ms deadline, which no real remote transport
    // can answer, and reported `box-unreachable` for a perfectly healthy box
    // — the documented seam's own meaning ("one look, do not wait") inverted
    // into "one look, doomed to fail". The look is the ceiling's whole
    // promise; it runs at the full per-call deadline. Only the WAITING is
    // zero: the re-check below still exits immediately after it.
    const remainingMs = ceilingMs - (now() - baseline);
    const tickTimeoutMs = remainingMs > 0 ? Math.min(perCallTimeoutMs, remainingMs) : perCallTimeoutMs;
    const verdict = await readAck(deps, vm, messageId, Math.max(ATTACH_MIN_TICK_MS, tickTimeoutMs));
    if (verdict === "acked") return { outcome: "attach-acked", messageId, requestId };
    if (verdict === "unusable") {
      unreachableTicks = 0;
      unusableTicks += 1;
      // A file that never parses is CORRUPTION, not latency: polling it to the
      // ceiling buys nothing (MARKER_UNUSABLE_TICKS_LIMIT's reading).
      if (unusableTicks >= ACK_UNUSABLE_TICKS_LIMIT) {
        reason = "acks-unreadable";
        break;
      }
    } else if (verdict === "unreachable") {
      unusableTicks = 0;
      unreachableTicks += 1;
      // Same argument, one layer down, and it is also the only bound this
      // module has on ABANDONED execs: `withTimeout` cannot cancel the call it
      // gave up on, so each timed-out tick leaves a session open in the box for
      // the rest of the ceiling. Breaking on the third caps that at three
      // instead of the ~60 a full 30 s poll would start. (Real cancellation
      // needs an abort path on `ProviderDriver.exec`, which the port has not
      // got; the late rejection itself is already pinned by `withTimeout`.)
      if (unreachableTicks >= ACK_UNUSABLE_TICKS_LIMIT) {
        reason = "box-unreachable";
        break;
      }
    } else {
      unusableTicks = 0; // a clean read clears both streaks (consecutive only)
      unreachableTicks = 0;
      answered = true;
    }
    // Re-check BEFORE sleeping, so a tick never sleeps past the ceiling.
    if (now() - baseline >= ceilingMs) break;
    await sleep(pollIntervalMs);
  } while (now() - baseline < ceilingMs);
  // `no-ack` means "appended cleanly, no ack inside the ceiling" — a claim the
  // append's clean exit supports only if the box ANSWERED the polls, i.e. at
  // least one read came back exit 0. When every look was UNREACHABLE — a call
  // that never came back, or one that came back and exited non-zero (unreadable
  // acks file, wiped steering root; see `readAck`) — reporting `no-ack` told
  // the operator the message IS queued on the strength of a poll that produced
  // no evidence about the file. The union is untouched, and `box-unreachable`
  // already has its own truthful remediation ("verify the box still exists").
  // A mix of clean reads and a trailing unreachable streak keeps `no-ack`: the
  // box demonstrably answered, and the docblock's four-reason table already
  // explains why that is the honest summary.
  if (reason === "no-ack" && !answered) reason = "box-unreachable";
  // This call neither dropped nor re-sent the message — but only the append is
  // established, not the queue's survival (a reboot wipes it with the run). If
  // the queue survives, `messageId` (the dedupe key) is what keeps a later
  // solicitation from delivering it twice.
  return { outcome: "attach-not-acked", messageId, requestId, reason };
}

/**
 * The engine leg of the transport, injected into `createSteering`.
 *
 * Re-reads the inbox every drain and never truncates it: truncation cannot be
 * made safe against a concurrent `cat >>` from `fleet attach`, and dedupe on
 * `messageId` (the controller's job) makes re-reading free of consequence.
 * Torn lines are skipped rather than fatal — a `cat >>` killed mid-append
 * leaves exactly one, and it must not break a solicitation
 * (`src/reverify/report.ts:291-323`'s rule).
 *
 * What it does NOT do is read without a bound. Not truncating is right, but it
 * left the file's size as the only limit on how much a solicitation reads and
 * parses — on `/run`, a tmpfs sized as a fraction of RAM. See
 * `INBOX_READ_CAP_BYTES`.
 */
/**
 * How the engine leg learns WHICH run it is. Optional because the suite drives
 * the engine leg directly and `SteeringInbox.drain(point)` carries no context —
 * only the host verb and this factory know a runId. Given one, drain filters to
 * it; without one, drain reads the inbox exactly as before.
 */
export interface SteeringInboxOptions {
  /** This run's id. `AttachLine.runId` is mandatory on every line the host
   *  verb writes, so a line addressed to a DIFFERENT run is not this run's
   *  guidance and must not be folded into its prompt (or acked — the ack would
   *  tell the OTHER run's `fleet attach` its message landed when this resident
   *  swallowed it). */
  ownRunId?: string;
}

/**
 * Serialization window for the host-local transport append (`ack` below): the
 * newline-guard read and the append must not interleave with another writer,
 * or two partial writes glue into one unparseable line and BOTH messages are
 * silently lost — the same two-victims shape APPEND_SCRIPT's `tail -c1` guard
 * documents for a torn tail, except that here neither line is torn.
 *
 * The lock is the repo's own (`src/lib/file-lock.ts`), with the
 * bank-provisioner's staleness policy: this append takes microseconds, so a
 * lock older than `ACK_LOCK_STALE_MS` is an orphan (SIGKILL/crash mid-append),
 * and a corrupt body or a dead pid is stale too — one bad lock file must not
 * wedge every ack on the box.
 *
 * BEST-EFFORT BY DESIGN: a lock that cannot be had in `ACK_LOCK_BLOCK_MS` (or
 * that errors) does NOT fail the ack. Falling back to the unlocked append is
 * today's behavior and is strictly better than skipping the ack — a lost ack
 * only costs the host leg its ceiling and a truthful `not-acked`, while a
 * thrown one costs the resident its whole solicitation. The lock narrows the
 * race; it does not claim to eliminate it.
 */
const ACK_LOCK_STALE_MS = 5_000;
const ACK_LOCK_BLOCK_MS = 2_000;

async function appendUnderAcksLock(append: () => void): Promise<void> {
  let release: (() => void) | null = null;
  try {
    release = await acquireFileLock(join(steeringRoot(), "acks.lock"), {
      label: "steering ack lock",
      isStale: ({ ageMs, pid }) => ageMs >= ACK_LOCK_STALE_MS || pid === undefined || isPidDead(pid),
      block: { timeoutMs: ACK_LOCK_BLOCK_MS, pollMs: 5 },
    });
  } catch {
    release = null; // deadline (or lock error) — append unlocked rather than lose the ack
  }
  try {
    append();
  } finally {
    try {
      release?.();
    } catch {
      // best-effort: a lock we could not release is left for the staleness
      // policy above to reclaim, never allowed to fail the ack.
    }
  }
}

export function localSteeringInbox(opts: SteeringInboxOptions = {}): SteeringInbox {
  const { ownRunId } = opts;
  return {
    async drain() {
      let text: string;
      try {
        text = readInboxTail(inboxPath());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      const out: { messageId: string; message: string }[] = [];
      let foreign = 0;
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const row = JSON.parse(line) as { messageId?: unknown; message?: unknown; runId?: unknown };
          // FOREIGN covers more than "a different run's id": a line with NO
          // runId at all is unattributable, and this drain cannot prove it is
          // this run's guidance. Folding it would spend this run's prompt
          // context on somebody's unaddressed bytes; acking it would tell an
          // unknown producer their message was consumed. Skip and count, no
          // fold, no ack — the same fail-safe posture the addressed-to-
          // another-run arm takes. (`AttachLine.runId` is mandatory on every
          // line the host verb writes, so a runId-less line was not written by
          // this transport at all.)
          if (ownRunId !== undefined && (typeof row.runId !== "string" || row.runId !== ownRunId)) {
            foreign += 1;
            continue;
          }
          if (typeof row.messageId === "string" && typeof row.message === "string") {
            out.push({ messageId: row.messageId, message: row.message });
          }
        } catch {
          /* torn or truncated line — ignore it */
        }
      }
      // A dropped line must not vanish silently — it is guidance somebody
      // queued for a run whose resident is NOT this one. One capped, best-effort
      // stderr note per drain (the same posture as approvers.ts's release-path
      // diagnostic): the count, never the lines.
      if (foreign > 0) {
        try {
          process.stderr.write(
            `steering inbox: skipped ${foreign} message(s) addressed to other runs\n`,
          );
        } catch {
          // best-effort diagnostic only
        }
      }
      return out;
    },
    async ack(messageId, point) {
      // Missing-path ENOENT is a NO-OP here, mirroring `drain` directly above:
      // the engine runs in the box, a vanished `/run/steering` (reboot; `/run`
      // is a tmpfs) is not this solicitation's fault, and an unacknowledged
      // message is the fail-safe direction — the host leg polls to its ceiling
      // and reports `not-acked`, which dedupe already makes safe. Letting the
      // ENOENT propagate, by contrast, aborted the whole solicitation fold.
      // Every OTHER errno (EACCES, EISDIR, …) still throws.
      try {
        mkdirSync(steeringRoot(), { recursive: true, mode: 0o700 });
        await appendUnderAcksLock(() => {
          // The newline guard, mirroring APPEND_SCRIPT's documented discipline.
          // `appendFileSync` concatenates onto whatever is last in the file, and
          // a torn tail — an engine killed between a `write` and its `\n`, the
          // same ENOSPC/kill shapes APPEND_SCRIPT's docblock enumerates for the
          // inbox — glues this ack onto that fragment: ONE unparseable line that
          // hides BOTH acks, so the OTHER run's `fleet attach` polls to its
          // ceiling reporting `no-ack` over a message this resident did consume.
          // The last byte decides: a non-empty file not ending in `\n` gets the
          // separator prepended. (ENOSPC between the read and the append can
          // still tear the NEW line — nothing the host leg has not always been
          // exposed to — but a torn tail no longer takes the next ack down.)
          const line = `${JSON.stringify({ messageId, ackedAt: new Date().toISOString(), point })}\n`;
          // `"a+"` creates the file when absent (O_CREAT) and keeps append
          // semantics (O_APPEND), so `mode: 0o600` applies exactly as
          // `appendFileSync(path, …, { mode })` did — and the append runs on
          // THIS fd, so the tail check below reads the same file it writes. It
          // must be RDWR, not write-only: the tail read on a write-only fd is
          // EBADF, which would abort every ack onto a non-empty acks file.
          const fd = openSync(acksPath(), "a+", 0o600);
          try {
            const size = fstatSync(fd).size;
            const tail = Buffer.alloc(1);
            // 0 bytes read means the file was empty (or vanished) — either way
            // nothing to separate; an empty file needs no leading newline.
            if (size > 0 && readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 0x0a) {
              appendFileSync(fd, "\n");
            }
            appendFileSync(fd, line);
          } finally {
            closeSync(fd);
          }
          // `mode` applies only at CREATION — a pre-existing lax acks file keeps
          // its permissions through the append. Belt-over-braces chmod, the same
          // case the inbox leg's APPEND_SCRIPT covers with its trailing
          // `chmod 600 "$f"`.
          chmodSync(acksPath(), 0o600);
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
    },
  };
}
