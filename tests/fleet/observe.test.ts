/**
 * DF3.8 — `observeSweep` (`fleet observe --all`) — story
 * `df3-8-host-completion-watcher.md` ACs 1-6 (the unit tier; AC7's live
 * detachment round is `tests/fleet/e2e/tier3-observe-detached.live.test.ts`).
 *
 * Harness idioms copied from tests/fleet/run-completion.test.ts (store()
 * factory + try/finally, ProbeDriver's marker-probe interception, the
 * fake-clock-free maxTicks shapes, captureLogs/quietLogs) and
 * tests/fleet/cli.test.ts (deadPid/liveChild for forged lock bodies, the
 * `run()` CLI seam with injected FleetDeps).
 *
 * Negative-control discipline (story AC2/AC3/AC4): every control is encoded as
 * a test pinning the CORRECT behavior, so the naive implementation it names
 * (read-before-lock, lock-inside-the-chain, no-margin uptime arithmetic,
 * seconds-vs-milliseconds, retire-on-liveness, exit-non-zero-on-refusal) turns
 * the pin red rather than being asserted as broken.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { createRun, type ExecResult, type ProviderAuditLink, type ProviderVmListing } from "../../src/providers/driver.ts";
import { RunRecordStore, type ExtensionEntry, type RunRecord } from "../../src/providers/run-record.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { setLogSink } from "../../src/swarmclaw/log.ts";
import { acquireRunLock, clearRunLockDestructive, releaseRunLock } from "../../scripts/lib/run-lock.ts";
import { deadPid, liveChild } from "./helpers.ts";
import { BOX_MARKER_PATH_RE } from "../../src/fleet/fanout-primitive.ts";
import { listVerbs, renderHelp } from "../../src/fleet/verbs.ts";
import {
  MAX_CANDIDATES_PER_PASS,
  PROVISION_LAG_MARGIN_MS,
  SWEEP_INTERVAL_MINUTES,
  SWEEP_WALL_CLOCK_BUDGET_MS,
  observeSweep,
  type ObserveSweepDeps,
  type SweepSummary,
} from "../../src/fleet/observe.ts";
import { run as fleetRun, type FleetDeps } from "../../scripts/fleet.ts";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_PATH = path.join(REPO_ROOT, "src", "fleet", "observe.ts");
const FLEET_TS_PATH = path.join(REPO_ROOT, "scripts", "fleet.ts");

// ─── log sink idioms (run-completion.test.ts) ────────────────────────────────

const quietLogRestores: Array<() => void> = [];
function quietLogs(): void {
  quietLogRestores.push(setLogSink(() => undefined));
}
function captureLogs(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  quietLogRestores.push(
    setLogSink((entry) => {
      lines.push(entry as Record<string, unknown>);
    }),
  );
  return lines;
}
afterEach(() => {
  for (const restore of quietLogRestores.splice(0)) restore();
  disarmFakeClock();
});

// ─── fake clock (run-completion.test.ts's idiom: a restorable Date.now spy) ──

let dateNowSpy: ReturnType<typeof spyOn<typeof Date, "now">> | null = null;
let fakeClockMs = 0;

function armFakeClock(startMs: number = Date.now()): void {
  disarmFakeClock();
  fakeClockMs = startMs;
  dateNowSpy = spyOn(Date, "now").mockImplementation(() => fakeClockMs);
}

function disarmFakeClock(): void {
  if (dateNowSpy !== null) {
    dateNowSpy.mockRestore();
    dateNowSpy = null;
  }
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function store(): { store: RunRecordStore; dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-df38-"));
  return {
    dir,
    store: new RunRecordStore({ dir }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Per-tick marker-read plan, run-completion.test.ts's shape (subset the sweep reaches at maxTicks 1). */
type MarkerPlan = { body: Record<string, unknown> | null } | { rawBody: string } | { catExit: number } | { forcedProbeExit: number };

/**
 * The sweep's inline fake driver: ProbeDriver's interception plus the two
 * `/proc/uptime` legs `readBoxFile` issues (`test -f` then `cat`).
 * `uptimeSeconds`: number = a parseable first float; null = the file READS but
 * is garbage (parse failure); undefined = the file is absent.
 */
