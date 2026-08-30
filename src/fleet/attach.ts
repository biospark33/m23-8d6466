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
 *    writes `runMarkerPath()` (`/run/journal/final.json`) with `writeFileSync`.
 *    The engine addresses in-box paths as local paths; that is the repo's
 *    settled convention, and it is why the engine needs no driver reference.
 *
 * The story specifies `copyFile` for the ack read and an in-box engine. Both
 * are corrected here on evidence: see the two paragraphs above, and
 * `pipeline-run-remote.ts:5-19` ("the box image carries no bun/node… phases
 * execute ON THE BOX orchestrated FROM THE HOST"). Recorded in the Dev Agent
 * Record.
 */
import { appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

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
 * LOCAL CALLERS ONLY — the engine leg below (which runs IN the box) and the
 * suite. The host leg must NEVER interpolate this into a script that runs in
 * the box: with the variable set on the host and unset in the box the two legs
 * addressed DIFFERENT files, `mkdir -p` created the wrong one, `cat` exited 0,
 * and the operator was told the message was queued in a box that would drain
 * the real path forever. The box resolves its own root — see
 * `BOX_STEERING_ROOT_SH`.
 */
export function steeringRoot(): string {
  return process.env.QDS_STEERING_ROOT ?? "/run/steering";
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
 *  - `no-ack` — appended cleanly, no ack inside the ceiling. The message IS
 *    queued; the resident simply has not reached a solicitation point.
 *  - `send-failed` — the append itself failed or timed out. `withTimeout` is a
 *    HOST-side deadline that cannot cancel the in-box `cat`, and a non-zero
 *    `cat` can follow a partial write, so the line MAY have landed.
 *  - `acks-unreadable` — the acks file is present and no line of it parses.
 *    Corruption, not latency (see `ACK_UNUSABLE_TICKS_LIMIT`).
 *  - `box-unreachable` — the ack read did not come back at all. The box, not
 *    the file, is the thing that stopped answering.
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
 */
export const ACKS_READ_CAP_BYTES = 1_048_576;

/**
 * The ack read, on the box's own path for the reason the append script gives.
 * `tail -c` (already used by APPEND_SCRIPT's newline guard) bounds the read to
 * the newest bytes — see `ACKS_READ_CAP_BYTES`. The cap constant is the only
 * interpolation and it is a module-level numeric literal, so argv stays a
 * constant, payload-free script exactly like the `cat` it replaces; an absent
 * file exits non-zero under `tail` just as it did under `cat`.
 */
const ACK_READ_SCRIPT = [BOX_STEERING_ROOT_SH, `tail -c ${ACKS_READ_CAP_BYTES} "$root/acks.ndjson"`].join(" && ");

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
    if (size <= INBOX_READ_CAP_BYTES) return readFileSync(fd, "utf8");
    const buf = Buffer.alloc(INBOX_READ_CAP_BYTES);
    readSync(fd, buf, 0, INBOX_READ_CAP_BYTES, size - INBOX_READ_CAP_BYTES);
    const text = buf.toString("utf8");
    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  } finally {
    closeSync(fd);
  }
}

/**
 * One ack tick. "absent" is a CLEAN read (no acks file, or none of ours yet) and
 * resets both streaks; "unusable" is a present file yielding no parseable line
 * at all; "unreachable" is the BOX declining to answer.
 *
 * That last one used to be "absent" too — "no evidence either way" — and the
 * cost was the destroyed-box case: 60 identical absent ticks, the full 30 s
 * poll, and then a remediation ("the message IS queued in the box; check the
 * resident agent is running") whose every clause was false. A `cat` that runs
 * and exits non-zero is genuinely "not there yet" (the engine has not reached a
 * solicitation point — the race probe's `test -f` reading); a call that never
 * comes back is a different fact about a different thing.
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
    if (res.exitCode !== 0) return "absent";
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
  let reason: AttachNotAckedReason = "no-ack";
  // do-while: one look always happens, so `ceilingMs: 0` means "no waiting",
  // not "no poll" (the old `while` evaluated false first and never read at all).
  do {
    // Bounded by what is LEFT, not just by the per-call constant: a tick
    // entered at 29.9 s could otherwise run a full 10 s timeout and make a
    // documented 30 s ceiling a ~40 s one.
    const remainingMs = ceilingMs - (now() - baseline);
    const verdict = await readAck(deps, vm, messageId, Math.max(ATTACH_MIN_TICK_MS, Math.min(perCallTimeoutMs, remainingMs)));
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
    }
    // Re-check BEFORE sleeping, so a tick never sleeps past the ceiling.
    if (now() - baseline >= ceilingMs) break;
    await sleep(pollIntervalMs);
  } while (now() - baseline < ceilingMs);
  // The message stays queued — neither dropped nor re-sent. `messageId` is the
  // dedupe key, so a later solicitation still delivers it exactly once.
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
export function localSteeringInbox(): SteeringInbox {
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
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const row = JSON.parse(line) as { messageId?: unknown; message?: unknown };
          if (typeof row.messageId === "string" && typeof row.message === "string") {
            out.push({ messageId: row.messageId, message: row.message });
          }
        } catch {
          /* torn or truncated line — ignore it */
        }
      }
      return out;
    },
    async ack(messageId, point) {
      mkdirSync(steeringRoot(), { recursive: true, mode: 0o700 });
      appendFileSync(acksPath(), `${JSON.stringify({ messageId, ackedAt: new Date().toISOString(), point })}\n`, {
        mode: 0o600,
      });
      // `mode` applies only at CREATION — a pre-existing lax acks file keeps
      // its permissions through the append. Belt-over-braces chmod, the same
      // case the inbox leg's APPEND_SCRIPT covers with its trailing
      // `chmod 600 "$f"`.
      chmodSync(acksPath(), 0o600);
    },
  };
}
