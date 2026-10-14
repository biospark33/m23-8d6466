/**
 * J4 — the `observeSweep` `onTick` seam (interface I3): called once per
 * still-running resident, fault-isolated and deadline-bounded, absent = unchanged.
 * Fakes are a trimmed copy of tests/fleet/observe.test.ts's SweepDriver idiom.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { createRun, type ExecResult } from "../../src/providers/driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { setLogSink } from "../../src/lib/log.ts";
import { BOX_MARKER_PATH_RE } from "../../src/fleet/fanout-primitive.ts";
import { observeSweep, type ObserveSweepDeps, type ObserveTickInfo, type SweepOutcome } from "../../src/fleet/observe.ts";
import { liveChild } from "./helpers.ts";
import { acquireRunLock, releaseRunLock } from "../../scripts/lib/run-lock.ts";

const restores: Array<() => void> = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const r of restores.splice(0)) r();
  for (const c of cleanups.splice(0)) c();
});

function captureLogs(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  restores.push(setLogSink((e) => void lines.push(e as Record<string, unknown>)));
  return lines;
}

class Driver extends FakeDriver {
  activityByVm = new Map<string, string>();
  /** Per-vm marker plan: undefined/absent = marker missing (running); "settled" = ok marker; "silent" = box never answers. */
  markerByVm = new Map<string, "settled" | "silent">();

  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin);
  }
  override async execTimed(vm: string, argv: string[], _t: number, stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin);
  }
  private async intercept(vm: string, argv: readonly string[], stdin?: string): Promise<ExecResult> {
    const cmd = argv.length >= 3 && argv[0] === "sh" && argv[1] === "-c" && typeof argv[2] === "string" ? argv[2] : "";
    if (argv[0] === "systemctl" && argv[1] === "is-active") {
      return { stdout: `${this.activityByVm.get(vm) ?? "active"}\n`, stderr: "", exitCode: 0 };
    }
    if (cmd.includes("/proc/uptime") && cmd.includes("test -f")) return { stdout: "", stderr: "", exitCode: 1 };
    if ((cmd.includes("test -f") || cmd.includes("cat ")) && BOX_MARKER_PATH_RE.test(cmd)) {
      const m = this.markerByVm.get(vm);
      if (m === "silent") return { stdout: "", stderr: "ssh: connect refused (exit 255)", exitCode: 255 };
      if (cmd.includes("test -f")) return { stdout: "", stderr: "", exitCode: m === "settled" ? 0 : 1 };
      return { stdout: `${JSON.stringify({ ok: true, completedAt: "2026-09-18T00:00:00.000Z" })}\n`, stderr: "", exitCode: 0 };
    }
    return super.exec(vm, argv as string[], stdin);
  }
}

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-j4-ontick-repo-"));
  const git = (...a: string[]): void => {
    const r = Bun.spawnSync(["git", ...a], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  };
  git("init", "-q", "-b", "main");
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Fixture {
  dir: string;
  store: RunRecordStore;
  driver: Driver;
  deps: (over?: Partial<ObserveSweepDeps>) => ObserveSweepDeps;
  seed: (runId: string) => Promise<string>;
}

function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-j4-ontick-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new RunRecordStore({ dir });
  const driver = new Driver(path.join(dir, "boxes"));
  const hostRoot = mkRepo();
  return {
    dir,
    store,
    driver,
    seed: async (runId) => {
      const rec = await createRun(driver, store, { runId, recordAuditLink: () => {} });
      store.set(runId, { requestId: "req-dispatch-stamp" } as never);
      return rec.vmName!;
    },
    deps: (over = {}) => ({
      driver,
      store,
      runsDir: dir,
      hostRoot,
      requestId: "req-j4-sweep",
      buildChainCtx: () => ({
        keyApi: new FakeKeyApi() as never,
        costLedger: { ingestBoxHours: () => {} } as never,
        recordAuditLink: () => {},
        close: () => {},
      }),
      ...over,
    }),
  };
}

const sweep = (o: SweepOutcome) => {
  if (o.kind !== "sweep") throw new Error(`expected sweep, got ${o.kind}`);
  // sweep_ms and the wall-clock-derived evidence differ run to run
  const { sweep_ms: _s, uptime_evidence: _u, ...rest } = o.summary;
  return rest;
};

