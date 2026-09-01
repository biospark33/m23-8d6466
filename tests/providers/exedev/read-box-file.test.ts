/**
 * `readBoxFile` — truncation is OVERSIZED, never content (wave-5 review round 2).
 *
 * A capped exec read returns a PREFIX. Handing that back as `{kind:"content"}`
 * lets a half-read marker parse as a whole one, which is how the fanout race
 * would claim a winner off a truncated journal. It is also distinct from
 * "unreadable" (present at test, nonzero at cat): that failure is transient
 * and worth retrying, but a permanently oversized marker is not — the race
 * must count it as unusable, never poll it forever.
 */
import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/providers/driver.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";

function driverOf(read: ExecResult) {
  return {
    exec: async (_vm: string, argv: string[]): Promise<ExecResult> =>
      argv[2]?.startsWith("test -f") ? { stdout: "", stderr: "", exitCode: 0 } : read,
  };
}

/** The same fake with `execTimed` PRESENT, recording what each call was given.
 *  `exec` throws: taking it when a timed seam exists is the bug this pins. */
function timedDriverOf(read: ExecResult) {
  const seen: Array<{ argv: string[]; timeoutMs: number }> = [];
  return {
    seen,
    driver: {
      exec: async (): Promise<ExecResult> => {
        throw new Error("readBoxFile took the untimed exec path while execTimed was available");
      },
      execTimed: async (_vm: string, argv: string[], timeoutMs: number): Promise<ExecResult> => {
        seen.push({ argv, timeoutMs });
        return argv[2]?.startsWith("test -f") ? { stdout: "", stderr: "", exitCode: 0 } : read;
      },
    },
  };
}

describe("readBoxFile", () => {
  test("a truncated read is oversized, not content", async () => {
    const r = await readBoxFile(driverOf({ stdout: "{partial", stderr: "", exitCode: 0, truncated: true }), "vm", "/run/journal/final.json", 5_000);
    expect(r).toEqual({ kind: "oversized" });
  });

  test("an untruncated read is still content", async () => {
    const r = await readBoxFile(driverOf({ stdout: "{}", stderr: "", exitCode: 0 }), "vm", "/run/journal/final.json", 5_000);
    expect(r).toEqual({ kind: "content", content: "{}" });
  });

  test("the caller's deadline reaches BOTH execs — not the transport's 120 s default", async () => {
    // `exec` hard-codes DEFAULT_EXEC_TIMEOUT_MS, so `withTimeout` expiring only
    // ABANDONS the ssh: the process keeps running against the box for up to two
    // minutes past the deadline its caller set, with its output discarded. The
    // gate budget and the fanout race both believed they had killed it. When the
    // driver can be given a deadline, it MUST be — and it must be this one, on
    // the presence probe as well as the read.
    const { seen, driver } = timedDriverOf({ stdout: "{}", stderr: "", exitCode: 0 });
    const r = await readBoxFile(driver, "vm", "/etc/qds-image.json", 5_000);
    expect(r).toEqual({ kind: "content", content: "{}" });
    expect(seen.map((c) => c.timeoutMs)).toEqual([5_000, 5_000]);
    expect(seen.map((c) => c.argv[2])).toEqual(["test -f '/etc/qds-image.json'", "cat '/etc/qds-image.json'"]);
  });
});
