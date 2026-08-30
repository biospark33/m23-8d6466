/**
 * F036/F037: the ONE bounded child-output reader.
 *
 * Seven spawn sites read child stdio with `new Response(proc.stdout).text()`
 * and no size ceiling — a chatty (or hostile) child could buffer its whole
 * output into the orchestrator's heap. Timeouts bound TIME, not BYTES.
 *
 * `readBounded` is that ceiling: a chunked read that stops hard at `cap`
 * bytes, cancels the reader, optionally kills the child, and returns the
 * captured prefix plus `truncated: true`. Output UNDER the cap is byte-for-byte
 * what `new Response(...).text()` returned — no marker, no behaviour change.
 *
 * The semantics are lifted verbatim from `test-results.ts`'s `readCapped`
 * (drain backstop and all), which now imports this one so the cap has a single
 * home.
 */

/**
 * Default ceiling on captured child output, per stream: 512 KiB.
 *
 * Sized for evidence, not for data: every consumer either parses a summary line
 * or writes a tail into a journal (`command-gate.ts` cuts to 1000 chars). Half a
 * megabyte of stdout is already a pathological gate, and the cap is about heap,
 * not about display.
 */
export const EXEC_MAX_OUTPUT_BYTES = 512 * 1024;

/** Bounded drain timeout for stream reads after the child's exit resolves —
 * prevents hanging when a descendant holds the pipe open. */
const DRAIN_TIMEOUT_MS = 2000;

export interface ReadBoundedOptions {
  /** Cancels the read early (aborts are the caller's kill path, not ours). */
  signal?: AbortSignal;
  /** The child's exit promise. Arms the drain backstop once the child is gone;
   * without it the read waits for the pipe to close, exactly as today. */
  exited?: Promise<number>;
  /** Called once when the cap is breached — the SIGKILL seam. Callers that own
   * a process group (`killTree`) pass that instead of a bare `proc.kill`. */
  kill?: () => void;
  /**
   * Keep reading past the cap and DISCARD the excess instead of killing the
   * child (`kill` is then never called). For sites whose child is USER work —
   * a gate command, a reverified repo's test command — where a verbose but
   * passing run must still be allowed to pass: killing it at 512 KiB turns
   * chatty output into a spurious failure. Heap stays bounded either way; only
   * the child's fate differs. Default false. */
  drainPastCap?: boolean;
  /** Appended to the text when truncated. Default: a one-line marker naming
   * the cap. Pass "" for a caller that must not see synthetic bytes. */
  marker?: string;
}

export interface BoundedRead {
  text: string;
  truncated: boolean;
}

/**
 * Read a piped stdio stream to text, stopping hard at `cap` bytes.
 *
 * Must be started IMMEDIATELY after spawn: awaiting the exit first would leave
 * the pipe undrained — a chatty child fills the 64 KiB pipe buffer, blocks on
 * write, and the exit being awaited never happens (deadlock).
 */
export async function readBounded(
  stream: ReadableStream<Uint8Array> | number | undefined | null,
  cap: number = EXEC_MAX_OUTPUT_BYTES,
  opts: ReadBoundedOptions = {},
): Promise<BoundedRead> { // dp:ok the read loop's try/catch sits inside the drain IIFE, which D017's frame walker attributes there, not to readBounded
  if (stream === undefined || stream === null || typeof stream === "number") {
    return { text: "", truncated: false };
  }
  const { signal, exited, kill, drainPastCap = false } = opts;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;

  // Race the read loop against a drain timeout — if a descendant holds the
  // pipe open after the child exits, cancel the reader and return what we
  // captured rather than hanging forever.
  const drainPromise = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        if (drainPastCap) {
          truncated = true;
          continue; // read to the end, keep nothing — the child runs to completion
        }
        truncated = true;
        // Kill BEFORE cancelling: a child that keeps writing into a cancelled
        // pipe dies of SIGPIPE eventually, but only when it next writes — a
        // producer that stalls would sit there holding the box.
        try {
          kill?.();
        } catch {
          // already gone
        }
        await reader.cancel().catch(() => {
          // stream already closed
        });
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    if (!truncated) {
      text += decoder.decode(); // flush any trailing partial multibyte char
    }
  })();

  // DRAIN_TIMEOUT_MS backstop — if the stream never closes, we abort and
  // return partial text. The caller's own abort race is the PRIMARY guard;
  // this is for pathological processes that never close the pipe.
  //
  // The timer is ARMED ONLY AFTER `exited` resolves: readers start at spawn,
  // but the backstop exists for a descendant holding the pipe open after the
  // child exits. Arming it at read start would cancel the reader mid-run on
  // any legitimate command longer than DRAIN_TIMEOUT_MS, losing its terminal
  // output. With no `exited` the backstop never arms at all.
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let readerSettled = false;
  const timeout = new Promise<"timeout">((resolve) => {
    onAbort = () => {
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      resolve("timeout");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // An AbortSignal never re-fires: a signal that was ALREADY aborted at
    // registration would leave this promise pending forever.
    if (signal?.aborted) onAbort();
    void exited?.then(() => {
      if (readerSettled) return; // drain finished before exit — nothing to arm
      drainTimer = setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS);
      drainTimer.unref();
    });
  });

  const result = await Promise.race([drainPromise, timeout]);
  readerSettled = true;
  if (drainTimer !== undefined) clearTimeout(drainTimer);
  // Balanced listener lifecycle: remove on EVERY settle path. On the abort path
  // { once: true } already consumed it (removal is then a harmless no-op); on
  // every other path this is what keeps a reused non-aborted signal from
  // accumulating dead listeners per call.
  if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  if (result === "timeout") { // dp:ok not a function — an `if` block the frame walker mis-attributes, the `new Promise((resolve) => {` braces above being at paren depth > 0
    // Drain timed out — cancel the reader and accept partial data.
    //
    // wave-5 review: NOT unconditionally `truncated = true` here. This path
    // fires for TWO structurally indistinguishable cases: (a) a genuinely
    // stalled pipe where trailing bytes are lost, and (b) the drain backstop
    // outliving a descendant that inherited the pipe AFTER the real output
    // was already fully read (test-results.ts's round-11 hardening test
    // depends on exactly this: a summary line written before exit, followed
    // by a backgrounded holder, must still parse — `bounded-exec.test.ts`'s
    // already-aborted-signal case is the same shape with zero bytes). Marking
    // every timeout truncated regresses both, and `readBounded` has no way to
    // tell the two apart from here. Left for a future story: either a
    // separate `drainedIncomplete` reason callers opt into, or reader-side
    // evidence (a pending `read()` promise vs. one that already resolved)
    // sufficient to distinguish them.
    await reader.cancel().catch(() => {});
  }
  if (truncated) {
    text += opts.marker ?? `\n[output truncated at ${cap} bytes]`;
  }
  return { text, truncated };
}