class SweepDriver extends FakeDriver {
  calls: Array<{ argv: readonly string[] }> = [];
  destroyed: string[] = [];
  plan: MarkerPlan[] = [{ body: null }];
  activity = "active";
  /** Per-box override of the `systemctl is-active` word — liveness shapes differ per candidate. */
  activityByVm = new Map<string, string>();
  unitProbeExit = 0;
  uptimeSeconds: number | null | undefined = 0;
  /** F1 seams: make the raw readBoxFile legs REJECT (withTimeout/driver-throw shape). */
  uptimeThrows = false;
  markerProbeThrows = false;
  destroyThrows = false;
  #tick = 0;
  #tickPlan: MarkerPlan | null = null;

  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin);
  }

  override async execTimed(vm: string, argv: string[], _timeoutMs: number, stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin);
  }

  override async destroy(vm: string): Promise<void> {
    this.destroyed.push(vm);
    if (this.destroyThrows) {
      const { FakeDriverError } = await import("../../src/providers/fake-driver.ts");
      throw new FakeDriverError(
        "destroy-failed-by-test",
        `driver could not confirm destruction of ${vm} (forced by the test seam)`,
        "this refusal is the test seam",
      );
    }
    return super.destroy(vm);
  }

  get markerTicks(): number {
    return this.#tick;
  }

  private async intercept(vm: string, argv: readonly string[], stdin?: string): Promise<ExecResult> {
    this.calls.push({ argv });
    const cmd = argv.length >= 3 && argv[0] === "sh" && argv[1] === "-c" && typeof argv[2] === "string" ? argv[2] : "";
    if (argv[0] === "systemctl" && argv[1] === "is-active") {
      if (this.unitProbeExit !== 0) {
        return { stdout: "", stderr: `ssh: transport failed (exit ${this.unitProbeExit})`, exitCode: this.unitProbeExit };
      }
      return { stdout: `${this.activityByVm.get(vm) ?? this.activity}\n`, stderr: "", exitCode: 0 };
    }
    if (cmd.includes("/proc/uptime") && cmd.includes("test -f")) {
      if (this.uptimeThrows) throw new Error("uptime probe rejected by the test seam");
      return this.uptimeSeconds === undefined
        ? { stdout: "", stderr: "", exitCode: 1 } // the clean miss — the file is not there
        : { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("cat ") && cmd.includes("/proc/uptime")) {
      if (this.uptimeSeconds === null) return { stdout: "garbage-not-a-float", stderr: "", exitCode: 0 };
      return { stdout: `${this.uptimeSeconds} ${this.uptimeSeconds}\n`, stderr: "", exitCode: 0 };
    }
    if ((cmd.includes("test -f") || cmd.includes("cat ")) && BOX_MARKER_PATH_RE.test(cmd) && this.markerProbeThrows) {
      throw new Error("marker probe rejected by the test seam");
    }
    if (cmd.includes("test -f") && BOX_MARKER_PATH_RE.test(cmd)) {
      this.#tickPlan = this.plan[Math.min(this.#tick++, this.plan.length - 1)]!;
      if ("forcedProbeExit" in this.#tickPlan) {
        return { stdout: "", stderr: `ssh: connect refused (exit ${this.#tickPlan.forcedProbeExit})`, exitCode: this.#tickPlan.forcedProbeExit };
      }
      return "body" in this.#tickPlan && this.#tickPlan.body === null
        ? { stdout: "", stderr: "", exitCode: 1 }
        : { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("cat ") && BOX_MARKER_PATH_RE.test(cmd)) {
      const p = this.#tickPlan ?? this.plan[0]!;
      if ("catExit" in p) return { stdout: "", stderr: `cat: forced (exit ${p.catExit})`, exitCode: p.catExit };
      if ("rawBody" in p) return { stdout: p.rawBody, stderr: "", exitCode: 0 };
      return { stdout: `${JSON.stringify("body" in p ? p.body : null)}\n`, stderr: "", exitCode: 0 };
    }
    return super.exec(vm, argv as string[], stdin);
  }
}

/** A driver whose listing cannot be proven complete — the typed start-up refusal. */
class UnverifiedDriver extends SweepDriver {
  override async listWithAnomalies(name?: string): Promise<ProviderVmListing> {
    const base = await super.listWithAnomalies(name);
    return { ...base, skipped: ["entry-0 (row had no name)"] };
  }
}

/** Seed an open candidate: record + live fake box, dispatch-stamped. */
async function seedCandidate(s: RunRecordStore, driver: SweepDriver, runId: string, patch: Record<string, unknown> = {}): Promise<string> {
  const rec = await createRun(driver, s, { runId, recordAuditLink: () => {} });
  s.set(runId, { requestId: "req-dispatch-stamp", ...patch } as never);
  return rec.vmName!;
}

/** Hand-rewrite `createdAt` (immutable via set()) — the run-completion.test.ts hand-edit idiom. */
function ageRecord(s: RunRecordStore, runId: string, ageMs: number): void {
  const p = s.path(runId);
  const rec = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  rec.createdAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(p, JSON.stringify(rec));
}

const SHA_A = "a".repeat(40);
const approvalExt = (state: string): ExtensionEntry => ({
  schemaVersion: 2,
  state,
  proposal: "open a PR",
  reportId: "rv-other-actor",
  headSha: SHA_A,
  requestedAt: "2026-09-15T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  supersededReportIds: [],
});

/** A real lock body's `<host>` field, captured from an in-process acquire (lockHost is module-private). */
function lockHostToken(runsDir: string): string {
  const h = acquireRunLock(runsDir, "qds-19990101-000000");
  try {
    return fs.readFileSync(h, "utf8").trim().split(/\s+/)[1]!;
  } finally {
    releaseRunLock(h);
  }
}

/** Forge a foreign-holder lock: `<pid> <host> <ISO> <nonce>` with the pid of our choosing. */
function forgeLock(runsDir: string, runId: string, pid: number, host: string): void {
  fs.writeFileSync(path.join(runsDir, `${runId}.lock`), `${pid} ${host} ${new Date().toISOString()} deadbeef\n`);
}

/**
 * Records, at each run's FIRST get(), whether its own lock file is on disk and
 * which lock files exist — the ordering evidence for AC2's lock-before-preflight
 * pin and the serial release pin. A naive implementation that reads the record
 * before acquiring leaves `ownLockPresent: false` and fails the pin.
 */
class RecordingStore extends RunRecordStore {
  readonly reads: Array<{ runId: string; ownLockPresent: boolean; lockFiles: string[] }> = [];
  #seen = new Set<string>();
  /** Start (or restart) recording — seeding itself gets records, and only the sweep's reads are evidence. */
  arm(): void {
    this.reads.length = 0;
    this.#seen.clear();
  }
  override get(runId: string): ReturnType<RunRecordStore["get"]> {
    const r = super.get(runId);
    if (!this.#seen.has(runId)) {
      this.#seen.add(runId);
      const lockFiles = fs.readdirSync(this.dir).filter((n) => n.endsWith(".lock"));
      this.reads.push({ runId, ownLockPresent: lockFiles.includes(`${runId}.lock`), lockFiles: [...lockFiles] });
    }
    return r;
  }
}

/**
 * AC3's reachable state: `listWithAnomalies()` answers from a snapshot taken
 * BEFORE the record was collected, `get()` reads live — exactly what a reaper
 * landing between enumeration and acquisition produces.
 */
class SnapshotListStore extends RunRecordStore {
  #snapshot: { records: RunRecord[]; skipped: string[]; skippedReasons: string[] } | null = null;
  freeze(): void {
    this.#snapshot = super.listWithAnomalies();
  }
  override listWithAnomalies(): ReturnType<RunRecordStore["listWithAnomalies"]> {
    return this.#snapshot ?? super.listWithAnomalies();
  }
}

function quietLedger(): { hook: { ingestBoxHours(ctx: Record<string, unknown>): void }; ingested: Array<Record<string, unknown>> } {
  const ingested: Array<Record<string, unknown>> = [];
  return { hook: { ingestBoxHours: (ctx) => ingested.push(ctx) }, ingested };
}

const chainCtxCalls: Array<{ runId: string }> = [];
function baseDeps(over: {
  driver: SweepDriver;
  store: RunRecordStore;
  runsDir: string;
  hostRoot?: string;
  buildChainCtx?: ObserveSweepDeps["buildChainCtx"];
  maxCandidatesPerPass?: number;
  wallClockBudgetMs?: number;
  recordAuditLink?: (link: ProviderAuditLink) => void;
}): ObserveSweepDeps {
  chainCtxCalls.length = 0;
  return {
    driver: over.driver,
    store: over.store,
    runsDir: over.runsDir,
    // The CALLER's worktree assert: the repo itself for every leg that never
    // enters reverify, a plain tmpdir for the refusal leg.
    hostRoot: over.hostRoot ?? REPO_ROOT,
    requestId: "req-df38-sweep",
    buildChainCtx:
      over.buildChainCtx ??
      ((rec: RunRecord) => {
        chainCtxCalls.push({ runId: rec.runId });
        return {
          keyApi: new FakeKeyApi() as never,
          costLedger: quietLedger().hook as never,
          recordAuditLink: over.recordAuditLink ?? (() => {}),
          close: () => {},
        };
      }),
    ...(over.maxCandidatesPerPass === undefined ? {} : { maxCandidatesPerPass: over.maxCandidatesPerPass }),
    ...(over.wallClockBudgetMs === undefined ? {} : { wallClockBudgetMs: over.wallClockBudgetMs }),
  };
}

const identityHolds = (s: SweepSummary): number =>
  s.runs_observed +
  s.runs_unsettled +
  s.runs_engine_dead +
  s.runs_box_unreachable +
  s.runs_lost_to_reboot +
  s.lock_refused +
  s.completion_unwitnessed +
  s.runs_vetoed +
  s.runs_approval_failed +
  s.runs_chain_failed +
  s.runs_handed_off +
  s.candidates_skipped;

// ─── module source (AC1 fence, shared with run-completion.test.ts's idioms) ──

async function moduleSource(): Promise<string> {
  return Bun.file(MODULE_PATH).text();
}

const FORBIDDEN_DIRECT = ["./approval-gate.ts", "./approvers.ts", "../pr/push.ts", "./index.ts"];

function importSpecifiers(src: string): string[] {
  const specifiers: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)) specifiers.push(m[1]!);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) specifiers.push(m[1]!);
  return specifiers;
}

