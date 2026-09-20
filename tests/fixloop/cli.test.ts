/**
 * DF6.1a leaf-6 — the fix-run CLI suite (ledger G1-G3).
 *
 * In-process `run()` from scripts/fix-run.ts with every seam injected: fakeGitHub
 * (tests/pr/helpers.ts), a FakeDriver subclass answering the INV-3 probe cans,
 * a real RunRecordStore on a per-test mkdtemp host, scripted dispatch/startRun/
 * observeChain/push/preflight/exec seams. No box, no network, no real timers.
 *
 * G1 legs: closed/merged PR ⇒ exit 0; 404 / no record / wrong head branch ⇒
 * exit 5 not-a-factory-pr; zero bot comments ⇒ exit 0; all comment IDs already
 * recorded ⇒ exit 0, no dispatch; the dispatch-time writes (fixRun="true" on
 * the attempt's record + fixAttemptRunIds append on the parent) land BEFORE the
 * chain runs.
 *
 * G2 legs: driven ⇒ exit 0 `state:"awaiting-approval"`, the run lock is HELD
 * during the chain and RELEASED at exit, and a never-deciding approval does not
 * hang the invocation (no approval polling inside invocation 1).
 *
 * G3 legs: approval-binding mismatch legs (reportId, headSha, approval gone at
 * the in-lock re-read); out-of-scope-diff / scope-requires-privilege / delete
 * action / unparseable diff — push never called, no fixContext, the
 * fix-attempt-refused log carries flags; pushVerifiedSha {ok:false} ⇒ exit 5,
 * no fixContext; {ok:true,pushed:false} resume ⇒ fixContext written; the
 * ordinary append writes attemptSha off the PushOutcome; preflight failure ⇒
 * nothing pushed (INV-7); the diff base is the record's PINNED commitSha; the
 * invocation-2 comment identity is a FRESH fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildFixContextPayload,
  encodeFixContext,
  parseFixContext,
  preflightFixContextWrite,
  APPROVED_ENV_FILE,
} from "../../src/fixloop/index.ts";
import type { DispatchDeps, DispatchResult } from "../../src/fleet/dispatch.ts";
import type { ChainOutcome, RunCompletionDeps } from "../../src/fleet/run-completion.ts";
import type { StartRunResult } from "../../src/fleet/run.ts";
import { DEFAULT_COST_CONFIG, CostLedger } from "../../src/providers/cost-ledger.ts";
import type { ExecResult } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore, type RunRecord } from "../../src/providers/run-record.ts";
import type { PrReviewComment, PullRequestInfo } from "../../src/pr/github.ts";
import type { PushOutcome } from "../../src/pr/push.ts";
import { appendReport, sealReport, type ReverifyEvidence, type ReverifyReport } from "../../src/reverify/report.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, RunLockReentrantError } from "../../scripts/lib/run-lock.ts";
import { fakeGitHub, type FakeGitHub } from "../pr/helpers.ts";
import { run, type FixRunDeps, type FixRunPushOpts } from "../../scripts/fix-run.ts";

const SLUG = "acme/widgets";
const REMOTE = "https://github.com/acme/widgets.git";
const PR = 7;
const PARENT = "qds-20260919-parent1";
const FIX = "qds-20260919-fix0001";
const OLD = "qds-20260919-old0001";
const PINNED = "a".repeat(40); // the PR head the attempt started from
const FIX_HEAD = "b".repeat(40); // the approved re-verified fix head
const PUSH_SHA = "c".repeat(40); // what the push seam reports publishing
const TOKEN = "tok-fix-run";
const DIGEST = "d".repeat(64);

const COMMENTS: PrReviewComment[] = [
  { id: 9001, body: "please handle the null case", authorLogin: "qds-review", authorType: "Bot" },
  { id: 9002, body: "add a regression test", authorLogin: "qds-review", authorType: "Bot" },
];

// ─── host scaffolding ─────────────────────────────────────────────────────────

interface Host {
  root: string;
  runsDir: string;
  reverifyDir: string;
  store: RunRecordStore;
  rosterPath: string;
}

const SCOPE_DOC = {
  schemaVersion: 1,
  scopes: {
    [SLUG]: {
      allowedPathGlobs: ["src/**", "tests/**", "scripts/**"],
      deniedPathGlobs: [{ glob: "scripts/reverify.ts", reason: "verification surface — the re-verifier judges this fix" }],
      permittedActions: ["modify", "add"],
    },
  },
};

const ROSTER_SINGLE = `defaults:
  provider: openrouter
  thinking: low
  tools: null
  writes: []
  harness_engineering: []

roles:
  - name: lead
    model: anthropic/claude-haiku-4.5
  - name: fixer
    model: deepseek/deepseek-v3.2
    writes: ["src/"]
`;

const ROSTER_TWO_WRITE_CAPABLE = ROSTER_SINGLE.replace(
  '    writes: ["src/"]',
  '    writes: ["src/"]\n  - name: fixer-2\n    model: deepseek/deepseek-v3.2\n    writes: ["tests/"]',
);

const ROSTER_TWO_NULL = `defaults:
  provider: openrouter
  thinking: low
  tools: null
  writes: []
  harness_engineering: []

roles:
  - name: lead
    model: anthropic/claude-haiku-4.5
  - name: fixer
    model: deepseek/deepseek-v3.2
    writes: null
  - name: fixer-2
    model: deepseek/deepseek-v3.2
    writes: null
`;

const scratchDirs: string[] = [];
afterEach(() => {
  for (const d of scratchDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeHost(opts: { scope?: boolean; roster?: string } = {}): Host {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-fixrun-cli-"));
  scratchDirs.push(root);
  const factory = path.join(root, ".factory");
  fs.mkdirSync(factory, { recursive: true });
  const repos = path.join(factory, "repos.json");
  fs.writeFileSync(
    repos,
    JSON.stringify({ version: 1, repos: { [SLUG]: { remote: REMOTE, baseBranch: "main", authorLogin: "acme-bot" } } }),
  );
  fs.chmodSync(repos, 0o600);
  if (opts.scope !== false) {
    const scope = path.join(factory, "fix-scope.json");
    fs.writeFileSync(scope, JSON.stringify(SCOPE_DOC));
    fs.chmodSync(scope, 0o600);
  }
  const rosterPath = path.join(root, "roster.yaml");
  fs.writeFileSync(rosterPath, opts.roster ?? ROSTER_SINGLE);
  const runsDir = path.join(root, "runs");
  const store = new RunRecordStore({ dir: runsDir });
  return { root, runsDir, reverifyDir: path.join(root, "reverify"), store, rosterPath };
}

/** The parent run: budget identity + the PR correlation the CLI joins on. */
function writeParent(store: RunRecordStore, opts: { fixAttemptRunIds?: string[]; spendMicroUsd?: number } = {}): void {
  store.create(PARENT);
  store.set(PARENT, {
    commitSha: PINNED,
    requestId: "req-parent",
    extensions: {
      budget: { repoSlug: SLUG, issueId: "42" },
      pr: { prUrl: `https://github.com/${SLUG}/pull/${PR}`, prNumber: PR, createdAt: "2026-09-19T00:00:00.000Z" },
      ...(opts.fixAttemptRunIds === undefined ? {} : { fixLoop: { fixAttemptRunIds: opts.fixAttemptRunIds } }),
    },
  });
  if (opts.spendMicroUsd !== undefined) store.set(PARENT, { spendMicroUsd: opts.spendMicroUsd });
}

