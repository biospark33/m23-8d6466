/**
 * M2.2 AC4 / INV-M2-4 — the observe chain's per-run memory-key teardown
 * (`teardownMemoryKey` inside src/fleet/run-completion.ts, written TDD-RED).
 *
 * The chain must revoke-and-verify the run's per-run memory gateway key BEFORE
 * the box is destroyed — a destroyed box cannot revoke a gateway key — the same
 * revoke → verify → destroy ordering `teardownSandbox` holds for provider
 * credentials (teardown.ts steps 4-6, mirroring credentials.ts :1622-1727).
 * L4's dispatch compensation seam is TOLERATED: a key already revoked reads
 * `already-gone` and is success, never an error.
 *
 * Mock boundary: `teardownSandbox` is seam-patched with the repo's mock.module
 * restore-by-spread idiom (run-completion.test.ts:2146) into a call-order
 * probe — the chain is otherwise REAL (real store, real marker classifier via
 * the FakeDriver interception idiom, real reverify preflight, which refuses
 * fast on a record with no commitSha, so the tail's outcome is incidental to
 * every case here). The ledger is the REAL MemgateLedger over a per-test
 * mkdtemp tmpdir; rows are minted through the honest path (mintRunMemoryKey
 * via memgateDeps). The log sink is captured into one ORDER array together
 * with the stub's calls — the ordering assertions read that single sequence.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FakeDriver } from "../../src/providers/fake-driver.ts";
import type { ExecResult } from "../../src/providers/driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import type { TeardownDeps } from "../../src/providers/teardown.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import { isRunLockDestructive } from "../../scripts/lib/run-lock.ts";
import { BOX_MARKER_PATH_RE } from "../../src/fleet/fanout-primitive.ts";
import {
  observeAndDriveChain,
  teardownMemoryKey,
  type ChainOutcome,
  type RunCompletionDeps,
} from "../../src/fleet/run-completion.ts";
import { memgateDeps, mintRunMemoryKey, revokeRunMemoryKey } from "../../src/memgate/gateway.ts";
import { openReadOnly } from "../../src/memgate/ledger.ts";
import { MEMGATE_ADMIN_KEY, QDS_MEMGATE_LEDGER, QDS_MEMGATE_SIGNING_KEY } from "../../src/memgate/schemas.ts";

// ---------------------------------------------------------------------------
// Fixtures — env discipline, tmpdirs, order recorder, teardown stub, driver
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-10-08T09:00:00.000Z");
const ADMIN_KEY = "mgadm-m22-teardown-0001";
const SIGNING_KEY = "mgsgn-m22-teardown-0001";
const REQ = "req-m22-teardown";
const RUN_ID = "run-m22-a";
const ENV_KEYS = [MEMGATE_ADMIN_KEY, QDS_MEMGATE_SIGNING_KEY, QDS_MEMGATE_LEDGER] as const;

let savedEnv: Record<string, string | undefined> = {};
let mgDir = "";
let runsDir = "";
let store: RunRecordStore;
let logs: LogEntry[] = [];
let restoreLog: (() => void) | undefined;

/** THE call-order recorder: every sink line (`sink:<event>`) and every stub call, one sequence. */
const order: string[] = [];

const ledgerPath = (): string => join(mgDir, "memgate-ledger.db");
const scopedEnv = (): Record<string, string | undefined> => ({
  [MEMGATE_ADMIN_KEY]: ADMIN_KEY,
  [QDS_MEMGATE_SIGNING_KEY]: SIGNING_KEY,
  [QDS_MEMGATE_LEDGER]: ledgerPath(),
});

const TEARDOWN_MODULE = "../../src/providers/teardown.ts";
const realTeardownModule = await import(TEARDOWN_MODULE);
const realTeardownSandbox = realTeardownModule.teardownSandbox;

/**
 * The order probe standing in for teardownSandbox: records entry, fires the
 * injected memoryKeyTeardown hook exactly where the real sequence does (just
 * ahead of its step-4 provider revoke), then records the destroy step
 * (teardown's step 6 — its LAST internal step). Nothing else runs, so the
 * record stays open and reverify's preflight refuses fast.
 */
