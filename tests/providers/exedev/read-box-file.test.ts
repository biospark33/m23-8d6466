/**
 * `readBoxFile` — truncation is UNREADABLE, never content (wave-5 review).
 *
 * A capped exec read returns a PREFIX. Handing that back as `{kind:"content"}`
 * lets a half-read marker parse as a whole one, which is how the fanout race
 * would claim a winner off a truncated journal.
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
  test("a truncated read is unreadable, not content", async () => {
    const r = await readBoxFile(driverOf({ stdout: "{partial", stderr: "", exitCode: 0, truncated: true }), "vm", "/run/journal/final.json", 5_000);
    expect(r.kind).toBe("unreadable");
    expect(r.kind === "unreadable" && r.stderr).toContain("capture cap");
  });

  test("an untruncated read is still content", async () => {
    const r = await readBoxFile(driverOf({ stdout: "{}", stderr: "", exitCode: 0 }), "vm", "/run/journal/final.json", 5_000);
    expect(r).toEqual({ kind: "content", content: "{}" });
  });
});
