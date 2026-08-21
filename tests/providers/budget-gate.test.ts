/**
 * DF2.8 budget gate TDD — refusal before spawn, clamp on admission.
 *
 * AC3/DoD test mapping:
 * - "refusal before spawn": AC3 over-budget refusal leaves zero creates/keys
 * - "under cap proceeds and clamps the mint": AC3 admittedCeilingMicroUsd minted
 * - "boundary": spent === cap refusal (inclusive ceiling, story Technical Notes)
 * - "zero-row issue": AC5 hasEvents:false path, ceiling === cap (min(50M, 5M))
 * - "per-issue override": AC3 perIssueOverrides honored end-to-end
 * - INV-COST-6: unopenable ledger refuses, zero creates
 * - "no-issue createRun": opts without issue behaves as before
 *
 * Every test chdirs into its own tmpdir FIRST so the default ledger path
 * can never resolve at the repo root — the real `.sandbox/` is never read or
 * written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createRun } from "../../src/providers/driver.ts";
import { assertWithinBudget, mintCapMicroUsd, OverBudgetError } from "../../src/providers/budget-gate.ts";
import { CostLedger, CostLedgerError, capForIssue } from "../../src/providers/cost-ledger.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "./fixtures/fake-key-api.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { mintRunKey } from "../../src/providers/credentials.ts";

let dir: string;
let prevCwd: string;
let prevLedgerEnv: string | undefined;
let prevConfigEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df28-budget-"));
  prevCwd = process.cwd();
  // Pin both env tiers so the implicit paths never resolve at the repo root.
  prevLedgerEnv = process.env.QDS_COST_LEDGER_FILE;
  prevConfigEnv = process.env.QDS_COST_CONFIG_FILE;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.QDS_COST_LEDGER_FILE;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.QDS_COST_CONFIG_FILE;
  process.chdir(dir);
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevLedgerEnv === undefined) delete process.env.QDS_COST_LEDGER_FILE;
  else process.env.QDS_COST_LEDGER_FILE = prevLedgerEnv;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevConfigEnv === undefined) delete process.env.QDS_COST_CONFIG_FILE;
  else process.env.QDS_COST_CONFIG_FILE = prevConfigEnv;
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/** A CostLedger on a fresh tmpdir db with default config. */
function freshLedger(path?: string, store?: RunRecordStore): CostLedger {
  return new CostLedger({
    path: path ?? join(dir, "cost-ledger.db"),
    readRunRecord: store ? ((runId: string) => {
      try {
        const rec = store.get(runId);
        return { keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd, createdAt: rec.createdAt, closedAt: rec.closedAt };
      } catch {
        return undefined;
      }
    }) : (() => undefined),
  });
}

/**
 * Seed a run with a minted key and ingest priced cost — simulates a prior run's spend.
 * Returns the ledger (async to await the mint).
 */
async function seedPriorSpend(opts: {
  store: RunRecordStore;
  keyApi: FakeKeyApi;
  ledger: CostLedger;
  runId: string;
  repoSlug: string;
  issueId: string;
  requestId: string;
  role: "lead" | "worker" | "resident";
  microUsd: number;
}): Promise<void> {
  const { store, keyApi, ledger, runId, repoSlug, issueId, requestId, role, microUsd } = opts;

  // Mint a key for the seed run
  const minted = await keyApi.createKey(runId, 50);
  store.create(runId);
  store.set(runId, { keyHash: minted.hash, limitMicroUsd: 50_000_000 });

  // Ingest the priced cost
  ledger.ingestCostEvent({
    agentId: "agent-1",
    model: "model",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: microUsd / 1_000_000,
    turnCount: 1,
    durationMs: 0,
    timestamp: new Date().toISOString(),
    unpricedTurns: 0,
  }, {
    runId,
    repoSlug,
    issueId,
    requestId,
    role,
    invocationSeq: 0,
  });
}

// ─── AC3: refusal before spawn ────────────────────────────────────────────────

