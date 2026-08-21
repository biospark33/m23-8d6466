/**
 * DF3.1 Agent C: verbs + status unit tests.
 *
 * MODULE 1 (verbs.ts):
 * - listVerbs() returns exactly 4 entries with exact shapes
 * - renderHelp() generates usage from registry
 *
 * MODULE 2 (status.ts):
 * - Pure join logic tests (state derivation with injected fake list results)
 * - statusAll timeout behavior
 * - statusRun validation and ENOENT handling
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listVerbs, renderHelp, type VerbEntry, type VerbFlag } from "../../src/fleet/verbs.ts";
import { statusAll, statusRun, type StatusRow, type StatusDeps } from "../../src/fleet/status.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";

describe("verbs.ts", () => {
  test("listVerbs returns exactly 4 entries", () => {
    const verbs = listVerbs();
    expect(verbs).toHaveLength(4);
    const verbNames = verbs.map((v) => v.verb);
    expect(verbNames).toContain("dispatch");
    expect(verbNames).toContain("status");
    expect(verbNames).toContain("harvest");
    expect(verbNames).toContain("teardown");
  });

  test("each verb has exact shape with no extra keys", () => {
    const verbs = listVerbs();
    for (const v of verbs) {
      // Exact keys: verb, summary, flags, exitCodes
      const keys = Object.keys(v).sort();
      expect(keys).toEqual(["exitCodes", "flags", "summary", "verb"]);

      // Verb is a non-empty string
      expect(typeof v.verb).toBe("string");
      expect(v.verb.length).toBeGreaterThan(0);

      // Summary is a non-empty string
      expect(typeof v.summary).toBe("string");
      expect(v.summary.length).toBeGreaterThan(0);

      // Flags is an array
      expect(Array.isArray(v.flags)).toBe(true);

      // Each flag has exact shape: {name, required, valueType}
      for (const flag of v.flags) {
        const flagKeys = Object.keys(flag).sort();
        expect(flagKeys).toEqual(["name", "required", "valueType"]);
        expect(typeof flag.name).toBe("string");
        expect(typeof flag.required).toBe("boolean");
        expect(["string", "path", "boolean"]).toContain(flag.valueType);
      }

      // Exit codes is an array of numbers
      expect(Array.isArray(v.exitCodes)).toBe(true);
      for (const code of v.exitCodes) {
        expect(typeof code).toBe("number");
        // Every exitCode within 0-5
        expect(code).toBeGreaterThanOrEqual(0);
        expect(code).toBeLessThanOrEqual(5);
      }
    }
  });

  test("dispatch verb has correct flags and exit codes", () => {
    const dispatch = listVerbs().find((v) => v.verb === "dispatch");
    expect(dispatch).toBeDefined();

    // Flags: --driver(string,optional), --brief(path,optional), --dir(path,optional)
    expect(dispatch!.flags).toHaveLength(3);

    const driverFlag = dispatch!.flags.find((f) => f.name === "--driver");
    expect(driverFlag).toBeDefined();
    expect(driverFlag!.valueType).toBe("string");
    expect(driverFlag!.required).toBe(false);

    const briefFlag = dispatch!.flags.find((f) => f.name === "--brief");
    expect(briefFlag).toBeDefined();
    expect(briefFlag!.valueType).toBe("path");
    expect(briefFlag!.required).toBe(false);

    const dirFlag = dispatch!.flags.find((f) => f.name === "--dir");
    expect(dirFlag).toBeDefined();
    expect(dirFlag!.valueType).toBe("path");
    expect(dirFlag!.required).toBe(false);

    // Exit codes: [0,1,2,3,5]
    expect(dispatch!.exitCodes).toEqual([0, 1, 2, 3, 5]);
  });

  test("status verb has correct flags and exit codes", () => {
    const status = listVerbs().find((v) => v.verb === "status");
    expect(status).toBeDefined();

    // Flags: [--driver]
    expect(status!.flags).toHaveLength(1);
    expect(status!.flags[0]!.name).toBe("--driver");
    expect(status!.flags[0]!.valueType).toBe("string");
    expect(status!.flags[0]!.required).toBe(false);

    // Exit codes: [0,1,4]
    expect(status!.exitCodes).toEqual([0, 1, 4]);
  });

  test("harvest verb has correct flags and exit codes", () => {
    const harvest = listVerbs().find((v) => v.verb === "harvest");
    expect(harvest).toBeDefined();

    // Flags: [--driver, --dir]
    expect(harvest!.flags).toHaveLength(2);
    expect(harvest!.flags.some((f) => f.name === "--driver")).toBe(true);
    expect(harvest!.flags.some((f) => f.name === "--dir")).toBe(true);

    // Exit codes: [0,1,4]
    expect(harvest!.exitCodes).toEqual([0, 1, 4]);
  });

  test("teardown verb has correct flags and exit codes", () => {
    const teardown = listVerbs().find((v) => v.verb === "teardown");
    expect(teardown).toBeDefined();

    // Flags: [--driver, --dir, --no-harvest]
    expect(teardown!.flags).toHaveLength(3);
    expect(teardown!.flags.some((f) => f.name === "--driver")).toBe(true);
    expect(teardown!.flags.some((f) => f.name === "--dir")).toBe(true);

    const noHarvest = teardown!.flags.find((f) => f.name === "--no-harvest");
    expect(noHarvest).toBeDefined();
    expect(noHarvest!.valueType).toBe("boolean");
    expect(noHarvest!.required).toBe(false);

    // Exit codes: [0,1,4]
    expect(teardown!.exitCodes).toEqual([0, 1, 4]);
  });

  test("verbs are unique", () => {
    const verbs = listVerbs();
    const verbNames = verbs.map((v) => v.verb);
    const uniqueNames = new Set(verbNames);
    expect(uniqueNames.size).toBe(verbNames.length);
  });

  test("renderHelp generates usage from registry", () => {
    const help = renderHelp(listVerbs());
    expect(typeof help).toBe("string");
    expect(help.length).toBeGreaterThan(0);

    // Should contain each verb name
    expect(help).toContain("dispatch");
    expect(help).toContain("status");
    expect(help).toContain("harvest");
    expect(help).toContain("teardown");

    // Should contain some usage text
    expect(help).toMatch(/Usage:|usage:|FLAGS/i);
  });
});

describe("status.ts (pure join logic)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-status-"));
    driver = new FakeDriver(dir);
    store = new RunRecordStore({ dir });
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("statusAll: closedAt → state 'closed'", async () => {
    const runId = "test-closed-run";
    store.create(runId);
    store.set(runId, { vmName: "test-vm" });
    store.close(runId);

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("closed");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("statusAll: open + vmName unset → boxMissing", async () => {
    const runId = "test-no-vm";
    store.create(runId);
    // No vmName set

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxMissing");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("statusAll: open + listOk + vm in set → live", async () => {
    const runId = "test-live-run";
    store.create(runId);
    const vmName = `qds-${runId.slice(0, 63)}`.slice(0, 63);
    store.set(runId, { vmName });

    // Create corresponding box
    await driver.create(vmName);

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    expect(rows[0]!.runId).toBe(runId);
    expect(rows[0]!.vmName).toBe(vmName);
  });

  test("statusAll: open + listOk + vm NOT in set → boxMissing", async () => {
    const runId = "test-missing-box";
    store.create(runId);
    const vmName = `qds-${runId.slice(0, 63)}`.slice(0, 63);
    store.set(runId, { vmName });

    // DON'T create the box

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxMissing");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("statusAll: open + !listOk (timeout) → boxUnknown", async () => {
    const runId = "test-unknown";
    store.create(runId);
    const vmName = `qds-${runId.slice(0, 63)}`.slice(0, 63);
    store.set(runId, { vmName });

    // Mock driver.list to timeout
    const slowDriver = new FakeDriver(dir);
    slowDriver.list = async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return [];
    };

    const deps: StatusDeps = { driver: slowDriver, store, listTimeoutMs: 100 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxUnknown");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("statusAll: open + !listOk (throw) → boxUnknown", async () => {
    const runId = "test-throw";
    store.create(runId);
    const vmName = `qds-${runId.slice(0, 63)}`.slice(0, 63);
    store.set(runId, { vmName });

    // Mock driver.list to throw
    const throwingDriver = new FakeDriver(dir);
    throwingDriver.list = async () => {
      throw new Error("driver list failed");
    };

    const deps: StatusDeps = { driver: throwingDriver, store, listTimeoutMs: 1000 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxUnknown");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("statusAll: newest-first order by createdAt desc", async () => {
    const now = new Date();
    const run1 = "test-older";
    const run2 = "test-newer";

    store.create(run1, new Date(now.getTime() - 1000));
    store.create(run2, now);

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.runId).toBe(run2); // newer first
    expect(rows[1]!.runId).toBe(run1);
  });

  test("statusAll: empty fleet → empty array, exit 0", async () => {
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(0);
  });

  test("statusAll: row includes spend/limit when present", async () => {
    const runId = "test-costs";
    store.create(runId);
    store.set(runId, {
      spendMicroUsd: 123456,
      limitMicroUsd: 500000,
      vmName: `qds-${runId.slice(0, 63)}`.slice(0, 63),
    });
    await driver.create(store.get(runId).vmName!);

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.spendMicroUsd).toBe(123456);
    expect(rows[0]!.limitMicroUsd).toBe(500000);
  });

  test("statusAll: row includes optional fields from record", async () => {
    const runId = "test-optional";
    store.create(runId);
    const vmName = `qds-${runId.slice(0, 63)}`.slice(0, 63);
    const httpsUrl = `https://${vmName}.fake`;
    store.set(runId, { vmName, httpsUrl });
    await driver.create(vmName);

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const rows = await statusAll(deps);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.vmName).toBe(vmName);
    expect(rows[0]!.httpsUrl).toBe(httpsUrl);
  });
});

describe("status.ts (statusRun)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-status-run-"));
    driver = new FakeDriver(dir);
    store = new RunRecordStore({ dir });
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("statusRun: valid runId returns single row", async () => {
    const runId = "test-single-run";
    store.create(runId);
    const vmName = `qds-${runId.slice(0, 63)}`.slice(0, 63);
    store.set(runId, { vmName });
    await driver.create(vmName);

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const row = await statusRun(deps, runId);

    expect(row.runId).toBe(runId);
    expect(row.state).toBe("live");
  });

  test("statusRun: runId validation rejects bad format", async () => {
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };

    // Invalid runId formats
    await expect(statusRun(deps, "INVALID_ID")).rejects.toThrow();
    await expect(statusRun(deps, "with spaces")).rejects.toThrow();
    await expect(statusRun(deps, "../escape")).rejects.toThrow();
  });

  test("statusRun: ENOENT → typed error exit 4", async () => {
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };

    try {
      await statusRun(deps, "nonexistent-run");
      expect(false).toBe(true); // Should have thrown
    } catch (e) {
      expect(e).toHaveProperty("exitCode", 4);
      expect(e).toHaveProperty("code", "run-not-found");
      expect(e).toHaveProperty("message");
      expect(e).toHaveProperty("remediation");
    }
  });

  test("statusRun: found record uses same join logic", async () => {
    const runId = "test-join-logic";
    store.create(runId);
    // No box created → should be boxMissing or boxUnknown depending on list

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const row = await statusRun(deps, runId);

    expect(row.runId).toBe(runId);
    // No vmName set → boxMissing
    expect(row.state).toBe("boxMissing");
  });

  test("statusRun: record closed → closed state, no driver call", async () => {
    const runId = "test-closed-single";
    store.create(runId);
    store.close(runId);

    // Don't create any box
    const listSpy = mock(() => Promise.resolve([]));
    driver.list = listSpy;

    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    const row = await statusRun(deps, runId);

    expect(row.state).toBe("closed");
    expect(row.runId).toBe(runId);
    // driver.list should NOT be called for closed records
    expect(listSpy).not.toHaveBeenCalled();
  });
});
