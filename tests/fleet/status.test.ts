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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { statusAll, statusRun, type StatusDeps } from "../../src/fleet/status.ts";
import { DEFAULT_PER_CALL_DEADLINE_MS, MARKER_UNUSABLE_TICKS_LIMIT } from "../../src/fleet/fanout-primitive.ts";
import { runMarkerPath } from "../../src/phase-engine/journal.ts";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../../src/providers/exedev/transport.ts";
import { EXEC_MAX_OUTPUT_BYTES } from "../../src/providers/bounded-exec.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";
import type { ExecResult, ProviderVm } from "../../src/providers/driver.ts";

const RUN_ID = "sbx-20260903-a1b2c3";
const VM = RUN_ID;

/** One exec leg's answer, or a throw. */
type Leg = ExecResult | Error;

interface Recorded {
  /** Every argv the marker read issued, in order. */
  argv: string[][];
  /** Every per-call deadline handed to `execTimed`. */
  deadlines: number[];
  execCalls: number;
}

/**
 * A status driver over a scripted box. `execTimed` answers the presence probe
 * and the `cat`; `exec` is recorded but must never be reached — it is the
 * channel that hard-codes the 120 s default, and AC5 forbids inheriting it.
 */
function driverWith(
  legs: Leg[],
  opts: { boxes?: ProviderVm[]; execTimed?: boolean; exec?: boolean } = {},
): StatusDeps["driver"] & { rec: Recorded } {
  const rec: Recorded = { argv: [], deadlines: [], execCalls: 0 };
  let i = 0;
  const next = (): Leg => legs[Math.min(i++, legs.length - 1)] as Leg;
  const boxes = opts.boxes ?? [{ name: VM } as ProviderVm];
  const driver: StatusDeps["driver"] & { rec: Recorded } = {
    list: async (name?: string): Promise<ProviderVm[]> =>
      name === undefined ? boxes : boxes.filter((b) => b.name === name),
    rec,
  };
  if (opts.exec !== false) {
    driver.exec = async (_vm: string, argv: string[]): Promise<ExecResult> => {
      rec.execCalls += 1;
      rec.argv.push(argv);
      const leg = next();
      if (leg instanceof Error) throw leg;
      return leg;
    };
  }
  if (opts.execTimed !== false) {
    driver.execTimed = async (_vm: string, argv: string[], timeoutMs: number): Promise<ExecResult> => {
      rec.argv.push(argv);
      rec.deadlines.push(timeoutMs);
      const leg = next();
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

  test("an ABSENT marker is `running` — the run is walking its phases, not stuck at `live`", async () => {
    const driver = driverWith([missing()]);
    const row = await statusRun(deps(driver), RUN_ID);
    expect(row.state).toBe("running");
    expect(row.state).not.toBe("live");
    // The presence probe is enough: no `cat` is issued for a file that is not there.
    expect(driver.rec.argv).toHaveLength(1);
  });

  test("a marker carrying ok:true is `ok`", async () => {
    const row = await statusRun(deps(driverWith([found(), catOut('{"ok":true}')])), RUN_ID);
    expect(row.state).toBe("ok");
  });

  test("a marker carrying ok:false is `not-ok` — a settled run that reported failure", async () => {
    const row = await statusRun(deps(driverWith([found(), catOut('{"ok":false}')])), RUN_ID);
    expect(row.state).toBe("not-ok");
  });

  test("the marker read targets runMarkerPath() on the box, shell-quoted by the providers layer", async () => {
    const driver = driverWith([found(), catOut('{"ok":true}')]);
    await statusRun(deps(driver), RUN_ID);
    const [probe, read] = driver.rec.argv as [string[], string[]];
    expect(probe[0]).toBe("sh");
    expect(probe[2]).toContain(runMarkerPath());
    expect(probe[2]).toStartWith("test -f ");
    expect(read[2]).toStartWith("cat ");
    expect(read[2]).toContain(runMarkerPath());
  });

  describe("INV-IBOX-7 — in-box evidence is a claim, never a proof", () => {
    test("an UNREADABLE marker past the tick ceiling is `unknown`, NEVER `ok`", async () => {
      // Present at `test -f`, non-zero at `cat`, every time. temp+rename means
      // that is corruption, not a half-written file.
      const driver = driverWith([found(), catFail(), found(), catFail(), found(), catFail(), found(), catFail()]);
      const row = await statusRun(deps(driver), RUN_ID);
      expect(row.state).toBe("unknown");
      expect(row.state).not.toBe("ok");
      // The ceiling is the poller's own, and it is REACHED, not approximated:
      // MARKER_UNUSABLE_TICKS_LIMIT probe/cat pairs and then it stops.
      expect(driver.rec.argv).toHaveLength(MARKER_UNUSABLE_TICKS_LIMIT * 2);
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
      // The cap itself is NOT raised by this story.
      expect(EXEC_MAX_OUTPUT_BYTES).toBe(512 * 1024);
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
      const deadlineMs = 200;
      const started = Date.now();
      const row = await statusRun(deps(hung, deadlineMs), RUN_ID);
      const elapsed = Date.now() - started;
      expect(row.state).toBe("unknown");
      // ONE deadline, with slack for a loaded machine — and an order of
      // magnitude below the 120 s default this must never inherit.
      expect(elapsed).toBeLessThan(deadlineMs * 8);
      expect(elapsed).toBeLessThan(DEFAULT_EXEC_TIMEOUT_MS);
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

    test("RETRIES share the one budget — three unusable reads cost one deadline, not three", async () => {
      // Each retry gets what the last one left. Handing every attempt the full
      // deadline would make a slow-corrupt marker cost MARKER_UNUSABLE_TICKS_LIMIT
      // deadlines, which is the hang the AC names, arrived at the long way.
      const slowFail = async (): Promise<ExecResult> => {
        await new Promise((r) => setTimeout(r, 40));
        return catFail();
      };
      const driver = driverWith([]);
      let call = 0;
      driver.execTimed = async (_vm: string, _argv: string[], timeoutMs: number): Promise<ExecResult> => {
        driver.rec.deadlines.push(timeoutMs);
        return call++ % 2 === 0 ? found() : await slowFail();
      };
      const deadlineMs = 300;
      const started = Date.now();
      const row = await statusRun(deps(driver, deadlineMs), RUN_ID);
      expect(row.state).toBe("unknown");
      expect(Date.now() - started).toBeLessThan(deadlineMs * 4);
      // Strictly shrinking across attempts is what "one budget" looks like.
      expect(Math.max(...driver.rec.deadlines)).toBeLessThanOrEqual(deadlineMs);
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
      store.set(older, { vmName: older });
      const entries: LogEntry[] = [];
      const restore = setLogSink((e) => entries.push(e));
      try {
        const rows = await statusAll(
          deps(
            driverWith([], {
              execTimed: false,
              boxes: [{ name: VM } as ProviderVm, { name: older } as ProviderVm],
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
      }
      const listing = driverWith([found(), catOut('{"ok":true}')]);
      await expect(statusAll(deps(listing, 0))).rejects.toMatchObject({ code: "invalid-marker-deadline" });
    });

    test("an omitted markerDeadlineMs defaults to the poller's per-call deadline, not the 120 s exec default", async () => {
      const driver = driverWith([found(), catOut('{"ok":true}')]);
      const row = await statusRun({ driver, store, listTimeoutMs: 1_000 }, RUN_ID);
      expect(row.state).toBe("ok");
      expect(Math.max(...driver.rec.deadlines)).toBeLessThanOrEqual(DEFAULT_PER_CALL_DEADLINE_MS);
      expect(driver.rec.deadlines).not.toContain(DEFAULT_EXEC_TIMEOUT_MS);
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
      const older = "old-run-df110";
      store.create(older);
      store.set(older, { vmName: older });
      const rows = await statusAll(
        deps(
          driverWith([missing()], {
            boxes: [{ name: VM } as ProviderVm, { name: older } as ProviderVm],
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
      expect(Date.parse(rows[0]?.createdAt as string)).toBeGreaterThanOrEqual(
        Date.parse(rows[1]?.createdAt as string),
      );
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
