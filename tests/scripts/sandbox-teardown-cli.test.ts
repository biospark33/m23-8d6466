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

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { acquireRunLock, run } from "../../scripts/sandbox-teardown.ts";

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
    expect(() => acquireRunLock(runs, "lock-unit")).toThrow("another sandbox-teardown holds");
    rmSync(first);
    expect(acquireRunLock(runs, "lock-unit")).toBe(first);
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
      expect(lines.join("")).toContain("invalid run-id");
    }
  });

  test("rejects runId with .. path traversal", async () => {
    const code = await run(["..", "--dir", runs], sink);
    expect(code).toBe(1);
    expect(lines.join("")).toContain("invalid run-id");
  });

  test("accepts valid runId format (lowercase alphanumeric with hyphens)", async () => {
    // Valid minted format: slug-date-hex like "test-20260817-abc123"
    const validId = "test-20260817-abc123";
    const code = await run([validId, "--dir", runs], sink);
    // Should fail with no-record (expected), NOT with invalid run-id
    expect(code).toBe(1);
    expect(lines.join("")).toContain("no-record");
  });

  test("rejects uppercase letters (minted IDs are lowercase only)", async () => {
    const code = await run(["Test-Run", "--dir", runs], sink);
    expect(code).toBe(1);
    expect(lines.join("")).toContain("invalid run-id");
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
