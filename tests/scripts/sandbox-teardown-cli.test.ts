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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // the refused invocation neither tore down nor released the holder's lock
    expect(store.get("held-run").closedAt).toBeUndefined();
    expect(existsSync(lock)).toBeTrue();
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