function fenceViolations(src: string): string[] {
  return importSpecifiers(src).filter((s) => FORBIDDEN_DIRECT.includes(s));
}

function runRecordImportNames(src: string): string[] {
  const rrLine = src.match(/(?:^|\n)(\s*import[^;\n]*from\s*["']\.\.\/providers\/run-record\.ts["'];?)/)?.[1] ?? "";
  const braceStart = rrLine.indexOf("{");
  const braceEnd = rrLine.lastIndexOf("}");
  if (braceStart === -1 || braceEnd === -1) return [];
  return rrLine
    .slice(braceStart + 1, braceEnd)
    .split(",")
    .map((n) => n.trim().replace(/^type\s+/, ""))
    .filter((n) => n !== "");
}

const RUN_RECORD_READ_NAMES = ["RunRecord", "RunRecordStore"];

// ─── AC1: the fence and the composition ──────────────────────────────────────

describe("AC1 import fence + composition (source contract)", () => {
  test("the fence: no forbidden specifier, the composition and classifier required, run-record read-names only (negative control)", async () => {
    const src = await moduleSource();
    expect(fenceViolations(src)).toEqual([]);
    // REQUIRED — a second CALLER of the one entry point, and the shared paths.
    expect(importSpecifiers(src)).toContain("./run-completion.ts");
    expect(importSpecifiers(src)).toContain("./fanout-primitive.ts");
    expect(runRecordImportNames(src)).toContain("RunRecordStore");
    expect(runRecordImportNames(src).every((n) => RUN_RECORD_READ_NAMES.includes(n))).toBe(true);
    // NEGATIVE CONTROL: the fence is on DIRECT specifiers only; the transitive
    // reach through run-completion (which reaches the gate via reverify's port)
    // must NOT fail.
    const synthetic = [
      'import { observeAndDriveChain } from "./run-completion.ts";',
      'import { boxMarkerPath } from "./fanout-primitive.ts";',
      'import type { RunLockHandle } from "../../scripts/lib/run-lock.ts";',
    ].join("\n");
    expect(fenceViolations(synthetic)).toEqual([]);
  });

  test("the fence has TEETH: every forbidden specifier and a run-record writer symbol actually violate", async () => {
    for (const specifier of FORBIDDEN_DIRECT) {
      expect(fenceViolations(`import { gate } from "${specifier}";\n`)).toContain(specifier);
      expect(fenceViolations(`export { gate } from "${specifier}";\n`)).toContain(specifier);
    }
    const corrupt = 'import { type RunRecord, RunRecordStore, setApproval } from "../providers/run-record.ts";';
    expect(runRecordImportNames(corrupt).every((n) => RUN_RECORD_READ_NAMES.includes(n))).toBe(false);
  });

  test("no dynamic imports, no inlined chain (no teardown/reverify import), maxTicks: 1 pinned", async () => {
    const src = await moduleSource();
    expect(/\bimport\s*\(/.test(src)).toBe(false);
    expect(importSpecifiers(src)).not.toContain("../providers/teardown.ts");
    expect(importSpecifiers(src)).not.toContain("../reverify/runner.ts");
    expect(importSpecifiers(src)).not.toContain("../reverify/approval.ts");
    expect(src).toContain("observeAndDriveChain(");
    expect(src).toContain("maxTicks: 1");
  });

  test("the named bounds exist and are positive", () => {
    expect(PROVISION_LAG_MARGIN_MS).toBeGreaterThan(0);
    expect(MAX_CANDIDATES_PER_PASS).toBeGreaterThan(0);
    expect(SWEEP_WALL_CLOCK_BUDGET_MS).toBeGreaterThan(0);
    expect(SWEEP_INTERVAL_MINUTES).toBeGreaterThan(0);
  });
});

// ─── AC2: enumeration, the lock, serialism ───────────────────────────────────

describe("AC2 enumeration + lock discipline", () => {
  test("candidates = open record ∩ live listable box — closed, approval-carrying and box-less records are not enumerated", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-open");
      await seedCandidate(s.store, driver, "run-closed");
      s.store.close("run-closed");
      await seedCandidate(s.store, driver, "run-approved");
      s.store.set("run-approved", { extensions: { approval: approvalExt("awaiting-approval") } } as never);
      s.store.create("run-boxless");
      s.store.set("run-boxless", { vmName: "vm-nowhere", requestId: "req-x" } as never);
      // F3: a vmName-LESS record whose runId-named box IS live (the dispatch
      // crash window) — not a candidate: the chain's record-names-no-box
      // pre-flight would refuse it every tick forever; the leaked box is the
      // reaper's arm's to collect.
      await driver.create("run-leaked");
      s.store.create("run-leaked");
      s.store.set("run-leaked", { requestId: "req-x" } as never);
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.candidates_enumerated).toBe(1);
      expect(identityHolds(out.summary)).toBe(1);
      expect(out.summary.completion_unwitnessed).toBe(0); // never enumerated, never refused
    } finally {
      s.cleanup();
    }
  });

  test("oldest-createdAt-first: the aged record reaches the chain before the fresh one", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-new");
      await seedCandidate(s.store, driver, "run-old");
      ageRecord(s.store, "run-old", 3_600_000);
      driver.uptimeSeconds = 3_600; // no reboot decided for either candidate (lag inside the margin)
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      expect(chainCtxCalls.map((c) => c.runId)).toEqual(["run-old", "run-new"]);
    } finally {
      s.cleanup();
    }
  });

  test("the lock is acquired BEFORE the first per-run record read (negative control: read-before-lock MUST fail)", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-ord");
      const rec = new RecordingStore({ dir: s.dir });
      await seedCandidate(rec, driver, "run-ord2");
      rec.arm();
      await observeSweep(baseDeps({ driver, store: rec, runsDir: s.dir }));
      const first = rec.reads.find((r) => r.runId === "run-ord2");
      expect(first).toBeDefined();
      // The pin: at the sweep's first read of the record its OWN lock is on
      // disk — an implementation that checks the extension/state before
      // acquiring records ownLockPresent: false here.
      expect(first!.ownLockPresent).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  test("serial pass: candidate A's lock is RELEASED before candidate B's first in-lock read (never concurrent)", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-a");
      await seedCandidate(s.store, driver, "run-b");
      const rec = new RecordingStore({ dir: s.dir });
      await seedCandidate(rec, driver, "run-a2");
      await seedCandidate(rec, driver, "run-b2");
      ageRecord(rec, "run-a2", 60_000); // deterministic oldest-first order
      rec.arm();
      const out = await observeSweep(baseDeps({ driver, store: rec, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      const a = rec.reads.find((r) => r.runId === "run-a2")!;
      const b = rec.reads.find((r) => r.runId === "run-b2")!;
      expect(rec.reads.indexOf(a)).toBeLessThan(rec.reads.indexOf(b)); // oldest-first drove A first
      expect(b.lockFiles).not.toContain("run-a2.lock"); // A's lock was released before B's re-read
      expect(b.ownLockPresent).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  test("busy lock → counted lock-refused skip (stale:false), remediation carried, pass still completes", async () => {
    quietLogs();
    const s = store();
    const holder = liveChild();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-busy");
      forgeLock(s.dir, "run-busy", holder.pid, lockHostToken(s.dir));
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.lock_refused).toBe(1);
      expect(out.summary.candidates_enumerated).toBe(1);
      expect(identityHolds(out.summary)).toBe(1);
      expect(driver.calls.length).toBe(0); // refused before any box touch
    } finally {
      holder.kill();
      s.cleanup();
    }
  });

  test("STALE lock → its own line with stale:true and the rm remediation — never folded into the benign skip", async () => {
    const lines = captureLogs();
    const s = store();
    const corpse = await deadPid();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-stale");
      forgeLock(s.dir, "run-stale", corpse, lockHostToken(s.dir));
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.lock_refused).toBe(1);
      const line = lines.find((l) => l.event === "lock-refused");
      expect(line).toMatchObject({ runId: "run-stale", stale: true, operation: "fleet.observe", requestId: "req-df38-sweep" });
      expect(String(line!.remediation)).toContain("rm ");
      expect(line!.sweep_ms).toBeDefined();
    } finally {
      s.cleanup();
    }
  });

  test("a record file the listing could not read is NAMED on a log line, never silently dropped", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-ok");
      fs.writeFileSync(path.join(s.dir, "stray.json"), "{{{ not a record");
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      expect(lines.some((l) => l.event === "sweep-record-anomaly" && String(l.file).includes("stray.json"))).toBe(true);
    } finally {
      s.cleanup();
    }
  });
});

