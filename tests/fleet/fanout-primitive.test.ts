/**
 * DF1.10 AC5 — the completion-marker read extracted out of `probeArm` so that
 * `fleet status` reuses the fan-out poller's classification VERBATIM rather
 * than growing a second copy of it.
 *
 * The race poller's own behaviour is covered by `fanout.test.ts` and is
 * unchanged by that extraction; what is pinned HERE is the shared surface both
 * callers now depend on — the four verdicts, their exact diagnostic codes, the
 * fail-closed catch, and the tick ceiling.
 */
import { describe, expect, test } from "bun:test";

import { TimeoutError } from "../../src/providers/timeout.ts";
import type { ExecResult } from "../../src/providers/driver.ts";
import { type BoxFileRead, DEFAULT_EXEC_TIMEOUT_MS } from "../../src/providers/exedev/transport.ts";
import {
  classifyMarkerRead,
  MARKER_UNUSABLE_TICKS_LIMIT,
  markerUnusableGivesUp,
  readMarkerVerdict,
} from "../../src/fleet/fanout-primitive.ts";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

/**
 * A driver whose `execTimed` answers the presence probe and the `cat` in turn.
 * `exec` THROWS: `readBoxFile` documents `execTimed` as preferred, and a test
 * seam that silently fell back to `exec` would be measuring the 120 s-default
 * channel while claiming to measure the deadlined one.
 */
function driverOf(legs: Array<ExecResult | Error>, calls: number[] = []) {
  let i = 0;
  return {
    exec: (): Promise<ExecResult> => {
      throw new Error("exec must not be reached while execTimed is present");
    },
    execTimed: async (_vm: string, _argv: string[], timeoutMs: number): Promise<ExecResult> => {
      calls.push(timeoutMs);
      const leg = legs[Math.min(i++, legs.length - 1)] as ExecResult | Error;
      if (leg instanceof Error) throw leg;
      return leg;
    },
  };
}

describe("classifyMarkerRead — the four BoxFileRead verdicts (AC5)", () => {
  test("absent with a CLEAN probe exit is `absent`, the reading that resets a corruption streak", () => {
    expect(classifyMarkerRead({ kind: "absent", probeExit: 1 })).toEqual({ kind: "absent" });
    // Absence is still absence without the exit — BoxFileRead types it optional.
    expect(classifyMarkerRead({ kind: "absent" })).toEqual({ kind: "absent" });
  });

  test("absent with a NON-clean probe exit is `skip`: absence is unproven, not proven", () => {
    // 255 (ssh never connected) and 137 (SIGKILLed at the budget) are the box
    // not answering, not `test -f`'s clean miss. Counting them as absence reset
    // the arm's corruption streak on every tick — the bug the exit carries.
    for (const probeExit of [255, 137, 2]) {
      const v = classifyMarkerRead({ kind: "absent", probeExit, probeStderr: "ssh: connect failed" });
      expect(v.kind).toBe("skip");
      expect(v).toMatchObject({ code: "race-probe-failed" });
    }
  });

  test("a box-controlled stderr tail is JSON-quoted, never interpolated raw", () => {
    // It is box-controlled and these notes are LOGGED: a newline or an ANSI
    // escape in one forges log lines from a box that has just stopped answering.
    const v = classifyMarkerRead({
      kind: "absent",
      probeExit: 255,
      probeStderr: "boom\nFLEET teardown ok[0m",
    });
    const message = ((v as { error: Error }).error).message;
    expect(message).not.toContain("\n");
    expect(message).toContain('"boom\\nFLEET teardown ok');
  });

  test("unreadable and oversized are BOTH `unusable` — present, and unjudgeable", () => {
    expect(classifyMarkerRead({ kind: "unreadable", exitCode: 1, stderr: "EACCES" })).toMatchObject({
      kind: "unusable",
      code: "race-read-failed",
    });
    expect(classifyMarkerRead({ kind: "oversized" })).toMatchObject({
      kind: "unusable",
      code: "marker-oversized",
    });
  });

  test("content parses to the marker's own `{ok: boolean}`", () => {
    expect(classifyMarkerRead({ kind: "content", content: '{"ok":true}' })).toEqual({ kind: "settled", ok: true });
    expect(classifyMarkerRead({ kind: "content", content: '{"ok":false}' })).toEqual({ kind: "settled", ok: false });
  });

  test("content that is NOT a `{ok: boolean}` marker is `unusable`, never a settled verdict", () => {
    // journal.ts publishes by temp+rename, so a persistent parse failure is
    // corruption. Both arms count as corruption rather than decide anything.
    for (const content of ["", "not json", "{}", '{"ok":"true"}', '{"ok":null}', '{"ok":1}']) {
      expect(classifyMarkerRead({ kind: "content", content })).toMatchObject({
        kind: "unusable",
        code: "marker-unreadable",
      });
    }
  });

  test("every BoxFileRead kind is classified — no reading falls through unhandled", () => {
    const reads: BoxFileRead[] = [
      { kind: "absent" },
      { kind: "unreadable", exitCode: 1, stderr: "" },
      { kind: "oversized" },
      { kind: "content", content: '{"ok":true}' },
    ];
    for (const r of reads) expect(["absent", "skip", "unusable", "settled"]).toContain(classifyMarkerRead(r).kind);
  });
});

