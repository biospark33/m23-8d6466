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
 *    `fanout-primitive.ts:688-696`, whose fix (`exec` + `cat` + `shellQuote`)
 *    this mirrors.
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
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DIRECTIVE_TEXT_CHAR_CEILING, type SteeringInbox } from "../phase-engine/steering.ts";
import type { ProviderDriver } from "../providers/driver.ts";
import type { RunRecordStore } from "../providers/run-record.ts";
import { withTimeout } from "../providers/timeout.ts";

/**
 * Steering-channel root. `/run/steering` in the box. `QDS_STEERING_ROOT` exists
 * solely so the host-side suite can exercise the real paths where `/run` is
 * root-owned (Linux CI) or absent (darwin dev) — the same role, and the same
 * read-at-call-time discipline, as `journal.ts`'s `runMarkerRoot()`.
 */
export function steeringRoot(): string {
  return process.env.QDS_STEERING_ROOT ?? "/run/steering";
}

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

export type AttachResult =
  | { outcome: "attach-acked"; messageId: string; requestId?: string }
  | { outcome: "attach-not-acked"; messageId: string; requestId?: string }
  | { outcome: "run-not-attachable"; state: string };

/**
 * POSIX single-quote wrapping. Mirrored from the primitive's own quoter
 * (`fanout-primitive.ts:755-757`), as `pipeline-run-remote.ts:49-52` already
 * mirrors it — it is private to each module by convention.
 */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Append-one-line, in-box. The argv carries only this fixed script; the payload
 * arrives on stdin, so `message`/`messageId`/`requestId` — none of them
 * sanitized — cannot break out of the command regardless of quotes, shell
 * metacharacters or embedded newlines. `cat` writes stdin verbatim and parses
 * nothing.
 *
 * `umask 077` runs FIRST so the file is 0600 from the instant `cat` creates it,
 * never briefly world-readable; `mkdir -p` is what creates `/run/steering/`;
 * the trailing `chmod` is belt-over-braces against a pre-existing lax file.
 * Lifted from `credentials.ts:347-358`'s `deliverScript`.
 */
function appendScript(path: string): string {
  return (
    `umask 077 && mkdir -p ${shellQuote(dirname(path))} && ` +
    `cat >> ${shellQuote(path)} && chmod 600 ${shellQuote(path)}`
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One ack tick. "absent" is a CLEAN read (no acks file, or none of ours yet) and
 * resets the corruption streak; "unusable" is a present file yielding no
 * parseable line at all.
 */
async function readAck(
  deps: AttachDeps,
  vm: string,
  messageId: string,
  timeoutMs: number,
): Promise<"acked" | "absent" | "unusable"> {
  let stdout: string;
  try {
    const res = await withTimeout(
      deps.driver.exec(vm, ["sh", "-c", `cat ${shellQuote(acksPath())}`]),
      timeoutMs,
      "attach-ack-read",
    );
    // A non-zero `cat` is "not there yet", not a fault: the engine has not
    // reached a solicitation point. Same reading as the race probe's `test -f`.
    if (res.exitCode !== 0) return "absent";
    stdout = res.stdout;
  } catch {
    return "absent"; // transport skip — no evidence either way
  }
  if (stdout.trim().length === 0) return "absent";
  let parsedAny = false;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let row: { messageId?: unknown };
    try {
      row = JSON.parse(line) as { messageId?: unknown };
    } catch {
      continue; // torn or truncated line — skip it (report.ts's rule)
    }
    parsedAny = true;
    if (row.messageId === messageId) return "acked";
  }
  return parsedAny ? "absent" : "unusable";
}

/**
 * Queue one operator message for the run's resident and wait for the engine to
 * fold it into a solicitation.
 *
 * Refuses `run-not-attachable` while the run is `pausing` or
 * `awaiting-approval` (box gone or going) and when no box was ever recorded —
 * checked BEFORE anything is queued, so a refusal leaves the extension and the
 * inbox untouched.
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
  if (state === "pausing" || state === "awaiting-approval") {
    return { outcome: "run-not-attachable", state: String(state) };
  }
  const vm = rec.vmName;
  if (vm === undefined) return { outcome: "run-not-attachable", state: "no-box" };
  // The fold caps at the same ceiling; refusing here means an operator is told
  // their message was too long instead of silently losing its tail.
  if (message.length > DIRECTIVE_TEXT_CHAR_CEILING) {
    throw new Error(
      `attach refused: message is ${message.length} chars, over the ${DIRECTIVE_TEXT_CHAR_CEILING}-char ceiling`,
    );
  }

  const messageId = opts.messageId ?? crypto.randomUUID();
  const requestId = rec.requestId;
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? ATTACH_PER_CALL_TIMEOUT_MS;
  const line: AttachLine = { messageId, requestId, runId, message, sentAt: new Date().toISOString() };

  const res = await withTimeout(
    deps.driver.exec(vm, ["sh", "-c", appendScript(inboxPath())], `${JSON.stringify(line)}\n`),
    perCallTimeoutMs,
    "attach-append",
  );
  if (res.exitCode !== 0) {
    throw new Error(`attach failed to queue for ${runId} (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 200)}`);
  }

  const now = opts.now ?? (() => performance.now());
  const ceilingMs = opts.ceilingMs ?? ATTACH_ACK_CEILING_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? ATTACH_POLL_INTERVAL_MS;
  const baseline = now();
  let unusableTicks = 0;
  while (now() - baseline < ceilingMs) {
    const verdict = await readAck(deps, vm, messageId, perCallTimeoutMs);
    if (verdict === "acked") return { outcome: "attach-acked", messageId, requestId };
    if (verdict === "unusable") {
      unusableTicks += 1;
      if (unusableTicks >= ACK_UNUSABLE_TICKS_LIMIT) break;
    } else {
      unusableTicks = 0; // a clean read clears the streak (consecutive only)
    }
    // Re-check BEFORE sleeping, so a tick never sleeps past the ceiling.
    if (now() - baseline >= ceilingMs) break;
    await sleep(pollIntervalMs);
  }
  // The message stays queued — neither dropped nor re-sent. `messageId` is the
  // dedupe key, so a later solicitation still delivers it exactly once.
  return { outcome: "attach-not-acked", messageId, requestId };
}

/**
 * The engine leg of the transport, injected into `createSteering`.
 *
 * Reads the WHOLE inbox every drain and never truncates it: truncation cannot
 * be made safe against a concurrent `cat >>` from `fleet attach`, and dedupe on
 * `messageId` (the controller's job) makes re-reading free of consequence.
 * Torn lines are skipped rather than fatal — a `cat >>` killed mid-append
 * leaves exactly one, and it must not break a solicitation
 * (`src/reverify/report.ts:291-323`'s rule).
 */
export function localSteeringInbox(): SteeringInbox {
  return {
    async drain() {
      let text: string;
      try {
        text = readFileSync(inboxPath(), "utf8");
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
    },
  };
}
