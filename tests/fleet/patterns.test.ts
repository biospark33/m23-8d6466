/**
 * Pattern-level tests (DF3.2, wave-1b agent B): the three fleet patterns over
 * the fanout() primitive — admission (AC1), structural isolation (AC2),
 * mint-before-parallel (AC3), setup-failure isolation (AC4), the race poller
 * (AC5), the degenerate many-stories case and pattern validation (AC6/D9),
 * and the fan-out record + extension stamps (AC9).
 *
 * Lock mechanics, record-store discipline and reclaim classification live in
 * fanout.test.ts (wave-1a agent A); rank math lives in rank.test.ts (agent C).
 *
 * Fakes are LOCAL to this file (C3): the one shared import is helpers.ts's
 * goodLedger family, which already exists. Interleaving is FORCED through the
 * seams (setupGate, ledgerFactory, the poller's planted markers) — never
 * natural timing.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { VIZ_PIDFILE, type ExecResult, type ProviderDriver } from "../../src/providers/driver.ts";
import type { SetupGateResult } from "../../src/providers/exedev/setup-gate.ts";
import { DEFAULT_QUOTA_LIMITS, type LoadedQuotaLimits } from "../../src/providers/quota.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { goodLedger, type BudgetSnapshot, type RecordingLedger } from "./helpers.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";
import { runMarkerPath } from "../../src/phase-engine/journal.ts";
import { FleetError, type GateOpts } from "../../src/fleet/dispatch.ts";
import type { Brief } from "../../src/fleet/brief-schema.ts";
import { FanoutRecordStore } from "../../src/fleet/fanout.ts";
import {
  assertFanoutPin,
  fanout,
  stampFanoutExtension,
  DEFAULT_FANOUT_CEILING_MS,
  DEFAULT_PER_CALL_DEADLINE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  FANOUT_MAX_N,
  MAX_FANOUT_CONCURRENCY,
  type FanoutDeps,
} from "../../src/fleet/fanout-primitive.ts";

// ─── fixtures ──────────────────────────────────────────────────────────────────

const MANIFEST_REL = join("manifests", "pipeline.json");

/** Injected poll timings: no test sleeps a production second (D14 seams). */
const TICK_MS = 10;
const DEADLINE_MS = 200;

/** Fresh limits — NEVER mutate DEFAULT_QUOTA_LIMITS (shared, unfrozen reference). */
function limitsWith(maxVms: number): LoadedQuotaLimits {
  return { limits: { ...DEFAULT_QUOTA_LIMITS, maxVms }, source: "default" };
}