// ─── AC3: the collection window ──────────────────────────────────────────────

describe("AC3 the collection window (reaper / concurrent teardown)", () => {
  test("record collected between enumeration and acquisition → typed completion-unwitnessed, never the gate, zero driver calls, byte-identical record", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-raced");
      const snap = new SnapshotListStore({ dir: s.dir });
      snap.freeze(); // enumeration's view: open
      s.store.close("run-raced"); // the reaper's collection, between the two
      const before = fs.readFileSync(s.store.path("run-raced"));
      const out = await observeSweep(baseDeps({ driver, store: snap, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.completion_unwitnessed).toBe(1);
      expect(identityHolds(out.summary)).toBe(1);
      expect(driver.calls.length).toBe(0); // the re-read precedes the chain's only marker read
      expect(driver.destroyed).toEqual([]);
      expect(fs.readFileSync(s.store.path("run-raced"))).toEqual(before);
      const line = lines.find((l) => l.event === "completion-unwitnessed");
      expect(line).toMatchObject({ runId: "run-raced" });
      expect(String(line!.message)).toContain("between enumeration and lock acquisition");
    } finally {
      s.cleanup();
    }
  });

  test("a chain-side pre-flight refusal (approval registered between enumeration and lock) folds into completion_unwitnessed carrying DF3.7's code verbatim", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-fold");
      const snap = new SnapshotListStore({ dir: s.dir });
      snap.freeze();
      s.store.set("run-fold", { extensions: { approval: approvalExt("awaiting-approval") } } as never);
      const out = await observeSweep(baseDeps({ driver, store: snap, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.completion_unwitnessed).toBe(1);
      expect(out.summary.runs_observed).toBe(0);
      const line = lines.find((l) => l.event === "completion-unwitnessed");
      expect(String(line!.code)).toBe("approval-already-registered");
      expect(String(line!.remediation)).toContain("fleet approve");
    } finally {
      s.cleanup();
    }
  });

  test("source pin: the in-lock re-read precedes the chain call — no witnessed-re-entry branch", async () => {
    const src = await moduleSource();
    const rereadAt = src.indexOf("completion-unwitnessed");
    const chainAt = src.indexOf("observeAndDriveChain(");
    expect(rereadAt).toBeGreaterThanOrEqual(0);
    expect(chainAt).toBeGreaterThan(rereadAt);
    expect(src).not.toContain("markerWitnessed");
  });
});

// ─── AC4: the reboot measurement and the two retiring/reporting arms ─────────

