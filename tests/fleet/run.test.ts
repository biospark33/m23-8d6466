/**
 * DF1.10 AC1, host side — `fleet run <run-id>` starts the in-box phase engine
 * and RETURNS.
 *
 * The verb's whole job is one idempotent `systemctl start` against DF2.10's
 * `qds-run@.service` template. Everything this file asserts falls out of three
 * facts the story makes load-bearing, and each has a negative control here:
 *
 *  - it does not HOLD the run. `systemctl start --wait` blocks until the unit
 *    EXITS, so an argv carrying `--wait` would satisfy "the engine ran" and
 *    violate AC1. The argv is pinned exactly, not by substring.
 *  - it does not ENABLE the instance. An enabled instance is pulled in by
 *    multi-user.target on every boot and re-walks phases whose git commits and
 *    LLM spend already happened (AC6, and the unit's own no-`[Install]` note).
 *    Pinned twice: the argv never says `enable`, and the shipped unit has no
 *    `[Install]` section for `enable` to succeed against.
 *  - a second `fleet run` starts no second engine. That is systemd's unit
 *    identity, not a host-side check — so what is asserted is that both calls
 *    address the byte-identical instance name, which is the property systemd's
 *    no-op rests on.
 *
 * The driver is a scripted stub, never `FakeDriver`: FakeDriver spawns the argv
 * for real, and the argv here begins `sudo -n systemctl` — a suite that ran it
 * would try to start units on the developer's own machine. FakeDriver is still
 * used for the RECORD fixtures (`provisionAdmittedRun`), which touch no exec.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MANAGER_DEFAULT_START_MS,
  RUN_START_TIMEOUT_MS,
  runUnitName,
  startRun,
  type StartRunDeps,
} from "../../src/fleet/run.ts";
import { listVerbs } from "../../src/fleet/verbs.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { provisionAdmittedRun, type ExecResult, type ProviderDriver } from "../../src/providers/driver.ts";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_KILLED_EXIT,
  EXEC_TRANSPORT_EXIT,
} from "../../src/providers/exedev/transport.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { run, type FleetDeps } from "../../scripts/fleet.ts";

/** The unit file DF2.10 ships and this verb starts an instance of. */
const UNIT_FILE = join(import.meta.dir, "../../oci/exedev/systemd/qds-run@.service");

interface RecordedExec {
  vm: string;
  argv: string[];
  timeoutMs?: number;
}

/**
 * A driver whose `exec`/`execTimed` are SCRIPTED — see the file docblock for
 * why this suite may not spawn the argv it builds.
 *
 * `execTimed` is present because the production ExeDev driver has it and
 * `startRun` must prefer it (an `exec`-only fallback inherits
 * `DEFAULT_EXEC_TIMEOUT_MS` and merely ABANDONS the ssh at the host deadline,
 * leaving the process running against the box). `withExecTimed: false` drops it
 * to exercise the structural fallback a test double may legitimately have.
 */
function stubDriver(
  answer: (argv: string[]) => ExecResult | Promise<ExecResult>,
  opts: { withExecTimed?: boolean } = {},
): ProviderDriver & { calls: RecordedExec[]; execTimed?: unknown } {
  const calls: RecordedExec[] = [];
  const notNeeded = (): never => {
    throw new Error("startRun must touch nothing but exec");
  };
  const driver = {
    name: "stub",
    calls,
    create: notNeeded,
    list: async () => [],
    destroy: notNeeded,
    expose: notNeeded,
    setPublic: notNeeded,
    whoami: notNeeded,
    copyFile: notNeeded,
    async exec(vm: string, argv: string[]): Promise<ExecResult> {
      calls.push({ vm, argv: [...argv] });
      return await answer(argv);
    },
    ...(opts.withExecTimed === false
      ? {}
      : {
          async execTimed(vm: string, argv: string[], timeoutMs: number): Promise<ExecResult> {
            calls.push({ vm, argv: [...argv], timeoutMs });
            return await answer(argv);
          },
        }),
  };
  return driver as unknown as ProviderDriver & { calls: RecordedExec[]; execTimed?: unknown };
}

/**
 * A healthy box: `systemctl start` accepts the job, and the unit that follows
 * reports `active`.
 *
 * The second half is not decoration. `qds-run@.service` is `Type=simple`, so
 * `systemctl start` exits 0 the instant the process is FORKED and every
 * post-fork failure is invisible to that status — so `startRun` corroborates
 * the start with `systemctl is-active` before it reports `started`. A scripted
 * driver that answered the probe with empty stdout would be scripting a box
 * whose systemd said nothing, which reads as `unknown`, not as a healthy start.
 */
const ok = (argv: string[]): ExecResult =>
  argv.includes("is-active")
    ? { stdout: "active\n", stderr: "", exitCode: 0 }
    : { stdout: "", stderr: "", exitCode: 0 };

/** The calls that are the START; the rest are the post-start liveness probe. */
const startCalls = (d: { calls: RecordedExec[] }): RecordedExec[] => d.calls.filter((c) => c.argv.includes("start"));
const probeCalls = (d: { calls: RecordedExec[] }): RecordedExec[] =>
  d.calls.filter((c) => c.argv.includes("is-active"));

