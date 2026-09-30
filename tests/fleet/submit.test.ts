/**
 * Submit verb core tests (Q1.1) — TDD RED phase.
 *
 * The DAG-facing single call (G1) with replay protection (G2): the same
 * `requestId` resolves to the SAME run — one box, one key, one engine start —
 * no matter how many times the caller retries. The durable intent record is
 * claimed (O_EXCL) BEFORE dispatch so a crash mid-submit leaves the requestId
 * spoken-for rather than double-provisioning.
 *
 * Coverage:
 * - first submit: dispatch → engine start → JSON ack (schemaVersion 1)
 * - replay: same requestId ⇒ same runId, one box, one key, one engine start,
 *   ack carries replayed:true
 * - in-flight intent (crash between claim and runId capture): refused, nothing
 *   provisioned, the requestId stays spoken-for
 * - pre-provision dispatch refusal RELEASES the claim — the requestId is
 *   reusable (a DAG node retries the same work after a budget/headroom refusal)
 * - budget-group flag pairing: --budget-group and --group-cap stand or fall
 *   together (exit 2)
 * - intent hygiene: 0600 file inside a 0700 submits dir
 * - the ack and the intent carry no key material (INV-4)
 * - replay ack is exact and engine state survives into it
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { goodLedger, admitThrowsLedger, type AdmitCall } from "./helpers.ts";
import { defaultKeyCapMicroUsd } from "../../src/providers/credentials.ts";

// RED: src/fleet/submit.ts does not exist yet — this import is the first failure.
import { submitWork, SubmitError, SUBMITS_DIRNAME } from "../../src/fleet/submit.ts";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "q1-submit-")));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const REQ_A = "5e5a3c8e-1f2b-4c3d-9a8e-70c1f2d3e4f5";
const REQ_B = "6f6b4d9f-2a3c-4d4e-8b9f-81d2e3f4a5b6";

/** Structural witness for a refused FleetError — the test asserts only `code`. */
interface FleetErrorLike {
  code?: string;
  exitCode?: number;
}

function headlessBrief(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoSlug: "owner/repo",
    workId: "dag/build-docs",
    commitSha: "a".repeat(40),
    manifestPath: "path/to/pipeline.json",
    repoUrl: "https://github.com/owner/repo",
    ...over,
  };
}

interface Harness {
  dir: string;
  store: RunRecordStore;
  driver: FakeDriver;
  submitsDir: string;
  engineStarts: string[];
  admitCalls: AdmitCall[];
  submit: (over?: Record<string, unknown>) => Promise<Awaited<ReturnType<typeof submitWork>>>;
}

function harness(): Harness {
  const dir = realpathSync(mkdtempSync(join(tmpRoot, "h-")));
  const runsDir = join(dir, "runs");
  const store = new RunRecordStore(runsDir);
  const driver = new FakeDriver(join(dir, "boxes"));
  const keyApi = new FakeKeyApi();
  const engineStarts: string[] = [];
  const admitCalls: AdmitCall[] = [];
  const submitsDir = join(runsDir, SUBMITS_DIRNAME);
  // A real manifest under the injected repoRoot — dispatch loads it (INV-2),
  // so a submit test needs the bytes, not just a path.
  const manifestRel = join("manifests", "pipeline.json");
  const manifestPath = join(dir, manifestRel);
  mkdirSync(join(dir, "manifests"), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "1.0.0",
      pipelineId: "test-pipeline",
      runBudgetMs: 200_000,
      phases: [
        { name: "plan", kind: "code", description: "Draft the approach for the change", command: ["true"], maxDurationMs: 10_000, retries: 0 },
        { name: "build", kind: "code", description: "Run the repository test suite", command: ["true"], maxDurationMs: 40_000, retries: 0 },
      ],
    }),
  );
  const startEngine = async (runId: string) => {
    engineStarts.push(runId);
    return { outcome: "started" as const, vm: "vm", unit: `qds-run@${runId}` };
  };
  const submit = (async (deps: Record<string, unknown>) => {
    return submitWork({
      brief: headlessBrief({ manifestPath: manifestRel }),
      requestId: REQ_A,
      driver,
      keyApi,
      store,
      repoRoot: dir,
      ledgerFactory: () => {
        const ledger = goodLedger();
        const inner = ledger.admitIssue.bind(ledger);
        (ledger as { admitIssue: unknown }).admitIssue = (input: AdmitCall["input"], cap: number, keyCap: number) => {
          admitCalls.push({ input, capMicroUsd: cap, keyCapMicroUsd: keyCap } as AdmitCall);
          return inner(input, cap, keyCap);
        };
        return ledger;
      },
      startEngine,
      ...deps,
    } as Parameters<typeof submitWork>[0]);
  }) as unknown as Harness["submit"];
  return {
    dir,
    store,
    driver,
    submitsDir,
    engineStarts,
    admitCalls,
    submit,
  };
}

