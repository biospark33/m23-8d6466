/**
 * Runtime tests for the sandbox-teardown CLI's operator-safety behaviors that
 * live in run() itself, not the providers (DF2.5 review round 4): the per-run
 * `<runId>.lock` (one teardown per run at the operator surface) and the
 * no-record vs record-read-failed split.
 *
 * Drives run() in-process against the fake driver. Every case here fails
 * BEFORE dispatch (lock held, provisioning key missing, unreadable record), so
 * no git repo is touched and no box is destroyed — the harvest/teardown flows
 * themselves are covered by tests/providers/teardown.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunRecordStore, RUN_ID_MAX, RUN_ID_RE } from "../../src/providers/run-record.ts";
import { run } from "../../scripts/sandbox-teardown.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, RunLockReentrantError } from "../../scripts/lib/run-lock.ts";

/** The shared lock module, by absolute path, for the signal subprocess below. */
const RUN_LOCK_MODULE = join(import.meta.dir, "../../scripts/lib/run-lock.ts");

/**
 * A pid that is certainly NOT running. Above PID_MAX on every platform this
 * runs on, so `kill(pid, 0)` is ESRCH by construction. The previous fixture
 * spawned and reaped a real process, which races the OS recycling that pid onto
 * a live one before the test reads it back — the "reported STALE" assertion
 * then fails on entirely correct behaviour. Six digits is not enough: Linux's
 * default pid_max is 4194304.
 */
const DEAD_PID = 999_999_999;

/**
 * A pid that is certainly running and is certainly not us. pid 1 exists on
 * every POSIX host; `kill(1, 0)` from a normal user raises EPERM, which the
 * liveness probe reads (correctly) as alive.
 */
const LIVE_FOREIGN_PID = 1;

/**
 * This host as the lock body spells it (run-lock.ts's `lockHost`), OBSERVED from
 * a real lock the module writes rather than recomputed here. `lockHost` folds the
 * `/proc/self/ns/pid` inode into the token wherever the kernel exposes it and
 * nothing where it does not, so a fixture re-deriving it from `hostname()` alone
 * matches on macOS and silently stops matching on Linux — where it would take the
 * "liveness unknown from here" branch, which is the exact branch every test below
 * exists to tell apart from the local one. Neither `lockHost` nor `hostTag` is
 * exported; a body naming any other host never reaches the pid probe at all.
 */
function lockHostOf(runsDir: string): string {
  const lock = acquireRunLock(runsDir, "host-probe");
  try {
    return readFileSync(lock, "utf8").trim().split(/\s+/)[1] ?? "";
  } finally {
    releaseRunLock(lock);
  }
}

