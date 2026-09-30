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
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { FakeDriver, FakeDriverError } from "../../src/providers/fake-driver.ts";
import { createRun, type ExecResult, type ProviderAuditLink } from "../../src/providers/driver.ts";
import { RunRecordStore, type ExtensionEntry } from "../../src/providers/run-record.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { setLogSink } from "../../src/swarmclaw/log.ts";
import { clearRunLockDestructive, isRunLockDestructive } from "../../scripts/lib/run-lock.ts";
import {
  BOX_MARKER_PATH_RE,
  DEFAULT_PER_CALL_DEADLINE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MARKER_UNUSABLE_TICKS_LIMIT,
  PROBE_SKIP_TICKS_LIMIT,
} from "../../src/fleet/fanout-primitive.ts";
import {
  DEFAULT_OBSERVATION_WINDOW_MS,
  OBSERVE_CHAIN_ORIGIN as chainOrigin,
  observeAndDriveChain,
  promoteStrandedPause,
  type ChainOutcome,
  type RunCompletionDeps,
} from "../../src/fleet/run-completion.ts";
import { OBSERVE_CHAIN_ORIGIN as gateOrigin } from "../../src/fleet/approval-gate.ts";
import { buildResult } from "../../src/fleet/result.ts";
// The store is opened on a per-test tmp path (never QDS_AUDIT_DB / the
// operator's `.sandbox/audit.db`): nothing in this file reaches an audit
// composition root, the links here arrive through the injected
// `recordAuditLink` seam, and the store is used only to prove the double
// teardown emit COALESCES to one row.
import { openAuditStore, openAuditStoreForWalk } from "../../src/audit/link-store.ts";
import type { ApprovalPort } from "../../src/reverify/approval.ts";
import { reverify } from "../../src/reverify/runner.ts";

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
 *
 * The default start is read INSIDE armFakeClock, before the spy installs —
 * pinning it to a module-load epoch would move pre-arm timestamps minutes
 * into the fake "future" on a slow suite.
 */
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

/** Advance the fake clock if armed; a no-op on the real clock. */
function stepClock(ms: number): void {
  if (dateNowSpy !== null) fakeClockMs += ms;
}

afterEach(disarmFakeClock);

/**
 * The chain tests silence the process-global log sink (a real teardown →
 * reverify → gate run logs as it goes). `setLogSink` hands back the restore;
 * capturing each install here lets the afterEach below put the sink back —
 * an un-restored silencing sink would swallow every later test's log output
 * for the rest of the process (CodeRabbit round 2, run-completion.test.ts:963).
 */
const quietLogRestores: Array<() => void> = [];
function quietLogs(): void {
  quietLogRestores.push(setLogSink(() => undefined));
}
/**
 * A CAPTURING sink — the observability-layer counterpart of quietLogs: the
 * module's observeLine/emitTerminal emissions land here for field-map
 * assertions. The restore rides quietLogRestores, so both helpers mix freely.
 */
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
});

/** Per-tick marker-read plan; index = marker PROBE count (each tick opens with `test -f`). */
type MarkerPlan =
  | { body: Record<string, unknown> | null } // null = cleanly absent
  | { rawBody: string } // present, exit 0, VERBATIM bytes — malformed payloads
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
  /**
   * `systemctl is-active` EXIT override: 0 answers the word in `activity`;
   * 255/137 is a TRANSPORT failure — unitActivity reads those exit codes
   * first and answers "unknown", with no systemd word to read (G).
   */
  unitProbeExit = 0;
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
      if (this.unitProbeExit !== 0) {
        return { stdout: "", stderr: `ssh: transport failed (exit ${this.unitProbeExit})`, exitCode: this.unitProbeExit };
      }
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
      if ("rawBody" in p) {
        return { stdout: p.rawBody, stderr: "", exitCode: 0 };
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
    // Overridable like every other dep here. As a bare `() => {}` no test could
    // ever see the links this chain emits through the REAL `teardownSandbox`,
    // so deleting the teardown emit left the suite green (DF5.3 review, H/M1).
    recordAuditLink: over.recordAuditLink ?? (() => {}),
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
 * quarantine()'s RED twin: identical shape, but the work's own test FAILS.
 * This is what a genuinely-red re-verify judges — not the marker's ok, not a
 * missing report (O13).
 */
function quarantineRed(h: GitHost, runId: string): string {
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
      'test("sums", () => { expect(sum(1, 2)).toBe(4); });', // RED by construction
      "",
    ].join("\n"),
  );
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "test: sum (red)"]);
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
  const rec = await createRun(driver, s, { runId, recordAuditLink: () => {} });
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

/**
 * The #382 write-order probe: records the approval extension's state AT THE
 * INSTANT the record's close lands. The pre-#382 chain order (teardown →
 * reverify → gate) observes `undefined` here — the close ran before any
 * registration — which is exactly the poller window the fix removes; the
 * fixed order (pre-register → teardown → …) observes `"pausing"`. The
 * negative control an outcome-only assertion cannot provide: a chain that
 * registers AFTER the close still ends at `awaiting-approval` and passes
 * every end-state test in this file.
 */
