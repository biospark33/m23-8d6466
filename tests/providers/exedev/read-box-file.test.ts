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

describe("readBoxFile", () => {
  test("a truncated read is oversized, not content", async () => {
    const r = await readBoxFile(driverOf({ stdout: "{partial", stderr: "", exitCode: 0, truncated: true }), "vm", "/run/journal/final.json", 5_000);
    expect(r).toEqual({ kind: "oversized" });
  });

  test("an untruncated read is still content", async () => {
    const r = await readBoxFile(driverOf({ stdout: "{}", stderr: "", exitCode: 0 }), "vm", "/run/journal/final.json", 5_000);
    expect(r).toEqual({ kind: "content", content: "{}" });
  });
});
