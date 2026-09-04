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

  test("a cap-KILLED read (truncated AND exit 137) is oversized, not unreadable", async () => {
    // The cap breach kills the exec (bounded-exec's SIGKILL seam), so a cap-hit
    // read carries BOTH facts at once. Exit-code-first classified it
    // "unreadable", and 137 upstream reads as a transport fault whose
    // remediation is "re-create the box" — a retry loop against a condition
    // this module documents as permanent. Truncation wins.
    const r = await readBoxFile(driverOf({ stdout: "{partial", stderr: "", exitCode: 137, truncated: true }), "vm", "/etc/qds-image.json", 5_000);
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
    // Both legs are budgeted from the SAME deadline, so neither exceeds what
    // the caller said (the sharing itself is pinned by the test below, which
    // spends real time in the probe). `> 0` used to ride here too and could not
    // fail: `left()` is `Math.max(1, …)`, so it holds for every possible
    // implementation. Replaced with the claim that CAN fail — this fake returns
    // instantly, so the probe must get essentially the whole budget, which a
    // regression that halved or hard-coded the per-leg deadline would break.
    for (const call of seen) {
      expect(call.timeoutMs).toBeLessThanOrEqual(5_000);
    }
    expect(seen[0]?.timeoutMs).toBeGreaterThan(4_900);
    expect(seen.length).toBe(2);
    expect(seen.map((c) => c.argv[2])).toEqual(["test -f '/etc/qds-image.json'", "cat '/etc/qds-image.json'"]);
  });

  test("the two legs SHARE one budget — a slow probe shortens the read, never buys a second deadline", async () => {
    // `deadlineMs` used to be handed to each exec in full, so a hung box cost
    // its caller up to 2 × deadlineMs. Neither caller has a second budget to
    // spend: setup-gate's B0 passes ONE `budgetFree()` snapshot and is then
    // measured against `gateTimeoutMs`, and the fanout race ticks against a
    // per-tick deadline. The probe here spends real time out of the shared
    // window; the read must be handed what is LEFT of it.
    const seen: number[] = [];
    const driver = {
      exec: async (): Promise<ExecResult> => {
        throw new Error("readBoxFile took the untimed exec path while execTimed was available");
      },
      execTimed: async (_vm: string, argv: string[], timeoutMs: number): Promise<ExecResult> => {
        seen.push(timeoutMs);
        if (argv[2]?.startsWith("test -f")) {
          await Bun.sleep(60);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    };
    const r = await readBoxFile(driver, "vm", "/etc/qds-image.json", 5_000);
    expect(r).toEqual({ kind: "content", content: "{}" });
    expect(seen[0] as number).toBeGreaterThan(4_900); // the probe gets ~the whole budget
    // The PROPERTY, not an arithmetic edge. `<= 5_000 - 60` had zero slack
    // against `Bun.sleep(60)`: a timer firing one integer millisecond early
    // relative to the two `Date.now()` reads makes it exactly 4941 and fails a
    // test whose point is "the read gets the remainder".
    expect(seen[1] as number).toBeLessThan(seen[0] as number);
    expect(seen[1] as number).toBeGreaterThan(0);
  });

  test("no budget left at the read leg is NAMED, not blamed on the box", async () => {
    // `left()`'s 1 ms floor is a clamp, not a diagnosis. With the shared window
    // already gone the `cat` used to be issued anyway on a 1 ms budget,
    // SIGKILLed at the spawn, and rendered by `imageMarkerFailure` as "the box
    // never answered (exit 137 — SIGKILLed at the exec budget)" with the
    // remediation "confirm the box answers at all" — sending the operator at
    // the network for a budget the CALLER's own probe leg consumed.
    //
    // Driven with `deadlineMs: 0` because that is the deterministic spelling of
    // the state: `withTimeout` bounds the probe at `left()`, so a probe that
    // truly overran would reject rather than reach here, and the reachable case
    // is a window that is already spent when the probe settles. Same fail-closed
    // disposition either way (probeArm counts a skip tick, setupGate refuses,
    // and `imageMarkerFailure` still says `image-marker-unreachable`); only the
    // sentence gets honest. `exitCode: -1` because no process ever ran.
    const seen: string[] = [];
    const driver = {
      exec: async (): Promise<ExecResult> => {
        throw new Error("readBoxFile took the untimed exec path while execTimed was available");
      },
      execTimed: async (_vm: string, argv: string[]): Promise<ExecResult> => {
        seen.push(argv[2] as string);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const r = await readBoxFile(driver, "vm", "/etc/qds-image.json", 0);
    expect(r).toEqual({
      kind: "unreadable",
      exitCode: -1,
      stderr: "read budget exhausted by the presence probe (0 ms shared by both legs)",
    });
    // The `cat` was never issued — the whole point of naming the case.
    expect(seen).toEqual(["test -f '/etc/qds-image.json'"]);
  });

  test("a FAILED cat whose stderr breached the cap is unreadable, not permanently oversized", async () => {
    // `ExecResult.truncated` is `out.truncated || err.truncated` (sshCommand),
    // so a `cat` that fails while spewing >512 KiB to STDERR carries the flag
    // without the marker being oversized at all. Classified `oversized` it was
    // PERMANENT: `fanout-primitive.ts:817` maps that to "unusable", which
    // counts toward MARKER_UNUSABLE_TICKS_LIMIT and gives the arm up as
    // corrupt, where `unreadable` retries — and `{kind:"oversized"}` carries no
    // exitCode or stderr, so the operator gets nothing to diagnose with. A
    // non-empty stdout is the one available signal that the READ hit the cap.
    const r = await readBoxFile(
      driverOf({ stdout: "", stderr: "cat: huge diagnostic…", exitCode: 1, truncated: true }),
      "vm",
      "/etc/qds-image.json",
      5_000,
    );
    expect(r).toEqual({ kind: "unreadable", exitCode: 1, stderr: "cat: huge diagnostic…" });
  });
});