function openPr(github: FakeGitHub, over: Partial<PullRequestInfo> = {}): void {
  github.pullRequests[PR] = { number: PR, state: "open", headRefName: `qds/${PARENT}`, headSha: PINNED, merged: false, ...over };
  github.reviewComments[PR] = [...COMMENTS];
}

/** A recorded attempt whose fixContext carries `commentIds` (the dedup carrier). */
function writeRecordedAttempt(store: RunRecordStore, runId: string, commentIds: string[]): void {
  store.create(runId);
  const fixContext = encodeFixContext(
    buildFixContextPayload({
      prNumber: PR,
      prBranch: `qds/${PARENT}`,
      commentIds,
      omittedCommentIds: [],
      omittedCount: 0,
      commentsDigest: DIGEST,
      attemptSha: PUSH_SHA,
      pollWindowOpenedAt: "2026-09-19T01:00:00.000Z",
    }),
  );
  store.set(runId, { commitSha: PINNED, extensions: { fixLoop: { fixContext } } });
  store.close(runId);
}

/** A green re-verify report for `runId` at `headSha`. */
function writeReport(reverifyDir: string, runId: string, headSha: string, reverifyId = `rv-${runId}-1`): ReverifyReport {
  const evidence: ReverifyEvidence = {
    reverifyId,
    runId,
    requestId: "req-fix",
    headSha,
    baseSha: PINNED,
    startedAt: "2026-09-19T09:59:00.000Z",
    completedAt: "2026-09-19T10:00:00.000Z",
    durationMs: 60_000,
    checks: [
      { item: "install", ok: true, note: "exit 0" },
      { item: "tests: bun test", ok: true, note: "exit 0, 7 pass, 0 fail" },
    ],
    testResults: { passed: 7, failed: 0 },
    flags: [],
    discrepancies: [],
    claimed: null,
    toolchain: { git: "2.44.0", bun: "1.2.0" },
    timings: { worktree_ms: 1, install_ms: 1, tests_ms: 1, gates_ms: 1, cleanup_ms: 1 },
  };
  const report = sealReport(evidence, {});
  appendReport(reverifyDir, report);
  return report;
}

