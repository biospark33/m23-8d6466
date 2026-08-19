/**
 * DF2.4 — the cap-hit demo: host-side provider cap detection, overflow classification,
 * wall-clock race, teardown invoked on every verdict, artifact redaction, and the
 * MANDATORY e2e demo (live: real capped key, real spend, verified kill).
 *
 * Tests cover: demonstrated path (AC1/DOD), self-report trap (AC2), host-produced
 * inputs provenance (AC2 INV-2), wall-clock-first (AC3), cap-below-first-turn (AC4),
 * teardown on host-error, record schema invariants, leak scan (INV-4), script smoke,
 * and the live gate (DOD).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderDriver } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore, CORE_FIELDS } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { FakeKeyApi } from "./fixtures/fake-key-api.ts";
import { RecordingDriver } from "./fixtures/recording-driver.ts";
import { leakScan } from "./fixtures/leak-scan.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "cap-hit-demo.ts");

import { runCapHitDemo, type CapHitDemoDeps, type CapHitDemoOptions } from "../../scripts/cap-hit-demo.ts";

let dir: string;
let store: RunRecordStore;
let api: FakeKeyApi;
let recording: RecordingDriver;
let driver: FakeDriver;
let logs: LogEntry[];
let restoreLog: (() => void) | undefined;
let evidenceDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df24-"));
  store = new RunRecordStore(join(dir, "runs"));
  driver = new FakeDriver(join(dir, "boxes"));
  recording = new RecordingDriver(driver);
  api = new FakeKeyApi();
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
  evidenceDir = join(dir, "evidence");
});

afterEach(() => {
  restoreLog?.();
  rmSync(dir, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function deps(overrides: Partial<CapHitDemoDeps> = {}): CapHitDemoDeps {
  return { driver: recording, keyApi: api, store, evidenceDir, envFile: "app/.env", ...overrides };
}

/** Default opts for fake substrate (driver.name !== "exedev"). */
function defaultOpts(overrides: Partial<CapHitDemoOptions> = {}): CapHitDemoOptions {
  return {
    capMicroUsd: 50_000,
    wallClockMs: 5_000, // short for test speed
    workloadArgv: ["true"],
    evidenceDir,
    ...overrides,
  };
}

/** Fixed artifact key set per DOD contract — exact order required for assertion. */
const ARTIFACT_KEYS = [
  "story",
  "runId",
  "requestId",
  "substrate",
  "capMicroUsd",
  "spendMicroUsd",
  "turnsCompleted",
  "turnsSource",
  "rejectionStatus",
  "providerCapRejected",
  "terminationProvenance",
  "exitStatus",
  "killOrigin",
  "revocationVerified",
  "closedAt",
  "verdict",
  "reason",
  "runBudgetCapMicros",
  "residentCeilingMicros",
  "keyHash",
  "timings",
  "recordedAt",
] as const;

