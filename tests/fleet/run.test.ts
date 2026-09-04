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

import { RUN_START_TIMEOUT_MS, runUnitName, startRun, type StartRunDeps } from "../../src/fleet/run.ts";
import { listVerbs } from "../../src/fleet/verbs.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { provisionAdmittedRun, type ExecResult, type ProviderDriver } from "../../src/providers/driver.ts";
import { EXEC_KILLED_EXIT, EXEC_TRANSPORT_EXIT } from "../../src/providers/exedev/transport.ts";
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

const ok = (): ExecResult => ({ stdout: "", stderr: "", exitCode: 0 });

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
    // The WHOLE argv, exact. A substring check on "systemctl" would pass for
    // `systemctl start --wait`, `systemctl enable`, and a start of the wrong
    // instance — the three shapes the next three tests exist to refuse.
    expect(driver.calls.map((c) => c.argv)).toEqual([
      ["sudo", "-n", "systemctl", "start", `qds-run@${runId}.service`],
    ]);
    expect(driver.calls[0]!.vm).toBe(vm);
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

  test("ONE exec, and nothing that waits on the engine: no marker read, no status poll", async () => {
    // AC1's "returns without holding the run" is not a timing claim a unit test
    // can make honestly — it is a claim about what the verb DOES. A host that
    // held the run would have to observe completion, and the only two ways to
    // observe it are polling the marker or polling the unit's state. Both are
    // execs, so "exactly one exec, and it is the start" is the assertion.
    const driver = stubDriver(ok);
    await startRun(deps(driver), runId);
    expect(driver.calls).toHaveLength(1);
    const argv = driver.calls[0]!.argv.join(" ");
    for (const holding of ["is-active", "is-failed", "journalctl", "final.json", "cat", "sh -c"]) {
      expect(argv).not.toContain(holding);
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

  test("%i is QUOTED wherever the unit's ExecStart exists (the runId-charset contract)", () => {
    // DF2.10 ships the template with NO ExecStart — leaf 1.2.3 adds the single
    // contracted line. Conditional on purpose: green today, and a real
    // assertion the moment that line lands, without this file having to be
    // edited by the leaf that lands it. `run %i` unquoted splits an instance
    // name on whitespace; `run "%i"` is the banked patch's form.
    const unit = readFileSync(UNIT_FILE, "utf8");
    const execStart = unit.split("\n").find((l) => l.startsWith("ExecStart="));
    if (execStart !== undefined) {
      expect(execStart).toContain('"%i"');
    }
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
    expect(driver.calls[1]!.argv).toEqual(driver.calls[0]!.argv);
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
    const MANAGER_DEFAULT_START_MS = 90_000;
    expect(RUN_START_TIMEOUT_MS).toBeGreaterThan(MANAGER_DEFAULT_START_MS);
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

  // ── refusals that touch nothing ───────────────────────────────────────────

  test("a run with no box is refused before any exec", async () => {
    const bare = "qds-20260903-cc22dd";
    store.create(bare);
    const driver = stubDriver(ok);
    expect(await startRun(deps(driver), bare)).toEqual({ outcome: "run-not-startable", state: "no-box" });
    expect(driver.calls).toHaveLength(0);
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
    const driver = stubDriver(() => ({ stdout: "", stderr: "x".repeat(50_000), exitCode: 1 }));
    const res = (await startRun(deps(driver), runId)) as { detail?: string };
    expect(res.detail!.length).toBeLessThanOrEqual(300);
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
    // the wrong one.
    expect(driver.calls).toHaveLength(1);
  });
});
