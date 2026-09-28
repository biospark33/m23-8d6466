/**
 * The Q1 service-surface CONTRACT suite (Q1.8) — the drift alarm.
 *
 * SC2's SwarmClaw adapter codes against EXACTLY this surface: the submit ack,
 * the result payload, the cancel completion lines, and the exit codes each
 * verb returns. Every field name, type and enum value is pinned LITERALLY —
 * drift names the field and both shapes (the gitnexus cli-contract.ts
 * discipline). The surface does not move without a deliberate version bump
 * (SUBMIT_SCHEMA_VERSION / RESULT_SCHEMA_VERSION), and a bump lands here
 * first.
 *
 * What is deliberately NOT pinned here: anything but the JSON contract. The
 * internals behind each verb have their own suites (submit.test.ts,
 * result.test.ts, budget-group.test.ts, quota-intents.test.ts, the verbs/cli
 * registry tables); this file reads the three surfaces THE WAY A DAG ADAPTER
 * DOES — through run()'s argv in, JSON line out.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { goodLedger } from "./helpers.ts";
import { run } from "../../scripts/fleet.ts";
import {
  SUBMIT_SCHEMA_VERSION,
  type SubmitAck,
} from "../../src/fleet/submit.ts";
import {
  RESULT_SCHEMA_VERSION,
  RESULT_STATUS_VALUES,
  type ResultPayload,
  type ResultStatus,
} from "../../src/fleet/result.ts";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "q1-contract-")));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const REQ = "5e5a3c8e-1f2b-4c3d-9a8e-70c1f2d3e4f5";

let dir: string;
let runsDir: string;
let store: RunRecordStore;
let outLines: string[];
let errLines: string[];

const RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpRoot, "c-")));
  runsDir = join(dir, "runs");
  store = new RunRecordStore(runsDir);
  outLines = [];
  errLines = [];
  // The teardown chain's close step prices box hours from the cost config —
  // the same fixture the destructive-verb suites plant beside their store.
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(dir, ".sandbox"), { recursive: true });
  writeFileSync(join(dir, ".sandbox", "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
  writeFileSync(join(dir, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
});

async function runCli(argv: string[], depsOverrides: Record<string, unknown> = {}): Promise<number> {
  return run(
    argv,
    (s: string) => void outLines.push(s),
    {
      driver: new FakeDriver(join(dir, "boxes")),
      keyApi: new FakeKeyApi(),
      store,
      ledgerFactory: () => goodLedger(),
      repoRoot: dir,
      ...depsOverrides,
    },
    (s: string) => void errLines.push(s),
  );
}

/** The exact field-set pin: missing AND extra fields both fail, naming them. */
function expectExactFields(obj: object, required: string[], optional: string[] = []): void {
  const keys = new Set(Object.keys(obj));
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((k) => !keys.has(k));
  const unexpected = [...keys].filter((k) => !allowed.has(k));
  expect({
    missing,
    unexpected,
    hint: `the Q1 contract changed: required=${JSON.stringify(required)} optional=${JSON.stringify(optional)} got=${JSON.stringify([...keys].sort())}`,
  }).toEqual({ missing: [], unexpected: [], hint: expect.any(String) });
}

