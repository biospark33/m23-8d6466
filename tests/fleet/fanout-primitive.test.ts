/**
 * DF1.10 AC5 — the completion-marker read extracted out of `probeArm` so that
 * `fleet status` reuses the fan-out poller's classification VERBATIM rather
 * than growing a second copy of it.
 *
 * The race poller's own behaviour is covered by `fanout.test.ts` and is
 * unchanged by that extraction; what is pinned HERE is the shared surface both
 * callers now depend on — the four verdicts, their exact diagnostic codes, the
 * fail-closed catch, and the tick ceiling.
 *
 * Review round 5 (fx-i) added the sections at the bottom: the `expectedRunId`
 * ownership wiring and the claim-failed streak resets are fanout-primitive.ts's
 * OWN contract (runRace/probeArm live here), so they are pinned here through a
 * trimmed local fake even though the pattern-level suite stays patterns.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { VIZ_PIDFILE, type ExecResult } from "../../src/providers/driver.ts";
import { type BoxFileRead, DEFAULT_EXEC_TIMEOUT_MS, shellQuote } from "../../src/providers/exedev/transport.ts";
import { BOX_RUN_ROOT } from "../../src/providers/harvest.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { TimeoutError } from "../../src/providers/timeout.ts";
import { DEFAULT_QUOTA_LIMITS } from "../../src/providers/quota.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { goodLedger } from "./helpers.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import type { Brief } from "../../src/fleet/brief-schema.ts";
import {
  BOX_MARKER_PATH_RE,
  boxMarkerPath,
  classifyMarkerRead,
  fanout,
  MARKER_UNUSABLE_TICKS_LIMIT,
  markerUnusableGivesUp,
  PROBE_SKIP_TICKS_LIMIT,
  readMarkerVerdict,
  type FanoutDeps,
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

  test("content that parses to null or a PRIMITIVE is `unusable` — the guard branch, not a crash", () => {
    // `JSON.parse` succeeds on "null"/"42"/'"x"'/"true", so the `as` cast on
    // its result is not a check: without the object guard, `marker.runId` on a
    // null dereferenced to a TypeError — which readMarkerVerdict's fail-closed
    // catch then reported as `skip` ("the box never answered") for a marker
    // that IS present and IS corrupt. The guard classifies it as what it is.
    for (const content of ["null", "42", '"a string"', "true"]) {
      expect(classifyMarkerRead({ kind: "content", content })).toMatchObject({
        kind: "unusable",
        code: "marker-unreadable",
      });
    }
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
    // A PRESENT-but-non-string runId is corruption, never "makes no claim":
    // the one legit writer always emits a string, so `{"runId":42,"ok":true}`
    // on another run's box must not settle this one through a type coercion.
    expect(
      classifyMarkerRead({ kind: "content", content: '{"runId":42,"ok":true}' }, "sbx-mine"),
    ).toMatchObject({ kind: "unusable", code: "marker-run-id-invalid" });
    // E3 (round 3): that non-string-runId arm is UNCONDITIONAL — it no longer
    // lives inside the `expectedRunId !== undefined` gate, so `fleet status`
    // (the caller that passes NO expectation) gets the same refusal. Before
    // the move, a present-but-corrupt marker settled cleanly for exactly the
    // caller that had no ownership opinion to check it against.
    expect(classifyMarkerRead({ kind: "content", content: '{"runId":42,"ok":true}' })).toMatchObject({
      kind: "unusable",
      code: "marker-run-id-invalid",
    });
    expect(classifyMarkerRead({ kind: "content", content: '{"runId":null,"ok":true}' }, "sbx-mine").kind).toBe(
      "unusable",
    );
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
    expect(v).toMatchObject({ kind: "unusable", code: "marker-read-budget-exhausted" });
    expect((v as { error: Error }).error.message).toContain("budget exhausted");
    // No `cat` ran, so the message must not assert one — "cat exited -1"
    // blames a process that never existed for the caller's own deadline.
    expect((v as { error: Error }).error.message).not.toContain("cat exited");
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
    // yields two EQUAL numbers and passes it. A leg that costs real time makes the
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
    await readMarkerVerdict(slowProbe, "box", "/m", 1_000);
    expect(calls.length).toBe(2);
    for (const ms of calls) {
      expect(ms).toBeLessThanOrEqual(1_000);
      expect(ms).not.toBe(DEFAULT_EXEC_TIMEOUT_MS);
    }
    // ONE ABSOLUTE budget for the PAIR, not one each: `readBoxFile` takes the
    // deadline once at entry and hands each leg what is LEFT of it. The first
    // leg's number is the caller's deadline — a 1_000 ms budget — asserted as
    // a RANGE around the caller's number rather than an equality that a
    // boundary-straddling read can break. F14 (round 3): the floor used to sit
    // 10 ms under the ceiling, a window a loaded runner can burn on scheduler
    // stall before `readBoxFile` even reads the clock; 100 ms of slack keeps
    // the discrimination (the 120 s exec default fails it by 100×) while
    // dropping the false-red. The second must be STRICTLY smaller: the
    // pre-fix shape (each leg handed the full deadline) yields [1_000, 1_000]
    // and fails. The 60 ms sleep above is not measured — it exists so a
    // CORRECT implementation's two numbers are guaranteed to differ by more
    // than the clock's granularity, keeping strictness meaningful without
    // betting the test on how much time a loaded runner actually let pass.
    expect(calls[0] as number).toBeLessThanOrEqual(1_000);
    expect(calls[0] as number).toBeGreaterThan(900);
    expect(calls[1] as number).toBeLessThan(calls[0] as number);
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
    expect(boxMarkerPath("pin-run")).toBe("/run/qds-run/pin-run/journal/final.json");
    expect(boxMarkerPath("pin-run")).toBe(join(BOX_RUN_ROOT, "qds-run", "pin-run", "journal", "final.json"));
    expect(BOX_MARKER_PATH_RE.test(boxMarkerPath("pin-run"))).toBe(true);
    // A LITERAL, so no host environment can move it.
    const prev = process.env.QDS_RUN_ROOT;
    process.env.QDS_RUN_ROOT = "/tmp/somewhere-else";
    try {
      expect(boxMarkerPath("pin-run")).toBe("/run/qds-run/pin-run/journal/final.json");
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
    // F11: the pin is about WHICH symbols the import carries, not about the
    // repo's quote style or the trailing semicolon — both are cosmetic, and a
    // style-only edit must not green this pin into "the import vanished".
    const importLine = /import\s*\{[^}]*\}\s*from\s*["']\.\/fanout-primitive\.ts["']\s*;?/.exec(status)?.[0] ?? "";
    expect(importLine).not.toBe("");
    expect(importLine).toContain("readMarkerVerdict");
    expect(importLine).toContain("boxMarkerPath");
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

  test("the streak-reset fixtures below are scaled from THESE exact values", () => {
    // F7: the reset tests' tick sequences are computed FROM the two constants,
    // so a moved constant changes what those fixtures prove without changing
    // their code. Pinned here so the move is a conscious act: update this pin,
    // then re-read the derivations (they need no further edit — that is the
    // point of computing them).
    expect(MARKER_UNUSABLE_TICKS_LIMIT).toBe(3);
    expect(PROBE_SKIP_TICKS_LIMIT).toBe(6);
  });
});

describe("expectedRunId — the ownership wiring both callers consume", () => {
  test("readMarkerVerdict THREADS expectedRunId: a marker claiming a FOREIGN run is refused, never settled", async () => {
    // The pure-classifier arm is pinned above; what was missing is the WIRING —
    // probeArm and `fleet status` each hand a run id to this 5th parameter, and
    // a dropped/renamed parameter here would make every fixture's claim-bearing
    // marker sail through unchecked. Driven through the driver seam (probe +
    // cat legs), the way both callers reach it.
    const foreign = JSON.stringify({ runId: "sbx-foreign", ok: true });
    const v = await readMarkerVerdict(driverOf([ok(""), ok(foreign)]), "box", "/run/journal/final.json", 1_000, "sbx-mine");
    expect(v).toMatchObject({ kind: "unusable", code: "marker-run-mismatch" });
  });

  test("a marker claiming THIS run settles through the same wiring — the claim-bearing path proceeds", async () => {
    const mine = JSON.stringify({ runId: "sbx-mine", ok: true });
    const v = await readMarkerVerdict(driverOf([ok(""), ok(mine)]), "box", "/run/journal/final.json", 1_000, "sbx-mine");
    expect(v).toEqual({ kind: "settled", ok: true });
  });
});

// ─── review round 5 (fx-i): the streak and ownership contracts runRace owns ────
//
// The fixtures below are a TRIMMED local copy of patterns.test.ts's race
// harness (C3 keeps fakes file-local): dispatch, the fan-out record and the
// poller all run for real against FakeDriver boxes, with the presence probe
// intercepted so tests key marker plants and record corruption to TICK
// numbers. Trimmed is everything only the pattern-level suite asserts —
// roster pinning, teardown step order, cost-ledger wiring, hung probes.

/** Injected poll timings: no test sleeps a production interval. */
const TICK_MS = 10;
const DEADLINE_MS = 200;

