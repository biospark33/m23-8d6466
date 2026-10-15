/**
 * J4 DoD — the mock-tier pack round, end to end with no box:
 * seeded resident (box journal with resident spend past threshold) → the REAL
 * `observeSweep` → `onTick: makeL7ObserveHook(...)` → the REAL `readBoxFile`
 * through a fake driver → L7 ask through the mock adapter → strict envelope →
 * exactly one MachineStateRecord + one provenance file + one `l7-ask` line
 * with `armed: false, would_signal: true` → zero steering writes.
 * Fakes follow tests/fleet/observe-ontick.test.ts. All dirs are tmp.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MachineStateRecordSchema } from "../../scripts/corpus/index.ts";
import { makeL7ObserveHook } from "../../src/autonomy/host-pack.ts";
import { BOX_MARKER_PATH_RE } from "../../src/fleet/fanout-primitive.ts";
import { observeSweep } from "../../src/fleet/observe.ts";
import { TYPESAFE_MODEL } from "../../src/judgment/index.ts";
import { createRun, type ExecResult } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** The box journal the in-box engine flushes to `$HOME/<runId>.journal.jsonl`, resident spend past 75% of 8,000 µ$. */
const JOURNAL = JSON.stringify({
  version: "1.0.0",
  runId: "run-e2e",
  ok: false,
  resident: {
    status: "active",
    directives: 1,
    directivesRejected: 0,
    steeringIterations: { build: 1 },
    spendMicros: 6_800,
    exitStatus: null,
    tripwires: [],
  },
  phases: [],
  gateEvents: [],
});

class Driver extends FakeDriver {
  journalReads = 0;
  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin);
  }
  override async execTimed(vm: string, argv: string[], _t: number, stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin);
  }
  private async intercept(vm: string, argv: readonly string[], stdin?: string): Promise<ExecResult> {
    const cmd = argv[0] === "sh" && argv[1] === "-c" && typeof argv[2] === "string" ? argv[2] : "";
    if (argv[0] === "systemctl" && argv[1] === "is-active") return { stdout: "active\n", stderr: "", exitCode: 0 };
    if (cmd.includes("/proc/uptime") && cmd.includes("test -f")) return { stdout: "", stderr: "", exitCode: 1 };
    // marker absent ⇒ the run is still running (the unsettled arm onTick fires on)
    if (BOX_MARKER_PATH_RE.test(cmd)) return { stdout: "", stderr: "", exitCode: 1 };
    if (cmd.includes("/home/exedev/run-e2e.journal.jsonl")) {
      if (cmd.includes("test -f")) return { stdout: "", stderr: "", exitCode: 0 };
      this.journalReads++;
      return { stdout: JOURNAL, stderr: "", exitCode: 0 };
    }
    return super.exec(vm, argv as string[], stdin);
  }
}

test("mock pack round: observe tick → L7 ask → envelope → record + provenance + l7-ask line, zero steering writes", async () => {
  const runsDir = tmp("qds-j4-e2e-runs-");
  const out = tmp("qds-j4-e2e-out-");
  const hostRoot = tmp("qds-j4-e2e-repo-");
  const g = Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: hostRoot });
  expect(g.exitCode).toBe(0);

  const store = new RunRecordStore({ dir: runsDir });
  const driver = new Driver(path.join(runsDir, "boxes"));
  await createRun(driver, store, { runId: "run-e2e", recordAuditLink: () => {} });

  const lines: Array<Record<string, unknown>> = [];
  const writes: unknown[] = [];
  const prov = path.join(out, "provenance");
  const msDir = path.join(out, "corpus", "machine-state");
  const onTick = makeL7ObserveHook({
    provenanceDir: prov,
    machineStateCorpusDir: msDir,
    corpusDir: path.join(out, "corpus"),
    log: (e) => void lines.push(e as Record<string, unknown>),
    writeSteering: (runId, d) => void writes.push({ runId, d }),
  });

  const outcome = await observeSweep({
    driver,
    store,
    runsDir,
    hostRoot,
    requestId: "req-j4-e2e-sweep",
    buildChainCtx: () => ({
      keyApi: new FakeKeyApi() as never,
      costLedger: { ingestBoxHours: () => {} } as never,
      recordAuditLink: () => {},
      close: () => {},
    }),
    onTick,
  });
  if (outcome.kind !== "sweep") throw new Error(`expected sweep, got ${outcome.kind}`);
  expect(outcome.summary.runs_unsettled).toBe(1);
  expect(driver.journalReads).toBe(1);

  // exactly one l7-ask line, recording-only
  const asks = lines.filter((l) => l.event === "l7-ask");
  expect(asks).toHaveLength(1);
  const ask = asks[0] as Record<string, unknown>;
  expect(ask).toMatchObject({ leg: "l7", egress_class: "machine-state", armed: false, would_signal: true, answer_mode: "mock" });
  expect(ask).not.toHaveProperty("miss");

  // exactly one provenance file, keyed by the line's requestId, strict model literal
  expect(fs.readdirSync(prov)).toEqual([`${ask.requestId}.json`]);
  const detail = JSON.parse(fs.readFileSync(path.join(prov, `${ask.requestId}.json`), "utf8")).detail;
  expect(detail).toMatchObject({ model: TYPESAFE_MODEL, egressClass: "machine-state" });
  expect(detail.questions.map((q: { type: string }) => q.type).sort()).toEqual(["choice", "noul"]);

  // exactly one machine-state corpus record
  const recs = fs
    .readFileSync(path.join(msDir, "run-e2e", "x-rx.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => MachineStateRecordSchema.parse(JSON.parse(l)));
  expect(recs).toHaveLength(1);
  expect(recs[0]).toMatchObject({ finding_id: "run-e2e@req-j4-e2e-sweep", disposition: "compact", answer_mode: "mock", pr: null, round: null });

  // recording-only: no directive written
  expect(writes).toEqual([]);

  // a second pass with the same sweep id is idempotent: no new ask, no new record
  await observeSweep({
    driver,
    store,
    runsDir,
    hostRoot,
    requestId: "req-j4-e2e-sweep",
    buildChainCtx: () => ({ keyApi: new FakeKeyApi() as never, costLedger: { ingestBoxHours: () => {} } as never, recordAuditLink: () => {}, close: () => {} }),
    onTick,
  });
  expect(lines.filter((l) => l.event === "l7-ask")).toHaveLength(1);
  expect(fs.readdirSync(prov)).toHaveLength(1);

  // a NEW sweep over the same unchanged resident state is not re-asked: one state-unchanged line
  await observeSweep({
    driver,
    store,
    runsDir,
    hostRoot,
    requestId: "req-j4-e2e-sweep-2",
    buildChainCtx: () => ({ keyApi: new FakeKeyApi() as never, costLedger: { ingestBoxHours: () => {} } as never, recordAuditLink: () => {}, close: () => {} }),
    onTick,
  });
  const l7 = lines.filter((l) => l.event === "l7-ask");
  expect(l7).toHaveLength(2);
  expect(l7[1]).toMatchObject({ skip: "state-unchanged", state_ref: recs[0]?.state_ref, armed: false });
  expect(fs.readdirSync(prov)).toHaveLength(1);
  expect(writes).toEqual([]);
});
