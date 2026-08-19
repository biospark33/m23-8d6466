/**
 * DF2.4 — the cap-hit demo: host-side provider cap detection, overflow classification,
 * wall-clock race, teardown invoked on every verdict, artifact redaction, and the
 * MANDATORY e2e demo (live: real capped key, real spend, verified kill).
 *
 * Tests cover: demonstrated path (AC1/DOD), self-report trap (AC2), host-produced
 * inputs provenance (AC2 INV-2), wall-clock-first (AC3), cap-below-first-turn (AC4),
 * teardown on host-error, record schema invariants, leak scan (INV-4), script smoke,
 * and the live gate (DOD).
 *
 * The script `scripts/cap-hit-demo.ts` does not exist when these tests are written
 * (TDD RED) — imports will fail until implementation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeRun, type ProviderDriver } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore, CORE_FIELDS } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { teardownSandbox, type TeardownDeps } from "../../src/providers/teardown.ts";
import { FakeKeyApi } from "./fixtures/fake-key-api.ts";
import { RecordingDriver } from "./fixtures/recording-driver.ts";
import { leakScan } from "./fixtures/leak-scan.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "cap-hit-demo.ts");

// ponytail: module import of missing script is RED by design — implementation follows
import { runCapHitDemo, type CapHitDemoDeps, type CapHitDemoOptions, type CapHitDemoResult } from "../../scripts/cap-hit-demo.ts";

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

// ─── 1. AC1/DOD e2e (fake substrate) — demonstrated path ────────────────────────

describe("AC1/DOD e2e (fake substrate) — demonstrated path", () => {
  test("demonstrated: exhausted key + 2 turns + 402 re-probe → overflow, verdict demonstrated", async () => {
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

    // Teardown STILL invoked — assert record closed and box destroyed
    expect(result.artifact.closedAt).toBeString();
    const rec = store.get(result.runId);
    expect(rec.closedAt).toBeString();
    expect(rec.vmName).toBeDefined();
    // FakeDriver box destroyed: boxes dir empty or recording saw destroy
    expect(existsSync(join(dir, "boxes", rec.vmName ?? ""))).toBeFalse();
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

  // ─── 9. turnsCompleted only downgrades ────────────────────────────────────────

  // Covered by test 5: turnsCompleted 0 → inconclusive despite overflow inputs.

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

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        Promise.race([proc.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1_200_000))]),
      ]);

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

  test("script smoke: subprocess exits 0, artifact exists, verdict valid enum", async () => {
    const res = await cli(["--driver", "fake", "--cap", "50000"]);

    expect(res.exitCode).toBe(0);

    // Parse last line as JSON
    const lines = res.stdout.trim().split("\n");
    const result = JSON.parse(lines[lines.length - 1] ?? "");

    // Artifact file exists under evidenceDir
    expect(existsSync(result.artifactPath)).toBeTrue();
    expect(result.artifactPath.startsWith(evidenceDir)).toBeTrue();

    // Verdict is valid enum
    expect(["demonstrated", "inconclusive"]).toContain(result.verdict);
  });
});