const RACE_MANIFEST_REL = join("manifests", "pipeline.json");

/**
 * FakeDriver whose box directory IS the box's root filesystem, so the in-box
 * marker (`/run/journal/final.json` in a real box) maps onto
 * `<box>/journal/final.json`. `probeExit` forces the presence probe's own
 * exit, producing the `test -f`-never-answered shape (ssh 255) a skip tick
 * needs. Also guards the SHARED HOST viz pidfile (teardown's stopVisualizer
 * step would otherwise kill whatever `/tmp/qds-viz.pid` names).
 */
class StreakFakeDriver extends FakeDriver {
  onProbe?: (vm: string, probeNumber: number) => void;
  probeExit?: (vm: string, probeNumber: number) => number | undefined;
  /**
   * When it returns a number for a vm, that vm's marker `cat` leg exits with
   * it — the present-but-unreadable shape (`test -f` clean, `cat` failed) that
   * `readBoxFile` reports as `unreadable` and the classifier as
   * `marker-read-failed`. Forcing it through the seam keeps the E4 pin off the
   * permission/root games a chmod-000 fixture would need.
   */
  catExit?: (vm: string) => number | undefined;
  #probes = 0;

  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin, undefined);
  }

  // BOTH channels, like patterns.test.ts's double: `readBoxFile` prefers
  // `execTimed`, so an `exec`-only override is never consulted at all.
  override async execTimed(vm: string, argv: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin, timeoutMs);
  }

  private async intercept(
    vm: string,
    argv: string[],
    stdin: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<ExecResult> {
    if (argv.some((a) => typeof a === "string" && a.includes(VIZ_PIDFILE))) {
      return { stdout: "NONE\n", stderr: "", exitCode: 0 };
    }
    if (this.isMarkerProbe(argv)) {
      const cmd = String(argv[2]);
      if (cmd.includes("cat ")) {
        const forcedCat = this.catExit?.(vm);
        if (forcedCat !== undefined) {
          return { stdout: "", stderr: `cat: forced failure by the test seam (exit ${String(forcedCat)})`, exitCode: forcedCat };
        }
        // The read is answered in-memory: the bytes are the file the test
        // planted, and only the PRESENCE probe counts (tests key plants to
        // tick numbers — counting the cat too shifts every dance by one).
        try {
          return { stdout: readFileSync(this.boxMarker(vm), "utf8"), stderr: "", exitCode: 0 };
        } catch {
          return { stdout: "", stderr: "cat: marker vanished between test and read", exitCode: 1 };
        }
      }
      this.#probes += 1;
      this.onProbe?.(vm, this.#probes);
      const forced = this.probeExit?.(vm, this.#probes);
      if (forced !== undefined) {
        return { stdout: "", stderr: `ssh: connect to host ${vm} port 22: Connection refused`, exitCode: forced };
      }
      return this.base(vm, ["sh", "-c", `test -f ${shellQuote(this.boxMarker(vm))}`], stdin, timeoutMs);
    }
    return this.base(vm, argv, stdin, timeoutMs);
  }

  /** The pass-through on whichever channel the caller used — deadline honoured. */
  private base(vm: string, argv: string[], stdin: string | undefined, timeoutMs: number | undefined): Promise<ExecResult> {
    return timeoutMs === undefined ? super.exec(vm, argv, stdin) : super.execTimed(vm, argv, timeoutMs, stdin);
  }

  override async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    // The box literal, never a host-derived path (see BOX_MARKER_PATH).
    if (BOX_MARKER_PATH_RE.test(remotePath) && remotePath.endsWith("/journal/final.json")) return super.copyFile(vm, this.boxMarker(vm), localPath);
    return super.copyFile(vm, remotePath, localPath);
  }

  private isMarkerProbe(argv: string[]): boolean {
    return (
      argv.length >= 3 &&
      argv[0] === "sh" &&
      argv[1] === "-c" &&
      typeof argv[2] === "string" &&
      BOX_MARKER_PATH_RE.test(argv[2])
    );
  }

  private boxMarker(vm: string): string {
    return join(this.root, vm, "journal", "final.json");
  }
}

/** Plants (or overwrites) a box's completion marker. A string body = raw bytes. */
function plantMarker(driver: StreakFakeDriver, vm: string, body: unknown): void {
  const p = join(driver.root, vm, "journal", "final.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof body === "string" ? body : `${JSON.stringify(body)}\n`);
}

/** Removes a box's marker — the next tick's `test -f` misses CLEANLY (absent). */
function clearMarker(driver: StreakFakeDriver, vm: string): void {
  rmSync(join(driver.root, vm, "journal", "final.json"), { force: true });
}

function boxExists(driver: StreakFakeDriver, vm: string | undefined): boolean {
  return vm !== undefined && existsSync(join(driver.root, vm));
}

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

describe("runRace — claim-failed streak resets and race-level ownership", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: StreakFakeDriver;
  let fanoutsDir: string;
  let entries: LogEntry[];
  let restoreLog: (() => void) | undefined;
  const probes = new Map<string, number>();

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "df1110-fx-i-")));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new StreakFakeDriver(join(dir, "boxes"));
    fanoutsDir = join(dir, "fanouts");
    entries = [];
    probes.clear();
    restoreLog = setLogSink((e) => entries.push(e));
  });

  afterEach(() => {
    restoreLog?.();
    rmSync(dir, { recursive: true, force: true });
  });

  function manifest(): void {
    const p = join(dir, RACE_MANIFEST_REL);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        phases: [
          { name: "plan", kind: "code", description: "Draft the approach", command: ["bun", "run", "plan"], maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Run the suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
        ],
      }),
    );
  }

  function brief(): Brief {
    return {
      repoSlug: "owner/repo",
      issueId: 42,
      commitSha: "a".repeat(40),
      manifestPath: RACE_MANIFEST_REL,
      repoUrl: "https://github.com/owner/repo",
    };
  }

  function raceDeps(overrides: Partial<FanoutDeps> = {}): FanoutDeps {
    return {
      driver,
      keyApi: new FakeKeyApi(),
      store,
      ledgerFactory: () => goodLedger(),
      repoRoot: dir,
      requestId: randomUUID(), // dispatch validates: strict UUID v4
      quotaLimits: { limits: { ...DEFAULT_QUOTA_LIMITS }, source: "default" },
      fanoutsDir,
      lockPath: join(dir, "fleet.lock"),
      setupGate: async (_d, vm) => ({
        ready: true,
        assertions: [],
        debugCommands: [],
        teardownCommand: `td ${vm}`,
        vm,
      }),
      pollIntervalMs: TICK_MS,
      perCallDeadlineMs: DEADLINE_MS,
      ceilingMs: 10_000,
      ...overrides,
    };
  }

  /** Give-up events of one kind — `event`, not the per-tick `error.code` shape. */
  function giveUps(event: string): number {
    return entries.filter((e) => e.operation === "fleet.fanout.race" && e.event === event).length;
  }

  /** One vm's tick number, counted from its own probes (arms interleave globally). */
  function tickOf(vm: string): number {
    const n = (probes.get(vm) ?? 0) + 1;
    probes.set(vm, n);
    return n;
  }

  /**
   * Corrupt the fan-out record so probeArm's winner CLAIM throws from inside
   * `mutate`'s read-and-validate; returns the restore. This is the P19 fixture
   * shape: a stale record lock, an unvalidatable record, EIO on the records
   * dir — the host-side write failing while the marker says this arm won.
   */
  function corruptFanoutRecord(): () => void {
    const file = join(fanoutsDir, readdirSafe(fanoutsDir).find((f) => f.endsWith(".json")) as string);
    const saved = readFileSync(file, "utf8");
    writeFileSync(file, "{ not a record");
    return () => writeFileSync(file, saved);
  }

  /** The runId whose run record names this vm — dispatch stamps `vmName` (INV-5). */
  function runIdOf(vm: string): string | undefined {
    for (const f of readdirSafe(join(dir, "runs"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(dir, "runs", f), "utf8")) as { vmName?: unknown };
        if (rec.vmName === vm) return f.slice(0, -".json".length);
      } catch {
        // a record mid-rewrite is not this scan's business — next probe rescans
      }
    }
    return undefined;
  }

  /**
   * A FOREIGN holder's live-looking claim for `<store.dir>/<runId>.lock`: a
   * host this process cannot match, so `refuse` classifies it as held by a
   * holder of unknown liveness — never stale, never stealable — and the
   * acquire throws RunLockedError before anything is mutated.
   */
  function plantRunLock(runId: string): void {
    // `runs/undefined.lock` is the failure mode this guard exists for: the
    // probe hook reads `runIds.get(vm)`, which setupGate populates, and a
    // future reordering that fires a probe before its arm's setupGate would
    // otherwise plant a lock for the literal run id "undefined" — the real
    // arm then acquires uncontended and the refusal silently stops being
    // tested. Loud now, at the drift site.
    if (runId === undefined) {
      throw new Error("plantRunLock got an undefined runId — the probe fired before its arm's setupGate populated runIds (dispatch/setupGate must precede tick-1 probes)");
    }
    writeFileSync(
      join(dir, "runs", `${runId}.lock`),
      "123456 a-host-this-process-cannot-match 2026-01-01T00:00:00.000Z deadbeef\n",
    );
  }

  // ── the claim-failed streak contract (P19, round-5 restore) ──────────────────

  test("a claim-failure followed by a clean ABSENT read RESETS the claim-failed streak — interleaved failures never give up", async () => {
    // Odd ticks: winner marker lands, record corrupt → the claim fails. Even
    // ticks: marker ABSENT (a CLEAN miss — the usable read that resets
    // claimFailedTicks; the fixture drives absence, so the name says absence
    // rather than the looser "usable read"). The failures total the give-up
    // bound but never two in a row, so the arm survives.
    //
    // F7: the heal fires only on the probe AFTER the LIMIT-th failure, and the
    // tick math is computed from MARKER_UNUSABLE_TICKS_LIMIT. Delete the
    // `absent` branch's `claimFailedTicks.delete(arm)` and the failures
    // accumulate to the limit: the arm is abandoned on the limit-th failure,
    // the heal probe never runs, the race ceiling-expires with no winner — this
    // test FAILS instead of drifting green. A hardcoded heal tick (the old 7)
    // could not promise that: at a larger limit the deleted branch never filled
    // and the test passed either way.
    manifest();
    let stuck: string | undefined;
    let restore: (() => void) | undefined;
    let claimFails = 0;
    driver.onProbe = (vm) => {
      if (stuck === undefined) stuck = vm;
      if (vm !== stuck) return;
      const tick = tickOf(vm);
      if (claimFails >= MARKER_UNUSABLE_TICKS_LIMIT) {
        restore?.();
        plantMarker(driver, vm, { ok: true });
        return;
      }
      if (tick % 2 === 1) {
        plantMarker(driver, vm, { ok: true });
        claimFails += 1;
        restore ??= corruptFanoutRecord();
      } else {
        clearMarker(driver, vm);
      }
    };
    const res = await fanout("race", 2, brief(), raceDeps({ rosterIds: ["r0", "r1"] }));
    const arm = res.arms.findIndex((a) => a.vmName === stuck);
    expect(res.winner).toBe(arm);
    expect(res.arms.some((a) => a.outcome === "armUnknown")).toBe(false);
    expect(giveUps("race-claim-failed")).toBe(0);
    // It polled PAST the bound, not up to it — survival, not a lucky streak.
    expect(probes.get(stuck as string)).toBeGreaterThan(MARKER_UNUSABLE_TICKS_LIMIT);
  }, 20_000);

  test("claim-failures and unusable reads reset EACH OTHER — alternating ticks reach neither bound", async () => {
    // The restored line's own comment: the box ANSWERED (the marker read as a
    // winner), which is evidence against the other streaks. Without the
    // claim-failed branch clearing `unusableTicks`, the alternating unusable
    // ticks accumulate to MARKER_UNUSABLE_TICKS_LIMIT and abandon the arm on
    // tick 2·LIMIT; without the unusable branch clearing `claimFailedTicks`,
    // the alternating claim failures reach the same bound on tick 2·LIMIT−1.
    // Either regression loses the race this arm goes on to win.
    //
    // F7: the heal is parked at tick 2·LIMIT+1 — strictly AFTER both bounds
    // could have fired — and every tick number is computed from the constant.
    // The old hardcoded heal at tick 7 passed with either branch deleted
    // whenever the limit sat above the three alternations the fixture drove:
    // green under exactly the regression this test exists to catch.
    manifest();
    let stuck: string | undefined;
    let restore: (() => void) | undefined;
    const limit = MARKER_UNUSABLE_TICKS_LIMIT;
    driver.onProbe = (vm) => {
      if (stuck === undefined) stuck = vm;
      if (vm !== stuck) return;
      const tick = tickOf(vm);
      if (tick >= 2 * limit + 1) {
        restore?.();
        plantMarker(driver, vm, { ok: true });
        return;
      }
      if (tick % 2 === 1) {
        plantMarker(driver, vm, { ok: true });
        restore ??= corruptFanoutRecord();
      } else {
        plantMarker(driver, vm, "not json{"); // present, unparseable → unusable
      }
    };
    const res = await fanout("race", 2, brief(), raceDeps({ rosterIds: ["r0", "r1"] }));
    const arm = res.arms.findIndex((a) => a.vmName === stuck);
    expect(res.winner).toBe(arm);
    expect(res.arms.some((a) => a.outcome === "armUnknown")).toBe(false);
    expect(giveUps("race-claim-failed")).toBe(0);
    expect(giveUps("marker-unreadable")).toBe(0);
    expect(probes.get(stuck as string)).toBeGreaterThan(MARKER_UNUSABLE_TICKS_LIMIT);
  }, 20_000);

  test("a claim-failure clears the SKIP streak — a claim between unanswered probes keeps a demonstrably-up box alive", async () => {
    // A run of probe-no-answer ticks (ssh 255: the box never answered), one
    // claim failure (the marker read as a winner — the box demonstrably
    // answered), another run of unanswered ticks. The TOTAL crosses the
    // starvation bound but no CONSECUTIVE run reaches it, because the claim
    // tick resets the skip streak along with the corruption one. Without that
    // reset, the last skip of the second run starves with a corroborating
    // sibling answer on the same tick and abandons the arm as
    // `probe-unanswered` BEFORE the record is restored — this test fails
    // rather than drifting green.
    //
    // F7: each half-run is PROBE_SKIP_TICKS_LIMIT rounded up by half — every
    // half stays strictly under the bound while the total crosses it — and the
    // tick numbers are computed from the constant, so moving the constant
    // re-derives the fixture instead of silently vacating it.
    manifest();
    let stuck: string | undefined;
    let restore: (() => void) | undefined;
    const skipRun = PROBE_SKIP_TICKS_LIMIT - Math.floor(PROBE_SKIP_TICKS_LIMIT / 2);
    driver.onProbe = (vm) => {
      if (stuck === undefined) stuck = vm;
      if (vm !== stuck) return;
      const tick = tickOf(vm);
      if (tick === skipRun + 1) {
        plantMarker(driver, vm, { ok: true });
        restore ??= corruptFanoutRecord();
      }
      if (tick === 2 * skipRun + 2) restore?.();
    };
    // `onProbe` runs before `probeExit` on the same probe, so the map is
    // already at this probe's tick number when the exit is decided.
    driver.probeExit = (vm) => {
      if (vm !== stuck) return undefined;
      const tick = probes.get(vm) ?? 0;
      return (tick >= 1 && tick <= skipRun) || (tick >= skipRun + 2 && tick <= 2 * skipRun + 1) ? 255 : undefined;
    };
    const res = await fanout("race", 2, brief(), raceDeps({ rosterIds: ["r0", "r1"] }));
    const arm = res.arms.findIndex((a) => a.vmName === stuck);
    expect(res.winner).toBe(arm);
    expect(giveUps("probe-unanswered")).toBe(0);
    expect(giveUps("race-claim-failed")).toBe(0);
    expect(probes.get(stuck as string)).toBeGreaterThan(PROBE_SKIP_TICKS_LIMIT);
  }, 20_000);

  test("N CONSECUTIVE claim-failures still give up — race-claim-failed, armUnknown, polling stops at the bound", async () => {
    // The other half of the contract the resets belong to: non-consecutive
    // failures are survivable, CONSECUTIVE ones are structural (a record the
    // store rejects on every attempt) and abandon the arm at the corruption
    // bound instead of re-reading a settled winner to the ceiling with the
    // fleet lock held.
    manifest();
    let stuck: string | undefined;
    let restore: (() => void) | undefined;
    let healed = false;
    driver.onProbe = (vm) => {
      if (stuck === undefined) stuck = vm;
      if (vm === stuck) {
        if (tickOf(vm) !== 1) return;
        plantMarker(driver, vm, { ok: true });
        restore = corruptFanoutRecord(); // permanently unwritable
        return;
      }
      tickOf(vm);
      // Heal only once the give-up event has LANDED — an earlier repair would
      // rescue the arm mid-streak; after the give-up it is no longer polled,
      // so this cannot. The sibling then takes the win the record can accept.
      if (!healed && giveUps("race-claim-failed") > 0) {
        healed = true;
        restore?.();
        plantMarker(driver, vm, { ok: true });
      }
    };
    const res = await fanout("race", 2, brief(), raceDeps({ rosterIds: ["r0", "r1"] }));
    expect(probes.get(stuck as string)).toBe(MARKER_UNUSABLE_TICKS_LIMIT);
    const stuckArm = res.arms.findIndex((a) => a.vmName === stuck);
    expect(res.arms[stuckArm]?.outcome).toBe("armUnknown");
    expect(giveUps("race-claim-failed")).toBe(1);
    expect(res.winner).not.toBe(stuckArm);
    expect(boxExists(driver, stuck)).toBe(true); // unknown ≠ loser, never torn down
  }, 20_000);

  // ── the ownership wiring, end to end through the poller ──────────────────────

  test("an arm whose marker claims a FOREIGN run never wins — marker-run-mismatch give-up, sibling takes the race", async () => {
    // Every fixture in this file, patterns.test.ts and status.test.ts plants
    // claim-LESS markers, so probeArm's `expectedRunId` hop had no end-to-end
    // coverage. This arm's marker positively names someone else's run: the read
    // must refuse ownership (unusable, marker-run-mismatch), the give-up event
    // must carry that code VERBATIM, and the arm must never be the winner — a
    // dropped wiring would settle this marker ok:true and arm 0 wins its first
    // tick.
    manifest();
    let stuck: string | undefined;
    let healed = false;
    driver.onProbe = (vm) => {
      if (stuck === undefined) stuck = vm;
      if (vm === stuck) {
        if (tickOf(vm) === 1) plantMarker(driver, vm, { runId: "sbx-someone-elses-run", ok: true });
        return;
      }
      tickOf(vm);
      if (!healed && giveUps("marker-run-mismatch") > 0) {
        healed = true;
        plantMarker(driver, vm, { ok: true });
      }
    };
    const res = await fanout("race", 2, brief(), raceDeps({ rosterIds: ["r0", "r1"] }));
    expect(probes.get(stuck as string)).toBe(MARKER_UNUSABLE_TICKS_LIMIT);
    const stuckArm = res.arms.findIndex((a) => a.vmName === stuck);
    expect(res.arms[stuckArm]?.outcome).toBe("armUnknown");
    expect(giveUps("marker-run-mismatch")).toBe(1);
    expect(res.winner).not.toBe(stuckArm);
    expect(res.winner).not.toBeNull();
    expect(boxExists(driver, stuck)).toBe(true);
  }, 20_000);

  test("a present-but-unreadable marker gives up as race-read-failed — the RACE spelling, raw code kept in the detail", async () => {
    // E4 (round 3): the give-up that abandons an arm on a filled corruption
    // streak used to spell the fault `marker-read-failed` while every per-tick
    // line spelled the same fault `race-read-failed` — one evidence stream,
    // two greppable names, and the operator hunting the race vocabulary found
    // the tick lines but never the abandonment. The give-up event's CODE now
    // goes through `raceCode` like the tick lines; the raw neutral code
    // survives only in the detail. The unreadable shape is driven through the
    // `catExit` seam (probe clean, cat exit 1) so the pin needs no chmod/root
    // games; its sibling heals and takes the race.
    manifest();
    let stuck: string | undefined;
    let healed = false;
    driver.catExit = (vm) => (vm === stuck ? 1 : undefined);
    driver.onProbe = (vm) => {
      if (stuck === undefined) stuck = vm;
      if (vm === stuck) {
        if (tickOf(vm) === 1) plantMarker(driver, vm, { ok: true });
        return;
      }
      tickOf(vm);
      if (!healed && giveUps("race-read-failed") > 0) {
        healed = true;
        plantMarker(driver, vm, { ok: true });
      }
    };
    const res = await fanout("race", 2, brief(), raceDeps({ rosterIds: ["r0", "r1"] }));
    expect(probes.get(stuck as string)).toBe(MARKER_UNUSABLE_TICKS_LIMIT);
    const stuckArm = res.arms.findIndex((a) => a.vmName === stuck);
    expect(res.arms[stuckArm]?.outcome).toBe("armUnknown");
    expect(giveUps("race-read-failed")).toBe(1);
    // The raw neutral code is preserved in the detail for diagnosis — E4 moves
    // the greppable name, it does not destroy the classifier's own vocabulary.
    const giveUpLine = entries.find((e) => e.operation === "fleet.fanout.race" && e.event === "race-read-failed");
    expect(String(giveUpLine?.detail)).toContain("marker-read-failed");
    expect(res.winner).not.toBe(stuckArm);
    expect(res.winner).not.toBeNull();
    expect(boxExists(driver, stuck)).toBe(true); // unknown ≠ loser, never torn down
  }, 20_000);

  test("a marker claiming the arm's OWN minted runId settles and wins — the check admits the true owner", async () => {
    // The inverse arm, and the one that pins the id probeArm passes is the
    // arm's own minted runId (not a fanoutId, not an arm index): the marker
    // names the runId found on the run record that owns this vm, and only a
    // matching expectation can settle it.
    manifest();
    const claimed = new Map<string, string>(); // vm → runId its marker named
    driver.onProbe = (vm) => {
      tickOf(vm);
      if (claimed.has(vm)) return;
      const runId = runIdOf(vm);
      if (runId === undefined) return;
      claimed.set(vm, runId);
      plantMarker(driver, vm, { runId, ok: true });
    };
    const res = await fanout("race", 2, brief(), raceDeps({ rosterIds: ["r0", "r1"] }));
    expect(res.winner).not.toBeNull();
    const won = res.arms[res.winner as number];
    expect(won?.outcome).toBe("ready");
    // A racing arm is a minted one — its runId is never the pre-mint null.
    expect(won?.runId).not.toBeNull();
    // F13 dropped the dead `?? undefined`; the assertion is read in the
    // direction that type-checks without it — the record's stamped runId
    // equals the id the run record scan found for that vm.
    expect(won?.runId).toBe(claimed.get(won?.vmName as string));
  }, 20_000);

  // ── the per-loser run lock (DF2.5 disposal wiring) ───────────────────────────

  test("a loser whose run lock names a FOREIGN HOST (the refuse-as-unknown-liveness branch) is REFUSED — loser-teardown-refused names it, its box survives, the sibling still disposes", async () => {
    // The per-loser lock sits INSIDE the disposal loop's try: one contended
    // loser must refuse — typed, remediated, never silent — without aborting
    // the loop, the record close, or the fleet lock's destructive
    // bookkeeping. The lock must exist BEFORE the race ends (the poller stops
    // the other arms the moment a claim lands), so it is planted at tick 1:
    // the first-probed arm is the sole claimant (its marker lands on its tick
    // 2 dance, after every arm's tick 1 is in flight); the second arm gets a
    // foreign lock and NO marker — undecided at the claim, disposed as
    // lostRace, REFUSED; the third arm is disposed clean.
    manifest();
    const runIds = new Map<string, string>(); // vm → the runId dispatch minted
    let winnerVm: string | undefined;
    let lockedVm: string | undefined;
    driver.onProbe = (vm) => {
      if (tickOf(vm) === 1) {
        if (winnerVm === undefined) winnerVm = vm;
        else if (lockedVm === undefined) {
          lockedVm = vm;
          plantRunLock(runIds.get(vm) as string);
        }
        return;
      }
      // The winner's marker rides its tick-2 dance: planted during the
      // presence probe, read by the same tick's `cat`, claimed immediately.
      if (vm === winnerVm) plantMarker(driver, vm, { ok: true });
    };
    const res = await fanout(
      "race",
      3,
      brief(),
      raceDeps({
        rosterIds: ["r0", "r1", "r2"],
        setupGate: async (_d, vm, o) => {
          runIds.set(vm, o.runId);
          return { ready: true, assertions: [], debugCommands: [], teardownCommand: `td ${vm}`, vm };
        },
      }),
    );
    expect(runIds.size).toBe(3);
    expect(res.winner).not.toBeNull();
    const lockedArm = res.arms.findIndex((a) => a.vmName === lockedVm);
    expect(lockedArm).toBeGreaterThanOrEqual(0);
    expect(res.winner).not.toBe(lockedArm);
    expect(res.arms[lockedArm]?.outcome).toBe("lostRace");
    // The refusal is the ONLY error line, names the locked arm's run, and
    // carries the run-locked remediation — INV-LOCK-3: never silent.
    const refusals = entries.filter(
      (e) =>
        e.operation === "fleet.fanout.arm" &&
        (e.error as { code?: string } | undefined)?.code === "loser-teardown-refused",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.arm).toBe(lockedArm);
    expect(refusals[0]?.runId).toBe(runIds.get(lockedVm as string));
    expect((refusals[0]?.error as { remediation?: string } | undefined)?.remediation).toContain("wait for that invocation");
    // Nothing ELSE failed: the disposal loop completed past the refusal.
    const otherLoserErrors = entries.filter(
      (e) =>
        e.operation === "fleet.fanout.arm" &&
        typeof (e.error as { code?: string } | undefined)?.code === "string" &&
        String((e.error as { code?: string }).code).startsWith("loser-teardown-"),
    );
    expect(otherLoserErrors).toHaveLength(1); // only the refusal above
    // The refused box survives untouched (acquire throws before any mutation);
    // the sibling's disposal ran through to its record close and destroy.
    expect(boxExists(driver, lockedVm)).toBe(true);
    // F10: `boxExists(driver, undefined)` is false BY CONSTRUCTION, so a
    // sibling the `find` below failed to locate would make the next two lines
    // pass vacuously — the arm whose clean disposal this test exists to
    // witness would simply be missing. Pin its presence first.
    const sibling = res.arms.find((a) => a.arm !== lockedArm && a.arm !== res.winner);
    expect(sibling).toBeDefined();
    expect(sibling?.outcome).toBe("lostRace");
    expect(boxExists(driver, sibling?.vmName)).toBe(false);
    expect(store.get(sibling?.runId as string).closedAt).toBeDefined();
  }, 20_000);

  test("the loser disposal threads the fan-out's requestId into withRunLock — the acquire line is attributable (D7)", () => {
    // D7 (round 3): every `withRunLock` site owes the Observability Contract
    // one acquire line per attempt, and a fan-out's loser disposals used to
    // emit theirs with the `-` fallback — a refusal an operator could not tie
    // to the fan-out that caused it. The acquire line rides run-lock's own
    // stderr channel (`writeSync(2)`, deliberately not the swappable log
    // sink), so there is no in-process seam to read it back through; the
    // wiring is pinned at the call site the same way the `fleet status`
    // shared-surface pin above works.
    const src = readFileSync(join(import.meta.dir, "../../src/fleet/fanout-primitive.ts"), "utf8");
    const site = /withRunLock\(\s*runsDir,\s*o\.runId as string,\s*"fanout loser teardown"/.exec(src);
    expect(site).not.toBeNull();
    const tail = src.slice(site?.index ?? 0, (site?.index ?? 0) + 600);
    expect(tail).toContain("destructive: true");
    expect(tail).toContain("requestId: deps.requestId");
  });
});