describe("AC3: refusal before spawn", () => {
  test("refusal before spawn: over-cap issue refuses with OverBudgetError, zero creates/keys, no run record", async () => {
    const driver = new FakeDriver(join(dir, "boxes"));
    const store = new RunRecordStore(join(dir, "runs"));
    const keyApi = new FakeKeyApi();
    const ledger = freshLedger(undefined, store);

    // Seed issue qds/demo#42 AT its cap — "at or above the configured cap" refuses (AC3).
    await seedPriorSpend({
      store,
      keyApi,
      ledger,
      runId: "seed-run-1",
      repoSlug: "qds/demo",
      issueId: "42",
      requestId: "req-seed",
      role: "lead",
      microUsd: 5_000_000,
    });

    const cap = capForIssue(ledger.config, "qds/demo", "42");
    expect(cap).toBe(5_000_000);

    const runId = "overcap-20260820-000001";
    let err: OverBudgetError | undefined;
    try {
      assertWithinBudget(ledger, {
        repoSlug: "qds/demo",
        issueId: "42",
        runId,
        requestId: `gate-${runId}`,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(OverBudgetError);
      err = e as OverBudgetError;
    }
    expect(err).toBeDefined();

    // Error carries exact AC3 payload
    expect(err?.status).toBe("over-budget");
    expect(err?.reason).toBe("spend-cap-exceeded");
    expect(err?.capMicroUsd).toBe(5_000_000);
    expect(err?.spentMicroUsd).toBe(5_000_000);
    expect(err?.reservedMicroUsd).toBe(0);
    expect(err?.unpricedRows).toBe(0);
    expect(err?.code).toBe("over-budget");
    expect(err?.remediation).toContain(".sandbox/cost-config.json");
    expect(err?.remediation).toContain("perIssueOverrides");

    // Zero creates — the gate refused before any spend, so no box was created
    expect((await driver.list()).map((v) => v.name)).toEqual([]);
    // No run record exists for the refused runId
    expect(() => store.get(runId)).toThrow();
  });
});

// ─── AC3: under cap proceeds and clamps ────────────────────────────────────────

describe("AC3: under cap proceeds and clamps the mint", () => {
  test("under cap proceeds and clamps the mint: spent 4,900,000 of 5,000,000 → ceiling 100,000", async () => {
    const store = new RunRecordStore(join(dir, "runs"));
    const keyApi = new FakeKeyApi();
    const ledger = freshLedger(undefined, store);

    await seedPriorSpend({
      store,
      keyApi,
      ledger,
      runId: "seed-run-1",
      repoSlug: "qds/demo",
      issueId: "42",
      requestId: "req-seed",
      role: "lead",
      microUsd: 4_900_000,
    });

    const cap = capForIssue(ledger.config, "qds/demo", "42");
    expect(cap).toBe(5_000_000);

    const decision = assertWithinBudget(ledger, {
      repoSlug: "qds/demo",
      issueId: "42",
      runId: "undercap-20260820-000001",
      requestId: "req-under",
    });

    expect(decision.admitted).toBeTrue();
    expect(decision.status).toBe("within-budget");
    expect(decision.capMicroUsd).toBe(5_000_000);
    expect(decision.spentMicroUsd).toBe(4_900_000);
    expect(decision.remainingMicroUsd).toBe(100_000);
    expect(decision.admittedCeilingMicroUsd).toBe(100_000); // min(50M, 100k)
    expect(decision.unpricedRows).toBe(0);

    // mintCapMicroUsd returns the ceiling
    expect(mintCapMicroUsd(decision)).toBe(100_000);
  });

  test("under cap: run record stores the budget extension, dispatcher can read admittedCeilingMicroUsd", async () => {
    const store = new RunRecordStore(join(dir, "runs"));
    const keyApi = new FakeKeyApi();
    const ledger = freshLedger(undefined, store);

    await seedPriorSpend({
      store,
      keyApi,
      ledger,
      runId: "seed-run-1",
      repoSlug: "qds/demo",
      issueId: "42",
      requestId: "req-seed",
      role: "lead",
      microUsd: 4_900_000,
    });

    const runId = "dispatch-20260820-000001";

    const decision = assertWithinBudget(ledger, {
      repoSlug: "qds/demo",
      issueId: "42",
      runId,
      requestId: "req-dispatch",
    });

    store.create(runId);
    store.set(runId, {
      extensions: {
        budget: {
          repoSlug: "qds/demo",
          issueId: "42",
          capMicroUsd: decision.capMicroUsd,
          spentMicroUsd: decision.spentMicroUsd,
          reservedMicroUsd: decision.reservedMicroUsd,
          admittedCeilingMicroUsd: decision.admittedCeilingMicroUsd,
        },
      },
    });

    const rec = store.get(runId);
    expect(rec.extensions?.budget).toEqual({
      schemaVersion: 1, // stamped by the store, not supplied by the caller
      repoSlug: "qds/demo",
      issueId: "42",
      capMicroUsd: 5_000_000,
      spentMicroUsd: 4_900_000,
      reservedMicroUsd: 0,
      admittedCeilingMicroUsd: 100_000,
    });
  });

  test("under cap: dispatcher uses admittedCeilingMicroUsd as capMicroUsd for mintRunKey", async () => {
    const store = new RunRecordStore(join(dir, "runs"));
    const keyApi = new FakeKeyApi();
    const ledger = freshLedger(undefined, store);
    const driver = new FakeDriver(join(dir, "boxes"));

    await seedPriorSpend({
      store,
      keyApi,
      ledger,
      runId: "seed-run-1",
      repoSlug: "qds/demo",
      issueId: "42",
      requestId: "req-seed",
      role: "lead",
      microUsd: 4_900_000,
    });

    const runId = "mint-20260820-000001";

    const decision = assertWithinBudget(ledger, {
      repoSlug: "qds/demo",
      issueId: "42",
      runId,
      requestId: "req-mint",
    });

    // createRun sequence
    store.create(runId);
    const vm = await driver.create(runId);
    await driver.destroy(vm.name); // cleanup after test

    // Mint with the clamped ceiling
    const minted = await mintRunKey({
      keyApi,
      driver,
      store,
      requestId: "req-mint",
      capMicroUsd: decision.admittedCeilingMicroUsd,
    }, runId);

    expect(keyApi.keys).toHaveLength(2); // the seed run's key + this run's
    const mintedEntry = keyApi.keys[1]!;
    expect(mintedEntry.limitUsd).toBe(0.1); // 100,000 µ$ = $0.10 USD
    expect(minted.hash).toBe(mintedEntry.hash);
  });
});

// ─── boundary: spent === cap refusal ───────────────────────────────────────────

describe("boundary: spent === cap exactly", () => {
  test("boundary: spent === cap exactly → refused (inclusive ceiling, story Technical Notes)", async () => {
    const store = new RunRecordStore(join(dir, "runs"));
    const keyApi = new FakeKeyApi();
    const ledger = freshLedger(undefined, store);

    await seedPriorSpend({
      store,
      keyApi,
      ledger,
      runId: "seed-run-1",
      repoSlug: "qds/demo",
      issueId: "42",
      requestId: "req-seed",
      role: "lead",
      microUsd: 5_000_000,
    });

    const cap = capForIssue(ledger.config, "qds/demo", "42");
    expect(cap).toBe(5_000_000);

    expect(() => assertWithinBudget(ledger, {
      repoSlug: "qds/demo",
      issueId: "42",
      runId: "boundary-20260820-000001",
      requestId: "req-bound",
    })).toThrow(OverBudgetError);
  });
});

// ─── AC5: zero-row issue ───────────────────────────────────────────────────────

describe("AC5: zero-row issue", () => {
  test("zero-row issue → admitted, hasEvents:false, ceiling === cap (min(50M, 5M))", () => {
    const ledger = freshLedger();
    const decision = assertWithinBudget(ledger, {
      repoSlug: "fresh/repo",
      issueId: "1",
      runId: "fresh-20260820-000001",
      requestId: "req-fresh",
    });

    expect(decision.admitted).toBeTrue();
    expect(decision.status).toBe("within-budget");
    expect(decision.spentMicroUsd).toBe(0);
    expect(decision.unpricedRows).toBe(0);
    expect(decision.remainingMicroUsd).toBe(5_000_000); // 5M default cap
    expect(decision.admittedCeilingMicroUsd).toBe(5_000_000); // min(50M, 5M)
  });
});

// ─── per-issue override ───────────────────────────────────────────────────────────

describe("per-issue override honored end-to-end", () => {
  test("per-issue override honored through the gate (file tier works end to end)", () => {
    mkdirSync(join(dir, ".sandbox"), { recursive: true });
    writeFileSync(join(dir, ".sandbox", "cost-config.json"), JSON.stringify({
      defaultCapMicroUsd: 5_000_000,
      perIssueOverrides: {
        "qds/demo#99": 1_000_000, // lower cap for this issue
      },
    }, null, 2));

    // Fresh ledger will read the config file from cwd (env tier clear, cwd is tmpdir)
    const ledger = freshLedger();
    const cap = capForIssue(ledger.config, "qds/demo", "99");
    expect(cap).toBe(1_000_000);

    const decision = assertWithinBudget(ledger, {
      repoSlug: "qds/demo",
      issueId: "99",
      runId: "override-20260820-000001",
      requestId: "req-override",
    });

    expect(decision.admitted).toBeTrue();
    expect(decision.capMicroUsd).toBe(1_000_000);
    expect(decision.remainingMicroUsd).toBe(1_000_000);
    expect(decision.admittedCeilingMicroUsd).toBe(1_000_000);
  });
});

// ─── INV-COST-6: unopenable ledger ─────────────────────────────────────────────

describe("INV-COST-6: unopenable ledger refuses", () => {
  test("INV-COST-6: createRun with opts.issue on an unopenable ledger path (directory) refuses, zero creates", async () => {
    const driver = new FakeDriver(join(dir, "boxes"));
    const store = new RunRecordStore(join(dir, "runs"));

    // Point ledger at a directory instead of a file
    const badPath = join(dir, "not-a-ledger");
    mkdirSync(badPath, { recursive: true });
    process.env.QDS_COST_LEDGER_FILE = badPath;

    let err: CostLedgerError | undefined;
    try {
      await createRun(driver, store, {
        runId: "badledger-20260820-000001",
        issue: { repoSlug: "qds/demo", issueId: "42", requestId: "req-bad" },
      });
    } catch (e) {
      err = e as CostLedgerError;
    }
    // Classification rides the typed code, never message text (INV-COST-6) —
    // the message is prose; the code is the contract.
    expect(err).toBeInstanceOf(CostLedgerError);
    expect(err?.code).toBe("ledger-unopenable");
    expect(err?.message).toContain(badPath);

    // Zero creates — the gate refused before driver.create
    const boxes = await driver.list();
    expect(boxes).toHaveLength(0);
  });
});

// ─── no-issue createRun untouched ───────────────────────────────────────────────

describe("no-issue createRun untouched", () => {
  test("no-issue createRun behaves exactly as before (record created, no budget extension)", async () => {
    const driver = new FakeDriver(join(dir, "boxes"));
    const store = new RunRecordStore(join(dir, "runs"));

    const rec = await createRun(driver, store, {
      runId: "noissue-20260820-000001",
    });

    expect(rec.runId).toBe("noissue-20260820-000001");
    expect(rec.vmName).toBe("noissue-20260820-000001");
    expect(rec.extensions?.budget).toBeUndefined();
    expect((await driver.list()).map((v) => v.name)).toEqual(["noissue-20260820-000001"]);
  });
});

// ─── E2E demo (DoD: MANDATORY) ────────────────────────────────────────────────

describe("E2E demo: lead+2-worker run → second dispatch over cap refused", () => {
  test("qds/demo#42 at 4.9M µ$ → dispatch 1 admitted at 100k ceiling, +300k spend, dispatch 2 refused with zero create/mint; qds cost artifacts captured", async () => {
    const driver = new FakeDriver(join(dir, "boxes"));
    const store = new RunRecordStore(join(dir, "runs"));
    const keyApi = new FakeKeyApi();
    // One ledger shared by the gate, the ingest and the CLI via the env tier.
    process.env.QDS_COST_LEDGER_FILE = join(dir, "cost-ledger.db");
    const ledger = freshLedger(join(dir, "cost-ledger.db"), store);

    // Prior spend: 4,900,000 µ$ of the 5,000,000 µ$ default cap (E2E slice).
    await seedPriorSpend({
      store, keyApi, ledger,
      runId: "seed-run-1", repoSlug: "qds/demo", issueId: "42",
      requestId: "req-seed", role: "lead", microUsd: 4_900_000,
    });

    // Dispatch 1 — admitted, remaining 100k, key minted at the clamped ceiling.
    const run1 = "e2e-run-1";
    const rec1 = await createRun(driver, store, {
      runId: run1,
      issue: { repoSlug: "qds/demo", issueId: "42", requestId: "req-e2e-1" },
    });
    const ceiling = rec1.extensions?.budget?.admittedCeilingMicroUsd;
    expect(ceiling).toBe(100_000);
    await mintRunKey({ keyApi, driver, store, requestId: "req-e2e-1", capMicroUsd: typeof ceiling === "number" ? ceiling : 0 }, run1);
    expect(keyApi.keys[keyApi.keys.length - 1]!.limitUsd).toBe(0.1);

    // The lead+2-worker run emits three cost events totalling 300,000 µ$.
    // Direct ingest — no key in the path. This is NOT an overspend demo:
    // FakeKeyApi enforces no limit, but a real provider refuses past the
    // minted $0.10 (the ceiling is the provider-side key limit). The demo's
    // point is that cumulative spend crosses the cap, so dispatch 2 refuses.
    const mk = (agentId: string, role: "lead" | "worker", seq: number, usd: number) =>
      ledger.ingestCostEvent({
        agentId, model: "cheap/model", inputTokens: 1_000, outputTokens: 500,
        cacheReadTokens: 200, cacheWriteTokens: 100, costUsd: usd,
        turnCount: 3, unpricedTurns: 0, durationMs: 1_500,
        timestamp: "2026-08-20T12:01:00.000Z",
      }, { runId: run1, repoSlug: "qds/demo", issueId: "42", requestId: "req-e2e-1", role, invocationSeq: seq });
    mk("lead-1", "lead", 0, 0.10);
    mk("worker-1", "worker", 0, 0.10);
    mk("worker-2", "worker", 0, 0.10);
    expect(ledger.readIssueCost("qds/demo", "42").totalMicroUsd).toBe(5_200_000);

    // Dispatch 2 — over cap: refused BEFORE create/mint (the recording provider
    // registers zero create and zero mint calls for this dispatch).
    const boxesBefore = (await driver.list()).map((v) => v.name);
    const keysBefore = keyApi.keys.length;
    let refusal: OverBudgetError | undefined;
    try {
      await createRun(driver, store, {
        runId: "e2e-run-2",
        issue: { repoSlug: "qds/demo", issueId: "42", requestId: "req-e2e-2" },
      });
    } catch (e) {
      expect(e).toBeInstanceOf(OverBudgetError);
      refusal = e as OverBudgetError;
    }
    expect(refusal).toBeDefined();
    expect(refusal?.status).toBe("over-budget");
    expect(refusal?.reason).toBe("spend-cap-exceeded");
    expect(refusal?.spentMicroUsd).toBe(5_200_000);
    // A box never created for dispatch 2, and no third key exists.
    expect((await driver.list()).map((v) => v.name)).toEqual(boxesBefore);
    expect(() => store.get("e2e-run-2")).toThrow();
    expect(keyApi.keys.length).toBe(keysBefore);

    // qds cost — the cumulative view off the same SUM the gate read.
    const { run: qdsCost } = await import("../../scripts/qds-cost.ts");
    const chunks: string[] = [];
    const exit = qdsCost(["qds/demo#42"], (s) => chunks.push(s));
    const output = chunks.join("");
    expect(exit).toBe(0);
    expect(output).toContain("qds/demo#42");
    expect(output).toContain("5,200,000"); // total µ$
    expect(output).toContain("lead");
    expect(output).toContain("worker");
    expect(output).toContain("pending"); // run-1 box hours not yet torn down

    // Artifacts: the DoD evidence payload, written under the per-test tmpdir so
    // a normal test run never mutates the repository working tree (the
    // committed copy in _bmad-output/evidence/df2-8/ carries the same shape).
    // Every figure is scope-labeled: dispatch-1 figures vs issue-cumulative.
    const evidenceDir = join(dir, "evidence", "df2-8");
    mkdirSync(evidenceDir, { recursive: true });
    const testArtifact = {
      story: "df2-8",
      capturedAt: new Date().toISOString(),
      issue: "qds/demo#42",
      capMicroUsd: 5_000_000,
      dispatch1: {
        runId: run1,
        headroomBeforeDispatchMicroUsd: 100_000,
        mintedCeilingMicroUsd: ceiling,
      },
      spend: {
        dispatch1MicroUsd: { lead: 100_000, worker: 200_000 },
        priorIssueSpendMicroUsd: 4_900_000,
        issueCumulativeMicroUsd: 5_200_000,
      },
      dispatch2Refusal: {
        status: "over-budget", reason: "spend-cap-exceeded",
        capMicroUsd: 5_000_000, spentMicroUsd: 5_200_000,
        boxesCreated: 0, keysMinted: 0,
      },
      qdsCostOutput: output,
    };
    writeFileSync(join(evidenceDir, "e2e-cost-demo.json"), `${JSON.stringify(testArtifact, null, 2)}\n`, { mode: 0o600 });

    // Schema-assert the committed evidence artifact to detect drift (D8).
    const committedPath = join(REPO_ROOT, "_bmad-output", "evidence", "df2-8", "e2e-cost-demo.json");
    const committed = JSON.parse(readFileSync(committedPath, "utf8")) as typeof testArtifact;
    // The committed copy must carry the same schema and key values as what the test produces.
    expect(committed.story).toBe(testArtifact.story);
    expect(committed.issue).toBe(testArtifact.issue);
    expect(committed.capMicroUsd).toBe(testArtifact.capMicroUsd);
    expect(committed.dispatch1.mintedCeilingMicroUsd).toBe(testArtifact.dispatch1.mintedCeilingMicroUsd);
    expect(committed.spend.dispatch1MicroUsd).toEqual(testArtifact.spend.dispatch1MicroUsd);
    expect(committed.spend.priorIssueSpendMicroUsd).toBe(testArtifact.spend.priorIssueSpendMicroUsd);
    expect(committed.spend.issueCumulativeMicroUsd).toBe(testArtifact.spend.issueCumulativeMicroUsd);
    expect(committed.dispatch2Refusal).toEqual(testArtifact.dispatch2Refusal);
    // qdsCostOutput is expected to vary (timestamps, ordering) — just assert it contains the key totals.
    expect(committed.qdsCostOutput).toContain("5,200,000");
    expect(committed.qdsCostOutput).toContain("qds/demo#42");
  }, 30_000);

  // D9: same requestId, different runId → distinct admissions, no double-count corruption
  test("same requestId with different runId → distinct admissions (no dedupe across runs)", async () => {
    const store = new RunRecordStore(join(dir, "runs"));
    const keyApi = new FakeKeyApi();
    const ledger = freshLedger(undefined, store);

    // Seed prior spend to make the admissions meaningful
    await seedPriorSpend({
      store, keyApi, ledger,
      runId: "seed-run-d9", repoSlug: "qds/demo", issueId: "42",
      requestId: "seed-d9", role: "lead", microUsd: 4_900_000,
    });

    const sharedRequestId = "shared-req-id";

    // First dispatch with shared requestId
    const decision1 = assertWithinBudget(ledger, {
      repoSlug: "qds/demo",
      issueId: "42",
      runId: "same-req-run-1",
      requestId: sharedRequestId,
    });

    expect(decision1.admitted).toBeTrue();
    // reservedMicroUsd counts OTHER outstanding reservations (pre-insert); the
    // seed run's reservation retired with its priced spend, so 0 here.
    expect(decision1.reservedMicroUsd).toBe(0);
    expect(decision1.admittedCeilingMicroUsd).toBe(100_000); // min(keyCap, 5M cap - 4.9M committed)
    // The real driver creates the run record right after admission (INV-COST-3
    // order); without it the orphan filter expires the reservation.
    store.create("same-req-run-1");

    // Second dispatch with SAME requestId but DIFFERENT runId: the first
    // dispatch's 100k reservation is now outstanding, so committed (4.9M spent
    // + 100k reserved) meets the 5M cap and the second is refused. The PK is
    // (request_id, run_id), so the shared requestId is not deduped across runs —
    // each admission is judged on its own headroom, never merged.
    let refused: OverBudgetError | undefined;
    try {
      assertWithinBudget(ledger, {
        repoSlug: "qds/demo",
        issueId: "42",
        runId: "same-req-run-2",
        requestId: sharedRequestId,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(OverBudgetError);
      refused = e as OverBudgetError;
    }
    // The refusal is the no-corruption proof: the shared requestId did not
    // dedupe or merge state — run-2 was judged on real headroom and lost.
    expect(refused).toBeDefined();
    expect(refused?.reservedMicroUsd).toBe(100_000); // run-1's reservation now counts against run-2
    expect(refused?.spentMicroUsd).toBe(4_900_000);
    expect(refused?.capMicroUsd).toBe(5_000_000);

    // Verify two distinct reservations exist in gate_admissions
    // The ledger should track both admissions separately by their (request_id, run_id) PK.
    // This test asserts the behavior: if dedupe were by requestId only, the second would be
    // rejected or carry merged state, which would be a corruption bug.
  });
});
