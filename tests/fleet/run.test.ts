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
 *    no-op rests on. The one carve-out: a unit ALREADY `failed` is refused by a
 *    pre-start guard (only an ACTIVE start is a no-op; a start on `failed`
 *    re-runs ExecStart) — see run.ts's module header.
 *
 * Since that guard the call sequence is THREE substrate calls per invocation —
 * the pre-start `is-active` (refuses only on `failed`; every other reading
 * falls through), the start, and the post-start corroboration probe — and this
 * file pins all three.
 *
 * The driver is a scripted stub, never `FakeDriver`: FakeDriver spawns the argv
 * for real, and the argv here begins `sudo -n systemctl` — a suite that ran it
 * would try to start units on the developer's own machine. FakeDriver is still
 * used for the RECORD fixtures (`provisionAdmittedRun`), which touch no exec.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The REAL approval producer, for one arm of the approval-refusal test: the
// record `requestApproval` leaves is the shape `startRun`'s guard reads in
// production, and one end-to-end arm beats any number of hand-built `as never`
// fixtures for proving producer and guard still agree on the key.
import { requestApproval } from "../../src/fleet/approval-gate.ts";
import {
  MANAGER_DEFAULT_START_MS,
  RUN_START_TIMEOUT_MS,
  runUnitName,
  startRun,
  unitActivity,
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
import {
  EXTENSION_NAMESPACES,
  InvalidRunIdError,
  RunRecordStore,
} from "../../src/providers/run-record.ts";
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
): ProviderDriver & { calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const notNeeded = (): never => {
    throw new Error("startRun must touch nothing but exec");
  };
  const driver = {
    name: "stub",
    calls,
    create: notNeeded,
    // `list` too (B18): a soft `[]` here silently fed any future `list`
    // pre-check — the TOCTOU probe AC6's own comment explicitly rejects — an
    // empty roster instead of failing the suite.
    list: notNeeded,
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
  // The cast erases the optional `execTimed` (the `withExecTimed: false` arm
  // omits it), which is the double's point: `startRun` must handle a driver
  // whose type does not promise it.
  return driver as unknown as ProviderDriver & { calls: RecordedExec[] };
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
    // `requestId` is ABSENT, not present-and-undefined (B17: the claim is
    // carried entirely by the `hasOwn` assert — `toEqual` treats the two as
    // equal, `provisionAdmittedRun` writes no requestId, so a separate
    // `toBeUndefined` read the fixture, not the subject).
    expect(Object.hasOwn(res, "requestId")).toBeFalse();
    // The WHOLE argv, exact. A substring check on "systemctl" would pass for
    // `systemctl start --wait`, `systemctl enable`, and a start of the wrong
    // instance — the three shapes the next three tests exist to refuse.
    expect(driver.calls.map((c) => c.argv)).toEqual([
      // FIRST the pre-start guard (P3): one `is-active` asking exactly one
      // question — is the unit already `failed`? Every other reading falls
      // through to the start. No `sudo`, like the corroboration below:
      // `is-active` is a query, and a read that needed privilege the box may
      // not grant would fail closed to `unknown` on every healthy run.
      ["systemctl", "is-active", `qds-run@${runId}.service`],
      ["sudo", "-n", "systemctl", "start", `qds-run@${runId}.service`],
      // Then the post-start corroboration, addressed at the SAME instance.
      ["systemctl", "is-active", `qds-run@${runId}.service`],
    ]);
    expect(driver.calls[0]!.vm).toBe(vm);
    expect(driver.calls[1]!.vm).toBe(vm);
    expect(driver.calls[2]!.vm).toBe(vm);
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

  test("THREE execs and no more — guard probe, start, ONE corroboration snapshot; nothing that waits on the engine", async () => {
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
    //
    // The number is THREE since P3 added the pre-start guard, and the guard's
    // own `is-active` is one of the two single snapshots the count permits.
    const driver = stubDriver(ok);
    await startRun(deps(driver), runId);
    expect(driver.calls).toHaveLength(3);
    expect(startCalls(driver)).toHaveLength(1);
    expect(probeCalls(driver)).toHaveLength(2);
    for (const call of driver.calls) {
      const argv = call.argv.join(" ");
      // The marker is `fleet status`'s to read and `fleet harvest`'s to fetch.
      // A `--wait`/`journalctl`/`cat` in here is the host holding the run.
      for (const holding of ["--wait", "journalctl", "final.json", "cat", "sh -c"]) {
        expect(argv).not.toContain(holding);
      }
    }
  });

  test("the POST-START probe corroborates the COMPLETED start — it is never issued while the start is still pending", async () => {
    // Record order alone cannot tell "probe after start" from "probe racing
    // the start": a concurrent implementation still ISSUES the start first, so
    // argv order, exec count and argv-order checks all pass. What separates
    // them is the probe's ISSUANCE relative to the start's COMPLETION, held
    // open here by a gate the test controls. On a slow-starting box a racing
    // probe reads a PRE-activation unit state and the pinned classifications
    // silently change meaning — the probe exists to read what systemd made of
    // a job this process submitted, and a race submits no such job.
    //
    // Since P3 there are TWO `is-active` calls and only the SECOND is the
    // corroboration probe: the first is the pre-start GUARD, issued before the
    // start by design (run.ts's module-header carve-out), so "any is-active
    // before the start settles" stopped being a refusal signal. What must
    // never happen is an `is-active` AFTER the first one being issued while
    // the start is still pending.
    //
    // B13: asserted on ORDER, never on a wall-clock margin. The guard probe
    // and the start are both issued inside `startRun`'s first await chain, so
    // after ONE macrotask turn a correct invocation has issued exactly those
    // two; a Promise.all-shaped racer has issued its corroboration probe too
    // and is caught with the start still gated open. The documented ceiling: a
    // racer that delays its probe past a macrotask AND past the start's
    // settlement no longer reads pre-activation state of THIS start — the
    // start resolved before its probe issued.
    let isActiveCalls = 0;
    let startSettled = false;
    let postProbeRaced = false;
    let releaseStart = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const driver = stubDriver((argv) => {
      if (argv.includes("is-active")) {
        isActiveCalls += 1;
        // Call #1 is the pre-start GUARD. Any LATER `is-active` is the
        // corroboration probe, and it exists only after the start settled.
        if (isActiveCalls > 1 && !startSettled) postProbeRaced = true;
        return { stdout: "active\n", stderr: "", exitCode: 0 };
      }
      return gate.then(() => {
        startSettled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      });
    });
    const pending = startRun(deps(driver), runId);
    // ONE macrotask turn — not a 25 ms window — then the ordering claim: with
    // the start still gated open, exactly one start and one `is-active` exist.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startCalls(driver)).toHaveLength(1);
    expect(isActiveCalls).toBe(1);
    releaseStart();
    expect(await pending).toMatchObject({ outcome: "started" });
    expect(postProbeRaced).toBe(false);
    expect(isActiveCalls).toBe(2);
  });

  test("NEGATIVE CONTROL — `--wait` never appears: it would block until the engine exits", async () => {
    // `systemctl start --wait` returns only when the unit does. It would pass
    // every other assertion in this file and turn `fleet run` into the host
    // holding a run for its whole walk, which is exactly what AC1 refuses.
    const driver = stubDriver(ok);
    await startRun(deps(driver), runId);
    // The START call, not `calls[0]` — the pre-start guard's `is-active` holds
    // that slot now, and it contains neither flag by construction.
    const start = startCalls(driver)[0] as RecordedExec;
    expect(start.argv).not.toContain("--wait");
    expect(start.argv).not.toContain("--no-block");
  });

  test("NEGATIVE CONTROL — never `systemctl enable`: an enabled instance re-walks paid phases at every boot", async () => {
    const driver = stubDriver(ok);
    await startRun(deps(driver), runId);
    // AC6's other door. `Restart=no` refuses the crash-restart; the absent
    // `[Install]` section refuses the boot-restart. A verb that enabled the
    // instance would defeat the second while passing every test of the first.
    const start = startCalls(driver)[0] as RecordedExec;
    expect(start.argv).not.toContain("enable");
    expect(start.argv).toContain("start");
  });

  test("the shipped unit has NO [Install] section, so `enable` cannot succeed even by hand", () => {
    // The host-side half above pins what THIS verb sends. This pins the box-side
    // half it depends on: with no `[Install]`, `systemctl enable qds-run@<id>`
    // fails loudly ("unit files have no installation config") rather than
    // arranging a re-walk at the next boot.
    expect(existsSync(UNIT_FILE)).toBe(true);
    const unit = readFileSync(UNIT_FILE, "utf8");
    // `^\s*` on every anchored directive: systemd STRIPS leading whitespace
    // before reading a section header or directive, so `  [Install]` is an
    // honoured section a column-0 anchor cannot see — the negative control
    // would pass while `enable` succeeds by hand, through formatting the
    // parser accepts.
    expect(unit).not.toMatch(/^\s*\[Install\]/m);
    expect(unit).toMatch(/^\s*Restart=no$/m);
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
    // `^\s*`, like every other anchored directive in this file (B16): systemd
    // strips leading whitespace before reading a directive, so a column-0
    // finder false-fails an indented-but-honoured `ExecStart=`.
    const execStart = unit.split("\n").find((l) => /^\s*ExecStart=/.test(l));
    expect(execStart).toBeDefined();
    expect(execStart).toContain('"%i"');
    // …and it starts the ENGINE, not a shell that re-splits the specifier.
    expect(execStart).toMatch(/^\s*ExecStart=\/usr\/local\/bin\/qds-engine run /);
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
    // B14: per-invocation COUNTS, not just argv identity — "a second `fleet
    // run` starts no second engine" is a count claim, and the forbidden-word
    // loop below checks per-call contents only. Each invocation issues exactly
    // its own three calls (guard probe, start, corroboration); a duplicate
    // `start` or an extra `is-active` in the SECOND invocation fails here.
    expect(driver.calls).toHaveLength(6);
    expect(startCalls(driver)).toHaveLength(2);
    expect(probeCalls(driver)).toHaveLength(4);
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

  test("`runUnitName` refuses an off-grammar id ITSELF — the READ-path rule, with the legacy tail admitted", () => {
    // P1: the assert lives at the interpolation point, and it is
    // `assertExistingRunId` — the READ-path grammar (strict plus the legacy
    // tail), not the mint rule `assertFleetRunId` — because `fleet status`
    // sweeps legacy-grammar records through `unitActivity`, and the mint rule
    // here would have made one legacy record kill the whole status sweep. Both
    // grammars share the `[a-z0-9-]` class the escaping argument above turns
    // on. Typed throw, before any exec (the transitive arm below).
    for (const bad of ["bad_id", "a/b", "pct%i", "UPPER", "-leading", "x".repeat(64), ""]) {
      expect(() => runUnitName(bad)).toThrow(InvalidRunIdError);
    }
    // The LEGACY tail, admitted: `legacy-run-` ends in a hyphen the strict
    // mint grammar refuses, and an older store minted records under exactly
    // that shape.
    expect(runUnitName("legacy-run-")).toBe("qds-run@legacy-run-.service");
  });

  test("`unitActivity` inherits the refusal — an off-grammar id dies BEFORE any exec", async () => {
    // P1, transitively: the exported probe reaches the same interpolation via
    // its own `runUnitName` call, so a status-sweep consumer cannot pass an
    // off-grammar id through to a wrong-unit `is-active` reported `inactive`.
    const driver = stubDriver(ok);
    await expect(unitActivity(driver, "vm", "bad_id", 50)).rejects.toThrow(InvalidRunIdError);
    expect(driver.calls).toHaveLength(0);
  });

  test("`systemctl is-active` words are pinned WORD BY WORD — `activating` is UP, not unknown", async () => {
    // run.ts's `unitActivity` switch, pinned per word: `activating`/`reloading`
    // read as `active` (a unit coming up is the same operator posture as up)
    // and `deactivating` as `inactive`. These three are REAL `is-active`
    // outputs during reload/transition, and they were the one group with no
    // probe in this file OR status.test.ts — a regression dropping them to the
    // `default` arm (`unknown`) flipped a slow-starting engine's corroboration
    // and a `fleet status` row to the fail-closed word for a box that ANSWERED,
    // with nothing failing. Pinned directly on the exported probe because the
    // run verb's own observable (started/not-refused) cannot separate `active`
    // from `unknown` on the corroborated arm.
    const words: [string, "active" | "failed" | "inactive" | "unknown"][] = [
      ["active", "active"],
      ["activating", "active"],
      ["reloading", "active"],
      ["failed", "failed"],
      ["inactive", "inactive"],
      ["deactivating", "inactive"],
      ["unknown", "unknown"],
      ["some-word-systemd-never-says", "unknown"],
    ];
    for (const [word, want] of words) {
      const driver = stubDriver((argv) =>
        argv.includes("is-active")
          ? { stdout: `${word}\n`, stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0 },
      );
      expect(await unitActivity(driver, "vm", runId, 50)).toBe(want);
    }
  });

  // ── the deadline ──────────────────────────────────────────────────────────

  test("the per-call deadline is passed EXPLICITLY and clears the start job's REAL ceiling", async () => {
    const driver = stubDriver(ok);
    await startRun(deps(driver), runId);
    // `execTimed` preferred: `exec` hard-codes DEFAULT_EXEC_TIMEOUT_MS (120 s)
    // and a host-side `withTimeout` expiring only ABANDONS the ssh, leaving the
    // start running against the box past the deadline the caller set. The
    // START's budget — `calls[0]` is the guard probe since P3, and it carries
    // the same full verb budget (pinned in the probe-budget test below).
    expect((startCalls(driver)[0] as RecordedExec).timeoutMs).toBe(RUN_START_TIMEOUT_MS);

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
    expect(unit).not.toMatch(/^\s*TimeoutStartSec=/m);
    // …and the absence is only honest while the service type keeps it inert.
    // `Type=exec` and `Type=notify` — the two the unit names as the way to ARM
    // a start timeout — hold the start job open until the execve succeeds or
    // until a readiness notification arrives, at which point a declared budget
    // really does bound the job and `RUN_START_TIMEOUT_MS`'s derivation has to
    // be redone against it. Pinned together, so the leaf that changes the type
    // is stopped here rather than downstream of here.
    expect(unit).toMatch(/^\s*Type=simple$/m);

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
    // `^\s*` here too (B16), matching the anchor discipline every other
    // directive in this file argues for.
    expect(unit).toMatch(/^\s*Requires=systemd-tmpfiles-setup\.service$/m);
    expect(unit).toMatch(/^\s*After=systemd-tmpfiles-setup\.service$/m);
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
    //
    // B19/P8 companion: these two are constant-vs-constant asserts that
    // exercise no code — their whole job is to guard DELIBERATE EDITS of the
    // budget against its ceilings, and that is intentional.
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
    // could only mean `DEFAULT_EXEC_TIMEOUT_MS`. It went stale the other way
    // round when the constant was raised: the comment below claimed "the two
    // are both 120 s now", which contradicted the suite's own assertion that
    // `RUN_START_TIMEOUT_MS` is STRICTLY greater than `DEFAULT_EXEC_TIMEOUT_MS`
    // (125 s vs 120 s) — the both-timers-fire-at-the-same-instant hazard that
    // assertion exists to prevent. The numbers differ again, but the CONSTANT
    // stays: naming either value in prose re-couples this comment to two
    // numbers that are free to move independently.
    const driver = stubDriver(ok, { withExecTimed: false });
    const res = await startRun(deps(driver), runId);
    expect(res.outcome).toBe("started");
    // The START call: with no `execTimed` every call routes through `exec`,
    // which records no budget — the structural fallback this test names.
    expect((startCalls(driver)[0] as RecordedExec).timeoutMs).toBeUndefined();
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
      // The START call (the guard probe takes the same clamped value).
      expect((startCalls(driver)[0] as RecordedExec).timeoutMs).toBe(1);
    }
    // Non-finite never reaches the clamp: `Number.isFinite` sends it to the
    // module default, so a NaN budget is a DEFAULT budget rather than a 1 ms one.
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const driver = stubDriver(ok);
      expect(await startRun(deps(driver), runId, { timeoutMs })).toMatchObject({ outcome: "started" });
      expect((startCalls(driver)[0] as RecordedExec).timeoutMs).toBe(RUN_START_TIMEOUT_MS);
    }
    // The CEILING, which had no clamp at all. `setTimeout` stores its delay in
    // a signed 32-bit int, so a budget past the max fires in 1 ms — a caller
    // asking for a LONGER window getting the shortest one there is, and every
    // healthy box reported `box-unreachable`. Clamped, the driver is handed the
    // largest budget that actually works.
    const huge = stubDriver(ok);
    expect(await startRun(deps(huge), runId, { timeoutMs: 2_147_483_648 })).toMatchObject({ outcome: "started" });
    expect((startCalls(huge)[0] as RecordedExec).timeoutMs).toBe(2_147_483_647);
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
    //
    // B12: the fixture below is the LITERAL dispatch's `!gate.ready` arm
    // writes (dispatch.ts:3068-3078) — `{outcome:"failed", failedItem?,
    // assertionCode?, failedAt}` — and it goes through the same `store.set`
    // dispatch uses, so the store's registered gate spec admits exactly these
    // keys and a drifting producer becomes UNWRITABLE rather than silently
    // unreadable. The cross-ref test right below binds the guard's key to that
    // registry.
    store.set(runId, {
      extensions: { gate: { outcome: "failed", failedItem: "A", assertionCode: 1, failedAt: new Date().toISOString() } },
    } as never);
    const driver = stubDriver(ok);
    expect(await startRun(deps(driver), runId)).toEqual({ outcome: "run-not-startable", state: "gate-failed" });
    expect(driver.calls).toHaveLength(0);
  });

  test("the guard reads REGISTERED extension keys — the registry both producers write through", () => {
    // B12: `startRun`'s guard reads `extensions.gate.outcome` and
    // `extensions.approval.state` off the parsed record. Both producers —
    // dispatch.ts's `!gate.ready` arm for the gate, approval-gate.ts's
    // `requestApproval`/`submitDecision` for the approval — write through
    // `RunRecordStore.set`, which refuses any key `EXTENSION_NAMESPACES` does
    // not register. So a producer renaming its key cannot write through the
    // store while this guard keeps reading the old one; that binding is this
    // assertion, and with it the hand-built fixtures in this describe can only
    // drift from the producer by the producer becoming unwritable first.
    expect(Object.keys(EXTENSION_NAMESPACES.gate!.fields)).toContain("outcome");
    expect(Object.keys(EXTENSION_NAMESPACES.approval!.fields)).toContain("state");
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
    //
    // The REAL writer's arm first (B12): `requestApproval` — the producer of
    // this extension — leaves `state:"awaiting-approval"` on a bare record
    // (verbs.test.ts's `pauseRun` is the same sequence, bundle included), and
    // that record must refuse exactly like the hand-built ones below it.
    const realWriter = "qds-20260903-realgate";
    store.create(realWriter);
    writeFileSync(join(runsDir, `${realWriter}.bundle`), "harvested");
    await requestApproval({ store }, realWriter, {
      proposal: "p",
      reportId: "rv-0",
      headSha: "a".repeat(40),
    });
    const realDriver = stubDriver(ok);
    expect(await startRun(deps(realDriver), realWriter)).toEqual({
      outcome: "run-not-startable",
      state: "awaiting-approval",
    });
    expect(realDriver.calls).toHaveLength(0);
    // …then the remaining states by hand: approval-gate.ts's `submitDecision`
    // writes the terminal ones through the same registered `state` field, and
    // the store spec admits exactly the keys used here.
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

  test("an approval state off a hand-edited record is SANITIZED, never echoed raw", async () => {
    // The store's extension check is a KIND check ("string"), not a
    // printability one, so a record can carry control characters and
    // unbounded length in `approval.state`. `status.ts` runs the same field
    // through `sanitizeLabel` at the PRODUCER; this verb was the outlier
    // echoing `String(state)` raw into a value the CLI prints and logs.
    // (`beforeEach` already provisioned `runId` — re-provisioning would EEXIST.)
    store.set(runId, {
      extensions: { approval: { state: `bad\x1b[2m state ${"x".repeat(100)}`, reportId: "rv-0" } },
    } as never);
    const res = (await startRun(deps(stubDriver(ok)), runId)) as { state: string };
    expect(res.state).not.toContain("\x1b");
    // …and capped at the 64-unit bound status.ts's MAX_APPROVAL_STATE uses —
    // the ellipsis marks the truncation, so the echo is visibly bounded.
    expect(res.state.length).toBeLessThanOrEqual(64);
    expect(res.state).toEndWith("…");
  });

  test("an approval object with NO readable state is refused — `{}`, `null`, and non-string `state` alike", async () => {
    // P4: the guard is fail-closed on the OBJECT, not merely on a present
    // string state. `store.set` refuses non-string approval states itself, so
    // these malformed shapes can only arrive the way they do in production —
    // a TORN or hand-edited record FILE — and the refusal renders the literal
    // `status.ts` renders for the same malformation, never a coerced
    // `"null"`/`"[object Object]"` vocabulary word no writer minted. Written
    // straight to disk, one shape at a time, over the same record.
    const recordPath = join(runsDir, `${runId}.json`);
    expect(existsSync(recordPath)).toBe(true);
    for (const bad of [{}, { state: null }, { state: 7 }] as const) {
      const body = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
      body.extensions = { ...(body.extensions as object | undefined), approval: bad };
      writeFileSync(recordPath, JSON.stringify(body));
      const driver = stubDriver(ok);
      expect(await startRun(deps(driver), runId)).toEqual({
        outcome: "run-not-startable",
        state: "(unknown approval state)",
      });
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

  test("a refusal with NOTHING on either stream carries NO detail key — an empty message is no message", async () => {
    // The catch arm's own rule (":287 already uses `||` for the same reason"),
    // which the final return omitted: `boxText(res.stderr.trim() ||
    // res.stdout.trim())` evaluated to `""` on a driver that populates neither
    // stream — `detail: ""`, present-but-empty, on the one terminal arm whose
    // whole job is diagnosis. The key is now absent rather than empty.
    const driver = stubDriver(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    const res = await startRun(deps(driver), runId);
    expect(res).toMatchObject({ outcome: "start-failed", reason: "unit-refused", exitCode: 1 });
    expect(Object.hasOwn(res, "detail")).toBeFalse();
  });

  test("systemd's OWN 255 is classed `box-unreachable`, not a unit refusal — a NUMBER is not evidence of who produced it", async () => {
    // 137/255 are read as the TRANSPORT's statuses, purely by number, and the
    // numbers are not exclusively the transport's: `systemctl` can exit 255,
    // and a unit's own status can surface as 137. This pins the chosen reading
    // rather than leaving it to be re-argued: a NUMBER is not evidence of who
    // produced it, so the fail-safe classification is the RETRYABLE one —
    // `box-unreachable` costs one wasted round trip (and a retry is a systemd
    // no-op by AC6's unit identity), while calling a transport fault
    // `unit-refused` strands a healthy box on a terminal exit 5 that no retry
    // may clear. (The title used to assert the OPPOSITE — "is a unit refusal"
    // over a body pinning `box-unreachable`, the retryable arm — so a reader
    // scanning titles took away the inverse of the suite's one contested
    // classification call.)
    const driver = stubDriver(() => ({
      stdout: "",
      stderr: "Failed to start qds-run@x.service: Access denied\nSee system logs for details.",
      exitCode: EXEC_TRANSPORT_EXIT,
    }));
    const res = await startRun(deps(driver), runId);
    expect(res).toMatchObject({ outcome: "start-failed", reason: "box-unreachable", exitCode: EXEC_TRANSPORT_EXIT });
  });

  test("`sudo -n`'s password refusal is `unit-refused` with the SUDOERS diagnosis, not raw stderr", async () => {
    // P6: exit 1 + "a password is required" is the box's sudoers losing the
    // NOPASSWD rule the steering channel was provisioned with — the SAME exit
    // code as a systemd job failure, so the code cannot separate them and the
    // words must. Still `unit-refused` (terminal: the identical retry hits the
    // identical policy), `exitCode` kept (it IS this invocation's), and the
    // detail names the sudoers repair instead of steering the operator at
    // `AssertPathExists=`/wrong-image audits.
    const driver = stubDriver((argv) =>
      argv.includes("is-active")
        ? { stdout: "active\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "sudo: a password is required\n", exitCode: 1 },
    );
    const res = (await startRun(deps(driver), runId)) as {
      reason: string;
      exitCode?: number;
      detail?: string;
    };
    expect(res.reason).toBe("unit-refused");
    expect(res.exitCode).toBe(1);
    expect(res.detail).toContain("sudoers");
    expect(res.detail).toContain("NOPASSWD");
  });

  test("a rejection whose `message` getter THROWS stays inside the catch arm — no untyped escape", async () => {
    // P7: a hostile or null-prototype rejection object made the `.message`
    // extraction itself throw INSIDE the catch, and the escape was an untyped
    // throw out of `startRun` — the CLI's exit-1 "retry me" on a permanent
    // driver defect, the exact posture this function's docblock refuses. The
    // read is guarded; a failed extraction falls to `?? e` and the same
    // `box-unreachable` return.
    const hostile = {
      get message(): string {
        throw new Error("getter blew up");
      },
    };
    const driver = stubDriver(() => {
      throw hostile;
    });
    const res = (await startRun(deps(driver), runId)) as { reason: string; detail?: string };
    expect(res.reason).toBe("box-unreachable");
    expect(res.detail).toBeDefined();
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
    //
    // The two probes answer DIFFERENTLY, so this stays the post-fork arm now
    // that a pre-start guard exists: the guard looked (probe #1, `active` —
    // a healthy unit), the start was accepted, and the engine died AFTER the
    // fork (probe #2, `failed`). The pre-start arm has its own test below.
    let probes = 0;
    const driver = stubDriver((argv) => {
      if (argv.includes("is-active")) {
        probes += 1;
        return probes === 1
          ? { stdout: "active\n", stderr: "", exitCode: 0 }
          : { stdout: "failed\n", stderr: "", exitCode: 3 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const res = await startRun(deps(driver), runId);
    expect(res).toMatchObject({ outcome: "start-failed", reason: "unit-refused" });
    // PERMANENT, so it must not carry a transport exit code an operator would
    // read as a network fault — the start itself exited 0.
    expect((res as { exitCode?: number }).exitCode).toBeUndefined();
    expect((res as { detail?: string }).detail).toContain("died after the fork");
    expect(probes).toBe(2);
  });

  test("a unit ALREADY `failed` BEFORE the start is refused — `systemctl start` would re-run ExecStart over spent phases", async () => {
    // P3 / edge-fleet-a M2: `failed` is not a liveness question, and only an
    // ACTIVE start is a no-op — a start on a `failed` unit re-runs ExecStart,
    // forking a SECOND engine over phases whose commits and spend already
    // happened, while the CLI's remediation called the retry inert. Refused
    // BEFORE any start is issued, with NO `exitCode` (no job ran this
    // invocation — one would be `is-active`'s own exit 3 wearing the start's
    // clothes) and a detail naming the operator's `reset-failed` step.
    const driver = stubDriver((argv) =>
      argv.includes("is-active")
        ? { stdout: "failed\n", stderr: "", exitCode: 3 }
        : { stdout: "", stderr: "", exitCode: 0 },
    );
    const res = await startRun(deps(driver), runId);
    expect(res).toMatchObject({ outcome: "start-failed", reason: "unit-refused" });
    expect((res as { exitCode?: number }).exitCode).toBeUndefined();
    expect((res as { detail?: string }).detail).toContain("reset-failed");
    expect((res as { detail?: string }).detail).toContain("fleet status");
    expect(startCalls(driver)).toHaveLength(0);
    expect(driver.calls).toHaveLength(1); // the guard's probe, nothing else
  });

  test("every OTHER pre-start reading falls through to the start — the guard refuses on `failed` alone", async () => {
    // Fail-OPEN by design: `active` falls through to the no-op start AC6
    // relies on, and `inactive`/`unknown` are not evidence a start is unsafe —
    // a slow or unreadable probe must not convert a healthy start into a
    // refusal.
    for (const word of ["active", "inactive", "unknown"]) {
      const driver = stubDriver((argv) =>
        argv.includes("is-active")
          ? { stdout: `${word}\n`, stderr: "", exitCode: word === "active" ? 0 : 3 }
          : { stdout: "", stderr: "", exitCode: 0 },
      );
      const res = await startRun(deps(driver), runId);
      expect(startCalls(driver)).toHaveLength(1);
      expect(res).toMatchObject({ outcome: "started" });
    }
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

  test("the POST-START probe is handed the budget everything before it left — ONE verb budget, never two", async () => {
    // `timeoutMs` is the verb's per-call deadline and the verb makes THREE
    // sequential substrate calls: the pre-start guard, the start, and this
    // corroboration probe. The GUARD carries the full budget (a status query
    // with no systemd job behind it — no ceiling of its own), while the
    // post-start probe gets what everything before it LEFT of the one budget:
    // handing it a fresh FULL budget made the verb's worst case 2× the number
    // the caller named (250 s against a "125 s" deadline) for a verdict the
    // start had already determined — the same one-absolute-budget rule
    // `readBoxFile` and `inBoxState` apply to their own second legs.
    //
    // B15: the elapsed clock is FAKED, not slept — the old shape measured a
    // real 60 ms `setTimeout` against hand-slack margins (`< 400 - 40`), which
    // flaked on a starved runner. With `Date.now` under the test's control the
    // slice is asserted as the FORMULA: 400 − 60 spent = 340, exactly.
    const realNow = Date.now;
    let fakeNow = 1_000_000;
    let startAnswered = false;
    try {
      globalThis.Date.now = () => fakeNow;
      const driver = stubDriver((argv) => {
        if (!argv.includes("is-active")) {
          // The start "spends" 60 ms of the 400 ms budget — by advancing the
          // controlled clock the moment its answer is composed.
          fakeNow += 60;
          startAnswered = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "active\n", stderr: "", exitCode: 0 };
      });
      const res = await startRun(deps(driver), runId, { timeoutMs: 400 });
      expect(res).toMatchObject({ outcome: "started" });
      expect(startAnswered).toBe(true);
      const [guardProbe, postProbe] = probeCalls(driver) as [RecordedExec, RecordedExec];
      // The GUARD carries the full verb budget…
      expect(guardProbe.timeoutMs).toBe(400);
      // …and the corroboration gets the slice: 400 − 60 elapsed, floored at
      // 1 ms exactly as status.ts floors its own second leg — a probe killed
      // at the spawn answers `unknown`, the same fail-closed disposition as
      // not asking.
      expect(postProbe.timeoutMs).toBe(340);
    } finally {
      globalThis.Date.now = realNow;
    }
  });

  test("an accepted start whose probe gave NO reading carries the reason — the probe's failure is not dropped", async () => {
    // The start is still reported (`unknown` is not evidence of failure), but
    // silently reporting a CORROBORATED start the verb never obtained hid the
    // probe failure entirely — every other non-happy arm carries a diagnosis
    // and this one dropped its own on the floor.
    for (const probe of [
      { stdout: "", stderr: "ssh: connection closed", exitCode: EXEC_TRANSPORT_EXIT },
      { stdout: "unknown\n", stderr: "", exitCode: 4 },
    ]) {
      const driver = stubDriver((argv) =>
        argv.includes("is-active") ? probe : { stdout: "", stderr: "", exitCode: 0 },
      );
      const res = (await startRun(deps(driver), runId)) as { outcome: string; detail?: string };
      expect(res.outcome).toBe("started");
      expect(res.detail).toContain("is-active");
      expect(res.detail).toContain("fleet status");
    }
    // …and a THROWING probe is the same no-reading arm.
    const thrower = stubDriver((argv) => {
      if (argv.includes("is-active")) throw new Error("ssh died");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(((await startRun(deps(thrower), runId)) as { detail?: string }).detail).toContain("UNCORROBORATED");
    // A CORROBORATED start carries NO detail key at all: the healthy shape
    // stays byte-identical for the `toEqual` consumers that pin it above.
    for (const word of ["active", "activating", "inactive", "deactivating"]) {
      const driver = stubDriver((argv) =>
        argv.includes("is-active")
          ? { stdout: `${word}\n`, stderr: "", exitCode: 3 }
          : { stdout: "", stderr: "", exitCode: 0 },
      );
      const res = await startRun(deps(driver), runId);
      expect(Object.hasOwn(res, "detail")).toBeFalse();
    }
  });

  test("a start systemd REFUSED is never CORROBORATED — no post-start probe over a unit that never was", async () => {
    // The PRE-start guard still probes (deliberate — run.ts's module-header
    // carve-out); what must not happen is a probe AFTER a start systemd
    // refused: there is no accepted job to corroborate. Pinned by ORDER, not
    // just count: the guard's `is-active` precedes the start, and nothing
    // follows it.
    const driver = stubDriver((argv) =>
      argv.includes("is-active")
        ? { stdout: "active\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "Unit not found.", exitCode: 5 },
    );
    await startRun(deps(driver), runId);
    expect(driver.calls).toHaveLength(2);
    expect(driver.calls.findIndex((c) => c.argv.includes("start"))).toBe(1);
    expect(probeCalls(driver)).toHaveLength(1);
  });

  test("foreign text is REDACTED then capped — a cap first splits a long token past recognition", async () => {
    // The ONE arm the order is load-bearing for. `redactSecrets`'s PREFIX arm
    // survives either order (`SECRET_PREFIX_RE`'s tail is `[…]*`, so a bare
    // `sk-or-` prefix still matches), which is why a prefixed key is the wrong
    // probe here and would pass against the broken order. Its LONG-TOKEN arm
    // needs ≥40 characters: a 45-character unprefixed credential straddling the
    // 300-char cap leaves a 10-character fragment the arm can no longer see.
    // The head is padded to 290 so the token is cut at exactly that boundary.
    // (B17: the token's ≥40 length and the head's 290 are arithmetic this
    // fixture performs on itself — comments, not asserts.)
    const token = "Zq7SmvKpLd3RtYw9NxJbHc2VfGa5UeQi8OpAzXrTdWnM4";
    // SPACE-separated words, not a run of one character: ` ` is outside
    // `LONG_TOKEN_RE`'s charset, so the head cannot merge with the token into a
    // single ≥40 match that would be redacted under either order — which is
    // exactly how a first draft of this test passed against the broken one.
    const head = "word ".repeat(58); // 290 chars, so the token is cut at the cap
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

  test("an UNCORROBORATED start prints the detail as a SECOND line — and still exits 0", async () => {
    // P2: run.ts's `started` arm carries a `detail` when the post-start probe
    // produced no reading, and the CLI used to drop it — a byte-identical
    // `started:` line for a corroborated and an UNCORROBORATED start, which
    // made the run.ts arm dead code at this layer. The line stays SECOND:
    // `started:` is first so a half-lost write still names the run.
    let probes = 0;
    const driver = stubDriver((argv) => {
      if (argv.includes("is-active")) {
        probes += 1;
        // Probe #1 is the PRE-start guard — a healthy unit, so the start
        // proceeds. Probe #2 is the corroboration, which gets NO reading.
        return probes === 1
          ? { stdout: "active\n", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(await cli(["run", runId, "--driver", "stub", "--dir", runsDir], driver)).toBe(0);
    const lines = out.join("").split("\n");
    expect(lines[0]).toBe(`started: ${runId}`);
    expect(lines[1]).toContain("UNCORROBORATED");
    expect(lines[1]).toContain("fleet status");
    expect(probes).toBe(2);
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

  test("the refusal remediation covers every state arm: three known arms plus the unknown-state fallback", async () => {
    // attach's round-9 E4/B12 ruling, adopted rather than re-learned. A state
    // this build does not recognise is evidence of NOTHING, so asserting a
    // torn-down box there would be a claim, not an observation.
    //
    // The CLI's own comment calls the remediation FOUR-WAY (no-box / closed /
    // paused / terminal / unknown-fallback — the fourth arm being the point);
    // this table pins EVERY state string those arms render, because the title
    // used to say "FOUR-WAY" over a THREE-case table and the unpinned states'
    // operator guidance (approved/pausing/timed-out) could drift with no
    // failure. All three terminal states share the torn-down remediation and
    // both pause states share the approve one — the strings come from
    // `scripts/fleet.ts`'s runRun refusal arm.
    const cases: [string, string][] = [
      ["awaiting-approval", "fleet approve"],
      ["pausing", "fleet approve"],
      ["rejected", "torn down"],
      ["approved", "torn down"],
      ["timed-out", "torn down"],
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

  test("exit 5: an approval extension with NO readable state — the torn/hand-edited record arm", async () => {
    // P4's CLI half: the refusal renders the `"(unknown approval state)"`
    // literal and the dedicated remediation naming the torn or hand-edited
    // write — including the warning that `fleet status` may render this run as
    // ordinary, which is the status-vs-run disagreement the remediation exists
    // to disclose. `store.set` cannot produce the shape (it refuses non-string
    // approval states itself), so the record FILE is written by hand — the
    // production path for this malformation.
    const recordPath = join(runsDir, `${runId}.json`);
    const body = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    body.extensions = { ...(body.extensions as object | undefined), approval: {} };
    writeFileSync(recordPath, JSON.stringify(body));
    const driver = stubDriver(ok);
    expect(await cli(["run", runId, "--driver", "stub", "--dir", runsDir], driver)).toBe(5);
    expect(err.join("")).toContain("(unknown approval state)");
    expect(err.join("")).toContain("torn or hand-edited");
    expect(err.join("")).toContain("extensions.approval");
    expect(driver.calls).toHaveLength(0);
    expect(out.join("")).toBe("");
  });

  test("a silent failure renders no `(exit undefined)` and no dangling colon", async () => {
    // Both fragments are optional: a host deadline that fired has no exit
    // status, and a box that failed without a word has no stderr. Rendered
    // unconditionally they read as a lie and as truncated output.
    //
    // B11: the negative control is driven on an arm that HAS no exit status —
    // an exec that never came back, killed at the host deadline (both probes
    // and the start hang) — not on an exitCode:1 stub, which always hands the
    // renderer a number to print and made `not.toContain("undefined")`
    // vacuous. The exitCode:1 stub is kept as the POSITIVE control only: the
    // fragment renders when a status exists.
    const refused = stubDriver(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    expect(await cli(["run", runId, "--driver", "stub", "--dir", runsDir], refused)).toBe(5);
    const rendered = JSON.parse(err[0] as string) as { message: string };
    expect(rendered.message).toContain("(exit 1)");
    err.length = 0;
    // …then the no-exit arm, through the CLI's own renderer.
    const hung = stubDriver(() => new Promise<ExecResult>(() => {}));
    const code = await run(
      ["run", runId, "--driver", "stub", "--dir", runsDir],
      sinkOut,
      { store, driver: hung, runOptions: { timeoutMs: 40 } } as Partial<FleetDeps>,
      sinkErr,
    );
    expect(code).toBe(1); // box-unreachable — the one arm automation may retry
    const envelope = JSON.parse(err[0] as string) as { message: string };
    expect(envelope.message).toContain("never answered");
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
    // the wrong one. One start, plus the TWO `is-active` snapshots around it
    // (the pre-start guard and the liveness corroboration).
    expect(startCalls(driver)).toHaveLength(1);
    expect(driver.calls).toHaveLength(3);
  });
});
