/**
 * Dispatch tests (Story DF3.1): TDD — tests written first, repaired to the
 * bun:test/DI idioms after the original agent draft (import reassignment is
 * impossible in Bun; seams go through DispatchDeps).
 *
 * Coverage per story DoD:
 * - requestId resolution: supplied strict UUID v4 honoured; malformed + absent both mint fresh
 * - Caller-invented runId rejected; dispatcher-minted runId accepted via opts (AC2)
 * - Malformed briefs → FleetError exit 2, ZERO side effects (INV-2)
 * - Admission: OverBudgetError → exit 5, checkHeadroom allowed:false → exit 5
 * - {admitted:true} suppresses headroom call ONLY (budget still checked)
 * - Ordering: record → box → key → fill → gate via call-order capture
 * - Cap hand-off: mintRunKey cap === admittedCeilingMicroUsd === manifest stamp === budget ext
 * - Gate failure: ready=false → FleetError exit 3, record OPEN, box NOT destroyed
 * - Ack shape asserted
 * - 600s wall clock: injected clock
 * - INV-4: no key material in logs or records
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_QUOTA_LIMITS, type LoadedQuotaLimits } from "../../src/providers/quota.ts";

/** Fresh limits — NEVER mutate DEFAULT_QUOTA_LIMITS (shared, unfrozen reference). */
function limitsWith(overrides: Partial<typeof DEFAULT_QUOTA_LIMITS>): LoadedQuotaLimits {
  return { limits: { ...DEFAULT_QUOTA_LIMITS, ...overrides }, source: "default" };
}
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import type { ProviderVm } from "../../src/providers/driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { isValidUuidV4 } from "../../src/phase-engine/issue-correlation.ts";
import { setLogSink } from "../../src/swarmclaw/log.ts";
import {
  FleetError,
  fakeGate,
  mintRunId,
  dispatch,
  type DispatchDeps,
  type LedgerLike,
} from "../../src/fleet/dispatch.ts";
import { goodLedger } from "./helpers.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "df3-1-dispatch-"));

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** A ledger whose issue is over cap (the DF2.8 refused decision shape). */
function overBudgetLedger(): LedgerLike {
  return {
    config: { defaultCapMicroUsd: 10_000_000, perIssueOverrides: {} },
    admitIssue: () => ({
      admitted: false as const,
      status: "over-budget" as const,
      reason: "spend-cap-exceeded" as const,
      capMicroUsd: 10_000_000,
      spentMicroUsd: 12_000_000,
      reservedMicroUsd: 0,
      unpricedRows: 0,
    }),
    close: () => {},
  };
}