const teardownStub = async (
  // TeardownDeps directly, not Parameters<typeof realTeardownSandbox>: the
  // module is loaded through a const-specifier dynamic import, which types as
  // any, so Parameters[0] collapses to unknown the moment the body touches it.
  deps: TeardownDeps,
  runId: string,
): Promise<void> => {
  order.push("teardownSandbox");
  // F-002: the real teardownSandbox fires the hook here — a fault throws out
  // (aborting ahead of destroy) and a clean return falls through to destroy.
  await deps.memoryKeyTeardown?.(runId);
  order.push("destroy");
};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  mgDir = mkdtempSync(join(realpathSync(tmpdir()), "qds-m22-mg-"));
  runsDir = mkdtempSync(join(realpathSync(tmpdir()), "qds-m22-runs-"));
  // The process.env fallback leg (case 4) resolves INSIDE the fixture tmpdir,
  // never the repo root's default .sandbox path.
  process.env.QDS_MEMGATE_LEDGER = ledgerPath();
  store = new RunRecordStore({ dir: runsDir });
  logs = [];
  order.length = 0;
  restoreLog = setLogSink((entry) => {
    logs.push(entry as LogEntry);
    const event = (entry as { event?: unknown }).event;
    if (typeof event === "string") order.push(`sink:${event}`);
  });
  mock.module(TEARDOWN_MODULE, () => ({ ...realTeardownModule, teardownSandbox: teardownStub }));
});