/** The fix run record as invocation 1's chain leaves it: closed, awaiting/approved per opts. */
function writeFixRecord(
  store: RunRecordStore,
  reverifyDir: string,
  opts: { approval?: "approved-bound" | "approved-stale-report" | "approved-stale-sha" | "awaiting" | "absent" } = {},
): void {
  store.create(FIX);
  store.set(FIX, {
    commitSha: PINNED,
    requestId: "req-fix",
    extensions: { fixLoop: { fixRun: "true" } },
  });
  store.close(FIX);
  const kind = opts.approval ?? "approved-bound";
  if (kind === "absent") return;
  if (kind === "awaiting") {
    store.set(FIX, { extensions: { approval: { state: "awaiting-approval", reportId: `rv-${FIX}-1`, headSha: FIX_HEAD } } });
    return;
  }
  // The bound report is the LATEST on disk for the "approved-bound" leg; the
  // stale legs bind to values that are not the latest report's.
  writeReport(reverifyDir, FIX, FIX_HEAD);
  const reportId = kind === "approved-stale-report" ? "rv-somebody-else" : `rv-${FIX}-1`;
  const headSha = kind === "approved-stale-sha" ? "e".repeat(40) : FIX_HEAD;
  store.set(FIX, {
    extensions: {
      approval: {
        state: "approved",
        proposal: `append a verified fix commit to the PR branch (fix run ${FIX} at ${FIX_HEAD})`,
        reportId,
        headSha,
        requestedAt: "2026-09-19T10:00:00.000Z",
        approverId: "steve",
        decidedAt: "2026-09-19T10:00:01.000Z",
      },
    },
  });
}

// ─── the probe driver (FixProbeDriver idiom from feedback-run.test.ts) ────────

const CLEAN_UNIT = [
  "[Service]",
  "Type=simple",
  "User=exedev",
  `EnvironmentFile=${APPROVED_ENV_FILE}`,
  "Environment=QDS_RUN_ID=%i",
  "",
].join("\n");

class ProbeDriver extends FakeDriver {
  calls: string[][] = [];
  destroyed: string[] = [];
  /** When set, `cat .env` answers with it — the plant leg. */
  envFileText = "QDS_API_KEY=minted-capped-key-hash\n";

  override async exec(_vm: string, argv: string[]): Promise<ExecResult> {
    return this.intercept(argv);
  }

  override async execTimed(_vm: string, argv: string[], _timeoutMs: number): Promise<ExecResult> {
    return this.intercept(argv);
  }

  override async destroy(vm: string): Promise<void> {
    this.destroyed.push(vm);
  }

  private intercept(argv: string[]): ExecResult {
    this.calls.push(argv);
    if (argv[0] === "systemctl" && argv[1] === "cat") return { stdout: CLEAN_UNIT, stderr: "", exitCode: 0 };
    if (argv[0] === "cat" && argv[1] === APPROVED_ENV_FILE) return { stdout: this.envFileText, stderr: "", exitCode: 0 };
    if (argv.includes("git") && argv.includes("config")) return { stdout: "", stderr: "", exitCode: 1 };
    if (argv.includes("sh") && argv.includes("-c")) return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "unexpected argv", exitCode: 255 };
  }
}

// ─── sinks, seams, and the runner ─────────────────────────────────────────────