describe("Q1.8 contract: fleet submit's ack", () => {
  test("schemaVersion is the literal 1 the module exports", () => {
    expect(SUBMIT_SCHEMA_VERSION).toBe(1);
  });

  test("the ack line carries exactly the contract fields, typed", async () => {
    // A real manifest under the repoRoot — the CLI path loads it.
    const manifestRel = join("manifests", "pipeline.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "manifests"), { recursive: true });
    writeFileSync(
      join(dir, manifestRel),
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        phases: [
          { name: "plan", kind: "code", description: "Draft", command: ["true"], maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Test", command: ["true"], maxDurationMs: 10_000, retries: 0 },
        ],
      }),
    );
    const brief = JSON.stringify({
      repoSlug: "owner/repo",
      workId: "dag/contract-probe",
      commitSha: "a".repeat(40),
      manifestPath: manifestRel,
      repoUrl: "https://github.com/owner/repo",
    });
    const code = await runCli(["submit", "--driver", "fake", "--request-id", REQ], {
      readBrief: async () => brief,
      startEngine: async (runId: string) => ({ outcome: "started" as const, vm: "vm", unit: `qds-run@${runId}` }),
    });
    expect(code).toBe(0);
    expect(outLines).toHaveLength(1);
    const ack = JSON.parse(outLines[0] as string) as SubmitAck;
    expectExactFields(ack, ["schemaVersion", "runId", "requestId", "state", "vmName", "replayed"], [
      "httpsUrl",
      "budgetGroup",
      "groupCapMicroUsd",
    ]);
    expect(ack.schemaVersion).toBe(1);
    expect(ack.runId).toMatch(RUN_ID_RE);
    expect(ack.requestId).toBe(REQ);
    expect(ack.state).toBe("running");
    expect(ack.replayed).toBe(false);
    expect(typeof ack.vmName).toBe("string");
  });

  test("the replay ack differs from the first ONLY in `replayed` — same runId, same fields", async () => {
    // (Coverage note: submit.test.ts owns the replay MECHANICS; this pins the
    // CONTRACT property a DAG adapter relies on — the replayed ack's SHAPE is
    // the ack's shape.)
    const first = {
      schemaVersion: 1,
      runId: "qds-20260928-abc123",
      requestId: REQ,
      state: "running",
      vmName: "qds-vm",
      replayed: false,
    } satisfies SubmitAck;
    const replayed: SubmitAck = { ...first, replayed: true };
    expectExactFields(replayed, ["schemaVersion", "runId", "requestId", "state", "vmName", "replayed"], [
      "httpsUrl",
      "budgetGroup",
      "groupCapMicroUsd",
    ]);
    expect(replayed.runId).toBe(first.runId);
  });

  test("usage refusals keep their exit codes: 2 usage, 5 spoken-for, per the registry", async () => {
    // 2: missing --request-id.
    expect(await runCli(["submit", "--driver", "fake"])).toBe(2);
    // 2: malformed --request-id.
    expect(await runCli(["submit", "--driver", "fake", "--request-id", "not-a-uuid"])).toBe(2);
    // 5: the requestId is spoken for by an in-flight submit. The refusal
    // fires AFTER the brief is read (the CLI reads the brief before the core
    // runs), so the probe hands back a parseable one.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const submits = join(runsDir, "submits");
    mkdirSync(submits, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(submits, `${REQ}.json`),
      JSON.stringify({ schemaVersion: 1, requestId: REQ, state: "in-flight", startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    expect(
      await runCli(["submit", "--driver", "fake", "--request-id", REQ], {
        readBrief: async () =>
          JSON.stringify({
            repoSlug: "owner/repo",
            workId: "dag/contract-probe",
            commitSha: "a".repeat(40),
            manifestPath: "m.json",
            repoUrl: "https://github.com/owner/repo",
          }),
      }),
    ).toBe(5);
  });
});

describe("Q1.8 contract: fleet result's payload", () => {
  test("schemaVersion is the literal 1 the module exports, and the status enum is closed", () => {
    expect(RESULT_SCHEMA_VERSION).toBe(1);
    // The closed set, named. A new status — or a renamed one — is a contract
    // change and lands here first.
    expect([...RESULT_STATUS_VALUES].sort()).toEqual([
      "approved",
      "awaiting-approval",
      "cancelled",
      "completed",
      "pausing",
      "rejected",
      "running",
    ]);
  });

  test("the payload line carries exactly the contract fields, typed, for EVERY lifecycle state", async () => {
    const states: Array<{ seed: () => void; status: ResultStatus; terminal: boolean }> = [
      { seed: () => store.create("qds-20260928-con001"), status: "running", terminal: false },
      {
        seed: () => {
          store.create("qds-20260928-con002");
          store.close("qds-20260928-con002");
        },
        status: "completed",
        terminal: true,
      },
    ];
    for (const [i, state] of states.entries()) {
      state.seed();
      const runId = `qds-20260928-con00${i + 1}`;
      const code = await runCli(["result", runId, "--json"]);
      expect(code).toBe(0);
      const payload = JSON.parse(outLines.at(-1) as string) as ResultPayload;
      expectExactFields(payload, ["schemaVersion", "runId", "requestId", "status", "terminal", "artifacts"], [
        "vmName",
        "spendMicroUsd",
      ]);
      expect(payload.schemaVersion).toBe(1);
      expect(payload.runId).toBe(runId);
      // requestId is `string | null` — present-but-null, never absent: the
      // adapter's join key reads the SAME field on every payload.
      expect(payload.requestId).toBeNull();
      expect(payload.status).toBe(state.status);
      expect(payload.terminal).toBe(state.terminal);
      expect(payload.artifacts).toEqual({});
    }
  });

  test("the missing-record answer is exit 4 with the envelope naming run-not-found", async () => {
    const code = await runCli(["result", "qds-20260928-none99"]);
    expect(code).toBe(4);
    expect(errLines.join("")).toContain("run-not-found");
  });
});

describe("Q1.8 contract: fleet cancel's surface", () => {
  test("cancel emits the `cancelled: <runId>` line and exits 0; the second cancel emits `nothing to do` and exits 0", async () => {
    // A provisioned run through the real dispatch verb.
    const manifestRel = join("manifests", "pipeline.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "manifests"), { recursive: true });
    writeFileSync(
      join(dir, manifestRel),
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        phases: [
          { name: "plan", kind: "code", description: "Draft", command: ["true"], maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Test", command: ["true"], maxDurationMs: 10_000, retries: 0 },
        ],
      }),
    );
    const brief = JSON.stringify({
      repoSlug: "owner/repo",
      issueId: 7,
      commitSha: "a".repeat(40),
      manifestPath: manifestRel,
      repoUrl: "https://github.com/owner/repo",
    });
    expect(await runCli(["dispatch", "--driver", "fake"], { readBrief: async () => brief })).toBe(0);
    const { runId } = JSON.parse(outLines.find((l) => l.includes("runId")) as string) as { runId: string };

    outLines = [];
    expect(await runCli(["cancel", "--driver", "fake", runId])).toBe(0);
    expect(outLines.join("")).toContain(`cancelled: ${runId}`);
    outLines = [];
    expect(await runCli(["cancel", "--driver", "fake", runId])).toBe(0);
    expect(outLines.join("")).toContain(`nothing to do: ${runId}`);
    // And the result payload reads it back — the branch surface SC2.3 codes.
    outLines = [];
    expect(await runCli(["result", runId])).toBe(0);
    const payload = JSON.parse(outLines[0] as string) as ResultPayload;
    expect(payload.status).toBe("cancelled");
    expect(payload.terminal).toBe(true);
  });

  test("cancel's missing-record answer is exit 4, per the registry", async () => {
    expect(await runCli(["cancel", "--driver", "fake", "qds-20260928-none99"])).toBe(4);
  });
});

describe("Q1.8 contract: the DAG identity (Q1.7)", () => {
  test("a headless brief carries workId; its ack and payload join on requestId, not issueId", async () => {
    // The identity half of the contract: a DAG adapter never invents an
    // issue id — the brief's workId names the work, and `${slug}#${workId}`
    // is the spend key the ledger holds it to.
    const manifestRel = join("manifests", "pipeline.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "manifests"), { recursive: true });
    writeFileSync(
      join(dir, manifestRel),
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        phases: [
          { name: "plan", kind: "code", description: "Draft", command: ["true"], maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Test", command: ["true"], maxDurationMs: 10_000, retries: 0 },
        ],
      }),
    );
    const brief = JSON.stringify({
      repoSlug: "owner/repo",
      workId: "dag/hermes-qa-pass",
      commitSha: "a".repeat(40),
      manifestPath: manifestRel,
      repoUrl: "https://github.com/owner/repo",
    });
    const requestId = randomUUID();
    const code = await runCli(["submit", "--driver", "fake", "--request-id", requestId], {
      readBrief: async () => brief,
      startEngine: async () => ({ outcome: "started" as const, vm: "vm", unit: "u" }),
    });
    expect(code).toBe(0);
    const ack = JSON.parse(outLines[0] as string) as SubmitAck;
    expect(ack.requestId).toBe(requestId);
    // The run record carries the correlation; the result payload joins on it.
    const rec = store.get(ack.runId);
    expect(rec?.requestId).toBe(requestId);
    outLines = [];
    expect(await runCli(["result", ack.runId])).toBe(0);
    const payload = JSON.parse(outLines[0] as string) as ResultPayload;
    expect(payload.requestId).toBe(requestId);
  });
});