class CloseProbeStore extends RunRecordStore {
  seenAtClose: string | undefined = undefined;
  override close(runId: string, now?: Date): ReturnType<RunRecordStore["close"]> {
    const ext = this.get(runId).extensions?.approval;
    this.seenAtClose = typeof ext?.state === "string" ? ext.state : undefined;
    return now === undefined ? super.close(runId) : super.close(runId, now);
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

/**
 * The run-record import's names, inline-`type` tokens stripped — both
 * `import type { … }` and `import { type A, B }` must pass the type-only
 * check (O4), while any WRITER symbol in the list must fail it (C1's teeth).
 */
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

describe("AC1 import fence + module shape (source contract)", () => {
  test("the fence: no direct forbidden specifier, fanout-primitive required, run-record type-only, transitive reach permitted (negative control)", async () => {
    const src = await moduleSource();
    // FORBIDDEN — the bridge cannot acquire the ability to write the namespace.
    expect(fenceViolations(src)).toEqual([]);
    // PERMITTED and REQUIRED — the shipped classifier consumed as code.
    expect(importSpecifiers(src)).toContain("./fanout-primitive.ts");
    // run-record: type-only, RunRecord/RunRecordStore only — never a symbol
    // that writes the approval extension (AC5's pre-flight read needs the
    // types; a whole-module ban would forbid them). Inline-`type` form
    // accepted (O4).
    expect(runRecordImportNames(src)).toContain("RunRecordStore");
    expect(runRecordImportNames(src).every((n) => RUN_RECORD_READ_NAMES.includes(n))).toBe(true);
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

  test("the fence has TEETH: every forbidden specifier and a run-record writer symbol actually violate (C1)", async () => {
    // A mistyped FORBIDDEN_DIRECT entry would make every green assertion in
    // the test above vacuous — each entry must catch a synthetic violation.
    for (const specifier of FORBIDDEN_DIRECT) {
      expect(fenceViolations(`import { gate } from "${specifier}";\n`)).toContain(specifier);
      expect(fenceViolations(`export { gate } from "${specifier}";\n`)).toContain(specifier);
    }
    // The run-record clause's teeth: a writer symbol in the import is
    // rejected by the name check.
    const corrupt = 'import { type RunRecord, RunRecordStore, setApproval } from "../providers/run-record.ts";';
    expect(runRecordImportNames(corrupt).every((n) => RUN_RECORD_READ_NAMES.includes(n))).toBe(false);
  });

  test("dynamic imports are banned outright: the static collector is blind to them, so a regex carries the fence (C2)", async () => {
    const src = await moduleSource();
    // The gap, demonstrated on a synthetic: `importSpecifiers` sees nothing
    // here — which is exactly why the assertion below is a regex, not a
    // collector call.
    const dyn = 'const gate = await import("./approval-gate.ts");';
    expect(importSpecifiers(dyn)).toEqual([]);
    expect(/\bimport\s*\(/.test(dyn)).toBe(true);
    // The module itself: no dynamic import of anything, forbidden or not —
    // a bridge that reaches for modules at runtime is outside the fence's
    // static audit entirely.
    expect(/\bimport\s*\(/.test(src)).toBe(false);
  });

  test("AC4 path derivation: boxMarkerPath imported; no runMarkerPath, no inlined /run/qds-run literal", async () => {
    const src = await moduleSource();
    expect(src).toContain("boxMarkerPath");
    expect(src).not.toContain("runMarkerPath");
    expect(src).not.toContain("/run/qds-run");
  });

  test("AC5/#245: the module acquires NO lock and runs NO git (substring belt + specifier teeth)", async () => {
    const src = await moduleSource();
    // The substring belt (kept): the call-site spellings the design forbids.
    expect(src).not.toContain("withRunLock(");
    expect(src).not.toContain("acquireRunLock");
    expect(src).not.toContain("is-inside-work-tree");
    expect(src).not.toContain("Bun.spawn");
    expect(src).not.toContain("spawnSync");
    // Specifier teeth (O6): an ALIASED call site evades a substring grep, so
    // the IMPORT surface is pinned too. The one run-lock import may carry the
    // destructive-window markers and the handle TYPE — never a lock-reaching
    // symbol (withRunLock / acquireRunLock / isRunLockDestructive).
    const lockLine = src.match(/import\s[^;]*from\s*["'][^"']*run-lock\.ts["']/)?.[0] ?? "";
    expect(lockLine).not.toBe("");
    const lockNames = (lockLine.match(/\{([^}]*)\}/)?.[1] ?? "")
      .split(",")
      .map((n) => n.trim().replace(/^type\s+/, ""))
      .filter((n) => n !== "");
    expect(lockNames.sort()).toEqual(["RunLockHandle", "clearRunLockDestructive", "markRunLockDestructive"]);
    // And no child process at all — a VALUE import included, which no
    // call-site grep can see.
    expect(importSpecifiers(src).some((s) => s.includes("node:child_process"))).toBe(false);
  });

  test("AC5/DoD: scripts/fleet.ts observe block takes withRunLock BEFORE the pre-flight read, worktree asserted by the caller before the chain (structural slice, D)", async () => {
    const fleetSrc = await Bun.file(FLEET_TS_PATH).text();
    // The slice is STRUCTURAL — `runObserve`'s arm, bounded by the next verb's
    // function — not a lastIndexOf over a byte window, which can match a
    // sibling verb's lock call when observe's own wiring moves or is removed.
    const start = fleetSrc.indexOf("async function runObserve(");
    const end = fleetSrc.indexOf("async function runDispatch(", start);
    expect(start).toBeGreaterThanOrEqual(0); // leaf-1.2's verb block must wire the module
    expect(end).toBeGreaterThan(start);
    const block = fleetSrc.slice(start, end);
    const lockAt = block.indexOf("withRunLock");
    const readAt = Math.min(...[block.indexOf("assertRunExists"), block.indexOf("store.get")].filter((i) => i >= 0));
    const worktreeAt = block.indexOf("is-inside-work-tree");
    const callAt = block.indexOf("await observeAndDriveChain(");
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(worktreeAt).toBeGreaterThanOrEqual(0);
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(readAt); // lock FIRST (AC5)
    expect(readAt).toBeLessThan(worktreeAt); // the caller's worktree assert, after the pre-flight read
    expect(worktreeAt).toBeLessThan(callAt); // asserted before the chain runs
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
      const { message, remediation } = out as { message: string; remediation: string };
      expect(message).toContain(stamp!);
      // J: no extension above this arm means the tail (reverify → gate) may
      // not have run — the remediation names the honest re-entry, not "start
      // over".
      expect(message).toContain("no approval state behind it");
      expect(remediation).toContain("scripts/reverify.ts run-cl");
      expect(fs.readFileSync(s.store.path("run-cl"))).toEqual(before);
      expect(driver.calls.length).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("an UNRECOGNIZED approval state refuses approval-state-unrecognized before any box touch (fail-closed, H)", async () => {
    for (const state of ["awaiting_approval", "", 42, { nested: true }]) {
      const s = store();
      try {
        seedRun(s.store, "run-hu");
        // The corruption arrives the way the finding describes it: a HAND
        // EDIT. The store's write path rejects a non-string state outright
        // (schema-rejected), but read-mode validation deliberately tolerates
        // any value a registered namespace already holds — so the file is
        // rewritten underneath the store, exactly the crash/hand-edit shape
        // the module's defensive read exists for.
        const p = s.store.path("run-hu");
        const rec = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
        rec.extensions = { approval: { ...approvalExt("awaiting-approval"), state } };
        fs.writeFileSync(p, JSON.stringify(rec));
        const before = fs.readFileSync(p);
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        const out = await observeAndDriveChain("run-hu", baseDeps("run-hu", { driver, store: s.store, runsDir: s.dir }));
        expect(out).toMatchObject({ kind: "refused", code: "approval-state-unrecognized" });
        expect((out as { message: string }).message).toContain("cannot classify");
        expect(fs.readFileSync(p)).toEqual(before);
        expect(driver.calls.length).toBe(0); // refused before any box touch
        expect(driver.destroyed).toEqual([]);
      } finally {
        s.cleanup();
      }
    }
  });

  test("unrecognized state + closedAt → the EXTENSION refusal wins (fail-closed order pin, H before J)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-ho");
      s.store.close("run-ho");
      const p = s.store.path("run-ho");
      const rec = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      rec.extensions = { approval: { ...approvalExt("awaiting-approval"), state: 42 } };
      fs.writeFileSync(p, JSON.stringify(rec));
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const out = await observeAndDriveChain("run-ho", baseDeps("run-ho", { driver, store: s.store, runsDir: s.dir }));
      expect(out).toMatchObject({ kind: "refused", code: "approval-state-unrecognized" });
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

  test("refusals emit NO observe line — the module stays silent, the verb's exit surface owns them (E)", async () => {
    const lines = captureLogs();
    const s = store();
    try {
      seedRun(s.store, "run-er");
      s.store.set("run-er", { extensions: { approval: approvalExt("approved") } } as never);
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const out = await observeAndDriveChain("run-er", baseDeps("run-er", { driver, store: s.store, runsDir: s.dir }));
      expect(out).toMatchObject({ kind: "refused", code: "approval-already-registered" });
      expect(driver.calls.length).toBe(0);
      // The pin: nothing on the poll/chain event vocabulary is minted for a
      // pre-flight refusal. (The store's own run-record.* telemetry rides the
      // same sink, so the filter is the module's operation, not the whole log.)
      expect(lines.filter((l) => l.operation === "fleet.observe")).toEqual([]);
    } finally {
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
      // A 1 ms window, paced by the fake clock (the liveness call steps 1 s
      // per tick): the first tick's accumulated floor outlives the window, so
      // the invocation ends on the window arm after exactly one marker read
      // (O3) — deterministically, not by a same-millisecond wall race.
      driver.advanceMs = 1_000;
      armFakeClock();
      const deps = baseDeps("run-w", { driver, store: s.store, runsDir: s.dir, windowMs: 1 });
      const out = await observeAndDriveChain("run-w", deps);
      expect(out.kind).toBe("unsettled");
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      expect(driver.markerTicks).toBe(1); // exactly one marker read (O3), not a poll that ran on
      expect(driver.destroyed).toEqual([]); // box alive and listable (INV-5)
      expect(fs.readFileSync(s.store.path("run-w"))).toEqual(before); // no record field mutated
      // Idempotent: the marker is the state — re-observing sees the same
      // thing. (The fake clock is still armed, so driver2 paces itself the
      // same way — a frozen clock with no stepping would loop forever.)
      const driver2 = new ProbeDriver(path.join(s.dir, "boxes"));
      driver2.plan = [{ body: null }];
      driver2.activity = "active";
      driver2.advanceMs = 1_000;
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
      // Paced by the FAKE clock (O9), never by a real-sleep race: the liveness
      // probe steps 3 s per tick (a clean-absent probe steps nothing — only
      // the plan's failure legs do), so tick 1 ends at t0+3 s — inside the
      // 5 s window — and tick 2 lands at t0+6 s, past it. The two-tick shape
      // is pinned without betting on tick 1 finishing inside a real 5 s
      // interval on a loaded CI box.
      driver.advanceMs = 3_000;
      armFakeClock();
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

  for (const exit of [255, 137]) {
    test(`absent + unit probe transport failure (exit ${exit}, no word) → unknown, NOT terminal — never a death certificate for a dead ssh (G)`, async () => {
      const s = store();
      try {
        seedRun(s.store, `run-lg${exit}`);
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        driver.plan = [{ body: null }];
        driver.unitProbeExit = exit;
        // Fake-clock pacing: the probe (exit 255, no clock step) plus the
        // 1 s-stepped liveness call put tick 1's accumulated floor past the
        // 500 ms window, so the invocation ends after EXACTLY one tick.
        driver.advanceMs = 1_000;
        armFakeClock();
        const out = await observeAndDriveChain(
          `run-lg${exit}`,
          baseDeps(`run-lg${exit}`, { driver, store: s.store, runsDir: s.dir, windowMs: 500 }),
        );
        // The transport exit is read FIRST (unitActivity): no systemd word
        // exists, so the reading is `unknown` — counted on the skip streak,
        // never the one terminal liveness reading.
        expect(driver.calls.filter((c) => c.argv[0] === "systemctl").length).toBe(1); // the branch was really exercised
        expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
        expect(terminalOf(out)?.code).not.toBe("run-engine-dead");
        expect(driver.destroyed).toEqual([]);
      } finally {
        s.cleanup();
      }
    }, 30_000);
  }

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

  test("five skips with the wall conjunct ALREADY satisfied → NOT box-unreachable: the tick bound is strict, not a >= (O8 near-miss)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-s4");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      // 20 s of fake wall per skip: the conjunct's 90 s is satisfied by tick 5
      // (100 s since lastReach) — so if the streak bound were `>= 5` this
      // would fire. It must not: five is a near-miss, and the invocation ends
      // on the maxTicks arm with NO terminal.
      driver.advanceMs = 20_000;
      driver.plan = Array.from({ length: 5 }, () => ({ forcedProbeExit: 255 } as MarkerPlan));
      armFakeClock();
      const out = await observeAndDriveChain(
        "run-s4",
        baseDeps("run-s4", { driver, store: s.store, runsDir: s.dir, maxTicks: 5, windowMs: 400_000 }),
      );
      expect(out.kind).toBe("unsettled");
      expect((out as { terminal?: unknown }).terminal).toBeUndefined();
      expect(driver.markerTicks).toBe(5);
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 60_000);

  test("the 90 s conjunct fires at EXACT equality: six skips, 15 s of fake wall each (O8)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-s5");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      // Skips step only their own probe: 15 s per tick puts the SIXTH skip at
      // exactly 90 000 ms since lastReachMs — the conjunct is `>=`, and the
      // equality edge is where a `<`/`>` typo or an off-by-one interval sum
      // shows. Fires at exactly tick 6, never earlier.
      driver.advanceMs = 15_000;
      driver.plan = Array.from({ length: 8 }, () => ({ forcedProbeExit: 255 } as MarkerPlan));
      armFakeClock();
      const out = await observeAndDriveChain(
        "run-s5",
        baseDeps("run-s5", { driver, store: s.store, runsDir: s.dir, windowMs: 400_000 }),
      );
      expect(out.kind).toBe("unsettled");
      expect(terminalOf(out)?.code).toBe("box-unreachable");
      expect(driver.markerTicks).toBe(6);
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 60_000);

  test("a skip tick does NOT reset the unusable streak: [255, cat, 255, cat, 255, cat] gives up at tick 6 (O8)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-s6");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      // The streaks are independent counters: skips reset nothing but
      // themselves being broken by an ANSWERED read. Here every cat failure
      // is one unusable; three of them (ticks 2, 4, 6) is the corruption
      // bound — the interleaved skips must not have cleared it.
      driver.plan = [
        { forcedProbeExit: 255 },
        { catExit: 2 },
        { forcedProbeExit: 255 },
        { catExit: 2 },
        { forcedProbeExit: 255 },
        { catExit: 2 },
      ];
      const out = await observeAndDriveChain(
        "run-s6",
        baseDeps("run-s6", { driver, store: s.store, runsDir: s.dir, windowMs: 10 * DEFAULT_POLL_INTERVAL_MS }),
      );
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved"); // the unusable bound, not the window
      expect(driver.markerTicks).toBe(6);
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 60_000);

  test("box-unreachable on `unknown` liveness evidence says 'no usable answer', never 'answered nothing' (A)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-s7");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      // Every tick IS answered — a clean absence probed, then `unknown`, the
      // ambiguous liveness word — so the fill's message may not claim silence.
      // Both legs step the fake wall (40 s per tick), so the conjunct is
      // satisfied well before tick 6.
      driver.advanceMs = 20_000;
      driver.activity = "unknown";
      driver.plan = [{ body: null }];
      armFakeClock();
      const out = await observeAndDriveChain(
        "run-s7",
        baseDeps("run-s7", { driver, store: s.store, runsDir: s.dir, windowMs: 400_000 }),
      );
      const terminal = terminalOf(out);
      expect(terminal?.code).toBe("box-unreachable");
      expect(terminal?.message).toContain("no usable answer");
      expect(terminal?.message).not.toContain("answered nothing");
      expect(terminal?.message).toContain("unit unknown"); // the cited evidence contradicts a silence claim
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 120_000);

  test("an UNUSABLE tick resets the skip streak: the box answered (present + cat), so skips cannot bridge across it", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-s3");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      // Ticks 1-5: five 255 skips (streak 5, fake wall +20 s each). Tick 6:
      // present-at-test + failed cat — the box answered BOTH legs, so the
      // streak resets (the race's own doctrine, fanout-primitive.ts: the
      // unusable tick is `anyArmAnswered`) and lastReachMs moves to now.
      // Ticks 7-10: four more skips. Pre-fix the streak counted 5+4=9 across
      // the unusable and fired box-unreachable at tick 10 ("answered nothing
      // on six consecutive ticks" — factually wrong: tick 6 answered); with
      // the reset the post-unusable streak tops out at four, under the limit,
      // and the window expires with the OTHER code.
      driver.advanceMs = 20_000;
      driver.plan = [
        ...Array.from({ length: 5 }, () => ({ forcedProbeExit: 255 } as MarkerPlan)),
        { catExit: 2 },
        ...Array.from({ length: 4 }, () => ({ forcedProbeExit: 255 } as MarkerPlan)),
      ];
      armFakeClock();
      const out = await observeAndDriveChain("run-s3", baseDeps("run-s3", { driver, store: s.store, runsDir: s.dir, windowMs: 190_000 }));
      expect(out.kind).toBe("unsettled");
      expect(terminalOf(out)?.code).not.toBe("box-unreachable"); // the answered tick broke the streak
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved"); // window fill, not transport death
      expect(driver.destroyed).toEqual([]); // box alive and listable either way
    } finally {
      s.cleanup();
    }
  }, 120_000);
});

// ─── the chain and the ChainOutcome arms (AC2c, AC5, #245) ──────────────────

describe("the chain: driven, ok:false, vetoed (real teardownSandbox → reverify → gate)", () => {
  test("settled ok:true drives the WHOLE chain to a registered pause — driven{markerOk:true} (AC1)", async () => {
    const lines = captureLogs();
    const s = store();
    const host = gitHost();
    try {
      quarantine(host, "run-d1");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const vm = await seedGreenRun(s.store, driver, host, "run-d1", { ok: true });
      const ledger = quietLedger();
      // DF5.3: the chain's own audit seam, CAPTURED. `chainTeardownDeps`
      // forwards `recordAuditLink` into the real `teardownSandbox`, so this is
      // the only place the hop-6 teardown link is observable from — and while
      // `baseDeps` hardcoded a `() => {}` nothing in this file could see it.
      const links: ProviderAuditLink[] = [];
      const out = await observeAndDriveChain(
        "run-d1",
        baseDeps("run-d1", {
          driver,
          store: s.store,
          runsDir: s.dir,
          hostRoot: host.dir,
          costLedger: ledger.hook as never,
          recordAuditLink: (link) => links.push(link),
        }),
      );
      expect(out).toMatchObject({ kind: "driven", markerOk: true });
      expect(typeof (out as { chainMs: number }).chainMs).toBe("number");
      const rec = s.store.get("run-d1");
      expect(rec.closedAt).toBeTruthy(); // teardown's close step ran
      expect(rec.extensions?.approval?.state).toBe("awaiting-approval"); // written only by the gate
      expect(fs.existsSync(path.join(s.dir, "run-d1.bundle"))).toBe(true); // harvest's bundle
      expect(driver.destroyed).toEqual([vm]); // the box is gone
      expect(ledger.ingested.length).toBeGreaterThan(0); // box-hours priced through the caller's ledger
      // The box is gone, the bundle was fetched and verified, and the chain
      // said so. No key was ever minted here, so no credential link is owed.
      expect(new Set(links.map((l) => `${l.hop}/${l.event}`))).toEqual(
        new Set(["run-bundle/bundle-verify", "run-bundle/bundle-fetch", "run-box/teardown"]),
      );
      // `teardown` is emitted TWICE on this path and that is BY DESIGN: the
      // fresh close emits it (teardown.ts, inside the close step) and the
      // approval gate's own teardown re-enters `teardownSandbox`, which
      // short-circuits on first-close-wins and re-emits so a process that died
      // between the close and the emit still lands the row. It is harmless only
      // because every copy carries the SAME subject and the SAME evidence
      // digest — which is exactly what the store's
      // `UNIQUE (run_id, hop, event, subject_key)` + `ON CONFLICT DO NOTHING`
      // coalesces on, so the STORE holds one row.
      //
      // Pinned through the STORE, not through the digests. `evidenceDigest` is
      // `sha256(canonicalJson(detail ?? null))` and nothing else feeds it
      // (driver.ts `emitAuditLink`), so "two emits with the same detail share a
      // digest" is arithmetic, not a property of this chain — the digest-set
      // check could only fail if `detail` drifted, which the `toMatchObject`
      // loop below already covers field by field. Replaying both emits into a
      // real store and reading ONE row back is the actual claim, and it is the
      // one that fails if the healing arm ever derives `occurredAt` or `detail`
      // differently (the store records that as `divergent` and keeps the first
      // row, so the second's facts are lost).
      const teardowns = links.filter((l) => l.event === "teardown");
      expect(teardowns).toHaveLength(2);
      const coalesceDir = fs.mkdtempSync(path.join(os.tmpdir(), "qds-df53-coalesce-"));
      try {
        const store = openAuditStore(path.join(coalesceDir, "audit.db"));
        try {
          for (const l of teardowns) store.record(l);
        } finally {
          store.close();
        }
        const handle = openAuditStoreForWalk(path.join(coalesceDir, "audit.db"));
        try {
          expect(handle.linksForRun("run-d1").filter((r) => r.event === "teardown")).toHaveLength(1);
        } finally {
          handle.close();
        }
      } finally {
        fs.rmSync(coalesceDir, { recursive: true, force: true });
      }
      for (const l of teardowns) {
        expect(l).toMatchObject({
          runId: "run-d1",
          repoSlug: "acme/widget", // the record's own attribution (INV-AUDIT-4)
          requestId: "req-df37",
          hop: "run-box",
          subjectKind: "box",
          subjectId: vm,
        });
      }
      // O16: guardedTeardown clears the destructive mark ON success — the
      // driven posture leaves an unmarked lock, same as the teardown verb.
      expect(isRunLockDestructive(lockHandle(s.dir, "run-d1"))).toBe(false);
      // E: the driven family's terminal line carries the kind, both timings,
      // and the join keys — and no error field. (`markerOk` rides the OUTCOME
      // and the verb's stdout line; the event line carries kind + timings.)
      const done = lines.find((l) => l.event === "run-complete");
      expect(done).toMatchObject({
        kind: "driven",
        runId: "run-d1",
        requestId: "req-df37",
        operation: "fleet.observe",
        status: "ok",
      });
      expect(typeof done!.chain_ms).toBe("number");
      expect(typeof done!.marker_poll_ms).toBe("number");
      expect(done!.error).toBeUndefined();
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 120_000);

  test("settled ok:false STILL drives the chain; the marker's ok never reaches reverify — its own verdict decides (AC2c)", async () => {
    quietLogs();
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
    const lines = captureLogs();
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-v1", recordAuditLink: () => {} });
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
      // E: the vetoed family's terminal line carries the REDACTED reason.
      const done = lines.find((l) => l.event === "run-complete");
      expect(done).toMatchObject({ kind: "vetoed", reason: "no-base-sha" });
      expect(typeof done!.marker_poll_ms).toBe("number");
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);

  test("nothing-to-verify → vetoed (zero commits beyond base is a judgment arm, exit 6)", async () => {
    quietLogs();
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const rec = await createRun(driver, s.store, { runId: "run-v2", recordAuditLink: () => {} });
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

describe("#382 — the chain registers the gate BEFORE the close (the poller window)", () => {
  test("a vetoed chain leaves closedAt + chain-pausing — the poller payload reads pausing, NEVER completed (the regression)", async () => {
    quietLogs();
    const s = store();
    const host = gitHost();
    try {
      // The run-v1 shape: settled marker, no commitSha → reverify errors inside
      // its own try → vetoed, and the gate is never reached. The record's end
      // state is exactly the window shape the old order left TRANSIENTLY:
      // `closedAt` set with the chain's `pausing` behind it.
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-w1", recordAuditLink: () => {} });
      driver.plan = [{ body: { runId: "run-w1", ok: true } }];
      const out = await observeAndDriveChain(
        "run-w1",
        baseDeps("run-w1", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "vetoed", reason: "no-base-sha" });
      const rec = s.store.get("run-w1");
      expect(rec.closedAt).toBeTruthy();
      expect(rec.extensions?.approval?.state).toBe("pausing");
      expect(rec.extensions?.approval?.origin).toBe("observe-chain");
      // THE PIN: `buildResult` over the exact record shape that used to map to
      // terminal `completed` in the window — the read the swarmclaw poller's
      // 2 s tick landed on in SC2.7 round 5 and applied as a completed verdict,
      // defeating the approve seam. With the pre-registration the SAME shape is
      // the record's stable post-veto state, and it is non-terminal.
      expect(buildResult(s.store, "run-w1")).toMatchObject({ status: "pausing", terminal: false });
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);

  test("the driven chain's promoted record still carries the chain origin (deep-merge survival)", async () => {
    quietLogs();
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-rc-"));
    const s = { dir, store: new CloseProbeStore({ dir }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    const host = gitHost();
    try {
      quarantine(host, "run-w2");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await seedGreenRun(s.store, driver, host, "run-w2", { ok: true });
      const out = await observeAndDriveChain(
        "run-w2",
        baseDeps("run-w2", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "driven", markerOk: true });
      // THE ORDER PIN: the extension already said `pausing` at the instant the
      // teardown's close landed — the write-order guarantee the poller window
      // fix is. (`undefined` here is the pre-#382 order passing every
      // end-state assertion below.)
      expect(s.store.seenAtClose).toBe("pausing");
      const ext = s.store.get("run-w2").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      // The gate's adopt restamps the pair it owns and never rewrites `origin`:
      // the field survives both the restamp and the promotion, so the record
      // keeps saying who registered the pause.
      expect(ext?.origin).toBe("observe-chain");
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 120_000);

  test("W1 crash recovery: chain-pausing on an OPEN record with the marker still settled re-runs the WHOLE chain", async () => {
    quietLogs();
    const s = store();
    const host = gitHost();
    try {
      // The crash window between the chain's pre-registration and its teardown:
      // the extension is on disk, the record is open, the box is alive and its
      // marker is settled. promoteStrandedPause presumes a post-teardown record
      // (no box, no marker) and would strand this one — the honest recovery is
      // the full chain again, ending in the gate's adopt.
      quarantine(host, "run-w3");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await seedGreenRun(s.store, driver, host, "run-w3", { ok: true });
      s.store.set("run-w3", {
        extensions: { approval: { state: "pausing", origin: "observe-chain" } },
      } as never);
      const out = await observeAndDriveChain(
        "run-w3",
        baseDeps("run-w3", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "driven", markerOk: true });
      const ext = s.store.get("run-w3").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      expect(driver.destroyed.length).toBe(1); // the still-alive box was torn down
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 120_000);

  test("the fence stays intact: the chain's local origin literal equals the gate's exported constant", () => {
    // run-completion.ts may not import ./approval-gate.ts (FORBIDDEN_DIRECT —
    // the bridge acquires no gate surface), so the two modules each carry the
    // one literal. This pin is the coupling: if either side renames the value,
    // the chain's registrations stop being adoptable and this fails.
    expect(chainOrigin).toBe(gateOrigin);
    expect(gateOrigin).toBe("observe-chain");
  });
});

describe("chain-failed: a step other than the approval leg threw (W16-2)", () => {
  test("destroy fails PRE-close → chain-failed{step:teardown}, the record stays open", async () => {
    const lines = captureLogs();
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-c1", recordAuditLink: () => {} });
      driver.plan = [{ body: { runId: "run-c1", ok: true } }];
      driver.destroyThrows = true;
      // DF5.3: CAPTURED here too, not only on the happy `driven` path. This is
      // the file's one failure-shaped teardown, and until it captured, nothing
      // observed whether a `run-box/teardown` link was written for a box that
      // was NOT destroyed. A regression that emits the link before
      // `driver.destroy()` resolves would record "box torn down" for a box
      // still alive and billing, and the suite would stay green.
      const links: ProviderAuditLink[] = [];
      const out = await observeAndDriveChain(
        "run-c1",
        baseDeps("run-c1", {
          driver,
          store: s.store,
          runsDir: s.dir,
          hostRoot: host.dir,
          recordAuditLink: (link) => links.push(link),
        }),
      );
      expect(out).toMatchObject({ kind: "chain-failed", step: "teardown" });
      // NO teardown link: the emit lives inside the `close` step, which the
      // unconfirmed destroy aborts before. The link vouches for a destroyed
      // box, so an undestroyed box owes none — the hop reporting `unlinked`
      // is the honest answer while the record is still open.
      expect(links.filter((l) => l.hop === "run-box" && l.event === "teardown")).toEqual([]);
      expect((out as { error: string }).error).toContain("destruction");
      expect(s.store.get("run-c1").closedAt).toBeUndefined(); // abort ⇒ record open
      // The destructive window was entered and did not complete, so the mark
      // the chain armed survives the outcome (guardedTeardown) — the lock is
      // the operator's to judge, exactly the teardown verb's posture.
      expect(isRunLockDestructive(lockHandle(s.dir, "run-c1"))).toBe(true);
      // E: the chain-failed family's terminal line carries step + error.
      const done = lines.find((l) => l.event === "run-complete");
      expect(done).toMatchObject({ kind: "chain-failed", step: "teardown" });
      expect(String(done!.error)).toContain("destruction");
    } finally {
      clearRunLockDestructive(lockHandle(s.dir, "run-c1")); // keep the mark out of later tests
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);

  test("a reverify-leg throw POST-close → chain-failed{step:reverify}, the record stays closed", async () => {
    quietLogs();
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-c2", recordAuditLink: () => {} });
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
    quietLogs();
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
          // O7: read the arrangement back — a truncate that did not happen
          // (or a bundle already missing) would make hollow-vs-missing
          // nondeterministic, and the pinned refusal code could be reached
          // through either arm.
          expect(fs.statSync(path.join(s.dir, "run-a1.bundle")).size).toBe(0);
        } catch (e) {
          throw new Error(`the truncate arrangement failed to land: ${String(e)}`);
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
      quietLogs();
      const s = store();
      const host = gitHost();
      try {
        const head = quarantine(host, "run-h1");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-h1", { ok: true });
        const overlay = new OverlayStore({ dir: s.dir });
        overlay.closedRun = "run-h1";
        overlay.overlay = approvalExt(overlayState, "rv-other-actor", head);
        overlay.skip = 3; // the overlay lands at the GATE's startup read, not before (O1)
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
    const lines = captureLogs();
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
      // E: the handed-off family's terminal line carries the outcome string.
      const done = lines.find((l) => l.event === "run-complete");
      expect(done).toMatchObject({ kind: "handed-off", outcome: "pause-in-progress" });
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 120_000);
});

describe("#245 — the production closure carries the chain's RunLockHandle (Closes #245)", () => {
  test("a driven outcome proves BOTH teardown call sites accepted the SAME caller handle — and the module source re-acquires nothing", async () => {
    quietLogs();
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
    quietLogs();
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-245n", recordAuditLink: () => {} });
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
      // O15: the mark the chain armed went onto the handle the CALLER passed
      // (the foreign lock), not onto the run's own — that is the #245 closure
      // passing deps.runLock through verbatim.
      expect(isRunLockDestructive(path.join(s.dir, "someone-elses.lock"))).toBe(true);
      expect(isRunLockDestructive(lockHandle(s.dir, "run-245n"))).toBe(false);
    } finally {
      clearRunLockDestructive(path.join(s.dir, "someone-elses.lock")); // keep the mark out of later tests
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

// ─── the observability layer (E): field maps, redaction, cap, sink guard ────

describe("observability (E)", () => {
  test("a throwing log sink never replaces the caller's outcome (observeLine guard)", async () => {
    quietLogRestores.push(
      setLogSink(() => {
        throw new Error("sink exploded by the test seam");
      }),
    );
    const s = store();
    try {
      seedRun(s.store, "run-e0");
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: null }];
      driver.activity = "active";
      const out = await observeAndDriveChain(
        "run-e0",
        baseDeps("run-e0", { driver, store: s.store, runsDir: s.dir, windowMs: 1 }),
      );
      // The poll's emissions (marker-absent, the terminal line) all funnel
      // through observeLine's try/catch — the invocation still ends typed.
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 30_000);

  test("verdict errors are REDACTED then capped at 200 chars before the sink (E: logText)", async () => {
    const s = store();
    try {
      seedRun(s.store, "run-e2");
      // The mismatch arm embeds the marker's runId VERBATIM into the verdict
      // error — the classifier builds its cause out of the marker's OWN
      // bytes, so a marker whose runId IS secret-shaped puts real secret
      // bytes on the only path to the log. The prose tail (redactor-inert)
      // makes the pre-sink text far longer than the cap, so the slice bites.
      const secret = `sk-${"k".repeat(60)} ${"lorem ipsum dolor sit amet ".repeat(30)}`;
      const lines = captureLogs();
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: { runId: secret, ok: true } }];
      const out = await observeAndDriveChain(
        "run-e2",
        baseDeps("run-e2", { driver, store: s.store, runsDir: s.dir, windowMs: 10 * DEFAULT_POLL_INTERVAL_MS }),
      );
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved"); // 3 unusable ticks, the corruption bound
      const unusable = lines.filter((l) => l.event === "marker-unusable");
      expect(unusable.length).toBe(MARKER_UNUSABLE_TICKS_LIMIT);
      for (const l of unusable) {
        const err = String(l.error);
        expect(err.length).toBeLessThanOrEqual(200); // the cap
        expect(err).not.toContain("sk-"); // the redaction ran BEFORE the slice
      }
    } finally {
      s.cleanup();
    }
  }, 60_000);
});

// ─── malformed marker payloads (F) ──────────────────────────────────────────

describe("malformed marker payloads (F): present + unjudgeable is unusable, streak-bounded", () => {
  const cases: Array<{ label: string; rawBody: string; code?: string }> = [
    { label: "garbage JSON", rawBody: "not-json-at-all{{{" },
    { label: "non-boolean ok", rawBody: JSON.stringify({ runId: "run-f1", ok: "yes" }) },
    { label: "null body", rawBody: "null" },
    { label: "non-string runId", rawBody: JSON.stringify({ runId: 42, ok: true }), code: "marker-run-id-invalid" },
    { label: "mismatched runId", rawBody: JSON.stringify({ runId: "someone-else", ok: true }), code: "marker-run-mismatch" },
  ];
  for (const c of cases) {
    test(`${c.label} → unusable; three consecutive give up; the chain never runs`, async () => {
      const s = store();
      try {
        seedRun(s.store, "run-f1");
        const before = fs.readFileSync(s.store.path("run-f1"));
        const lines = captureLogs();
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        driver.plan = [{ rawBody: c.rawBody }];
        const out = await observeAndDriveChain(
          "run-f1",
          baseDeps("run-f1", { driver, store: s.store, runsDir: s.dir, windowMs: 10 * DEFAULT_POLL_INTERVAL_MS }),
        );
        expect(terminalOf(out)?.code).toBe("run-completion-unobserved"); // the corruption bound, not the window
        expect(driver.markerTicks).toBe(MARKER_UNUSABLE_TICKS_LIMIT);
        expect(markerCmds(driver, "cat ").length).toBe(MARKER_UNUSABLE_TICKS_LIMIT); // every tick answered BOTH legs
        expect(driver.destroyed).toEqual([]);
        expect(fs.readFileSync(s.store.path("run-f1"))).toEqual(before);
        if (c.code !== undefined) {
          const perTick = lines.filter((l) => l.event === "marker-unusable");
          expect(perTick.length).toBe(MARKER_UNUSABLE_TICKS_LIMIT);
          for (const l of perTick) expect(l.code).toBe(c.code);
        }
      } finally {
        s.cleanup();
      }
    }, 60_000);
  }

  test("a marker with NO runId and ok:true SETTLES — an absent ownership claim is the caller's own run (F, classifier-documented)", async () => {
    // The triage expected this shape to be unusable; the classifier's source
    // says otherwise (`marker.runId !== undefined` gates the ownership check —
    // only a PRESENT-but-wrong claim is corruption). Pinned at its REAL
    // behavior via the cheapest settled reach: the chain runs and reverify's
    // no-base-sha veto lands — an unusable reading would end
    // run-completion-unobserved instead.
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-f2", recordAuditLink: () => {} });
      driver.plan = [{ body: { ok: true } }];
      const out = await observeAndDriveChain(
        "run-f2",
        baseDeps("run-f2", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "vetoed", reason: "no-base-sha" }); // the chain RAN
      expect(s.store.get("run-f2").closedAt).toBeTruthy();
      expect(driver.destroyed.length).toBe(1);
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);
});

// ─── the observation window under a backward clock (N) ──────────────────────

describe("the observation window under clock manipulation (N)", () => {
  test("a backward clock step cannot defer expiry: the accumulated floor expires the window (N)", async () => {
    class BackStepDriver extends ProbeDriver {
      backStepAtProbe = Number.POSITIVE_INFINITY;
      backStepMs = 0;
      #probes = 0;
      override async execTimed(vm: string, argv: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
        const res = await super.execTimed(vm, argv, timeoutMs, stdin);
        if (argv.length >= 3 && typeof argv[2] === "string" && BOX_MARKER_PATH_RE.test(argv[2]) && argv[2]!.includes("test -f")) {
          this.#probes += 1;
          if (this.#probes === this.backStepAtProbe) fakeClockMs -= this.backStepMs; // the NTP correction
        }
        return res;
      }
    }
    const s = store();
    try {
      seedRun(s.store, "run-n1");
      const driver = new BackStepDriver(path.join(s.dir, "boxes"));
      driver.plan = [{ body: null }];
      driver.activity = "inactive"; // answered-but-negative, so the streaks stay out of the way
      driver.advanceMs = 80_000;
      driver.backStepAtProbe = 2;
      driver.backStepMs = 300_000;
      armFakeClock();
      // windowMs 150 s, deadline t0+150 s. Only the LIVENESS leg steps the
      // fake wall here (a clean-absent probe steps nothing): tick 1
      // accumulates 80 s of measured work; tick 2's probe hurls the clock
      // back 300 s (now BELOW the start — the wall deadline is forever away);
      // tick 3 pushes the accumulated floor to 160 s. The wall arm CANNOT
      // have fired; the expiry at exactly 3 ticks is the accumulated floor's.
      const out = await observeAndDriveChain(
        "run-n1",
        baseDeps("run-n1", { driver, store: s.store, runsDir: s.dir, windowMs: 150_000 }),
      );
      expect(terminalOf(out)?.code).toBe("run-completion-unobserved");
      expect(driver.markerTicks).toBe(3);
      expect(driver.destroyed).toEqual([]);
    } finally {
      s.cleanup();
    }
  }, 30_000);
});

// ─── the reverify leg's INV-RV-4 redaction map (I) ──────────────────────────

describe("the reverify redaction map (I)", () => {
  test("the module passes a NON-EMPTY map keyed on the record's keyHash to reverify (INV-RV-4)", async () => {
    const REDACTION_MODULE = "../../src/reverify/redaction.ts";
    // Seam-patched with the repo's mock.module restore-by-spread idiom
    // (tests/scripts/qds-cost.test.ts): the wrapper records what the module
    // handed to reverify, then calls the real builder.
    const redactionModule = await import(REDACTION_MODULE);
    const real = redactionModule.runRedactionMap;
    const seen: Array<{ runId: string; runsDir?: string; keys: string[] }> = [];
    mock.module(REDACTION_MODULE, () => ({
      ...redactionModule,
      runRedactionMap: (runId: string, runsDir?: string) => {
        const map = real(runId, runsDir);
        seen.push({ runId, runsDir, keys: Object.keys(map) });
        return map;
      },
    }));
    quietLogs();
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      await createRun(driver, s.store, { runId: "run-i1", recordAuditLink: () => {} });
      s.store.set("run-i1", {
        commitSha: host.baseSha,
        keyHash: "key-hash-for-the-redaction-test",
        requestId: "req-df37",
        extensions: { budget: { repoSlug: "acme/widget", issueId: "7" } },
      } as never);
      driver.plan = [{ body: { runId: "run-i1", ok: true } }]; // settles → chain → nothing-to-verify veto
      await observeAndDriveChain(
        "run-i1",
        baseDeps("run-i1", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(seen.length).toBeGreaterThan(0); // the chain reached reverify through this seam
      for (const ctx of seen) {
        expect(ctx.runId).toBe("run-i1");
        expect(ctx.runsDir).toBe(s.dir); // the record is read from the RUNS dir, not cwd
        expect(ctx.keys).toContain("QDS_PROVIDER_KEY_HASH"); // non-empty: the record's hash is promised redacted
      }
    } finally {
      mock.module(REDACTION_MODULE, () => ({ ...redactionModule, runRedactionMap: real }));
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);
});

// ─── the stranded-pause promotion path (B / auditor AC5): the green path ────

describe("the stranded-pause promotion (B): a promotable pausing record, driven for real", () => {
  /**
   * A promotable stranded pause, every fact real: the work is quarantined in
   * the host repo AND cloned into the box, a green report is sealed by a REAL
   * reverify run (stubbing only its approval leg — nothing may register yet),
   * the bundle sits where the gate's resume guard looks, and the record
   * carries `pausing` bound to that report at that head.
   */
  async function seedPromotablePause(
    s: { store: RunRecordStore; dir: string },
    host: GitHost,
    runId: string,
  ): Promise<{ vmName: string; driver: ProbeDriver; reportId: string; head: string }> {
    const head = quarantine(host, runId);
    const driver = new ProbeDriver(path.join(s.dir, "boxes"));
    const rec = await createRun(driver, s.store, { runId, recordAuditLink: () => {} });
    seedBoxGit(driver, rec.vmName!, host, runId);
    s.store.set(runId, {
      commitSha: host.baseSha,
      requestId: "req-df37",
      // INV-APPROVE-6 reaches the resume/promote arms too: a record that
      // names a box must account for its key, or the gate refuses the pause
      // hand-over. The key is long revoked (the box is gone in this story's
      // posture); the hash is what the guard reads.
      keyHash: "key-hash-for-the-promote-test",
      extensions: { budget: { repoSlug: "acme/widget", issueId: "7" } },
    } as never);
    const stub = { requestApproval: async () => ({ outcome: "pause-in-progress" }) } as ApprovalPort;
    const first = await reverify(runId, {
      store: s.store,
      runsDir: s.dir,
      hostRoot: host.dir,
      approval: stub,
      log: () => undefined,
    });
    expect(first.report.verdict).toBe("green"); // the fixture must seal a GREEN report
    s.store.set(runId, { extensions: { approval: approvalExt("pausing", first.report.reverifyId, head) } } as never);
    // The resume arm's assertBundlePresent: the bundle sits at
    // <runsDir>/<runId>.bundle (the promote tail's harvest re-writes it for real).
    fs.writeFileSync(path.join(s.dir, `${runId}.bundle`), "bundle-bytes-by-test\n");
    return { vmName: rec.vmName!, driver, reportId: first.report.reverifyId, head };
  }

  test("a promotable stranded pause → driven with NO markerOk and ZERO poll calls (the second export's green path)", async () => {
    const s = store();
    const host = gitHost();
    try {
      const { vmName, driver } = await seedPromotablePause(s, host, "run-pg");
      const lines = captureLogs();
      const out = await observeAndDriveChain(
        "run-pg",
        baseDeps("run-pg", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out.kind).toBe("driven");
      expect((out as { markerOk?: boolean }).markerOk).toBeUndefined(); // no caller of this entry read a marker
      expect(driver.markerTicks).toBe(0); // the poll never started
      expect(driver.calls.filter((c) => c.argv[0] === "systemctl").length).toBe(0);
      const rec = s.store.get("run-pg");
      expect(rec.extensions?.approval?.state).toBe("awaiting-approval"); // PROMOTED, not re-registered
      expect(rec.closedAt).toBeTruthy(); // the promote tail's idempotent teardown closed it
      expect(driver.destroyed).toEqual([vmName]); // the box is gone
      expect(lines.some((l) => l.event === "pause-promoted" && l.kind === "driven")).toBe(true);
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 180_000);

  test("a stranded pause whose extension moves mid-flight → handed-off{pause-in-progress} (the resume arm's non-match)", async () => {
    // Unlike the driven test above, the promote entry ALWAYS re-presents the
    // stored reportId (reverify reads `bound.reportId`), so a static stranger
    // id would simply resume-and-promote. The collision this test stands in
    // for — another actor's pause landing between reverify's bound read and
    // the gate's startup read — needs the read-count overlay: reads 1-4 stay
    // clean (the observe pre-flight, the promote entry's re-read, reverify's
    // preflight and its bound read — which re-presents R1), and read 5, the
    // gate's startup read, sees the stranger's binding.
    class MidflightPauseStore extends RunRecordStore {
      changeAtRead = Number.POSITIVE_INFINITY;
      #reads = 0;
      #replacement: ExtensionEntry | null = null;
      constructor(dir: string, replacement: ExtensionEntry) {
        super({ dir });
        this.#replacement = replacement;
      }
      override get(runId: string): ReturnType<RunRecordStore["get"]> {
        const r = super.get(runId);
        if (runId === "run-pg2") {
          this.#reads += 1;
          if (this.#replacement !== null && this.#reads >= this.changeAtRead) {
            return { ...r, extensions: { ...r.extensions, approval: this.#replacement } } as ReturnType<
              RunRecordStore["get"]
            >;
          }
        }
        return r;
      }
    }
    const s = store();
    const host = gitHost();
    try {
      const { driver, head } = await seedPromotablePause(s, host, "run-pg2");
      const overlayStore = new MidflightPauseStore(s.dir, approvalExt("pausing", "rv-someone-else", head));
      overlayStore.changeAtRead = 5;
      const out = await observeAndDriveChain(
        "run-pg2",
        baseDeps("run-pg2", { driver, store: overlayStore, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "handed-off", outcome: "pause-in-progress" });
      expect(driver.markerTicks).toBe(0); // the poll never started here either
      expect(s.store.get("run-pg2").extensions?.approval?.state).toBe("pausing"); // nothing moved it on disk
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 180_000);
});

// ─── the veto arms' remaining half (O13) ────────────────────────────────────

describe("veto arms (O13): a genuine RED, and the flag-less approval-null string", () => {
  test("module source pins the flag-less approval-null diagnosis string (O13)", async () => {
    const src = await moduleSource();
    expect(src).toContain("approval null without flag");
  });

  test("a genuinely RED re-verify → vetoed naming the re-verifier's own reason (not the marker's, not a missing report)", async () => {
    quietLogs();
    const s = store();
    const host = gitHost();
    try {
      const driver = new ProbeDriver(path.join(s.dir, "boxes"));
      const rec = await createRun(driver, s.store, { runId: "run-red1", recordAuditLink: () => {} });
      s.store.set("run-red1", {
        commitSha: host.baseSha,
        requestId: "req-df37",
        extensions: { budget: { repoSlug: "acme/widget", issueId: "7" } },
      } as never);
      // The box has no git (harvest answers NOREPO; teardown still completes)
      // and the HOST-quarantined ref carries work whose own test FAILS. The
      // marker's ok:true is irrelevant (AC2c) — the re-verifier's verdict
      // alone decides, and it is red.
      quarantineRed(host, "run-red1");
      driver.plan = [{ body: { runId: "run-red1", ok: true } }];
      const out = await observeAndDriveChain(
        "run-red1",
        baseDeps("run-red1", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
      );
      expect(out).toMatchObject({ kind: "vetoed", reason: "tests-failed" });
      expect(s.store.get("run-red1").closedAt).toBeTruthy(); // the chain landed first
      expect(driver.destroyed).toEqual([rec.vmName!]);
    } finally {
      host.cleanup();
      s.cleanup();
    }
  }, 60_000);
});
