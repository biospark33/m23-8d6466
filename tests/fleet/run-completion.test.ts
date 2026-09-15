/**
 * DF3.7 — `observeAndDriveChain` / `promoteStrandedPause` (contract
 * `.unlazy/df3-7/contract.md` §Test inventory, cases 1–22).
 *
 * Authored against the frozen contract in parallel with the module (D4): the
 * seams under test are the shipped classifier's verdicts, both streaks, the
 * liveness arm, the pre-flight order, the AC1 import fence, the #245 closure,
 * and the ChainOutcome arm mapping.
 *
 * Harness idioms copied from tests/fleet/approval-gate.test.ts (store()
 * factory + try/finally, byte-identical refusal asserts) and
 * tests/fleet/fanout-primitive.test.ts (StreakFakeDriver's marker-probe
 * interception: `readBoxFile` probes an ABSOLUTE in-box path
 * `/run/qds-run/<runId>/journal/final.json`, which a fake box answers by
 * interception, never by a real file).
 *
 * The chain tests run the REAL `teardownSandbox` → `reverify` → gate against
 * a throwaway git host (tests/reverify/runner.test.ts's arrangement) — the
 * module accepts no injected port, so the honest way to pin the outcome-arm
 * mapping is to drive the real chain and steer it with the record, the
 * bundle, the host repo, and a store overlay that lands a decision "between"
 * the pre-flight and the gate.
 *
 * Fake-clock note: the skip-streak's 90 s wall-clock conjunct
 * (`6 × (DEFAULT_POLL_INTERVAL_MS + DEFAULT_PER_CALL_DEADLINE_MS)`) is real
 * wall time in production; here the driver steps bun's `setSystemTime` per
 * probe so the conjunct's arithmetic is exercised without sleeping 90 s. The
 * poll-interval pacing itself is the module's own (DEFAULT_POLL_INTERVAL_MS),
 * so streak tests still spend ~5 s per tick of real sleep.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { FakeDriver, FakeDriverError } from "../../src/providers/fake-driver.ts";
import { createRun, type ExecResult } from "../../src/providers/driver.ts";
import { RunRecordStore, type ExtensionEntry } from "../../src/providers/run-record.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { setLogSink } from "../../src/swarmclaw/log.ts";
import {
  BOX_MARKER_PATH_RE,
  DEFAULT_PER_CALL_DEADLINE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MARKER_UNUSABLE_TICKS_LIMIT,
  PROBE_SKIP_TICKS_LIMIT,
} from "../../src/fleet/fanout-primitive.ts";
import {
  DEFAULT_OBSERVATION_WINDOW_MS,
  observeAndDriveChain,
  promoteStrandedPause,
  type ChainOutcome,
  type RunCompletionDeps,
} from "../../src/fleet/run-completion.ts";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_PATH = path.join(REPO_ROOT, "src", "fleet", "run-completion.ts");
const REVERIFY_APPROVAL_PATH = path.join(REPO_ROOT, "src", "reverify", "approval.ts");
const FLEET_TS_PATH = path.join(REPO_ROOT, "scripts", "fleet.ts");

/**
 * The fake clock for the wall-clock conjunct tests. bun's `setSystemTime`
 * FREEZES `Date` (there is no restore), and a frozen clock turns a windowed
 * poll into an infinite loop — the module's deadline is `Date.now() +
 * windowMs` — so the fake is a `spyOn(Date, "now")` the afterEach really
 * restores. Sleeps stay REAL: only `Date.now()` lies, which is exactly the
 * seam the 90 s conjunct arithmetic reads.
 */
const REAL_EPOCH_MS = Date.now();
let dateNowSpy: ReturnType<typeof spyOn<typeof Date, "now">> | null = null;
let fakeClockMs = 0;