describe("submitWork (Q1.1 replay-safe submit)", () => {
  test("first submit: one box, one key, engine started, JSON ack carries schemaVersion 1", async () => {
    const h = harness();
    const ack = await h.submit({});
    expect(ack.schemaVersion).toBe(1);
    expect(ack.requestId).toBe(REQ_A);
    expect(ack.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    expect(ack.state).toBe("running");
    expect(ack.replayed).toBe(false);
    expect(ack.vmName).toBeTypeOf("string");
    expect(await h.driver.list()).toHaveLength(1);
    expect(h.admitCalls).toHaveLength(1);
    expect(h.engineStarts).toEqual([ack.runId]);
    expect(existsSync(join(h.submitsDir, `${REQ_A}.json`))).toBe(true);
  });

  test("replay with the same requestId: same runId, one box, one key, ONE engine start, replayed:true", async () => {
    const h = harness();
    const first = await h.submit({});
    const second = await h.submit({});
    expect(second.runId).toBe(first.runId);
    expect(second.replayed).toBe(true);
    expect(second.schemaVersion).toBe(1);
    expect(await h.driver.list()).toHaveLength(1);
    expect(h.admitCalls).toHaveLength(1);
    expect(h.engineStarts).toEqual([first.runId]);
  });

  test("a DIFFERENT requestId is a different run, not a replay", async () => {
    const h = harness();
    const a = await h.submit({});
    const b = await h.submit({ requestId: REQ_B });
    expect(b.runId).not.toBe(a.runId);
    expect(b.replayed).toBe(false);
    expect(await h.driver.list()).toHaveLength(2);
  });

  test("in-flight intent (crash between claim and runId capture) refuses and provisions NOTHING", async () => {
    const h = harness();
    mkdirSync(h.submitsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(h.submitsDir, `${REQ_A}.json`),
      JSON.stringify({ schemaVersion: 1, requestId: REQ_A, state: "in-flight", startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    let err: unknown;
    try {
      await h.submit({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SubmitError);
    expect((err as SubmitError).exitCode).toBe(5);
    expect((err as SubmitError).code).toBe("submit-in-flight");
    expect(await h.driver.list()).toHaveLength(0);
    expect(h.admitCalls).toHaveLength(0);
  });

  test("pre-provision dispatch refusal RELEASES the claim — the requestId is reusable", async () => {
    const h = harness();
    let err: unknown;
    try {
      await h.submit({
        ledgerFactory: () => admitThrowsLedger(),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(existsSync(join(h.submitsDir, `${REQ_A}.json`))).toBe(false);
    // The retry on the same requestId goes through cleanly.
    const ack = await h.submit({});
    expect(ack.replayed).toBe(false);
    expect(await h.driver.list()).toHaveLength(1);
  });

  test("budget-group flags pair: one without the other is a usage refusal (exit 2)", async () => {
    const h = harness();
    for (const over of [
      { budgetGroup: "dag-2026-09" },
      { groupCapMicroUsd: 500_000 },
    ]) {
      let err: unknown;
      try {
        await h.submit(over);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SubmitError);
      expect((err as SubmitError).exitCode).toBe(2);
      expect((err as SubmitError).code).toBe("submit-usage");
    }
    expect(await h.driver.list()).toHaveLength(0);
  });

  test("budget-group accepted together rides the ack and the intent", async () => {
    const h = harness();
    const ack = await h.submit({ budgetGroup: "dag-2026-09", groupCapMicroUsd: 500_000 });
    expect(ack.budgetGroup).toBe("dag-2026-09");
    expect(ack.groupCapMicroUsd).toBe(500_000);
    const intent = JSON.parse(readFileSync(join(h.submitsDir, `${REQ_A}.json`), "utf-8")) as Record<string, unknown>;
    expect(intent.budgetGroup).toBe("dag-2026-09");
    expect(intent.groupCapMicroUsd).toBe(500_000);
  });

  test("intent hygiene: 0600 file inside a 0700 submits dir", async () => {
    const h = harness();
    await h.submit({});
    expect(statSync(h.submitsDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(h.submitsDir, `${REQ_A}.json`)).mode & 0o777).toBe(0o600);
  });

  test("the ack and the intent carry no key material (INV-4)", async () => {
    const h = harness();
    const ack = (await h.submit({})) as unknown as Record<string, unknown>;
    const intent = JSON.parse(readFileSync(join(h.submitsDir, `${REQ_A}.json`), "utf-8")) as Record<string, unknown>;
    for (const obj of [ack, intent]) {
      expect(JSON.stringify(obj)).not.toMatch(/sk-or|sk-ant|keyHash|apiKey|secret/i);
    }
  });

  test("Q1.2: submit with a budget group RESERVES through the ledger before dispatch", async () => {
    const h = harness();
    // The harness's ledgerFactory returns a RecordingLedger per call; capture
    // them so the group calls are visible on the recording surface.
    const ledgers: Awaited<ReturnType<typeof goodLedger>>[] = [];
    const ack = await h.submit({
      budgetGroup: "dag-2026-09",
      groupCapMicroUsd: 2_900_000,
      ledgerFactory: () => {
        const ledger = goodLedger();
        ledgers.push(ledger);
        return ledger;
      },
    });
    expect(ack.budgetGroup).toBe("dag-2026-09");
    expect(ledgers.length).toBeGreaterThan(0);
    const groupCalls = ledgers.flatMap((l) => l.groupCalls);
    expect(groupCalls).toHaveLength(1);
    expect(groupCalls[0]?.groupId).toBe("dag-2026-09");
    expect(groupCalls[0]?.issueKey).toBe("dag/build-docs");
    expect(groupCalls[0]?.requestId).toBe(REQ_A);
    expect(groupCalls[0]?.amountMicroUsd).toBeGreaterThan(0);
    // The reservation LANDED BEFORE the dispatch's own admission: the group
    // cap refuses at zero spend, before a box exists.
    const firstGroupAt = ledgers.indexOf(
      ledgers.find((l) => l.groupCalls.length > 0) as Awaited<ReturnType<typeof goodLedger>>,
    );
    expect(firstGroupAt).toBe(0);
    // No release: the run exists, the reservation stays — and NOTHING releases it
    // yet: cancel/teardown/completion never call releaseBudgetGroup (the only
    // release is the no-record refusal refund in submit.ts), so a reused group
    // name wedges at zero spend until release wiring lands.
    expect(ledgers.flatMap((l) => l.groupReleases)).toHaveLength(0);
  });

  test("SC2.6: a group-scoped CLI submit reserves and mints at the GROUP cap (the verb takes no --cap-micro-usd)", async () => {
    // The real-ledger arithmetic this guards (measured live 2026-09-29, SC2.6
    // window (b)): submit reserved the $50 defaultKeyCapMicroUsd against a
    // $0.50 group and refused exit 5 at ZERO spend — the recording ledger's
    // permissive reserve hid it from this suite. The operator named the group
    // ceiling; without an injected caller cap (this verb never injects one) a
    // single run's reservation can never exceed it — an explicit deps cap wins
    // and can.
    const h = harness();
    const ledgers: Awaited<ReturnType<typeof goodLedger>>[] = [];
    const admitCalls: AdmitCall[] = [];
    await h.submit({
      budgetGroup: "sc2-fj",
      groupCapMicroUsd: 500_000,
      ledgerFactory: () => {
        const ledger = goodLedger();
        const inner = ledger.admitIssue.bind(ledger);
        (ledger as { admitIssue: unknown }).admitIssue = (input: AdmitCall["input"], cap: number, keyCap: number) => {
          admitCalls.push({ input, capMicroUsd: cap, keyCapMicroUsd: keyCap } as AdmitCall);
          return inner(input, cap, keyCap);
        };
        ledgers.push(ledger);
        return ledger;
      },
    });
    const groupCalls = ledgers.flatMap((l) => l.groupCalls);
    expect(groupCalls).toHaveLength(1);
    expect(groupCalls[0]?.amountMicroUsd).toBe(500_000);
    // The minted key's ceiling rides the same bound — a key cannot outspend
    // the group it was admitted under.
    expect(admitCalls[0]?.keyCapMicroUsd).toBe(500_000);
  });

  test("SC2.6: an INJECTED deps.capMicroUsd beats the group bound — the reservation and key cap are the explicit cap", async () => {
    // The group-bounded cap only applies when deps.capMicroUsd is UNDEFINED
    // (submit.ts's `deps.capMicroUsd === undefined` conjunct). A caller that
    // injects its own cap — even one ABOVE the group ceiling — wins outright:
    // both the reservation and the minted key cap are the explicit cap, not
    // the group's. Guards that conjunct against a future "simplification"
    // that would silently override caller caps.
    const h = harness();
    const ledgers: Awaited<ReturnType<typeof goodLedger>>[] = [];
    const admitCalls: AdmitCall[] = [];
    await h.submit({
      budgetGroup: "sc2-fj",
      groupCapMicroUsd: 1_000_000,
      capMicroUsd: 500_000,
      ledgerFactory: () => {
        const ledger = goodLedger();
        const inner = ledger.admitIssue.bind(ledger);
        (ledger as { admitIssue: unknown }).admitIssue = (input: AdmitCall["input"], cap: number, keyCap: number) => {
          admitCalls.push({ input, capMicroUsd: cap, keyCapMicroUsd: keyCap } as AdmitCall);
          return inner(input, cap, keyCap);
        };
        ledgers.push(ledger);
        return ledger;
      },
    });
    const groupCalls = ledgers.flatMap((l) => l.groupCalls);
    expect(groupCalls).toHaveLength(1);
    expect(groupCalls[0]?.amountMicroUsd).toBe(500_000);
    expect(admitCalls[0]?.keyCapMicroUsd).toBe(500_000);
  });

  test("SC2.6: a group cap at or above the default passes through — reservation and key cap stay the $50 default", async () => {
    // groupCapMicroUsd >= defaultKeyCapMicroUsd ⇒ Math.min is a pass-through:
    // the reservation and the minted key cap both equal the $50 default, byte-
    // for-byte the pre-fix behavior. A cap that large carries no tighter bound
    // for a single run to inherit.
    const h = harness();
    const ledgers: Awaited<ReturnType<typeof goodLedger>>[] = [];
    const admitCalls: AdmitCall[] = [];
    await h.submit({
      budgetGroup: "sc2-fj",
      groupCapMicroUsd: defaultKeyCapMicroUsd,
      ledgerFactory: () => {
        const ledger = goodLedger();
        const inner = ledger.admitIssue.bind(ledger);
        (ledger as { admitIssue: unknown }).admitIssue = (input: AdmitCall["input"], cap: number, keyCap: number) => {
          admitCalls.push({ input, capMicroUsd: cap, keyCapMicroUsd: keyCap } as AdmitCall);
          return inner(input, cap, keyCap);
        };
        ledgers.push(ledger);
        return ledger;
      },
    });
    const groupCalls = ledgers.flatMap((l) => l.groupCalls);
    expect(groupCalls).toHaveLength(1);
    expect(groupCalls[0]?.amountMicroUsd).toBe(defaultKeyCapMicroUsd);
    expect(admitCalls[0]?.keyCapMicroUsd).toBe(defaultKeyCapMicroUsd);
  });

  test("Q1.2: a budget-group-exceeded refusal releases the claim — the requestId is reusable", async () => {
    const h = harness();
    const { CostLedgerError } = await import("../../src/providers/cost-ledger.ts");
    let err: unknown;
    try {
      await h.submit({
        budgetGroup: "dag-2026-09",
        groupCapMicroUsd: 2_900_000,
        ledgerFactory: () => {
          const ledger = goodLedger();
          ledger.reserveBudgetGroup = () => {
            throw new CostLedgerError(
              "budget-group-exceeded",
              "budget group dag-2026-09 is at 2_900_000 of 2_900_000 µ$ — a 500_000 µ$ reservation does not fit",
              "raise the group cap, or submit under a different budget group",
            );
          };
          return ledger;
        },
      });
    } catch (e) {
      err = e;
    }
    expect((err as FleetErrorLike)?.code).toBe("budget-group-exceeded");
    expect((err as FleetErrorLike)?.exitCode).toBe(5);
    // The claim is gone: the requestId is reusable (a wedged in-flight claim
    // here would need an operator for a retryable budget refusal).
    expect(existsSync(join(h.submitsDir, `${REQ_A}.json`))).toBe(false);
  });

  test("Q1.2: a post-reserve dispatch refusal refunds the group reservation", async () => {
    const h = harness();
    const ledgers: Awaited<ReturnType<typeof goodLedger>>[] = [];
    let err: unknown;
    try {
      await h.submit({
        budgetGroup: "dag-2026-09",
        groupCapMicroUsd: 2_900_000,
        // The group reserve SUCCEEDS on the first handle; the dispatch's own
        // admission then throws (nothing provisioned) — the refund must run.
        ledgerFactory: () => {
          const ledger = goodLedger();
          if (ledgers.length === 0) {
            ledgers.push(ledger);
            return ledger;
          }
          const refusal = goodLedger();
          refusal.admitIssue = () => {
            throw new Error("admission exploded");
          };
          ledgers.push(refusal);
          return refusal;
        },
      });
    } catch {
      err = true;
    }
    expect(err).toBeDefined();
    const releases = ledgers.flatMap((l) => l.groupReleases);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.groupId).toBe("dag-2026-09");
    expect(existsSync(join(h.submitsDir, `${REQ_A}.json`))).toBe(false);
  });

  test("engine-start failure on FIRST submit: ack state provisioned, engine failed; replay retries the engine once", async () => {
    const h = harness();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      return { outcome: "start-failed" as const, reason: "box-unreachable" as const };
    };
    const succeeding = async (runId: string) => {
      calls += 1;
      return { outcome: "started" as const, vm: "vm", unit: `qds-run@${runId}` };
    };
    const ack = (await h.submit({ startEngine: failing })) as unknown as Record<string, unknown>;
    expect(ack.state).toBe("provisioned");
    expect(calls).toBe(1);
    // Replay retries the engine start against the SAME run — the retry the
    // run verb's idempotent systemd unit start earns. The replay call carries
    // its own engine seam, exactly as a fresh CLI invocation would.
    const replay = (await h.submit({ startEngine: succeeding })) as unknown as Record<string, unknown>;
    expect(replay.runId).toBe(ack.runId);
    expect(replay.state).toBe("running");
    expect(calls).toBe(2);
  });
});
