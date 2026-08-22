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
 * - Admission hand-off: the issue/run/estimate admitIssue was asked, ledger closed
 * - Ordering: record → box → key → fill → gate via call-order capture
 * - Cap hand-off: mintRunKey cap === admittedCeilingMicroUsd === manifest stamp === budget ext
 * - Gate failure: ready=false → FleetError exit 3, record OPEN, box NOT destroyed,
 *   gate outcome on the record, keyHash persisted (the key stays revocable)
 * - Ack shape asserted, and asserted to carry no key material
 * - 600s wall clock: injected ADVANCING clock, expiry and just-under boundary
 * - Public exposure happens only after the gate passes
 * - INV-4: no key material in logs, records or the ack
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as YAML from "yaml";

import { DEFAULT_QUOTA_LIMITS, type LoadedQuotaLimits } from "../../src/providers/quota.ts";

/** Fresh limits — NEVER mutate DEFAULT_QUOTA_LIMITS (shared, unfrozen reference). */
function limitsWith(overrides: Partial<typeof DEFAULT_QUOTA_LIMITS>): LoadedQuotaLimits {
  return { limits: { ...DEFAULT_QUOTA_LIMITS, ...overrides }, source: "default" };
}
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import type { ProviderVm } from "../../src/providers/driver.ts";
import { defaultKeyCapMicroUsd } from "../../src/providers/credentials.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";
import { statusRun } from "../../src/fleet/status.ts";
import {
  FleetError,
  fakeGate,
  mintRunId,
  dispatch,
  type DispatchDeps,
} from "../../src/fleet/dispatch.ts";
import { goodLedger, overBudgetLedger } from "./helpers.ts";

/**
 * UUID v4, spelled out here rather than imported from the implementation's own
 * `isValidUuidV4`: a predicate loosened in `src/` would otherwise loosen the
 * test that is supposed to catch it, and the two would degrade together.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The dispatch wall-clock ceiling `DispatchDeps.timeoutMs` defaults to. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Fixtures stay in `os.tmpdir()` and the containment root is INJECTED
 * (`deps.repoRoot`, defaulting to `process.cwd()`): nothing here writes into the
 * repo working tree, and no test mutates a process-global every other test file
 * in the run shares. `realpathSync` because macOS resolves `/var` →
 * `/private/var` — the containment check compares resolved paths, so an
 * unresolved fixture path makes the behaviour platform-dependent.
 */
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "df3-1-dispatch-")));

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * A clock that starts at a fixed instant and only moves when a test moves it.
 *
 * `() => Date.now() + 601_000` is inert: dispatch takes its wall-clock BASELINE
 * from the same seam, so a constant offset reads as zero elapsed. Expiry is
 * only reachable by a clock that ADVANCES between the baseline and the check.
 */