let logs: LogEntry[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
  logs = [];
  restoreSink = setLogSink((e) => logs.push(e));
});
afterEach(() => {
  restoreSink?.();
  restoreSink = undefined;
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  outLines: Record<string, unknown>[];
  errLines: Record<string, unknown>[];
}

interface Seams {
  dispatchCalls: { brief: unknown; deps: DispatchDeps }[];
  startRunCalls: string[];
  chainCalls: { runId: string; deps: RunCompletionDeps }[];
  pushCalls: { runId: string; opts: FixRunPushOpts }[];
  preflighted: string[];
  execCalls: string[][];
  auditLinks: unknown[];
  dispatchResult: DispatchResult;
  chainOutcome: ChainOutcome;
  pushOutcome: PushOutcome;
  execResult: ExecResult;
  /** When set, the chain fake stamps this approval state on the fix record. */
  chainApprovalState?: string;
  /** When true, the chain fake asserts the run lock is HELD during the call. */
  assertLockHeld: boolean;
}

async function runCli(
  argv: string[],
  host: Host,
  github: FakeGitHub,
  driver: ProbeDriver,
  over: Partial<Seams> = {},
  depsOver: Partial<FixRunDeps> = {},
): Promise<{ result: Captured; seams: Seams }> {
  const seams: Seams = {
    dispatchCalls: [],
    startRunCalls: [],
    chainCalls: [],
    pushCalls: [],
    preflighted: [],
    execCalls: [],
    auditLinks: [],
    dispatchResult: { runId: FIX, requestId: "req-fix", state: "ready", vmName: `vm-${FIX}` },
    chainOutcome: { kind: "driven", chainMs: 5 },
    pushOutcome: { ok: true, sha: PUSH_SHA, targetRef: `refs/heads/qds/${PARENT}`, pushed: true },
    execResult: { exitCode: 0, stdout: "M\tsrc/a.ts\n", stderr: "" },
    assertLockHeld: true,
    ...over,
  };
  const costLedger = new CostLedger({ path: path.join(host.root, "cost.db"), config: DEFAULT_COST_CONFIG });
  const deps: FixRunDeps = {
    github,
    token: async () => TOKEN,
    driver,
    store: host.store,
    hostRoot: host.root,
    reverifyDir: host.reverifyDir,
    rosterPath: host.rosterPath,
    costLedger,
    ledger: { issueBudgetSnapshot: () => ({ ceilingMicroUsd: Number.MAX_SAFE_INTEGER, spentMicroUsd: 0, reservedMicroUsd: 0 }) },
    recordAuditLink: (link) => seams.auditLinks.push(link),
    dispatch: async (brief, ddeps) => {
      seams.dispatchCalls.push({ brief, deps: ddeps });
      ddeps.store.create(seams.dispatchResult.runId);
      ddeps.store.set(seams.dispatchResult.runId, {
        vmName: seams.dispatchResult.vmName,
        commitSha: PINNED,
        requestId: ddeps.requestId,
      });
      return seams.dispatchResult;
    },
    startRun: async (_d, runId) => {
      seams.startRunCalls.push(runId);
      const started: StartRunResult = { outcome: "started", vm: `vm-${runId}`, unit: `qds-run@${runId}.service` };
      return started;
    },
    observeChain: async (runId, cdeps) => {
      if (seams.assertLockHeld) {
        // The caller holds <runsDir>/<runId>.lock while the chain runs: a
        // re-acquire in this process must refuse (re-entrant same-process).
        let held = false;
        try {
          acquireRunLock(cdeps.runsDir, runId, "probe");
        } catch (e) {
          held = e instanceof RunLockedError || e instanceof RunLockReentrantError;
        }
        if (!held) throw new Error("observeChain ran WITHOUT the caller holding the run lock");
      }
      seams.chainCalls.push({ runId, deps: cdeps });
      if (seams.chainApprovalState !== undefined) {
        cdeps.store.set(runId, { extensions: { approval: { state: seams.chainApprovalState } } });
      }
      return seams.chainOutcome;
    },
    push: async (runId, opts) => {
      seams.pushCalls.push({ runId, opts });
      return seams.pushOutcome;
    },
    preflight: (encoded) => {
      seams.preflighted.push(encoded);
      preflightFixContextWrite(encoded); // the REAL validate-only route
    },
    exec: async (argv) => {
      seams.execCalls.push([...argv]);
      return seams.execResult;
    },
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    ...depsOver,
  };
  let stdout = "";
  let stderr = "";
  const code = await run(
    argv,
    (s) => {
      stdout += s;
    },
    (s) => {
      stderr += s;
    },
    deps,
  );
  try {
    costLedger.close();
  } catch {
    // Already closed by a test leg; closing twice is the test's own cleanup.
  }
  const parse = (text: string): Record<string, unknown>[] =>
    text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { result: { code, stdout, stderr, outLines: parse(stdout), errLines: parse(stderr) }, seams };
}

function baseDepsArgv(): string[] {
  return ["--pr", String(PR)];
}

const attemptLines = (): LogEntry[] => logs.filter((l) => l.operation === "fix-run.attempt" && l.exitCode !== undefined);
const eventLines = (event: string): LogEntry[] => logs.filter((l) => l.event === event);

// ─── G1: intake and routing ───────────────────────────────────────────────────

describe("G1 intake/routing", () => {
  test("closed PR ⇒ exit 0 no-op, no dispatch, no box", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github, { state: "closed", merged: false });
    const driver = new ProbeDriver();
    const { result, seams } = await runCli(baseDepsArgv(), host, github, driver);
    expect(result.code).toBe(0);
    expect(result.outLines[0]).toMatchObject({ state: "no-op", reason: "closed-or-merged", prNumber: PR });
    expect(seams.dispatchCalls).toEqual([]);
    expect(driver.calls).toEqual([]);
  });

  test("merged PR ⇒ exit 0 no-op", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github, { state: "closed", merged: true });
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(0);
    expect(result.outLines[0]).toMatchObject({ state: "no-op", reason: "closed-or-merged" });
    expect(seams.dispatchCalls).toEqual([]);
  });

  test("PR unknown to GitHub (404) ⇒ exit 5 not-a-factory-pr", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub(); // no pullRequests entry ⇒ null
    const { result } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "not-a-factory-pr" });
  });

  test("no run record names the PR ⇒ exit 5 not-a-factory-pr", async () => {
    const host = makeHost();
    const github = fakeGitHub();
    openPr(github);
    const { result } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "not-a-factory-pr" });
  });

  test("head branch not qds/<runId> ⇒ exit 5 not-a-factory-pr", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github, { headRefName: "feature/hand-made" });
    const { result } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "not-a-factory-pr" });
  });

  test("zero bot comments ⇒ exit 0, no dispatch", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    github.reviewComments[PR] = [{ id: 1, body: "LGTM", authorLogin: "steve", authorType: "User" }];
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(0);
    expect(result.outLines[0]).toMatchObject({ state: "no-op", reason: "no-bot-comments" });
    expect(seams.dispatchCalls).toEqual([]);
  });

  test("all comment IDs already recorded ⇒ exit 0 already-recorded, no dispatch", async () => {
    const host = makeHost();
    writeParent(host.store, { fixAttemptRunIds: [OLD] });
    writeRecordedAttempt(host.store, OLD, ["9001", "9002"]);
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(0);
    expect(result.outLines[0]).toMatchObject({ state: "no-op", reason: "already-recorded" });
    expect(seams.dispatchCalls).toEqual([]);
  });

  test("a partially-recorded comment set dispatches (dedup is all-or-nothing)", async () => {
    const host = makeHost();
    writeParent(host.store, { fixAttemptRunIds: [OLD] });
    writeRecordedAttempt(host.store, OLD, ["9001"]); // 9002 is NEW
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), { chainApprovalState: "awaiting-approval" });
    expect(result.code).toBe(0);
    expect(seams.dispatchCalls.length).toBe(1);
  });

  test("the dispatch-time writes land BEFORE the chain runs (fixRun marker + parent ledger append)", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const driver = new ProbeDriver();
    const { result, seams } = await runCli(baseDepsArgv(), host, github, driver, {
      chainApprovalState: "awaiting-approval",
    });
    expect(result.code).toBe(0);
    // Asserted FROM INSIDE the chain fake's predecessor — re-assert against the
    // store now: the marker and the append survive the invocation.
    expect(seams.chainCalls.length).toBe(1);
    expect(host.store.get(FIX).extensions?.fixLoop?.fixRun).toBe("true");
    expect(host.store.get(PARENT).extensions?.fixLoop?.fixAttemptRunIds).toEqual([FIX]);
    // And the brief is the fix brief: pinned to the PR head, the fix manifest.
    const brief = seams.dispatchCalls[0]!.brief as { manifestPath?: string; commitSha?: string; fixContext?: { botComments?: unknown[] } };
    expect(brief.manifestPath).toBe("config/rosters/fix-run.pipeline.json");
    expect(brief.commitSha).toBe(PINNED);
    expect(brief.fixContext?.botComments?.length).toBe(2);
  });

  test("chain-time observation proves the writes preceded the chain", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const observed: { fixRun: unknown; ledger: unknown }[] = [];
    const { result } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), { chainApprovalState: "awaiting-approval" }, {
      observeChain: async (runId, cdeps) => {
        observed.push({
          fixRun: cdeps.store.get(runId).extensions?.fixLoop?.fixRun,
          ledger: cdeps.store.get(PARENT).extensions?.fixLoop?.fixAttemptRunIds,
        });
        cdeps.store.set(runId, { extensions: { approval: { state: "awaiting-approval" } } });
        return { kind: "driven", chainMs: 1 };
      },
    });
    expect(result.code).toBe(0);
    expect(observed).toEqual([{ fixRun: "true", ledger: [FIX] }]);
  });

  test("two write-capable roles ⇒ exit 5 fix-roster-not-single-fixer, nothing dispatched", async () => {
    const host = makeHost({ roster: ROSTER_TWO_WRITE_CAPABLE });
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "fix-roster-not-single-fixer" });
    expect(seams.dispatchCalls).toEqual([]);
    expect(eventLines("fix-attempt-refused")[0]).toMatchObject({ flags: ["fix-roster-not-single-fixer"] });
  });

  test("two writes:null roles ⇒ exit 5 (null is UNRESTRICTED writes)", async () => {
    const host = makeHost({ roster: ROSTER_TWO_NULL });
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "fix-roster-not-single-fixer" });
    expect(seams.dispatchCalls).toEqual([]);
  });

  test("missing fix scope ⇒ exit 5 fix-scope-missing BEFORE any dispatch", async () => {
    const host = makeHost({ scope: false });
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "fix-scope-missing" });
    expect(seams.dispatchCalls).toEqual([]);
  });

  test("an insufficient issue ceiling ⇒ exit 5 fix-ceiling-insufficient, nothing dispatched", async () => {
    const host = makeHost();
    writeParent(host.store, { spendMicroUsd: 500_000 });
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {}, {
      ledger: { issueBudgetSnapshot: () => ({ ceilingMicroUsd: 1, spentMicroUsd: 0, reservedMicroUsd: 0 }) },
    });
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "fix-ceiling-insufficient" });
    expect(seams.dispatchCalls).toEqual([]);
  });

  test("credential probe hit ⇒ box destroyed, no engine start, exit 5 credential-probe-hit", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const driver = new ProbeDriver();
    driver.envFileText = "QDS_API_KEY=x\nGH_TOKEN=gho_planted\n";
    const { result, seams } = await runCli(baseDepsArgv(), host, github, driver);
    expect(result.code).toBe(5);
    expect(result.errLines.some((l) => l.code === "credential-probe-hit")).toBe(true);
    expect(driver.destroyed).toEqual([`vm-${FIX}`]);
    expect(seams.startRunCalls).toEqual([]);
    expect(seams.chainCalls).toEqual([]);
    // The dispatch-time writes survive the aborted attempt (C21).
    expect(host.store.get(FIX).extensions?.fixLoop?.fixRun).toBe("true");
    expect(host.store.get(PARENT).extensions?.fixLoop?.fixAttemptRunIds).toEqual([FIX]);
  });

  test("a held run lock ⇒ exit 5 lock-refused, chain never called", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    // A foreign holder: a lock file naming a LIVE pid this process does not
    // hold reads as stale-or-busy contention — either flavor is RunLockedError.
    fs.writeFileSync(path.join(host.runsDir, `${FIX}.lock`), `${process.pid} testhost 2026-09-19T00:00:00.000Z deadbeef\n`);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), { assertLockHeld: false });
    expect(result.code).toBe(5);
    expect(result.errLines.some((l) => l.code === "lock-refused")).toBe(true);
    expect(seams.chainCalls).toEqual([]);
  });

  test("usage: no --pr, unknown flag, non-numeric --pr ⇒ exit 2", async () => {
    const host = makeHost();
    const github = fakeGitHub();
    expect((await runCli([], host, github, new ProbeDriver())).result.code).toBe(2);
    expect((await runCli(["--bogus"], host, github, new ProbeDriver())).result.code).toBe(2);
    expect((await runCli(["--pr", "abc"], host, github, new ProbeDriver())).result.code).toBe(2);
  });

  test("--cap-micro-usd flows into the dispatch cap; bad values and raises ⇒ exit 2", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli([...baseDepsArgv(), "--cap-micro-usd", "50000"], host, github, new ProbeDriver(), {
      chainApprovalState: "awaiting-approval",
    });
    expect(result.code).toBe(0);
    expect(seams.dispatchCalls.length).toBe(1);
    expect(seams.dispatchCalls[0]!.deps.capMicroUsd).toBe(50_000);

    expect((await runCli([...baseDepsArgv(), "--cap-micro-usd", "0"], host, github, new ProbeDriver())).result.code).toBe(2);
    expect((await runCli([...baseDepsArgv(), "--cap-micro-usd", "abc"], host, github, new ProbeDriver())).result.code).toBe(2);
    expect((await runCli([...baseDepsArgv(), "--cap-micro-usd", "999999999999"], host, github, new ProbeDriver())).result.code).toBe(2);
  });
});