describe("AC4 the reboot measurement", () => {
  test("never-rebooted box inside the margin → ZERO box_reboot_after_dispatch (naive no-margin MUST fail) and uptime_unknown counts it, never 'no reboot'", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-fresh");
      ageRecord(s.store, "run-fresh", 30 * 60_000); // 30 min old
      driver.uptimeSeconds = 30 * 60 - 5; // boot 5 s after createdAt — inside the margin
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.box_reboot_after_dispatch).toBe(0);
      expect(out.summary.uptime_unknown).toBe(1); // AC4a: inside the margin is unknown, never "no reboot"
      expect(out.summary.runs_unsettled).toBe(1); // the measurement decided nothing; the chain proceeded
      expect(identityHolds(out.summary)).toBe(1);
      const ev = out.summary.uptime_evidence[0]!;
      expect(ev.runId).toBe("run-fresh");
      expect(ev.provisionLagMs!).toBeGreaterThanOrEqual(0);
      expect(ev.provisionLagMs!).toBeLessThan(PROVISION_LAG_MARGIN_MS);
    } finally {
      s.cleanup();
    }
  });

  test("F8 boundary: uptimeMs EXACTLY ageMs − margin is unknown, NOT a reboot (the comparison is strict)", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-edge");
      // Fake clock: createdAt pinned exactly 1 h before the frozen hostNow,
      // uptime exactly (age − margin)/1000 — the strict `<` is the only thing
      // standing between this and a false confirmed reboot.
      const t0 = Date.now();
      armFakeClock(t0);
      const p = s.store.path("run-edge");
      const recFile = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      recFile.createdAt = new Date(t0 - 3_600_000).toISOString();
      fs.writeFileSync(p, JSON.stringify(recFile));
      driver.uptimeSeconds = (3_600_000 - PROVISION_LAG_MARGIN_MS) / 1000;
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.box_reboot_after_dispatch).toBe(0);
      expect(out.summary.uptime_unknown).toBe(1);
      expect(out.summary.runs_lost_to_reboot).toBe(0);
      expect(out.summary.uptime_evidence[0]!.provisionLagMs).toBe(PROVISION_LAG_MARGIN_MS);
    } finally {
      s.cleanup();
    }
  });

  test("F8 guard: a garbage createdAt never reaches the arithmetic — the store's own listing validation skips it as a named anomaly", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-badstamp");
      const p = s.store.path("run-badstamp");
      const recFile = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      recFile.createdAt = "not-a-timestamp";
      fs.writeFileSync(p, JSON.stringify(recFile));
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.candidates_enumerated).toBe(0); // never a candidate, so the NaN age never enters the inequality
      expect(out.summary.box_reboot_after_dispatch).toBe(0);
      expect(lines.some((l) => l.event === "sweep-record-anomaly" && String(l.file).includes("run-badstamp"))).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  test("rebooted box (uptime ≪ age − margin, ms on both sides) counts 1 per distinct runId — raw seconds vs ms age MUST fail on the healthy case above", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-rebooted");
      ageRecord(s.store, "run-rebooted", 3_600_000); // 1 h old
      driver.uptimeSeconds = 300; // box has been up 5 min — a reboot 55 min in
      driver.plan = [{ rawBody: "present-but-unjudgeable" }]; // marker present → falls through
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.box_reboot_after_dispatch).toBe(1);
      expect(out.summary.uptime_unknown).toBe(0);
      expect(out.summary.runs_lost_to_reboot).toBe(0); // the marker is present — the chain's own read classifies it
      expect(out.summary.runs_unsettled).toBe(1);
      expect(out.summary.uptime_evidence[0]!.provisionLagMs!).toBeGreaterThanOrEqual(PROVISION_LAG_MARGIN_MS);
    } finally {
      s.cleanup();
    }
  });

  test("confirmed reboot + absent marker → run-lost-to-reboot once per pass, box NOT destroyed and still listable, candidate re-enumerated next pass", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      const vm = await seedCandidate(s.store, driver, "run-lost");
      ageRecord(s.store, "run-lost", 3_600_000);
      driver.uptimeSeconds = 300;
      driver.plan = [{ body: null }]; // tmpfs marker gone with the reboot
      const before = fs.readFileSync(s.store.path("run-lost"));
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.runs_lost_to_reboot).toBe(1);
      expect(out.summary.box_reboot_after_dispatch).toBe(1);
      expect(identityHolds(out.summary)).toBe(1);
      expect(driver.destroyed).toEqual([]); // INV-5: the refusal is the operator's cue, never a licence to destroy
      expect((await driver.list()).map((b) => b.name)).toContain(vm); // alive and listable
      expect(fs.readFileSync(s.store.path("run-lost"))).toEqual(before);
      const line = lines.find((l) => l.event === "run-lost-to-reboot");
      expect(line).toMatchObject({ runId: "run-lost" });
      expect(`${String(line!.message)} ${String(line!.remediation ?? "")}`).toContain("fleet teardown run-lost");
      // The refusal does NOT retire the candidate: the next tick re-enumerates
      // and re-reports it (liveness cannot tell started-then-rebooted from
      // never-started — the unit carries no [Install] section either way).
      const second = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(second.kind).toBe("sweep");
      if (second.kind !== "sweep") return;
      expect(second.summary.candidates_enumerated).toBe(1);
      expect(second.summary.runs_lost_to_reboot).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  test("unparseable /proc/uptime → uptime_unknown, never 'no reboot'; the chain still proceeds", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-garbage");
      ageRecord(s.store, "run-garbage", 3_600_000);
      driver.uptimeSeconds = null; // the file reads, but not as two floats
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.uptime_unknown).toBe(1);
      expect(out.summary.box_reboot_after_dispatch).toBe(0);
      expect(out.summary.runs_lost_to_reboot).toBe(0);
      expect(out.summary.runs_unsettled).toBe(1);
      expect(out.summary.uptime_evidence[0]!.uptimeSeconds).toBeNull();
    } finally {
      s.cleanup();
    }
  });

  test("absent /proc/uptime → uptime_unknown (a failed measurement is not a zero) with a null-valued evidence entry (F5)", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-nouptime");
      driver.uptimeSeconds = undefined;
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.uptime_unknown).toBe(1);
      expect(out.summary.runs_unsettled).toBe(1);
      // F5: the unknown box still earns its raw entry — the margin must be
      // re-derivable from data, unknown boxes included.
      expect(out.summary.uptime_evidence).toHaveLength(1);
      expect(out.summary.uptime_evidence[0]!).toMatchObject({ runId: "run-nouptime", uptimeSeconds: null, provisionLagMs: null });
    } finally {
      s.cleanup();
    }
  });

  test("F1: a REJECTED uptime read → uptime_unknown + null evidence, and the pass proceeds to the chain (never an abort)", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-deadssh");
      driver.uptimeThrows = true;
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.uptime_unknown).toBe(1);
      expect(out.summary.uptime_evidence[0]!).toMatchObject({ runId: "run-deadssh", uptimeSeconds: null, provisionLagMs: null });
      expect(out.summary.runs_unsettled).toBe(1); // the chain ran — absent marker, active unit
      expect(identityHolds(out.summary)).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  test("F1: a REJECTED reboot-arm marker read reads as not-absent — the chain's own read classifies (skip → sweep-box-unreachable), never an abort", async () => {
    quietLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-rejmark");
      ageRecord(s.store, "run-rejmark", 3_600_000);
      driver.uptimeSeconds = 300; // reboot confirmed — the marker read is the decider
      driver.markerProbeThrows = true;
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.box_reboot_after_dispatch).toBe(1);
      expect(out.summary.runs_lost_to_reboot).toBe(0); // a rejection is not an absence
      expect(out.summary.runs_box_unreachable).toBe(1); // the chain's classified read decided
      expect(identityHolds(out.summary)).toBe(1);
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("unitActivity failed → sweep-engine-dead: counted, own line, in-pass retire, re-enumerated and re-counted next tick", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-dead1");
      ageRecord(s.store, "run-dead1", 7_200_000); // oldest — the queue head the arm exists for
      await seedCandidate(s.store, driver, "run-walk1");
      driver.activityByVm.set("run-dead1", "failed"); // only THIS unit is dead
      driver.uptimeSeconds = 7_200; // up as long as the oldest run — no reboot in play, the liveness arm decides
      const before = fs.readFileSync(s.store.path("run-dead1"));
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.runs_engine_dead).toBe(1);
      expect(out.summary.runs_unsettled).toBe(1); // the younger candidate still got its disposition
      expect(identityHolds(out.summary)).toBe(2);
      expect(driver.destroyed).toEqual([]);
      expect(fs.readFileSync(s.store.path("run-dead1"))).toEqual(before);
      expect(lines.some((l) => l.event === "sweep-engine-dead" && l.runId === "run-dead1")).toBe(true);
      // Nothing is persisted: the next tick re-enumerates and re-refuses, each
      // counted and reported — never folded into a healthy runs_observed: 0.
      const second = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(second.kind).toBe("sweep");
      if (second.kind !== "sweep") return;
      expect(second.summary.candidates_enumerated).toBe(2);
      expect(second.summary.runs_engine_dead).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  test("skip verdict (box listable, never answers) → sweep-box-unreachable disposition, kept, never runs_unsettled", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-silent");
      driver.plan = [{ forcedProbeExit: 255 } as { forcedProbeExit: number }];
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.runs_box_unreachable).toBe(1);
      expect(out.summary.runs_unsettled).toBe(0);
      expect(lines.some((l) => l.event === "sweep-box-unreachable" && l.runId === "run-silent")).toBe(true);
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  });
});