/** The same token folded to the filename-safe form lock temps carry (`hostTag`). */
function hostTagOf(runsDir: string): string {
  return lockHostOf(runsDir).replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Drain `stream` until `needle` appears, or fail with the child's stderr. */
async function readUntil(proc: Bun.Subprocess<"pipe", "pipe", "pipe">, needle: string): Promise<void> {
  const reader = proc.stdout.getReader();
  try {
    let seen = "";
    while (!seen.includes(needle)) {
      const { value, done } = await reader.read();
      // A partial write, an import error, a throwing acquire: `value` is
      // undefined and `decode(undefined)` is "", so a single read() reports
      // `expected "" to contain "locked"` and never surfaces the stderr that
      // was piped precisely for this.
      if (done) throw new Error(`child exited before "${needle}": ${await new Response(proc.stderr).text()}`);
      seen += new TextDecoder().decode(value);
    }
  } finally {
    reader.releaseLock();
  }
}

let dir: string;
let runs: string;
let store: RunRecordStore;
const lines: string[] = [];
const sink = (s: string) => lines.push(s);
/** Env vars overridden per-test, restored verbatim in afterEach. */
const savedEnv: Array<[string, string | undefined]> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df25-cli-"));
  runs = join(dir, "runs");
  store = new RunRecordStore(runs);
  lines.length = 0;
  // run() resolves a driver before it reads the record; keep the fake driver's
  // boxes dir hermetic even though no case here ever dispatches.
  for (const [k, v] of [
    ["QDS_PROVIDER_DRIVER", "fake"],
    ["QDS_FAKE_BOXES_DIR", join(dir, "boxes")],
    ["OPENROUTER_PROVISIONING_KEY", undefined],
  ] as const) {
    savedEnv.push([k, process.env[k]]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterEach(() => {
  for (const [k, v] of savedEnv.splice(0)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("sandbox-teardown run() — the per-run operator lock", () => {
  /** A foreign holder's body at `lock` — contention, without a second process. */
  function foreignLock(runId: string, pid = 1): string {
    const lock = join(runs, `${runId}.lock`);
    writeFileSync(lock, `${pid} ${new Date().toISOString()} feedface\n`, { flag: "wx" });
    return lock;
  }

  test("acquireRunLock is exclusive, writes pid+host+timestamp, and reacquires after release", () => {
    const first = acquireRunLock(runs, "lock-unit");
    expect(first).toBe(join(runs, "lock-unit.lock"));
    // The host field is what makes the pid meaningful: `kill(pid, 0)` answers
    // about THIS host's process table, and a shared runs directory makes that
    // answer about a stranger.
    expect(readFileSync(first, "utf8")).toMatch(new RegExp(`^${process.pid} \\S+ \\d{4}-\\d{2}-\\d{2}T`));
    // The CLASS and its code, not a prose substring: the message is
    // parameterised by holder name, and a catch block switching on `.code` is
    // what the CLIs actually do.
    const lock = foreignLock("exclusive-unit");
    expect(() => acquireRunLock(runs, "exclusive-unit")).toThrow(RunLockedError);
    try {
      acquireRunLock(runs, "exclusive-unit");
      expect.unreachable("the second acquire must refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(RunLockedError);
      expect((e as RunLockedError).code).toBe("run-locked");
    }
    rmSync(lock);
    releaseRunLock(first);
    expect(existsSync(first)).toBeFalse();
    expect(acquireRunLock(runs, "lock-unit")).toBe(first);
    releaseRunLock(first);
  });

  test("a SECOND acquire in the same process is a distinct error, not advice to wait for ourselves", () => {
    // The lock is not re-entrant. Reported as contention it read "another
    // invocation holds … (pid <self>)" — telling the operator to wait for the
    // process printing the message, or to rm a lock it is actively using.
    const lock = acquireRunLock(runs, "reentrant-unit");
    try {
      expect(() => acquireRunLock(runs, "reentrant-unit")).toThrow(RunLockReentrantError);
      try {
        acquireRunLock(runs, "reentrant-unit");
        expect.unreachable("the re-acquire must refuse");
      } catch (e) {
        expect((e as RunLockReentrantError).code).toBe("run-lock-reentrant");
        expect((e as Error).message).toContain("this process already holds");
      }
    } finally {
      releaseRunLock(lock);
    }
  });

  test("a lock body written before the host field still parses, and is FOREIGN rather than stale", () => {
    // `<pid> <ISO> <nonce>` is what the previous implementation wrote. Two
    // properties, and the second is the one that bites: the lock must still name
    // its holder rather than degrade to "holder unknown" (that wording tells the
    // operator the file is garbage), AND it must never be called stale. An old
    // body carries no host, so `kill(pid, 0)` here answers about whatever process
    // happens to hold that number on THIS box — back-compat that probed it anyway
    // quietly opted every pre-host lock out of the host guard and printed `rm` for
    // a live remote holder, which is the double teardown the guard was added for.
    foreignLock("legacy-body");
    try {
      acquireRunLock(runs, "legacy-body");
      expect.unreachable("a held lock must still refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(RunLockedError);
      expect((e as Error).message).toMatch(
        /pid 1 from a lock written before the host field existed, liveness unknown from here, held \d+s/,
      );
      // The remediation is the half an operator acts on, and "unknown liveness"
      // and "provably dead" produce refusals that read almost identically.
      expect((e as RunLockedError).remediation).not.toContain("stale lock");
      expect((e as RunLockedError).remediation).toContain("wait for that invocation to finish");
    }
  });

  test("a lock held on ANOTHER host is never called stale (its pid is not ours to probe)", () => {
    // `kill(pid, 0)` is host-local. On a shared runs directory (NFS, a mounted
    // volume, a CI runner beside a laptop) probing our own process table for a
    // foreign pid answers about a stranger — and a false "not running" makes
    // the CLI actively instruct the operator to rm a LIVE holder's lock.
    const lock = join(runs, "other-host.lock");
    writeFileSync(lock, `4711 some-other-box ${new Date(Date.now() - 7_000).toISOString()} c0ffee\n`, { flag: "wx" });
    try {
      acquireRunLock(runs, "other-host");
      expect.unreachable("a foreign host's lock must still refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(RunLockedError);
      expect((e as Error).message).toContain("pid 4711 on host some-other-box");
      expect((e as Error).message).toContain("liveness unknown from here");
      expect((e as RunLockedError).remediation).not.toContain("stale lock");
    }
  });

  test("the refusal names the HOLDER each entry point passes (fleet vs sandbox-teardown)", () => {
    // One implementation, two operator vocabularies: `fleet` takes the default
    // ("another invocation holds"), `sandbox-teardown` passes its own name. A
    // holder argument silently ignored would print the wrong CLI to go look at.
    foreignLock("holder-fleet");
    foreignLock("holder-teardown");
    expect(() => acquireRunLock(runs, "holder-fleet")).toThrow(/another invocation holds/);
    expect(() => acquireRunLock(runs, "holder-teardown", "sandbox-teardown")).toThrow(/another sandbox-teardown holds/);
  });

  test("a stale `<runId>.lock.<hostTag>.<pid>.<hex>.tmp` is reaped on acquire; a live pid's temp is left alone", () => {
    // Nothing else removes these: a process SIGKILLed between the temp's
    // creation and its unlink leaves one forever, in the same directory the
    // record and bundle listings glob over.
    const tag = hostTagOf(runs);
    const stale = join(runs, `reap-run.lock.${tag}.${DEAD_PID}.deadbeef.tmp`);
    const live = join(runs, `reap-run.lock.${tag}.${process.pid}.c0ffee.tmp`);
    const otherRun = join(runs, `other-run.lock.${tag}.${DEAD_PID}.abc123.tmp`);
    // A dead pid on a DIFFERENT host. The pid is only meaningful on the box that
    // minted it, so probing our own process table for it reads a live remote
    // invocation as dead — and this sweep would then delete its in-flight temp
    // between the `fsync` and the `linkSync`, freeing the run for a second
    // holder. The host tag in the name is the whole defence; a sweep that
    // ignored it passes every other assertion here.
    const otherHost = join(runs, `reap-run.lock.some-other-box.${DEAD_PID}.abc123.tmp`);
    // The pre-host-tag filename shape. Deliberately NOT this module's to reap —
    // it carries no host, so it is exactly as unprobeable as the line above.
    // `RunRecordStore.cleanStaleTemps` still sweeps it on the next CLI start.
    const legacyShape = join(runs, `reap-run.lock.${DEAD_PID}.deadbeef.tmp`);
    for (const p of [stale, live, otherRun, otherHost, legacyShape]) writeFileSync(p, "x\n");

    releaseRunLock(acquireRunLock(runs, "reap-run"));

    expect(existsSync(stale)).toBeFalse();
    expect(existsSync(live)).toBeTrue(); // mid-acquire, not litter
    expect(existsSync(otherRun)).toBeTrue(); // a different run's temp is not ours to reap
    expect(existsSync(otherHost)).toBeTrue(); // a different host's pid is not ours to probe
    expect(existsSync(legacyShape)).toBeTrue(); // unqualified pid — left for the store's sweep
    for (const p of [live, otherRun, otherHost, legacyShape]) rmSync(p);
  });

  test("a `.rescue` body left by a failed restore is NEVER reaped, however dead its pid", () => {
    // `releaseRunLock` parks a body it took but does not own at
    // `<runId>.lock.<pid>.<hex>.rescue` and tells the operator to `mv` it back.
    // While that file used the `.tmp` shape, it was the only copy of a LIVE
    // holder's claim sitting in a directory two reapers sweep by dead pid — this
    // acquire's own `reapStaleTemps`, and `RunRecordStore`'s `cleanStaleTemps`,
    // which runs before the lock is even taken. Our pid is dead by the time an
    // operator reads the remediation, so both would have collected it and the
    // next invocation would acquire a run its real holder still owns.
    const rescue = join(runs, `rescue-run.lock.${DEAD_PID}.deadbeef.rescue`);
    const litter = join(runs, `rescue-run.lock.${DEAD_PID}.deadbeef.tmp`);
    for (const p of [rescue, litter]) writeFileSync(p, "someone else's claim\n");

    // A second store construction is what a later CLI invocation does first.
    new RunRecordStore(runs);
    releaseRunLock(acquireRunLock(runs, "rescue-run"));

    expect(existsSync(rescue)).toBeTrue();
    expect(existsSync(litter)).toBeFalse(); // our own abandoned copy is still litter
    expect(readFileSync(rescue, "utf8")).toContain("someone else's claim");
    rmSync(rescue);
  });

  test("the lock is released when the guarded operation throws, and the run is lockable again", () => {
    // A teardown that throws mid-flight leaving `<runId>.lock` on disk makes
    // that run permanently un-teardownable — the release belongs in a finally,
    // not on the success path.
    const guarded = (): void => {
      const lock = acquireRunLock(runs, "throwing-op");
      try {
        throw new Error("boom");
      } finally {
        releaseRunLock(lock);
      }
    };
    expect(guarded).toThrow("boom");
    expect(existsSync(join(runs, "throwing-op.lock"))).toBeFalse();
    const again = acquireRunLock(runs, "throwing-op");
    releaseRunLock(again);
  });

  test("releaseRunLock refuses to unlink a lock this process no longer owns", () => {
    // Ours was cleared by hand and re-taken by a live invocation: an
    // unconditional `rm` here deletes THEIR lock and re-opens the exact
    // double-teardown window the lock exists to close.
    const lock = acquireRunLock(runs, "foreign-lock");
    // A LIVE foreign holder, which is what the scenario in the comment above
    // describes; `process.pid + 1` left it a coin flip whether the "re-taken by
    // a live invocation" premise held at all.
    writeFileSync(lock, `${LIVE_FOREIGN_PID} ${new Date().toISOString()} deadbeef\n`);
    expect(() => releaseRunLock(lock)).toThrow(/refusing to release/);
    expect(existsSync(lock)).toBeTrue();
    expect(readFileSync(lock, "utf8")).toContain("deadbeef");
    // The release READS first and throws on the mismatch (run-lock.ts's
    // `before !== body` guard) — it never reaches the `rename`, so the foreign
    // claim is left exactly where it is rather than taken and put back. That
    // distinction is the fix: a take-then-compare release emptied the path for
    // a third contender while the restore raced it. Assert the claim is still
    // enforced, which is what an empty or missing file here would break.
    expect(() => acquireRunLock(runs, "foreign-lock")).toThrow(RunLockedError);
    rmSync(lock);
  });

  test("a lock cleared by hand and re-acquired by a LIVE process survives our release", async () => {
    // The double-teardown scenario end to end, with a real second holder rather
    // than a hand-written body: the remediation text tells an operator to `rm`
    // a lock they believe is stale, a second invocation legitimately takes the
    // freed path, and the first invocation then reaches its own release. If
    // that release unlinks by path, the live holder loses its lock mid-teardown
    // and a third invocation walks straight into the same run.
    //
    // This case stops at the READ: `releaseRunLock` compares the on-disk body
    // before it touches the path, sees the child's claim, and throws without
    // renaming. The second comparison (rename, re-read, `restore`) guards a
    // strictly narrower window — the lock being re-claimed between our own read
    // and our own rename — and no test can open it: the two calls are
    // synchronous and adjacent, with no seam to interleave on. That branch is
    // reachable only under fault injection, which is why nothing here asserts
    // on it.
    const runId = "handoff-run";
    const lock = join(runs, `${runId}.lock`);
    const ours = acquireRunLock(runs, runId);

    // The operator's `rm`, then a live second holder claims the freed path.
    rmSync(lock);
    const child = join(dir, "handoff-child.ts");
    writeFileSync(
      child,
      [
        `import { acquireRunLock } from ${JSON.stringify(RUN_LOCK_MODULE)};`,
        "const [runsDir, runId] = process.argv.slice(2);",
        "acquireRunLock(runsDir, runId);",
        'process.stdout.write("locked\\n");',
        "process.stdin.resume(); // hold it for the duration of the test",
      ].join("\n"),
    );
    const holder = Bun.spawn(["bun", child, runs, runId], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      // Drained until the readiness line, never a single chunk: a child that
      // died before locking would otherwise leave `readFileSync(lock)` reading
      // the body THIS process wrote, quietly inverting what the release
      // assertions below prove.
      await readUntil(holder, "locked");
      const theirs = readFileSync(lock, "utf8");
      expect(theirs).toContain(String(holder.pid));

      // Our release must refuse, leave THEIR bytes at the path, and leave the
      // run locked against everyone else.
      expect(() => releaseRunLock(ours)).toThrow(/refusing to release/);
      expect(readFileSync(lock, "utf8")).toBe(theirs);
      expect(() => acquireRunLock(runs, runId)).toThrow(RunLockedError);
    } finally {
      holder.kill();
      await holder.exited;
      rmSync(lock, { force: true });
    }
  }, 15_000);

  test("SIGINT releases the lock and the process still dies of the signal (exit 130)", async () => {
    // One Ctrl-C during teardown used to leave the lock on disk forever: every
    // later harvest/teardown of that run refused while the box and the key
    // stayed live and billing.
    const child = join(dir, "sigint-child.ts");
    writeFileSync(
      child,
      [
        `import { acquireRunLock } from ${JSON.stringify(RUN_LOCK_MODULE)};`,
        "const [runsDir, runId] = process.argv.slice(2);",
        "acquireRunLock(runsDir, runId);",
        'process.stdout.write("locked\\n");',
        "process.stdin.resume(); // stay alive for the signal — no timer, no sleep",
      ].join("\n"),
    );
    const lock = join(runs, "sigint-run.lock");
    const proc = Bun.spawn(["bun", child, runs, "sigint-run"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // Wait on the child's own readiness line, never on the clock.
      await readUntil(proc, "locked");
      expect(existsSync(lock)).toBeTrue();
      proc.kill("SIGINT");
      await proc.exited;
      // `signalCode` is the portable half of the contract and the property this
      // test exists to protect: the handler releases and then RE-RAISES, so the
      // process still dies of the signal. Pinning `exited === 130` alongside it
      // pins Bun's coercion of a signal-terminated child instead — under POSIX
      // semantics that same correct child reports exitCode null, and a Bun
      // upgrade turning this red invites "fixing" it with `process.exit(130)`,
      // which is exactly the swallowed-signal behaviour being guarded against.
      expect(proc.signalCode).toBe("SIGINT");
      expect(proc.exitCode === null || proc.exitCode === 130).toBeTrue(); // never a swallowed 0
      expect(existsSync(lock)).toBeFalse();
    } finally {
      proc.kill("SIGKILL"); // no orphan, whatever happened above
      await proc.exited;
    }
  });

  test("SIGTERM releases the lock too, and still dies of the signal", async () => {
    // SIGINT has its own test above; SIGTERM is the one `kill`, a supervisor and
    // a CI cancellation actually send, and it strands the lock in exactly the
    // same way — the handler list, not just its first entry, is the contract.
    const child = join(dir, "sigterm-child.ts");
    writeFileSync(
      child,
      [
        `import { acquireRunLock } from ${JSON.stringify(RUN_LOCK_MODULE)};`,
        "const [runsDir, runId] = process.argv.slice(2);",
        "acquireRunLock(runsDir, runId);",
        'process.stdout.write("locked\\n");',
        "process.stdin.resume();",
      ].join("\n"),
    );
    const lock = join(runs, "sigterm-run.lock");
    const proc = Bun.spawn(["bun", child, runs, "sigterm-run"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      await readUntil(proc, "locked");
      expect(existsSync(lock)).toBeTrue();
      proc.kill("SIGTERM");
      await proc.exited;
      expect(proc.signalCode).toBe("SIGTERM");
      expect(proc.exitCode === null || proc.exitCode === 143).toBeTrue(); // never a swallowed 0
      expect(existsSync(lock)).toBeFalse();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });

  test("a plain process.exit() while the lock is held still releases it", async () => {
    // The signal handlers only cover signals. An `exit(N)` reached with the lock
    // held — a guard clause, an uncaught throw, an unhandled rejection — took
    // none of them, and since this module never steals and a live-pid body is
    // never stale, that run was refused against every later verb with no
    // automated way back. The exit code must survive the release unchanged.
    const child = join(dir, "exit-child.ts");
    writeFileSync(
      child,
      [
        `import { acquireRunLock } from ${JSON.stringify(RUN_LOCK_MODULE)};`,
        "const [runsDir, runId] = process.argv.slice(2);",
        "acquireRunLock(runsDir, runId);",
        "process.exit(7); // no release in sight — the handler is the only thing standing between this and a wedged run",
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", child, runs, "exit-run"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    expect(proc.exitCode).toBe(7);
    expect(existsSync(join(runs, "exit-run.lock"))).toBeFalse();
  });

  test("a held lock fails run-locked naming pid/age and the literal rm, and mutates nothing", async () => {
    store.create("held-run");
    store.set("held-run", { vmName: "held-run-box" }); // P10: give it a vmName so teardown would do real work
    // Alive and not us — the CLI must fail closed, never steal. `process.pid + 1`
    // was a coin flip on whether the holder was live at all, so the test could
    // silently become the stale-lock case it has its own test for.
    const other = LIVE_FOREIGN_PID;
    const lock = join(runs, "held-run.lock");
    // `<pid> <host> <ISO> <nonce>` — the modern four-field body `claim` actually
    // writes, naming THIS host. A pre-host fixture parses fine but classifies
    // FOREIGN, so it never reaches the pid probe and this case would stop being
    // about a live holder at all.
    writeFileSync(lock, `${other} ${lockHostOf(runs)} ${new Date(Date.now() - 5_000).toISOString()} feedface\n`, {
      flag: "wx",
    });

    const code = await run(["held-run", "--dir", runs], sink);

    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! run-locked:");
    // Delimited, not `toContain("pid 1")`: that substring is inside `pid 12345`
    // too, so a refusal printing some pid other than the HOLDER's reads as correct.
    expect(text).toMatch(new RegExp(`pid ${other}, held \\d+s`));
    // The live branch's remediation, never the stale one: a liveness probe that
    // answered "dead" here prints `rm` for a lock a running teardown holds.
    expect(text).toContain("wait for that invocation to finish");
    expect(text).not.toContain("stale lock");
    expect(text).toContain("next: ");
    expect(text).toContain(`rm ${lock}`);
    // P10: the refused invocation neither tore down nor released the holder's lock
    expect(store.get("held-run").closedAt).toBeUndefined();
    expect(existsSync(lock)).toBeTrue();
    // P10: record is still open (not closed by refused invocation)
    expect(store.get("held-run").closedAt).toBeUndefined();
  });

  test("the lock is released after a failed dispatch (keyed run, no provisioning key)", async () => {
    store.create("keyed-run");
    store.set("keyed-run", { keyHash: "sha256-digest-shaped-holder" });
    const code = await run(["keyed-run", "--dir", runs], sink);
    expect(code).toBe(1);
    expect(lines.join("")).toContain("provisioning-key-missing");
    expect(existsSync(join(runs, "keyed-run.lock"))).toBeFalse();
    expect(store.get("keyed-run").closedAt).toBeUndefined();
  });
});

describe("sandbox-teardown run() — record-read failure classification", () => {
  test("genuine absence (ENOENT) stays no-record with the create-the-run remediation", async () => {
    const code = await run(["no-such-run", "--dir", runs], sink);
    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! no-record:");
    expect(text).toContain("ENOENT");
    expect(text).toContain("create the run first");
  });

  test("a corrupt record is record-read-failed and never told to re-create the run", async () => {
    writeFileSync(join(runs, "corrupt-run.json"), "{ not json\n");
    const code = await run(["corrupt-run", "--dir", runs], sink);
    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! record-read-failed:");
    expect(text).toContain("malformed run record");
    // a live box + live key may sit behind a corrupt record: inspection, not
    // re-creation
    expect(text).toContain("inspect");
    expect(text).not.toContain("create the run first");
  });
});

describe("sandbox-teardown run() — runId path-injection guard (P2)", () => {
  test("rejects runId containing path separator characters", async () => {
    const badIds = ["../../etc/passwd", "foo/bar", "foo\\bar", "foo/../bar"];
    for (const badId of badIds) {
      lines.length = 0;
      const code = await run([badId, "--dir", runs], sink);
      expect(code).toBe(1);
      expect(lines.join("")).toContain("invalid run id");
    }
  });

  test("rejects runId with .. path traversal", async () => {
    const code = await run(["..", "--dir", runs], sink);
    expect(code).toBe(1);
    expect(lines.join("")).toContain("invalid run id");
  });

  test("accepts valid runId format (lowercase alphanumeric with hyphens)", async () => {
    // Valid minted format: slug-date-hex like "test-20260817-abc123"
    const validId = "test-20260817-abc123";
    const code = await run([validId, "--dir", runs], sink);
    // Should fail with no-record (expected), NOT with invalid run id
    expect(code).toBe(1);
    expect(lines.join("")).toContain("no-record");
  });

  test("rejects uppercase letters (minted IDs are lowercase only)", async () => {
    const code = await run(["Test-Run", "--dir", runs], sink);
    expect(code).toBe(1);
    expect(lines.join("")).toContain("invalid run id");
  });

  test("rejects a TRAILING HYPHEN, naming the grammar that rejected it", async () => {
    // The id becomes a box name and then an RFC 1123 hostname label, where a
    // trailing hyphen is illegal — the whole reason the store's pattern
    // tightened. The CLI defers to `assertValidRunId`, so the refusal must
    // print the store's grammar rather than a restated copy of it.
    const code = await run(["trailing-hyphen-", "--dir", runs], sink);
    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain('invalid run id: "trailing-hyphen-"');
    expect(text).toContain(RUN_ID_RE.source);
    expect(text).toContain(String(RUN_ID_MAX));
  });

  test("a legal id with interior hyphens still passes the guard (the tightening did not over-reject)", async () => {
    const code = await run(["ok-20260817-abc123", "--dir", runs], sink);
    expect(code).toBe(1);
    // Reached the record read — rejected for absence, not for its shape.
    expect(lines.join("")).toContain("no-record");
    expect(lines.join("")).not.toContain("invalid run id");
  });

  test(`rejects an id longer than RUN_ID_MAX (${RUN_ID_MAX}) instead of letting it reach the store as a path error`, async () => {
    const tooLong = "a".repeat(RUN_ID_MAX + 1);
    const code = await run([tooLong, "--dir", runs], sink);
    expect(code).toBe(1);
    expect(lines.join("")).toContain("invalid run id");
    expect(lines.join("")).not.toContain("ENAMETOOLONG");
    // The boundary itself is legal: a cap that refused 63 would refuse real ids.
    lines.length = 0;
    expect(await run(["a".repeat(RUN_ID_MAX), "--dir", runs], sink)).toBe(1);
    expect(lines.join("")).toContain("no-record");
  });
});

describe("sandbox-teardown run() — lock edge cases (P5)", () => {
  test("malformed lock body reports holder unknown", async () => {
    store.create("malformed-lock");
    const lock = join(runs, "malformed-lock.lock");
    writeFileSync(lock, "not a pid at all\n");

    const code = await run(["malformed-lock", "--dir", runs], sink);

    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! run-locked:");
    expect(text).toContain("holder unknown");
  });

  test("empty lock body names the creator that died mid-create and gives the rm, not 'holder unknown'", async () => {
    // "holder unknown" is now reserved for a body that PARSED as garbage and for
    // a lock we could not read at all. An empty body has exactly one cause —
    // `writeLockDirect`'s creator SIGKILLed between the exclusive create and the
    // write — and reporting it as an unknown holder made it a lock to WAIT on:
    // nothing steals, nothing expires, and `reapStaleTemps` matches only `.tmp`,
    // so the run refused forever while the box and the key kept billing.
    store.create("empty-lock");
    const lock = join(runs, "empty-lock.lock");
    writeFileSync(lock, "");

    const code = await run(["empty-lock", "--dir", runs], sink);

    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! run-locked:");
    expect(text).toContain("the lock is empty: its creator died between creating it and writing its body");
    expect(text).not.toContain("holder unknown");
    // Stale, so the operator gets a way out — plus the caveat that stops them
    // racing a harvest that started a moment ago.
    expect(text).toContain(`rm ${lock} to clear the stale lock`);
    expect(text).toContain("wait and re-check first");
    // Reported, never stolen.
    expect(existsSync(lock)).toBeTrue();
    expect(store.get("empty-lock").closedAt).toBeUndefined();
  });

  test("a lock whose pid is dead is reported STALE, naming the pid and the rm that clears it", async () => {
    store.create("stale-lock");
    const lock = join(runs, "stale-lock.lock");
    // Same-host body: a lock naming any other host (or none, as a pre-host body
    // does) is foreign and is correctly never marked stale, so a fixture without
    // the host token tests the opposite branch from the one this title claims.
    writeFileSync(lock, `${DEAD_PID} ${lockHostOf(runs)} ${new Date(Date.now() - 9_000).toISOString()} c0ffee\n`, {
      flag: "wx",
    });

    const code = await run(["stale-lock", "--dir", runs], sink);

    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! run-locked:");
    expect(text).toContain(`pid ${DEAD_PID} is not running`);
    expect(text).toContain(`rm ${lock} to clear the stale lock`);
    // Reported, never stolen: the refusal leaves the file and the record alone.
    expect(existsSync(lock)).toBeTrue();
    expect(store.get("stale-lock").closedAt).toBeUndefined();
  });

  test("a lock held by a LIVE unrelated pid is never reported stale (pid reuse is not a licence to rm)", async () => {
    // pid 1 is alive and is certainly not a teardown of this run — the wording
    // an operator follows ("rm the stale lock") must not appear for it.
    store.create("live-lock");
    const lock = join(runs, "live-lock.lock");
    // Same-host body, for the same reason as the stale case above — inverted: a
    // foreign lock is never stale no matter what the pid is doing, so without the
    // host token the "never reported stale" assertions below hold vacuously.
    writeFileSync(lock, `${LIVE_FOREIGN_PID} ${lockHostOf(runs)} ${new Date(Date.now() - 3_000).toISOString()} facade\n`, {
      flag: "wx",
    });

    const code = await run(["live-lock", "--dir", runs], sink);

    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! run-locked:");
    // Delimited: `toContain("pid 1")` is satisfied by `pid 12345` / `pid 1000`,
    // so a refusal naming a pid this CLI had lying around rather than the
    // HOLDER's would read as correct.
    expect(text).toMatch(new RegExp(`pid ${LIVE_FOREIGN_PID}, held \\d+s`));
    expect(text).not.toContain("is not running");
    expect(text).not.toContain("stale lock");
    expect(text).toContain("wait for that invocation to finish");
    expect(existsSync(lock)).toBeTrue();
  });

  test("a LIVE pid holding the lock for days is diagnosed as possible pid reuse, not silently trusted", () => {
    // After a SIGKILL the OS can recycle the holder's pid onto an unrelated
    // process. `kill(pid, 0)` then reads that stranger as the holder, `stale`
    // stays false, and the remediation ("wait for that invocation to finish")
    // points at a process the operator waits on forever. No steal and no TTL —
    // the no-steal property is load-bearing — so the DIAGNOSIS is what has to
    // improve, using the createdAt the body already carries.
    const createdAt = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const lock = join(runs, "ancient-lock.lock");
    writeFileSync(lock, `${LIVE_FOREIGN_PID} ${lockHostOf(runs)} ${createdAt} c0ffee\n`, { flag: "wx" });
    try {
      acquireRunLock(runs, "ancient-lock");
      expect.unreachable("a held lock must still refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(RunLockedError);
      // Still a refusal, still not stale: the fix is honesty, never a steal.
      expect((e as RunLockedError).remediation).not.toContain("stale lock");
      expect((e as RunLockedError).remediation).toContain("wait for that invocation to finish");
      // ...plus the part an operator can act on: the implausible hold, the pid
      // to check, and the timestamp that settles whether it is the holder.
      expect((e as RunLockedError).remediation).toContain("recycled");
      expect((e as RunLockedError).remediation).toContain(`ps -p ${LIVE_FOREIGN_PID}`);
      expect((e as RunLockedError).remediation).toContain(createdAt);
    }
    rmSync(lock);
  });

  test("a live pid holding the lock for seconds gets NO pid-reuse advice (the note is not boilerplate)", () => {
    // The ordinary contention case is the common one. Telling every operator
    // their holder might be a recycled pid would train them to ignore the line
    // that matters — and to `rm` a live invocation's lock.
    const lock = join(runs, "fresh-lock.lock");
    writeFileSync(lock, `${LIVE_FOREIGN_PID} ${lockHostOf(runs)} ${new Date().toISOString()} c0ffee\n`, { flag: "wx" });
    try {
      acquireRunLock(runs, "fresh-lock");
      expect.unreachable("a held lock must still refuse");
    } catch (e) {
      expect((e as RunLockedError).remediation).not.toContain("recycled");
    }
    rmSync(lock);
  });

  test("dead vs live on the SAME host differ in the remediation, not just the message", () => {
    // The two branches share `another … holds <lock> (pid N…)` and diverge only
    // in what the operator is told to DO — one prints the `rm`, the other says
    // wait. A liveness probe stubbed to a constant still produces a plausible
    // refusal either way, so a test that only greps the message passes with the
    // probe gutted in either direction. Both fixtures use the four-field
    // `<pid> <host> <ISO> <nonce>` body `claim` writes, on THIS host, so the pid
    // probe is actually reached.
    const host = lockHostOf(runs);
    const at = new Date(Date.now() - 4_000).toISOString();
    const refusalFor = (runId: string, pid: number): RunLockedError => {
      writeFileSync(join(runs, `${runId}.lock`), `${pid} ${host} ${at} c0ffee\n`, { flag: "wx" });
      try {
        acquireRunLock(runs, runId);
        return expect.unreachable("a held lock must refuse");
      } catch (e) {
        expect(e).toBeInstanceOf(RunLockedError);
        return e as RunLockedError;
      }
    };

    const dead = refusalFor("branch-dead", DEAD_PID);
    const live = refusalFor("branch-live", LIVE_FOREIGN_PID);

    expect(dead.remediation).toContain(`rm ${join(runs, "branch-dead.lock")} to clear the stale lock`);
    expect(dead.remediation).not.toContain("wait for that invocation to finish");
    expect(live.remediation).toContain("wait for that invocation to finish");
    expect(live.remediation).not.toContain("stale lock");
  });

  test("missing runs dir propagates ENOENT from acquireRunLock", async () => {
    const missingRuns = join(dir, "no-such-runs");
    // Not a bare `.toThrow()`: an invalid-run-id refusal, a RunLockedError or a
    // TypeError from a signature change all satisfy that, while the name here
    // claims ENOENT. A refactor turning a missing runs dir into a silent
    // `mkdir -p` — masking a misconfigured `--dir` and writing locks nowhere
    // useful — must fail this, not merely need some other reason to throw.
    expect(() => acquireRunLock(missingRuns, "any-id")).toThrow(/ENOENT/);
    try {
      acquireRunLock(missingRuns, "any-id");
      expect(false).toBeTrue(); // should not reach here
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      expect(err.code).toBe("ENOENT");
    }
  });
});

describe("sandbox-teardown run() — lock release after TeardownError mid-teardown (P6)", () => {
  test("lock is released after a failure deep inside teardown (probe step)", async () => {
    // The keyed-run test above proves release on provisioning-key-missing
    // (post-lock, pre-mutation). This one fails DEEPER: a record with a vmName
    // runs the git-bundle-verify probe inside teardownSandbox, and a PATH
    // holding only a failing `git` stub makes the probe exit non-zero — the
    // lock's finally must still release and the record must stay open. (An
    // EMPTY PATH is no good: posix_spawnp falls back to the system default
    // path and the real git is found again.)
    const stubDir = join(dir, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    store.create("probe-fail");
    store.set("probe-fail", { vmName: "probe-fail-box" });
    const savedPath = process.env.PATH;
    process.env.PATH = stubDir;
    try {
      const code = await run(["probe-fail", "--dir", runs], sink);
      expect(code).toBe(1);
      const text = lines.join("");
      expect(text).toContain("!! bundle-verify-unavailable:");
    } finally {
      process.env.PATH = savedPath;
    }
    expect(existsSync(join(runs, "probe-fail.lock"))).toBeFalse();
    expect(store.get("probe-fail").closedAt).toBeUndefined();
  });
});

describe("sandbox-teardown run() — lock release failure never masks the primary result", () => {
  test("a release failure after a deep teardown error is its own diagnostic, exit code untouched", async () => {
    // Same deep-failure shape as the P6 test (failing `git` stub →
    // bundle-verify-unavailable), but the stub ALSO strips write permission
    // from the runs dir, so the finally's rmSync(lock) fails EACCES. Before
    // the round-10 guard, that throw replaced the reported teardown failure;
    // now both diagnostics surface and the exit code reflects the teardown.
    // (chmod by ABSOLUTE path — PATH holds only the stub dir.)
    const stubDir = join(dir, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "git"), `#!/bin/sh\n/bin/chmod 555 ${runs}\nexit 1\n`, { mode: 0o755 });
    store.create("release-fail");
    store.set("release-fail", { vmName: "release-fail-box" });
    const savedPath = process.env.PATH;
    process.env.PATH = stubDir;
    try {
      const code = await run(["release-fail", "--dir", runs], sink);
      expect(code).toBe(1); // the teardown failed — the cleanup failure must not change that
      const text = lines.join("");
      expect(text).toContain("!! bundle-verify-unavailable:"); // primary failure survives
      expect(text).toContain("!! lock-release-failed:"); // cleanup failure reported separately
      expect(text).toContain("next: ");
      expect(existsSync(join(runs, "release-fail.lock"))).toBeTrue(); // release really failed
      expect(store.get("release-fail").closedAt).toBeUndefined();
    } finally {
      process.env.PATH = savedPath;
      chmodSync(runs, 0o755); // afterEach sweeps dir — restore write permission first
    }
  });
});