// ─── G2: no residency across the gate ─────────────────────────────────────────

describe("G2 no-residency", () => {
  test("driven ⇒ exit 0 awaiting-approval, lock HELD during the chain and RELEASED at exit", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {
      chainApprovalState: "awaiting-approval",
    });
    expect(result.code).toBe(0);
    expect(result.outLines[0]).toMatchObject({ state: "awaiting-approval", runId: FIX, prNumber: PR, attempt: 1 });
    // The chain ran under the caller-held lock (asserted inside the fake), and
    // the lock is free afterwards: a concurrent harvest/teardown acquires it.
    expect(seams.chainCalls.length).toBe(1);
    const handle = acquireRunLock(host.runsDir, FIX, "test-aftermath");
    releaseRunLock(handle);
  });

  test("a never-deciding approval does not hang invocation 1 (no approval polling)", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    // The chain registers the approval request and returns; the approval NEVER
    // advances. An implementation that polls for the decision inside this
    // invocation hangs here and the race resolves to -1.
    const raced = await Promise.race([
      runCli(baseDepsArgv(), host, github, new ProbeDriver(), { chainApprovalState: "awaiting-approval" }).then((r) => r.result.code),
      Bun.sleep(2_000).then(() => -1),
    ]);
    expect(raced).toBe(0);
  });

  test("the attempt line carries fix_run_ms and NOT push_ms on the invocation-1 path", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const { result } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), { chainApprovalState: "awaiting-approval" });
    expect(result.code).toBe(0);
    const line = attemptLines().at(-1)!;
    expect(line).toMatchObject({ prNumber: PR, attempt: 1, runId: FIX, exitStatus: "success" });
    expect(typeof line.fix_run_ms).toBe("number");
    expect(line).not.toHaveProperty("push_ms");
    expect(line).not.toHaveProperty("harvest_ms");
    expect(line).not.toHaveProperty("reverify_ms");
  });

  test("an unsettled chain ⇒ exit 1, lock released", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const { result } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {
      chainOutcome: { kind: "unsettled", verdict: { state: "no-marker" } as never },
    });
    expect(result.code).toBe(1);
    const handle = acquireRunLock(host.runsDir, FIX, "test-aftermath");
    releaseRunLock(handle);
  });

  test("a chain refusal ⇒ exit 5; a vetoed chain ⇒ exit 6", async () => {
    const host = makeHost();
    writeParent(host.store);
    const github = fakeGitHub();
    openPr(github);
    const refused = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {
      chainOutcome: { kind: "refused", code: "record-names-no-box", message: "m", remediation: "r" },
    });
    expect(refused.result.code).toBe(5);
    expect(refused.result.errLines[0]).toMatchObject({ code: "record-names-no-box" });

    const host2 = makeHost();
    writeParent(host2.store);
    const github2 = fakeGitHub();
    openPr(github2);
    const vetoed = await runCli(baseDepsArgv(), host2, github2, new ProbeDriver(), {
      chainOutcome: { kind: "vetoed", reason: "tests red" },
    });
    expect(vetoed.result.code).toBe(6);
  });
});