// ─── the chain through the sweep: driven, vetoed, chain-failed ────────────────

describe("the chain through the sweep (AC1 driven / outcome counters)", () => {
  test("a settled marker on a dispatch-long-gone run reaches awaiting-approval by DF3.7's chain — driven, links forwarded, run-observed with chain_ms", async () => {
    const lines = captureLogs();
    const s = store();
    const host = mkGitHost();
    let links: ProviderAuditLink[] = [];
    try {
      quarantine(host, "run-green");
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      const runId = "run-green";
      const rec = await createRun(driver, s.store, { runId, recordAuditLink: () => {} });
      seedBoxGit(driver, rec.vmName!, host, runId);
      s.store.set(runId, {
        commitSha: host.baseSha,
        requestId: "req-dispatch-stamp",
        extensions: { budget: { repoSlug: "acme/widget", issueId: "7" } },
      } as never);
      ageRecord(s.store, runId, 3_600_000); // dispatched an hour ago — the host was gone all along
      driver.uptimeSeconds = 3_600 - 5; // inside the margin: no reboot decided
      driver.plan = [{ body: { runId, ok: true, completedAt: "2026-09-18T00:00:00.000Z" } }];
      links = [];
      const out = await observeSweep(
        baseDeps({ driver, store: s.store, runsDir: s.dir, hostRoot: host.dir, recordAuditLink: (l) => links.push(l) }),
      );
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.runs_observed).toBe(1);
      expect(identityHolds(out.summary)).toBe(1);
      const after = s.store.get(runId);
      expect(after.closedAt).toBeTruthy();
      expect(after.extensions?.approval?.state).toBe("awaiting-approval"); // written only by the gate
      expect(fs.existsSync(path.join(s.dir, `${runId}.bundle`))).toBe(true);
      expect(driver.destroyed).toEqual([rec.vmName!]); // createRun always persists the box name
      expect(links.some((l) => l.event === "teardown")).toBe(true); // the seam forwards into the real teardown
      const line = lines.find((l) => l.event === "run-observed");
      expect(line).toMatchObject({ runId, requestId: "req-df38-sweep", operation: "fleet.observe" });
      expect(typeof line!.chain_ms).toBe("number");
      expect(typeof line!.sweep_ms).toBe("number");
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 180_000);

  test("dispatched-but-never-started (inactive, no marker, no reboot) survives a full sweep with NO terminal refusal, then drives normally once started", async () => {
    quietLogs();
    const s = store();
    const host = mkGitHost();
    try {
      quarantine(host, "run-never");
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      const runId = "run-never";
      const rec = await createRun(driver, s.store, { runId, recordAuditLink: () => {} });
      seedBoxGit(driver, rec.vmName!, host, runId);
      s.store.set(runId, {
        commitSha: host.baseSha,
        requestId: "req-dispatch-stamp",
        extensions: { budget: { repoSlug: "acme/widget", issueId: "7" } },
      } as never);
      driver.activity = "inactive"; // never started — reads exactly like a dead unit to liveness
      driver.plan = [{ body: null }];
      const first = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }));
      expect(first.kind).toBe("sweep");
      if (first.kind === "sweep") {
        expect(first.summary.runs_unsettled).toBe(1);
        expect(first.summary.runs_engine_dead).toBe(0);
        expect(first.summary.runs_lost_to_reboot).toBe(0);
        expect(identityHolds(first.summary)).toBe(1);
      }
      expect(driver.destroyed).toEqual([]); // no death certificate for a run fleet run would still start
      // Once the engine starts and settles, the SAME candidate drives normally.
      driver.activity = "active";
      driver.plan = [{ body: { runId, ok: true, completedAt: "2026-09-18T00:00:00.000Z" } }];
      const second = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }));
      expect(second.kind).toBe("sweep");
      if (second.kind === "sweep") {
        expect(second.summary.runs_observed).toBe(1);
      }
      expect(s.store.get(runId).extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 180_000);

  test("a settled marker over a record with no base sha → vetoed counted in runs_vetoed with its own line (the chain ran, the host said no)", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-veto");
      driver.plan = [{ body: { runId: "run-veto", ok: true } }];
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.runs_vetoed).toBe(1);
      expect(out.summary.runs_observed).toBe(0);
      expect(out.summary.candidates_skipped).toBe(0); // never a benign skip
      expect(identityHolds(out.summary)).toBe(1);
      expect(lines.some((l) => l.event === "sweep-vetoed" && l.runId === "run-veto")).toBe(true);
    } finally {
      s.cleanup();
    }
  }, 120_000);

  test("a chain that throws lands runs_chain_failed, the marked lock is left for the operator, and the NEXT candidate still gets its disposition", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-boom");
      await seedCandidate(s.store, driver, "run-after");
      ageRecord(s.store, "run-boom", 60_000); // first in line
      driver.plan = [{ body: { runId: "run-boom", ok: true } }, { body: null }];
      driver.destroyThrows = true;
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.runs_chain_failed).toBe(1);
      expect(out.summary.runs_unsettled).toBe(1); // the pass survived
      expect(identityHolds(out.summary)).toBe(2);
      expect(s.store.get("run-boom").closedAt).toBeUndefined(); // abort ⇒ record open
      expect(lines.some((l) => l.event === "sweep-chain-failed" && l.runId === "run-boom")).toBe(true);
    } finally {
      // The chain's destructive mark is process-global state — keep it out of later tests.
      clearRunLockDestructive(path.join(s.dir, "run-boom.lock"));
      s.cleanup();
    }
  }, 120_000);

  test("F2: a chain-CONTEXT construction failure (no key env on a keyed record) counts runs_chain_failed with its code verbatim and the pass continues", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-nokey", { keyHash: "key-hash-x" });
      await seedCandidate(s.store, driver, "run-tail2");
      ageRecord(s.store, "run-nokey", 60_000); // the wedging head, oldest first
      const out = await observeSweep(
        baseDeps({
          driver,
          store: s.store,
          runsDir: s.dir,
          buildChainCtx: (rec) => {
            if (rec.runId === "run-nokey") throw Object.assign(new Error("key env missing"), { code: "no-key-env" });
            return {
              keyApi: new FakeKeyApi() as never,
              costLedger: quietLedger().hook as never,
              recordAuditLink: () => {},
              close: () => {},
            };
          },
        }),
      );
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.runs_chain_failed).toBe(1);
      expect(out.summary.runs_unsettled).toBe(1); // the tail was NOT starved
      expect(identityHolds(out.summary)).toBe(2);
      const line = lines.find((l) => l.event === "sweep-chain-failed");
      expect(line).toMatchObject({ runId: "run-nokey", code: "no-key-env" });
    } finally {
      s.cleanup();
    }
  });
});