describe("dispatch.ts (DF3.1 AC1-AC9, INV-1-INV-6, C1-C10)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  let keyApi: FakeKeyApi;
  let logs: string[] = [];
  let restoreLog: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-"));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new FakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    logs = [];
    // Capture the module's own sink (INV-4 checks)
    restoreLog = setLogSink((e) => {
      logs.push(JSON.stringify(e));
    });
  });

  afterEach(() => {
    restoreLog?.();
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── helpers ─────────────────────────────────────────────────────────────────

  function validBrief(overrides: Partial<{ requestId: string; manifestPath: string }> = {}) {
    const manifestDir = join(dir, "manifests");
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, "pipeline.json");
    const manifest = {
      version: "1.0.0",
      pipelineId: "test-pipeline",
      runBudgetMs: 200_000,
      phases: [
        { name: "plan", kind: "engineer", description: "Draft the approach for the change", maxDurationMs: 10_000, retries: 0 },
        { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    return {
      repoSlug: "owner/repo",
      issueId: 42,
      commitSha: "a".repeat(40),
      manifestPath,
      repoUrl: "https://github.com/owner/repo",
      ...overrides,
    };
  }

  function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
    return {
      driver,
      keyApi,
      store,
      ledgerFactory: () => goodLedger(),
      timeoutMs: 600_000,
      ...overrides,
    };
  }

  // ─── requestId resolution (AC2) ─────────────────────────────────────────────────────

  test("AC2: supplied strict UUID v4 is honoured", async () => {
    const requestId = "9f1754e8-1c32-4bc7-8e0d-34f39bc8e5a1";
    const brief = validBrief({ requestId });
    const result = await dispatch(brief, deps());
    expect(result.requestId).toBe(requestId);
  });

  test("AC2: malformed requestId mints fresh (never exits 2)", async () => {
    const requestId = "not-a-uuid";
    const brief = validBrief({ requestId });
    const result = await dispatch(brief, deps());
    expect(result.requestId).not.toBe(requestId);
    expect(isValidUuidV4(result.requestId)).toBeTrue();
  });

  test("AC2: absent requestId mints fresh", async () => {
    const brief = validBrief();
    const result = await dispatch(brief, deps());
    expect(result.requestId).toBeDefined();
    expect(isValidUuidV4(result.requestId)).toBeTrue();
  });

  test("AC2: caller-invented runId rejected (only mintRunId values accepted via opts)", async () => {
    const brief = validBrief();
    await expect(dispatch(brief, deps(), { runId: "invented-by-caller" })).rejects.toThrow(FleetError);
  });

  test("AC2: dispatcher-minted runId accepted via opts", async () => {
    const preMinted = mintRunId();
    const brief = validBrief();
    const result = await dispatch(brief, deps(), { runId: preMinted });
    expect(result.runId).toBe(preMinted);
  });

  test("mintRunId() re-exports newId('qds')", () => {
    const id = mintRunId();
    expect(id).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
  });

  // ─── INV-2: validate before any side effect ───────────────────────────────────────────

  test("INV-2: unknown field → FleetError exit 2, zero provisioning", async () => {
    const brief = { ...validBrief(), unknownField: "should-reject" };
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock(() =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-brief");
      expect(String(err.payload?.field)).toBe("unknownField");

      // Zero side effects
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    }
  });

  test("INV-2: missing repoSlug → FleetError exit 2, zero provisioning", async () => {
    const brief = validBrief();
    Reflect.deleteProperty(brief, "repoSlug");
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);

      expect(createSpy).not.toHaveBeenCalled();
      expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    }
  });

  test("INV-2: bad commitSha → FleetError exit 2, zero provisioning", async () => {
    const brief = { ...validBrief(), commitSha: "not-40-hex" };
    const mintSpy = mock(() =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);

      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    }
  });

  test("validate-after-mint implementation MUST fail: a rejected brief leaves zero records", async () => {
    // Negative control (story AC1): an implementation that mints first and
    // validates after produces a record for a rejected brief. Ours must not.
    const brief = { ...validBrief(), unknownField: "x" };
    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
    }
    expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
  });

  // ─── Admission: budget gate (AC7) ───────────────────────────────────────────────────

  test("AC7: OverBudgetError → FleetError exit 5 with DF2.8 fields, zero provisioning", async () => {
    const brief = validBrief();
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock(() =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps({ ledgerFactory: overBudgetLedger }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
      expect(err.payload?.capMicroUsd).toBe(10_000_000);
      expect(err.payload?.spentMicroUsd).toBe(12_000_000);

      // Zero provisioning
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    }
  });

  test("AC7: {admitted:true} still checks budget (only headroom suppressed)", async () => {
    const brief = validBrief();
    try {
      await dispatch(brief, deps({ ledgerFactory: overBudgetLedger }), { admitted: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
    }
  });

  // ─── Admission: headroom gate (AC8) ───────────────────────────────────────────────

  test("AC8: checkHeadroom allowed:false → FleetError exit 5, zero provisioning", async () => {
    const brief = validBrief();
    const listSpy = mock(() =>
      Promise.resolve([
        { name: "box1", status: "running" },
        { name: "box2", status: "running" },
        { name: "box3", status: "running" },
      ] as ProviderVm[]),
    );
    driver.list = listSpy;

    const loaded = limitsWith({ maxVms: 3 }); // 3 live == ceiling → headroom 0

    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;

    try {
      await dispatch(brief, deps({ quotaLimits: loaded }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-headroom");
      expect(createSpy).not.toHaveBeenCalled();
      expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    }
  });

  test("AC8: checkHeadroom list-unverified → FleetError exit 5", async () => {
    const brief = validBrief();
    // driver.list throws → checkHeadroom reports list-unverified (fail-closed)
    driver.list = mock(() => Promise.reject(new Error("list timeout")));

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-headroom");
      expect(err.payload?.reason).toBe("list-unverified");
    }
  });

  test("AC8: {admitted:true} suppresses the headroom call (a saturated fleet still dispatches)", async () => {
    const brief = validBrief();
    // Ceiling 0 with 0 live VMs: only passable if the headroom call is SKIPPED
    const loaded = limitsWith({ maxVms: 0 });

    const listSpy = mock(() => Promise.resolve([] as ProviderVm[]));
    driver.list = listSpy;

    const result = await dispatch(brief, deps({ quotaLimits: loaded }), { admitted: true });
    expect(result.runId).toBeDefined();
    // the one list call the store/gate path makes is NOT a headroom admission:
    // with maxVms=0 any real checkHeadroom(1) would have refused
    expect(listSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  // ─── INV-1 ordering: record → box → key → fill → gate ─────────────────────────────────

  test("INV-1: ordering asserted via call-order capture", async () => {
    const brief = validBrief();
    const callOrder: string[] = [];

    const originalCreate = store.create.bind(store);
    store.create = (runId: string) => {
      callOrder.push("store.create");
      return originalCreate(runId);
    };

    const originalDriverCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      callOrder.push("driver.create");
      return originalDriverCreate(name, tag);
    };

    const originalMint = keyApi.createKey.bind(keyApi);
    keyApi.createKey = async (name: string, limit: number) => {
      callOrder.push("mint");
      return originalMint(name, limit);
    };

    const originalExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      if (argv[0] === "sh") callOrder.push("sh-exec"); // deliver + fill both ride sh -c
      return originalExec(vm, argv, stdin);
    };

    await dispatch(
      brief,
      deps({
        setupGate: async (drv, vm, o) => {
          callOrder.push("gate");
          return fakeGate(drv, vm, o);
        },
      }),
    );

    // Subsequence: record < box < mint < first sh-exec (deliver/fill) < gate.
    // Containment asserted first — indexOf's -1 would otherwise satisfy any
    // comparison for a call that never happened.
    const expectInOrder = (calls: string[], ...names: string[]): void => {
      for (const name of names) expect(calls).toContain(name);
      for (let i = 1; i < names.length; i++) {
        expect(calls.indexOf(names[i - 1] as string)).toBeLessThan(calls.indexOf(names[i] as string));
      }
    };
    expectInOrder(callOrder, "store.create", "driver.create", "mint", "sh-exec", "gate");
  });

  // ─── Cap hand-off (AC9) ─────────────────────────────────────────────────────────

  test("AC9: mintRunKey receives cap === admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    const admittedCeiling = 25_000_000; // half of the DF2.3 default
    const originalMint = keyApi.createKey.bind(keyApi);
    const mintSpy = mock((name: string, limit: number) => originalMint(name, limit));
    keyApi.createKey = mintSpy;

    await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    expect(mintSpy).toHaveBeenCalled();
    const limitArg = mintSpy.mock.calls[0]?.[1] as number;
    expect(limitArg).toBe(admittedCeiling / 1_000_000); // µ$ → USD at the HTTP boundary
  });

  test("AC9a: manifest stamped with limitMicroUsd = admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    const admittedCeiling = 30_000_000;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    const record = store.get(result.runId);
    const filled = await driver.exec(record.vmName as string, ["cat", "pipeline.yaml"]);
    const limitLine = filled.stdout.split("\n").find((l) => l.startsWith("limitMicroUsd:"));
    expect(limitLine).toBeDefined();
    expect(limitLine).toContain("30000000");
  });

  test("AC9b: budget extension carries effectiveCeilingMicros = admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    const admittedCeiling = 20_000_000;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    const record = store.get(result.runId);
    expect(record.extensions?.budget?.admittedCeilingMicroUsd).toBe(admittedCeiling);

    // The run context handed to the box carries the same computed-once value
    const ctxFile = await driver.exec(record.vmName as string, ["cat", "run-context.json"]);
    const ctx = JSON.parse(ctxFile.stdout) as { effectiveCeilingMicros?: number };
    expect(ctx.effectiveCeilingMicros).toBe(admittedCeiling);
  });

  // ─── Gate failure (AC3, INV-5) ─────────────────────────────────────────────────────

  test("AC3: gate ready=false → FleetError exit 3, record OPEN, box alive", async () => {
    const brief = validBrief();

    try {
      await dispatch(
        brief,
        deps({
          setupGate: async () => ({
            ready: false,
            failedItem: "A" as const,
            assertionCode: 1 as const,
            assertions: [{ item: "A" as const, ok: false, note: "HEAD mismatch" }],
            debugCommands: ["ssh box.exe.xyz cat /tmp/provision"],
            teardownCommand: "bun scripts/fleet.ts teardown the-run",
            vm: "test-box",
          }),
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      expect(err.payload?.assertionCode).toBe(1);
      expect(err.payload?.failedItem).toBe("A");

      // Record OPEN (no closedAt) and the failure recorded host-side
      const record = store.get(err.payload?.runId as string);
      expect(record.closedAt).toBeUndefined();

      // Box NOT destroyed
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
    }
  });

  // ─── Ack shape (AC2) ─────────────────────────────────────────────────────────────

  test("Ack shape {runId, requestId, state: 'ready', vmName, httpsUrl?}", async () => {
    const brief = validBrief();
    const result = await dispatch(brief, deps());

    expect(result).toMatchObject({
      runId: expect.stringMatching(/^qds-/),
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      state: "ready",
      vmName: expect.stringMatching(/^qds-/),
    });
    // httpsUrl is optional on the fake substrate without a port
    if (result.httpsUrl !== undefined) {
      expect(result.httpsUrl).toMatch(/^https:\/\//);
    }
  });

  // ─── 600s wall clock timeout ───────────────────────────────────────────────────────

  test("600s wall clock: expiry throws FleetError exit 1, box alive", async () => {
    const brief = validBrief();

    try {
      await dispatch(
        brief,
        deps({ clock: () => Date.now() + 601_000, timeoutMs: 600_000 }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-timeout");

      // Box left alive (INV-5 posture: teardown is the operator's call)
      const boxes = await driver.list();
      expect(boxes.length).toBeGreaterThan(0);
    }
  });

  // ─── INV-4: no key material in logs or records ───────────────────────────────────────

  test("INV-4: no key material in log lines", async () => {
    const brief = validBrief();
    keyApi.createKey = async () => ({
      key: "sk-or-known-key-material-12345",
      hash: "abc123",
      limitUsd: 50,
      usageUsd: 0,
    });

    await dispatch(brief, deps());

    expect(logs.some((l) => l.includes("sk-or-known-key-material"))).toBeFalse();
  });

  test("INV-4: no key material in record write", async () => {
    const brief = validBrief();
    const knownKey = "sk-test-known-key-99999";
    keyApi.createKey = async () => ({
      key: knownKey,
      hash: "deadbeef",
      limitUsd: 50,
      usageUsd: 0,
    });

    const result = await dispatch(brief, deps());
    const record = store.get(result.runId);

    // keyHash present, plaintext absent
    expect(record.keyHash).toBe("deadbeef");
    expect(JSON.stringify(record)).not.toContain(knownKey);
  });
});
