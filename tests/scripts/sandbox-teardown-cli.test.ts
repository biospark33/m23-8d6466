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
import { acquireRunLock, releaseRunLock, RunLockedError } from "../../scripts/lib/run-lock.ts";

/** The shared lock module, by absolute path, for the signal subprocess below. */
const RUN_LOCK_MODULE = join(import.meta.dir, "../../scripts/lib/run-lock.ts");

/**
 * A pid that is certainly NOT running: spawned, waited on, reaped. (There is no
 * such thing as a permanently dead pid — this is the closest a test can get,
 * and the window before the OS recycles it is the whole test.)
 */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  const { pid } = proc;
  await proc.exited;
  return pid;
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
  test("acquireRunLock is exclusive, writes pid+timestamp, and reacquires after release", () => {
    const first = acquireRunLock(runs, "lock-unit");
    expect(first).toBe(join(runs, "lock-unit.lock"));
    expect(readFileSync(first, "utf8")).toMatch(new RegExp(`^${process.pid} \\d{4}-\\d{2}-\\d{2}T`));
    // The CLASS and its code, not a prose substring: the message is
    // parameterised by holder name, and a catch block switching on `.code` is
    // what the CLIs actually do.
    expect(() => acquireRunLock(runs, "lock-unit")).toThrow(RunLockedError);
    try {
      acquireRunLock(runs, "lock-unit");
      expect.unreachable("the second acquire must refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(RunLockedError);
      expect((e as RunLockedError).code).toBe("run-locked");
    }
    releaseRunLock(first);
    expect(existsSync(first)).toBeFalse();
    expect(acquireRunLock(runs, "lock-unit")).toBe(first);
    releaseRunLock(first);
  });

  test("the refusal names the HOLDER each entry point passes (fleet vs sandbox-teardown)", () => {
    // One implementation, two operator vocabularies: `fleet` takes the default
    // ("another invocation holds"), `sandbox-teardown` passes its own name. A
    // holder argument silently ignored would print the wrong CLI to go look at.
    const fleetLock = acquireRunLock(runs, "holder-fleet");
    const teardownLock = acquireRunLock(runs, "holder-teardown", "sandbox-teardown");
    try {
      expect(() => acquireRunLock(runs, "holder-fleet")).toThrow(/another invocation holds/);
      expect(() => acquireRunLock(runs, "holder-teardown", "sandbox-teardown")).toThrow(
        /another sandbox-teardown holds/,
      );
    } finally {
      releaseRunLock(fleetLock);
      releaseRunLock(teardownLock);
    }
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
    writeFileSync(lock, `${process.pid + 1} ${new Date().toISOString()} deadbeef\n`);
    expect(() => releaseRunLock(lock)).toThrow(/refusing to release/);
    expect(existsSync(lock)).toBeTrue();
    expect(readFileSync(lock, "utf8")).toContain("deadbeef");
    rmSync(lock);
  });

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
      const reader = proc.stdout.getReader();
      let seen = "";
      while (!seen.includes("locked")) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`child exited before locking: ${await new Response(proc.stderr).text()}`);
        seen += new TextDecoder().decode(value);
      }
      expect(existsSync(lock)).toBeTrue();
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(130); // 128 + SIGINT, not a swallowed 0
      expect(proc.signalCode).toBe("SIGINT");
      expect(existsSync(lock)).toBeFalse();
    } finally {
      proc.kill("SIGKILL"); // no orphan, whatever happened above
      await proc.exited;
    }
  });

  test("a held lock fails run-locked naming pid/age and the literal rm, and mutates nothing", async () => {
    store.create("held-run");
    store.set("held-run", { vmName: "held-run-box" }); // P10: give it a vmName so teardown would do real work
    const other = process.pid + 1; // not us — the CLI must fail closed, never steal
    const lock = join(runs, "held-run.lock");
    writeFileSync(lock, `${other} ${new Date(Date.now() - 5_000).toISOString()}\n`, { flag: "wx" });

    const code = await run(["held-run", "--dir", runs], sink);

    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! run-locked:");
    expect(text).toContain(`pid ${other}`);
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

  test("empty lock body reports holder unknown", async () => {
    store.create("empty-lock");
    const lock = join(runs, "empty-lock.lock");
    writeFileSync(lock, "");

    const code = await run(["empty-lock", "--dir", runs], sink);

    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! run-locked:");
    expect(text).toContain("holder unknown");
  });

  test("a lock whose pid is dead is reported STALE, naming the pid and the rm that clears it", async () => {
    store.create("stale-lock");
    const lock = join(runs, "stale-lock.lock");
    const pid = await deadPid();
    writeFileSync(lock, `${pid} ${new Date(Date.now() - 9_000).toISOString()} c0ffee\n`, { flag: "wx" });

    const code = await run(["stale-lock", "--dir", runs], sink);

    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! run-locked:");
    expect(text).toContain(`pid ${pid} is not running`);
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
    writeFileSync(lock, `1 ${new Date(Date.now() - 3_000).toISOString()} facade\n`, { flag: "wx" });

    const code = await run(["live-lock", "--dir", runs], sink);

    expect(code).toBe(1);
    const text = lines.join("");
    expect(text).toContain("!! run-locked:");
    expect(text).toContain("pid 1");
    expect(text).not.toContain("is not running");
    expect(text).not.toContain("stale lock");
    expect(text).toContain("wait for that invocation to finish");
    expect(existsSync(lock)).toBeTrue();
  });

  test("missing runs dir propagates ENOENT from acquireRunLock", async () => {
    const missingRuns = join(dir, "no-such-runs");
    expect(() => acquireRunLock(missingRuns, "any-id")).toThrow();
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