// ─── G3: the push leg (invocation 2) ──────────────────────────────────────────

function inv2Host(opts: { approval?: "approved-bound" | "approved-stale-report" | "approved-stale-sha" | "awaiting" | "absent" } = {}): Host {
  const host = makeHost();
  writeParent(host.store, { fixAttemptRunIds: [FIX] });
  writeFixRecord(host.store, host.reverifyDir, opts);
  return host;
}

describe("G3 push leg", () => {
  test("approved and bound ⇒ append: exact pinned diff argv, push target, one fixContext write, exit 0", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(0);
    expect(result.outLines[0]).toMatchObject({ state: "appended", runId: FIX, prNumber: PR, attempt: 1, attemptSha: PUSH_SHA });

    // The diff is computed against the record's PINNED commitSha — never the
    // default branch (the wrong-diff-base mutant fails this exact argv).
    expect(seams.execCalls).toEqual([["git", "diff", "--name-status", `${PINNED}..${FIX_HEAD}`]]);

    // The push: the fix RUN's id, the PR branch ref.
    expect(seams.pushCalls.length).toBe(1);
    expect(seams.pushCalls[0]!.runId).toBe(FIX);
    expect(seams.pushCalls[0]!.opts.targetRef).toBe(`refs/heads/qds/${PARENT}`);

    // INV-7: the preflight ran BEFORE the push, over the placeholder encoding.
    expect(seams.preflighted.length).toBe(1);
    const pre = parseFixContext(seams.preflighted[0]!);
    expect(pre.attemptSha).toBe("0".repeat(40));
    expect(pre.pollWindowOpenedAt).toBe("1970-01-01T00:00:00.000Z");

    // The post-push write differs from the pre-flighted encoding in EXACTLY the
    // two placeholder fields (AC4).
    const written = host.store.get(FIX).extensions?.fixLoop?.fixContext;
    expect(typeof written).toBe("string");
    const post = parseFixContext(written);
    expect(post.attemptSha).toBe(PUSH_SHA);
    expect(post.pollWindowOpenedAt).toBe("2026-09-20T12:00:00.000Z");
    const diffKeys = (Object.keys(post) as (keyof typeof post)[]).filter((k) => JSON.stringify(post[k]) !== JSON.stringify(pre[k]));
    expect(diffKeys.sort()).toEqual(["attemptSha", "pollWindowOpenedAt"]);
    expect(post.commentIds).toEqual(["9001", "9002"]);
    expect(post.commentsDigest).toMatch(/^[0-9a-f]{64}$/);

    // The appended event names the published sha.
    expect(eventLines("fix-attempt-appended")[0]).toMatchObject({ runId: FIX, prNumber: PR, attempt: 1, attemptSha: PUSH_SHA });
    // The attempt line carries push_ms and NOT fix_run_ms on this path.
    const line = attemptLines().at(-1)!;
    expect(typeof line.push_ms).toBe("number");
    expect(line).not.toHaveProperty("fix_run_ms");
    // The lock is released at exit.
    const handle = acquireRunLock(host.runsDir, FIX, "test-aftermath");
    releaseRunLock(handle);
  });

  test("the invocation-2 comment identity is a FRESH fetch (a comment that arrived during the approval wait is carried)", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    github.reviewComments[PR] = [
      ...COMMENTS,
      { id: 9003, body: "one more thing", authorLogin: "qds-review", authorType: "Bot" },
    ];
    const { result } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(0);
    const written = parseFixContext(host.store.get(FIX).extensions?.fixLoop?.fixContext);
    expect(written.commentIds).toEqual(["9001", "9002", "9003"]);
  });

  test("approval bound to a different reportId ⇒ exit 5, nothing pushed, no fixContext", async () => {
    const host = inv2Host({ approval: "approved-stale-report" });
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "approval-binding-mismatch" });
    expect(seams.pushCalls).toEqual([]);
    expect(host.store.get(FIX).extensions?.fixLoop?.fixContext).toBeUndefined();
    expect(eventLines("fix-attempt-refused")[0]).toMatchObject({ flags: ["approval-binding-mismatch"] });
  });

  test("approval bound to a different headSha ⇒ exit 5, nothing pushed", async () => {
    const host = inv2Host({ approval: "approved-stale-sha" });
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "approval-binding-mismatch" });
    expect(seams.pushCalls).toEqual([]);
  });

  test("the approval gone at the in-lock re-read ⇒ exit 5, nothing pushed", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    // Routing reads the fix record twice before invocation 2's own fresh read
    // (the dedup walk, then the routing read); strip the approval from the
    // third read on — the bind-time read must not trust the routing copy.
    let fixGets = 0;
    const real = host.store;
    const proxied = new Proxy(real, {
      get(target, prop) {
        const orig = Reflect.get(target, prop, target);
        if (prop !== "get") return typeof orig === "function" ? orig.bind(target) : orig;
        return (id: string): RunRecord => {
          const rec = (orig as (x: string) => RunRecord).call(target, id);
          if (id === FIX) {
            fixGets += 1;
            if (fixGets >= 3) {
              const { approval: _approvalGone, ...extensions } = rec.extensions ?? {};
              return { ...rec, extensions };
            }
          }
          return rec;
        };
      },
    });
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {}, { store: proxied });
    expect(fixGets).toBeGreaterThanOrEqual(3);
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "approval-binding-mismatch" });
    expect(seams.pushCalls).toEqual([]);
  });

  test("an awaiting-approval latest attempt ⇒ exit 0 approval-pending, no dispatch, no push", async () => {
    const host = inv2Host({ approval: "awaiting" });
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver());
    expect(result.code).toBe(0);
    expect(result.outLines[0]).toMatchObject({ state: "no-op", reason: "approval-pending", runId: FIX });
    expect(seams.dispatchCalls).toEqual([]);
    expect(seams.pushCalls).toEqual([]);
  });

  test("out-of-scope diff ⇒ exit 5, push never called, fix-attempt-refused with flags + paths, no fixContext", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {
      execResult: { exitCode: 0, stdout: "M\tsrc/a.ts\nM\tREADME.md\n", stderr: "" },
    });
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "out-of-scope-diff" });
    expect(seams.pushCalls).toEqual([]);
    expect(host.store.get(FIX).extensions?.fixLoop?.fixContext).toBeUndefined();
    const refused = eventLines("fix-attempt-refused")[0]!;
    expect(refused).toMatchObject({ runId: FIX, prNumber: PR, flags: ["out-of-scope-diff"] });
    expect(refused.paths).toEqual(["README.md"]);
    // `flags` is log-only: NEVER a record field.
    expect(host.store.get(FIX).extensions?.fixLoop).not.toHaveProperty("flags");
    // The lock released on the refusal path too.
    const handle = acquireRunLock(host.runsDir, FIX, "test-aftermath");
    releaseRunLock(handle);
  });

  test("a denied path (scripts/reverify.ts) ⇒ scope-requires-privilege naming glob + reason", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {
      execResult: { exitCode: 0, stdout: "M\tscripts/reverify.ts\n", stderr: "" },
    });
    expect(result.code).toBe(5);
    const line = result.errLines[0]!;
    expect(line.code).toBe("scope-requires-privilege");
    expect(String(line.message)).toContain("scripts/reverify.ts");
    expect(String(line.message)).toContain("verification surface");
    expect(seams.pushCalls).toEqual([]);
    expect(host.store.get(FIX).extensions?.fixLoop?.fixContext).toBeUndefined();
    expect(eventLines("fix-attempt-refused")[0]).toMatchObject({ flags: ["scope-requires-privilege"] });
  });

  test("a delete action is out of scope under the shipped permittedActions", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {
      execResult: { exitCode: 0, stdout: "D\tsrc/old.ts\n", stderr: "" },
    });
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "out-of-scope-diff" });
    expect(seams.pushCalls).toEqual([]);
  });

  test("an unclassifiable diff line ⇒ exit 5 diff-unparseable, nothing pushed", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {
      execResult: { exitCode: 0, stdout: "U\tsrc/conflict.ts\n", stderr: "" },
    });
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "diff-unparseable" });
    expect(seams.pushCalls).toEqual([]);
  });

  test("pushVerifiedSha {ok:false} ⇒ exit 5 push-refused, refusal code logged, no fixContext", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {
      pushOutcome: {
        ok: false,
        refusal: {
          runId: FIX,
          attemptedAt: "2026-09-20T12:00:00.000Z",
          failedPrecondition: "not-fast-forward",
          failingChecks: [],
          reportPath: "",
          message: "not a descendant of the remote tip",
        },
      },
    });
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "push-refused", failedPrecondition: "not-fast-forward" });
    expect(seams.pushCalls.length).toBe(1);
    expect(host.store.get(FIX).extensions?.fixLoop?.fixContext).toBeUndefined();
    expect(eventLines("fix-attempt-refused")[0]).toMatchObject({ flags: ["not-fast-forward"] });
  });

  test("pushVerifiedSha {ok:true, pushed:false} — the resume arm — writes fixContext and exits 0", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    const { result } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {
      pushOutcome: { ok: true, sha: PUSH_SHA, targetRef: `refs/heads/qds/${PARENT}`, pushed: false },
    });
    expect(result.code).toBe(0);
    const written = parseFixContext(host.store.get(FIX).extensions?.fixLoop?.fixContext);
    expect(written.attemptSha).toBe(PUSH_SHA);
    expect(eventLines("fix-attempt-appended").length).toBe(1);
  });

  test("a preflight failure refuses BEFORE the push (INV-7): push never called, no fixContext", async () => {
    const host = inv2Host();
    const github = fakeGitHub();
    openPr(github);
    const { result, seams } = await runCli(baseDepsArgv(), host, github, new ProbeDriver(), {}, {
      preflight: () => {
        throw new Error("secret shape in payload");
      },
    });
    expect(result.code).toBe(5);
    expect(result.errLines[0]).toMatchObject({ code: "fix-context-preflight-failed" });
    expect(seams.pushCalls).toEqual([]);
    expect(host.store.get(FIX).extensions?.fixLoop?.fixContext).toBeUndefined();
    // The lock is released even on the preflight refusal path.
    const handle = acquireRunLock(host.runsDir, FIX, "test-aftermath");
    releaseRunLock(handle);
  });
});