describe("observeSweep onTick seam", () => {
  test("called exactly once per live resident with runId/vm/record/driver/sweepRequestId", async () => {
    const f = fixture();
    const vmA = await f.seed("run-a");
    const vmB = await f.seed("run-b");
    const calls: ObserveTickInfo[] = [];
    const out = await observeSweep(f.deps({ onTick: (i) => void calls.push(i) }));
    expect(sweep(out).runs_unsettled).toBe(2);
    expect(calls.map((c) => c.runId).sort()).toEqual(["run-a", "run-b"]);
    const a = calls.find((c) => c.runId === "run-a")!;
    expect(a.vm).toBe(vmA);
    expect(calls.find((c) => c.runId === "run-b")!.vm).toBe(vmB);
    expect(a.record.runId).toBe("run-a");
    expect(a.record.requestId).toBe("req-dispatch-stamp");
    expect(a.driver).toBe(f.driver);
    expect(a.sweepRequestId).toBe("req-j4-sweep");
  });

  test("runs inside the run's lock", async () => {
    const f = fixture();
    await f.seed("run-a");
    let lockPresent = false;
    await observeSweep(f.deps({ onTick: (i) => {
          lockPresent = fs.existsSync(path.join(f.dir, `${i.runId}.lock`));
        },
      }));
    expect(lockPresent).toBe(true);
    expect(fs.existsSync(path.join(f.dir, "run-a.lock"))).toBe(false);
  });

  test("not called for engine-dead, unreachable, settled, locked-out or skipped residents", async () => {
    const f = fixture();
    const holder = liveChild();
    try {
      await f.seed("run-dead");
      await f.seed("run-silent");
      await f.seed("run-settled");
      await f.seed("run-locked");
      f.driver.activityByVm.set(f.store.get("run-dead").vmName!, "failed");
      f.driver.markerByVm.set(f.store.get("run-silent").vmName!, "silent");
      f.driver.markerByVm.set(f.store.get("run-settled").vmName!, "settled");
      // a foreign live holder on run-locked
      const h = acquireRunLock(f.dir, "qds-19990101-000000");
      const host = fs.readFileSync(h, "utf8").trim().split(/\s+/)[1]!;
      releaseRunLock(h);
      fs.writeFileSync(path.join(f.dir, "run-locked.lock"), `${holder.pid} ${host} ${new Date().toISOString()} deadbeef\n`);
      await f.seed("run-skipped"); // newest: cut off by maxCandidatesPerPass
      const calls: string[] = [];
      const out = await observeSweep(f.deps({ maxCandidatesPerPass: 4, onTick: (i) => void calls.push(i.runId) }));
      const s = sweep(out);
      expect(s.runs_unsettled).toBe(0);
      expect(s.runs_engine_dead).toBe(1);
      expect(s.runs_box_unreachable).toBe(1);
      expect(s.lock_refused).toBe(1);
      expect(s.candidates_skipped).toBe(1);
      expect(calls).toEqual([]);
    } finally {
      holder.kill();
    }
  });

  test("a throwing and a rejecting hook leave the outcome identical to a no-hook run; failure is logged without a stack", async () => {
    const run = async (onTick?: ObserveSweepDeps["onTick"]) => {
      const f = fixture();
      await f.seed("run-a");
      await f.seed("run-b");
      const lines = captureLogs();
      const out = await observeSweep(f.deps(onTick === undefined ? {} : { onTick }));
      return { s: sweep(out), lines, lockLeft: fs.readdirSync(f.dir).filter((n) => n.endsWith(".lock")) };
    };
    const base = await run();
    const thrown = await run(() => {
      throw new Error("sync boom");
    });
    const rejected = await run(async () => {
      throw new Error("async boom");
    });
    expect(thrown.s).toEqual(base.s);
    expect(rejected.s).toEqual(base.s);
    expect(thrown.lockLeft).toEqual([]);
    expect(rejected.lockLeft).toEqual([]);
    const fails = thrown.lines.filter((l) => l.event === "sweep-ontick-failed");
    expect(fails).toHaveLength(2);
    expect(String(fails[0]!.error)).toContain("sync boom");
    expect(base.lines.some((l) => l.event === "sweep-ontick-failed")).toBe(false);
  });

  test("a hanging hook is bounded by onTickDeadlineMs and changes nothing", async () => {
    const f = fixture();
    await f.seed("run-a");
    const base = sweep(await observeSweep(f.deps()));
    const lines = captureLogs();
    const t0 = Date.now();
    const out = await observeSweep(f.deps({ onTick: () => new Promise<void>(() => {}), onTickDeadlineMs: 50 }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(sweep(out)).toEqual(base);
    const fail = lines.find((l) => l.event === "sweep-ontick-failed");
    expect(String(fail?.error)).toContain("timed out");
    expect(fs.readdirSync(f.dir).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });

  test("absent hook: counters identical to a hooked run's counters", async () => {
    const f = fixture();
    await f.seed("run-a");
    const without = sweep(await observeSweep(f.deps()));
    const withHook = sweep(await observeSweep(f.deps({ onTick: () => {} })));
    expect(withHook).toEqual(without);
    expect(without.runs_unsettled).toBe(1);
  });
});