afterEach(() => {
  // PIN the real function, never a bare spread: the namespace this module
  // captured at collection is the LIVE export object bun's mock.module writes
  // through — after the stub registration `realTeardownModule.teardownSandbox`
  // IS the stub, so `{ ...realTeardownModule }` would "restore" the stub and
  // poison every later test file importing the teardown module (the repo's
  // idiom pins the captured real fn on restore: run-completion.test.ts:2184,
  // qds-cost.test.ts:1100, dispatch-task.test.ts:1100).
  mock.module(TEARDOWN_MODULE, () => ({ ...realTeardownModule, teardownSandbox: realTeardownSandbox }));
  restoreLog?.();
  restoreLog = undefined;
  rmSync(mgDir, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/**
 * The inline marker fake (run-completion.test.ts's ProbeDriver idiom, settled
 * only): `exec`/`execTimed` both route through `intercept` because
 * `readBoxFile` prefers `execTimed`; marker probes answer the plan, everything
 * else falls through to the real FakeDriver.
 */
class MarkerDriver extends FakeDriver {
  /** Settled marker body — every case here settles on tick 1. */
  body: Record<string, unknown> | null = { runId: RUN_ID, ok: true };
  destroyed: string[] = [];

  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin, undefined);
  }

  override async execTimed(vm: string, argv: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin, timeoutMs);
  }

  override async destroy(vm: string): Promise<void> {
    this.destroyed.push(vm);
  }

  private async intercept(
    vm: string,
    argv: string[],
    stdin: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<ExecResult> {
    const cmd = argv.length >= 3 && argv[0] === "sh" && argv[1] === "-c" && typeof argv[2] === "string" ? argv[2] : "";
    if (cmd.includes("test -f") && BOX_MARKER_PATH_RE.test(cmd)) {
      return this.body === null ? { stdout: "", stderr: "", exitCode: 1 } : { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("cat ") && BOX_MARKER_PATH_RE.test(cmd)) {
      return { stdout: `${JSON.stringify(this.body)}\n`, stderr: "", exitCode: 0 };
    }
    return timeoutMs === undefined ? super.exec(vm, argv, stdin) : super.execTimed(vm, argv, timeoutMs, stdin);
  }
}

/** Seed the minimum record the observer will drive: a box name and the join key. */
function seedRun(runId: string): void {
  store.create(runId);
  store.set(runId, { vmName: `vm-${runId}`, requestId: REQ } as never);
}

/** A full RunCompletionDeps over the fakes; `env` undefined ⇒ process.env fallback. */
function chainDeps(
  env?: Record<string, string | undefined>,
): { driver: MarkerDriver; lockPath: string; drive: () => Promise<ChainOutcome> } {
  const driver = new MarkerDriver(join(runsDir, "boxes"));
  seedRun(RUN_ID);
  const lockPath = join(runsDir, `${RUN_ID}.lock`);
  // hostRoot is deliberately NOT a git worktree and the record carries no
  // commitSha: reverify's preflight refuses fast, so the chain's tail costs
  // nothing and its outcome is incidental to every case here.
  const deps: RunCompletionDeps = {
    driver,
    store,
    runsDir,
    hostRoot: realpathSync(tmpdir()),
    runLock: lockPath as RunCompletionDeps["runLock"],
    keyApi: new FakeKeyApi() as RunCompletionDeps["keyApi"],
    requestId: REQ,
    costLedger: { ingestBoxHours: () => undefined } as unknown as RunCompletionDeps["costLedger"],
    recordAuditLink: () => undefined,
    env,
  };
  return { driver, lockPath, drive: () => observeAndDriveChain(RUN_ID, deps) };
}

/** The honest setup path: a real mint through memgateDeps over the fixture ledger. */
function mintFor(runId: string): string {
  const gd = memgateDeps({ env: scopedEnv(), ledgerPath: ledgerPath(), now: () => NOW_MS });
  return mintRunMemoryKey(gd, { runId, banks: ["bank-a"], ttlMs: 3_600_000, requestId: REQ }).tokenId;
}

function line(event: string, fields: Record<string, unknown> = {}): LogEntry | undefined {
  return logs.find((l) => {
    const rec = l as Record<string, unknown>;
    if (rec.event !== event) return false;
    return Object.entries(fields).every(([k, v]) => rec[k] === v);
  });
}

const sawRevokeWork = (): boolean =>
  order.some((x) => x === "sink:memgate-revoke" || x === "sink:memgate-verify-revoked");

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("M2.2 AC4 / INV-M2-4: the chain's per-run memory-key teardown", () => {
  test("ordering: revoke+verify land INSIDE teardownSandbox (the injected hook) and BEFORE destroy", async () => {
    mintFor(RUN_ID);
    const c = chainDeps(scopedEnv());
    await c.drive();
    const verifyIdx = order.lastIndexOf("sink:memgate-verify-revoked");
    const teardownIdx = order.indexOf("teardownSandbox");
    const destroyIdx = order.indexOf("destroy");
    expect(verifyIdx).toBeGreaterThanOrEqual(0); // the gateway's own verify read happened
    expect(verifyIdx).toBeGreaterThan(teardownIdx); // the hook fires INSIDE the sequence
    expect(destroyIdx).toBeGreaterThan(verifyIdx); // destroy strictly after the verify read
    expect(isRunLockDestructive(c.lockPath)).toBe(false); // happy path: mark armed then cleared
  });

  test("happy revoke: a live per-run row for the run is revoked AND verified (fresh read-only proof)", async () => {
    const tokenId = mintFor(RUN_ID);
    const c = chainDeps(scopedEnv());
    await c.drive();
    // The gateway's OWN lifecycle lines are the per-token record — no second
    // host-side vocabulary for the same lifecycle (story Observability Contract).
    expect(line("memgate-verify-revoked", { tokenId, runId: RUN_ID })).toBeDefined();
    expect(order).toContain("teardownSandbox");
    const ro = openReadOnly(ledgerPath());
    try {
      expect(ro.isRevoked(tokenId)).toBe(true); // the verify read is the proof, never the write's answer
    } finally {
      ro.close();
    }
  });

  test("L4 seam: an already-revoked key reads already-gone — never an error, chain proceeds", async () => {
    const tokenId = mintFor(RUN_ID);
    // L4's dispatch compensation outcome, produced by the real gateway in setup.
    revokeRunMemoryKey(memgateDeps({ env: scopedEnv(), ledgerPath: ledgerPath() }), { tokenId, requestId: REQ });
    const c = chainDeps(scopedEnv());
    const out = await c.drive();
    expect(order).toContain("teardownSandbox"); // proceeded — the revoke leg did not fault
    expect(line("memgate-skip")).toBeUndefined(); // a row existed; this was revoke work, not a skip
    const ro = openReadOnly(ledgerPath());
    try {
      expect(ro.isRevoked(tokenId)).toBe(true); // still revoked — nothing un-revoked, nothing stranded
    } finally {
      ro.close();
    }
    // Not a revoke fault: whatever the incidental reverify tail did, the
    // teardown leg itself never failed.
    expect(out.kind === "chain-failed" ? out.step : "").not.toBe("teardown");
  });

  test("no per-run key for the run: one skip line (no-per-run-key-for-run), teardown still runs, no revoke", async () => {
    mintFor("run-m22-other"); // the ledger exists and is in use — just not by THIS run
    // The operator's exported env — the process.env FALLBACK leg (deps.env
    // undefined), pointed at the fixture ledger by beforeEach.
    process.env[MEMGATE_ADMIN_KEY] = ADMIN_KEY;
    process.env[QDS_MEMGATE_SIGNING_KEY] = SIGNING_KEY;
    const c = chainDeps();
    await c.drive();
    expect(line("memgate-skip", { reason: "no-per-run-key-for-run", runId: RUN_ID })).toBeDefined();
    expect(order).toContain("teardownSandbox");
    expect(sawRevokeWork()).toBe(false);
  });

  test("memgate env absent: one skip line (env-absent), chain proceeds untouched", async () => {
    const c = chainDeps({}); // injected env with NOTHING configured
    await c.drive();
    expect(line("memgate-skip", { reason: "env-absent", runId: RUN_ID })).toBeDefined();
    expect(order).toContain("teardownSandbox");
    expect(sawRevokeWork()).toBe(false);
  });

  test("F-003: env set but the ledger FILE is absent → skip (ledger-absent), teardown proceeds, no revoke", async () => {
    // A mint is the only thing that creates the ledger: env-present +
    // file-absent means no key was ever minted on this host — ABSENCE, not
    // corruption, so the leg SKIPS instead of wedging every later teardown on
    // ledger-unreadable. (The fail-closed case below holds a lock on an
    // EXISTING ledger — the corruption arm, unaffected by this skip.)
    const env = { ...scopedEnv(), [QDS_MEMGATE_LEDGER]: join(mgDir, "never-minted.db") };
    const c = chainDeps(env);
    await c.drive();
    expect(line("memgate-skip", { reason: "ledger-absent", runId: RUN_ID })).toBeDefined();
    expect(order).toContain("teardownSandbox");
    expect(sawRevokeWork()).toBe(false);
  });

  test("INV-M2-4 fail-closed: a revoke-leg fault propagates — guardedTeardown NEVER runs, destroy unreachable", async () => {
    mintFor(RUN_ID);
    // The injection: a second connection holds a BEGIN IMMEDIATE (RESERVED)
    // lock on the ledger — the READ-ONLY scan still reads (SHARED locks ride
    // alongside RESERVED), but the revoke leg's INSERT cannot promote to
    // EXCLUSIVE and, past busy_timeout, recordRevocation throws a REAL
    // ledger-unwritable MemgateError out of revokeRunMemoryKey. (The dir-mode
    // route is unavailable: assertDirMode0700 CHMODS the dir back to 0700 as
    // owner, so a widened mode self-heals instead of refusing.)
    const holder = new Database(ledgerPath());
    try {
      holder.exec("BEGIN IMMEDIATE");
      const c = chainDeps(scopedEnv());
      const out = await c.drive();
      expect(out.kind).toBe("chain-failed");
      expect(out.kind === "chain-failed" ? out.step : "").toBe("teardown");
      // The stub ENTERED (the hook fault threw from inside it, past the entry
      // record) but never reached its destroy record.
      expect(order).toContain("teardownSandbox");
      expect(order).not.toContain("destroy");
      expect(c.driver.destroyed).toEqual([]);
      // CHOKE-POINT proof: the mark was armed and NEVER cleared — the throw
      // surfaced INSIDE guardedTeardown's try (tornDown stayed false), so the
      // finally kept the destructive mark for the operator.
      expect(isRunLockDestructive(c.lockPath)).toBe(true);
    } finally {
      holder.close();
    }
  }, 20_000);

  test("paranoia: two per-run rows for the same runId — BOTH revoked and verified", async () => {
    const a = mintFor(RUN_ID);
    const b = mintFor(RUN_ID); // mint imposes no per-run uniqueness (token_id is the PK)
    const c = chainDeps(scopedEnv());
    await c.drive();
    const ro = openReadOnly(ledgerPath());
    try {
      expect(ro.isRevoked(a)).toBe(true);
      expect(ro.isRevoked(b)).toBe(true);
    } finally {
      ro.close();
    }
    expect(logs.filter((l) => (l as Record<string, unknown>).event === "memgate-verify-revoked")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F-002: the hook on a DIRECT teardownSandbox call — the destroy paths that
// bypass guardedTeardown (`fleet teardown`, `sandbox-teardown`, fan-out loser
// disposal) are covered by the SAME injected leg, fired by the sequence itself
// just ahead of its step-4 provider revoke.
// ---------------------------------------------------------------------------

describe("F-002 / INV-M2-4: the injected hook fires on a DIRECT teardownSandbox call", () => {
  // A vmName-less, keyless record: the git preflight is gated on either being
  // present (teardown.ts), so this shape reaches the hook with no host git —
  // the cheapest REAL sequence that still destroys (runId fallback) + closes.
  const directDeps = (hook: TeardownDeps["memoryKeyTeardown"]): { driver: MarkerDriver; deps: TeardownDeps } => {
    const driver = new MarkerDriver(join(runsDir, "boxes"));
    store.create(RUN_ID);
    store.set(RUN_ID, { requestId: REQ } as never);
    const origDestroy = driver.destroy.bind(driver);
    driver.destroy = (vm: string) => {
      order.push("destroy");
      return origDestroy(vm);
    };
    return {
      driver,
      deps: {
        driver,
        store,
        runsDir,
        recordAuditLink: () => undefined,
        memoryKeyTeardown: hook,
      },
    };
  };

  test("order: memory revoke+verify land BEFORE destroy on the direct path; teardown completes", async () => {
    mintFor(RUN_ID);
    const { deps } = directDeps((runId) => teardownMemoryKey({ env: scopedEnv() }, runId, { requestId: REQ }));
    await realTeardownSandbox(deps, RUN_ID, join(runsDir, `${RUN_ID}.lock`) as Parameters<typeof realTeardownSandbox>[2], {
      noHarvest: true,
    });
    const verifyIdx = order.lastIndexOf("sink:memgate-verify-revoked");
    const destroyIdx = order.indexOf("destroy");
    expect(verifyIdx).toBeGreaterThanOrEqual(0); // the hook really revoked
    expect(destroyIdx).toBeGreaterThan(verifyIdx); // destroy strictly after the verify read
    expect(store.get(RUN_ID).closedAt).toBeDefined(); // the sequence completed
  });

  test("fail-closed: a hook fault on the direct path rejects BEFORE destroy — box alive, record open", async () => {
    const { driver, deps } = directDeps(() => {
      throw new Error("memgate-revoke-refused");
    });
    await expect(
      realTeardownSandbox(deps, RUN_ID, join(runsDir, `${RUN_ID}.lock`) as Parameters<typeof realTeardownSandbox>[2], {
        noHarvest: true,
      }),
    ).rejects.toThrow("memgate-revoke-refused"); // asTeardownError preserves the message
    expect(order).not.toContain("destroy");
    expect(driver.destroyed).toEqual([]);
    expect(store.get(RUN_ID).closedAt).toBeUndefined(); // never closed over a live key
  });

  // Structural, deliberately: behavioral proof that the bypass sites pass the
  // hook would need a full CLI/reaper/fanout rig per file — disproportionate
  // for a wiring assertion. The two cases above prove the firing semantics;
  // this pins that the wiring exists where F-002 said it was missing.
  // reaper.ts is named for the PASSTHROUGH (SweepDeps.memoryKeyTeardown → the
  // sweep's teardownDeps): without it, sandbox-reap's binding is dead wiring
  // the provider layer silently drops.
  test("wiring: every DIRECT destroy path constructs its TeardownDeps with the hook", () => {
    const root = resolve(import.meta.dir, "../..");
    for (const rel of [
      "scripts/fleet.ts",
      "scripts/sandbox-teardown.ts",
      "src/fleet/fanout-primitive.ts",
      "scripts/sandbox-reap.ts",
      "scripts/cap-hit-demo.ts",
      "src/providers/reaper.ts",
    ]) {
      expect(readFileSync(join(root, rel), "utf8").includes("memoryKeyTeardown")).toBeTrue();
    }
  });
});