describe("DF1.10 AC1 — fleet run starts the in-box engine and returns", () => {
  let dir: string;
  let runsDir: string;
  let store: RunRecordStore;
  let fake: FakeDriver;
  const runId = "qds-20260903-aa11bb";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-run-"));
    runsDir = join(dir, "runs");
    store = new RunRecordStore({ dir: runsDir });
    fake = new FakeDriver(join(dir, "boxes"));
    await provisionAdmittedRun(fake, store, { runId });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (driver: ProviderDriver): StartRunDeps => ({ driver, store }) as StartRunDeps;

  // ── the start itself ──────────────────────────────────────────────────────

  test("starts qds-run@<runId>.service on the run's box and returns `started`", async () => {
    const driver = stubDriver(ok);
    const res = await startRun(deps(driver), runId);

    const rec = store.get(runId);
    expect(rec.vmName).toBeDefined();
    const vm = rec.vmName as string;
    // `requestId` is the RECORD's — the join key dispatch stamped — and is
    // handed back rather than re-read, so the CLI needs no second store read.
    // `provisionAdmittedRun` writes none, so it is ABSENT here rather than
    // fabricated; the CLI's log line omits the key on exactly this shape.
    expect(res).toEqual({ outcome: "started", vm, unit: `qds-run@${runId}.service`, requestId: rec.requestId });
    // `requestId` is ABSENT, not present-and-undefined. `toEqual` treats the two
    // as equal, so the claim the comment above makes — "absent rather than
    // fabricated", which is what lets the CLI's log line omit the key — is
    // invisible to it. `provisionAdmittedRun` writes no requestId.
    expect(rec.requestId).toBeUndefined();
    expect(Object.hasOwn(res, "requestId")).toBeFalse();
    // The WHOLE argv, exact. A substring check on "systemctl" would pass for
    // `systemctl start --wait`, `systemctl enable`, and a start of the wrong
    // instance — the three shapes the next three tests exist to refuse.
    expect(driver.calls.map((c) => c.argv)).toEqual([
      ["sudo", "-n", "systemctl", "start", `qds-run@${runId}.service`],
      // The post-start corroboration, addressed at the SAME instance. No
      // `sudo`: `is-active` is a query, and a read that needed privilege the
      // box may not grant would fail closed to `unknown` on every healthy run.
      ["systemctl", "is-active", `qds-run@${runId}.service`],
    ]);
    expect(driver.calls[0]!.vm).toBe(vm);
    expect(driver.calls[1]!.vm).toBe(vm);
  });

  test("the record's requestId rides the result — the dispatch join key, never a fabricated one", async () => {
    const correlated = "qds-20260903-dd44ee";
    await provisionAdmittedRun(fake, store, { runId: correlated });
    store.set(correlated, { requestId: "req-from-dispatch" });
    const driver = stubDriver(ok);
    expect(await startRun(deps(driver), correlated)).toMatchObject({
      outcome: "started",
      requestId: "req-from-dispatch",
    });
    // …and it rides the FAILURE arms too, which is where an operator most needs
    // to join this refusal to the dispatch that made the box.
    const broken = stubDriver(() => ({ stdout: "", stderr: "nope", exitCode: 1 }));
    expect(await startRun(deps(broken), correlated)).toMatchObject({
      outcome: "start-failed",
      requestId: "req-from-dispatch",
    });
  });

  test("TWO execs and no more — the start and ONE liveness snapshot, nothing that waits on the engine", async () => {
    // AC1's "returns without holding the run" is not a timing claim a unit test
    // can make honestly — it is a claim about what the verb DOES. A host that
    // held the run would have to OBSERVE COMPLETION, and completion is observed
    // by reading the marker or by polling the unit until it stops.
    //
    // This assertion used to be "exactly one exec, and it is the start", with
    // `is-active` on the forbidden list. That was too strong and it hid a real
    // defect: `Type=simple` makes `systemctl start`'s exit 0 mean "forked", so
    // one exec could never tell a started engine from one that died on its
    // first line. The bound that carries AC1 is not "one exec" — it is a FIXED,
    // SMALL number of execs with no loop and no marker read among them. A
    // single non-repeating `is-active` cannot wait for anything: the unit is
    // `active` for the whole run, so the answer is the same in the first second
    // and the last. Polling it in a LOOP would be the violation, and the count
    // is what refuses that.
    const driver = stubDriver(ok);
    await startRun(deps(driver), runId);
    expect(driver.calls).toHaveLength(2);
    expect(startCalls(driver)).toHaveLength(1);
    expect(probeCalls(driver)).toHaveLength(1);
    for (const call of driver.calls) {
      const argv = call.argv.join(" ");
      // The marker is `fleet status`'s to read and `fleet harvest`'s to fetch.
      // A `--wait`/`journalctl`/`cat` in here is the host holding the run.
      for (const holding of ["--wait", "journalctl", "final.json", "cat", "sh -c"]) {
        expect(argv).not.toContain(holding);
      }
    }
  });

  test("NEGATIVE CONTROL — `--wait` never appears: it would block until the engine exits", async () => {
    // `systemctl start --wait` returns only when the unit does. It would pass
    // every other assertion in this file and turn `fleet run` into the host
    // holding a run for its whole walk, which is exactly what AC1 refuses.
    const driver = stubDriver(ok);
    await startRun(deps(driver), runId);
    expect(driver.calls[0]!.argv).not.toContain("--wait");
    expect(driver.calls[0]!.argv).not.toContain("--no-block");
  });

  test("NEGATIVE CONTROL — never `systemctl enable`: an enabled instance re-walks paid phases at every boot", async () => {
    const driver = stubDriver(ok);
    await startRun(deps(driver), runId);
    // AC6's other door. `Restart=no` refuses the crash-restart; the absent
    // `[Install]` section refuses the boot-restart. A verb that enabled the
    // instance would defeat the second while passing every test of the first.
    expect(driver.calls[0]!.argv).not.toContain("enable");
    expect(driver.calls[0]!.argv).toContain("start");
  });

  test("the shipped unit has NO [Install] section, so `enable` cannot succeed even by hand", () => {
    // The host-side half above pins what THIS verb sends. This pins the box-side
    // half it depends on: with no `[Install]`, `systemctl enable qds-run@<id>`
    // fails loudly ("unit files have no installation config") rather than
    // arranging a re-walk at the next boot.
    expect(existsSync(UNIT_FILE)).toBe(true);
    const unit = readFileSync(UNIT_FILE, "utf8");
    expect(unit).not.toMatch(/^\[Install\]/m);
    expect(unit).toMatch(/^Restart=no$/m);
    // And the instance name this verb builds is an instance OF THIS TEMPLATE.
    expect(UNIT_FILE.endsWith(`${runUnitName(runId).split("@")[0]}@.service`)).toBe(true);
  });

  test("the unit's ExecStart QUOTES %i (the runId-charset contract)", () => {
    // UNCONDITIONAL. This was written while DF2.10 shipped the template with no
    // `ExecStart` at all, and it guarded on `if (execStart !== undefined)` so it
    // could be green before leaf 1.2.3 landed the line and a real assertion
    // after. The line has landed — the shipped unit carries
    // `ExecStart=/usr/local/bin/qds-engine run "%i"` — so the guard now protects
    // nothing and only hides the test: DELETE the ExecStart and this file has
    // no opinion, which is the failure mode a conditional assertion always ends
    // in. `run %i` unquoted splits an instance name on whitespace; `run "%i"` is
    // the shipped form.
    const unit = readFileSync(UNIT_FILE, "utf8");
    const execStart = unit.split("\n").find((l) => l.startsWith("ExecStart="));
    expect(execStart).toBeDefined();
    expect(execStart).toContain('"%i"');
    // …and it starts the ENGINE, not a shell that re-splits the specifier.
    expect(execStart).toStartWith("ExecStart=/usr/local/bin/qds-engine run ");
  });

  // ── AC6: the double-start window is closed by unit identity ───────────────

  test("AC6 — a second `fleet run` addresses the byte-identical instance, so systemd's start is a no-op", async () => {
    // The verb runs NO host-side "is it already going?" check, deliberately:
    // any such check is a TOCTOU window (the answer can change between the
    // probe and the start). `systemctl start` on an already-active instance is
    // a no-op, and the property that buys is instance IDENTITY — so identity is
    // what this asserts. Two calls, one unit, no per-attempt state anywhere.
    const driver = stubDriver(ok);
    const first = await startRun(deps(driver), runId);
    const second = await startRun(deps(driver), runId);
    expect(second).toEqual(first);
    // The two STARTS, byte-identical. Filtered rather than indexed: each start
    // is followed by its own `is-active` snapshot, so `calls[1]` is the first
    // invocation's probe, not the second invocation's start.
    const [firstStart, secondStart] = startCalls(driver) as [RecordedExec, RecordedExec];
    expect(secondStart.argv).toEqual(firstStart.argv);
    // No `--force`, no `restart`, no `try-restart`: every one of those turns
    // the second invocation into a SECOND engine over phases already paid for.
    for (const call of driver.calls) {
      for (const forbidden of ["--force", "restart", "try-restart", "reset-failed"]) {
        expect(call.argv).not.toContain(forbidden);
      }
    }
  });

  test("the instance name needs no systemd escaping — the run-id grammar has no escapable character", () => {
    // `assertFleetRunId` admits only the RFC 1123 label grammar
    // (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`), which contains no `/`, `.`, `\` or
    // `%` — the characters `systemd-escape` exists for. That is what makes the
    // plain interpolation below safe, and it is also why the argv can carry the
    // id unquoted through any transport: nothing in the grammar is a shell
    // metacharacter either.
    expect(runUnitName("qds-20260903-aa11bb")).toBe("qds-20260903-aa11bb.service".replace(/^/, "qds-run@"));
    expect(runUnitName(runId)).toMatch(/^qds-run@[a-z0-9][a-z0-9-]*\.service$/);
  });

  // ── the deadline ──────────────────────────────────────────────────────────

  test("the per-call deadline is passed EXPLICITLY and clears the start job's REAL ceiling", async () => {
    const driver = stubDriver(ok);
    await startRun(deps(driver), runId);
    // `execTimed` preferred: `exec` hard-codes DEFAULT_EXEC_TIMEOUT_MS (120 s)
    // and a host-side `withTimeout` expiring only ABANDONS the ssh, leaving the
    // start running against the box past the deadline the caller set.
    expect(driver.calls[0]!.timeoutMs).toBe(RUN_START_TIMEOUT_MS);

    const unit = readFileSync(UNIT_FILE, "utf8");
    // This half used to read `TimeoutStartSec=60` back out of the unit and
    // require the host budget to clear it. The unit DELETED that directive with
    // an argument (its own "NO TimeoutStartSec=" block): for `Type=simple`
    // systemd calls the unit STARTED as soon as the process is forked, so the
    // start window closes microseconds after activation and the directive could
    // never elapse — it protected nothing while reading as a considered
    // activation guard. Depending on it here was depending on a lie, so what is
    // pinned instead is its ABSENCE: re-adding the inert directive is the exact
    // mistake that was made once and argued away, and it must not come back
    // quietly on the strength of this file having expected it.
    expect(unit).not.toMatch(/^TimeoutStartSec=/m);
    // …and the absence is only honest while the service type keeps it inert.
    // `Type=exec` and `Type=notify` — the two the unit names as the way to ARM
    // a start timeout — hold the start job open until the execve succeeds or
    // until a readiness notification arrives, at which point a declared budget
    // really does bound the job and `RUN_START_TIMEOUT_MS`'s derivation has to
    // be redone against it. Pinned together, so the leaf that changes the type
    // is stopped here rather than downstream of here.
    expect(unit).toMatch(/^Type=simple$/m);

    // The PROPERTY the deleted directive was standing in for is still real, and
    // this is what carries it now. `systemctl start` without `--no-block` waits
    // for the whole job TRANSACTION, and this unit pulls a second job into it:
    // `Requires=` ACTIVATES systemd-tmpfiles-setup.service when that oneshot is
    // inactive (the unit's own CEILING note), and `After=` orders our start
    // behind it — so a start systemd is legitimately running can block for as
    // long as that oneshot's own start job does. Nothing in this unit bounds
    // that wait; the MANAGER default does (`DefaultTimeoutStartSec`, 90 s on the
    // exeuntu/Ubuntu base, the same default the unit's `TimeoutStopSec` block
    // reasons about for the stop side). A host budget under it abandons a
    // healthy start and reports `box-unreachable` for a healthy box, which is
    // the failure this assertion has always existed to refuse.
    expect(unit).toMatch(/^Requires=systemd-tmpfiles-setup\.service$/m);
    expect(unit).toMatch(/^After=systemd-tmpfiles-setup\.service$/m);
    // STRICTLY greater, and the strictness is the whole property. An equal
    // budget is not a safe budget: the host's window and systemd's would expire
    // at the same instant, with the ssh round trip spent inside the host's and
    // outside systemd's — so the host gives up FIRST on a start job systemd is
    // still legitimately running and reports `box-unreachable` for a healthy
    // box, which is the exact failure this assertion exists to refuse. A
    // `toBeGreaterThanOrEqual` admits that case, and it was real: the constant
    // sat at exactly the ceiling until it was raised to clear it.
    //
    // The RELATIONSHIP is asserted, never the number. Both sides move — the
    // headroom is a judgement call, and `MANAGER_DEFAULT_START_MS` is systemd's
    // documented default rather than something measured on an exe.dev box, so
    // it may move too. Pinning either literal here is how the old 60/90
    // coupling rotted: it turns a deliberate budget change into a test edit,
    // and a test edited to match a constant asserts nothing about it.
    //
    // The direction this refuses is specific. Deleting `TimeoutStartSec=`
    // invites the inference "the unit declares no start timeout any more, so
    // the budget is over-generous" — and shrinking it on that reading is
    // exactly wrong, because the ceiling was never that directive.
    // IMPORTED, never re-typed. The comment above says "the RELATIONSHIP is
    // asserted, never the number" and then hard-coded 90_000 four lines later —
    // a second copy of systemd's default that the day the box OS moves stays
    // stale here and keeps passing against a ceiling nothing has any more.
    expect(RUN_START_TIMEOUT_MS).toBeGreaterThan(MANAGER_DEFAULT_START_MS);
    // The SECOND ceiling, and the same strictness for a second reason. With no
    // `execTimed` the start falls back to `exec`, which hard-codes
    // `DEFAULT_EXEC_TIMEOUT_MS` — so a host budget EQUAL to it makes both
    // timers fire at the same instant and which one reports is a coin flip.
    // (`status.ts` refuses to read over `exec` at all rather than live with
    // that; this module cannot refuse, so it clears the number instead.)
    expect(RUN_START_TIMEOUT_MS).toBeGreaterThan(DEFAULT_EXEC_TIMEOUT_MS);
  });

  test("a driver with no execTimed still gets the start (structural fallback, not a silent DEFAULT_EXEC_TIMEOUT_MS)", async () => {
    // Named by CONSTANT, not by value. This used to read "not a silent 120 s",
    // which was legible while `RUN_START_TIMEOUT_MS` was 90 s and the number
    // could only mean `DEFAULT_EXEC_TIMEOUT_MS`. The two are both 120 s now, so
    // the digits no longer distinguish the budget the caller CHOSE from the one
    // `exec` falls back to — and the distinction is the entire test.
    const driver = stubDriver(ok, { withExecTimed: false });
    const res = await startRun(deps(driver), runId);
    expect(res.outcome).toBe("started");
    expect(driver.calls[0]!.timeoutMs).toBeUndefined();
  });

  test("an exec that never comes back is bounded by the host deadline, not left hanging", async () => {
    const driver = stubDriver(() => new Promise<ExecResult>(() => {}));
    const res = await startRun(deps(driver), runId, { timeoutMs: 40 });
    expect(res).toMatchObject({ outcome: "start-failed", reason: "box-unreachable" });
  });

  test("the deadline is clamped at BOTH ends — 0/-1/NaN take the floor or the default, never a 1 ms window", async () => {
    // The floor arm: `Math.max(1, …)` keeps a 0 or negative budget from
    // refusing the call before the driver can answer. A scripted driver answers
    // instantly, so a 1 ms budget still completes — which is the point: the
    // outcome is `started`, not a manufactured `box-unreachable`.
    for (const timeoutMs of [0, -1]) {
      const driver = stubDriver(ok);
      expect(await startRun(deps(driver), runId, { timeoutMs })).toMatchObject({ outcome: "started" });
      expect(driver.calls[0]!.timeoutMs).toBe(1);
    }
    // Non-finite never reaches the clamp: `Number.isFinite` sends it to the
    // module default, so a NaN budget is a DEFAULT budget rather than a 1 ms one.
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const driver = stubDriver(ok);
      expect(await startRun(deps(driver), runId, { timeoutMs })).toMatchObject({ outcome: "started" });
      expect(driver.calls[0]!.timeoutMs).toBe(RUN_START_TIMEOUT_MS);
    }
    // The CEILING, which had no clamp at all. `setTimeout` stores its delay in
    // a signed 32-bit int, so a budget past the max fires in 1 ms — a caller
    // asking for a LONGER window getting the shortest one there is, and every
    // healthy box reported `box-unreachable`. Clamped, the driver is handed the
    // largest budget that actually works.
    const huge = stubDriver(ok);
    expect(await startRun(deps(huge), runId, { timeoutMs: 2_147_483_648 })).toMatchObject({ outcome: "started" });
    expect(huge.calls[0]!.timeoutMs).toBe(2_147_483_647);
  });

  // ── refusals that touch nothing ───────────────────────────────────────────

  test("a run with no box is refused before any exec", async () => {
    const bare = "qds-20260903-cc22dd";
    store.create(bare);
    const driver = stubDriver(ok);
    expect(await startRun(deps(driver), bare)).toEqual({ outcome: "run-not-startable", state: "no-box" });
    expect(driver.calls).toHaveLength(0);
  });

  test("a GATE-FAILED run is refused before any exec — its box is alive and it failed its setup assertions", async () => {
    // `dispatch` writes `extensions.gate = {outcome:"failed", …}` and then, per
    // INV-5, leaves the record OPEN and the box ALIVE with `vmName` set and no
    // approval state — so a gate-failed run passed every one of the three
    // guards this block used to hold and got an engine, which then walked
    // phases (git commits, LLM spend) on a box that failed assertion A/B/C.
    // Nothing read `extensions.gate` back anywhere in the repo; this is the
    // first reader.
    store.set(runId, {
      extensions: { gate: { outcome: "failed", failedItem: "A", assertionCode: 1, failedAt: new Date().toISOString() } },
    } as never);
    const driver = stubDriver(ok);
    expect(await startRun(deps(driver), runId)).toEqual({ outcome: "run-not-startable", state: "gate-failed" });
    expect(driver.calls).toHaveLength(0);
  });

  test("a gate that did NOT fail is no bar to starting — the refusal is on the outcome, not on the key", async () => {
    // The guard must not become "no gate record ⇒ refuse". Dispatch writes the
    // extension ONLY on failure, so a healthy run carries none and a
    // presence-based check would refuse every run there is.
    const passed = "qds-20260903-ee55ff";
    await provisionAdmittedRun(fake, store, { runId: passed });
    store.set(passed, {
      extensions: { gate: { outcome: "passed", failedAt: new Date().toISOString() } },
    } as never);
    expect(await startRun(deps(stubDriver(ok)), passed)).toMatchObject({ outcome: "started" });
  });

  test("startRun REFUSES an off-grammar id itself, before it builds an argv", async () => {
    // The CLI validates too (`scripts/fleet.ts` calls `assertFleetRunId` before
    // this function), so deleting that upstream call broke no test here — while
    // `statusRun` in the same story calls it as its OWN first statement. The
    // guarantee belongs to the function that RELIES on it: `runUnitName`
    // interpolates the id raw into a systemd instance name, and the argument
    // for why that is safe is the grammar, not the caller.
    for (const bad of ["has space", "with/slash", "pct%i", "..", "UPPER", "-leading", "trailing-", ""]) {
      const driver = stubDriver(ok);
      await expect(startRun(deps(driver), bad)).rejects.toMatchObject({ exitCode: 2 });
      expect(driver.calls).toHaveLength(0);
    }
  });

  test("a closed run is refused before any exec — its box is gone", async () => {
    store.close(runId);
    const driver = stubDriver(ok);
    expect(await startRun(deps(driver), runId)).toEqual({ outcome: "run-not-startable", state: "closed" });
    expect(driver.calls).toHaveLength(0);
  });

  test("any approval state refuses — `requestApproval` tears the box down BEFORE it promotes", async () => {
    // Attach's ruling, and the same evidence: every approval state is strictly
    // after that teardown, so `vmName` survives on the record while the box
    // does not. An UNRECOGNISED state refuses too — an unknown state is not
    // evidence the box survived.
    for (const state of ["pausing", "awaiting-approval", "approved", "rejected", "timed-out", "from-the-future"]) {
      const id = `qds-20260903-${state.replace(/[^a-z0-9]/g, "")}`.slice(0, 40);
      await provisionAdmittedRun(fake, store, { runId: id });
      store.set(id, {
        extensions: { approval: { state, proposal: "p", reportId: "rv-0", headSha: "a".repeat(40) } },
      } as never);
      const driver = stubDriver(ok);
      expect(await startRun(deps(driver), id)).toEqual({ outcome: "run-not-startable", state });
      expect(driver.calls).toHaveLength(0);
    }
  });

  // ── the start that failed ─────────────────────────────────────────────────

  test("systemd refusing the start is `unit-refused` — permanent for this box, never a retry signal", async () => {
    // AssertPathExists=/home/exedev/app/.env failing, or no such unit on a box
    // built from the wrong image. Retrying is identical every time.
    const driver = stubDriver(() => ({
      stdout: "",
      stderr: "Assertion failed for QDS-Factory phase-engine run",
      exitCode: 1,
    }));
    const res = await startRun(deps(driver), runId);
    expect(res).toMatchObject({ outcome: "start-failed", reason: "unit-refused", exitCode: 1 });
    expect((res as { detail?: string }).detail).toContain("Assertion failed");
  });

  test("a box that never answered is `box-unreachable` — the one arm a retry can clear", async () => {
    for (const exitCode of [EXEC_KILLED_EXIT, EXEC_TRANSPORT_EXIT]) {
      const driver = stubDriver(() => ({ stdout: "", stderr: "", exitCode }));
      const res = await startRun(deps(driver), runId);
      // Retrying THIS arm is safe precisely because of AC6's unit identity: if
      // the start did land before the transport died, the retry is systemd's
      // no-op, not a second engine.
      expect(res).toMatchObject({ outcome: "start-failed", reason: "box-unreachable", exitCode });
    }
  });

  test("a thrown exec is reported, never propagated — an untyped throw is the CLI's retryable exit 1", async () => {
    const driver = stubDriver(() => {
      throw new Error("ssh: connect to host qds.exe.xyz port 22: Connection refused");
    });
    const res = await startRun(deps(driver), runId);
    expect(res).toMatchObject({ outcome: "start-failed", reason: "box-unreachable" });
    expect((res as { detail?: string }).detail).toContain("Connection refused");
  });

  test("stderr on a failed start is BOUNDED — a box can put megabytes there", async () => {
    // SPACE-SEPARATED words, not `"x".repeat(50_000)`. That probe was one
    // ≥40-character token in `LONG_TOKEN_RE`'s charset, so `redactSecrets` —
    // which runs BEFORE the slice in `boxText` — collapsed the whole 50 KB to a
    // short placeholder and `length <= 300` held with `.slice(0, DETAIL_CHARS)`
    // DELETED. ` ` is outside that charset, so this text is redaction-immune
    // and only the cap can bound it.
    const driver = stubDriver(() => ({ stdout: "", stderr: "word ".repeat(20_000), exitCode: 1 }));
    const res = (await startRun(deps(driver), runId)) as { detail?: string };
    expect(res.detail!.length).toBeLessThanOrEqual(300);
    expect(res.detail).toContain("word");
  });

  test("a failed start with NOTHING on stderr falls back to stdout — the whole diagnosis is there", async () => {
    // Every other failure case here has empty stdout, so deleting the
    // `|| res.stdout.trim()` arm lost the diagnosis silently. systemd normally
    // says why on stderr; a box whose systemctl is wrapped, or whose shell
    // merged the streams, says it on stdout.
    const driver = stubDriver(() => ({
      stdout: "Failed to start qds-run@x.service: Unit not found.",
      stderr: "",
      exitCode: 1,
    }));
    const res = (await startRun(deps(driver), runId)) as { detail?: string };
    expect(res.detail).toContain("Failed to start");
  });

  test("systemd's OWN 255 is a unit refusal, not a transport fault — the classification is pinned", async () => {
    // 137/255 are read as the TRANSPORT's statuses, purely by number, and the
    // numbers are not exclusively the transport's: `systemctl` can exit 255,
    // and a unit's own status can surface as 137. This pins the chosen reading
    // rather than leaving it to be re-argued: a NUMBER is not evidence of who
    // produced it, so the fail-safe classification is the RETRYABLE one —
    // `box-unreachable` costs one wasted round trip (and a retry is a systemd
    // no-op by AC6's unit identity), while calling a transport fault
    // `unit-refused` strands a healthy box on a terminal exit 5 that no retry
    // may clear.
    const driver = stubDriver(() => ({
      stdout: "",
      stderr: "Failed to start qds-run@x.service: Access denied\nSee system logs for details.",
      exitCode: EXEC_TRANSPORT_EXIT,
    }));
    const res = await startRun(deps(driver), runId);
    expect(res).toMatchObject({ outcome: "start-failed", reason: "box-unreachable", exitCode: EXEC_TRANSPORT_EXIT });
  });

  // ── the start that was ACCEPTED and did not take (Type=simple) ────────────

  test("exit 0 with the unit already FAILED is `unit-refused` — Type=simple reports a start at the fork", async () => {
    // The hole this closes: for `Type=simple` systemd considers the unit
    // started the instant the process is FORKED, so `systemctl start` exits 0
    // and every post-fork failure — an unreadable `run-context.json`, a
    // non-positive `budgetMs`, an unset HOME, a box dispatch never finished
    // furnishing — was invisible. `fleet run` printed `started` and exited 0,
    // `Restart=no` left the unit `failed`, and no marker was ever written, so
    // `fleet status` then had nothing to read either.
    const driver = stubDriver((argv) =>
      argv.includes("is-active")
        ? { stdout: "failed\n", stderr: "", exitCode: 3 }
        : { stdout: "", stderr: "", exitCode: 0 },
    );
    const res = await startRun(deps(driver), runId);
    expect(res).toMatchObject({ outcome: "start-failed", reason: "unit-refused" });
    // PERMANENT, so it must not carry a transport exit code an operator would
    // read as a network fault — the start itself exited 0.
    expect((res as { exitCode?: number }).exitCode).toBeUndefined();
    expect((res as { detail?: string }).detail).toContain("failed");
  });

  test("a unit that is INACTIVE or unreadable after an accepted start still reports `started`", async () => {
    // Neither may manufacture `unit-refused`, the arm the CLI maps to a
    // terminal exit 5. `inactive` means the process ran and exited — a start
    // that LANDED, possibly a whole run that finished inside the round trip.
    // `unknown` means the probe produced no reading, which is not evidence of
    // failure. Fail-closed cuts the other way here than it does in `status`:
    // there the doubtful reading must not claim success about the RUN; here it
    // must not claim a refusal systemd never issued.
    for (const probe of [
      { stdout: "inactive\n", stderr: "", exitCode: 3 },
      { stdout: "", stderr: "ssh: connection closed", exitCode: EXEC_TRANSPORT_EXIT },
      { stdout: "unknown\n", stderr: "", exitCode: 4 },
    ]) {
      const driver = stubDriver((argv) => (argv.includes("is-active") ? probe : { stdout: "", stderr: "", exitCode: 0 }));
      expect(await startRun(deps(driver), runId)).toMatchObject({ outcome: "started" });
    }
    // …and a probe that THROWS is the same: a liveness probe may not take the
    // verb down, and its failure is not the start's failure.
    const thrower = stubDriver((argv) => {
      if (argv.includes("is-active")) throw new Error("ssh died");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(await startRun(deps(thrower), runId)).toMatchObject({ outcome: "started" });
  });

  test("a start systemd REFUSED is never probed — there is no unit to ask about", async () => {
    const driver = stubDriver(() => ({ stdout: "", stderr: "Unit not found.", exitCode: 5 }));
    await startRun(deps(driver), runId);
    expect(probeCalls(driver)).toHaveLength(0);
  });

  test("foreign text is REDACTED then capped — a cap first splits a long token past recognition", async () => {
    // The ONE arm the order is load-bearing for. `redactSecrets`'s PREFIX arm
    // survives either order (`SECRET_PREFIX_RE`'s tail is `[…]*`, so a bare
    // `sk-or-` prefix still matches), which is why a prefixed key is the wrong
    // probe here and would pass against the broken order. Its LONG-TOKEN arm
    // needs ≥40 characters: a 45-character unprefixed credential straddling the
    // 300-char cap leaves a 10-character fragment the arm can no longer see.
    // The head is padded to 290 so the token is cut at exactly that boundary.
    const token = "Zq7SmvKpLd3RtYw9NxJbHc2VfGa5UeQi8OpAzXrTdWnM4";
    expect(token.length).toBeGreaterThanOrEqual(40);
    // SPACE-separated words, not a run of one character: ` ` is outside
    // `LONG_TOKEN_RE`'s charset, so the head cannot merge with the token into a
    // single ≥40 match that would be redacted under either order — which is
    // exactly how a first draft of this test passed against the broken one.
    const head = "word ".repeat(58); // 290 chars, so the token is cut at the cap
    expect(head).toHaveLength(290);
    const driver = stubDriver(() => ({ stdout: "", stderr: `${head}${token}`, exitCode: 1 }));
    const res = (await startRun(deps(driver), runId)) as { detail?: string };
    expect(res.detail!.length).toBeLessThanOrEqual(300);
    // Neither the whole token nor the 10-character head a cap-first order would
    // have left behind.
    expect(res.detail).not.toContain(token);
    expect(res.detail).not.toContain(token.slice(0, 10));
    // …and the same rule on the thrown path, where the text is an exception's
    // own message rather than the box's stderr.
    const thrower = stubDriver(() => {
      throw new Error(`${head}${token}`);
    });
    const thrown = (await startRun(deps(thrower), runId)) as { detail?: string };
    expect(thrown.detail).not.toContain(token.slice(0, 10));
  });
});

// ── the CLI surface ─────────────────────────────────────────────────────────

describe("DF1.10 AC1 — the `run` verb's registry entry and exit table", () => {
  let dir: string;
  let runsDir: string;
  let store: RunRecordStore;
  let fake: FakeDriver;
  const runId = "qds-20260903-aa11bb";
  const out: string[] = [];
  const err: string[] = [];
  const sinkOut = (s: string): void => void out.push(s);
  const sinkErr = (s: string): void => void err.push(s);

  beforeEach(async () => {
    out.length = 0;
    err.length = 0;
    dir = mkdtempSync(join(tmpdir(), "fleet-run-cli-"));
    runsDir = join(dir, "runs");
    store = new RunRecordStore({ dir: runsDir });
    fake = new FakeDriver(join(dir, "boxes"));
    await provisionAdmittedRun(fake, store, { runId });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cli = (argv: string[], driver?: ProviderDriver): Promise<number> =>
    run(argv, sinkOut, { store, ...(driver === undefined ? {} : { driver }) } as Partial<FleetDeps>, sinkErr);

  test("the registry declares `run` with a complete flag table and exit codes", () => {
    const entry = listVerbs().find((v) => v.verb === "run");
    expect(entry).toBeDefined();
    expect([...entry!.flags].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
    ]);
    // 3 is dispatch's setup gate and nothing else; `run` provisions nothing.
    expect(entry!.exitCodes).toEqual([0, 1, 2, 4, 5, 6]);
  });

  test("`run` appears in --help with its summary and its exit-code table", async () => {
    expect(await cli(["--help"])).toBe(0);
    const help = out.join("");
    const entry = listVerbs().find((v) => v.verb === "run")!;
    expect(help).toContain("run");
    expect(help).toContain(entry.summary);
    expect(help).toContain(entry.exitCodes.join(", "));
  });

  test("exit 0 and one completion line on a started run", async () => {
    const driver = stubDriver(ok);
    expect(await cli(["run", runId, "--driver", "stub", "--dir", runsDir], driver)).toBe(0);
    expect(out.join("")).toBe(`started: ${runId}\n`);
    // The completion line is stdout; every diagnostic is stderr. A caller
    // parsing this verb's output must never have to skip an envelope in it.
    expect(err.join("")).not.toContain("started:");
  });

  test("exit 2: no run id, an id off the grammar, and a missing --driver", async () => {
    expect(await cli(["run", "--driver", "stub"], stubDriver(ok))).toBe(2);
    expect(err.join("")).toContain("run requires <run-id>");
    err.length = 0;
    expect(await cli(["run", "NOT_AN_ID", "--driver", "stub"], stubDriver(ok))).toBe(2);
    expect(err.join("")).toContain("invalid-run-id");
    err.length = 0;
    // No driver INJECTED either — the flag is the only way to choose one here.
    expect(await run(["run", runId], sinkOut, { store }, sinkErr)).toBe(2);
    expect(err.join("")).toContain("run requires --driver <name>");
  });

  test("exit 2: a second positional is refused", async () => {
    expect(await cli(["run", runId, "extra", "--driver", "stub"], stubDriver(ok))).toBe(2);
    expect(err.join("")).toContain("exactly one <run-id>");
  });

  test("exit 4: an id with no record, nothing execed", async () => {
    const driver = stubDriver(ok);
    expect(await cli(["run", "qds-19990101-000000", "--driver", "stub", "--dir", runsDir], driver)).toBe(4);
    expect(err.join("")).toContain("run-not-found");
    expect(driver.calls).toHaveLength(0);
  });

  test("exit 5: the run cannot take a start, and the box was never touched", async () => {
    store.close(runId);
    const driver = stubDriver(ok);
    expect(await cli(["run", runId, "--driver", "stub", "--dir", runsDir], driver)).toBe(5);
    expect(err.join("")).toContain("run-not-startable");
    expect(driver.calls).toHaveLength(0);
    expect(out.join("")).toBe("");
  });

  test("exit 5: systemd refused the unit — permanent, so NOT the retryable 1", async () => {
    const driver = stubDriver(() => ({ stdout: "", stderr: "Unit qds-run@x.service not found.", exitCode: 5 }));
    expect(await cli(["run", runId, "--driver", "stub", "--dir", runsDir], driver)).toBe(5);
    expect(err.join("")).toContain("engine-start-refused");
    expect(out.join("")).toBe("");
  });

  test("the refusal remediation is FOUR-WAY: an unrecognised state is never told its box is gone", async () => {
    // attach's round-9 E4/B12 ruling, adopted rather than re-learned. A state
    // this build does not recognise is evidence of NOTHING, so asserting a
    // torn-down box there would be a claim, not an observation.
    const cases: [string, string][] = [
      ["awaiting-approval", "fleet approve"],
      ["rejected", "torn down"],
      ["from-the-future", "inspect the box before acting"],
    ];
    for (const [state, want] of cases) {
      const id = `qds-20260903-${state.replace(/[^a-z0-9]/g, "")}`.slice(0, 40);
      await provisionAdmittedRun(fake, store, { runId: id });
      store.set(id, {
        extensions: { approval: { state, proposal: "p", reportId: "rv-0", headSha: "a".repeat(40) } },
      } as never);
      err.length = 0;
      expect(await cli(["run", id, "--driver", "stub", "--dir", runsDir], stubDriver(ok))).toBe(5);
      expect({ state, err: err.join("") }).toMatchObject({ err: expect.stringContaining(want) });
    }
  });

  test("a silent failure renders no `(exit undefined)` and no dangling colon", async () => {
    // Both fragments are optional: a host deadline that fired has no exit
    // status, and a box that failed without a word has no stderr. Rendered
    // unconditionally they read as a lie and as truncated output.
    const driver = stubDriver(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    expect(await cli(["run", runId, "--driver", "stub", "--dir", runsDir], driver)).toBe(5);
    const envelope = JSON.parse(err[0] as string) as { message: string };
    expect(envelope.message).toContain("(exit 1)");
    expect(envelope.message).not.toContain("undefined");
    expect(envelope.message.endsWith(":")).toBe(false);
  });

  test("exit 1: the box never answered — the one arm automation may retry", async () => {
    const driver = stubDriver(() => ({ stdout: "", stderr: "", exitCode: EXEC_TRANSPORT_EXIT }));
    expect(await cli(["run", runId, "--driver", "stub", "--dir", runsDir], driver)).toBe(1);
    expect(err.join("")).toContain("engine-start-unreachable");
  });

  test("exit 6: the engine STARTED and the result line could not be written — landed, not retryable", async () => {
    const driver = stubDriver(ok);
    const broken = (): never => {
      const e = new Error("EAGAIN: resource temporarily unavailable, write") as NodeJS.ErrnoException;
      e.code = "EAGAIN";
      throw e;
    };
    // 6, never 1: the engine is walking phases in the box. A retryable 1 sends
    // automation back to start a run that is already running — harmless only
    // because of unit identity, and misleading regardless.
    //
    // Bound to a named `code` deliberately: verbs.test.ts's excuse table cites
    // THIS case as the one that owes `run`'s exit 6, and its binding check
    // requires an `expect(<…code>).toBe(6)` shape in the body — an inline
    // `expect(await run(…)).toBe(6)` would leave the excuse unsatisfied.
    const code = await run(
      ["run", runId, "--driver", "stub", "--dir", runsDir],
      broken,
      { store, driver } as Partial<FleetDeps>,
      sinkErr,
    );
    expect(code).toBe(6);
    // The engine really did start — that is what makes 6 the right code and 1
    // the wrong one. One start, plus the liveness snapshot that corroborated it.
    expect(startCalls(driver)).toHaveLength(1);
    expect(driver.calls).toHaveLength(2);
  });
});