function armFakeClock(startMs: number = REAL_EPOCH_MS): void {
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

/** Advance the fake clock if armed; a no-op on the real clock. */
function stepClock(ms: number): void {
  if (dateNowSpy !== null) fakeClockMs += ms;
}

afterEach(disarmFakeClock);

/** Per-tick marker-read plan; index = marker PROBE count (each tick opens with `test -f`). */
type MarkerPlan =
  | { body: Record<string, unknown> | null } // null = cleanly absent
  | { forcedProbeExit: number } // e.g. 255: the box never answered → skip
  | { catExit: number } // present, cat failed → unusable
  | { oversized: true } // present, cat over the capture cap → unusable
  | { probeEatsBudget: true }; // probe spends the whole shared budget → no cat, unreadable(-1)

function store(): { store: RunRecordStore; dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-rc-"));
  return {
    dir,
    store: new RunRecordStore({ dir }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * The inline fake driver (no shared marker FakeDriver exists —
 * fanout-primitive.test.ts's StreakFakeDriver is local to that file, so this
 * is the same idiom rebuilt). `exec`/`execTimed` BOTH route through
 * `intercept` because `readBoxFile` prefers `execTimed` while `unitActivity`
 * falls back to plain `exec` — the pair is what keeps the driver honest
 * (patterns.test.ts's "double").
 *
 * `advanceMs` steps bun's fake clock on marker probes and systemctl calls:
 * the module has no clock seam, and the skip-streak conjunct is wall-clock
 * math.
 */
class ProbeDriver extends FakeDriver {
  calls: Array<{ argv: readonly string[]; timeoutMs?: number }> = [];
  destroyed: string[] = [];
  /** Marker-read plan per tick, indexed by marker probe. */
  plan: MarkerPlan[] = [{ body: null }];
  /** `systemctl is-active` answer word; exitCode kept off 137/255. */
  activity = "active";
  advanceMs = 0;
  destroyThrows = false;
  #tick = 0;
  #tickPlan: MarkerPlan | null = null;

  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin, undefined);
  }

  override async execTimed(vm: string, argv: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin, timeoutMs);
  }

  override async destroy(vm: string): Promise<void> {
    this.destroyed.push(vm);
    if (this.destroyThrows) {
      throw new FakeDriverError(
        "destroy-failed-by-test",
        `driver could not confirm destruction of ${vm} (forced by the test seam)`,
        "this refusal is the test seam; production remediation names a hand destroy",
      );
    }
    return super.destroy(vm);
  }

  /** Marker probes completed (one `test -f` per tick, whatever the cat did). */
  get markerTicks(): number {
    return this.#tick;
  }

  private async intercept(
    vm: string,
    argv: string[],
    stdin: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<ExecResult> {
    this.calls.push({ argv, timeoutMs });
    const cmd = argv.length >= 3 && argv[0] === "sh" && argv[1] === "-c" && typeof argv[2] === "string" ? argv[2] : "";
    if (argv[0] === "systemctl" && argv[1] === "is-active") {
      // unitActivity reads the WORD, not the exit code; any exit but 137/255
      // is transport-fine.
      stepClock(this.advanceMs);
      return { stdout: `${this.activity}\n`, stderr: "", exitCode: 0 };
    }
    if (cmd.includes("test -f") && BOX_MARKER_PATH_RE.test(cmd)) {
      this.#tickPlan = this.plan[Math.min(this.#tick++, this.plan.length - 1)]!;
      const p = this.#tickPlan;
      if ("forcedProbeExit" in p) {
        stepClock(this.advanceMs);
        return { stdout: "", stderr: `ssh: connect to host ${vm} port 22: Connection refused`, exitCode: p.forcedProbeExit };
      }
      if ("probeEatsBudget" in p) {
        // The probe "succeeds" but burns the whole shared budget: step the
        // clock past the per-call deadline so readBoxFile's absolute-deadline
        // check reports unreadable{exitCode:-1} and never issues a cat.
        stepClock(DEFAULT_PER_CALL_DEADLINE_MS + 5_000);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return "body" in p && p.body === null
        ? { stdout: "", stderr: "", exitCode: 1 } // test -f's clean miss
        : { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("cat ") && BOX_MARKER_PATH_RE.test(cmd)) {
      const p = this.#tickPlan ?? this.plan[0]!;
      if ("catExit" in p) {
        return {
          stdout: "",
          stderr: `cat: forced failure by the test seam (exit ${String(p.catExit)})`,
          exitCode: p.catExit,
        };
      }
      if ("oversized" in p) {
        return { stdout: "x".repeat(600_000), stderr: "", exitCode: 0, truncated: true };
      }
      return { stdout: `${JSON.stringify("body" in p ? p.body : null)}\n`, stderr: "", exitCode: 0 };
    }
    return timeoutMs === undefined ? super.exec(vm, argv, stdin) : super.execTimed(vm, argv, timeoutMs, stdin);
  }
}

/** A fresh record with a box name — the minimum the observer will poll for. */
function seedRun(s: RunRecordStore, runId: string, patch: Record<string, unknown> = {}): void {
  s.create(runId);
  s.set(runId, { vmName: `vm-${runId}`, requestId: "req-df37", ...patch } as never);
}

const lockHandle = (runsDir: string, runId: string): string => path.join(runsDir, `${runId}.lock`);

function quietLedger(): { hook: { ingestBoxHours(ctx: Record<string, unknown>): void }; ingested: Array<Record<string, unknown>> } {
  const ingested: Array<Record<string, unknown>> = [];
  return { hook: { ingestBoxHours: (ctx) => ingested.push(ctx) }, ingested };
}

function baseDeps(
  runId: string,
  over: Partial<RunCompletionDeps> & { driver: ProbeDriver; store: RunRecordStore; runsDir: string },
): RunCompletionDeps {
  return {
    driver: over.driver,
    store: over.store,
    runsDir: over.runsDir,
    // hostRoot: the CALLER asserts the worktree — a plain tmpdir is fine for
    // every leg that never enters reverify, and the module must not care.
    hostRoot: over.hostRoot ?? fs.realpathSync(os.tmpdir()),
    runLock: over.runLock ?? (lockHandle(over.runsDir, runId) as RunCompletionDeps["runLock"]),
    keyApi: (over.keyApi ?? new FakeKeyApi()) as RunCompletionDeps["keyApi"],
    requestId: over.requestId ?? "req-df37",
    costLedger: (over.costLedger ?? quietLedger().hook) as RunCompletionDeps["costLedger"],
    maxTicks: over.maxTicks,
    windowMs: over.windowMs,
  };
}

const terminalOf = (out: ChainOutcome): { code: string; message: string; remediation: string } | undefined =>
  out.kind === "unsettled" ? out.terminal : undefined;

const markerCmds = (driver: ProbeDriver, needle: string): string[] =>
  driver.calls
    .filter((c) => c.argv.length >= 3 && typeof c.argv[2] === "string" && BOX_MARKER_PATH_RE.test(c.argv[2]) && c.argv[2]!.includes(needle))
    .map((c) => c.argv[2]!);

// ─── the throwaway git host the chain's reverify leg needs ───────────────────

const HOST_MANIFEST = {
  version: "1.0.0",
  pipelineId: "host-verify-df37",
  runBudgetMs: 1_200_000,
  phases: [
    {
      name: "tests",
      kind: "code",
      description: "host-pinned test run",
      maxDurationMs: 150_000,
      retries: 0,
      command: ["bun", "test", "t/"],
      testCommand: ["bun", "test", "t/"],
    },
    {
      name: "tree-clean",
      kind: "code",
      description: "host-pinned working tree gate",
      maxDurationMs: 150_000,
      retries: 0,
      command: ["git", "status", "--porcelain"],
    },
  ],
};

interface GitHost {
  dir: string;
  baseSha: string;
  cleanup(): void;
}

function gitRun(argv: string[], cwd: string): string {
  const res = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (res.status !== 0) throw new Error(`${argv.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  return res.stdout;
}

/**
 * A git host shaped like tests/reverify/fixtures/harvested-repo.ts but with
 * `.factory/` and `.gitignore` IN the base commit — teardown's verify leg and
 * reverify's plan resolution both read the host, and an untracked pipeline
 * index would dirty it.
 */
function gitHost(): GitHost {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-rc-repo-"));
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

/** Quarantine the run's two work commits at refs/sandbox/<runId>, as harvest leaves them. */
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
    [
      'import { expect, test } from "bun:test";',
      'import { sum } from "../src/sum.ts";',
      'test("sums", () => { expect(sum(1, 2)).toBe(3); });',
      "",
    ].join("\n"),
  );
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "test: sum"]);
  const head = run(["git", "rev-parse", "HEAD"]).trim();
  run(["git", "update-ref", `refs/sandbox/${runId}`, head]);
  run(["git", "checkout", "-q", "main"]);
  run(["git", "branch", "-q", "-D", `work-${runId}`]);
  return head;
}

/**
 * Make the fake box a real git repo whose `sbx/<runId>` branch holds the run's
 * work. The repo lives at `<box>/app` — harvest's workdir probe is
 * `[ -d "$d/.git" ]` over DEFAULT_WORKDIRS with "app" first, so a repo at the
 * box root would read NOREPO.
 */
function seedBoxGit(driver: ProbeDriver, vm: string, host: GitHost, runId: string): void {
  const box = path.join(driver.root, vm);
  const app = path.join(box, "app");
  gitRun(["git", "clone", "-q", host.dir, app], box);
  gitRun(["git", "fetch", "-q", "origin", `refs/sandbox/${runId}`], app);
  gitRun(["git", "checkout", "-q", "-B", `sbx/${runId}`, "FETCH_HEAD"], app);
}

/**
 * The record the driven chain needs: box + pinned base + budget attribution
 * (reverify's plan lookup key and the close step's ingest source), plus a
 * settled marker planted for the poll's first tick.
 */
async function seedGreenRun(
  s: RunRecordStore,
  driver: ProbeDriver,
  host: GitHost,
  runId: string,
  marker: { ok: boolean },
): Promise<string> {
  const rec = await createRun(driver, s, { runId });
  seedBoxGit(driver, rec.vmName!, host, runId);
  s.set(runId, {
    commitSha: host.baseSha,
    requestId: "req-df37",
    extensions: { budget: { repoSlug: "acme/widget", issueId: "7" } },
  } as never);
  driver.plan = [{ body: { runId, ok: marker.ok, completedAt: "2026-09-15T00:00:00.000Z" } }];
  return rec.vmName!;
}

/**
 * A store that lands a "concurrent" approval decision after the chain closes
 * the record — the shape the module's PREFLIGHT passed but the gate must now
 * see. The first `skip` post-close `get`s stay clean (the close step's own
 * read, then reverify's bound-read); after that every read carries the
 * overlay: the honest in-process stand-in for another actor deciding between
 * the pre-flight and the gate.
 */
class OverlayStore extends RunRecordStore {
  closedRun: string | null = null;
  overlay: ExtensionEntry | null = null;
  /**
   * How many post-close `get`s stay CLEAN before the overlay lands. The
   * pause-in-progress test pins this to the post-close read order the module
   * and runner's source fix: (1) teardown's close-step read, (2) reverify's
   * preflight read, (3) reverify's bound-report read — the overlay must land
   * after (3), because a pausing bound read re-presents the STORED id and the
   * gate would then resume it (→ requested) instead of answering
   * `pause-in-progress`. Get (4) is the gate's startup read, where the
   * mismatch is decided.
   */
  skip = 0;
  #served = 0;
  #closed = false;
  onClose: () => void = () => undefined;

  override close(runId: string, now?: Date): ReturnType<RunRecordStore["close"]> {
    const r = now === undefined ? super.close(runId) : super.close(runId, now);
    if (runId === this.closedRun) {
      this.#closed = true;
      this.onClose();
    }
    return r;
  }

  override get(runId: string): ReturnType<RunRecordStore["get"]> {
    const r = super.get(runId);
    if (this.#closed && runId === this.closedRun && this.overlay !== null && this.#served++ >= this.skip) {
      return { ...r, extensions: { ...r.extensions, approval: this.overlay } } as ReturnType<RunRecordStore["get"]>;
    }
    return r;
  }
}

const SHA_A = "a".repeat(40);
/** A record's approval extension as the gate-shaped entry the store types it as. */
const approvalExt = (state: string, reportId = "rv-other-actor", headSha = SHA_A): ExtensionEntry => ({
  schemaVersion: 2, // the approval namespace's version validateExtensions pins (run-record.ts)
  state,
  proposal: "open a PR",
  reportId,
  headSha,
  requestedAt: "2026-09-15T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  supersededReportIds: [],
});

// ─── module source (fence, path derivation, lock, git) ──────────────────────

async function moduleSource(): Promise<string> {
  return Bun.file(MODULE_PATH).text();
}

const FORBIDDEN_DIRECT = ["./approval-gate.ts", "./approvers.ts", "../pr/push.ts", "./index.ts"];

/** Every direct `import … from "…"` / `export … from "…"` specifier, verbatim. */
function importSpecifiers(src: string): string[] {
  const specifiers: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)) specifiers.push(m[1]!);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) specifiers.push(m[1]!);
  return specifiers;
}

function fenceViolations(src: string): string[] {
  return importSpecifiers(src).filter((s) => FORBIDDEN_DIRECT.includes(s));
}

describe("AC1 import fence + module shape (source contract)", () => {
  test("the fence: no direct forbidden specifier, fanout-primitive required, run-record type-only, transitive reach permitted (negative control)", async () => {
    const src = await moduleSource();
    // FORBIDDEN — the bridge cannot acquire the ability to write the namespace.
    expect(fenceViolations(src)).toEqual([]);
    // PERMITTED and REQUIRED — the shipped classifier consumed as code.
    expect(importSpecifiers(src)).toContain("./fanout-primitive.ts");
    // run-record: type-only, RunRecord/RunRecordStore only — never a symbol
    // that writes the approval extension (AC5's pre-flight read needs the
    // types; a whole-module ban would forbid them).
    const rrLine = src.match(/(?:^|\n)(\s*import[^;\n]*from\s*["']\.\.\/providers\/run-record\.ts["'];?)/)?.[1] ?? "";
    expect(rrLine).not.toBe("");
    expect(/^\s*import\s+type\s/.test(rrLine) || rrLine.includes("{ type RunRecord")).toBe(true);
    const braceStart = rrLine.indexOf("{");
    const braceEnd = rrLine.lastIndexOf("}");
    const importedNames = rrLine
      .slice(braceStart + 1, braceEnd)
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n !== "");
    expect(importedNames.every((n) => n === "type" || n === "RunRecord" || n === "RunRecordStore")).toBe(true);
    expect(importedNames).toContain("RunRecordStore");
    // NEGATIVE CONTROL: the fence is on DIRECT specifiers only. A module that
    // reaches the gate transitively — through ./fanout-primitive.ts and
    // ../reverify/runner.ts, exactly as run-completion does — must NOT fail.
    const synthetic = [
      'import { readMarkerVerdict } from "./fanout-primitive.ts";',
      'import { reverify } from "../reverify/runner.ts";',
      'import type { RunLockHandle } from "../../scripts/lib/run-lock.ts";',
    ].join("\n");
    expect(fenceViolations(synthetic)).toEqual([]);
    // And the transitive reach is REAL: reverify's own port imports the gate.
    const approvalSrc = await Bun.file(REVERIFY_APPROVAL_PATH).text();
    expect(importSpecifiers(approvalSrc)).toContain("../fleet/approval-gate.ts");
  });

  test("AC4 path derivation: boxMarkerPath imported; no runMarkerPath, no inlined /run/qds-run literal", async () => {
    const src = await moduleSource();
    expect(src).toContain("boxMarkerPath");
    expect(src).not.toContain("runMarkerPath");
    expect(src).not.toContain("/run/qds-run");
  });

  test("AC5/#245: the module acquires NO lock and runs NO git (caller-owned)", async () => {
    const src = await moduleSource();
    expect(src).not.toContain("withRunLock(");
    expect(src).not.toContain("acquireRunLock");
    expect(src).not.toContain("is-inside-work-tree");
    expect(src).not.toContain("Bun.spawn");
    expect(src).not.toContain("spawnSync");
  });

  test("AC5/DoD: scripts/fleet.ts observe block takes withRunLock BEFORE the pre-flight read, worktree asserted by the caller before the chain", async () => {
    const fleetSrc = await Bun.file(FLEET_TS_PATH).text();
    const at = fleetSrc.indexOf("await observeAndDriveChain("); // the CALL site, not the import
    expect(at).toBeGreaterThanOrEqual(0); // leaf-1.2's verb block must wire the module
    const block = fleetSrc.slice(Math.max(0, at - 8000), at + 500);
    const lockAt = block.lastIndexOf("withRunLock");
    const readAt = Math.max(block.lastIndexOf("store.get"), block.lastIndexOf("assertRunExists"));
    const worktreeAt = block.lastIndexOf("is-inside-work-tree");
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(readAt); // lock FIRST (AC5)
    expect(worktreeAt).toBeGreaterThanOrEqual(0); // hostRoot asserted by the CALLER, in the block
  });

  test("DEFAULT_OBSERVATION_WINDOW_MS is a positive number (the one new number, named)", () => {
    expect(typeof DEFAULT_OBSERVATION_WINDOW_MS).toBe("number");
    expect(DEFAULT_OBSERVATION_WINDOW_MS).toBeGreaterThan(0);
  });
});

// ─── pre-flight order (AC5) ──────────────────────────────────────────────────

describe("pre-flight refusals (order: extension → pausing → closedAt → no-box)", () => {
  for (const state of ["awaiting-approval", "approved", "rejected", "timed-out"]) {
    test(`state ${state} refuses approval-already-registered naming the state, record byte-identical`, async () => {
      const s = store();
      try {
        seedRun(s.store, "run-pf");
        s.store.set("run-pf", { extensions: { approval: approvalExt(state) } } as never);
        const before = fs.readFileSync(s.store.path("run-pf"));
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        const out = await observeAndDriveChain("run-pf", baseDeps("run-pf", { driver, store: s.store, runsDir: s.dir }));
        expect(out).toMatchObject({ kind: "refused", code: "approval-already-registered" });
        expect((out as { message: string }).message).toContain(state);
        expect(fs.readFileSync(s.store.path("run-pf"))).toEqual(before);
        expect(driver.calls.length).toBe(0); // refused before any box touch
        expect(driver.destroyed).toEqual([]);
      } finally {
        s.cleanup();
      }
    });
  }

  test("closedAt + awaiting-approval → the EXTENSION refusal wins (order pin, W16-3)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-ord");
      s.store.close("run-ord");
      s.store.set("run-ord", { extensions: { approval: approvalExt("awaiting-approval") } } as never);
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const out = await observeAndDriveChain("run-ord", baseDeps("run-ord", { driver, store: s.store, runsDir: s.dir }));
      expect(out).toMatchObject({ kind: "refused", code: "approval-already-registered" });
    } finally {
      s.cleanup();
    }
  });

  test("closedAt alone → run-already-closed naming the closure stamp, before any box touch", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-cl");
      s.store.close("run-cl");
      const stamp = s.store.get("run-cl").closedAt;
      const before = fs.readFileSync(s.store.path("run-cl"));
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const out = await observeAndDriveChain("run-cl", baseDeps("run-cl", { driver, store: s.store, runsDir: s.dir }));
      expect(out).toMatchObject({ kind: "refused", code: "run-already-closed" });
      expect((out as { message: string }).message).toContain(stamp!);
      expect(fs.readFileSync(s.store.path("run-cl"))).toEqual(before);
      expect(driver.calls.length).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("no vmName → record-names-no-box, refused before mutation (D1)", async () => {
    const s = store();
    try {
      s.store.create("run-nobox");
      s.store.set("run-nobox", { requestId: "req-df37" } as never);
      const before = fs.readFileSync(s.store.path("run-nobox"));
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const out = await observeAndDriveChain("run-nobox", baseDeps("run-nobox", { driver, store: s.store, runsDir: s.dir }));
      expect(out).toMatchObject({ kind: "refused", code: "record-names-no-box" });
      expect(fs.readFileSync(s.store.path("run-nobox"))).toEqual(before);
      expect(driver.calls.length).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("closedAt + pausing → the PAUSING route wins over the closedAt refusal (never refuses, never polls)", async () => {
    const s = store();
    const host = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-rc-host-"));
    try {
      seedRun(s.store, "run-pw");
      s.store.close("run-pw");
      s.store.set("run-pw", { extensions: { approval: approvalExt("pausing", "rv-bound") } } as never);
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const out = await observeAndDriveChain(
        "run-pw",
        baseDeps("run-pw", { driver, store: s.store, runsDir: s.dir, hostRoot: host }),
      );
      // promoteStrandedPause ran (reverify's own error verdict below), and the
      // marker poll NEVER did: zero driver calls, no teardown, no refusal.
      expect(driver.calls.length).toBe(0);
      expect(out.kind).not.toBe("refused");
      expect(out.kind).toBe("vetoed"); // no commitSha → reverify's error verdict
      expect(s.store.get("run-pw").closedAt).toBeTruthy(); // untouched by the promotion attempt
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
      s.cleanup();
    }
  });

  test("promoteStrandedPause refuses record-not-pausing on any other state (cheap pre-flight)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-np");
      s.store.set("run-np", { extensions: { approval: approvalExt("awaiting-approval") } } as never);
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const out = await promoteStrandedPause("run-np", baseDeps("run-np", { driver, store: s.store, runsDir: s.dir }));
      expect(out).toMatchObject({ kind: "refused", code: "record-not-pausing" });
      expect(driver.calls.length).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("a pausing record takes promoteStrandedPause with ZERO driver.exec — the poll never starts (AC5)", async () => {
    const s = store();
    const host = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-rc-host-"));
    try {
      seedRun(s.store, "run-ps");
      s.store.set("run-ps", { extensions: { approval: approvalExt("pausing", "rv-bound") } } as never);
      const before = fs.readFileSync(s.store.path("run-ps"));
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const out = await observeAndDriveChain(
        "run-ps",
        baseDeps("run-ps", { driver, store: s.store, runsDir: s.dir, hostRoot: host }),
      );
      expect(driver.calls.length).toBe(0); // ZERO exec/execTimed — no probe, no teardown, no destroy
      expect(driver.destroyed).toEqual([]);
      expect(out.kind).toBe("vetoed"); // reverify's independent verdict (no base sha here)
      expect((out as { reason: string }).reason).toBe("no-base-sha");
      expect(fs.readFileSync(s.store.path("run-ps"))).toEqual(before); // the gate refused (no bundle); record untouched
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
      s.cleanup();
    }
  });
});

// ─── the poll: verdicts, streaks, liveness, window (AC2/AC3) ────────────────

describe("the observation window and the marker verdicts (AC2/AC3)", () => {
  test("window expiry → typed run-completion-unobserved, box alive, record byte-identical, idempotent re-run (AC3)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-w");
      const before = fs.readFileSync(s.store.path("run-w"));
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: null }]; // absent, cleanly
      driver.activity = "active";
      // A 1 ms window: the first tick itself outlives it, so the invocation
      // ends on the window arm after exactly one marker read.
      const deps = baseDeps("run-w", { driver, store: s.store, runsDir: s.dir, windowMs: 1 });
      const out = await observeAndDriveChain("run-w", deps);
      expect(out.kind).toBe("unsettled");
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      expect(driver.destroyed).toEqual([]); // box alive and listable (INV-5)
      expect(fs.readFileSync(s.store.path("run-w"))).toEqual(before); // no record field mutated
      // Idempotent: the marker is the state — re-observing sees the same thing.
      const driver2 = new ProbeDriver(path.join(s.dir, "boxes"));
      driver2.plan = [{ body: null }];
      driver2.activity = "active";
      const again = await observeAndDriveChain("run-w", { ...deps, driver: driver2 });
      expect(again.kind).toBe("unsettled");
      expect(terminalOf(again)?.code).toBe("run-completion-unobserved");
      expect(markerCmds(driver2, "test -f").length).toBeGreaterThan(0);
    } finally {
      s.cleanup();
    }
  }, 30_000);

  test("maxTicks (the DF3.8 sweep shape) → unsettled WITHOUT terminal — the caller decides", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-mt");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: null }];
      driver.activity = "active";
      const out = await observeAndDriveChain(
        "run-mt",
        baseDeps("run-mt", { driver, store: s.store, runsDir: s.dir, maxTicks: 1, windowMs: 10 * DEFAULT_POLL_INTERVAL_MS }),
      );
      expect(out.kind).toBe("unsettled");
      expect((out as { terminal?: unknown }).terminal).toBeUndefined();
      expect(driver.markerTicks).toBe(1); // exactly one tick
    } finally {
      s.cleanup();
    }
  });

  test("expectedRunId is wired: the probe addresses THIS run's per-run marker path (AC2b)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-x1");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: null }];
      driver.activity = "active";
      await observeAndDriveChain("run-x1", baseDeps("run-x1", { driver, store: s.store, runsDir: s.dir, windowMs: 1 }));
      const probes = markerCmds(driver, "test -f");
      expect(probes.length).toBeGreaterThan(0);
      for (const cmd of probes) expect(cmd).toContain("/run/qds-run/run-x1/journal/final.json");
    } finally {
      s.cleanup();
    }
  }, 30_000);

  test("a marker naming ANOTHER run is unusable, never settled — the chain never runs (AC2b)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-x2");
      const before = fs.readFileSync(s.store.path("run-x2"));
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: { runId: "someone-else", ok: true } }]; // foreign runId, present marker
      const out = await observeAndDriveChain(
        "run-x2",
        baseDeps("run-x2", { driver, store: s.store, runsDir: s.dir, windowMs: 6 * DEFAULT_POLL_INTERVAL_MS }),
      );
      expect(out.kind).toBe("unsettled");
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved"); // the unusable streak abandoned it
      expect(driver.markerTicks).toBe(MARKER_UNUSABLE_TICKS_LIMIT); // gave up at 3, not windowed
      expect(driver.destroyed).toEqual([]); // chain never ran
      expect(fs.readFileSync(s.store.path("run-x2"))).toEqual(before);
    } finally {
      s.cleanup();
    }
  }, 60_000);

  test("unreadable at cat → unusable; ×3 consecutive → run-completion-unobserved; never a free tick (AC2a)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-u1");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ catExit: 2 }, { catExit: 2 }, { catExit: 2 }];
      const out = await observeAndDriveChain(
        "run-u1",
        baseDeps("run-u1", { driver, store: s.store, runsDir: s.dir, windowMs: 10 * DEFAULT_POLL_INTERVAL_MS }),
      );
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      // NEVER a free tick: every unusable tick answered BOTH legs — the box
      // answered twice per tick (test -f clean + cat failed).
      expect(markerCmds(driver, "cat ").length).toBe(MARKER_UNUSABLE_TICKS_LIMIT);
      expect(driver.markerTicks).toBe(MARKER_UNUSABLE_TICKS_LIMIT);
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 60_000);

  test("absent RESETS the unusable streak: the give-up needs 3 CONSECUTIVE unusables after it", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-u2");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [
        { catExit: 2 },
        { body: null }, // clean absence — resets the streak
        { catExit: 2 },
        { catExit: 2 },
        { catExit: 2 },
      ];
      const out = await observeAndDriveChain(
        "run-u2",
        baseDeps("run-u2", { driver, store: s.store, runsDir: s.dir, windowMs: 8 * DEFAULT_POLL_INTERVAL_MS }),
      );
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      // Five marker ticks, four cat legs (the absent tick ran no cat): the
      // streak restarted at the absent tick — an implementation that never
      // resets gives up at tick 3 and never issues ticks 4-5.
      expect(driver.markerTicks).toBe(5);
      expect(markerCmds(driver, "cat ").length).toBe(4);
    } finally {
      s.cleanup();
    }
  }, 60_000);

  test("oversized → unusable; probe-budget-exhausted (no cat issued) → unusable (AC2a)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-u3");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      // tick1: present and oversized (cat over the capture cap). tick2: the
      // presence probe eats the whole shared budget — the sentinel says NO cat
      // was issued, and the disposition is still unusable, never a skip.
      // tick3: oversized again → the 3rd consecutive unusable gives up.
      driver.plan = [{ oversized: true }, { probeEatsBudget: true }, { oversized: true }];
      armFakeClock(); // the probeEatsBudget leg steps the fake clock past the per-call deadline
      const out = await observeAndDriveChain(
        "run-u3",
        baseDeps("run-u3", { driver, store: s.store, runsDir: s.dir, windowMs: 10 * DEFAULT_POLL_INTERVAL_MS }),
      );
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      expect(markerCmds(driver, "cat ").length).toBe(2); // ticks 1 and 3; the budget tick never catted
      expect(driver.markerTicks).toBe(3);
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 60_000);
});

describe("the liveness arm (AC2d)", () => {
  test("absent + unitActivity active → keeps polling to the window; the unit was probed, never terminal", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-l1");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: null }, { body: null }];
      driver.activity = "active";
      // The first tick ends well inside a 5 s window, the second lands after
      // the module's own 5 s poll interval — two ticks, one interval slept,
      // and the window arm closes it.
      const out = await observeAndDriveChain(
        "run-l1",
        baseDeps("run-l1", { driver, store: s.store, runsDir: s.dir, windowMs: 5_000 }),
      );
      expect(out.kind).toBe("unsettled");
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      const unit = driver.calls.filter((c) => c.argv[0] === "systemctl");
      expect(unit.length).toBe(2); // probed on EVERY absent tick
      expect(unit[0]!.argv.join(" ")).toContain("qds-run@run-l1.service");
      expect(driver.markerTicks).toBe(2); // it KEPT polling past the first absence
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 30_000);

  test("absent + unitActivity failed → terminal run-engine-dead naming systemctl, box ALIVE, record byte-identical", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-l2");
      const before = fs.readFileSync(s.store.path("run-l2"));
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: null }];
      driver.activity = "failed";
      const out = await observeAndDriveChain(
        "run-l2",
        baseDeps("run-l2", { driver, store: s.store, runsDir: s.dir, windowMs: 10 * DEFAULT_POLL_INTERVAL_MS }),
      );
      expect(out.kind).toBe("unsettled");
      const terminal = terminalOf(out);
      expect(terminal?.code).toBe("run-engine-dead");
      expect(`${terminal?.message ?? ""} ${terminal?.remediation ?? ""}`).toContain("qds-run@run-l2.service");
      expect(driver.destroyed).toEqual([]); // nothing destroyed on a liveness reading
      expect(fs.readFileSync(s.store.path("run-l2"))).toEqual(before);
    } finally {
      s.cleanup();
    }
  }, 30_000);

  for (const word of ["inactive", "unknown"]) {
    test(`absent + unitActivity ${word} → NOT terminal: bounded by the window, never a death certificate (AC2d)`, async () => {
      const s = store();
      try {
        seedRun(s.store, `run-l3-${word}`);
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        driver.plan = [{ body: null }];
        driver.activity = word;
        const out = await observeAndDriveChain(
          `run-l3-${word}`,
          baseDeps(`run-l3-${word}`, { driver, store: s.store, runsDir: s.dir, windowMs: 1 }),
        );
        expect(out.kind).toBe("unsettled");
        expect(terminalOf(out)?.code).not.toBe("run-engine-dead");
        expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
        expect(driver.destroyed).toEqual([]);
      } finally {
        s.cleanup();
      }
    }, 30_000);
  }
});

describe("the skip streak and its 90 s wall-clock conjunct (AC2a)", () => {
  test("six 255-probes with lastReach answered EARLY → NOT box-unreachable: the wall-clock conjunct blocks the premature arm", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-s1");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      // Fake wall advances 12 s per answered unit call and per 255 probe. Tick
      // 1: clean absence + answered unit (inactive) — it counts a skip (AC2d)
      // AND sets lastReachMs at fake t0+12 s. Ticks 2-6: five 255 skips take
      // the streak to six with only 60 s of fake wall since the box last
      // ANSWERED — the 90 s conjunct is FALSE through the whole streak, and
      // the 70 s window expires at tick 6 with the OTHER code. The streak
      // really counted: this is not a loop that never reached six.
      driver.advanceMs = 12_000;
      driver.activity = "inactive";
      driver.plan = [{ body: null }, ...Array.from({ length: 6 }, () => ({ forcedProbeExit: 255 } as MarkerPlan))];
      armFakeClock();
      const out = await observeAndDriveChain("run-s1", baseDeps("run-s1", { driver, store: s.store, runsDir: s.dir, windowMs: 70_000 }));
      expect(out.kind).toBe("unsettled");
      expect(terminalOf(out)?.code).not.toBe("box-unreachable");
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      expect(driver.markerTicks).toBeGreaterThanOrEqual(PROBE_SKIP_TICKS_LIMIT); // the streak reached six
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 120_000);

  test("six skips with the box NEVER reached → box-unreachable fires (6 ticks + 90 s wall), box untouched, record byte-identical", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-s2");
      const before = fs.readFileSync(s.store.path("run-s2"));
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      // All-skip from the first tick: lastReachMs stays at the start, and 20 s
      // of fake wall per probe puts the 6th skip past the 90 s conjunct
      // (6 × (DEFAULT_POLL_INTERVAL_MS + DEFAULT_PER_CALL_DEADLINE_MS)).
      driver.advanceMs = 20_000;
      driver.plan = Array.from({ length: 8 }, () => ({ forcedProbeExit: 255 } as MarkerPlan));
      armFakeClock();
      const out = await observeAndDriveChain("run-s2", baseDeps("run-s2", { driver, store: s.store, runsDir: s.dir, windowMs: 130_000 }));
      expect(out.kind).toBe("unsettled");
      const terminal = terminalOf(out);
      expect(terminal?.code).toBe("box-unreachable"); // DISTINCT from run-completion-unobserved (AC2a)
      expect(driver.destroyed).toEqual([]); // exit-1 transient: box alive and listable
      expect(fs.readFileSync(s.store.path("run-s2"))).toEqual(before); // no record field mutated
      expect(driver.markerTicks).toBeLessThanOrEqual(PROBE_SKIP_TICKS_LIMIT + 1); // stopped AT the fill, not at the window
    } finally {
      s.cleanup();
    }
  }, 120_000);
});

// ─── the chain and the ChainOutcome arms (AC2c, AC5, #245) ──────────────────

describe("the chain: driven, ok:false, vetoed (real teardownSandbox → reverify → gate)", () => {
  test("settled ok:true drives the WHOLE chain to a registered pause — driven{markerOk:true} (AC1)", async () => {
    setLogSink(() => undefined);
    const s = store();
    const host = gitHost();
    try {
      quarantine(host, "run-d1");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const vm = await seedGreenRun(s.store, driver, host, "run-d1", { ok: true });
      const ledger = quietLedger();
      const out = await observeAndDriveChain(
        "run-d1",
        baseDeps("run-d1", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir, costLedger: ledger.hook as never }),
      );
      expect(out).toMatchObject({ kind: "driven", markerOk: true });
      expect(typeof (out as { chainMs: number }).chainMs).toBe("number");
      const rec = s.store.get("run-d1");
      expect(rec.closedAt).toBeTruthy(); // teardown's close step ran
      expect(rec.extensions?.approval?.state).toBe("awaiting-approval"); // written only by the gate
      expect(fs.existsSync(path.join(s.dir, "run-d1.bundle"))).toBe(true); // harvest's bundle
      expect(driver.destroyed).toEqual([vm]); // the box is gone
      expect(ledger.ingested.length).toBeGreaterThan(0); // box-hours priced through the caller's ledger
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 120_000);

  test("settled ok:false STILL drives the chain; the marker's ok never reaches reverify — its own verdict decides (AC2c)", async () => {
    setLogSink(() => undefined);
    const s = store();
    const host = gitHost();
    try {
      quarantine(host, "run-d2");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await seedGreenRun(s.store, driver, host, "run-d2", { ok: false });
      const out = await observeAndDriveChain(
        "run-d2",
        baseDeps("run-d2", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      // The tree re-verified green independently → the pause registered even
      // though the marker said ok:false. Had the marker's ok been fed forward,
      // this would be vetoed.
      expect(out).toMatchObject({ kind: "driven", markerOk: false });
      expect(s.store.get("run-d2").extensions?.approval?.state).toBe("awaiting-approval");
      expect(driver.destroyed.length).toBe(1); // harvested AND torn down
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 120_000);

  test("reverify's error verdict → vetoed naming its reason (the chain landed; the host said no)", async () => {
    setLogSink(() => undefined);
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-v1" });
      // vmName set, NO commitSha: harvest short-circuits "none", teardown
      // completes, reverify throws no-base-sha inside its own try → error
      // report → approval null.
      driver.plan = [{ body: { runId: "run-v1", ok: true } }];
      const out = await observeAndDriveChain(
        "run-v1",
        baseDeps("run-v1", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "vetoed", reason: "no-base-sha" });
      expect(s.store.get("run-v1").closedAt).toBeTruthy(); // the chain landed first
      expect(driver.destroyed.length).toBe(1);
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);

  test("nothing-to-verify → vetoed (zero commits beyond base is a judgment arm, exit 6)", async () => {
    setLogSink(() => undefined);
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const rec = await createRun(driver, s.store, { runId: "run-v2" });
      // The box has no git at all → harvest Step A answers NOREPO → outcome
      // none; the record pins a base the host knows, but no sandbox ref
      // exists → reverify's nothing-to-verify preflight (runner.ts:280-291).
      s.store.set("run-v2", {
        commitSha: host.baseSha,
        requestId: "req-df37",
        extensions: { budget: { repoSlug: "acme/widget", issueId: "7" } },
      } as never);
      driver.plan = [{ body: { runId: "run-v2", ok: true } }];
      const out = await observeAndDriveChain(
        "run-v2",
        baseDeps("run-v2", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "vetoed", reason: "nothing-to-verify" });
      expect(s.store.get("run-v2").closedAt).toBeTruthy();
      expect(driver.destroyed).toEqual([rec.vmName!]); // createRun always names the box
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);
});

describe("chain-failed: a step other than the approval leg threw (W16-2)", () => {
  test("destroy fails PRE-close → chain-failed{step:teardown}, the record stays open", async () => {
    setLogSink(() => undefined);
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-c1" });
      driver.plan = [{ body: { runId: "run-c1", ok: true } }];
      driver.destroyThrows = true;
      const out = await observeAndDriveChain(
        "run-c1",
        baseDeps("run-c1", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "chain-failed", step: "teardown" });
      expect((out as { error: string }).error).toContain("destruction");
      expect(s.store.get("run-c1").closedAt).toBeUndefined(); // abort ⇒ record open
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);

  test("a reverify-leg throw POST-close → chain-failed{step:reverify}, the record stays closed", async () => {
    setLogSink(() => undefined);
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-c2" });
      s.store.set("run-c2", {
        commitSha: host.baseSha,
        requestId: "req-df37",
        extensions: { budget: { repoSlug: "acme/widget", issueId: "7" } },
      } as never);
      driver.plan = [{ body: { runId: "run-c2", ok: true } }];
      // reverify's report leg sits outside its try blocks: with the sandbox
      // ref absent it seals a nothing-to-verify report and APPENDS it — and
      // the append target is a regular FILE here, so reverify itself throws
      // after the chain already closed the record.
      fs.mkdirSync(path.join(host.dir, ".sandbox"), { recursive: true });
      fs.writeFileSync(path.join(host.dir, ".sandbox", "reverify"), "not a directory");
      const out = await observeAndDriveChain(
        "run-c2",
        baseDeps("run-c2", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "chain-failed", step: "reverify" });
      expect(s.store.get("run-c2").closedAt).toBeTruthy(); // post-close: teardown succeeded first
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);
});

describe("approval-failed and handed-off (AC5)", () => {
  test("green report + a gate leg that throws → approval-failed carrying approval-request-failed — never driven, never refused", async () => {
    setLogSink(() => undefined);
    const s = store();
    const host = gitHost();
    try {
      quarantine(host, "run-a1");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await seedGreenRun(s.store, driver, host, "run-a1", { ok: true });
      // Smallest honest arrangement for the throwing port: the module builds
      // the port itself with `bundleDir: runsDir`, and the port's own
      // hollow-bundle guard refuses (reverify's catch flattening that into
      // the approval-request-failed flag) when the harvested bundle is
      // emptied AFTER the chain closed the record. The overlay store flips
      // it at exactly that point — the in-process stand-in for a bundle lost
      // between harvest and the gate.
      const overlay = new OverlayStore({ dir: s.dir });
      overlay.closedRun = "run-a1";
      overlay.onClose = () => {
        try {
          fs.truncateSync(path.join(s.dir, "run-a1.bundle"));
        } catch {
          /* the gate's own refusal covers the missing case too */
        }
      };
      const out = await observeAndDriveChain(
        "run-a1",
        baseDeps("run-a1", { driver, store: overlay, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "approval-failed", error: "approval-request-failed" });
      expect(out.kind).not.toBe("driven");
      expect(out.kind).not.toBe("refused");
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 120_000);

  for (const [label, overlayState, expectedOutcome] of [
    ["approved", "approved", "already-decided"],
    ["awaiting-approval under another report", "awaiting-approval", "rebound"],
  ] as const) {
    test(`a decision landing between pre-flight and gate (${label}) → handed-off{outcome:${expectedOutcome}}`, async () => {
      setLogSink(() => undefined);
      const s = store();
      const host = gitHost();
      try {
        const head = quarantine(host, "run-h1");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-h1", { ok: true });
        const overlay = new OverlayStore({ dir: s.dir });
        overlay.closedRun = "run-h1";
        overlay.overlay = approvalExt(overlayState, "rv-other-actor", head);
        const out = await observeAndDriveChain(
          "run-h1",
          baseDeps("run-h1", { driver, store: overlay, runsDir: s.dir, hostRoot: host.dir }),
        );
        expect(out.kind).toBe("handed-off");
        expect((out as { outcome: string }).outcome).toBe(expectedOutcome);
        expect(out.kind).not.toBe("driven"); // nothing re-ran, nothing re-minted (W14-2)
      } finally {
        host.cleanup();
        s.cleanup();
      }
    }, 120_000);
  }

  test("a stranded pausing extension bound to ANOTHER report → handed-off{outcome:pause-in-progress}", async () => {
    setLogSink(() => undefined);
    const s = store();
    const host = gitHost();
    try {
      const head = quarantine(host, "run-h2");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await seedGreenRun(s.store, driver, host, "run-h2", { ok: true });
      // The gate decides `pause-in-progress` at its STARTUP read (a fresh
      // registration promotes without re-reading), so the overlay must be
      // invisible to reverify's bound read (it would re-present the stored
      // id and the gate would RESUME it → requested) and visible to the
      // gate's first read. skip=3 is the post-close read order pinned in
      // OverlayStore's docblock; the headSha matches the quarantined head so
      // the mismatch is the reportId alone.
      const overlay = new OverlayStore({ dir: s.dir });
      overlay.closedRun = "run-h2";
      overlay.overlay = approvalExt("pausing", "rv-someone-else", head);
      overlay.skip = 3;
      const out = await observeAndDriveChain(
        "run-h2",
        baseDeps("run-h2", { driver, store: overlay, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out.kind).toBe("handed-off");
      expect((out as { outcome: string }).outcome).toBe("pause-in-progress");
      expect(out.kind).not.toBe("driven");
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 120_000);
});

describe("#245 — the production closure carries the chain's RunLockHandle (Closes #245)", () => {
  test("a driven outcome proves BOTH teardown call sites accepted the SAME caller handle — and the module source re-acquires nothing", async () => {
    setLogSink(() => undefined);
    const src = await moduleSource();
    // The source half: no withRunLock anywhere (a wrap here throws
    // RunLockReentrantError), no acquireRunLock import.
    expect(src).not.toContain("withRunLock(");
    expect(src).not.toContain("acquireRunLock");
    // The behavioural half: the module calls teardownSandbox directly AND
    // hands the gate a closure over the same deps.runLock. Real
    // teardownSandbox's head check refuses any handle that does not resolve
    // to <runsDir>/<runId>.lock — so a driven outcome (whose gate seam ran
    // between pausing and promote) is only reachable if BOTH sites passed a
    // resolve-equal handle. A re-acquiring or mismatched closure surfaces as
    // chain-failed / approval-failed instead.
    const s = store();
    const host = gitHost();
    try {
      quarantine(host, "run-245");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await seedGreenRun(s.store, driver, host, "run-245", { ok: true });
      const out = await observeAndDriveChain(
        "run-245",
        baseDeps("run-245", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "driven" });
      expect(s.store.get("run-245").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 120_000);

  test("negative: a MISMATCHED handle is refused at teardown's head check → chain-failed{teardown}, nothing touched", async () => {
    setLogSink(() => undefined);
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-245n" });
      driver.plan = [{ body: { runId: "run-245n", ok: true } }];
      const out = await observeAndDriveChain(
        "run-245n",
        baseDeps("run-245n", {
          driver,
          store: s.store,
          runsDir: s.dir,
          hostRoot: host.dir,
          runLock: path.join(s.dir, "someone-elses.lock") as RunCompletionDeps["runLock"],
        }),
      );
      expect(out).toMatchObject({ kind: "chain-failed", step: "teardown" });
      expect((out as { error: string }).error).toContain("not this run's lock");
      expect(s.store.get("run-245n").closedAt).toBeUndefined();
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);
});

describe("worktree: hostRoot is the CALLER's assert (the module runs no git)", () => {
  test("a plain tmpdir as hostRoot still observes — the outcome is decided by the marker/window alone, and the module spawned no git", async () => {
    // The module must not discover the worktree inside reverify (post-teardown
    // discovery is strictly worse than the caller's start-up refusal): the
    // poll legs work against a hostRoot that is not a repo at all. The
    // caller-side order pin lives in the scripts/fleet.ts source test above.
    const s = store();
    try {
      seedRun(s.store, "run-wt");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: null }];
      driver.activity = "active";
      const out = await observeAndDriveChain(
        "run-wt",
        baseDeps("run-wt", { driver, store: s.store, runsDir: s.dir, windowMs: 25 }),
      );
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      // The module issued no git of its own: every routed call is a marker
      // probe or a systemctl word.
      for (const c of driver.calls) {
        expect(c.argv[0] === "sh" || c.argv[0] === "systemctl").toBe(true);
      }
    } finally {
      s.cleanup();
    }
  }, 30_000);
});
