/**
 * J4 R1-16 — the composition root: `fleet observe --all` (scripts/fleet.ts
 * `run`) wires the L7 hook as the sweep's `onTick` when injected deps carry
 * `judgmentPack`, and runs hook-free when injected deps do not. Driven through
 * the real CLI entry with a fake driver whose box holds a seeded resident
 * journal past threshold (host-pack.e2e.test.ts's fixture). All dirs are tmp;
 * the cwd is this repo (a git worktree, as the verb requires).
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run as fleetRun } from "../../scripts/fleet.ts";
import { BOX_MARKER_PATH_RE } from "../../src/fleet/fanout-primitive.ts";
import { setLogSink } from "../../src/lib/log.ts";
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

const JOURNAL = JSON.stringify({
  version: "1.0.0",
  runId: "run-cli",
  ok: false,
  resident: { status: "active", directives: 0, directivesRejected: 0, steeringIterations: { build: 1 }, spendMicros: 6_900, exitStatus: null, tripwires: [] },
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
    if (BOX_MARKER_PATH_RE.test(cmd)) return { stdout: "", stderr: "", exitCode: 1 }; // still running
    if (cmd.includes("/home/exedev/run-cli.journal.jsonl")) {
      if (cmd.includes("test -f")) return { stdout: "", stderr: "", exitCode: 0 };
      this.journalReads++;
      return { stdout: JOURNAL, stderr: "", exitCode: 0 };
    }
    return super.exec(vm, argv as string[], stdin);
  }
}

async function seeded(): Promise<{ driver: Driver; store: RunRecordStore }> {
  const runsDir = tmp("qds-j4-cli-runs-");
  const store = new RunRecordStore({ dir: runsDir });
  const driver = new Driver(path.join(runsDir, "boxes"));
  await createRun(driver, store, { runId: "run-cli", recordAuditLink: () => {} });
  store.set("run-cli", { requestId: "req-dispatch-stamp" } as never);
  return { driver, store };
}

function quiet(): Array<Record<string, unknown>> {
  const sink: Array<Record<string, unknown>> = [];
  cleanups.push(setLogSink((e) => void sink.push(e as Record<string, unknown>)));
  return sink;
}

test("fleet observe --all with injected judgmentPack fires the L7 hook once per running resident", async () => {
  const houseLog = quiet();
  const { driver, store } = await seeded();
  const out = tmp("qds-j4-cli-out-");
  const lines: Array<Record<string, unknown>> = [];
  const writes: unknown[] = [];
  const stdout: string[] = [];
  const code = await fleetRun(
    ["observe", "--all", "--driver", "fake"],
    (l) => stdout.push(l),
    {
      driver,
      store,
      keyApi: new FakeKeyApi(),
      judgmentPack: {
        provenanceDir: path.join(out, "prov"),
        machineStateCorpusDir: path.join(out, "ms"),
        corpusDir: path.join(out, "corpus"),
        log: (e) => void lines.push(e as Record<string, unknown>),
        writeSteering: (runId, d) => void writes.push({ runId, d }),
      },
    },
    () => {},
  );
  expect(code).toBe(0);
  expect(driver.journalReads).toBe(1);
  const asks = lines.filter((l) => l.event === "l7-ask");
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ leg: "l7", armed: false, would_signal: true, answer_mode: "mock", runId: "run-cli" });
  expect(fs.readdirSync(path.join(out, "prov"))).toHaveLength(1);
  expect(fs.existsSync(path.join(out, "ms", "run-cli", "x-rx.jsonl"))).toBe(true);
  expect(writes).toEqual([]);
  // the pack's lines went to the injected sink, never the house log
  expect(houseLog.some((l) => l.event === "l7-ask")).toBe(false);
});

test("fleet observe --all with injected deps and NO judgmentPack runs hook-free", async () => {
  const houseLog = quiet();
  const { driver, store } = await seeded();
  const code = await fleetRun(["observe", "--all", "--driver", "fake"], () => {}, { driver, store, keyApi: new FakeKeyApi() }, () => {});
  expect(code).toBe(0);
  expect(driver.journalReads).toBe(0);
  expect(houseLog.some((l) => l.event === "l7-ask")).toBe(false);
  // the sweep did reach the running resident (so the absence of a read is the hook's absence)
  expect(houseLog.some((l) => l.runId === "run-cli")).toBe(true);
});
