/**
 * DF1.10 AC5 — a live in-box run is observable from the host.
 *
 * NEGATIVE CONTROL, and the reason every assertion below names a literal:
 * before this story a run with a live `vmName` and no terminal state reported
 * `state: "live"` FOREVER, because `status.ts` had no awareness of the in-box
 * marker. (The story text says the stuck literal is `"ready"`; it is not —
 * `"ready"` is `fleet dispatch`'s one-shot ack literal, which `status.ts` never
 * emits. `"live"` is the state that never resolved, so `"live"` is what these
 * tests must refuse to accept.) Every test here passes trivially against that
 * behaviour if it asserts the wrong word.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { statusAll, statusRun, type StatusDeps } from "../../src/fleet/status.ts";
import { BOX_MARKER_PATH, DEFAULT_PER_CALL_DEADLINE_MS } from "../../src/fleet/fanout-primitive.ts";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../../src/providers/exedev/transport.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";
import type { ExecResult, ProviderVm } from "../../src/providers/driver.ts";

const RUN_ID = "sbx-20260903-a1b2c3";
// DISTINCT, deliberately. Aliasing `VM === RUN_ID` made every fixture's two
// join keys the same string, so an implementation addressing the box by
// `runId` instead of `vmName` (or building `qds-run@<vmName>.service` instead
// of `qds-run@<runId>.service`) produced byte-identical argv on every fixture
// here — the whole wrong-key regression class was invisible while the suite
// stayed green. On a real fleet the two names differ.
const VM = `${RUN_ID}-box`;

/**
 * Timer slop on the tightened whole-read bounds: `setTimeout` can fire late
 * under load, and the bound's job is to fail on a SECOND full deadline, not to
 * flake on the healthy one-deadline path it pins. `* 2 + SLOP_MS` is the
 * tightest shape that holds both: a two-full-deadlines regression (the exact
 * shape the old `* 3` bound swallowed — deadline 500 admitted ~1000 ms) now
 * trips it with 200 ms to spare, while a healthy read (~1 deadline) sits a
 * full deadline below it.
 */
const SLOP_MS = 200;

/** One exec leg's answer, or a throw. */
type Leg = ExecResult | Error;

interface Recorded {
  /** Every argv the marker read issued, in order. */
  argv: string[][];
  /** Every per-call deadline handed to `execTimed`. */
  deadlines: number[];
  execCalls: number;
  /** Every vm argument the exec channels were addressed to, in order. */
  vms: string[];
  /** How many times `list()` was asked — it is substrate touch too. */
  listCalls: number;
}

/**
 * A status driver over a scripted box. `execTimed` answers the presence probe
 * and the `cat`; `exec` is recorded but must never be reached — it is the
 * channel that hard-codes the 120 s default, and AC5 forbids inheriting it.
 *
 * An UNSCRIPTED marker leg THROWS rather than clamping: the old
 * `legs[Math.min(i, legs.length - 1)]` answered an empty script with
 * `undefined` (silently flowing into the verdict path) and an overrun by
 * repeating the last leg forever — a fixture that under-scripted its reads
 * passed on the previous leg's answer instead of failing loudly. The unit
 * probe answers off `opts.unit` and never consumes a marker-leg slot.
 */
function driverWith(
  legs: Leg[],
  opts: { boxes?: ProviderVm[]; execTimed?: boolean; exec?: boolean; unit?: Leg } = {},
): StatusDeps["driver"] & { rec: Recorded } {
  const rec: Recorded = { argv: [], deadlines: [], execCalls: 0, vms: [], listCalls: 0 };
  let i = 0;
  // The UNIT probe answers off its own script, not off the marker legs. An
  // absent marker is followed by `systemctl is-active` on the run's unit —
  // absence alone means four different things and only one of them is "still
  // walking its phases" — and letting that probe consume a marker leg would
  // make every fixture's leg sequence describe two different reads.
  //
  // `active` by default: the box these fixtures describe is a run in progress,
  // which is what makes an absent marker mean `running` at all.
  const unitLeg: Leg = opts.unit ?? { stdout: "active\n", stderr: "", exitCode: 0 };
  const next = (argv: string[]): Leg => {
    if (argv.includes("is-active")) return unitLeg;
    const leg = legs[i++];
    if (leg === undefined) {
      throw new Error(
        `driverWith: unscripted marker leg #${i} (argv ${argv.join(" ")}); the fixture scripted ${legs.length} leg(s)`,
      );
    }
    return leg;
  };
  const boxes = opts.boxes ?? [{ name: VM } as ProviderVm];
  const driver: StatusDeps["driver"] & { rec: Recorded } = {
    list: async (name?: string): Promise<ProviderVm[]> => {
      rec.listCalls += 1;
      return name === undefined ? boxes : boxes.filter((b) => b.name === name);
    },
    rec,
  };
  if (opts.exec !== false) {
    driver.exec = async (vm: string, argv: string[]): Promise<ExecResult> => {
      rec.execCalls += 1;
      rec.argv.push(argv);
      rec.vms.push(vm);
      const leg = next(argv);
      if (leg instanceof Error) throw leg;
      return leg;
    };
  }
  if (opts.execTimed !== false) {
    driver.execTimed = async (vm: string, argv: string[], timeoutMs: number): Promise<ExecResult> => {
      rec.argv.push(argv);
      rec.vms.push(vm);
      // Only the MARKER legs' budgets: the deadline assertions are about the
      // probe/`cat` pair sharing one absolute budget, and the unit probe's
      // leftover slice is a different claim (asserted in its own test below).
      if (!argv.includes("is-active")) rec.deadlines.push(timeoutMs);
      const leg = next(argv);
      if (leg instanceof Error) throw leg;
      return leg;
    };
  }
  return driver;
}