describe("readMarkerVerdict — the fail-closed read (AC5)", () => {
  test("a clean presence miss reads `absent` off the real readBoxFile probe", async () => {
    const v = await readMarkerVerdict(driverOf([{ stdout: "", stderr: "", exitCode: 1 }]), "box", "/run/journal/final.json", 1_000);
    expect(v).toEqual({ kind: "absent" });
  });

  test("probe hit + cat content settles the verdict", async () => {
    const v = await readMarkerVerdict(driverOf([ok(""), ok('{"ok":true}')]), "box", "/run/journal/final.json", 1_000);
    expect(v).toEqual({ kind: "settled", ok: true });
  });

  test("a THROWING transport is `skip` — no reading, so no evidence either way", async () => {
    const v = await readMarkerVerdict(driverOf([new Error("ssh died")]), "box", "/m", 1_000);
    expect(v).toMatchObject({ kind: "skip", code: "race-probe-failed" });
  });

  test("a TimeoutError keeps its OWN code, so a hang is diagnosable from a failure", async () => {
    const v = await readMarkerVerdict(driverOf([new TimeoutError("race-probe", 10)]), "box", "/m", 1_000);
    expect(v).toMatchObject({ kind: "skip", code: "race-probe-timeout" });
  });

  test("readMarkerVerdict NEVER rejects — every caller's await is self-guarding", async () => {
    // probeArm's loop and status's row sweep both drop their own try/catch on
    // this promise. A rejection here wedges the race or takes the status verb
    // down, so it is a property of the function, not of its callers.
    const hostile = {
      exec: (): Promise<ExecResult> => {
        throw new Error("no");
      },
      execTimed: (): Promise<ExecResult> => Promise.reject(null),
    };
    await expect(readMarkerVerdict(hostile, "box", "/m", 50)).resolves.toMatchObject({ kind: "skip" });
  });

  test("the caller's deadline reaches the SPAWN and is never the 120 s exec default", async () => {
    // The whole point of `execTimed`: `exec` hard-codes DEFAULT_EXEC_TIMEOUT_MS,
    // so a bound around it only abandons the ssh while the process runs on.
    const calls: number[] = [];
    await readMarkerVerdict(driverOf([ok(""), ok('{"ok":true}')], calls), "box", "/m", 250);
    expect(calls.length).toBe(2);
    for (const ms of calls) {
      expect(ms).toBeLessThanOrEqual(250);
      expect(ms).not.toBe(DEFAULT_EXEC_TIMEOUT_MS);
    }
    // ONE ABSOLUTE budget for the PAIR, not one each: `readBoxFile` takes the
    // deadline once at entry and hands each leg what is LEFT of it, so the
    // second leg's budget can never exceed the first's — which is how a hung
    // box costs the caller the number it actually said instead of twice it.
    expect(calls[1] as number).toBeLessThanOrEqual(calls[0] as number);
  });
});

describe("markerUnusableGivesUp — the shared tick ceiling (AC5)", () => {
  test("gives up at exactly MARKER_UNUSABLE_TICKS_LIMIT, not before", () => {
    for (let ticks = 0; ticks < MARKER_UNUSABLE_TICKS_LIMIT; ticks++) {
      expect(markerUnusableGivesUp(ticks)).toBeFalse();
    }
    expect(markerUnusableGivesUp(MARKER_UNUSABLE_TICKS_LIMIT)).toBeTrue();
    expect(markerUnusableGivesUp(MARKER_UNUSABLE_TICKS_LIMIT + 1)).toBeTrue();
  });

  test("the limit is a real bound, not a formality", () => {
    expect(MARKER_UNUSABLE_TICKS_LIMIT).toBeGreaterThan(0);
  });
});