function stepClock(): { clock: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return {
    clock: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("dispatch.ts (DF3.1 AC1-AC9, INV-1-INV-6, C1-C10)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  let keyApi: FakeKeyApi;
  let logs: string[] = [];
  let entries: LogEntry[] = [];
  let restoreLog: (() => void) | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpRoot, "run-")));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new FakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    logs = [];
    entries = [];
    // Capture the module's own sink (INV-4 checks)
    restoreLog = setLogSink((e) => {
      entries.push(e);
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

  /**
   * `repoRoot` is the test's own temp dir, so the manifest-containment check has
   * a real root to enforce without anyone touching `process.cwd()`.
   *
   * `timeoutMs` is deliberately NOT injected: the production default is what
   * every test then exercises, so a changed default fails the clock tests
   * instead of passing invisibly behind an injected 600_000.
   */
  function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
    return {
      driver,
      keyApi,
      store,
      ledgerFactory: () => goodLedger(),
      repoRoot: dir,
      ...overrides,
    };
  }

  /** The refusal log lines this dispatch emitted (`refuse`'s own contract). */
  function refusalLines(): LogEntry[] {
    return entries.filter((e) => e.operation === "fleet.dispatch" && e.phase === "refused");
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
    expect(result.requestId).toMatch(UUID_V4_RE);
  });

  test("AC2: absent requestId mints fresh", async () => {
    const brief = validBrief();
    const result = await dispatch(brief, deps());
    expect(result.requestId).toBeDefined();
    expect(result.requestId).toMatch(UUID_V4_RE);
  });

  test("AC2: caller-invented runId rejected (only mintRunId values accepted via opts)", async () => {
    const brief = validBrief();
    try {
      // @ts-expect-error AC2: a caller-invented id is not a MintedRunId — the brand
      // refuses it at compile time; this asserts the runtime guard still refuses a cast.
      await dispatch(brief, deps(), { runId: "invented-by-caller" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      // Not just "a FleetError": every later refusal is one too, and this test
      // is about the provenance guard specifically.
      expect(err.code).toBe("run-id-not-minted");
      expect(err.exitCode).toBe(2);
    }
    // Nothing was provisioned under the forged id.
    expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
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

  test("INV-4-bis: requestId is persisted on the record and surfaces on the status row", async () => {
    const requestId = "3c9f0b21-7a44-4d0e-b8b1-6f0c2e5a7d13";
    const result = await dispatch(validBrief({ requestId }), deps());

    expect(store.get(result.runId).requestId).toBe(requestId);

    // `fleet status` is the operator's only inspection surface — the join key
    // has to reach it, not just the record file.
    const row = await statusRun({ driver, store }, result.runId);
    expect(row.requestId).toBe(requestId);
    expect(row.state).toBe("live");
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

  test("INV-2: a rejected brief never opens the ledger — no admission is spent", async () => {
    // The money-path half of INV-2, distinct from the record/box/key assertions
    // above: an implementation that admits first and validates after books the
    // issue's cap for a brief it then refuses, and the reservation outlives the
    // refusal (only a priced cost_event retires it).
    const brief = { ...validBrief(), unknownField: "x" };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      expect((e as FleetError).exitCode).toBe(2);
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
  });

  test("a refusal that fires before the run id exists logs runId: null", async () => {
    const brief = { ...validBrief(), unknownField: "x" };

    await expect(dispatch(brief, deps())).rejects.toThrow(FleetError);

    const refusals = refusalLines();
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0] as LogEntry;
    // `null`, not undefined and not "" — the absence is named, never fabricated.
    expect(refusal.runId).toBeNull();
    expect(refusal.requestId).toBe("unresolved");
    expect(refusal.status).toBe("error");
    expect((refusal.error as { code: string }).code).toBe("invalid-brief");
  });

  // ─── Refusals that fire before an admission is spent (INV-2) ────────────────────────

  /**
   * A manifest at `escapePath` — beneath `tmpRoot`, so outside both the test's
   * own `repoRoot` (`dir`) and `process.cwd()`. Byte-identical to the valid
   * fixture: the refusal must be the containment check, never a schema
   * complaint that would pass for the wrong reason.
   */
  function briefWithManifestOutsideRoot() {
    const brief = validBrief();
    const escapePath = join(mkdtempSync(join(tmpRoot, "escape-")), "pipeline.json");
    copyFileSync(brief.manifestPath, escapePath);
    return { ...brief, manifestPath: escapePath };
  }

  test("INV-2: a manifest outside the supplied repoRoot → exit 2 manifest-rejected, zero provisioning", async () => {
    // The root is the injected one, not the manifest's own directory: a root
    // derived from the candidate path makes every path its own root and the
    // beneath-root assertion vacuous. The seam must not have widened the guard.
    const brief = briefWithManifestOutsideRoot();
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("manifest-rejected");
      // The refusal names the root it enforced — the injected one, not cwd.
      expect(err.remediation).toContain(dir);
      expect(err.remediation).not.toContain(process.cwd());
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: with no repoRoot supplied the default root still refuses an outside manifest", async () => {
    // The fallback is `process.cwd()`. Covered here so the default cannot rot
    // behind the injected root every other test uses — and asserted WITHOUT
    // mutating the process's cwd, which is shared by every other test file.
    const brief = briefWithManifestOutsideRoot();

    try {
      await dispatch(brief, deps({ repoRoot: undefined }));
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("manifest-rejected");
      expect((e as FleetError).remediation).toContain(process.cwd());
    }
    expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: a non-positive timeoutMs → exit 2 timeout-invalid, zero provisioning", async () => {
    // A ceiling nothing can satisfy must refuse at the boundary, not mid-run.
    try {
      await dispatch(validBrief(), deps({ timeoutMs: 0 }));
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("timeout-invalid");
    }
    expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: a port outside 1..65535 → exit 2 port-invalid, zero provisioning", async () => {
    try {
      await dispatch(validBrief(), deps({ port: 0 }));
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("port-invalid");
    }
    expect(readdirSync(join(dir, "runs"))).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a re-dispatch under a run id that already has a record refuses before the admission", async () => {
    const preMinted = mintRunId();
    await dispatch(validBrief(), deps(), { runId: preMinted });

    // Booking the issue's cap a second time and then dying on EEXIST leaves the
    // reservation committed against an issue that got nothing for it.
    const ledgerFactory = mock(() => goodLedger());
    try {
      await dispatch(validBrief(), deps({ ledgerFactory }), { runId: preMinted });
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("run-id-in-use");
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, "runs"))).toHaveLength(1);
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
    const ledger = overBudgetLedger();

    try {
      await dispatch(brief, deps({ ledgerFactory: () => ledger }));
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
    // The refusal path closes the handle too — a leaked SQLite handle per
    // refused dispatch is invisible until the fleet runs out of them.
    expect(ledger.closeCalls).toBe(1);
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

  test("AC7: admitIssue is asked about THIS issue, run and cap, and the ledger is closed", async () => {
    const brief = validBrief();
    const cap = 12_345_678;
    const ledger = goodLedger(cap);

    const result = await dispatch(brief, deps({ ledgerFactory: () => ledger }));

    expect(ledger.admitCalls).toHaveLength(1);
    const call = ledger.admitCalls[0] as (typeof ledger.admitCalls)[number];
    expect(call.input).toEqual({
      repoSlug: "owner/repo",
      // The ledger's issue_id column is text — the brief's number is stringified
      // exactly once, here, or the same issue books two different rows.
      issueId: "42",
      runId: result.runId,
      requestId: result.requestId,
    });
    // capForIssue(config, …) with no per-issue override → the config default.
    expect(call.capMicroUsd).toBe(cap);
    // DF2.3's backstop, not a re-derived one: the clamp is min(keyCap, remaining).
    expect(call.keyCapMicroUsd).toBe(defaultKeyCapMicroUsd);
    expect(ledger.closeCalls).toBe(1);
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
    // EXACTLY zero: `checkHeadroom` is the only caller of `driver.list` on this
    // path, so "at most one" would be satisfied by the regression it is meant
    // to catch (one headroom call that happened to be allowed).
    expect(listSpy).not.toHaveBeenCalled();
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
    // Parsed and compared NUMERICALLY: a substring assertion on "30000000" also
    // matches 300000000 and 30000000000, so a 10×/1000× unit-conversion error
    // in the stamp would pass. `YAML.parse` reads the delivered file under
    // either encoding (serializeManifest emits JSON, a YAML subset).
    const delivered = YAML.parse(filled.stdout) as { limitMicroUsd?: unknown };
    expect(delivered.limitMicroUsd).toBe(admittedCeiling);
  });

  test("AC9b: budget extension carries effectiveCeilingMicros = admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    // Cap ≠ ceiling on purpose: with the two equal, a dispatcher that
    // propagated `capMicroUsd` wherever the ceiling belongs passes every
    // assertion below. The ceiling is min(keyCap, remaining), i.e. the smaller.
    const admittedCeiling = 20_000_000;
    const cap = 75_000_000;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling, cap) }));

    const record = store.get(result.runId);
    expect(record.extensions?.budget?.admittedCeilingMicroUsd).toBe(admittedCeiling);
    expect(record.extensions?.budget?.capMicroUsd).toBe(cap);

    // The run context handed to the box carries the same computed-once value
    const ctxFile = await driver.exec(record.vmName as string, ["cat", "run-context.json"]);
    const ctx = JSON.parse(ctxFile.stdout) as { effectiveCeilingMicros?: number };
    expect(ctx.effectiveCeilingMicros).toBe(admittedCeiling);

    // The manifest is the cap's only in-box source (AC9a) — the CEILING, not
    // the issue cap, is what the box may spend.
    const filled = await driver.exec(record.vmName as string, ["cat", "pipeline.yaml"]);
    expect((JSON.parse(filled.stdout) as { limitMicroUsd?: number }).limitMicroUsd).toBe(admittedCeiling);
  });

  // ─── Gate failure (AC3, INV-5) ─────────────────────────────────────────────────────

  test("AC3: gate ready=false → FleetError exit 3, record OPEN, box alive, gate outcome recorded", async () => {
    const brief = validBrief();
    const ledger = goodLedger();

    try {
      await dispatch(
        brief,
        deps({
          ledgerFactory: () => ledger,
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

      // AC3: the refusal is on the RUN RECORD too — `fleet status` is where an
      // operator learns why the run is open.
      expect(record.extensions?.gate?.outcome).toBe("failed");
      expect(record.extensions?.gate?.failedItem).toBe("A");
      expect(record.extensions?.gate?.assertionCode).toBe(1);
      expect(Number.isNaN(Date.parse(String(record.extensions?.gate?.failedAt)))).toBeFalse();

      // A minted key is spendable the moment it exists. If the dispatcher dies
      // at the gate without persisting `keyHash`, the credential is live and
      // NOBODY can revoke it — the record is the only handle teardown has.
      expect(record.keyHash).toMatch(/^[0-9a-f]{64}$/);

      // Box NOT destroyed (INV-5: the evidence outlives the failure)
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();

      // The refusal line carries the run id once one exists — the counterpart
      // of the `runId: null` refusal above.
      const refusals = refusalLines();
      expect(refusals).toHaveLength(1);
      expect((refusals[0] as LogEntry).runId).toBe(record.runId);
    }
    expect(ledger.closeCalls).toBe(1);
  });

  test("INV-5 ordering: a failed gate never makes the box public", async () => {
    const brief = validBrief();
    const callOrder: string[] = [];

    const originalExpose = driver.expose.bind(driver);
    driver.expose = async (vm: string, port: number) => {
      callOrder.push("expose");
      return originalExpose(vm, port);
    };
    const originalSetPublic = driver.setPublic.bind(driver);
    driver.setPublic = async (vm: string) => {
      callOrder.push("setPublic");
      return originalSetPublic(vm);
    };

    try {
      await dispatch(
        brief,
        deps({
          port: 8080,
          setupGate: async (_drv, vm) => {
            callOrder.push("gate");
            return {
              ready: false,
              failedItem: "C" as const,
              assertionCode: 2 as const,
              assertions: [{ item: "C" as const, ok: false, note: "env file mode" }],
              debugCommands: [],
              teardownCommand: "bun scripts/fleet.ts teardown the-run",
              vm,
            };
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).code).toBe("setup-gate-failed");
    }
    // A box made public before the gate proves it is reachable while unproven —
    // and INV-5 then forbids tearing it down.
    expect(callOrder).toEqual(["gate"]);
  });

  test("INV-5 ordering: the box is exposed and made public only AFTER the gate passes", async () => {
    const brief = validBrief();
    const callOrder: string[] = [];

    const originalExpose = driver.expose.bind(driver);
    driver.expose = async (vm: string, port: number) => {
      callOrder.push("expose");
      return originalExpose(vm, port);
    };
    const originalSetPublic = driver.setPublic.bind(driver);
    driver.setPublic = async (vm: string) => {
      callOrder.push("setPublic");
      return originalSetPublic(vm);
    };

    const result = await dispatch(
      brief,
      deps({
        port: 8080,
        setupGate: async (drv, vm, o) => {
          callOrder.push("gate");
          return fakeGate(drv, vm, o);
        },
      }),
    );

    expect(callOrder).toEqual(["gate", "expose", "setPublic"]);
    expect(result.httpsUrl).toMatch(/^https:\/\//);
    expect(store.get(result.runId).ports).toEqual([8080]);
  });

  // ─── Ack shape (AC2) ─────────────────────────────────────────────────────────────

  test("Ack shape {runId, requestId, state: 'ready', vmName, httpsUrl?}", async () => {
    const brief = validBrief();
    const result = await dispatch(brief, deps());

    expect(result).toMatchObject({
      runId: expect.stringMatching(/^qds-/),
      requestId: expect.stringMatching(UUID_V4_RE),
      state: "ready",
      vmName: expect.stringMatching(/^qds-/),
    });
    // httpsUrl is optional on the fake substrate without a port
    if (result.httpsUrl !== undefined) {
      expect(result.httpsUrl).toMatch(/^https:\/\//);
    }
  });

  // ─── 600s wall clock timeout ───────────────────────────────────────────────────────

  test("600s wall clock: expiry past the default ceiling throws FleetError exit 1, box alive", async () => {
    const brief = validBrief();
    const { clock, advance } = stepClock();

    try {
      await dispatch(
        brief,
        // No timeoutMs: the PRODUCTION default is the ceiling under test.
        deps({
          clock,
          setupGate: async (drv, vm, o) => {
            // Time passes ACROSS the gate — the longest await in a dispatch —
            // so the advance lands after the real work, exactly where the
            // ceiling has to be re-sampled. Advancing before the gate promise
            // reaches `within` instead makes that step abandon an in-flight
            // gate and throw dispatch-timeout from `within` rather than from
            // the post-gate re-sample, which is a different code path.
            const result = await fakeGate(drv, vm, o);
            advance(DEFAULT_TIMEOUT_MS + 1_000);
            return result;
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("gate");
      // The default itself, not just "some ceiling" — a changed default would
      // otherwise be invisible here.
      expect(err.message).toContain(`${DEFAULT_TIMEOUT_MS} ms`);

      // Box left alive (INV-5 posture: teardown is the operator's call), and it
      // is THIS run's box — a count alone passes when the run's own VM is gone
      // and an unrelated box exists.
      const record = store.get(err.payload?.runId as string);
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
    }
  });

  test("600s wall clock: just under the ceiling does NOT expire", async () => {
    const brief = validBrief();
    const { clock, advance } = stepClock();

    // Boundary control: without it, a ceiling regressed to 60s (or raised to
    // 6000s) still passes the expiry test above.
    const result = await dispatch(
      brief,
      deps({
        clock,
        setupGate: async (drv, vm, o) => {
          const result = await fakeGate(drv, vm, o);
          advance(DEFAULT_TIMEOUT_MS - 1_000);
          return result;
        },
      }),
    );
    expect(result.state).toBe("ready");
  });

  // ─── INV-4: no key material in logs, records or the ack ──────────────────────────────

  test("INV-4: no key material in log lines", async () => {
    const brief = validBrief();
    keyApi.createKey = async () => ({
      key: "sk-or-known-key-material-12345",
      hash: "abc123",
      limitUsd: 50,
      usageUsd: 0,
    });

    await dispatch(brief, deps());

    // Positive control: `some(...)` on an EMPTY array is false, so the absence
    // proof below means nothing unless lines were actually captured.
    expect(logs.length).toBeGreaterThan(0);
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

  test("INV-4: no key material in the dispatch ack", async () => {
    const brief = validBrief();
    const knownKey = "sk-test-ack-leak-4242";
    keyApi.createKey = async () => ({
      key: knownKey,
      hash: "cafebabe",
      limitUsd: 50,
      usageUsd: 0,
    });

    const result = await dispatch(brief, deps());

    // The ack is printed to stdout by the CLI. `toMatchObject` above ignores
    // extra keys, so a regression that hangs the plaintext off the ack would
    // leak it there undetected.
    expect(JSON.stringify(result)).not.toContain(knownKey);
    expect(result).not.toHaveProperty("key");
    expect(result).not.toHaveProperty("openrouterKey");
  });
});
