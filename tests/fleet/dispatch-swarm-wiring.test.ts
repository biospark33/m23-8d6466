/**
 * S1 rig_swarm WIRING (F-013): `mintAndDeliverKey`'s swarm branch — the piece
 * between `seatKeyPlan` (unit-tested in dispatch-seat-plan.test.ts) and
 * `mintSeatKeys`/`deliverSeatKeys` (unit-tested in providers/credentials).
 * `mintAndDeliverKey` is module-private, so these drive it through `dispatch()`
 * with a rig_swarm manifest and the same fake-deps harness
 * dispatch.test.ts uses — copied idiom, not shared fixture, so a drift in one
 * file's harness cannot silently change what the other proves.
 *
 * What is pinned here and nowhere else:
 * 1. seatPlan actually THREADS: the clamped plan dispatch computes is what
 *    reaches the provider (seat names + exact clamped limits on the POSTs).
 * 2. mint → deliver ORDER, via the audit store's insertion-ordered rows.
 * 3. The swarm abandoned-step payloads (F-009): a mint that lands after the
 *    refusal names EVERY seat it left live — `{seats:[{seat, hashPrefix,
 *    capMicroUsd}]}`, hash PREFIX only — and a late deliver names the box and
 *    the seat count — `{vmName, seatsDelivered}`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { SWARM_KEYS_DIR } from "../../src/providers/credentials.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import {
  FleetError,
  dispatch,
  type DispatchDeps,
} from "../../src/fleet/dispatch.ts";
import { goodLedger, useTempAuditStore } from "./helpers.ts";
import { type AuditLinkRow, openAuditStoreForWalk } from "../../src/audit/link-store.ts";

/** DF5.3: dispatch resolves the audit DB itself; these rows are its output. */
const auditDb = useTempAuditStore();

function auditRows(runId: string): AuditLinkRow[] {
  const handle = openAuditStoreForWalk(auditDb.path());
  try {
    return handle.linksForRun(runId);
  } finally {
    handle.close();
  }
}

/** A clock that starts at a fixed instant and only moves when a test moves it. */
function stepClock(): { clock: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return {
    clock: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * Settle once ONE abandoned-phase line has reached the sink, then wait for the
 * abandoned-line count to hold steady across two hops — a sibling step's line
 * arriving late must not slip into the assertions below. (Shared idiom with
 * dispatch.test.ts's `abandonedLine`, which owns the full commentary.)
 */
async function abandonedLine(
  entries: LogEntry[],
  match: (e: LogEntry) => boolean,
): Promise<LogEntry> {
  if (!entries.some(match)) {
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (entries.some(match)) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });
  }
  const settleBy = Date.now() + 250;
  const abandonedCount = (): number => entries.filter((e) => e.phase === "abandoned").length;
  let seen = abandonedCount();
  let quietHops = 0;
  while (quietHops < 2 && Date.now() < settleBy) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = abandonedCount();
    quietHops = next === seen ? quietHops + 1 : 0;
    seen = next;
  }
  const lines = entries.filter((e) => e.phase === "abandoned");
  expect(lines).toHaveLength(1);
  return lines[0] as LogEntry;
}

