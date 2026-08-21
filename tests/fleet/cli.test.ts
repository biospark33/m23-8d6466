/**
 * CLI tests (Story DF3.1): scripts/fleet.ts run() contract + the MANDATORY
 * e2e demo (DoD): dispatch → status → teardown against the fake driver,
 * capturing the three outputs for the Dev Agent Record.
 *
 * Also covers (DoD): --help renders from the registry (no second list),
 * bidirectional verb coverage, malformed briefs via stdin → exit 2 with
 * zero provisioning, unknown runId → exit 4 mutating nothing, 64KiB cap.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../scripts/fleet.ts";
import { listVerbs, renderHelp } from "../../src/fleet/verbs.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { defaultKeyCapMicroUsd } from "../../src/providers/credentials.ts";
import type { FleetDeps, } from "../../scripts/fleet.ts";
import type { LedgerLike } from "../../src/fleet/dispatch.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "df3-1-cli-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function validBriefJson(dir: string): string {
  const manifestDir = join(dir, "manifests");
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, "pipeline.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "1.0.0",
      pipelineId: "e2e-pipeline",
      runBudgetMs: 200_000,
      phases: [
        { name: "plan", kind: "engineer", description: "Draft the approach for the change", maxDurationMs: 10_000, retries: 0 },
        { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
      ],
    }),
  );
  return JSON.stringify({
    repoSlug: "owner/repo",
    issueId: 42,
    commitSha: "b".repeat(40),
    manifestPath,
    repoUrl: "https://github.com/owner/repo",
  });
}

function goodLedger(ceilingMicroUsd: number = defaultKeyCapMicroUsd): LedgerLike {
  return {
    config: { defaultCapMicroUsd: ceilingMicroUsd, perIssueOverrides: {} },
    admitIssue: () => ({
      admitted: true as const,
      status: "within-budget" as const,
      admittedCeilingMicroUsd: ceilingMicroUsd,
      capMicroUsd: ceilingMicroUsd,
      spentMicroUsd: 0,
      reservedMicroUsd: 0,
      remainingMicroUsd: ceilingMicroUsd,
      unpricedRows: 0,
    }),
    close: () => {},
  };
}

describe("scripts/fleet.ts (DF3.1 CLI)", () => {
  let dir: string;
  let boxesDir: string;
  let runsDir: string;
  let captured: string[];
  const prevCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpRoot, "cli-"));
    boxesDir = join(dir, "boxes");
    runsDir = join(dir, "runs");
    captured = [];
    // Repo idiom: chdir so the real CostLedger the teardown verb wires lands
    // in the tmpdir's .sandbox, and DF2.8's box-hours pricing has its config.
    process.chdir(dir);
    mkdirSync(join(dir, ".sandbox"), { recursive: true });
    writeFileSync(join(dir, ".sandbox", "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(briefJson: string): Partial<FleetDeps> {
    return {
      driver: new FakeDriver(boxesDir),
      keyApi: new FakeKeyApi(),
      store: new RunRecordStore(runsDir),
      ledgerFactory: () => goodLedger(),
      readBrief: async () => briefJson,
    };
  }

  const out = (s: string): void => {
    captured.push(s);
  };

  // ─── --help renders from the registry (AC6) ────────────────────────────────

  test("--help renders exactly renderHelp(listVerbs()) — no second list", async () => {
    const code = await run(["--help"], out, deps(""));
    expect(code).toBe(0);
    const helpText = captured.join("");
    expect(helpText).toBe(`${renderHelp(listVerbs())}\n`);
    for (const entry of listVerbs()) {
      expect(helpText).toContain(entry.verb);
    }
  });

  test("no verb prints usage", async () => {
    const code = await run([], out, deps(""));
    expect(code).toBe(0);
    expect(captured.join("")).toContain("dispatch");
  });

  // ─── bidirectional verb coverage (AC6) ─────────────────────────────────────

  test("every registry verb is dispatchable and every dispatchable verb is registered", async () => {
    const registry = new Set(listVerbs().map((v) => v.verb));
    // A registry verb without a positional runId must NOT report unknown-verb
    // (status/dispatch take none; harvest/teardown report missing-arg = 2,
    // never "unknown verb").
    for (const verb of registry) {
      captured.length = 0;
      const code = await run([verb], out, deps(""));
      const text = captured.join("");
      expect(text).not.toContain("unknown-verb");
      expect([0, 2]).toContain(code);
    }
    // A non-registry verb reports unknown-verb (exit 2)
    captured.length = 0;
    const code = await run(["warp"], out, deps(""));
    expect(code).toBe(2);
    expect(captured.join("")).toContain("unknown-verb");
  });

  // ─── malformed brief → exit 2, zero provisioning (INV-2) ───────────────────

  test("unknown brief field → exit 2 naming the field, zero records, zero boxes", async () => {
    const bad = JSON.stringify({ ...JSON.parse(validBriefJson(dir)), extraField: 1 });
    const code = await run(["dispatch"], out, deps(bad));
    expect(code).toBe(2);
    expect(captured.join("")).toContain("extraField");
    expect(readdirSync(runsDir)).toHaveLength(0);
    expect(readdirSync(boxesDir)).toHaveLength(0);
  });

  test("brief over 64 KiB → exit 2 brief-too-large", async () => {
    const big = validBriefJson(dir).replace(
      "owner/repo",
      `owner/${"x".repeat(70_000)}`,
    );
    const code = await run(["dispatch"], out, deps(big));
    expect(code).toBe(2);
    expect(captured.join("")).toContain("brief-too-large");
  });

  test("invalid JSON brief → exit 2", async () => {
    const code = await run(["dispatch"], out, deps("{not json"));
    expect(code).toBe(2);
    expect(captured.join("")).toContain("invalid-brief");
  });

  // ─── status unknown run → exit 4, mutates nothing (AC4) ────────────────────

  test("status <unknown-runId> → exit 4 run-not-found, no driver list call", async () => {
    const driver = new FakeDriver(boxesDir);
    const listSpy = mock(() => driver.list.bind(driver)());
    driver.list = listSpy;
    const d = deps(validBriefJson(dir));
    (d as { driver?: FakeDriver }).driver = driver;
    const code = await run(["status", "qds-19990101-000000"], out, d);
    expect(code).toBe(4);
    expect(captured.join("")).toContain("run-not-found");
    expect(listSpy).not.toHaveBeenCalled();
  });

  test("teardown <unknown-runId> → exit 4 run-not-found", async () => {
    const code = await run(["teardown", "qds-19990101-000000"], out, deps(validBriefJson(dir)));
    expect(code).toBe(4);
    expect(captured.join("")).toContain("run-not-found");
  });

  // ─── THE E2E DEMO (DoD, mandatory): dispatch → status → teardown ──────────

  test("e2e: dispatch → status → teardown against the fake driver", async () => {
    const brief = validBriefJson(dir);
    // ONE shared fleet across all three verbs: the teardown verb's
    // captureSpend reads the key dispatch minted, so the FakeKeyApi and store
    // must be the same instances (a fresh keyApi sees no such key and the
    // spend stays unwritten).
    const driver = new FakeDriver(boxesDir);
    const keyApi = new FakeKeyApi();
    const store = new RunRecordStore(runsDir);
    const shared: Partial<FleetDeps> = {
      driver,
      keyApi,
      store,
      ledgerFactory: () => goodLedger(),
      readBrief: async () => brief,
    };

    // 1. dispatch — prints the ack, exits 0
    const dispatchCode = await run(["dispatch", "--driver", "fake"], out, shared);
    expect(dispatchCode).toBe(0);
    const ackLine = captured.find((l) => l.startsWith("{") && l.includes("runId")) as string;
    expect(ackLine).toBeDefined();
    const ack = JSON.parse(ackLine) as {
      runId: string;
      requestId: string;
      state: string;
      vmName: string;
      httpsUrl?: string;
    };
    expect(ack.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    expect(ack.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(ack.state).toBe("ready");
    expect(ack.vmName).toBe(ack.runId);

    // 2. status — lists the run live
    captured.length = 0;
    const statusCode = await run(["status", "--driver", "fake"], out, shared);
    expect(statusCode).toBe(0);
    const rowLine = captured.find((l) => l.includes(ack.runId)) as string;
    expect(rowLine).toBeDefined();
    const row = JSON.parse(rowLine) as { runId: string; state: string };
    expect(row.runId).toBe(ack.runId);
    expect(row.state).toBe("live");

    // 3. teardown — closes the record with spendMicroUsd set
    captured.length = 0;
    const teardownCode = await run(["teardown", "--driver", "fake", ack.runId], out, shared);
    expect(teardownCode).toBe(0);
    expect(captured.join("")).toContain(`torn down: ${ack.runId}`);
    const record = store.get(ack.runId);
    expect(record.closedAt).toBeDefined();
    expect(typeof record.spendMicroUsd).toBe("number");

    // 4. post-teardown status reports closed
    captured.length = 0;
    const afterCode = await run(["status", "--driver", "fake", ack.runId], out, shared);
    expect(afterCode).toBe(0);
    const closedRow = JSON.parse(captured[0] as string) as { state: string };
    expect(closedRow.state).toBe("closed");
  });
});
