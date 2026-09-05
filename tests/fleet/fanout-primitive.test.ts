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
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TimeoutError } from "../../src/providers/timeout.ts";
import type { ExecResult } from "../../src/providers/driver.ts";
import { type BoxFileRead, DEFAULT_EXEC_TIMEOUT_MS } from "../../src/providers/exedev/transport.ts";
import { BOX_RUN_ROOT } from "../../src/providers/harvest.ts";
import {
  BOX_MARKER_PATH,
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
    // 0 is here too, and it is the CONTRADICTORY reading: `readBoxFile` only
    // reports absence on a NON-zero probe, so `{kind:"absent", probeExit:0}`
    // can only come from some other producer. It stays `skip` (a contradiction
    // is no evidence) and the message no longer says "not `test -f`'s clean
    // miss (exit 1)" about an exit that succeeded, which read as nonsense.
    for (const probeExit of [255, 137, 2, 0]) {
      const v = classifyMarkerRead({ kind: "absent", probeExit, probeStderr: "ssh: connect failed" });
      expect(v.kind).toBe("skip");
      // NEUTRAL, not `race-…`. `fleet status` shares this classifier, and a
      // status row on a plain single run emitting `race-probe-failed` sends an
      // operator hunting a fan-out that does not exist. The poller translates
      // back to its own vocabulary at `probeArm` (`raceCode`), which is what
      // `tests/fleet/patterns.test.ts` still pins.
      expect(v).toMatchObject({ code: "marker-probe-failed" });
      expect((v as { code: string }).code).not.toStartWith("race-");
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
    // BOTH halves of the forgery claim. The newline is what splits one log line
    // into two; the ESC is what repaints the ones around it, and a test that
    // pinned only the newline left the second half unasserted.
    expect(message).not.toContain("\u001b");
    expect(message).toContain('"boom\\nFLEET teardown ok');
  });

  test("unreadable and oversized are BOTH `unusable` — present, and unjudgeable", () => {
    expect(classifyMarkerRead({ kind: "unreadable", exitCode: 1, stderr: "EACCES" })).toMatchObject({
      kind: "unusable",
      code: "marker-read-failed",
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

  test("every BoxFileRead kind is classified — and each to the EXACT verdict, not just to one of four", () => {
    // This used to assert membership in the whole `MarkerVerdict` union, which
    // only a THROW could fail: swap `absent`→`settled` and it stayed green.
    // Each kind is pinned to its own verdict instead.
    const reads: [BoxFileRead, ReturnType<typeof classifyMarkerRead>["kind"]][] = [
      [{ kind: "absent" }, "absent"],
      [{ kind: "unreadable", exitCode: 1, stderr: "" }, "unusable"],
      [{ kind: "oversized" }, "unusable"],
      [{ kind: "content", content: '{"ok":true}' }, "settled"],
    ];
    for (const [r, kind] of reads) expect(classifyMarkerRead(r).kind).toBe(kind);
  });

  test("a BoxFileRead kind this build does not know is `skip`, never parsed as content", () => {
    // The three `if`s used to be the only tests and everything else FELL
    // THROUGH to `JSON.parse(res.content)`. The day `BoxFileRead` grows a fifth
    // arm, that is `JSON.parse(undefined)` — a TypeError reported as marker
    // CORRUPTION and counted against the give-up streak, so a transport change
    // would have looked like a corrupt marker on every box at once.
    const fifth = { kind: "quarantined", reason: "policy" } as unknown as BoxFileRead;
    expect(classifyMarkerRead(fifth)).toMatchObject({ kind: "skip", code: "marker-read-unclassified" });
  });

  test("a marker naming ANOTHER run never settles this one — two records can address one box", () => {
    // `joinedBox` falls back to matching on the run id (the INV-1 crash
    // window) and `reportDuplicateBoxNames` exists because duplicate box names
    // happen, so an open record whose id collides with a live box owned by a
    // DIFFERENT record read that box's marker and reported `ok` for a run that
    // never started. The marker body carries `runId` (journal.ts's
    // `writeTerminalMarker`), so this is answerable rather than assumable.
    const body = JSON.stringify({ runId: "sbx-other", ok: true, completedAt: "2026-09-03T00:00:00.000Z" });
    expect(classifyMarkerRead({ kind: "content", content: body }, "sbx-mine")).toMatchObject({
      kind: "unusable",
      code: "marker-run-mismatch",
    });
    // …and the mismatch is checked BEFORE `ok` is read, so ok:false from
    // another run cannot decide this row either.
    const failed = JSON.stringify({ runId: "sbx-other", ok: false });
    expect(classifyMarkerRead({ kind: "content", content: failed }, "sbx-mine").kind).toBe("unusable");
    // The MATCH settles normally.
    expect(classifyMarkerRead({ kind: "content", content: body }, "sbx-other")).toEqual({ kind: "settled", ok: true });
    // A marker with NO runId makes no ownership claim, so it is not a
    // mismatch — refusing it would fail closed on a merely less informative
    // reading, and the race poller's own fixtures publish exactly that shape.
    expect(classifyMarkerRead({ kind: "content", content: '{"ok":true}' }, "sbx-mine")).toEqual({
      kind: "settled",
      ok: true,
    });
    // And with no expectation passed, nothing is checked at all.
    expect(classifyMarkerRead({ kind: "content", content: body })).toEqual({ kind: "settled", ok: true });
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
    expect(v).toMatchObject({ kind: "skip", code: "marker-probe-failed" });
  });

  test("a TimeoutError keeps its OWN code, so a hang is diagnosable from a failure", async () => {
    const v = await readMarkerVerdict(driverOf([new TimeoutError("race-probe", 10)]), "box", "/m", 1_000);
    expect(v).toMatchObject({ kind: "skip", code: "marker-probe-timeout" });
  });

  test("probe OK + a non-zero `cat` is `unusable` — present, and unreadable", async () => {
    // The half of the read path neither this file nor status.test.ts drove
    // through `readMarkerVerdict`: the box answers TWICE (the file is there,
    // the read fails), which is emphatically not "no evidence" and must count
    // as corruption rather than as an unanswered probe.
    const v = await readMarkerVerdict(
      driverOf([ok(""), { stdout: "", stderr: "cat: Permission denied", exitCode: 1 }]),
      "box",
      "/m",
      1_000,
    );
    expect(v).toMatchObject({ kind: "unusable", code: "marker-read-failed" });
    expect((v as { error: Error }).error.message).toContain("Permission denied");
  });

  test("`readBoxFile`'s budget-exhausted reading is `unusable`, and its -1 is never read as a box status", () => {
    // The arm where the PROBE answered but spent the whole window, so the `cat`
    // was never issued: `{kind:"unreadable", exitCode:-1}` because no process
    // ever ran. It exists so the operator is not told to check the network for
    // a fault the CALLER's budget caused, and the classification has to keep
    // that honest — `unusable` (present and unjudgeable), never `skip`, and its
    // sentinel exit must not be mistaken for something a box reported.
    //
    // Driven through `classifyMarkerRead` rather than `readMarkerVerdict`,
    // deliberately: reaching it live needs the probe to resolve at exactly the
    // deadline, which races `withTimeout` and would be a flaky test of another
    // module's timing. What THIS module owes is the reading's meaning.
    const v = classifyMarkerRead({
      kind: "unreadable",
      exitCode: -1,
      stderr: "read budget exhausted by the presence probe (20 ms shared by both legs)",
    });
    expect(v).toMatchObject({ kind: "unusable", code: "marker-read-failed" });
    expect((v as { error: Error }).error.message).toContain("budget exhausted");
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
    // The probe BURNS ~60 ms before it answers. Without that the two legs run
    // microseconds apart and `calls[1] <= calls[0]` is clock monotonicity, not
    // a budget check: the pre-fix shape (each leg handed the full deadline)
    // yields [250, 250] and passes it. A leg that costs real time makes the
    // two numbers differ by the time it cost, which only ONE absolute budget
    // can produce.
    const slowProbe = {
      exec: (): Promise<ExecResult> => {
        throw new Error("exec must not be reached while execTimed is present");
      },
      execTimed: async (_vm: string, _argv: string[], timeoutMs: number): Promise<ExecResult> => {
        calls.push(timeoutMs);
        if (calls.length === 1) await new Promise((r) => setTimeout(r, 60));
        return calls.length === 1 ? ok("") : ok('{"ok":true}');
      },
    };
    await readMarkerVerdict(slowProbe, "box", "/m", 250);
    expect(calls.length).toBe(2);
    for (const ms of calls) {
      expect(ms).toBeLessThanOrEqual(250);
      expect(ms).not.toBe(DEFAULT_EXEC_TIMEOUT_MS);
    }
    // ONE ABSOLUTE budget for the PAIR, not one each: `readBoxFile` takes the
    // deadline once at entry and hands each leg what is LEFT of it, so a probe
    // that spent 60 ms leaves the `cat` strictly less — which is how a hung box
    // costs the caller the number it actually said instead of twice it.
    expect(calls[1] as number).toBeLessThan((calls[0] as number) - 40);
  });
});

describe("the surface `fleet status` and the race poller SHARE (AC5)", () => {
  test("the marker path is the BOX's, never derived from the host's QDS_RUN_ROOT", () => {
    // `runMarkerPath()` reads `QDS_RUN_ROOT` off the HOST — a test seam for
    // exercising `finish()` where `/run` is root-owned or absent (journal.ts) —
    // and both box-directed readers used to build their `test -f` path with it.
    // An operator, a test runner or a shell profile exporting the variable
    // therefore aimed every probe at a path the box does not have: `test -f`
    // missed cleanly, the verdict was `absent`, and every live row reported the
    // run as progressing regardless of what it had actually done.
    expect(BOX_MARKER_PATH).toBe("/run/journal/final.json");
    expect(BOX_MARKER_PATH).toBe(join(BOX_RUN_ROOT, "journal", "final.json"));
    // A LITERAL, so no host environment can move it.
    const prev = process.env.QDS_RUN_ROOT;
    process.env.QDS_RUN_ROOT = "/tmp/somewhere-else";
    try {
      expect(BOX_MARKER_PATH).toBe("/run/journal/final.json");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "QDS_RUN_ROOT");
      else process.env.QDS_RUN_ROOT = prev;
    }
  });

  test("`fleet status` reads through THIS module — not a re-forked private copy", () => {
    // The file header claims a surface both callers share, and every test above
    // exercises it directly, so a `status.ts` that grew its own `readBoxFile`
    // wrapper would leave this whole suite green while the two verbs drifted
    // apart on what a marker means. The import is the shared-ness.
    // Round 3 (B2-2): the pin used to be three loose substring checks, so a
    // `status.ts` that kept the words in a COMMENT (or imported the module
    // without either symbol) passed. The IMPORT STATEMENT is now parsed and
    // both symbols must ride IN it.
    const status = readFileSync(join(import.meta.dir, "../../src/fleet/status.ts"), "utf8");
    const importLine = /import\s*\{[^}]*\}\s*from\s*"\.\/fanout-primitive\.ts";/.exec(status)?.[0] ?? "";
    expect(importLine).not.toBe("");
    expect(importLine).toContain("readMarkerVerdict");
    expect(importLine).toContain("BOX_MARKER_PATH");
    // …and NOT through the host-derived path this module exists to replace.
    // The IMPORT, not the word: the import comment above it explains at length
    // why `runMarkerPath` is the wrong function here, and a mention is what
    // keeps the next reader from re-adding it. Namespace and dynamic imports
    // sidestep a named-import regex, so both shapes are refused too.
    expect(status).not.toMatch(/import\s*\{[^}]*runMarkerPath/);
    expect(status).not.toMatch(/import\s*\*\s*as\s+\w+\s*from\s*"\.\/fanout-primitive\.ts"/);
    expect(status).not.toMatch(/import\(\s*"\.\/fanout-primitive\.ts"\s*\)/);
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
    // `> 0` alone admits 1e6, which at the poller's 5 s interval is a ceiling
    // no run reaches — the arm would spin to the fan-out's own 1 h ceiling with
    // the fleet lock held, which is the exact failure the streak limit exists
    // to bound. A small SMALL upper bound is the half that was missing; the
    // number itself stays free to move inside it.
    expect(MARKER_UNUSABLE_TICKS_LIMIT).toBeGreaterThan(0);
    expect(MARKER_UNUSABLE_TICKS_LIMIT).toBeLessThanOrEqual(10);
  });
});