const found = (): ExecResult => ({ stdout: "", stderr: "", exitCode: 0 });
const missing = (): ExecResult => ({ stdout: "", stderr: "", exitCode: 1 });
const catOut = (content: string): ExecResult => ({ stdout: content, stderr: "", exitCode: 0 });
const catFail = (exitCode = 1, stderr = "cat: Permission denied"): ExecResult => ({ stdout: "", stderr, exitCode });

describe("AC5: fleet status reads the in-box marker", () => {
  let dir: string;
  let store: RunRecordStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df110-status-"));
    store = new RunRecordStore(dir);
    store.create(RUN_ID);
    // A live box and NO terminal state — the AC's exact precondition.
    store.set(RUN_ID, { vmName: VM });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (driver: StatusDeps["driver"], markerDeadlineMs = 1_000): StatusDeps => ({
    driver,
    store,
    listTimeoutMs: 1_000,
    markerDeadlineMs,
  });

  test("an ABSENT marker with an ACTIVE unit is `running` — absence CORROBORATED, not assumed", async () => {
    const driver = driverWith([missing()]);
    const row = await statusRun(deps(driver), RUN_ID);
    expect(row.state).toBe("running");
    expect(row.state).not.toBe("live");
    // The presence probe is enough for the MARKER: no `cat` is issued for a
    // file that is not there. The second call is the unit probe that turns
    // "no marker" into "no marker AND the engine is up".
    expect(driver.rec.argv).toHaveLength(2);
    expect(driver.rec.argv[0]?.[2]).toStartWith("test -f ");
    expect(driver.rec.argv[1]).toEqual(["systemctl", "is-active", `qds-run@${RUN_ID}.service`]);
    // BOTH join keys in one frame, distinguishable because VM ≠ RUN_ID: every
    // exec is addressed to the BOX's own name, while the unit asked about is
    // the RUN's instance — exactly the two-key regression class the aliased
    // fixtures could not observe.
    expect(driver.rec.vms).toEqual([VM, VM]);
    expect(row.vmName).toBe(VM);
  });

  describe("an absent marker is FOUR states, not one (the `running` forever bug)", () => {
    // `absent` used to return `running` unqualified — the ONE verdict with no
    // corroboration behind it, produced by four situations: dispatched but
    // `fleet run` never invoked; the engine died after the fork; the box
    // REBOOTED, wiping tmpfs `/run` (and with `Restart=no` and no `[Install]`
    // the engine does not come back, so a run that reported `ok` reverts to
    // `running` PERMANENTLY); or the marker was harvested. Every one of them
    // said "walking its phases" forever on a box that bills by the hour, which
    // is the "an in-box run reports ready forever" failure AC5's negative
    // control says must fail — reached through a different word.

    test("absent + a FAILED unit is `engine-failed`, never `running`", async () => {
      const driver = driverWith([missing()], { unit: { stdout: "failed\n", stderr: "", exitCode: 3 } });
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("engine-failed");
      expect(row.state).not.toBe("running");
      expect(row.state).not.toBe("ok");
    });

    test("absent + an INACTIVE unit is `not-running` — the tmpfs/reboot case AC5 is most exposed to", async () => {
      // `/run` is tmpfs, so a reboot wipes the marker; `Restart=no` plus no
      // `[Install]` section means systemd does not bring the engine back. A run
      // that had reported `ok` therefore comes back with NO marker and NO
      // engine — and reported `running` forever. It is `not-running` now: four
      // causes, one honest reading ("no engine is running and no result was
      // left behind"), because separating them needs a durable in-box artefact
      // this read does not have.
      const driver = driverWith([missing()], { unit: { stdout: "inactive\n", stderr: "", exitCode: 3 } });
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("not-running");
      expect(row.state).not.toBe("running");
    });

    test("absent + a TRANSITIONING unit reads by its direction — `activating`/`reloading` are UP, `deactivating` is down", async () => {
      // `unitActivity`'s deliberate grouping (run.ts:341-355), pinned from the
      // status side: these are REAL `is-active` outputs during a reload or a
      // slow start, and none had a probe in this file — a regression dropping
      // them to the `default`/unknown arm flipped a row for a box that
      // ANSWERED to the fail-closed word, and an engine still booting read as
      // `unknown` instead of `running`.
      for (const word of ["activating", "reloading"]) {
        const driver = driverWith([missing()], { unit: { stdout: `${word}\n`, stderr: "", exitCode: 0 } });
        expect((await statusRun(deps(driver), RUN_ID)).state).toBe("running");
      }
      const stopping = driverWith([missing()], { unit: { stdout: "deactivating\n", stderr: "", exitCode: 0 } });
      expect((await statusRun(deps(stopping), RUN_ID)).state).toBe("not-running");
    });

    test("absent + an UNREADABLE unit is `unknown` — no corroboration fails CLOSED", async () => {
      // INV-IBOX-7 on the unit probe as well as on the marker. A box that
      // answers about the FILE and not about the UNIT has told us nothing about
      // the run, and `running` would be the reassuring guess.
      for (const unit of [
        new Error("ssh: connection closed by remote host"),
        { stdout: "", stderr: "", exitCode: 255 },
        { stdout: "some-word-systemd-never-says\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 4 },
      ] as Leg[]) {
        const driver = driverWith([missing()], { unit });
        const row = await statusRun(deps(driver), RUN_ID);
        expect(row.state).toBe("unknown");
        expect(row.state).not.toBe("running");
      }
    });

    test("a SETTLED marker is decisive whatever the unit says — the engine exits after it writes", async () => {
      // Order matters and this pins it: the marker is read FIRST. A healthy
      // finished run leaves `ok` on disk and an `inactive` unit, so a unit-first
      // read would report `not-running` for the one outcome that is complete.
      const driver = driverWith([found(), catOut('{"ok":true}')], {
        unit: { stdout: "inactive\n", stderr: "", exitCode: 3 },
      });
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("ok");
      // …and the unit was never asked, because there was nothing to corroborate.
      expect(driver.rec.argv.some((a) => a.includes("is-active"))).toBeFalse();
    });
  });

  test("a marker carrying ok:true is `ok`", async () => {
    const row = await statusRun(deps(driverWith([found(), catOut('{"ok":true}')])), RUN_ID);
    expect(row.state).toBe("ok");
  });

  test("a marker carrying ok:false is `not-ok` — a settled run that reported failure", async () => {
    const row = await statusRun(deps(driverWith([found(), catOut('{"ok":false}')])), RUN_ID);
    expect(row.state).toBe("not-ok");
  });

  test("the marker read targets the BOX's /run/journal/final.json, shell-quoted by the providers layer", async () => {
    const driver = driverWith([found(), catOut('{"ok":true}')]);
    await statusRun(deps(driver), RUN_ID);
    const [probe, read] = driver.rec.argv as [string[], string[]];
    expect(probe[0]).toBe("sh");
    expect(probe[2]).toStartWith("test -f ");
    expect(read[2]).toStartWith("cat ");
    // The LITERAL, not `runMarkerPath()`. Both test and production used to call
    // that function, so the expectation moved with the implementation and
    // nothing pinned the path the box side actually publishes — the assertion
    // was a tautology over the host's own environment.
    expect(probe[2]).toContain("/run/journal/final.json");
    expect(read[2]).toContain("/run/journal/final.json");
    expect(BOX_MARKER_PATH).toBe("/run/journal/final.json");
  });

  test("a host-side QDS_RUN_ROOT does NOT leak into the box command", async () => {
    // `runMarkerPath()` reads `QDS_RUN_ROOT` off the HOST — a test seam for
    // exercising `finish()` where `/run` is root-owned or absent — and this
    // path is shipped into a `test -f` INSIDE the box. An operator, a test
    // runner or a shell profile exporting it made every probe hit a path the
    // box does not have: `test -f` returned 1, the verdict was a CLEAN
    // `absent`, and every live row in the fleet reported the run as
    // progressing regardless of what it had done. journal.ts names this exact
    // hazard and `harvest.ts` already keeps a host-side literal because of it.
    const prev = process.env.QDS_RUN_ROOT;
    process.env.QDS_RUN_ROOT = "/tmp/host-side-run-root";
    try {
      const driver = driverWith([found(), catOut('{"ok":true}')]);
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("ok");
      for (const argv of driver.rec.argv) {
        expect(argv.join(" ")).not.toContain("/tmp/host-side-run-root");
      }
      expect((driver.rec.argv[0] as string[])[2]).toContain("/run/journal/final.json");
    } finally {
      // Reflect.deleteProperty, not `= undefined`: Bun coerces an undefined
      // assignment into the STRING "undefined".
      if (prev === undefined) Reflect.deleteProperty(process.env, "QDS_RUN_ROOT");
      else process.env.QDS_RUN_ROOT = prev;
    }
  });

  test("the row's OWN runId rides the read — another run's marker never settles this row", async () => {
    // Two records can address one box (`joinedBox` falls back to matching on
    // the run id for the INV-1 crash window, and `reportDuplicateBoxNames`
    // exists because duplicate box names happen), and the marker body is the
    // only thing that knows WHOSE run settled. Without this, a record whose id
    // collided with a live box owned by another record read that box's marker
    // and reported `ok` for a run that never started.
    const other = JSON.stringify({ runId: "sbx-somebody-else", ok: true, completedAt: "2026-09-03T00:00:00.000Z" });
    const row = await statusRun(deps(driverWith([found(), catOut(other)])), RUN_ID);
    expect(row.state).toBe("unknown");
    expect(row.state).not.toBe("ok");
    // …and the row's own marker settles normally.
    const mine = JSON.stringify({ runId: RUN_ID, ok: true, completedAt: "2026-09-03T00:00:00.000Z" });
    expect((await statusRun(deps(driverWith([found(), catOut(mine)])), RUN_ID)).state).toBe("ok");
  });

  describe("INV-IBOX-7 — in-box evidence is a claim, never a proof", () => {
    test("an UNREADABLE marker is `unknown`, NEVER `ok` — and it is read ONCE", async () => {
      // Present at `test -f`, non-zero at `cat`. temp+rename means that is
      // corruption, not a half-written file.
      const driver = driverWith([found(), catFail(), found(), catFail(), found(), catFail(), found(), catFail()]);
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("unknown");
      expect(row.state).not.toBe("ok");
      // ONE probe/`cat` pair. This used to be MARKER_UNUSABLE_TICKS_LIMIT pairs,
      // and the retry it counted could not fire in the case its own docblock
      // justified: every attempt was handed the WHOLE remaining budget, so a
      // `cat` killed at the budget (the "busy box, not a corrupt marker" case)
      // left nothing for a second attempt. What it did retry was the FAST
      // failures — a parse error, a non-boolean `ok`, an oversized read — which
      // the same docblock calls permanently corrupt: three identical reads of
      // an identical file, on an operator's deadline. A single snapshot is also
      // strictly more fail-closed than the poller, which is the direction the
      // shared-ceiling argument cared about.
      expect(driver.rec.argv).toHaveLength(2);
    });

    test("an OVERSIZED marker is `unknown` — a capped read is a PREFIX, and prefixes do not parse", async () => {
      // A truncated `{"ok":true}…` would parse as a whole marker if the cap
      // were dropped. `readBoxFile` refuses it as oversized; AC5 must not
      // upgrade that to a success report.
      const oversized: ExecResult = {
        stdout: '{"ok":true,"pad":"x',
        stderr: "",
        exitCode: 137,
        truncated: true,
      };
      const driver = driverWith([found(), oversized]);
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("unknown");
      expect(row.state).not.toBe("ok");
      // (The `expect(EXEC_MAX_OUTPUT_BYTES).toBe(512 * 1024)` that used to sit
      // here is gone: it restated a constant this story does not own and
      // described no behaviour of status.ts — a change detector on somebody
      // else's number. The behaviour it was standing in for is the assertion
      // above, that an oversized read is `unknown`.)
    });

    test("a marker whose ok is not a boolean is `unknown`, never read as truthy", async () => {
      for (const body of ['{"ok":"true"}', "{}", "not json", '{"ok":1}']) {
        const row = await statusRun(deps(driverWith([found(), catOut(body)])), RUN_ID);
        expect(row.state).toBe("unknown");
      }
    });

    test("a box that never answers is `unknown` — no reading is no evidence, and no evidence fails CLOSED", async () => {
      const row = await statusRun(deps(driverWith([new Error("ssh: connect to host: Connection refused")])), RUN_ID);
      expect(row.state).toBe("unknown");
    });

    test("a probe that exits non-clean does NOT read as absence", async () => {
      // exit 255 is ssh never connecting, not `test -f`'s clean miss. Reporting
      // it as `running` would tell an operator a dead box is making progress.
      const row = await statusRun(deps(driverWith([{ stdout: "", stderr: "ssh: connect failed", exitCode: 255 }])), RUN_ID);
      expect(row.state).toBe("unknown");
      expect(row.state).not.toBe("running");
    });
  });

  describe("the per-call deadline is explicit and bounds the whole read", () => {
    test("`fleet status` returns inside ONE deadline against an unreachable box", async () => {
      // The failure this exists to prevent: a status call that hangs 120 s
      // against a dead box because it inherited DEFAULT_EXEC_TIMEOUT_MS.
      const hung = driverWith([]);
      hung.execTimed = (): Promise<ExecResult> => new Promise<ExecResult>(() => {});
      // A LARGER deadline with a TIGHTER multiplier. `deadlineMs * 8` on a
      // 200 ms budget hid a 4× regression — two full deadlines, or four —
      // behind a bound that was also the only flake candidate in this file
      // under a parallel `bun test`. 500 ms of real budget makes the scheduler
      // jitter a small fraction of the bound instead of most of it. `* 2 +
      // SLOP_MS` (not the `* 3` this used to be): 3× a 500 ms budget still
      // admitted the two-full-deadlines regression it existed to catch
      // (~1000 ms elapsed passed a 1500 ms bound); 2× + slop trips on it.
      const deadlineMs = 500;
      const started = Date.now();
      const row = await statusRun(deps(hung, deadlineMs), RUN_ID);
      const elapsed = Date.now() - started;
      expect(row.state).toBe("unknown");
      expect(elapsed).toBeLessThan(deadlineMs * 2 + SLOP_MS);
      // (The `elapsed < DEFAULT_EXEC_TIMEOUT_MS` that used to follow is gone: a
      // 120 s bound on a call the line above holds to 1.5 s asserts nothing.)
    });

    test("the deadline reaches the SPAWN: execTimed is used and never the 120 s default", async () => {
      const driver = driverWith([found(), catOut('{"ok":true}')]);
      await statusRun(deps(driver, 750), RUN_ID);
      expect(driver.rec.execCalls).toBe(0); // `exec` would carry the 120 s default
      expect(driver.rec.deadlines).toHaveLength(2);
      for (const ms of driver.rec.deadlines) {
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(750);
        expect(ms).not.toBe(DEFAULT_EXEC_TIMEOUT_MS);
      }
    });

    test("the marker read is ONE snapshot on ONE budget — a corrupt marker is not re-read", async () => {
      // This test used to be "RETRIES share the one budget", and its only
      // budget assertion was `max(deadlines) <= deadlineMs` — which an
      // implementation handing EVERY attempt the full deadline (the exact
      // regression the name called out) satisfies with [300, 300, 300]. The
      // retry is gone (see the unreadable test above), so what is asserted now
      // is the property that replaced it and the property that survived: one
      // pair of legs, and their budgets STRICTLY SHRINK because `readBoxFile`
      // takes one absolute deadline at entry and hands each leg what is left.
      const driver = driverWith([]);
      let call = 0;
      driver.execTimed = async (_vm: string, _argv: string[], timeoutMs: number): Promise<ExecResult> => {
        driver.rec.deadlines.push(timeoutMs);
        // The PROBE burns 60 ms. Without a leg that costs real time the two
        // budgets differ by microseconds and "shrinking" is unassertable.
        if (call++ === 0) {
          await new Promise((r) => setTimeout(r, 60));
          return found();
        }
        return catFail();
      };
      const deadlineMs = 300;
      const started = Date.now();
      const row = await statusRun(deps(driver, deadlineMs), RUN_ID);
      expect(row.state).toBe("unknown");
      // ONE pair, not MARKER_UNUSABLE_TICKS_LIMIT of them.
      expect(driver.rec.deadlines).toHaveLength(2);
      expect(Math.max(...driver.rec.deadlines)).toBeLessThanOrEqual(deadlineMs);
      // The assertion the old one could not make: strictly less, by about what
      // the first leg spent.
      expect(driver.rec.deadlines[1] as number).toBeLessThan((driver.rec.deadlines[0] as number) - 40);
      // …and the whole read still fits inside ONE deadline (`* 2 + SLOP_MS`:
      // the old `* 3` swallowed a two-full-deadlines regression whole).
      expect(Date.now() - started).toBeLessThan(deadlineMs * 2 + SLOP_MS);
    });

    test("the unit probe is bounded by what the MARKER read left, not by a second deadline", async () => {
      // Absence is corroborated by a second exec, and a second exec on its own
      // fresh budget is how a status call costs two deadlines against a box
      // that is half-answering — the hang AC5 names, arrived at the long way.
      const seen: number[] = [];
      const driver = driverWith([]);
      driver.execTimed = async (_vm: string, argv: string[], timeoutMs: number): Promise<ExecResult> => {
        seen.push(timeoutMs);
        if (argv.includes("is-active")) return { stdout: "active\n", stderr: "", exitCode: 0 };
        await new Promise((r) => setTimeout(r, 60));
        return missing();
      };
      const deadlineMs = 300;
      const started = Date.now();
      const row = await statusRun(deps(driver, deadlineMs), RUN_ID);
      expect(row.state).toBe("running");
      expect(seen).toHaveLength(2);
      expect(seen[1] as number).toBeLessThan((seen[0] as number) - 40);
      expect(Date.now() - started).toBeLessThan(deadlineMs * 2 + SLOP_MS);
    });
  });

  describe("what is NOT read", () => {
    test("a driver with no execTimed keeps reporting `live` — and reads nothing", async () => {
      // Back-compatible by construction: `execTimed` is the only channel that
      // can honour an explicit deadline, so a driver without it is not asked at
      // all rather than asked over the 120 s default.
      const driver = driverWith([found(), catOut('{"ok":true}')], { execTimed: false });
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("live");
      expect(driver.rec.argv).toHaveLength(0);
      expect(driver.rec.execCalls).toBe(0);
    });

    test("…but the skip is OBSERVABLE: one note per listing, naming the missing channel", async () => {
      // Silence is the failure AC5 exists to end. Without this note a driver
      // that loses `execTimed` reports `live` exactly as it did before AC5 —
      // indistinguishable from AC5 working and finding a box that is up.
      const older = "old-run-df110";
      store.create(older);
      store.set(older, { vmName: `${older}-box` });
      const entries: LogEntry[] = [];
      const restore = setLogSink((e) => entries.push(e));
      try {
        const rows = await statusAll(
          deps(
            driverWith([], {
              execTimed: false,
              boxes: [{ name: VM } as ProviderVm, { name: `${older}-box` } as ProviderVm],
            }),
          ),
        );
        expect(rows.every((r) => r.state === "live")).toBeTrue();
      } finally {
        restore();
      }
      // LATCHED: two live rows, ONE note — the fact is about the driver, and a
      // note repeated per row is a note nobody reads.
      const notes = entries.filter((e) => e.operation === "fleet.status.marker_channel");
      expect(notes).toHaveLength(1);
      const note = notes[0] as unknown as { code: string; message: string };
      expect(note.code).toBe("marker-channel-unavailable");
      expect(note.message).toContain("execTimed");
      // Names the number a status read must never inherit, from the constant.
      expect(note.message).toContain(String(DEFAULT_EXEC_TIMEOUT_MS));
    });

    test("the note names WHICH method is missing — an execTimed-only driver is not blamed for execTimed", async () => {
      // `markerReader` requires `exec` AND `execTimed`, so a driver exposing
      // only `execTimed` lands on the same silent path — and the note used to
      // hand that operator a paragraph asserting "this driver exposes no
      // `execTimed`", remediation about the one method they actually had.
      const entries: LogEntry[] = [];
      const restore = setLogSink((e) => entries.push(e));
      try {
        const row = await statusRun(deps(driverWith([missing()], { exec: false })), RUN_ID);
        expect(row.state).toBe("live");
      } finally {
        restore();
      }
      const note = entries.find((e) => e.operation === "fleet.status.marker_channel") as unknown as {
        message: string;
      };
      expect(note.message).toContain("no `exec`");
      expect(note.message).not.toContain("exposes no `execTimed`");
    });

    test("nothing to read ⇒ nothing said: a fleet with no live row emits no channel note", async () => {
      // The note is about a QUESTION that went unanswered. A closed record asks
      // none, so a `--driver fake` run over a torn-down fleet stays quiet.
      store.close(RUN_ID);
      const entries: LogEntry[] = [];
      const restore = setLogSink((e) => entries.push(e));
      try {
        await statusAll(deps(driverWith([], { execTimed: false })));
      } finally {
        restore();
      }
      expect(entries.filter((e) => e.operation === "fleet.status.marker_channel")).toHaveLength(0);
    });

    test("a CLOSED record is never probed — its box is not walking phases", async () => {
      store.close(RUN_ID);
      const driver = driverWith([found(), catOut('{"ok":true}')]);
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("closed");
      expect(driver.rec.argv).toHaveLength(0);
      // A clean teardown leaves NO artifactsLost — absence is the "torn down
      // clean" signal (#221), so it must be a real absence, not undefined-by-
      // accident: the field is populated only from `extensions.teardown`.
      expect("artifactsLost" in row).toBeFalse();
    });

    test("#221: a closed row carrying extensions.teardown shows the artifacts loss", async () => {
      // Teardown's artifacts step is deliberately non-fatal (an undestroyable
      // box bills forever) — the loss lands on the record so this verb can say
      // it without the log stream. `code` sanitized+bounded; `failedAt` rides
      // along when the writer stamped it.
      store.set(RUN_ID, {
        extensions: {
          teardown: { schemaVersion: 1, artifactsCode: "artifacts-failed", artifactsFailedAt: "2026-09-05T14:00:00.000Z" },
        },
      });
      store.close(RUN_ID);
      const driver = driverWith([found(), catOut('{"ok":true}')]);
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("closed");
      expect(row.artifactsLost?.code).toBe("artifacts-failed");
      expect(row.artifactsLost?.failedAt).toBe("2026-09-05T14:00:00.000Z");
      // And never probed: the extension is record-side evidence.
      expect(driver.rec.argv).toHaveLength(0);
    });

    test("a run PAUSED for approval keeps its pause — the approval state outranks the marker", async () => {
      store.set(RUN_ID, { extensions: { approval: { state: "awaiting-approval", reportId: "rep-1" } } });
      const driver = driverWith([found(), catOut('{"ok":true}')]);
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("awaiting-approval");
      expect(driver.rec.argv).toHaveLength(0);
    });

    test("a record with NO live box is never probed — there is no box to address", async () => {
      const driver = driverWith([found(), catOut('{"ok":true}')], { boxes: [] });
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("boxMissing");
      expect(driver.rec.argv).toHaveLength(0);
    });

    test("an approval state that ECHOES the word `live` is not mistaken for a live row", async () => {
      // `approvalRowFields` renders an approval state this build does not know
      // VERBATIM, so a record carrying `approval.state: "live"` produces a row
      // whose `state` is the string "live" without being the ordinary live arm.
      // Probing it would overwrite the deliberately fail-VISIBLE unknown-state
      // signal — while `attachToRun` still refuses the same record as
      // `run-not-attachable`, which is the contradiction that arm prevents.
      store.set(RUN_ID, { extensions: { approval: { state: "live", reportId: "rep-1" } } });
      const driver = driverWith([found(), catOut('{"ok":true}')]);
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("live");
      expect(row.reportId).toBe("rep-1");
      expect(driver.rec.argv).toHaveLength(0);
    });

    test("an unlistable substrate is `boxUnknown`, not a marker read on a guessed name", async () => {
      const driver = driverWith([found(), catOut('{"ok":true}')]);
      driver.list = async (): Promise<ProviderVm[]> => {
        throw new Error("list down");
      };
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("boxUnknown");
      expect(driver.rec.argv).toHaveLength(0);
    });
  });

  describe("the deadline is validated, not silently obeyed", () => {
    test("a non-positive or non-finite markerDeadlineMs is REFUSED, exit 2, before the substrate is touched", async () => {
      // Silent and total otherwise: the budget check fires before the first
      // read, so every live row in the fleet reports `unknown` — indistinguishable
      // from genuinely unreadable markers, from one bad config number.
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const driver = driverWith([found(), catOut('{"ok":true}')]);
        const call = statusRun(deps(driver, bad), RUN_ID);
        await expect(call).rejects.toMatchObject({ exitCode: 2, code: "invalid-marker-deadline" });
        expect(driver.rec.argv).toHaveLength(0);
        // `list()` is substrate too — the test's name claims the substrate was
        // never touched, and an implementation that listed the fleet before
        // validating the budget violated it invisibly while argv stayed empty.
        expect(driver.rec.listCalls).toBe(0);
      }
      const listing = driverWith([found(), catOut('{"ok":true}')]);
      await expect(statusAll(deps(listing, 0))).rejects.toMatchObject({ code: "invalid-marker-deadline" });
      expect(listing.rec.listCalls).toBe(0);
    });

    test("an omitted markerDeadlineMs defaults to the poller's per-call deadline, not the 120 s exec default", async () => {
      const driver = driverWith([found(), catOut('{"ok":true}')]);
      const row = await statusRun({ driver, store, listTimeoutMs: 1_000 }, RUN_ID);
      expect(row.state).toBe("ok");
      expect(Math.max(...driver.rec.deadlines)).toBeLessThanOrEqual(DEFAULT_PER_CALL_DEADLINE_MS);
      expect(driver.rec.deadlines).not.toContain(DEFAULT_EXEC_TIMEOUT_MS);
      // A LOWER bound too. The two assertions above pass if the default
      // regresses to 5 s, to 500 ms or to 1 ms — every one of which is "not
      // 120 s" and none of which is the poller's per-call deadline. The first
      // leg gets essentially the whole budget, so it pins the default itself.
      expect(driver.rec.deadlines[0] as number).toBeGreaterThan(DEFAULT_PER_CALL_DEADLINE_MS - 1_000);
    });
  });

  describe("both entry points agree", () => {
    test("statusAll reports the in-box state too, and reports the SAME one as statusRun", async () => {
      const all = await statusAll(deps(driverWith([found(), catOut('{"ok":false}')])));
      const one = await statusRun(deps(driverWith([found(), catOut('{"ok":false}')])), RUN_ID);
      expect(all).toHaveLength(1);
      expect((all[0] as { state: string }).state).toBe("not-ok");
      expect((all[0] as { state: string }).state).toBe(one.state);
    });

    test("statusAll keeps the row's sort instant across the in-box override", async () => {
      // The override returns a NEW row object; the newest-first instant is
      // pinned off-row (a WeakMap), so pinning the pre-override row would sort
      // a live run to the top with the unattributed orphans.
      // DISTINCT instants, forced. `createdAt` is immutable on the record, so
      // the gap has to come from the clock — and without the wait the two
      // records were created milliseconds apart and frequently landed on the
      // IDENTICAL ISO millisecond, which `toBeGreaterThanOrEqual` accepted as a
      // pass. The named regression (an unpinned row sorting at +Infinity) puts
      // BOTH rows at +Infinity, where the order is arbitrary and the test
      // stayed green either way. A real gap plus an EXACT id order is what
      // makes this a sort assertion instead of a tie.
      await new Promise((r) => setTimeout(r, 10));
      const older = "new-run-df110"; // created LAST, so it sorts FIRST
      store.create(older);
      store.set(older, { vmName: `${older}-box` });
      const rows = await statusAll(
        deps(
          driverWith([missing(), missing()], {
            boxes: [{ name: VM } as ProviderVm, { name: `${older}-box` } as ProviderVm],
          }),
        ),
      );
      expect(rows).toHaveLength(2);
      // Both are `running`, and both still carry a parseable createdAt — an
      // unpinned row would have sorted to the front with +Infinity instead.
      for (const r of rows) {
        expect(r.state).toBe("running");
        expect(Number.isNaN(Date.parse(r.createdAt as string))).toBeFalse();
      }
      // Newest FIRST, by id, with a real gap that no tie can blur.
      expect(rows.map((r) => r.runId)).toEqual([older, RUN_ID]);
      expect(Date.parse(rows[0]?.createdAt as string)).toBeGreaterThan(Date.parse(rows[1]?.createdAt as string));
    });

    test("the sort instant is pinned from the RAW createdAt — a display-truncated timestamp still sorts by its parsed instant", async () => {
      // The named regression for the test above, which cannot produce it: the
      // pin only changes behaviour when the SANITIZED display `createdAt` is
      // unparseable — a >64-char timestamp truncates to 63 chars + an ellipsis
      // — and every store-minted createdAt is a 24-char ISO string. A
      // hand-migrated record with a LONG-but-parseable timestamp (the store
      // validates parseability, never length) is the input where an unpinned
      // final row falls back to parsing the display artifact, gets NaN, and
      // sorts at +Infinity — to the TOP, ahead of every healthy run, looking
      // exactly like the unattributed spend the +Infinity arm exists for.
      // `createdAt` is immutable through the store, so the record is written
      // to disk directly, in the store's own `{runId, createdAt}` shape.
      const migrated = "hand-migrated-run";
      // Fractional digits are ISO-8601 and both engines parse them; the point
      // is only that there are 120 of them.
      const longCreated = `2020-01-01T00:00:00.${"0".repeat(120)}Z`;
      expect(Number.isNaN(Date.parse(longCreated))).toBeFalse();
      expect(longCreated.length).toBeGreaterThan(64);
      writeFileSync(
        join(dir, `${migrated}.json`),
        JSON.stringify({ runId: migrated, createdAt: longCreated, vmName: `${migrated}-box` }),
      );
      const rows = await statusAll(
        deps(
          driverWith([missing(), missing()], {
            boxes: [{ name: VM } as ProviderVm, { name: `${migrated}-box` } as ProviderVm],
          }),
        ),
      );
      expect(rows).toHaveLength(2);
      // The DISPLAY createdAt is the truncated artifact — 64 units ending in
      // the ellipsis, unparseable by design…
      const shown = rows.find((r) => r.runId === migrated)?.createdAt;
      expect(shown).toHaveLength(64);
      expect(shown?.endsWith("…")).toBeTrue();
      expect(Number.isNaN(Date.parse(shown as string))).toBeTrue();
      // …so the comparator's fallback would rank it +Infinity and FIRST. The
      // pinned RAW instant ranks it LAST: 2020 against RUN_ID's test-time
      // creation six years later.
      expect(rows.map((r) => r.runId)).toEqual([RUN_ID, migrated]);
    });

    test("one row's failed read never removes another row — the listing describes the whole fleet", async () => {
      // A fleet where one box answers and one does not. Every row survives, and
      // each reports its OWN reading.
      const other = "other-run-df110";
      store.create(other);
      store.set(other, { vmName: other });
      const driver = driverWith([], {
        boxes: [{ name: VM } as ProviderVm, { name: other } as ProviderVm],
      });
      driver.execTimed = async (vm: string, argv: string[]): Promise<ExecResult> => {
        if (vm === VM) throw new Error("ssh: connect to host: Connection refused");
        return argv.includes("is-active") ? { stdout: "active\n", stderr: "", exitCode: 0 } : missing();
      };
      const rows = await statusAll(deps(driver));
      const byId = new Map(rows.map((r) => [r.runId, r.state]));
      expect(byId.get(RUN_ID)).toBe("unknown");
      expect(byId.get(other)).toBe("running");
    });

    test("the per-row sweep is allSettled — a rejection may not take the whole listing down", async () => {
      // `readMarkerVerdict` is documented as never rejecting and every other
      // await in the per-row callback is guarded, so there is no INPUT through
      // this verb's public surface that reaches the rejection path — which is
      // exactly why the `Promise.all` was invisible while it stood. Under it,
      // ONE unexpected throw on ONE row (a future note, a future sort hook, a
      // structural store's hostile getter) rejected the whole thing and `fleet
      // status` returned nothing at all for a fleet of N healthy runs — the
      // failure this file states three times as its own rule.
      //
      // Structure, then, because behaviour is unreachable: the sweep is
      // `allSettled` and it has a record-only fallback for the rejected arm. A
      // test that cannot fail on today's inputs still fails the day someone
      // swaps it back.
      //
      // ONE structural positive, kept: the sweep must be `allSettled`. The
      // brittle tokens that used to ride along (`not.toContain("await
      // Promise.all(")` and `toContain('r.status === "fulfilled"')`) are gone
      // — they pinned spelling, not behaviour: renaming the settlement
      // variable failed the test on identical behaviour, while a
      // `const p = Promise.all(rows); … await p` shape (no `await Promise.all(`
      // substring) reintroduced the exact regression and still passed. The
      // one retained positive cannot be satisfied by the regressed shape.
      const src = readFileSync(join(import.meta.dir, "../../src/fleet/status.ts"), "utf8");
      expect(src).toContain("Promise.allSettled");
    });

    test("the row keeps every other fact it carried — the override changes the state and nothing else", async () => {
      const before = await statusRun(deps(driverWith([found(), catOut('{"ok":true}')], { execTimed: false })), RUN_ID);
      const after = await statusRun(deps(driverWith([found(), catOut('{"ok":true}')])), RUN_ID);
      expect(before.state).toBe("live");
      expect(after.state).toBe("ok");
      expect({ ...after, state: "live" }).toEqual(before);
    });
  });
});
