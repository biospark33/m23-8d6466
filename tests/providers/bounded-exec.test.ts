import { describe, expect, test } from "bun:test";
import { ACKS_READ_CAP_BYTES } from "../../src/fleet/attach.ts";
import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../../src/providers/bounded-exec";
import { boundedEcho, MAX_ECHO } from "../../src/providers/step-log.ts";

/** The seven call sites all do exactly this: spawn, then read the pipe. */
async function run(
  argv: string[],
  cap: number = EXEC_MAX_OUTPUT_BYTES,
  drainPastCap = false,
): Promise<{ text: string; truncated: boolean; exitCode: number }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const kill = () => {
    proc.kill(9);
  };
  const read = drainPastCap
    ? readBounded(proc.stdout, cap, { exited: proc.exited, drainPastCap: true })
    : readBounded(proc.stdout, cap, { kill, exited: proc.exited });
  const [{ text, truncated }, exitCode] = await Promise.all([read, proc.exited]);
  return { text, truncated, exitCode };
}

describe("readBounded", () => {
  test("a child emitting 100 MB is killed at the cap and returns a truncation marker", async () => {
    const cap = 1 << 20;
    const r = await run(["bash", "-c", "yes | head -c 100000000"], cap);
    expect(r.text.length).toBeLessThanOrEqual(cap + 64);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("[output truncated at");
  }, 30_000);

  test("output under the cap is byte-identical to an unbounded read — no marker", async () => {
    const r = await run(["bash", "-c", "printf 'hello\\nworld\\n'"]);
    expect(r.text).toBe("hello\nworld\n");
    expect(r.truncated).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  test("output at exactly the cap is not truncated", async () => {
    const cap = 4096;
    const r = await run(["bash", "-c", `head -c ${cap} /dev/zero | tr '\\0' 'a'`], cap);
    expect(r.text.length).toBe(cap);
    expect(r.truncated).toBe(false);
  });

  test("an ignored stream (not piped) reads as empty", async () => {
    const proc = Bun.spawn(["true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    expect(await readBounded(proc.stdout)).toEqual({ text: "", truncated: false });
  });

  test("a multibyte char split across chunks survives the decode", async () => {
    const r = await run(["bash", "-c", "printf 'héllo wörld ✓'"]);
    expect(r.text).toBe("héllo wörld ✓");
  });

  test("drainPastCap: the child runs to completion and keeps its own exit code", async () => {
    const cap = 1 << 20;
    // Verbose but PASSING user work: 4 MB of output, then exit 0.
    const r = await run(["bash", "-c", "yes | head -c 4000000; exit 0"], cap, true);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(cap + 64);
    expect(r.exitCode).toBe(0); // NOT killed — that is the whole point
  }, 30_000);

  test("without drainPastCap the same child is killed (non-zero exit)", async () => {
    const r = await run(["bash", "-c", "yes | head -c 4000000; exit 0"], 1 << 20);
    expect(r.truncated).toBe(true);
    expect(r.exitCode).not.toBe(0);
  }, 30_000);

  test("an already-aborted signal settles the read instead of hanging", async () => {
    const proc = Bun.spawn(["bash", "-c", "sleep 30"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    try {
      const r = await readBounded(proc.stdout, EXEC_MAX_OUTPUT_BYTES, { signal: AbortSignal.abort() });
      expect(r).toEqual({ text: "", truncated: false });
    } finally {
      proc.kill(9);
      await proc.exited;
    }
  }, 10_000);

  test("the default cap covers attach's ack-read window — BOTH constants pinned absolutely", () => {
    // The floor set by `src/fleet/attach.ts`'s ACKS_READ_CAP_BYTES: its
    // `tail -c` window rides the generic `driver.exec` seam, and a cap below
    // the window truncates the read from the front, dropping the newest acks
    // and turning a delivered message into a spurious `attach-not-acked`.
    //
    // BOTH sides are pinned to their literals, not related by `>=`. A `>=`
    // between two imports passes whenever they move TOGETHER, so a joint bump
    // (both doubled to buy a bigger window, say) sailed through while it
    // changed how much of a box's stdout a single exec may hold, and how much
    // attach re-reads, in one unreviewed line. An absolute pin is the alarm;
    // whoever moves a constant arrives here and decides on purpose.
    expect(EXEC_MAX_OUTPUT_BYTES).toBe(512 * 1024);
    expect(ACKS_READ_CAP_BYTES).toBe(512 * 1024);
  });
});

/**
 * `boundedEcho` is the other half of this file's subject: the bound on what a
 * provider-originated string may put into a log line, and the reason its pins
 * live here rather than in step-log.test.ts is that this wave's ownership
 * splits the providers cluster — these are the P7 pins, and this is the file
 * this fixer owns. `MAX_ECHO` is pinned absolutely for the same reason the cap
 * above is: the budget is a contract with every sink that formats around it.
 */
describe("boundedEcho — the cap is on the RETURN, in UTF-16 units, code-point-safe", () => {
  /** True when `s` carries a surrogate half with no partner. */
  function hasLoneSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      if (u >= 0xd800 && u <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i++;
      } else if (u >= 0xdc00 && u <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  test("MAX_ECHO is 96 — the budget every sink formats against", () => {
    expect(MAX_ECHO).toBe(96);
  });

  test("short input passes through whole, undefined is named", () => {
    expect(boundedEcho("qds-20260831-ab12cd34")).toBe("qds-20260831-ab12cd34");
    expect(boundedEcho(undefined)).toBe("(none)");
  });

  test("the `…(N chars)` suffix rides INSIDE the cap — the total is never over 96", () => {
    // `!` is outside every redaction token charset, so the input survives
    // `redactSecrets` byte-for-byte and the arithmetic is exact.
    const out = boundedEcho("!".repeat(500));
    expect(out.length).toBe(MAX_ECHO);
    expect(out.endsWith("…(500 chars)")).toBe(true);
    expect(out.startsWith("!".repeat(MAX_ECHO - "…(500 chars)".length))).toBe(true);
  });

  test("a cut that lands mid-surrogate-pair backs up one unit — no lone half reaches the sink", () => {
    // 83 `!` (1 unit each) + 9 U+1D11E (2 units each) = 101 units, so the
    // suffix is `…(101 chars)` (12 units) and the head budget is 96 - 12 = 84.
    // Unit 83 is the HIGH half of the first U+1D11E: the naive
    // `slice(0, 84)` that the back-up replaced ended the head on a lone high
    // surrogate — the halved pair is what JSON.stringify then mangles and a
    // file write replaces with U+FFFD. The cut backs up to 83 and drops the
    // whole pair instead.
    const out = boundedEcho(`${"!".repeat(83)}${"𝄞".repeat(9)}`);
    expect(out).toBe(`${"!".repeat(83)}…(101 chars)`);
    expect(out.length).toBe(95);
    expect(out.length).toBeLessThanOrEqual(MAX_ECHO);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  test("a boundary that already lands on a code point loses nothing to the back-up", () => {
    // 82 `!` + a U+1D11E lands the 84-unit cut exactly BETWEEN pairs, so the
    // back-up does not fire and the head keeps a whole supplementary character.
    // The sibling test above pins the back-up; this one pins that it is not
    // also eating a character at every even boundary.
    const out = boundedEcho(`${"!".repeat(82)}${"𝄞".repeat(9)}`);
    expect(out).toBe(`${"!".repeat(82)}𝄞…(100 chars)`);
    expect(out.length).toBe(MAX_ECHO);
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});