/** Subprocess runner for script-e2e tests. */
async function cli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  env.QDS_RUNS_DIR = join(dir, "runs");
  env.QDS_EVIDENCE_DIR = evidenceDir;
  env.QDS_FAKE_KEY_API = "1"; // script constructs FakeKeyApi when set
  env.PATH = process.env.PATH ?? "";
  const proc = Bun.spawn({
    cmd: ["bun", SCRIPT, ...args],
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Reaps the workload child on the paths where the demo closes the run while
 * the exec is still pending (grace-expired, cancel destroy-failed): FakeDriver
 * exec spawns a real child the demo then abandons — without awaiting it here
 * the sleep outlives the test and can hold the bun test process open.
 */
class WorkloadReapDriver implements ProviderDriver {
  readonly name: string;
  workloadSettled: Promise<unknown> = Promise.resolve();
  constructor(private readonly inner: ProviderDriver) {
    this.name = inner.name;
  }
  create(name: string, tag?: string): Promise<import("../../src/providers/driver").ProviderVm> {
    return this.inner.create(name, tag);
  }
  list(name?: string): Promise<import("../../src/providers/driver").ProviderVm[]> {
    return this.inner.list(name);
  }
  destroy(vm: string): Promise<void> {
    return this.inner.destroy(vm);
  }
  expose(vm: string, port: number): Promise<string> {
    return this.inner.expose(vm, port);
  }
  setPublic(vm: string): Promise<void> {
    return this.inner.setPublic(vm);
  }
  whoami(): Promise<string> {
    return this.inner.whoami();
  }
  exec(vm: string, argv: string[], stdin?: string): Promise<import("../../src/providers/driver").ExecResult> {
    const p = this.inner.exec(vm, argv, stdin);
    if (argv[0] === "sleep") this.workloadSettled = p.then(() => undefined, () => undefined);
    return p;
  }
  copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    return this.inner.copyFile(vm, remotePath, localPath);
  }
}

// ─── 1. AC1/DOD e2e (fake substrate) — demonstrated path ────────────────────────

describe("AC1/DOD e2e (fake substrate) — demonstrated path", () => {
  test("demonstrated: exhausted key + 2 turns + 403 re-probe → overflow, verdict demonstrated", async () => {
    // usageOnCreateUsd 0.06 ≥ cap 0.05 → key born exhausted
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    const opts = defaultOpts({
      workloadArgv: ["sh", "-c", "printf 'turn_end\\nturn_end\\n'"],
    });

    const result = await runCapHitDemo(deps(), opts);

    // Verdict and classification
    expect(result.verdict).toBe("demonstrated");
    expect(result.artifact.exitStatus).toBe("overflow");
    expect(result.artifact.killOrigin).toBe("provider-cap");
    expect(result.artifact.reason).toBeNull();

    // Spend and cap
    expect(result.artifact.spendMicroUsd).toBe(60_000); // 0.06 USD → µ$
    expect(result.artifact.capMicroUsd).toBe(50_000);

    // Turns
    expect(result.artifact.turnsCompleted).toBe(2);
    expect(result.artifact.turnsSource).toBe("in-box");

    // Teardown completed
    expect(result.artifact.closedAt).toBeString();
    expect(result.artifact.revocationVerified).toBeTrue();

    // Artifact file existence and permissions
    expect(existsSync(result.artifactPath)).toBeTrue();
    const stat = statSync(result.artifactPath);
    expect(stat.mode & 0o777).toBe(0o600); // file 0600
    const dirStat = statSync(join(result.artifactPath, ".."));
    expect(dirStat.mode & 0o777).toBe(0o700); // dir 0700

    // Artifact schema — exact key set
    const keys = Object.keys(result.artifact).sort() as (typeof ARTIFACT_KEYS)[number][];
    expect(keys).toEqual([...ARTIFACT_KEYS].sort());

    // Timings present with required sub-keys
    expect(result.artifact.timings).toBeDefined();
    expect(result.artifact.timings.mint_ms).toBeNumber();
    expect(result.artifact.timings.setup_ms).toBeNumber();
    expect(result.artifact.timings.workload_ms).toBeNumber();
    expect(result.artifact.timings.reprobe_ms).toBeNumber();
    expect(result.artifact.timings.capture_spend_ms).toBeNumber();
    expect(result.artifact.timings.teardown_ms).toBeNumber();
  });

  // ─── 2. AC2 self-report trap ────────────────────────────────────────────────

  test("AC2 self-report trap: box reports transient but host-side overflow → still demonstrated", async () => {
    // usage 0.06 ≥ cap 0.05 → key exhausted at birth
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    const opts = defaultOpts({
      workloadArgv: ["sh", "-c", "printf 'turn_end\\nturn_end\\n'; echo boom >&2; exit 1"], // exitCode 1 → inBoxExit "transient", but with turns
    });

    const result = await runCapHitDemo(deps(), opts);

    // Host-side evidence outranks box self-report
    expect(result.verdict).toBe("demonstrated");
    expect(result.artifact.exitStatus).toBe("overflow");
    expect(result.artifact.killOrigin).toBe("provider-cap");
    // inBoxExit was "transient" but classification overrode to overflow
  });

  // ─── 3. AC2 host-produced inputs — box-claimed rejection ignored ──────────────

  test("AC2 host-produced: chatStatus 500 → providerCapRejected false → NOT overflow", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06, chatStatus: 500 });
    const opts = defaultOpts({ workloadArgv: ["true"] });

    const result = await runCapHitDemo(deps(), opts);

    // No 402 from re-probe → providerCapRejected false → NOT overflow
    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("no-rejection");
    expect(result.artifact.providerCapRejected).toBeFalse();
    // Host-side fields preserved
    expect(result.artifact.spendMicroUsd).toBe(60_000);
    expect(result.artifact.exitStatus).toBe("success"); // inBoxExit passthrough
  });

  test("AC2 host-produced: chatStatus 402 but usage BELOW cap → NOT overflow", async () => {
    // usage 0.01 < cap 0.05 → not exhausted
    api = new FakeKeyApi({ usageOnCreateUsd: 0.01, chatStatus: 402 });
    const opts = defaultOpts({ workloadArgv: ["true"] });

    const result = await runCapHitDemo(deps(), opts);

    // providerCapRejected true but usage < cap → NOT overflow
    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("no-rejection");
    expect(result.artifact.providerCapRejected).toBeTrue(); // 402 observed
    expect(result.artifact.exitStatus).toBe("success");
  });

  test("AC2: 403 'Key limit exceeded' (the MEASURED live signature, 2026-08-19) counts as cap rejection → overflow", async () => {
    // Live fire measured the key-limit rejection as HTTP 403, not 402 — the
    // probe classifier must accept both.
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06, chatStatus: 403 });
    const opts = defaultOpts({
      workloadArgv: ["sh", "-c", "printf 'turn_end\\n'"],
    });

    const result = await runCapHitDemo(deps(), opts);

    expect(result.artifact.providerCapRejected).toBeTrue();
    expect(result.artifact.exitStatus).toBe("overflow");
    expect(result.verdict).toBe("demonstrated");
    expect(result.artifact.rejectionStatus).toStartWith("403:");
  });

  test("AC2 negative control (DOD): box stdout CLAIMS a cap rejection the host re-probe does not reproduce → inconclusive", async () => {
    // The workload's own output says "402 Insufficient credits" — an
    // implementation sourcing providerCapRejected from box output MUST fail
    // this test (INV-2): the host re-probe (chatStatus 500) does not
    // reproduce the claim, so the verdict may not be overflow.
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06, chatStatus: 500 });
    const opts = defaultOpts({
      workloadArgv: ["sh", "-c", "printf 'error 402 Insufficient credits turn_end\\n'"],
    });

    const result = await runCapHitDemo(deps(), opts);

    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("no-rejection");
    expect(result.artifact.providerCapRejected).toBeFalse(); // host probe, not box stdout
    expect(result.artifact.exitStatus).not.toBe("overflow");
    // The artifact's rejection status is the HOST probe's (500), not the box's claim
    expect(result.artifact.rejectionStatus).toStartWith("500:");
    // …and the box's CLAIMED rejection never entered it (INV-2: host-produced only)
    expect(result.artifact.rejectionStatus).not.toContain("402");
    expect(result.artifact.rejectionStatus).not.toContain("Insufficient credits");
  });

  // ─── 4. AC3 wall-clock-first ─────────────────────────────────────────────────

  test("AC3 wall-clock-first: sleep 2 with 300ms ceiling → wall-clock provenance, teardown invoked", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 }); // exhausted, but wall-clock fires first
    const opts = defaultOpts({
      wallClockMs: 300,
      workloadArgv: ["sleep", "2"],
    });

    const result = await runCapHitDemo(deps(), opts);

    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("wall-clock-first");
    expect(result.artifact.terminationProvenance).toBe("wall-clock");
    expect(result.artifact.exitStatus).not.toBe("overflow");
    // The wall-clock branch records the elapsed ceiling, not a default zero.
    expect(result.artifact.timings.workload_ms).toBeGreaterThanOrEqual(300);

    // Teardown STILL invoked — assert record closed and box destroyed
    expect(result.artifact.closedAt).toBeString();
    const rec = store.get(result.runId);
    expect(rec.closedAt).toBeString();
    expect(rec.vmName).toBeDefined();
    // FakeDriver box destroyed: boxes dir empty or recording saw destroy
    expect(existsSync(join(dir, "boxes", rec.vmName!))).toBeFalse();
  });

  // ─── 4b. Entry validation (programmatic callers) ─────────────────────────────

  test("entry validation: bad numeric options reject before createRun — no run is ever created", async () => {
    // runCapHitDemo is an exported contract, not just main()'s CLI path: a
    // NaN/∞/zero/negative option must throw at the entry point (NaN wallClockMs
    // would fire ~immediately; NaN budget/ceiling render as null in JSON)
    // BEFORE createRun, so no record or box exists to strand.
    const badOpts: Partial<CapHitDemoOptions>[] = [
      { capMicroUsd: 0 },
      { capMicroUsd: -1 },
      { capMicroUsd: Number.NaN },
      { capMicroUsd: Number.POSITIVE_INFINITY },
      { wallClockMs: 0 },
      { wallClockMs: Number.NaN },
      { runBudgetCapMicros: -5 },
      { runBudgetCapMicros: Number.NaN },
      { residentCeilingMicros: 0 },
      { residentCeilingMicros: Number.NEGATIVE_INFINITY },
    ];
    for (const bad of badOpts) {
      await expect(runCapHitDemo(deps(), { ...defaultOpts(), ...bad })).rejects.toThrow(
        /must be a positive integer, got/,
      );
    }
    // Nothing was created — the throw happened before store.create.
    expect(store.list()).toHaveLength(0);
  });

  // ─── 4c. Wall-clock cancel on a no-execTimed substrate ───────────────────────

  test("wall-clock cancel: workload destroyed and settled BEFORE the probe reads the key", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    // FakeDriver has no execTimed, so the workload runs through the plain
    // executeRun fallback — the path whose wall-clock expiry must cancel.
    // Observe the ordering through the seam: destroy (the cancel verb) and
    // the workload exec's settlement must both precede the probe.
    const events: string[] = [];
    class OrderingDriver implements ProviderDriver {
      readonly name = recording.name;

      constructor(private readonly inner: ProviderDriver) {}

      create(name: string, tag?: string): Promise<import("../../src/providers/driver").ProviderVm> {
        return this.inner.create(name, tag);
      }
      list(name?: string): Promise<import("../../src/providers/driver").ProviderVm[]> {
        return this.inner.list(name);
      }
      destroy(vm: string): Promise<void> {
        return this.inner.destroy(vm).then(() => {
          events.push("destroy");
        });
      }
      expose(vm: string, port: number): Promise<string> {
        return this.inner.expose(vm, port);
      }
      setPublic(vm: string): Promise<void> {
        return this.inner.setPublic(vm);
      }
      whoami(): Promise<string> {
        return this.inner.whoami();
      }
      exec(vm: string, argv: string[], stdin?: string): Promise<import("../../src/providers/driver").ExecResult> {
        const p = this.inner.exec(vm, argv, stdin);
        if (argv[0] === "sleep") {
          events.push("workload-start");
          return p.then((res) => {
            events.push("workload-end");
            return res;
          });
        }
        return p;
      }
      copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
        return this.inner.copyFile(vm, remotePath, localPath);
      }
    }
    const probe = async (): Promise<{ status: number; body: string }> => {
      events.push("probe");
      return { status: 403, body: "Key limit exceeded" };
    };

    const opts = defaultOpts({ wallClockMs: 300, workloadArgv: ["sleep", "2"] });
    const result = await runCapHitDemo(deps({ driver: new OrderingDriver(recording), probe }), opts);

    expect(result.artifact.terminationProvenance).toBe("wall-clock");
    expect(result.artifact.reason).toBe("wall-clock-first");
    const destroyAt = events.indexOf("destroy");
    const workloadEndAt = events.indexOf("workload-end");
    const probeAt = events.indexOf("probe");
    expect(destroyAt).toBeGreaterThan(-1);
    expect(workloadEndAt).toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(-1);
    // Cancel verb fired at expiry…
    expect(destroyAt).toBeGreaterThan(events.indexOf("workload-start"));
    // …and settlement was awaited to completion BEFORE the probe ran.
    expect(workloadEndAt).toBeLessThan(probeAt);
    // Teardown still completed on every path (AC3).
    expect(result.artifact.closedAt).toBeString();
    const rec4c = store.get(result.runId);
    expect(rec4c.vmName).toBeDefined();
    expect(existsSync(join(dir, "boxes", rec4c.vmName!))).toBeFalse();
  });

  // ─── 4d. Cancel failure → fail-closed: probe never issued ────────────────────

  test("cancel destroy-failed: NO probe while the workload may be active, teardown still closes the run", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    // First destroy (the cancel verb) throws; teardown's own destroy (second
    // call) succeeds so the record still closes.
    let destroyCalls = 0;
    class FirstDestroyThrowsDriver implements ProviderDriver {
      readonly name = recording.name;

      constructor(private readonly inner: ProviderDriver) {}

      create(name: string, tag?: string): Promise<import("../../src/providers/driver").ProviderVm> {
        return this.inner.create(name, tag);
      }
      list(name?: string): Promise<import("../../src/providers/driver").ProviderVm[]> {
        return this.inner.list(name);
      }
      destroy(vm: string): Promise<void> {
        destroyCalls++;
        if (destroyCalls === 1) return Promise.reject(new Error("destroy refused"));
        return this.inner.destroy(vm);
      }
      expose(vm: string, port: number): Promise<string> {
        return this.inner.expose(vm, port);
      }
      setPublic(vm: string): Promise<void> {
        return this.inner.setPublic(vm);
      }
      whoami(): Promise<string> {
        return this.inner.whoami();
      }
      exec(vm: string, argv: string[], stdin?: string): Promise<import("../../src/providers/driver").ExecResult> {
        return this.inner.exec(vm, argv, stdin);
      }
      copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
        return this.inner.copyFile(vm, remotePath, localPath);
      }
    }
    let probeCalls = 0;
    const probe = async (): Promise<{ status: number; body: string }> => {
      probeCalls++;
      return { status: 403, body: "Key limit exceeded" };
    };

    const opts = defaultOpts({ wallClockMs: 300, workloadArgv: ["sleep", "2"] });
    // WorkloadReapDriver sits INSIDE the destroy-throwing wrapper so the demo's
    // abandoned sleep child is still reaped at test end (this path closes the
    // run without awaiting the exec's settlement).
    const reaper = new WorkloadReapDriver(recording);
    const result = await runCapHitDemo(deps({ driver: new FirstDestroyThrowsDriver(reaper), probe }), opts);

    // The probe was never issued — no provider evidence read while the
    // workload's termination was unconfirmed.
    expect(probeCalls).toBe(0);
    expect(result.artifact.providerCapRejected).toBeFalse();
    expect(result.artifact.rejectionStatus).toBeNull();
    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("workload-cancel-failed");
    expect(result.artifact.terminationProvenance).toBe("wall-clock");
    // Teardown still ran (AC3): its destroy succeeded on the retry, the
    // record closed, and the artifact's spend is teardown's own pre-revoke
    // read off the record (not the skipped explicit capture).
    expect(destroyCalls).toBe(2);
    expect(result.artifact.closedAt).toBeString();
    expect(result.artifact.spendMicroUsd).toBe(60_000);
    // Reap the abandoned sleep child (see WorkloadReapDriver).
    await reaper.workloadSettled;
  });

  test("cancel grace-expired: workload still pending past the grace → NO probe, reason workload-cancel-failed", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    let probeCalls = 0;
    const probe = async (): Promise<{ status: number; body: string }> => {
      probeCalls++;
      return { status: 403, body: "Key limit exceeded" };
    };

    // 300ms ceiling → marker at ~1.3s; 200ms grace expires while the 4s
    // sleep is still pending (termination unconfirmed) — the demo must skip
    // the probe rather than read evidence against an active workload.
    const opts = defaultOpts({ wallClockMs: 300, workloadArgv: ["sleep", "4"] });
    const reaper = new WorkloadReapDriver(recording);
    const result = await runCapHitDemo(deps({ driver: reaper, probe, cancelGraceMs: 200 }), opts);

    expect(probeCalls).toBe(0);
    expect(result.artifact.providerCapRejected).toBeFalse();
    expect(result.artifact.rejectionStatus).toBeNull();
    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("workload-cancel-failed");
    expect(result.artifact.terminationProvenance).toBe("wall-clock");
    // The cancel destroy DID land here, so teardown proceeds normally and
    // the run closes on every path (AC3).
    expect(result.artifact.closedAt).toBeString();
    expect(result.artifact.revocationVerified).toBeTrue();
    expect(result.artifact.spendMicroUsd).toBe(60_000);
    // Reap the still-pending sleep child the demo correctly stopped waiting on.
    await reaper.workloadSettled;
  });

  // ─── 4e. Invalid classifier inputs → fail-closed, teardown still runs ───────

  test("negative record cap: classification skipped, inconclusive classification-invalid, teardown revokes the live key", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 }); // probe answers 403 naturally
    // A record file corrupted after mint (mint's INV-CRED-1 cannot produce a
    // negative cap): every read reports limitMicroUsd -1 — finite, so the
    // echoed-cap fallback alone does not catch it.
    class CorruptCapStore extends RunRecordStore {
      get(runId: string) {
        return { ...super.get(runId), limitMicroUsd: -1 };
      }
    }
    const corruptStore = new CorruptCapStore(store.dir);
    const opts = defaultOpts({ workloadArgv: ["sh", "-c", "printf 'turn_end\\n'"] });

    const result = await runCapHitDemo(deps({ store: corruptStore }), opts);

    // Fail-closed: a corrupt cap earns no verdict, even with a real 403 probe.
    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("classification-invalid");
    expect(result.artifact.exitStatus).toBe("success"); // box-reported exit kept
    expect(result.artifact.providerCapRejected).toBeTrue(); // evidence retained
    expect(result.artifact.spendMicroUsd).toBe(60_000);
    // Teardown ran anyway: record closed, key revoked — no live key survives.
    expect(result.artifact.closedAt).toBeString();
    expect(result.artifact.revocationVerified).toBeTrue();
    expect(api.keys.filter((k) => !k.deleted)).toHaveLength(0);
  });

  test("negative captureSpend result (provider refund): inconclusive classification-invalid, teardown revokes the live key", async () => {
    // A negative usage read is REACHABLE provider behavior (refunds) and passes
    // the record's integer validation — without the guard, classifyRunExit
    // throws here, BEFORE teardown, stranding the live key.
    class RefundApi extends FakeKeyApi {
      async getKeyEntry(hash: string, maxPages?: number) {
        const { entry, truncated } = await super.getKeyEntry(hash, maxPages);
        return { entry: entry === null ? entry : { ...entry, usageUsd: -0.000002 }, truncated };
      }
    }
    api = new RefundApi({ usageOnCreateUsd: 0.06 });
    const opts = defaultOpts({ workloadArgv: ["sh", "-c", "printf 'turn_end\\n'"] });

    const result = await runCapHitDemo(deps(), opts);

    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("classification-invalid");
    // The corrupt spend never reaches the artifact as a figure — 0, fail-closed.
    expect(result.artifact.spendMicroUsd).toBe(0);
    expect(result.artifact.closedAt).toBeString();
    expect(result.artifact.revocationVerified).toBeTrue();
    expect(api.keys.filter((k) => !k.deleted)).toHaveLength(0);
  });

  // ─── 5. AC4 cap-below-first-turn ─────────────────────────────────────────────

  test("AC4 cap-below-first-turn: exhausted at birth, zero turns → inconclusive", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 }); // exhausted at birth
    const opts = defaultOpts({ workloadArgv: ["true"] }); // stdout empty → turnsCompleted 0

    const result = await runCapHitDemo(deps(), opts);

    // Overflow classification BUT verdict downgraded by turnsCompleted === 0
    expect(result.artifact.exitStatus).toBe("overflow"); // classification still overflow
    expect(result.artifact.killOrigin).toBe("provider-cap");
    expect(result.verdict).toBe("inconclusive"); // verdict downgraded
    expect(result.artifact.reason).toBe("cap-below-first-turn");
    expect(result.artifact.turnsCompleted).toBe(0);
  });

  // ─── 6. Teardown invoked on host-error path ───────────────────────────────────

  test("host-error path: exec throws during workload → teardown invoked, record closed", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    // Wrap the RecordingDriver to throw on workload argv but delegate otherwise
    class ThrowingDriver implements ProviderDriver {
      readonly name = recording.name;

      constructor(private readonly inner: ProviderDriver) {}

      create(name: string, tag?: string): Promise<import("../../src/providers/driver").ProviderVm> {
        return this.inner.create(name, tag);
      }
      list(name?: string): Promise<import("../../src/providers/driver").ProviderVm[]> {
        return this.inner.list(name);
      }
      destroy(vm: string): Promise<void> {
        return this.inner.destroy(vm);
      }
      expose(vm: string, port: number): Promise<string> {
        return this.inner.expose(vm, port);
      }
      setPublic(vm: string): Promise<void> {
        return this.inner.setPublic(vm);
      }
      whoami(): Promise<string> {
        return this.inner.whoami();
      }
      exec(vm: string, argv: string[], stdin?: string): Promise<import("../../src/providers/driver").ExecResult> {
        // Throw ONLY for workload argv, delegate deliverRunKey's exec
        if (argv[0] === "true" || argv[0] === "sleep") {
          return Promise.reject(new Error("ssh exploded"));
        }
        return this.inner.exec(vm, argv, stdin);
      }
      copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
        return this.inner.copyFile(vm, remotePath, localPath);
      }
    }
    const throwingDriver = new ThrowingDriver(recording);
    const opts = defaultOpts({ workloadArgv: ["true"] });

    const result = await runCapHitDemo(deps({ driver: throwingDriver }), opts);

    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("host-error");
    expect(result.artifact.terminationProvenance).toBe("host-error");

    // Teardown still ran — record closed
    expect(result.artifact.closedAt).toBeString();
    const rec = store.get(result.runId);
    expect(rec.closedAt).toBeString();
  });

  // ─── 7. DF2.1 record gains no field ───────────────────────────────────────────

  test("DF2.1 record gains no field: every key ∈ CORE_FIELDS", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    const opts = defaultOpts({ workloadArgv: ["true"] });

    const result = await runCapHitDemo(deps(), opts);
    const rec = store.get(result.runId);

    // Every record key is in CORE_FIELDS (subset check, not equality)
    const recKeys = Object.keys(rec);
    for (const key of recKeys) {
      expect(Object.hasOwn(CORE_FIELDS, key)).toBeTrue();
    }

    // store.list() does not throw — no stray artifacts in runs dir
    expect(() => store.list()).not.toThrow();

    // Evidence file lives in evidenceDir, NOT runs dir
    expect(result.artifactPath.startsWith(evidenceDir)).toBeTrue();
    expect(result.artifactPath.includes("/runs/")).toBeFalse();
  });

  // ─── 8. Leak scan (AC5/INV-4) ────────────────────────────────────────────────

  test("leak scan: key material does NOT appear in artifact (AC5/INV-4)", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    const opts = defaultOpts({ workloadArgv: ["true"] });

    const result = await runCapHitDemo(deps(), opts);
    const artifactText = readFileSync(result.artifactPath, "utf8");

    // Get the plaintext key from api
    const rec = store.get(result.runId);
    const hash = rec.keyHash;
    if (!hash) throw new Error("no keyHash in record");
    const key = api.plaintexts.get(hash);
    if (!key) throw new Error("no plaintext key in api");

    // Scan: every 8-char window of key must NOT appear in artifact
    const leak = leakScan(key, artifactText);
    expect(leak).toBeNull();

    // keyHash present and NOT the key
    expect(artifactText).toContain(hash);
    expect(artifactText).not.toContain(key);
  });

  test("AC5 hygiene: key-management URL stripped from rejectionStatus, hash stays in keyHash", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    // Live-measured 403 body shape: the message embeds the key-management URL
    // (openrouter.ai/.../keys/<64-hex hash>).
    const urlHash = "e04ffb6c8731607617a7bd457c38d272bdb840fe7efdc5ba0e8c71651648f784";
    const probe = async () => ({
      status: 403,
      body: `{"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/${urlHash}","code":403}}`,
    });
    const opts = defaultOpts({
      workloadArgv: ["sh", "-c", "printf 'turn_end\\n'"],
    });

    const result = await runCapHitDemo(deps({ probe }), opts);

    expect(result.verdict).toBe("demonstrated");
    expect(result.artifact.providerCapRejected).toBeTrue();
    // Management deep-link (and the hash inside it) gone from rejectionStatus...
    expect(result.artifact.rejectionStatus).toContain("Key limit exceeded");
    expect(result.artifact.rejectionStatus).not.toContain("openrouter.ai/workspaces");
    expect(result.artifact.rejectionStatus).not.toContain(urlHash);
    // The rule holds at the SHARED gate too, not just these assertions —
    // the fixture scanner flags management URLs alongside key fragments.
    expect(leakScan("any-secret", JSON.stringify(result.artifact))).toBeNull();
    // ...while the structured keyHash field keeps the deliberate identifier.
    // keyHash is optional on the record type; a missing record hash must FAIL
    // this equality (artifact falls back to the mint-time hash ≠ "").
    const rec = store.get(result.runId);
    expect(result.artifact.keyHash).toBe(rec.keyHash ?? "");
  });

  test("AC2 fail-closed: probe transport failure → probe-error status, verdict inconclusive", async () => {
    const probe = async (): Promise<{ status: number; body: string }> => {
      throw new Error("fetch failed: connection reset");
    };
    const opts = defaultOpts({ workloadArgv: ["sh", "-c", "printf 'turn_end\\n'"] });
    const result = await runCapHitDemo(deps({ probe }), opts);
    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.providerCapRejected).toBeFalse();
    expect(result.artifact.rejectionStatus).toStartWith("probe-error:");
    expect(result.artifact.rejectionStatus).toContain("fetch failed");
  });

  test("AC2/AC5: probe-error redacts a management deep-link in the thrown error text", async () => {
    // Companion to the fail-closed test above: the error message a probe
    // throws can embed the request URL, and its /keys/<id> segment is a
    // management deep-link — the error path gets the SAME redaction the 403
    // body path gets, and this test pins it (placeholder present, raw
    // URL/hash absent, whole artifact scans clean).
    const urlHash = "e04ffb6c8731607617a7bd457c38d272bdb840fe7efdc5ba0e8c71651648f784";
    const probe = async (): Promise<{ status: number; body: string }> => {
      throw new Error(`fetch failed: request to https://openrouter.ai/workspaces/default/keys/${urlHash} aborted`);
    };
    const opts = defaultOpts({ workloadArgv: ["sh", "-c", "printf 'turn_end\\n'"] });
    const result = await runCapHitDemo(deps({ probe }), opts);
    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.rejectionStatus).toStartWith("probe-error:");
    expect(result.artifact.rejectionStatus).toContain("fetch failed");
    expect(result.artifact.rejectionStatus).toContain("[REDACTED]");
    expect(result.artifact.rejectionStatus).not.toContain("openrouter.ai/workspaces");
    expect(result.artifact.rejectionStatus).not.toContain(urlHash);
    expect(leakScan("any-secret", JSON.stringify(result.artifact))).toBeNull();
  });

  // ─── 9. turnsCompleted only downgrades ────────────────────────────────────────

  // Covered by test 5: turnsCompleted 0 → inconclusive despite overflow inputs.

  // ─── 9b. FakeKeyApi.chatComplete contract (the host re-probe substrate) ───────

  test("chatComplete natural path: capped exhausted key → 403 Key limit exceeded (the MEASURED per-key shape)", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    const minted = await api.createKey("df24-chat-contract", 0.05);
    const res = await api.chatComplete(minted.key);
    expect(res.status).toBe(403);
    expect(res.body).toContain("Key limit exceeded");
  });

  test("chatComplete: a revoked (deleted) key authenticates as 401 invalid-key", async () => {
    api = new FakeKeyApi();
    const minted = await api.createKey("df24-chat-revoked", 0.05);
    await api.deleteKey(minted.hash);
    const res = await api.chatComplete(minted.key);
    expect(res.status).toBe(401);
  });

  // ─── 9c. Mint transport failure vs orphan compensation ────────────────────────

  test("mint transport failure after provider-side create: compensation revokes the orphan, verdict inconclusive mint-failed", async () => {
    // The provider registered the key, then the transport "timed out" —
    // mintRunKey's compensation sweep (list by run-scoped name → revoke)
    // must leave NO live orphan, and the demo must fail honestly.
    api = new FakeKeyApi({ mintTransportErrorAfterCreate: true });
    const result = await runCapHitDemo(deps(), defaultOpts());

    expect(result.verdict).toBe("inconclusive");
    expect(result.artifact.reason).toBe("mint-failed");
    expect(api.keys.filter((k) => !k.deleted)).toHaveLength(0);
    expect(result.artifact.keyHash).toBeNull(); // null, not empty string
    // Phase-specific timings on the early-failure artifact: the mint duration
    // lives in mint_ms ONLY (never parked in setup_ms), phases that never ran
    // stay 0, and teardown_ms carries the actually-measured early teardown.
    expect(result.artifact.timings.setup_ms).toBe(0);
    expect(result.artifact.timings.workload_ms).toBe(0);
    expect(result.artifact.timings.reprobe_ms).toBe(0);
    expect(result.artifact.timings.capture_spend_ms).toBe(0);
    // teardown really ran on this path, but its elapsed is clock-granular —
    // assert the field is a populated number, not a fake positive bound.
    expect(result.artifact.timings.teardown_ms).toBeNumber();
  });

  test("mint compensation failure: the provider key stays live AND recoverable by its run-scoped name", async () => {
    // DELETE answers 500, so compensation's revoke fails — the orphan stays
    // live. The record closes with no keyHash (nothing was recorded to revoke),
    // so recovery is by NAME: the provider list still carries the entry keyed
    // to this runId, which is exactly what mintRunKey's sweep matches on.
    api = new FakeKeyApi({ mintTransportErrorAfterCreate: true, deleteStatus: 500 });
    const result = await runCapHitDemo(deps(), defaultOpts());

    expect(result.artifact.reason).toBe("mint-failed");
    const orphan = api.keys.find((k) => !k.deleted);
    expect(orphan).toBeDefined();
    expect(orphan?.name).toContain(result.runId);
    expect(result.artifact.revocationVerified).toBeFalse();
  });

  // ─── keyHash null on mint-fail, revocationVerified requires non-empty string ────

  test("mint-fail artifact emits keyHash null, not empty string", async () => {
    api = new FakeKeyApi({ mintTransportErrorAfterCreate: true });
    const result = await runCapHitDemo(deps(), defaultOpts());

    expect(result.artifact.reason).toBe("mint-failed");
    // keyHash is null when no key was minted (not "")
    expect(result.artifact.keyHash).toBeNull();
    // revocationVerified is false because keyHash is null/missing
    expect(result.artifact.revocationVerified).toBeFalse();
  });

  // ─── probe retry-once on transport error ───────────────────────────────────────

  // ─── probe retry-once on transport error ───────────────────────────────────────

  test("probe that throws once then returns 403 still yields providerCapRejected true", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    let calls = 0;
    const probe = async (): Promise<{ status: number; body: string }> => {
      calls++;
      if (calls === 1) throw new Error("connection reset");
      return { status: 403, body: "Key limit exceeded" };
    };
    const opts = defaultOpts({ workloadArgv: ["sh", "-c", "printf 'turn_end\\n'"] });
    const result = await runCapHitDemo(deps({ probe }), opts);

    expect(calls).toBe(2); // first throw, then retry succeeds
    expect(result.artifact.providerCapRejected).toBeTrue();
    expect(result.artifact.rejectionStatus).toStartWith("403:");
    expect(result.verdict).toBe("demonstrated");
  });

  test("probe that throws twice yields probe-error + providerCapRejected false", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    const probe = async (): Promise<{ status: number; body: string }> => {
      throw new Error("network unreachable");
    };
    const opts = defaultOpts({ workloadArgv: ["sh", "-c", "printf 'turn_end\\n'"] });
    const result = await runCapHitDemo(deps({ probe }), opts);

    expect(result.artifact.providerCapRejected).toBeFalse();
    expect(result.artifact.rejectionStatus).toStartWith("probe-error:");
    expect(result.artifact.rejectionStatus).toContain("network unreachable");
    expect(result.verdict).toBe("inconclusive");
  });

  // ─── turn_end anchored count (line boundaries) ─────────────────────────────────────

  test("stdout 'xturn_endy\\n' not counted; 'turn_end\\n' counted", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06, chatStatus: 403 });
    const opts = defaultOpts({
      workloadArgv: ["sh", "-c", "printf 'xturn_endy\\nturn_end\\n'"],
    });
    const result = await runCapHitDemo(deps(), opts);

    // Only the standalone "turn_end" line counts; embedded substring ignored
    expect(result.artifact.turnsCompleted).toBe(1);
  });

  test("fixture paddingBytes string '10000' → workload-fixture-invalid", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.06 });
    const fixturePath = join(dir, "string-padding.yaml");
    writeFileSync(fixturePath, `model: deepseek/deepseek-v3.2
prompt: test
paddingBytes: "10000"
wall_clock_cap_ms: 900000
provider: openrouter
`);
    const opts = defaultOpts({ fixturePath, workloadArgv: undefined });
    const result = await runCapHitDemo(deps(), opts);

    expect(result.artifact.reason).toBe("workload-fixture-invalid");
    expect(result.verdict).toBe("inconclusive");
  });

  // ─── 10. Live gate (DOD MANDATORY e2e) ─────────────────────────────────────────

  test.todoIf(!process.env.QDS_EXEDEV_LIVE)(
    "live cap-hit kill: real box, real capped key, verified revocation (DOD MANDATORY)",
    async () => {
      const repoUrl = process.env.QDS_EXEDEV_REPO_URL ?? "";
      const sha = process.env.QDS_EXEDEV_SHA ?? "";
      const roster = process.env.QDS_EXEDEV_ROSTER ?? "";
      const provKey = process.env.OPENROUTER_PROVISIONING_KEY ?? "";

      if (!repoUrl || !sha || !roster || !provKey) {
        throw new Error(
          "QDS_EXEDEV_LIVE is set but QDS_EXEDEV_REPO_URL / QDS_EXEDEV_SHA / QDS_EXEDEV_ROSTER / OPENROUTER_PROVISIONING_KEY are not — refusing to run a hollow live-fire",
        );
      }

      // Spawn live demo subprocess
      const liveEvidenceDir = join(dir, "evidence");
      const liveRunsDir = join(dir, "runs");
      const proc = Bun.spawn({
        cmd: [
          "bun",
          "scripts/cap-hit-demo.ts",
          "--driver",
          "exedev",
          "--cap",
          "50000",
          "--repo-url",
          repoUrl,
          "--sha",
          sha,
          "--roster",
          roster,
        ],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          QDS_RUNS_DIR: liveRunsDir,
          QDS_EVIDENCE_DIR: liveEvidenceDir,
          OPENROUTER_PROVISIONING_KEY: provKey,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      // The timeout handle is cleared on every path, and a timeout rejection
      // kills the subprocess before propagating (no orphaned live-fire run).
      let liveTimer: ReturnType<typeof setTimeout> | undefined;
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      try {
        [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          Promise.race([
            proc.exited,
            new Promise<never>((_, reject) => {
              liveTimer = setTimeout(() => reject(new Error("timeout")), 1_200_000);
            }),
          ]),
        ]);
      } finally {
        clearTimeout(liveTimer);
        proc.kill();
      }

      expect(exitCode).toBe(0);

      // Parse result JSON from stdout
      const lines = stdout.trim().split("\n");
      const resultJson = JSON.parse(lines[lines.length - 1] ?? "");
      expect(resultJson.verdict).toBe("demonstrated");
      expect(resultJson.artifact.spendMicroUsd).toBeGreaterThanOrEqual(50_000);
      expect(resultJson.artifact.revocationVerified).toBeTrue();
      expect(resultJson.artifact.exitStatus).toBe("overflow");
      expect(resultJson.artifact.killOrigin).toBe("provider-cap");

      // Artifact file exists
      expect(existsSync(resultJson.artifactPath)).toBeTrue();
    },
  );

  // ─── 11. Script smoke (subprocess) ────────────────────────────────────────────

  test("script smoke: exit code tracks verdict, artifact exists, verdict valid enum", async () => {
    const res = await cli(["--driver", "fake", "--cap", "50000"]);

    // The fake substrate's fresh key is under its cap and the probe answers
    // 200 — inconclusive, and since the exit-code contract only pays out on a
    // demonstrated verdict, the process must fail.
    expect(res.exitCode).toBe(1);

    // Parse last line as JSON
    const lines = res.stdout.trim().split("\n");
    const result = JSON.parse(lines[lines.length - 1] ?? "");

    // Artifact file exists under evidenceDir
    expect(existsSync(result.artifactPath)).toBeTrue();
    expect(result.artifactPath.startsWith(evidenceDir)).toBeTrue();

    // Verdict is valid enum (and matches the exit code above)
    expect(["demonstrated", "inconclusive"]).toContain(result.verdict);
    expect(result.verdict).toBe("inconclusive");
  });
});