describe("dispatch rig_swarm wiring: seatPlan → mintSeatKeys → deliverSeatKeys (F-013/F-009)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  let keyApi: FakeKeyApi;
  let entries: LogEntry[] = [];
  let restoreLog: (() => void) | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "df3-swarm-")));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new FakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    entries = [];
    restoreLog = setLogSink((e) => entries.push(e));
  });

  afterEach(() => {
    restoreLog?.();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A one-phase rig_swarm brief. Authored budgets sum ABOVE the admitted
   * ceiling on purpose: the plan these tests see must be dispatch's CLAMPED
   * one, so any seatPlan threading break shows up as wrong limits on the wire.
   */
  function swarmBrief(): {
    repoSlug: string;
    issueId: number;
    commitSha: string;
    manifestPath: string;
    repoUrl: string;
  } {
    const manifestPath = join(dir, "manifests", "pipeline.json");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        phases: [
          // The schema refuses a single-phase manifest (phaseCount ≥ 2); the
          // code phase is filler that never runs — the gate stub ends dispatch.
          { name: "plan", kind: "code", description: "Plan the change", command: ["true"], maxDurationMs: 10_000, retries: 0 },
          {
            name: "swarm",
            kind: "rig_swarm",
            description: "Run the rig swarm to settle the objective",
            maxDurationMs: 10_000,
            rigSpec: {
              name: "demo-rig",
              pods: [
                { id: "pod-1", members: [{ id: "lead", model: "claude/lead" }, { id: "worker", model: "claude/worker" }] },
              ],
            },
            objective: "Do the thing",
            leadSeat: "lead",
            // Σ 60M authored vs the 50M admitted ceiling — proportional shares.
            seatBudgets: { lead: 40_000_000, worker: 20_000_000 },
            testCommand: ["true"], // I4/#325: required on rig_swarm now
          },
        ],
      }),
    );
    return {
      repoSlug: "owner/repo",
      issueId: 42,
      commitSha: "a".repeat(40),
      manifestPath: "manifests/pipeline.json",
      repoUrl: "https://github.com/owner/repo",
    };
  }

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

  /**
   * Stub the swarm-key DELIVER execs only. Their scripts carry the fixed
   * absolute `SWARM_KEYS_DIR` (/opt/qds/…) — a real-box path a FakeDriver
   * child cannot honour (the same reason credentials.test.ts stubs the driver
   * for these scripts; live E2E owns the real path). Everything else — fill's
   * clones, the gate — passes through to the real FakeDriver, so an intercept
   * keyed on stdin alone would hang fill's first exec and deadlock the clock.
   * Returns the 0600 confirmation for the write arm, empty stdout otherwise;
   * `onWrite`, when given, runs in the write arm before that answer (the clock
   * spend and the gated hang of the late-delivery test).
   */
  function stubSwarmDeliver(onWrite?: () => Promise<void> | void): void {
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      const script = String(argv[2] ?? "");
      if (!script.includes(SWARM_KEYS_DIR)) return realExec(vm, argv, stdin);
      if (onWrite !== undefined && script.includes("cat >")) {
        await onWrite();
      }
      return { exitCode: 0, stdout: script.includes("cat >") ? "600" : "", stderr: "" };
    };
  }

  /** The gate stub from dispatch.test.ts's gate-failure family: fail AFTER key. */
  function failingGate(overrides: Partial<DispatchDeps> = {}): Partial<DispatchDeps> {
    return {
      setupGate: async (_drv, vm) => ({
        ready: false,
        failedItem: "A" as const,
        assertionCode: 1 as const,
        assertions: [{ item: "A" as const, ok: false, note: "swarm-wiring-stop" }],
        debugCommands: [],
        teardownCommand: "teardown",
        vm,
      }),
      ...overrides,
    };
  }

  test("the clamped seatPlan threads through to the mint, and deliver follows mint", async () => {
    stubSwarmDeliver();
    let err: FleetError | undefined;
    try {
      await dispatch(swarmBrief(), deps(failingGate()));
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError); // the gate stub, AFTER key+fill
    const runId = err?.payload?.runId as string;
    expect(typeof runId).toBe("string");

    // seatPlan threading, on the wire: the shares dispatch computed from the
    // 60M-authored / 50M-ceiling pair — (40M·50M)/60M = 33_333_333 and
    // (20M·50M)/60M = 16_666_666, BigInt-exact floor division — are what the
    // provider was asked to mint, under the seat key names.
    expect(
      keyApi.requests.filter((r) => r.method === "POST").map(({ name, limitUsd }) => ({ name, limitUsd })),
    ).toEqual([
      { name: `sbx-${runId}-lead`, limitUsd: 33.333333 },
      { name: `sbx-${runId}-worker`, limitUsd: 16.666666 },
    ]);

    // mint → deliver ORDER: the audit rows are insertion-ordered, and the only
    // two events the key hop emits are one mint per seat then one deliver per
    // seat.
    expect(auditRows(runId).filter((r) => r.event === "mint" || r.event === "deliver").map((r) => r.event))
      .toEqual(["mint", "mint", "deliver", "deliver"]);
  });

  test("an ABANDONED swarm mint names EVERY seat it left live — prefix, cap, never the plaintext", async () => {
    const { clock, advance } = stepClock();
    const DEFAULT_TIMEOUT_MS = 600_000; // the production default, uninjected
    const EARLY_LEFT_MS = 30_000;
    const TARGET_LEFT_MS = 900;
    // Two-stage clock spend (dispatch.test.ts's scheme): inside `create` spend
    // all but 30 s; at the requestId stamp — the last synchronous seam before
    // `within("mint")` arms — spend down to 900 ms, so mint alone holds the
    // short timer.
    const realCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      const vm = await realCreate(name, tag);
      advance(DEFAULT_TIMEOUT_MS - EARLY_LEFT_MS);
      return vm;
    };
    const realSet = store.set.bind(store);
    store.set = (id: string, patch: Parameters<RunRecordStore["set"]>[1]) => {
      if (Object.keys(patch).length === 1 && "requestId" in patch) {
        advance(EARLY_LEFT_MS - TARGET_LEFT_MS);
      }
      return realSet(id, patch);
    };
    const knownKey = "sk-or-v1-abandonedswarmkey31337";
    let releaseMint: () => void = () => {};
    const minting = new Promise<void>((r) => {
      releaseMint = r;
    });
    let mintCalls = 0;
    keyApi.createKey = async (name: string, limitUsd: number) => {
      // GATED, not slept: the mint completes only once the test releases it,
      // after `dispatch` has already refused — abandoned by construction.
      await minting;
      const hash = name.endsWith("-lead") ? "d00dfeed" : "beefbeef";
      mintCalls += 1;
      return { key: knownKey, hash, limitUsd, usageUsd: 0 };
    };

    let err: FleetError | undefined;
    try {
      await dispatch(swarmBrief(), deps({ clock }));
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    expect(err?.code).toBe("dispatch-timeout");
    expect(err?.payload?.step).toBe("mint");

    releaseMint();
    const line = await abandonedLine(entries, (e) => e.phase === "abandoned" && e.step === "mint");
    expect((line.error as { code?: string }).code).toBe("abandoned-step-succeeded");
    // F-009's payload: one row per PLANNED seat — 8-char hash PREFIX + "…"
    // (the full hash is the record's business, INV-4 posture) and each seat's
    // planned cap, because "live" and "can spend N µ$" are different incidents.
    // The caps are the CLAMPED plan's (40M/20M authored ÷ 60M → shares of the
    // 50M ceiling), so a payload built from the authored budgets fails here.
    expect(line.seats).toEqual([
      { seat: "lead", hashPrefix: "d00dfeed…", capMicroUsd: 33_333_333 },
      { seat: "worker", hashPrefix: "beefbeef…", capMicroUsd: 16_666_666 },
    ]);
    // Both seats were asked for before the abandonment (the clock is what
    // expired; the mints were merely held).
    expect(mintCalls).toBe(2);
    // INV-4: the hash prefix, never the plaintext — this is a log sink.
    expect(JSON.stringify(line)).not.toContain(knownKey);
    expect(JSON.stringify(line)).not.toContain("sk-or-v1-");
  });

  test("a LATE swarm deliver names the box and the seat count it may have reached", async () => {
    const { clock, advance } = stepClock();
    const DEFAULT_TIMEOUT_MS = 600_000;
    const EARLY_LEFT_MS = 30_000;
    const TARGET_LEFT_MS = 900;
    let boxName = "";
    const realCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      const vm = await realCreate(name, tag);
      boxName = vm.name;
      return vm;
    };
    // Two-stage clock spend, INSIDE mint (the seats mint sequentially): the
    // first seat spends all but 30 s; the second spends down to 900 ms. Both
    // advances land before `within("mint")` resolves, so DELIVER is the step
    // that arms a 900 ms real timer — an advance made inside deliver's own
    // exec would be too late: the timer was armed at step start.
    let mintCalls = 0;
    const realCreateKey = keyApi.createKey.bind(keyApi);
    keyApi.createKey = async (name: string, limitUsd: number) => {
      if (mintCalls++ === 0) advance(DEFAULT_TIMEOUT_MS - EARLY_LEFT_MS);
      else advance(EARLY_LEFT_MS - TARGET_LEFT_MS);
      return realCreateKey(name, limitUsd);
    };
    // `deliverSeatKeys`' write (`cat >` against SWARM_KEYS_DIR) blocks until
    // the test releases it — abandoned first by construction. Keyed on the
    // swarm path via stubSwarmDeliver's detection, never on `stdin !==
    // undefined`: fill's execs would otherwise be the first to hang.
    let releaseDeliver: () => void = () => {};
    const delivering = new Promise<void>((r) => {
      releaseDeliver = r;
    });
    stubSwarmDeliver(() => delivering);

    let err: FleetError | undefined;
    try {
      await dispatch(swarmBrief(), deps({ clock }));
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    expect(err?.code).toBe("dispatch-timeout");
    expect(err?.payload?.step).toBe("deliver");

    releaseDeliver();
    const line = await abandonedLine(entries, (e) => e.phase === "abandoned" && e.step === "deliver");
    expect((line.error as { code?: string }).code).toBe("abandoned-step-succeeded");
    // F-009's deliver payload: the box the seat keys REACHED after the
    // operator was told the dispatch failed, and how many seats rode along.
    expect(line.vmName).toBe(boxName);
    expect(line.seatsDelivered).toBe(2);
  });
});