// ─── AC6: pass shape, hostRoot, help, no daemon ──────────────────────────────

describe("AC6 pass shape, hostRoot, help, no daemon", () => {
  test("empty sweep: kind sweep, all counters zero, sweep-complete line, nothing persisted", async () => {
    const lines = captureLogs();
    const s = store();
    const before = fs.readdirSync(s.dir);
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.candidates_enumerated).toBe(0);
      expect(identityHolds(out.summary)).toBe(0);
      expect(out.summary.uptime_evidence).toEqual([]);
      const done = lines.find((l) => l.event === "sweep-complete");
      expect(done).toMatchObject({ requestId: "req-df38-sweep", candidates_enumerated: 0, runs_observed: 0 });
      expect(fs.readdirSync(s.dir)).toEqual(before); // no cursor, no observation record, nothing
    } finally {
      s.cleanup();
    }
  });

  test("partial pass (maxCandidatesPerPass 1 over 2): candidates_skipped names the count, chain_ms ABSENT on the skipped line, identity holds", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-first");
      await seedCandidate(s.store, driver, "run-tail");
      ageRecord(s.store, "run-first", 60_000);
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir, maxCandidatesPerPass: 1 }));
      expect(out.kind).toBe("sweep");
      if (out.kind !== "sweep") return;
      expect(out.summary.candidates_enumerated).toBe(2);
      expect(out.summary.runs_unsettled).toBe(1);
      expect(out.summary.candidates_skipped).toBe(1);
      expect(identityHolds(out.summary)).toBe(2);
      const skipped = lines.find((l) => l.event === "candidate-skipped");
      expect(skipped).toBeDefined();
      expect(skipped!.left_behind).toBe(1);
      expect(skipped!.chain_ms).toBeUndefined(); // absent, never 0 — 0 is a lie shaped like an instant chain
    } finally {
      s.cleanup();
    }
  });

  test("non-worktree hostRoot → typed refused reverify-host-root-unusable at start-up, ZERO driver calls, zero records touched", async () => {
    quietLogs();
    const s = store();
    const notARepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-df38-norepo-"));
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-wt");
      const before = fs.readFileSync(s.store.path("run-wt"));
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir, hostRoot: notARepo }));
      expect(out).toMatchObject({ kind: "refused", code: "reverify-host-root-unusable" });
      expect(driver.calls.length).toBe(0); // refused before any box was touched
      expect(driver.destroyed).toEqual([]);
      expect(fs.readFileSync(s.store.path("run-wt"))).toEqual(before);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
      s.cleanup();
    }
  });

  test("unverified driver listing → typed refused at start-up, zero boxes touched", async () => {
    quietLogs();
    const s = store();
    try {
      // Seed through a driver whose listing IS verifiable (createRun's own
      // headroom check reads the listing), then sweep through one whose is not
      // — over the same boxes root, so the candidate set is real.
      const seeder = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, seeder, "run-uv");
      const driver = new UnverifiedDriver(path.join(s.dir, "boxes"));
      const out = await observeSweep(baseDeps({ driver, store: s.store, runsDir: s.dir }));
      expect(out).toMatchObject({ kind: "refused" });
      expect((out as { code: string }).code).toContain("listing");
      expect(driver.calls.length).toBe(0);
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("--help renders the documented cd-prefixed cron line with the derived interval", () => {
    const help = renderHelp(listVerbs());
    expect(help).toContain("--all");
    expect(help).toContain(`*/${SWEEP_INTERVAL_MINUTES} * * * * cd `);
    expect(help).toContain("observe --all --driver exedev");
  });

  test("no daemon: no interval timer in the module, --all is a boolean flag, no process ships", async () => {
    const src = await moduleSource();
    expect(src).not.toContain("setInterval");
    expect(src).not.toContain("--daemon");
    const entry = listVerbs().find((v) => v.verb === "observe")!;
    expect(entry.flags.find((f) => f.name === "--all")).toMatchObject({ required: false, valueType: "boolean" });
    expect(entry.exitCodes).toEqual([0, 1, 2, 4, 5, 6]); // DF3.7's table, unchanged — no new code
  });

  test("source pin: the --all branch returns BEFORE the single-run path, and DF3.7's lock-before-preflight order survives (structural slice)", async () => {
    const fleetSrc = await Bun.file(FLEET_TS_PATH).text();
    const start = fleetSrc.indexOf("async function runObserve(");
    const end = fleetSrc.indexOf("async function runDispatch(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = fleetSrc.slice(start, end);
    const allAt = block.indexOf("bools.has(\"--all\")");
    const lockAt = block.indexOf("withRunLock");
    const readAt = Math.min(...[block.indexOf("assertRunExists"), block.indexOf("store.get")].filter((i) => i >= 0));
    expect(allAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(allAt).toBeLessThan(lockAt); // the sweep arm returns before the single-run path
    expect(lockAt).toBeLessThan(readAt); // DF3.7's pin, still intact
  });
});

// ─── CLI wiring: the exit-0 contract through scripts/fleet.ts ────────────────

describe("CLI: fleet observe --all (exit-0 contract)", () => {
  function cliDeps(driver: FakeDriver, s: RunRecordStore): Partial<FleetDeps> {
    return { driver, store: s, keyApi: new FakeKeyApi() };
  }

  test("empty sweep exits 0 — nothing to do is not a failure", async () => {
    quietLogs();
    const s = store();
    const out: string[] = [];
    const err: string[] = [];
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      const code = await fleetRun(["observe", "--all", "--driver", "fake"], (l) => out.push(l), cliDeps(driver, s.store), (l) => err.push(l));
      expect(code).toBe(0);
      expect(out.some((l) => l.includes("sweep-complete") || l.includes("candidates_enumerated"))).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  test("an all-refused sweep (busy lock) still exits 0 — the exit code belongs to the invocation, not the candidate", async () => {
    quietLogs();
    const s = store();
    const holder = liveChild();
    const out: string[] = [];
    const err: string[] = [];
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-cli-busy");
      forgeLock(s.dir, "run-cli-busy", holder.pid, lockHostToken(s.dir));
      const code = await fleetRun(["observe", "--all", "--driver", "fake"], (l) => out.push(l), cliDeps(driver, s.store), (l) => err.push(l));
      expect(code).toBe(0);
      expect(err.some((l) => l.includes("run-locked") || l.includes("lock"))).toBe(false); // counted on the log channel, not the exit surface
    } finally {
      holder.kill();
      s.cleanup();
    }
  });

  test("usage: --all with a <run-id> is refused (exit 2); --window-ms with --all is refused (a sweep is not a wait)", async () => {
    quietLogs();
    const s = store();
    const sink: string[] = [];
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      const both = await fleetRun(
        ["observe", "--all", "--driver", "fake", "run-both"],
        (l) => sink.push(l),
        cliDeps(driver, s.store),
        (l) => sink.push(l),
      );
      expect(both).toBe(2);
      const window = await fleetRun(
        ["observe", "--all", "--driver", "fake", "--window-ms", "5000"],
        (l) => sink.push(l),
        cliDeps(driver, s.store),
        (l) => sink.push(l),
      );
      expect(window).toBe(2);
      expect(driver.calls.length).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("a non-worktree hostRoot is a start-up refusal through the CLI too (exit 5, zero boxes touched)", async () => {
    quietLogs();
    const s = store();
    const out: string[] = [];
    const err: string[] = [];
    const cwd = process.cwd();
    const notARepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-df38-cwd-"));
    try {
      const driver = new SweepDriver(path.join(s.dir, "boxes"));
      await seedCandidate(s.store, driver, "run-cli-wt");
      process.chdir(notARepo);
      const code = await fleetRun(["observe", "--all", "--driver", "fake"], (l) => out.push(l), cliDeps(driver, s.store), (l) => err.push(l));
      expect(code).toBe(5);
      expect(err.some((l) => l.includes("reverify-host-root-unusable"))).toBe(true);
      expect(driver.calls.length).toBe(0);
      expect(driver.destroyed).toEqual([]);
    } finally {
      process.chdir(cwd);
      fs.rmSync(notARepo, { recursive: true, force: true });
      s.cleanup();
    }
  });
});

// ─── the git host the driven chain's reverify leg needs (run-completion.test.ts's arrangement, trimmed) ──

interface GitHost {
  dir: string;
  baseSha: string;
  cleanup(): void;
}

function gitRun(argv: string[], cwd: string): string {
  const res = Bun.spawnSync(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (res.exitCode !== 0) throw new Error(`${argv.join(" ")} failed in ${cwd}: ${res.stderr}`);
  return res.stdout.toString();
}

const HOST_MANIFEST = {
  version: "1.0.0",
  pipelineId: "host-verify-df38",
  runBudgetMs: 1_200_000,
  phases: [
    { name: "tests", kind: "code", description: "host-pinned test run", maxDurationMs: 150_000, retries: 0, command: ["bun", "test", "t/"], testCommand: ["bun", "test", "t/"] },
    { name: "tree-clean", kind: "code", description: "host-pinned working tree gate", maxDurationMs: 150_000, retries: 0, command: ["git", "status", "--porcelain"] },
  ],
};

function mkGitHost(): GitHost {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-df38-repo-"));
  const run = (argv: string[], cwd = dir): string => gitRun(argv, cwd);
  run(["git", "init", "-q", "-b", "main"]);
  run(["git", "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# base\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".sandbox/\n");
  fs.mkdirSync(path.join(dir, ".factory", "manifests"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".factory", "manifests", "acme-widget.json"), JSON.stringify(HOST_MANIFEST));
  fs.writeFileSync(
    path.join(dir, ".factory", "pipeline.json"),
    JSON.stringify({ version: 1, repos: { "acme/widget": { manifest: ".factory/manifests/acme-widget.json" } } }),
  );
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "base"]);
  const baseSha = run(["git", "rev-parse", "HEAD"]).trim();
  return { dir, baseSha, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function seedBoxGit(driver: SweepDriver, vm: string, host: GitHost, runId: string): void {
  const box = path.join(driver.root, vm);
  const app = path.join(box, "app");
  gitRun(["git", "clone", "-q", host.dir, app], box);
  gitRun(["git", "fetch", "-q", "origin", `refs/sandbox/${runId}`], app);
  gitRun(["git", "checkout", "-q", "-B", `sbx/${runId}`, "FETCH_HEAD"], app);
}

/** Quarantine the run's two work commits at refs/sandbox/<runId>, as harvest leaves them (run-completion.test.ts's helper). */
function quarantine(h: GitHost, runId: string): string {
  const run = (argv: string[], cwd = h.dir): string => gitRun(argv, cwd);
  run(["git", "checkout", "-q", "-b", `work-${runId}`]);
  fs.mkdirSync(path.join(h.dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(h.dir, "src", "sum.ts"), "export function sum(a: number, b: number) {\n  return a + b;\n}\n");
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "feat: sum"]);
  fs.mkdirSync(path.join(h.dir, "t"), { recursive: true });
  fs.writeFileSync(
    path.join(h.dir, "t", "sum.test.ts"),
    ['import { expect, test } from "bun:test";', 'import { sum } from "../src/sum.ts";', 'test("sums", () => { expect(sum(1, 2)).toBe(3); });', ""].join("\n"),
  );
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "test: sum"]);
  const head = run(["git", "rev-parse", "HEAD"]).trim();
  run(["git", "update-ref", `refs/sandbox/${runId}`, head]);
  run(["git", "checkout", "-q", "main"]);
  run(["git", "branch", "-q", "-D", `work-${runId}`]);
  return head;
}
