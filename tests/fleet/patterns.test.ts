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
import { goodLedger } from "./helpers.ts";
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
      expect((await refuseOf(fanout("many-stories", 3, brief() as unknown as Brief[], deps()))).code).toBe(
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
      const bad = { ...brief(), commitSha: "not-a-sha" } as unknown as Brief;
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
      expect((err as unknown as { exitStatus?: string }).exitStatus).toBeUndefined();
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
      expect((err as unknown as { exitStatus?: string }).exitStatus).toBe("transient");
      expect(fanoutRecordFiles()).toHaveLength(0);
      expect(boxCount(driver)).toBe(0);
    });
  });

  // ─── AC2/AC3: isolation and mint ordering ──────────────────────────────────────

  describe("isolation and mint ordering (AC2/AC3)", () => {
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
  });

  // ─── AC5: the race ─────────────────────────────────────────────────────────────

  describe("race (AC5)", () => {
    /** The poller starts only after every arm is dispatched; keep ceilings tight. */
    function raceDeps(overrides: Partial<FanoutDeps> = {}): FanoutDeps {
      return deps({ ceilingMs: 800, ...overrides });
    }

    test("planted marker decides the winner first-writer; losers tear down harvest-before-destroy", async () => {
      manifest();
      driver.onProbe = (_vm, probeNumber) => {
        if (probeNumber === 2) plantMarker(driver, _vm, { ok: true });
      };
      const res = await fanout("race", 3, brief(), raceDeps({ rosterIds: ["r0", "r1", "r2"] }));
      expect(res.winner).toBe(1); // probe #2 belongs to arm index 1 (sequential probing)
      expect(res.arms[1]?.outcome).toBe("ready"); // the winner raced and won
      expect(res.arms[0]?.outcome).toBe("lostRace");
      expect(res.arms[2]?.outcome).toBe("lostRace");
      // Losers went through DF2.5 unmodified — destroyed; the winner stays up.
      expect(boxExists(driver, res.arms[0]?.vmName)).toBe(false);
      expect(boxExists(driver, res.arms[2]?.vmName)).toBe(false);
      expect(boxExists(driver, res.arms[1]?.vmName)).toBe(true);
      for (const loser of [res.arms[0], res.arms[2]]) {
        const steps = teardownStepsFor(entries, loser?.runId);
        expect(steps).toContain("harvest");
        expect(steps.indexOf("harvest")).toBeLessThan(steps.indexOf("destroy"));
        expect(steps).toContain("close");
      }
      const rec = new FanoutRecordStore({ dir: fanoutsDir }).get(res.fanoutId);
      expect(rec.winner).toBe(1);
      expect(rec.closedAt).not.toBeNull();
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
      expect(res.arms[0]?.exitCode).not.toBe(3);
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
      expect(hungProbes).toBeGreaterThanOrEqual(4);
      const skips = entries.filter(
        (e) =>
          e.operation === "fleet.fanout.race" &&
          (e.error as { code?: string } | undefined)?.code === "race-probe-timeout",
      );
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
      // The INV-6 caps are imported constants, never mirrored literals.
      expect(MAX_FANOUT_CONCURRENCY).toBe(8);
      expect(DEFAULT_POLL_INTERVAL_MS).toBe(5_000);
      expect(DEFAULT_PER_CALL_DEADLINE_MS).toBe(10_000);
      expect(DEFAULT_FANOUT_CEILING_MS).toBe(3_600_000);
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
                return (store as unknown as { set: (...a: unknown[]) => unknown }).set(...args);
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
});
