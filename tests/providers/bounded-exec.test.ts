import { describe, expect, test } from "bun:test";
import { ACKS_READ_CAP_BYTES } from "../../src/fleet/attach.ts";
import { EXEC_MAX_OUTPUT_BYTES, readBounded } from "../../src/providers/bounded-exec";

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

  test("the default cap covers attach's ack-read window and no less", () => {
    // The floor set by `src/fleet/attach.ts`'s ACKS_READ_CAP_BYTES: its
    // `tail -c` window rides exec, and a cap below the window truncates the
    // read from the front, dropping the newest acks and turning a delivered
    // message into a spurious `attach-not-acked`. attach's own transport test
    // pins the same number from its side (the `tail -c` argv), so the two
    // literals guard each other. Asserted against the imported constant, not
    // a restated literal — a bump to either side that breaks the floor fails
    // HERE, by name, instead of passing a stale 1 MiB by coincidence.
    expect(EXEC_MAX_OUTPUT_BYTES).toBe(1_048_576);
    expect(EXEC_MAX_OUTPUT_BYTES).toBeGreaterThanOrEqual(ACKS_READ_CAP_BYTES);
  });
});