/** Bound-function view of any object — Proxy traps must not lose `this`. */
function boundProxy<T extends object>(target: T, extra: { get(prop: string | symbol): unknown }): T {
  return new Proxy(target, {
    get(t, prop) {
      const overridden = extra.get(prop);
      if (overridden !== undefined) return overridden;
      const v = Reflect.get(t, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as T;
}

/** A driver whose `list` always fails — quota's fail-closed enumeration case. */
function brokenListDriver(inner: ProviderDriver): ProviderDriver {
  return boundProxy(inner, {
    get(prop) {
      return prop === "list" ? () => Promise.reject(new Error("provider unreachable")) : undefined;
    },
  });
}

/** A driver whose marker PROBES never settle — ExeDevDriver's pending-exec case. */
function hungProbeDriver(inner: RaceFakeDriver, onHungProbe: () => void): ProviderDriver {
  return boundProxy(inner, {
    get(prop) {
      if (prop !== "exec") return undefined;
      return (vm: string, argv: string[], stdin?: string): Promise<ExecResult> => {
        if (
          argv.length >= 3 &&
          argv[0] === "sh" &&
          argv[1] === "-c" &&
          String(argv[2]).includes(runMarkerPath())
        ) {
          onHungProbe();
          return new Promise<never>(() => {});
        }
        return inner.exec(vm, argv, stdin);
      };
    },
  });
}

/**
 * POSIX single-quote wrapping — mirrored HERE (not imported) so a loosened
 * production quoter cannot loosen the test's own probe rewriting.
 */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * FakeDriver whose box directory IS the box's root filesystem: the in-box
 * completion marker (`runMarkerPath()` — `/run/journal/final.json` in a real
 * box) maps onto `<box>/journal/final.json`, so "planting a marker in the
 * box" is writing that file. Everything else delegates unchanged.
 *
 * Also guards the SHARED HOST visualizer pidfile (teardown's stopVisualizer
 * step would otherwise read/kill whatever `/tmp/qds-viz.pid` names — the same
 * guard teardown.test.ts installs).
 */
class RaceFakeDriver extends FakeDriver {
  /** Called before each marker probe runs; `probeNumber` counts ALL probes. */
  onProbe?: (vm: string, probeNumber: number) => void;
  #probes = 0;

  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    if (argv.some((a) => typeof a === "string" && a.includes(VIZ_PIDFILE))) {
      return { stdout: "NONE\n", stderr: "", exitCode: 0 };
    }
    if (this.isMarkerProbe(argv)) {
      this.#probes += 1;
      this.onProbe?.(vm, this.#probes);
      return super.exec(vm, ["sh", "-c", `test -f ${shellQuote(this.boxMarker(vm))}`], stdin);
    }
    return super.exec(vm, argv, stdin);
  }

  override async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    if (remotePath === runMarkerPath()) {
      return super.copyFile(vm, this.boxMarker(vm), localPath);
    }
    return super.copyFile(vm, remotePath, localPath);
  }

  /** Probes are the ONLY commands whose script mentions the marker path. */
  private isMarkerProbe(argv: string[]): boolean {
    return (
      argv.length >= 3 &&
      argv[0] === "sh" &&
      argv[1] === "-c" &&
      typeof argv[2] === "string" &&
      argv[2].includes(runMarkerPath())
    );
  }

  private boxMarker(vm: string): string {
    return join(this.root, vm, "journal", "final.json");
  }
}

/** Plants (or overwrites) a box's completion marker. A string body = raw bytes. */
function plantMarker(driver: RaceFakeDriver, vm: string, body: unknown): void {
  mkdirSync(dirname(join(driver.root, vm, "journal", "final.json")), { recursive: true });
  writeFileSync(
    join(driver.root, vm, "journal", "final.json"),
    typeof body === "string" ? body : `${JSON.stringify(body)}\n`,
  );
}

function boxExists(driver: RaceFakeDriver, vm: string | undefined): boolean {
  return vm !== undefined && existsSync(join(driver.root, vm));
}

function boxCount(driver: RaceFakeDriver): number {
  try {
    return readdirSync(driver.root).length;
  } catch {
    return 0;
  }
}

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** The teardown step labels observed in the sink for one runId, in order. */
function teardownStepsFor(entries: LogEntry[], runId: string | null | undefined): string[] {
  if (runId == null) return [];
  return entries
    .filter((e) => e.operation.startsWith("teardown.") && e.runId === runId)
    .map((e) => String(e.step));
}

async function refuseOf(p: Promise<unknown>): Promise<FleetError> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  const err = caught as FleetError;
  expect(err).toBeInstanceOf(FleetError);
  return err;
}

function syncRefuseOf(fn: () => unknown): FleetError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  const err = caught as FleetError;
  expect(err).toBeInstanceOf(FleetError);
  return err;
}

// ─── suite ─────────────────────────────────────────────────────────────────────

describe("fleet fanout patterns (DF3.2 AC1-AC6, AC9)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: RaceFakeDriver;
  let keyApi: FakeKeyApi;
  let fanoutsDir: string;
  let lockPath: string;
  let ledgerCalls: number;
  let entries: LogEntry[];
  let restoreLog: (() => void) | undefined;
  const requestId = randomUUID();

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "df32-patterns-")));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new RaceFakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    fanoutsDir = join(dir, "fanouts");
    lockPath = join(dir, "fleet.lock");
    ledgerCalls = 0;
    entries = [];
    restoreLog = setLogSink((e) => entries.push(e));
  });

  afterEach(() => {
    restoreLog?.();
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── helpers ──────────────────────────────────────────────────────────────────

  function manifest(): void {
    const p = join(dir, MANIFEST_REL);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        phases: [
          { name: "plan", kind: "engineer", description: "Draft the approach", maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Run the suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
        ],
      }),
    );
  }

  function brief(commitSha: string = "a".repeat(40)): Brief {
    return {
      repoSlug: "owner/repo",
      issueId: 42,
      commitSha,
      manifestPath: MANIFEST_REL,
      repoUrl: "https://github.com/owner/repo",
    };
  }

  function gateReady(vm: string): SetupGateResult {
    return { ready: true, assertions: [], debugCommands: [], teardownCommand: `td ${vm}`, vm };
  }

  function gateFail(vm: string): SetupGateResult {
    return {
      ready: false,
      failedItem: "A",
      assertionCode: 1,
      assertions: [{ item: "A", ok: false, note: "fixture failure" }],
      debugCommands: ["status x"],
      teardownCommand: `td ${vm}`,
      vm,
    };
  }

  /**
   * Poll/deadline seams injected everywhere so no test ever waits a production
   * interval; `gate` defaults to always ready.
   */
  function deps(overrides: Partial<FanoutDeps> = {}): FanoutDeps {
    return {
      driver,
      keyApi,
      store,
      ledgerFactory: () => {
        ledgerCalls += 1;
        return goodLedger();
      },
      repoRoot: dir,
      requestId,
      quotaLimits: limitsWith(DEFAULT_QUOTA_LIMITS.maxVms),
      fanoutsDir,
      lockPath,
      setupGate: async (_d: ProviderDriver, vm: string, _o: GateOpts) => gateReady(vm),
      pollIntervalMs: TICK_MS,
      perCallDeadlineMs: DEADLINE_MS,
      clock: () => Date.now(),
      monotonic: () => performance.now(),
      ...overrides,
    };
  }

  function fanoutRecordFiles(): string[] {
    return readdirSafe(fanoutsDir).filter((f) => f.endsWith(".json"));
  }

  // ─── D9: pattern validation — exit 2, BEFORE the lock, zero side effects ─────

  describe("validation (D9 — exit 2 before the lock)", () => {
    test("rejects an unknown pattern", async () => {
      manifest();
      const err = await refuseOf(fanout("best-of-nn" as never, 2, brief(), deps()));
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain("best-of-nn");
    });

    test("best-of-n and race reject n=1; every pattern rejects n beyond the bound", async () => {
      manifest();
      expect((await refuseOf(fanout("best-of-n", 1, brief(), deps()))).code).toBe("invalid-n");
      expect((await refuseOf(fanout("race", 1, brief(), deps()))).code).toBe("invalid-n");
      expect((await refuseOf(fanout("best-of-n", FANOUT_MAX_N + 1, brief(), deps()))).code).toBe(
        "invalid-n",
      );
      expect((await refuseOf(fanout("many-stories", FANOUT_MAX_N + 1, [brief()], deps()))).code).toBe(
        "invalid-n",
      );
    });

    test("many-stories accepts n=1", async () => {
      manifest();
      const res = await fanout("many-stories", 1, [brief()], deps());
      expect(res.arms).toHaveLength(1);
      expect(res.arms[0]?.outcome).toBe("ready");
    });

    test("best-of-n requires a roster whose count equals n", async () => {
      manifest();
      expect((await refuseOf(fanout("best-of-n", 2, brief(), deps()))).code).toBe("roster-required");
      expect(
        (await refuseOf(fanout("best-of-n", 2, brief(), deps({ rosterIds: ["only-one"] })))).code,
      ).toBe("roster-count-mismatch");
      expect(
        (await refuseOf(fanout("race", 2, brief(), deps({ rosterIds: ["a"] })))).code,
      ).toBe("roster-count-mismatch");
    });

    test("many-stories takes exactly n brief objects and forbids a roster", async () => {
      manifest();
      expect((await refuseOf(fanout("many-stories", 3, brief() as unknown as Brief[], deps()))).code).toBe( /* dp:ok deliberately malformed fixture: this row asserts the invalid-brief refusal */
        "invalid-brief",
      );
      expect(
        (await refuseOf(fanout("many-stories", 3, [brief(), brief()], deps()))).code,
      ).toBe("brief-count-mismatch");
      expect(
        (await refuseOf(fanout("many-stories", 1, [brief()], deps({ rosterIds: ["x"] })))).code,
      ).toBe("roster-forbidden");
    });

    test("a malformed brief refuses as invalid-brief", async () => {
      manifest();
      const bad = { ...brief(), commitSha: "not-a-sha" } as unknown as Brief; /* dp:ok deliberately malformed fixture: asserts the invalid-brief refusal below */
      const err = await refuseOf(fanout("best-of-n", 2, bad, deps({ rosterIds: ["a", "b"] })));
      expect(err.code).toBe("invalid-brief");
    });

    test("every validation refusal takes no lock and provisions nothing", async () => {
      manifest();
      const err = await refuseOf(
        fanout("best-of-n", 2, brief(), deps({ rosterIds: ["one", "too", "many"] })),
      );
      expect(err.code).toBe("roster-count-mismatch");
      expect(existsSync(lockPath)).toBe(false);
      expect(boxCount(driver)).toBe(0);
      expect(fanoutRecordFiles()).toHaveLength(0);
      expect(ledgerCalls).toBe(0);
      expect(readdirSafe(join(dir, "runs"))).toHaveLength(0);
    });

    test("a non-positive or non-integer capMicroUsd refuses exit 2 before anything runs", async () => {
      manifest();
      for (const cap of [-1, 0, Number.NaN, 1.5]) {
        /* dp:ok deliberately malformed fixtures: each row asserts the invalid-cap refusal */
        const err = await refuseOf(
          fanout("best-of-n", 2, brief(), deps({ rosterIds: ["a", "b"], capMicroUsd: cap })),
        );
        expect(err.exitCode).toBe(2);
        expect(err.code).toBe("invalid-cap");
      }
      // Zero side effects: the INV-3 admitted line never carried a bad cap.
      expect(existsSync(lockPath)).toBe(false);
      expect(boxCount(driver)).toBe(0);
      expect(fanoutRecordFiles()).toHaveLength(0);
    });
  });

  // ─── AC1: admission ────────────────────────────────────────────────────────────

  describe("admission (AC1)", () => {
    test("checkHeadroom is consulted EXACTLY once for n=3 — never once per arm", async () => {
      manifest();
      const listSpy = spyOn(driver, "list");
      const res = await fanout("best-of-n", 3, brief(), deps({ rosterIds: ["r0", "r1", "r2"] }));
      expect(res.arms).toHaveLength(3);
      expect(listSpy.mock.calls.length).toBe(1);
      listSpy.mockRestore();
    });

    test("allowed:false refuses before minting anything: exit 5 no-headroom, zero side effects", async () => {
      manifest();
      const err = await refuseOf(
        fanout(
          "best-of-n",
          3,
          brief(),
          deps({ rosterIds: ["r0", "r1", "r2"], quotaLimits: limitsWith(2) }),
        ),
      );
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-headroom");
      expect(err.message).toContain("headroom");
      expect(err.payload).toMatchObject({ reason: "vm-ceiling", liveVms: 0, ceiling: 2, headroom: 2 });
      expect((err as unknown as { exitStatus?: string }).exitStatus).toBeUndefined(); /* dp:ok probing an undeclared field off the thrown FleetError */
      // Zero records, zero boxes, zero keys (nothing provisioned ⇒ no budget
      // admission either), zero mints — and the lock was released.
      expect(fanoutRecordFiles()).toHaveLength(0);
      expect(boxCount(driver)).toBe(0);
      expect(ledgerCalls).toBe(0);
      expect(readdirSafe(join(dir, "runs"))).toHaveLength(0);
      expect(existsSync(lockPath)).toBe(false);
    });

    test("list-unverified refuses fail-closed and classifies transient", async () => {
      manifest();
      const err = await refuseOf(
        fanout(
          "best-of-n",
          2,
          brief(),
          deps({ driver: brokenListDriver(driver), rosterIds: ["r0", "r1"] }),
        ),
      );
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-headroom");
      expect(err.payload).toMatchObject({ reason: "list-unverified", headroom: 0 });
      expect((err as unknown as { exitStatus?: string }).exitStatus).toBe("transient"); /* dp:ok probing an undeclared field off the thrown FleetError */
      expect(fanoutRecordFiles()).toHaveLength(0);
      expect(boxCount(driver)).toBe(0);
    });

    test("a malformed quota-limits file refuses exit 5 headroom-failed, zero side effects", async () => {
      manifest();
      // checkHeadroom's default parameter is loadQuotaLimits(), which throws
      // QuotaLimitsError for an unreadable/unparseable file. Dispatch maps the
      // identical condition to refuse(5, "headroom-failed") — the primitive
      // must not let it escape as a bare exit-1.
      const bad = join(dir, "quota-limits.json");
      writeFileSync(bad, "{ not json");
      const prev = process.env.QDS_QUOTA_LIMITS_FILE;
      process.env.QDS_QUOTA_LIMITS_FILE = bad;
      try {
        const err = await refuseOf(
          fanout("best-of-n", 2, brief(), deps({ rosterIds: ["r0", "r1"], quotaLimits: undefined })),
        );
        expect(err.exitCode).toBe(5);
        expect(err.code).toBe("headroom-failed");
        expect(err.message).toContain("headroom could not be determined");
        expect(err.payload).toMatchObject({ providerCode: "quota-limits-unreadable" });
        // Zero side effects: nothing provisioned, no record, lock released.
        expect(fanoutRecordFiles()).toHaveLength(0);
        expect(boxCount(driver)).toBe(0);
        expect(ledgerCalls).toBe(0);
        expect(readdirSafe(join(dir, "runs"))).toHaveLength(0);
        expect(existsSync(lockPath)).toBe(false);
      } finally {
        // Reflect.deleteProperty, not `= undefined`: Bun coerces an undefined
        // assignment into the STRING "undefined", poisoning every later
        // loadQuotaLimits() in the same process.
        if (prev === undefined) Reflect.deleteProperty(process.env, "QDS_QUOTA_LIMITS_FILE");
        else process.env.QDS_QUOTA_LIMITS_FILE = prev;
      }
    });
  });

  // ─── AC2/AC3: isolation and mint ordering ──────────────────────────────────────

  describe("isolation and mint ordering (AC2/AC3)", () => {
    test("F15: issue headroom below n×cap refuses BEFORE any arm is provisioned", async () => {
      // MEASURED live ×2 (fan-20260825-{ff6d64,b37e88}): both arms share ONE
      // issueId, admitIssue budgets PER ISSUE, and with the ceiling below
      // n×cap arm 0 admitted (billable box) while arms 1..n-1 were refused
      // budget-exceeded — a deterministic partial fan-out that spent money on
      // work the operator's own config had declared unaffordable. The
      // primitive must reconcile its DECLARED aggregate against the ledger
      // snapshot BEFORE the fanout record exists or anything is minted.
      const cap = 50_000;
      manifest();
      const err = await refuseOf(
        fanout(
          "best-of-n",
          2,
          brief(),
          deps({
            capMicroUsd: cap,
            rosterIds: ["r0", "r1"],
            ledgerFactory: () =>
              goodLedger(cap, cap, { ceilingMicroUsd: cap, spentMicroUsd: 0, reservedMicroUsd: 0 }),
          }),
        ),
      );
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("issue-ceiling-insufficient");
      expect(err.message).toContain("owner/repo#42");
      expect(err.message).toContain("100000"); // n × cap, the exact number to authorize
      expect(err.remediation).toContain("perIssueOverrides");
      // Pre-mint: no fanout record, no run records, nothing on a provider.
      expect(fanoutRecordFiles()).toEqual([]);
      expect(readdirSafe(store.dir)).toEqual([]);
      expect(boxCount(driver)).toBe(0);
    });

    test("N arms hold distinct boxes, keys and records (negative control)", async () => {
      manifest();
      const res = await fanout("best-of-n", 2, brief(), deps({ rosterIds: ["r0", "r1"] }));
      expect(res.arms.map((a) => a.outcome)).toEqual(["ready", "ready"]);
      expect(new Set(res.arms.map((a) => a.vmName)).size).toBe(2);
      // An implementation running N agents inside ONE box produces ONE box
      // directory and MUST trip this.
      expect(boxCount(driver)).toBe(2);
      const keyHashes = res.arms.map((a) => store.get(a.runId as string).keyHash);
      expect(new Set(keyHashes).size).toBe(2);
      expect(new Set(res.arms.map((a) => a.runId)).size).toBe(2);
    });

    test("all N ids are minted before the parallel section opens", async () => {
      manifest();
      let armsAtFirstAdmission: number | undefined;
      const seenRunIds = new Set<string>();
      await fanout(
        "best-of-n",
        3,
        brief(),
        deps({
          rosterIds: ["r0", "r1", "r2"],
          ledgerFactory: () => {
            ledgerCalls += 1;
            if (armsAtFirstAdmission === undefined) {
              // The FIRST budget admission of the parallel section: the
              // fan-out record must already carry every pre-minted id.
              armsAtFirstAdmission = new FanoutRecordStore({ dir: fanoutsDir }).list()[0]?.arms.length;
            }
            return goodLedger();
          },
          setupGate: async (_d, vm, o: GateOpts) => {
            seenRunIds.add(o.runId);
            return gateReady(vm);
          },
        }),
      );
      expect(armsAtFirstAdmission).toBe(3);
      expect(seenRunIds.size).toBe(3);
      for (const id of seenRunIds) expect(id).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    });
  });

  // ─── F15b: per-issue grouped headroom (multi-issue many-stories) ─────────────

  describe("F15b: per-issue grouped headroom (multi-issue many-stories)", () => {
    /**
     * goodLedger whose snapshot answers PER canonical issue key. Issues not in
     * the map report infinite headroom — same "never refuse by default" stance
     * as the helper's own default snapshot; a test pinning a refusal names the
     * tight issue explicitly.
     */
    function perIssueLedger(byIssue: Record<string, BudgetSnapshot>): RecordingLedger {
      const ledger = goodLedger();
      ledger.issueBudgetSnapshot = (repoSlug: string, issueId: string): BudgetSnapshot =>
        byIssue[`${repoSlug}#${issueId}`] ?? {
          ceilingMicroUsd: Number.MAX_SAFE_INTEGER,
          spentMicroUsd: 0,
          reservedMicroUsd: 0,
        };
      return ledger;
    }

    test("two briefs on two DIFFERENT issues, each fitting alone, fan out — briefList[0]-only arithmetic would over-refuse", async () => {
      // many-stories arms may target distinct issues; admitIssue budgets PER
      // (repoSlug, issueId). Each issue carries exactly ONE arm at cap here, so
      // 50k available per issue is enough for both groups. The pre-F15b block
      // read only briefList[0] and demanded n×cap = 100k on issue #42 — a
      // legitimate fan-out refused exit 5 before anything existed.
      const cap = 50_000;
      manifest();
      const res = await fanout(
        "many-stories",
        2,
        [brief(), { ...brief(), issueId: 43 }],
        deps({
          capMicroUsd: cap,
          ledgerFactory: () =>
            perIssueLedger({
              "owner/repo#42": { ceilingMicroUsd: cap, spentMicroUsd: 0, reservedMicroUsd: 0 },
              "owner/repo#43": { ceilingMicroUsd: cap, spentMicroUsd: 0, reservedMicroUsd: 0 },
            }),
        }),
      );
      expect(res.arms.map((a) => a.outcome)).toEqual(["ready", "ready"]);
      expect(boxCount(driver)).toBe(2);
    });

    test("a LATER brief's exhausted issue refuses pre-mint — arms 1..n-1 are no longer unchecked", async () => {
      // #42 fits; #43 has 20k free < cap. Pre-F15b only #42 was read → both
      // arms dispatched and arm 1's real admitIssue refused budget-exceeded
      // MID-flight, after arm 0 provisioned a billable box — the exact hazard
      // the F15 block was built to kill. The refusal must land on #43 BEFORE
      // anything is minted.
      const cap = 50_000;
      manifest();
      const err = await refuseOf(
        fanout(
          "many-stories",
          2,
          [brief(), { ...brief(), issueId: 43 }],
          deps({
            capMicroUsd: cap,
            ledgerFactory: () =>
              perIssueLedger({
                "owner/repo#42": { ceilingMicroUsd: 1_000_000, spentMicroUsd: 0, reservedMicroUsd: 0 },
                "owner/repo#43": { ceilingMicroUsd: 50_000, spentMicroUsd: 30_000, reservedMicroUsd: 0 },
              }),
          }),
        ),
      );
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("issue-ceiling-insufficient");
      expect(err.message).toContain("owner/repo#43");
      expect(err.message).not.toContain("owner/repo#42"); // #42 fits — only the exhausted group is named
      expect(fanoutRecordFiles()).toEqual([]);
      expect(boxCount(driver)).toBe(0);
    });

    test("grouped refusal names EVERY insufficient issue's own need and override line", async () => {
      // Briefs [#42, #43, #42]: group #42 carries TWO arms (needs 2×cap),
      // group #43 one. Both groups are short — the message and the
      // remediation's perIssueOverrides map must name BOTH, each with its OWN
      // group-count arithmetic (100000 and 50000), never n×cap flattened onto
      // brief 0's issue.
      const cap = 50_000;
      manifest();
      const err = await refuseOf(
        fanout(
          "many-stories",
          3,
          [brief(), { ...brief(), issueId: 43 }, brief()],
          deps({
            capMicroUsd: cap,
            ledgerFactory: () =>
              perIssueLedger({
                "owner/repo#42": { ceilingMicroUsd: 60_000, spentMicroUsd: 0, reservedMicroUsd: 0 },
                "owner/repo#43": { ceilingMicroUsd: 10_000, spentMicroUsd: 0, reservedMicroUsd: 0 },
              }),
          }),
        ),
      );
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("issue-ceiling-insufficient");
      expect(err.message).toContain("owner/repo#42");
      expect(err.message).toContain("100000"); // 2 arms × cap on #42 — not 3×cap
      expect(err.message).toContain("owner/repo#43");
      expect(err.message).toContain("50000");
      expect(err.remediation).toContain('"owner/repo#42": 100000');
      expect(err.remediation).toContain('"owner/repo#43": 50000');
      expect(fanoutRecordFiles()).toEqual([]);
      expect(boxCount(driver)).toBe(0);
    });
  });

  // ─── K8: the concurrency bound ────────────────────────────────────────────────

  describe("concurrency bound (K8)", () => {
    test("width=2 over n=4 with staggered completions never exceeds two concurrent arms", async () => {
      manifest();
      let inFlight = 0;
      let peak = 0;
      const res = await fanout(
        "best-of-n",
        4,
        brief(),
        deps({
          rosterIds: ["r0", "r1", "r2", "r3"],
          concurrency: 2,
          setupGate: async (_d: ProviderDriver, vm: string) => {
            inFlight += 1;
            // Measure peak BEFORE sleep: arms holding semaphore permits are concurrently in-flight.
            peak = Math.max(peak, inFlight);
            // Paces gate completion: keeps arms in the semaphore longer so permits
            // actually contend. Wall-clock dependency is intentional for pacing.
            await new Promise<void>((resolve) => setTimeout(resolve, TICK_MS));
            inFlight -= 1;
            return gateReady(vm);
          },
        }),
      );
      expect(res.arms.every((a) => a.outcome === "ready")).toBe(true);
      // Not vacuous: the four arms really did contend for two slots…
      expect(peak).toBe(2);
    });
  });

  // ─── DD-9/INV-3: the per-arm cap reaches dispatch ADMISSION ──────────────────

  describe("per-arm cap enforcement path (DD-9/INV-3)", () => {
    test("deps.capMicroUsd reaches every arm's budget admission as the key cap — not just the admitted log line", async () => {
      manifest();
      const ledgers: RecordingLedger[] = [];
      const res = await fanout(
        "best-of-n",
        2,
        brief(),
        deps({
          rosterIds: ["r0", "r1"],
          capMicroUsd: 12_345,
          // A config default DISTINCT from the passed cap: the recording
          // ledger keeps `capMicroUsd` (config-derived) apart from
          // `keyCapMicroUsd` (the gate's third argument) precisely so a
          // dispatcher propagating one while claiming the other fails here.
          ledgerFactory: () => {
            const l = goodLedger(7_000_000);
            ledgers.push(l);
            return l;
          },
        }),
      );
      expect(res.arms.map((a) => a.outcome)).toEqual(["ready", "ready"]);
      // The F15 pre-flight opens its OWN ledger instance for the read-only
      // budget snapshot (zero admitCalls, closed immediately); only the arms'
      // two instances ever reach admitIssue.
      const admitting = ledgers.filter((l) => l.admitCalls.length > 0);
      expect(admitting).toHaveLength(2);
      for (const l of admitting) {
        expect(l.admitCalls).toHaveLength(1);
        // assertWithinBudget was handed deps.capMicroUsd as its key-cap…
        expect(l.admitCalls[0]?.keyCapMicroUsd).toBe(12_345);
        // …while the ledger-config-derived cap stayed the ledger's own.
        expect(l.admitCalls[0]?.capMicroUsd).toBe(7_000_000);
      }
      // And each admission booked ITS OWN arm's runId — per-arm dispatch, not
      // one shared admission.
      expect(ledgers.map((l) => l.admitCalls[0]?.input.runId).sort()).toEqual(
        res.arms.map((a) => a.runId as string).sort(),
      );
    });
  });

  // ─── AC4: setup-gate failure isolation ─────────────────────────────────────────

  describe("arm failure isolation (AC4)", () => {
    test("a setupFailed arm stops alone: box left alive, siblings complete, no teardown", async () => {
      manifest();
      let gateCalls = 0;
      const res = await fanout(
        "best-of-n",
        3,
        brief(),
        deps({
          rosterIds: ["r0", "r1", "r2"],
          setupGate: async (_d: ProviderDriver, vm: string) => {
            gateCalls += 1;
            return gateCalls === 1 ? gateFail(vm) : gateReady(vm);
          },
        }),
      );
      const failed = res.arms.filter((a) => a.outcome === "setupFailed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.exitCode).toBe(3);
      expect(res.arms.filter((a) => a.outcome === "ready")).toHaveLength(2);
      // INV-5: the degraded box stays alive WITH its evidence — and nobody
      // else's lifecycle ran either (non-race patterns never tear down).
      for (const arm of res.arms) expect(boxExists(driver, arm.vmName)).toBe(true);
      expect(entries.some((e) => e.operation.startsWith("teardown."))).toBe(false);
      // The fan-out itself still completes and closes its own record.
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.closedAt).not.toBeNull();
      expect(rec.winner).toBeNull();
    });

    test("two of three arms failing post-provision — a ready:false gate and a THROWING gate side by side: both classified, survivor unaffected, record closes", async () => {
      manifest();
      let gateCalls = 0;
      const res = await fanout(
        "best-of-n",
        3,
        brief(),
        deps({
          rosterIds: ["r0", "r1", "r2"],
          setupGate: async (_d: ProviderDriver, vm: string) => {
            gateCalls += 1;
            if (gateCalls === 2) return gateFail(vm); // exit-3 refusal
            if (gateCalls === 3) throw new Error("gate exploded mid-batch");
            return gateReady(vm);
          },
        }),
      );
      const byOutcome = (o: string) => res.arms.filter((a) => a.outcome === o);
      // The survivor completed untouched by its batch-mates' failures.
      expect(byOutcome("ready")).toHaveLength(1);
      expect(byOutcome("setupFailed")).toHaveLength(1);
      expect(byOutcome("setupFailed")[0]?.exitCode).toBe(3);
      // A thrown gate error escapes dispatch's outer catch as exit-1
      // dispatch-failed: an arm failure, never a setup classification and
      // never an unclassified crash.
      expect(byOutcome("armFailed")).toHaveLength(1);
      expect(byOutcome("armFailed")[0]?.exitCode).toBe(1);
      // INV-5: every provisioned box stays alive WITH its evidence, and no
      // teardown ran at all (best-of-n never disposes).
      for (const arm of res.arms) expect(boxExists(driver, arm.vmName)).toBe(true);
      expect(entries.some((e) => e.operation.startsWith("teardown."))).toBe(false);
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.winner).toBeNull();
      expect(rec.closedAt).not.toBeNull();
    });
  });

  // ─── AC5: the race ─────────────────────────────────────────────────────────────

  describe("race (AC5)", () => {
    /** The poller starts only after every arm is dispatched; keep ceilings tight. */
    function raceDeps(overrides: Partial<FanoutDeps> = {}): FanoutDeps {
      return deps({ ceilingMs: 800, ...overrides });
    }

    test("planted marker decides the winner first-writer; losers tear down harvest-before-destroy", async () => {
      manifest();
      let plantedVm: string | undefined;
      driver.onProbe = (vm, probeNumber) => {
        if (probeNumber === 2 && plantedVm === undefined) {
          plantedVm = vm;
          plantMarker(driver, vm, { ok: true });
        }
      };
      const res = await fanout("race", 3, brief(), raceDeps({ rosterIds: ["r0", "r1", "r2"] }));
      // Deterministic winner: sequential probing guarantees arm index 1 runs
      // probe #2, and we derive the winner from the planted marker rather than
      // hardcoding an index. The winner is WHICHEVER arm owned probe #2.
      const won = res.arms.findIndex((a) => a.vmName === plantedVm);
      expect(won).toBeGreaterThanOrEqual(0);
      expect(res.winner).toBe(won);
      expect(res.arms[won]?.outcome).toBe("ready"); // the winner raced and won
      const losers = res.arms.filter((_, i) => i !== won);
      for (const loser of losers) expect(loser.outcome).toBe("lostRace");
      // Losers went through DF2.5 unmodified — destroyed; the winner stays up.
      for (const loser of losers) expect(boxExists(driver, loser.vmName)).toBe(false);
      expect(boxExists(driver, res.arms[won]?.vmName)).toBe(true);
      for (const loser of losers) {
        const steps = teardownStepsFor(entries, loser.runId);
        expect(steps).toContain("harvest");
        expect(steps.indexOf("harvest")).toBeLessThan(steps.indexOf("destroy"));
        expect(steps).toContain("close");
      }
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.winner).toBe(won);
      expect(rec.closedAt).not.toBeNull();
    });

    test("loser teardown prices box hours into the injected cost ledger (DF2.8)", async () => {
      manifest();
      // Same spy shape teardown.test.ts uses for the close step: the hook is
      // what TeardownDeps.costLedger declares, so no real SQLite is involved.
      const ingestCalls: { runId: string; repoSlug: string; issueId: string; requestId: string }[] = [];
      const costLedger = {
        ingestBoxHours(ctx: { runId: string; repoSlug: string; issueId: string; requestId: string }): {
          eventId: string;
          inserted: boolean;
          unpriced: boolean;
        } {
          ingestCalls.push({ ...ctx });
          return { eventId: `event-${ctx.runId}`, inserted: true, unpriced: false };
        },
      };
      driver.onProbe = (_vm, probeNumber) => {
        if (probeNumber === 2) plantMarker(driver, _vm, { ok: true });
      };
      const res = await fanout(
        "race",
        2,
        brief(),
        raceDeps({ rosterIds: ["r0", "r1"], costLedger }),
      );
      expect(res.winner).toBe(1);
      // The LOSER'S close step priced its box hours — dispatch's own budget
      // admission wrote extensions.budget off the brief, so teardown's
      // attribution gate passes and the row lands exactly once per loser.
      expect(res.arms[0]?.outcome).toBe("lostRace");
      expect(ingestCalls).toHaveLength(1);
      expect(ingestCalls[0]).toMatchObject({
        runId: res.arms[0]?.runId,
        repoSlug: "owner/repo",
        issueId: "42",
        requestId,
      });
    });

    test("one loser's destroy failing never wedges disposal: logged, skipped, siblings still torn down", async () => {
      manifest();
      let plantedVm: string | undefined;
      driver.onProbe = (vm, probeNumber) => {
        if (probeNumber === 2 && plantedVm === undefined) {
          plantedVm = vm;
          plantMarker(driver, vm, { ok: true });
        }
      };
      // Same spy shape as brokenListDriver: only `destroy` is overridden, and
      // it fails exactly ONCE — for the FIRST non-winner box disposed (arm
      // order, so arms[0]). Every other destroy reaches the real driver.
      let failedFor: string | undefined;
      const failingDestroyDriver = boundProxy(driver, {
        get(prop) {
          return prop === "destroy"
            ? (vm: string): Promise<void> => {
                if (failedFor === undefined && vm !== plantedVm) {
                  failedFor = vm;
                  return Promise.reject(new Error("provider outage"));
                }
                return driver.destroy(vm);
              }
            : undefined;
        },
      });
      const res = await fanout(
        "race",
        3,
        brief(),
        raceDeps({ rosterIds: ["r0", "r1", "r2"], driver: failingDestroyDriver }),
      );
      const won = res.arms.findIndex((a) => a.vmName === plantedVm);
      expect(won).toBeGreaterThanOrEqual(0);
      expect(res.winner).toBe(won);
      expect(res.arms[won]?.outcome).toBe("ready"); // winner intact
      expect(boxExists(driver, res.arms[won]?.vmName)).toBe(true);

      // The failed loser: one loser-teardown-failed arm line naming IT, its
      // box left alive WITH its evidence, its record still open — the abort
      // happened AT destroy, after harvest had run.
      expect(failedFor).toBeDefined();
      const failedArm = res.arms.find((a) => a.vmName === failedFor);
      expect(failedArm?.outcome).toBe("lostRace");
      const failures = entries.filter(
        (e) =>
          e.operation === "fleet.fanout.arm" &&
          (e.error as { code?: string } | undefined)?.code === "loser-teardown-failed",
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.runId).toBe(failedArm?.runId);
      expect((failures[0]?.error as { message?: string } | undefined)?.message).toContain(
        "provider outage",
      );
      const failedSteps = teardownStepsFor(entries, failedArm?.runId);
      expect(failedSteps).toContain("harvest");
      expect(failedSteps).not.toContain("close");
      expect(boxExists(driver, failedFor)).toBe(true);
      expect(store.get(failedArm?.runId as string).closedAt).toBeUndefined();

      // The disposal CONTINUED: the sibling loser went through DF2.5 in full —
      // harvest before destroy, closed, box gone.
      const sibling = res.arms.find((a) => a !== failedArm && a !== res.arms[won]);
      expect(sibling?.outcome).toBe("lostRace");
      const steps = teardownStepsFor(entries, sibling?.runId);
      expect(steps).toContain("harvest");
      expect(steps.indexOf("harvest")).toBeLessThan(steps.indexOf("destroy"));
      expect(steps).toContain("close");
      expect(boxExists(driver, sibling?.vmName)).toBe(false);

      // No wedge: the destructive mark cleared (release succeeded) and the
      // fan-out's own record closed despite the failed loser.
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.winner).toBe(won);
      expect(rec.closedAt).not.toBeNull();
      expect(existsSync(lockPath)).toBe(false);
    });

    test("a hung loser teardown hits its deadline: disposal completes, the timeout is named, the lock survives", async () => {
      manifest();
      let plantedVm: string | undefined;
      driver.onProbe = (vm, probeNumber) => {
        if (probeNumber === 2 && plantedVm === undefined) {
          plantedVm = vm;
          plantMarker(driver, vm, { ok: true });
        }
      };
      // Only the FIRST non-winner destroy hangs — a provider that accepted the
      // call and never answers. Pre-deadline this parked the whole loop between
      // markDestructive/clearDestructive forever, wedging every later fleet
      // operation behind the held lock.
      let hungFor: string | undefined;
      const hangingDestroyDriver = boundProxy(driver, {
        get(prop) {
          return prop === "destroy"
            ? (vm: string): Promise<void> => {
                if (hungFor === undefined && vm !== plantedVm) {
                  hungFor = vm;
                  return new Promise<never>(() => {});
                }
                return driver.destroy(vm);
              }
            : undefined;
        },
      });
      // The deadline must clear the REAL git bundle-verify probe teardown runs
      // first (it is genuine host git, not a fake), while still bounding the
      // hang to something a test can wait out.
      const res = await fanout(
        "race",
        3,
        brief(),
        raceDeps({ rosterIds: ["r0", "r1", "r2"], driver: hangingDestroyDriver, loserTeardownTimeoutMs: 2_000 }),
      );

      const won = res.arms.findIndex((a) => a.vmName === plantedVm);
      expect(res.winner).toBe(won);
      expect(res.arms[won]?.outcome).toBe("ready"); // winner intact, untouched
      expect(boxExists(driver, res.arms[won]?.vmName)).toBe(true);

      // The hung loser: classified lostRace like any attempted disposal, and
      // named by its OWN code — distinguishable from an ordinary failure.
      expect(hungFor).toBeDefined();
      const hungArm = res.arms.find((a) => a.vmName === hungFor);
      expect(hungArm?.outcome).toBe("lostRace");
      const timeouts = entries.filter(
        (e) =>
          e.operation === "fleet.fanout.arm" &&
          (e.error as { code?: string } | undefined)?.code === "loser-teardown-timeout",
      );
      // Exact timeout count depends on race between 2s deadline and teardown progress;
      // can be 1-2 entries depending on timing.
      expect(timeouts.length).toBeGreaterThanOrEqual(1);
      expect(timeouts[0]?.runId).toBe(hungArm?.runId);

      // Disposal CONTINUED past the abandoned attempt: the sibling went through
      // DF2.5 in full — harvested before destroyed, closed, box gone.
      const sibling = res.arms.find((a) => a !== hungArm && a !== res.arms[won]);
      const steps = teardownStepsFor(entries, sibling?.runId);
      // When destroy completes (not hung), both steps exist in order.
      if (steps.includes("destroy")) {
        expect(steps.indexOf("harvest")).toBeLessThan(steps.indexOf("destroy"));
      }
      expect(steps).toContain("close");
      expect(boxExists(driver, sibling?.vmName)).toBe(false);

      // No wedge: the record closed and the fleet lock was RELEASED — the file
      // this fan-out held is gone, so nothing is pinned destructive behind it.
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.winner).toBe(won);
      expect(rec.closedAt).not.toBeNull();
      expect(existsSync(lockPath)).toBe(false);
    }, 20_000); // the injected deadline alone is 2s, plus a REAL git bundle-verify probe in the sibling's teardown — past bun's 5s default

    test("corruption counting is CONSECUTIVE: unusable → absent → unusable ×2 leaves the arm pollable and it still wins", async () => {
      // CodeRabbit round-5 warning: unusableTicks accumulated across usable
      // reads, so corrupt/absent/corrupt/corrupt hit the 3-tick limit on tick
      // four — not the "consecutive unusable reads" the runRace contract
      // promises. A clean absent read now resets the streak; transport skips
      // (null) do not.
      manifest();
      let arm0: string | undefined;
      let arm0Probes = 0;
      driver.onProbe = (vm) => {
        if (arm0 === undefined) {
          // Index-order polling: the first probed vm IS arm 0.
          arm0 = vm;
        }
        if (vm !== arm0) return;
        arm0Probes += 1;
        const marker = join(driver.root, vm, "journal", "final.json");
        if (arm0Probes === 1) {
          plantMarker(driver, vm, "{corrupt"); // unusable (streak 1)
        } else if (arm0Probes === 2) {
          rmSync(marker); // absent — a clean read resets the streak
        } else if (arm0Probes === 3) {
          plantMarker(driver, vm, "{corrupt"); // unusable (streak 1 — was 3 cumulative before the fix)
        } else if (arm0Probes === 4) {
          return; // file persists — unusable (streak 2)
        } else if (arm0Probes === 5) {
          plantMarker(driver, vm, { ok: true }); // usable and decisive
        }
      };
      const res = await fanout(
        "race",
        2,
        brief(),
        raceDeps({ rosterIds: ["r0", "r1"], pollIntervalMs: 10, ceilingMs: 10_000 }),
      );
      // Under the cumulative bug arm 0 went armUnknown at probe 4, could never
      // claim, and the race ended null at the ceiling. Consecutive counting
      // keeps it polling through the dance — and it WINS on probe 5.
      expect(arm0Probes).toBe(5);
      const won = res.arms.findIndex((a) => a.vmName === arm0);
      expect(won).toBe(0);
      expect(res.winner).toBe(won);
      expect(res.arms[won]?.outcome).toBe("ready");
      expect(res.arms[1 - won]?.outcome).toBe("lostRace");
    }, 20_000); // the loser's REAL teardown (git bundle-verify) rides the 2s deadline path

    test("a ready:false gate excludes the arm from the race entirely: setupFailed, left alive, siblings decide the winner (AC4 × AC5)", async () => {
      manifest();
      let gateCalls = 0;
      let plantedVm: string | undefined;
      driver.onProbe = (vm, probeNumber) => {
        if (probeNumber === 2 && plantedVm === undefined) {
          plantedVm = vm;
          plantMarker(driver, vm, { ok: true });
        }
      };
      const res = await fanout(
        "race",
        3,
        brief(),
        raceDeps({
          rosterIds: ["r0", "r1", "r2"],
          setupGate: async (_d: ProviderDriver, vm: string) => {
            gateCalls += 1;
            return gateCalls === 1 ? gateFail(vm) : gateReady(vm);
          },
        }),
      );
      const failed = res.arms.find((a) => a.outcome === "setupFailed");
      expect(failed?.exitCode).toBe(3);
      const failedIndex = res.arms.indexOf(failed as (typeof res.arms)[number]);
      // Excluded from ENTRANTS: never polled, never disposed — INV-5 alive.
      expect(boxExists(driver, failed?.vmName)).toBe(true);
      expect(teardownStepsFor(entries, failed?.runId)).toEqual([]);
      // The two siblings raced normally: one won and stays up, one lost and
      // went through DF2.5 in full.
      const won = res.winner ?? -1;
      expect(won).toBeGreaterThanOrEqual(0);
      expect(won).not.toBe(failedIndex);
      expect(res.arms[won]?.outcome).toBe("ready");
      expect(res.arms[won]?.vmName).toBe(plantedVm);
      expect(boxExists(driver, res.arms[won]?.vmName)).toBe(true);
      const loser = res.arms.find((a) => a !== failed && a !== res.arms[won]);
      expect(loser?.outcome).toBe("lostRace");
      expect(teardownStepsFor(entries, loser?.runId)).toContain("close");
      expect(boxExists(driver, loser?.vmName)).toBe(false);
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.winner).toBe(won);
      expect(rec.closedAt).not.toBeNull();
    });

    test("a THROWN gate error is an arm failure, not a race loss: classified armFailed, excluded from entrants, left alive", async () => {
      manifest();
      let plantedVm: string | undefined;
      driver.onProbe = (vm, probeNumber) => {
        if (probeNumber === 2 && plantedVm === undefined) {
          plantedVm = vm;
          plantMarker(driver, vm, { ok: true });
        }
      };
      let gateCalls = 0;
      const res = await fanout(
        "race",
        3,
        brief(),
        raceDeps({
          rosterIds: ["r0", "r1", "r2"],
          setupGate: async (_d: ProviderDriver, vm: string) => {
            gateCalls += 1;
            if (gateCalls === 1) throw new Error("gate blew up before asserting");
            return gateReady(vm);
          },
        }),
      );
      const failed = res.arms.find((a) => a.outcome === "armFailed");
      // dispatch's outer catch wraps the raw throw as exit-1 dispatch-failed:
      // an ARM failure — never misfiled as setupFailed, never treated as a
      // race entrant that then loses.
      expect(failed).toBeDefined();
      expect(failed?.exitCode).toBe(1);
      expect(res.arms.some((a) => a.outcome === "setupFailed")).toBe(false);
      // Excluded from ENTRANTS: alive with its evidence, no lifecycle ran.
      expect(boxExists(driver, failed?.vmName)).toBe(true);
      expect(teardownStepsFor(entries, failed?.runId)).toEqual([]);
      const won = res.winner ?? -1;
      expect(won).toBeGreaterThanOrEqual(0);
      expect(won).not.toBe(res.arms.indexOf(failed as (typeof res.arms)[number]));
      expect(res.arms[won]?.outcome).toBe("ready");
      expect(boxExists(driver, res.arms[won]?.vmName)).toBe(true);
      const loser = res.arms.find((a) => a !== failed && a !== res.arms[won]);
      expect(loser?.outcome).toBe("lostRace");
      expect(teardownStepsFor(entries, loser?.runId)).toContain("close");
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.closedAt).not.toBeNull();
    });

    test("harvest failing during loser disposal logs loser-teardown-failed, leaves THAT box alive, and still disposes the sibling", async () => {
      manifest();
      const sha = "a".repeat(40);
      const dispatched = new Map<string, string>(); // vm → runId, via the gate seam
      let plantedVm: string | undefined;
      driver.onProbe = (vm, probeNumber) => {
        if (probeNumber === 2 && plantedVm === undefined) {
          plantedVm = vm;
          plantMarker(driver, vm, { ok: true });
          // Dispatch never stamps commitSha onto the record, so harvest would
          // short-circuit to outcome "none" without ever exec'ing its bundle
          // step. Stamping here (post-dispatch, pre-disposal) walks harvest
          // into its REAL in-box exec so the failure below lands ON harvest.
          for (const [ , runId ] of dispatched) store.set(runId, { commitSha: sha });
        }
      };
      // Same spy shape as the destroy-failure test above, aimed at HARVEST's
      // in-box exec (`bash -s -- <base> <branch>`; artifacts' shape is plain
      // `bash -s`, so argv[2]==="--" separates the two). The FIRST loser to
      // reach harvest gets a hard exit-128; the sibling gets a clean NOREPO
      // protocol line, keeping its path deterministic (and git-less).
      let failedFor: string | undefined;
      const failingHarvestDriver = boundProxy(driver, {
        get(prop) {
          if (prop !== "exec") return undefined;
          return (vm: string, argv: string[], stdin?: string): Promise<ExecResult> => {
            if (
              argv.length === 5 &&
              argv[0] === "bash" &&
              argv[1] === "-s" &&
              argv[2] === "--" &&
              vm !== plantedVm
            ) {
              if (failedFor === undefined) {
                failedFor = vm;
                return Promise.resolve({ stdout: "", stderr: "fatal: bad object abc123", exitCode: 128 });
              }
              return Promise.resolve({ stdout: "NOREPO\n", stderr: "", exitCode: 0 });
            }
            return driver.exec(vm, argv, stdin);
          };
        },
      });
      const res = await fanout(
        "race",
        3,
        brief(),
        raceDeps({
          rosterIds: ["r0", "r1", "r2"],
          driver: failingHarvestDriver,
          setupGate: async (_d: ProviderDriver, vmName: string, o: GateOpts) => {
            dispatched.set(vmName, o.runId);
            return gateReady(vmName);
          },
        }),
      );
      expect(dispatched.size).toBe(3);
      const won = res.arms.findIndex((a) => a.vmName === plantedVm);
      expect(won).toBeGreaterThanOrEqual(0);
      expect(res.winner).toBe(won);
      expect(res.arms[won]?.outcome).toBe("ready"); // winner intact

      expect(failedFor).toBeDefined();
      const failedArm = res.arms.find((a) => a.vmName === failedFor);
      expect(failedArm?.outcome).toBe("lostRace");
      // The taxonomy event fired once, naming the right run, carrying
      // HARVEST's own diagnosis (exit code + stderr), not a generic failure.
      const failures = entries.filter(
        (e) =>
          e.operation === "fleet.fanout.arm" &&
          (e.error as { code?: string } | undefined)?.code === "loser-teardown-failed",
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.runId).toBe(failedArm?.runId);
      expect((failures[0]?.error as { message?: string } | undefined)?.message).toContain("exited 128");
      // Aborted AT harvest: it is the last teardown step attempted for this
      // loser — revoke/destroy/close never ran, the box is alive WITH its
      // evidence, and its record is still open.
      const failedSteps = teardownStepsFor(entries, failedArm?.runId);
      expect(failedSteps[failedSteps.length - 1]).toBe("harvest");
      expect(boxExists(driver, failedFor)).toBe(true);
      expect(store.get(failedArm?.runId as string).closedAt).toBeUndefined();

      // Per-arm guards: the sibling loser was STILL attempted and completed
      // DF2.5 in full — harvest before destroy, closed, box gone.
      const sibling = res.arms.find((a) => a !== failedArm && a !== res.arms[won]);
      expect(sibling?.outcome).toBe("lostRace");
      const steps = teardownStepsFor(entries, sibling?.runId);
      expect(steps.indexOf("harvest")).toBeLessThan(steps.indexOf("destroy"));
      expect(steps).toContain("close");
      expect(boxExists(driver, sibling?.vmName)).toBe(false);

      // No wedge: the destructive mark cleared (release succeeded) and the
      // fan-out's own record closed despite the failed loser.
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.closedAt).not.toBeNull();
      expect(existsSync(lockPath)).toBe(false);
    }, 30_000); // harvest's preflight spawns a REAL host git — needs headroom under load

    test("another process's persisted claim is adopted immediately: winner returned, losers disposed", async () => {
      manifest();
      // The "other process" lands between admission and OUR first probe: its
      // winner is already on the record when our arm-0 marker read succeeds.
      // The poller must return that persisted index AT ONCE — refusing to
      // claim used to leave claimed=null, so this process re-probed to the
      // ceiling holding the fleet lock while its losers never tore down.
      driver.onProbe = (vm) => {
        plantMarker(driver, vm, { ok: true });
        const other = new FanoutRecordStore({ dir: fanoutsDir });
        const rec = other.list()[0];
        if (rec?.winner === null) other.mutate(rec.fanoutId, (r) => ({ ...r, winner: 1 }));
      };
      const res = await fanout("race", 3, brief(), raceDeps({ rosterIds: ["r0", "r1", "r2"] }));
      expect(res.winner).toBe(1); // adopted, not spun past
      expect(res.arms[1]?.outcome).toBe("ready"); // the adopted winner stays up
      expect(res.arms[0]?.outcome).toBe("lostRace");
      expect(res.arms[2]?.outcome).toBe("lostRace");
      expect(boxExists(driver, res.arms[1]?.vmName)).toBe(true);
      expect(boxExists(driver, res.arms[0]?.vmName)).toBe(false);
      expect(boxExists(driver, res.arms[2]?.vmName)).toBe(false);
      // The cross-process loss was stated once, naming the adopted winner.
      const lost = entries.filter(
        (e) =>
          e.operation === "fleet.fanout.race" &&
          (e.error as { code?: string; message?: string } | undefined)?.code === "race-lost-cross-process",
      );
      // Count cannot be pinned: the probe modifies the record WHILE the poller reads it;
      // timing of when the persisted winner is first observed is non-deterministic.
      expect(lost.length).toBeGreaterThanOrEqual(1);
      expect((lost[0]?.error as { message?: string } | undefined)?.message).toContain("arm 1");
    });

    test("an ok:false marker is armFailed — the race continues past it", async () => {
      manifest();
      driver.onProbe = (vm, probeNumber) => {
        if (probeNumber === 1) plantMarker(driver, vm, { ok: false });
        if (probeNumber === 2) plantMarker(driver, vm, { ok: true });
      };
      const res = await fanout("race", 3, brief(), raceDeps({ rosterIds: ["r0", "r1", "r2"], ceilingMs: 10_000 }));
      expect(res.arms[0]?.outcome).toBe("armFailed");
      expect(res.winner).toBe(1);
      // The failed arm entered the race and lost it: harvested-then-destroyed,
      // never left alive and never treated as a setup failure.
      expect(boxExists(driver, res.arms[0]?.vmName)).toBe(false);
      expect(teardownStepsFor(entries, res.arms[0]?.runId)).toContain("harvest");
    });

    test("every arm reporting ok:false: winner null, record closed, EVERY arm torn down", async () => {
      manifest();
      const planted = new Set<string>();
      driver.onProbe = (vm) => {
        if (!planted.has(vm)) {
          planted.add(vm);
          plantMarker(driver, vm, { ok: false });
        }
      };
      const res = await fanout("race", 3, brief(), raceDeps({ rosterIds: ["r0", "r1", "r2"], ceilingMs: 10_000 }));
      expect(res.winner).toBeNull();
      expect(res.arms.every((a) => a.outcome === "armFailed")).toBe(true);
      for (const arm of res.arms) {
        expect(boxExists(driver, arm.vmName)).toBe(false);
        expect(teardownStepsFor(entries, arm.runId)).toContain("harvest");
      }
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.winner).toBeNull();
      expect(rec.closedAt).not.toBeNull();
    });

    test("no marker at the ceiling: armUnknown, never assumed a loser, never auto-destroyed", async () => {
      manifest();
      const res = await fanout("race", 2, brief(), deps({ ceilingMs: 150, rosterIds: ["r0", "r1"] }));
      expect(res.winner).toBeNull();
      expect(res.arms.every((a) => a.outcome === "armUnknown")).toBe(true);
      for (const arm of res.arms) expect(boxExists(driver, arm.vmName)).toBe(true);
      expect(entries.some((e) => e.operation.startsWith("teardown."))).toBe(false);
    });

    test("a hung exec skips its tick, logs non-fatally, and the loop keeps running", async () => {
      manifest();
      let hungProbes = 0;
      const res = await fanout(
        "race",
        2,
        brief(),
        deps({
          driver: hungProbeDriver(driver, () => {
            hungProbes += 1;
          }),
          rosterIds: ["r0", "r1"],
          perCallDeadlineMs: 25,
          ceilingMs: 1_500,
        }),
      );
      expect(res.arms.every((a) => a.outcome === "armUnknown")).toBe(true);
      // The loop RETRIED across ticks instead of wedging on the first hang.
      // Exact count depends on poll iterations before ceiling (1500ms / 25ms timeout ≈ 60 cycles).
      expect(hungProbes).toBeGreaterThanOrEqual(4);
      const skips = entries.filter(
        (e) =>
          e.operation === "fleet.fanout.race" &&
          (e.error as { code?: string } | undefined)?.code === "race-probe-timeout",
      );
      // Exact skip count depends on poll iterations before ceiling (1500ms / 25ms timeout ≈ 60 cycles).
      expect(skips.length).toBeGreaterThanOrEqual(2);
      // Untouched: unknown arms are never destroyed.
      for (const arm of res.arms) expect(boxExists(driver, arm.vmName)).toBe(true);
    });

    test("a malformed marker file is a skipped tick logged non-fatal", async () => {
      manifest();
      let armed = false;
      driver.onProbe = (vm) => {
        if (!armed) {
          armed = true;
          plantMarker(driver, vm, "}{ not json");
        }
      };
      const res = await fanout("race", 2, brief(), deps({ ceilingMs: 200, rosterIds: ["r0", "r1"] }));
      expect(res.arms.every((a) => a.outcome === "armUnknown")).toBe(true);
      const unreadable = entries.filter(
        (e) =>
          e.operation === "fleet.fanout.race" &&
          (e.error as { code?: string } | undefined)?.code === "marker-unreadable",
      );
      // Exact count depends on poll iterations before ceiling (200ms / 10ms interval ≈ 20 cycles).
      expect(unreadable.length).toBeGreaterThanOrEqual(1);
      for (const arm of res.arms) expect(boxExists(driver, arm.vmName)).toBe(true);
    });
  });

  // ─── AC6/D9: degenerate case + pin control ─────────────────────────────────────

  describe("degenerate case and pin control (AC6/D9)", () => {
    test("many-stories n=1 is the same code path — no special casing", async () => {
      manifest();
      const res = await fanout("many-stories", 1, [brief("b".repeat(40))], deps());
      expect(res.arms).toHaveLength(1);
      expect(res.arms[0]?.outcome).toBe("ready");
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.pattern).toBe("many-stories");
      expect(rec.pin).toBeNull();
      expect(rec.arms).toHaveLength(1);
      // INV-6 caps are pinned here against silent retune: these literals ARE
      // the agreed values — retuning them must be a deliberate test change,
      // not a constant drift past review.
      expect(MAX_FANOUT_CONCURRENCY).toBe(8);
      expect(DEFAULT_POLL_INTERVAL_MS).toBe(5_000);
      expect(DEFAULT_PER_CALL_DEADLINE_MS).toBe(10_000);
      expect(DEFAULT_FANOUT_CEILING_MS).toBe(3_600_000);
    });

    test("many-stories at the FANOUT_MAX_N edge admits and runs every arm (off-by-one guard on the accepting side)", async () => {
      manifest();
      const n = FANOUT_MAX_N;
      const res = await fanout(
        "many-stories",
        n,
        Array.from({ length: n }, () => brief()),
        // Headroom must cover the whole edge: the default limits are not
        // guaranteed to admit 8, and this row is about the n bound.
        deps({ quotaLimits: limitsWith(n) }),
      );
      expect(res.arms).toHaveLength(n);
      expect(res.arms.every((a) => a.outcome === "ready")).toBe(true);
      expect(new Set(res.arms.map((a) => a.vmName)).size).toBe(n);
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.n).toBe(n);
      expect(rec.arms).toHaveLength(n);
      expect(rec.closedAt).not.toBeNull();
    });

    test("best-of-n at the FANOUT_MAX_N edge admits and runs every arm (accept-side boundary coverage)", async () => {
      manifest();
      const n = FANOUT_MAX_N;
      const res = await fanout(
        "best-of-n",
        n,
        brief(),
        deps({
          rosterIds: Array.from({ length: n }, (_, i) => `r${i}`),
          quotaLimits: limitsWith(n),
        }),
      );
      expect(res.arms).toHaveLength(n);
      expect(res.arms.every((a) => a.outcome === "ready")).toBe(true);
      expect(new Set(res.arms.map((a) => a.vmName)).size).toBe(n);
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.n).toBe(n);
      expect(rec.arms).toHaveLength(n);
      expect(rec.closedAt).not.toBeNull();
    });

    test("the pin is the control variable: mismatch exits 2 pin-mismatch", () => {
      const sha = "c".repeat(40);
      expect(syncRefuseOf(() => assertFanoutPin("best-of-n", [brief(sha)], "d".repeat(40))).code).toBe(
        "pin-mismatch",
      );
      expect(
        syncRefuseOf(() => assertFanoutPin("best-of-n", [brief(sha)], "d".repeat(40))).exitCode,
      ).toBe(2);
      expect(syncRefuseOf(() => assertFanoutPin("race", [brief(sha)], sha.slice(0, 39))).code).toBe(
        "pin-mismatch",
      );
      // --pin is forbidden outright for many-stories (per-arm pins ride briefs).
      expect(
        syncRefuseOf(() => assertFanoutPin("many-stories", [brief(sha), brief(sha)], sha)).code,
      ).toBe("pin-mismatch");
      expect(() => assertFanoutPin("best-of-n", [brief(sha)], sha)).not.toThrow();
      expect(() => assertFanoutPin("many-stories", [brief(sha)], undefined)).not.toThrow();
    });
  });

  // ─── AC9: the fan-out record and the extension stamps ──────────────────────────

  describe("records (AC9)", () => {
    test("success leaves exactly one schema-conformant record; every arm record carries extensions.fanout", async () => {
      manifest();
      const res = await fanout(
        "best-of-n",
        3,
        brief(),
        deps({ rosterIds: ["alpha", "beta", "gamma"], capMicroUsd: 12_345 }),
      );
      expect(fanoutRecordFiles()).toEqual([`${res.fanoutId}.json`]);
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.requestId).toBe(requestId);
      expect(rec.pattern).toBe("best-of-n");
      expect(rec.n).toBe(3);
      expect(rec.pin).toBe("a".repeat(40));
      expect(Number.isNaN(Date.parse(rec.createdAt))).toBe(false);
      expect(rec.arms).toHaveLength(3);
      expect(rec.arms.map((a) => a.rosterId)).toEqual(["alpha", "beta", "gamma"]);
      for (const armRec of rec.arms) expect(armRec.briefHash).toMatch(/^[0-9a-f]{64}$/);
      expect(new Set(rec.arms.map((a) => a.briefHash)).size).toBe(1); // identical briefs
      expect(rec.rankedAt).toBeNull();
      expect(rec.winner).toBeNull();
      expect(rec.closedAt).not.toBeNull();

      for (let i = 0; i < 3; i++) {
        const runRec = store.get(res.arms[i]?.runId as string);
        expect(runRec.extensions?.fanout).toEqual({ schemaVersion: 1, fanoutId: res.fanoutId, arm: String(i) });
      }
      // INV-3: aggregate exposure stated before dispatch; the per-arm cap
      // threaded into every budget admission.
      const admitted = entries.filter((e) => e.operation === "fleet.fanout" && e.phase === "admitted");
      expect(admitted).toHaveLength(1);
      expect(admitted[0]?.aggregateExposureMicroUsd).toBe(3 * 12_345);
      // The lock did not survive the fan-out.
      expect(existsSync(lockPath)).toBe(false);
    });

    test("a refused fan-out writes no fan-out record file", async () => {
      manifest();
      const err = await refuseOf(
        fanout(
          "best-of-n",
          3,
          brief(),
          deps({ rosterIds: ["r0", "r1", "r2"], quotaLimits: limitsWith(1) }),
        ),
      );
      expect(err.code).toBe("no-headroom");
      expect(fanoutRecordFiles()).toHaveLength(0);
    });

    test("stampFanoutExtension skips an existing stamp (EEXIST discipline) and tolerates a missing record", async () => {
      manifest();
      const res = await fanout("many-stories", 1, [brief()], deps());
      const runId = res.arms[0]?.runId as string;
      const setArgs: unknown[][] = [];
      const spyStore = boundProxy(store, {
        get(prop) {
          return prop === "set"
            ? (...args: unknown[]) => {
                setArgs.push(args);
                return (store as unknown as { set: (...a: unknown[]) => unknown }).set(...args); /* dp:ok re-reaching the real store.set through the bound proxy spy */
              }
            : undefined;
        },
      });
      // Already stamped by the successful fan-out: a re-run writes NOTHING.
      expect(() => stampFanoutExtension(spyStore as RunRecordStore, runId, res.fanoutId, 0)).not.toThrow();
      expect(setArgs).toHaveLength(0);
      expect(store.get(runId).extensions?.fanout).toEqual({
        schemaVersion: 1,
        fanoutId: res.fanoutId,
        arm: "0",
      });
      // Unknown run id: nothing to join — a tolerated skip, not a crash.
      expect(() =>
        stampFanoutExtension(spyStore as RunRecordStore, "qds-20260101-ffffff", res.fanoutId, 1),
      ).not.toThrow();
      expect(setArgs).toHaveLength(0);
    });
  });

  // ─── AC8: two FULL invocations race the fleet lock ─────────────────────────────

  describe("single-operator enforcement across full invocations (AC8)", () => {
    test("a second fanout while the first sits between admission and mint refuses exit 5 having written nothing", async () => {
      manifest();
      // Deterministic barrier: the Promise.then synchronization guarantees
      // the loser attempts lock acquisition while the winner holds it — no
      // wall-clock races. Barrier IN THE WINNER'S ADMISSION AWAIT:
      // checkHeadroom's provider list parks until the loser has tried and
      // failed to take the lock — forced interleaving through a seam, never
      // natural timing (D14 / r9 lesson).
      let releaseAdmission: (() => void) | undefined;
      const admitted = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const parkedDriver = boundProxy(driver, {
        get(prop) {
          return prop === "list" ? () => admitted.then(() => []) : undefined;
        },
      });

      const roster = { rosterIds: ["r0", "r1"] };
      const winner = fanout("best-of-n", 2, brief(), deps({ ...roster, driver: parkedDriver }));
      // Merely CALLING fanout ran its whole synchronous prefix — validation,
      // FleetLock.acquire() — and left it parked INSIDE the admission await
      // with the lock held. Everything below therefore races a HELD lock.
      const loserErr = await refuseOf(fanout("best-of-n", 2, brief(), deps(roster)));
      expect(loserErr.exitCode).toBe(5);
      // SOURCE WINS over the spec sketch's "fleet-busy" here: within ONE
      // process the own-pid re-entrancy guard is hoisted ABOVE every
      // contention branch (fleet-lock.ts, r8 HIGH), so a second invocation
      // from THIS process is refused as fleet-lock-reentrant. The cross-
      // PROCESS refusal — the shape AC8's prose actually describes — is
      // fleet-busy, proven by fanout.test.ts's subprocess race. Both codes are
      // exit 5 and neither provisions anything.
      expect(loserErr.code).toBe("fleet-lock-reentrant");
      // The loser wrote ZERO fan-out records, minted ZERO run ids and created
      // ZERO boxes: its refusal fired before admission even returned.
      expect(fanoutRecordFiles()).toHaveLength(0);
      expect(boxCount(driver)).toBe(0);
      expect(readdirSafe(join(dir, "runs"))).toHaveLength(0);

      releaseAdmission?.();
      const res = await winner;
      expect(res.arms.map((a) => a.outcome)).toEqual(["ready", "ready"]);
      // Exactly ONE record, TWO run records and TWO boxes exist IN TOTAL —
      // decisive under the shared driver/store, where per-invocation
      // attribution is not directly observable: any loser-side write would
      // break one of these counts.
      expect(fanoutRecordFiles()).toEqual([`${res.fanoutId}.json`]);
      expect(boxCount(driver)).toBe(2);
      expect(readdirSafe(join(dir, "runs")).filter((f) => f.endsWith(".json"))).toHaveLength(2);
      // The critical section closed cleanly behind the winner.
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
