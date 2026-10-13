#!/usr/bin/env bun
/**
 * `bun scripts/fix-run.ts --pr <n> [--dir <recordsDir>] [--repos-file <path>]`
 * — the DF6.1a operator CLI: one bot review comment set on a factory PR drives
 * at most one bounded fix attempt, and one verified, approved append to the PR
 * branch — or a refusal that costs nothing.
 *
 * Two bounded invocations (PLAN I8, story AC3). A requestId is minted at every
 * invocation and rides every log line (I11).
 *
 * Routing (on the PARENT record's `extensions.fixLoop.fixAttemptRunIds` ledger,
 * joined through the head branch `qds/<runId>`):
 *  - the LATEST attempt's fix-run record carries an APPROVED
 *    `extensions.approval` ⇒ invocation 2 (the push leg);
 *  - `pausing`/`awaiting-approval` ⇒ report state, exit 0 — the approval wait
 *    is human time and is NEVER polled;
 *  - anything else ⇒ invocation 1 (a fresh dispatch).
 *
 * Invocation 1: readFixScope attempt-start probe (refusal BEFORE any box) →
 * assertSingleFixer over the roster the run will use → assertFixCeilingCovered
 * → `dispatch()` in-process → fixRun="true" on the minted record + the minted
 * runId appended to the parent's fixAttemptRunIds (dispatch-time, so a charged
 * failure keeps the ledger) → INV-3 probeBoxCredentials (a hit destroys the
 * box, no agent work) → startRun → acquireRunLock → observeAndDriveChain with
 * the lock HELD BY THIS CALLER (the chain is lock-agnostic; acquireRunLock is
 * not re-entrant, so the handle goes in as deps.runLock and this file never
 * wraps the call in withRunLock) → driven ⇒ exit 0 reporting
 * `state: "awaiting-approval"`, lock released, no child process left.
 *
 * Invocation 2: re-verify the approval binding against the fix run's LATEST
 * reverify report (a stale or mismatched binding exits 5, nothing pushed) →
 * acquireRunLock → host-side `git diff --name-status <pinned commitSha>..
 * <approved headSha>` → readFixScope + classifyDiffScope (the two refusals are
 * distinct, nothing pushed, no fixContext) → fixContext encoded with the I5
 * placeholders and pre-flighted validate-only (INV-7) → pushVerifiedSha (the
 * PushOutcome union is discriminated on `ok`, never caught) → on success the
 * pre-flighted encoding is written ONCE with exactly the two placeholder
 * fields made real (attemptSha off the outcome, pollWindowOpenedAt = now) →
 * fix-attempt-appended → exit 0. DF6.1b's poll leg attaches after this.
 *
 * Repo resolution: `--pr` is a bare number, so owner/repo cannot come from
 * argv. The join key is the factory's own records: the run whose
 * `extensions.pr.prNumber` matches supplies `extensions.budget.repoSlug`, the
 * allowlist (`resolveRepoEntry`) turns that into owner/repo, and the PR's
 * `headRefName` must then BE `qds/<that run's id>` — anything else is
 * `not-a-factory-pr`.
 *
 * Exit codes (I10): 0 = awaiting-approval / appended / empty-feedback /
 * already-recorded / closed-or-merged / approval-pending; 2 = usage; 5 = the
 * typed refusals (not-a-factory-pr, fix-scope-missing, fix-ceiling-
 * insufficient, fix-roster-not-single-fixer, credential-probe-hit, out-of-
 * scope-diff, scope-requires-privilege, lock-refused, approval-binding
 * mismatch, push refusal); 1 = provider/run failure (incl. no host token and
 * GitHub API errors); 6 = the work landed but reporting/cleanup failed.
 *
 * IMPORT FENCE (C18): push.ts is imported ONLY for pushVerifiedSha /
 * PushOutcome; run-record.ts ONLY for RunRecordStore / RunRecord (which is why
 * the records-dir default is resolved locally rather than through
 * resolveRunsDir); approval-gate.ts and approvers.ts are banned outright. The
 * fence gate greps this file.
 */
import { join } from "node:path";

import { openAuditStore, type AuditStoreWriter } from "../src/audit/link-store.ts";
import {
  dispatch as fleetDispatch,
  FleetError,
  type DispatchDeps,
  type DispatchResult,
  type LedgerLike,
} from "../src/fleet/dispatch.ts";
import {
  observeAndDriveChain,
  type ChainOutcome,
  type RunCompletionDeps,
} from "../src/fleet/run-completion.ts";
import { startRun, type StartRunDeps, type StartRunResult } from "../src/fleet/run.ts";
import {
  assertFixCeilingCovered,
  assertSingleFixer,
  ATTEMPT_SHA_PLACEHOLDER,
  buildEscalationComment,
  buildFixBrief,
  buildFixContextPayload,
  CHARGED_CLASSES,
  classifyDiffScope,
  deriveAttemptLadder,
  encodeFixContext,
  encodeFixOutcome,
  evaluateCeilings,
  fetchBotComments,
  FIX_DISPATCH_CEILING_MS,
  fixContextHasRealSha,
  ghRunnerFromToken,
  parseFixContext,
  ONCE_PER_PR_CLASSES,
  parseFixOutcome,
  pollRequiredChecks,
  postEscalationComment,
  preflightFixContextWrite,
  preflightFixOutcomeWrite,
  probeBoxCredentials,
  probeRequiredChecks,
  readFixScope,
  type BotCommentSet,
  type BudgetCounts,
  type EscalationClass,
  type EscalationDiagnostic,
  type FixScopeAction,
  type GhRunner,
  type IssueBudgetSnapshotSource,
  type PollVerdict,
} from "../src/fixloop/index.ts";
import { loadRoster, RosterError } from "../src/phase-engine/roster/schema.ts";
import { CostLedger } from "../src/providers/cost-ledger.ts";
import { defaultKeyCapMicroUsd, openRouterKeyApi, type KeyApi } from "../src/providers/credentials.ts";
import type { ProviderAuditLink, ProviderDriver } from "../src/providers/driver.ts";
import { resolveDriver } from "../src/providers/index.ts";
import { RunRecordStore, type RunRecord } from "../src/providers/run-record.ts";
import { redactSecrets } from "../src/providers/step-log.ts";
import { httpGitHubApi, readHostToken, type GitHubApi } from "../src/pr/github.ts";
import { pushVerifiedSha, type PushOutcome } from "../src/pr/push.ts";
import { PrRefusalError, resolveRepoEntry } from "../src/pr/repos.ts";
import { DEFAULT_REVERIFY_DIR, readReportsWithTail } from "../src/reverify/report.ts";
import { exec as hostExec, type ExecResult } from "../src/reverify/worktree.ts";
import { log, newRequestId } from "../src/lib/log.ts";
import { costLedgerOpts } from "./lib/cost-ledger-opts.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, type RunLockHandle } from "./lib/run-lock.ts";

const USAGE = "usage: bun scripts/fix-run.ts --pr <n> [--dir <recordsDir>] [--repos-file <path>] [--cap-micro-usd <n>]";

/** The roster the single-fixer guard reads — the same roster the fix manifest names. */
const DEFAULT_ROSTER_PATH = "config/rosters/roster.yaml";

/**
 * Records-dir resolution, inlined: the import fence (C18) permits only
 * RunRecordStore/RunRecord out of run-record.ts, so resolveRunsDir cannot be
 * imported. The semantics are copied verbatim: --dir wins, then
 * $QDS_RUNS_DIR (trimmed, empty = unset), then `.sandbox/runs`.
 */
function resolveRecordsDir(dir: string | undefined): string {
  if (dir !== undefined) return dir;
  const env = process.env.QDS_RUNS_DIR?.trim();
  return env !== undefined && env !== "" ? env : ".sandbox/runs";
}

/**
 * The write-posture store for an invocation that is about to write: close the
 * read-only intake store (it holds no handles — the constructor's checks and
 * sweeps are all synchronous, so "closing" is abandoning the object) and
 * reopen WITHOUT `create: false`, re-running every posture proof the writable
 * constructor owns (0700, O_EXCL, link(2), the stale-temp sweep).
 *
 * A caller-injected store is the test's own store — taken as-is, never
 * reopened under it. The failure mapping is the intake guard's, for the same
 * reason F2 names: a chmod EPERM or an EROFS escaping as a raw errno would
 * cost the automation its typed exit 5.
 */
function writableStoreFor(deps: FixRunDeps | undefined, store: RunRecordStore, requestId: string): RunRecordStore {
  if (deps?.store !== undefined) return store;
  try {
    return new RunRecordStore({ dir: store.dir, requestId });
  } catch (e) {
    const x = (e ?? {}) as { message?: string };
    throw new FleetError(
      5,
      "not-a-factory-pr",
      `the records directory ${store.dir} cannot be opened read-write (${redactSecrets(x.message ?? e)})`,
      "fix the directory's permissions/ownership, or pass --dir",
    );
  }
}

/** Everything injectable, so the suite drives run() in-process with fakes at every seam. */
export interface FixRunDeps {
  /** Defaults to httpGitHubApi(). */
  github?: GitHubApi;
  /** Reads the host token. Defaults to keychain-then-stdin; never env, never argv. */
  token?: () => Promise<string | null>;
  /** Defaults to resolveDriver($QDS_PROVIDER_DRIVER ?? "exedev"). Built only on legs that touch a box. */
  driver?: ProviderDriver;
  store?: RunRecordStore;
  keyApi?: KeyApi;
  /** The ceiling pre-flight's snapshot source; a real CostLedger when absent. */
  ledger?: IssueBudgetSnapshotSource;
  /** dispatch()'s budget-gate ledger factory; beside the records dir when absent. */
  ledgerFactory?: () => LedgerLike;
  /** The chain's teardown ledger; a real CostLedger when absent. Caller-injected = caller-closed. */
  costLedger?: CostLedger;
  /** The roster the single-fixer guard reads. Default: config/rosters/roster.yaml under hostRoot. */
  rosterPath?: string;
  /** The operator's checkout — host git repo and `.factory/` root. Default: process.cwd(). */
  hostRoot?: string;
  reverifyDir?: string;
  /** In-process dispatch seam (default: src/fleet/dispatch.ts's dispatch). */
  dispatch?: (brief: unknown, deps: DispatchDeps) => Promise<DispatchResult>;
  startRun?: (deps: StartRunDeps, runId: string) => Promise<StartRunResult>;
  /** The completion-chain seam (default: observeAndDriveChain). The deps carry the caller-held lock. */
  observeChain?: (runId: string, deps: RunCompletionDeps) => Promise<ChainOutcome>;
  /** The push seam (default: pushVerifiedSha). Kept narrow so the fence's two permitted symbols suffice. */
  push?: (runId: string, opts: FixRunPushOpts) => Promise<PushOutcome>;
  /** INV-7 validate-only seam (default: preflightFixContextWrite). */
  preflight?: (encoded: string) => void;
  /** Host-side git (the invocation-2 diff). Default: src/reverify/worktree.ts's exec. */
  exec?: (argv: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;
  /** The chain's audit-link sink; default lazily opens the audit store and degrades, never throws. */
  recordAuditLink?: (link: ProviderAuditLink) => void;
  now?: () => Date;
  /** The dispatch cap, and the ceiling pre-flight's one uniform rate. Default: defaultKeyCapMicroUsd. */
  capMicroUsd?: number;
  /** The `gh` runner behind the CI-verdict poll and the required-check probe. Default: ghRunnerFromToken(token). */
  gh?: GhRunner;
  /** The poll cadence's sleep. Default: a real 30-second timer (tests inject an immediate resolve). */
  sleep?: (ms: number) => Promise<void>;
  /** INV-7 validate-only seam for fixOutcome (default: preflightFixOutcomeWrite). */
  preflightOutcome?: (encoded: string) => void;
}

/**
 * The push seam's options — structurally assignable to pushVerifiedSha's
 * `{ targetRef?: string } & PrDeps`, so the real export drops in as the
 * default without importing PrDeps (the fence permits pushVerifiedSha and
 * PushOutcome ONLY).
 */
export interface FixRunPushOpts {
  targetRef: string;
  hostRoot: string;
  runsDir: string;
  store: RunRecordStore;
  reverifyDir: string;
  reposFile?: string;
  token: () => Promise<string | null>;
  github: GitHubApi;
  exec: (argv: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;
  log: (e: Record<string, unknown>) => void;
}

// ─── argv ────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  pr: number;
  dir?: string;
  reposFile?: string;
  capMicroUsd?: number;
  help: boolean;
}

function usageError(message: string): FleetError {
  return new FleetError(2, "usage", message, USAGE);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { pr: 0, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--help" || tok === "-h") {
      out.help = true;
      continue;
    }
    const eq = tok.indexOf("=");
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : tok.slice(eq + 1);
    if (flag !== "--pr" && flag !== "--dir" && flag !== "--repos-file" && flag !== "--cap-micro-usd") {
      throw usageError(`unknown argument ${JSON.stringify(tok.slice(0, 96))}`);
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined || value === "") throw usageError(`${flag} requires a non-empty value`);
    if (flag === "--pr") {
      if (!/^\d+$/.test(value) || Number(value) <= 0) throw usageError(`--pr takes a positive PR number, got ${JSON.stringify(value.slice(0, 96))}`);
      out.pr = Number(value);
    } else if (flag === "--dir") {
      out.dir = value;
    } else if (flag === "--cap-micro-usd") {
      // The dispatch/key cap override — the live-e2e spend protocol's 50 000 µ$
      // key cap rides this flag; production keeps defaultKeyCapMicroUsd. Never
      // a silent raise: the flag can only tighten, never exceed the provider
      // backstop.
      if (!/^\d+$/.test(value) || Number(value) <= 0) throw usageError(`--cap-micro-usd takes a positive integer, got ${JSON.stringify(value.slice(0, 96))}`);
      if (Number(value) > defaultKeyCapMicroUsd) throw usageError(`--cap-micro-usd ${value} exceeds the provider backstop ${defaultKeyCapMicroUsd} — caps tighten, they never raise`);
      out.capMicroUsd = Number(value);
    } else {
      out.reposFile = value;
    }
  }
  if (!out.help && out.pr === 0) throw usageError("--pr <n> is required");
  return out;
}

// ─── small record readers (defensive: extensions are ExtensionValue-typed) ────

function fixAttemptRunIdsOf(rec: RunRecord): string[] {
  const v = rec.extensions?.fixLoop?.fixAttemptRunIds;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function approvalStateOf(rec: RunRecord): string | undefined {
  const s = rec.extensions?.approval?.state;
  return typeof s === "string" ? s : undefined;
}

/** Comment IDs every recorded attempt already carries — the dedup set. A missing or damaged attempt record contributes nothing. */
function recordedCommentIds(store: RunRecordStore, attemptIds: readonly string[]): Set<string> {
  const recorded = new Set<string>();
  for (const id of attemptIds) {
    try {
      const fx = store.get(id).extensions?.fixLoop?.fixContext;
      if (typeof fx !== "string") continue;
      for (const cid of parseFixContext(fx).commentIds) recorded.add(cid);
    } catch {
      // A reaped record or a torn fixContext proves nothing about the comment set.
    }
  }
  return recorded;
}

// ─── git diff --name-status parsing ───────────────────────────────────────────

/**
 * `git diff --name-status <pinned>..<approved>` lines: `M\tpath`, `A\tpath`,
 * `D\tpath`, `R100\told\tnew`, `C100\told\tnew`. A rename classifies as
 * "modify" at its NEW path, a copy as "add". Any other status letter is a
 * typed refusal — never a guess the scope classifier would wave through.
 */
function parseNameStatus(stdout: string): { path: string; action: FixScopeAction }[] {
  const entries: { path: string; action: FixScopeAction }[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status === "M" && parts[1]) entries.push({ path: parts[1], action: "modify" });
    else if (status === "A" && parts[1]) entries.push({ path: parts[1], action: "add" });
    else if (status === "D" && parts[1]) entries.push({ path: parts[1], action: "delete" });
    else if (status.startsWith("R") && parts[2]) entries.push({ path: parts[2], action: "modify" });
    else if (status.startsWith("C") && parts[2]) entries.push({ path: parts[2], action: "add" });
    else {
      throw new FleetError(
        5,
        "diff-unparseable",
        `git diff --name-status emitted a line this CLI cannot classify: ${JSON.stringify(line.slice(0, 96))}`,
        "inspect the harvested range by hand — a diff the scope check cannot read is never pushed",
      );
    }
  }
  return entries;
}

// ─── the one entry point ──────────────────────────────────────────────────────

export async function run(
  argv: readonly string[],
  out: (s: string) => void,
  err: (s: string) => void,
  deps?: FixRunDeps,
): Promise<number> {
  const startedAt = Date.now();
  const requestId = newRequestId();
  const now = deps?.now ?? (() => new Date());

  /** stderr diagnostics — a sink failure can never change an outcome. */
  const note = (s: string): void => {
    try {
      err(s);
    } catch {
      // Diagnostics only.
    }
  };
  const printRefusal = (code: string, message: string, remediation?: string, payload?: Record<string, unknown>): void => {
    const line: Record<string, unknown> = { ...(payload ?? {}), code, message };
    if (typeof remediation === "string" && remediation.trim() !== "") line.remediation = remediation;
    note(`${JSON.stringify(line)}\n`);
  };

  let code = 1;
  let prNumber = 0;
  let fixRunId: string | undefined;
  /** F3: the PARENT run's invocation lock — see the acquire below. Undefined until the join resolves the parent. */
  let parentLock: RunLockHandle | undefined;
  let phase = "resolve";
  /** I11: sub-timings are ABSENT, never 0, on legs that did not run. */
  const timings: Record<string, number> = {};
  let errorDetail: { code: string; message: string } | undefined;

  /** I11's per-attempt line: one per invocation, on every exit. */
  const attemptLog = (): void => {
    try {
      log({
        requestId,
        operation: "fix-run.attempt",
        agentId: null,
        timestamp: now().toISOString(),
        duration: Date.now() - startedAt,
        status: code === 0 ? "ok" : "error",
        prNumber: prNumber === 0 ? null : prNumber,
        attempt: 1,
        runId: fixRunId ?? null,
        phase,
        exitCode: code,
        exitStatus: code === 0 ? "success" : code === 1 ? "transient" : "logic",
        ...(errorDetail === undefined ? {} : { error: errorDetail }),
        ...timings,
      });
    } catch {
      // A raising log sink never replaces the invocation's outcome.
    }
  };

  /** I11's attempt events. `flags` is log-only — NEVER a record field. */
  const fixEvent = (fields: Record<string, unknown>): void => {
    try {
      log({
        requestId,
        operation: "fix-run.attempt",
        agentId: null,
        timestamp: now().toISOString(),
        duration: 0,
        status: "ok",
        prNumber,
        attempt: 1,
        ...fields,
      });
    } catch {
      // Best-effort, like every log sink here.
    }
  };
  const logAttemptRefused = (reason: string, flags: string[], extra?: Record<string, unknown>): void => {
    fixEvent({ event: "fix-attempt-refused", runId: fixRunId ?? null, reason, flags, ...(extra ?? {}) });
  };

  /** The completion line IS the report of landed work: a failed write after success is exit 6. */
  const printResult = (obj: Record<string, unknown>): boolean => {
    try {
      out(`${JSON.stringify(obj)}\n`);
      return true;
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      printRefusal(
        "completion-unwritable",
        `the invocation completed but its result line could not be written to stdout: ${redactSecrets(x.message ?? e)}`,
        "the work the missing line describes DID happen — confirm against the run records before re-running",
      );
      return false;
    }
  };

  /** Exit-0 no-op arms (I10): one JSON result line, no box, no dispatch. */
  const noop = (reason: string, extra?: Record<string, unknown>): number => {
    code = printResult({ state: "no-op", reason, prNumber, requestId, ...(extra ?? {}) }) ? 0 : 6;
    return code;
  };

  try {
    const args = parseArgs(argv);
    if (args.help) {
      out(`${USAGE}\n`);
      code = 0;
      return code;
    }
    prNumber = args.pr;

    const hostRoot = deps?.hostRoot ?? process.cwd();
    const store =
      deps?.store ??
      (() => {
        const dir = resolveRecordsDir(args.dir);
        // READ-ONLY, always. A no-op invocation (closed PR, empty feedback,
        // dedup, approval-pending) must not mkdir/chmod anything — and that
        // guarantee now holds for an EXISTING directory too, not just a
        // missing one: the writable open (mkdir 0700 + probe files + the
        // stale-temp sweep) previously ran BEFORE any no-op arm could exit,
        // mutating a directory the invocation was about to leave untouched.
        // The write posture is taken lazily — top of invocation1 and
        // invocation2, via writableStoreFor — because only an invocation that
        // will actually dispatch or push writes (the attempt record, the
        // parent's attempt-ledger append, the post-push fixContext). With no
        // records directory there are no factory runs, so there is no factory
        // PR to fix, and that guard stays here at intake.
        try {
          return new RunRecordStore({ dir, create: false, requestId });
        } catch (e) {
          const x = (e ?? {}) as { message?: string };
          throw new FleetError(
            5,
            "not-a-factory-pr",
            `the records directory ${dir} is unusable (${redactSecrets(x.message ?? e)}) — no factory runs means no factory PR`,
            "run fix-run from the checkout whose .sandbox/runs holds the PR's parent run, or pass --dir",
          );
        }
      })();

    const tokenFn = deps?.token ?? readHostToken;
    const token = await tokenFn();
    if (token === null || token === "") {
      throw new FleetError(
        1,
        "no-host-token",
        "no host GitHub token is available (keychain empty and stdin not piped)",
        "store the token in the keychain entry qds-factory-github, or pipe it: printf %s \"$TOKEN\" | bun scripts/fix-run.ts --pr <n>",
      );
    }
    const github = deps?.github ?? httpGitHubApi();

    // ── the PR ↔ parent-run join (see the header) ──
    const listing = store.listWithAnomalies();
    const candidates = listing.records.filter((r) => r.extensions?.pr?.prNumber === prNumber);
    if (candidates.length === 0) {
      throw new FleetError(
        5,
        "not-a-factory-pr",
        `no run record under ${store.dir} names PR #${prNumber} in extensions.pr.prNumber — this CLI acts only on factory-opened PRs`,
        "pass the PR a factory run opened (its parent record carries the pr extension), or check --dir",
        listing.skipped.length > 0 ? { skippedRecords: listing.skipped.length } : undefined,
      );
    }
    const slugs = new Set(
      candidates
        .map((r) => r.extensions?.budget?.repoSlug)
        .filter((s): s is string => typeof s === "string" && s !== ""),
    );
    if (slugs.size !== 1) {
      throw new FleetError(
        5,
        "not-a-factory-pr",
        `the records naming PR #${prNumber} disagree on the repository (${slugs.size} distinct repoSlugs) — the PR number is only meaningful within one`,
        "inspect the records under --dir by hand; a PR number shared across repos is ambiguous and never guessed",
      );
    }
    const repoSlug = [...slugs][0]!;
    // Propagates PrRefusalError (allowlist unreadable / slug unregistered).
    const repoEntry = resolveRepoEntry(hostRoot, repoSlug, args.reposFile);

    const pr = await github.getPullRequest({ owner: repoEntry.owner, repo: repoEntry.repo, prNumber, token });
    if (pr === null) {
      throw new FleetError(
        5,
        "not-a-factory-pr",
        `${repoSlug}#${prNumber} does not exist (404) — the record's pr extension disagrees with GitHub`,
        "check the PR number and the repo allowlist entry",
      );
    }
    if (pr.state === "closed" || pr.merged) {
      return noop("closed-or-merged", { merged: pr.merged });
    }
    const parentSummary = candidates.find((r) => pr.headRefName === `qds/${r.runId}`);
    if (parentSummary === undefined) {
      throw new FleetError(
        5,
        "not-a-factory-pr",
        `${repoSlug}#${prNumber}'s head branch ${JSON.stringify(pr.headRefName)} is not qds/<runId> of any factory run holding that PR number`,
        "the fix loop runs only on PRs whose head branch a factory run owns",
      );
    }
    // The freshness re-read I8 names: the scan's copy is stale the moment it lands.
    const parent = store.get(parentSummary.runId);

    // The PARENT run's invocation lock, taken the moment the join resolves the
    // parent and held to invocation exit (released in run()'s finally — never
    // across the approval gate, which is a separate process's human time).
    // The parent is the contention point, not the fix run: the dedup key IS
    // the parent's `fixAttemptRunIds` ledger, and invocation 1's append to it
    // (the fresh re-read + `store.set` below the dispatch) is a check-then-act
    // whose window a concurrent second invocation otherwise narrows to
    // microseconds but never closes — the loser's ledger id vanishes and the
    // lost dedup key re-dispatches (spend). Serializing on the parent's lock
    // refuses the second invocation `lock-refused` exit 5 at report() BEFORE
    // it mints anything. The fix run's own lock (acquired inside each
    // invocation, keyed on the freshly minted attempt id) is a different key
    // and never collides with this one — acquireRunLock keys on
    // `<runsDir>/<runId>.lock` and parent ≠ attempt.
    parentLock = acquireRunLock(store.dir, parent.runId, "fix-run");

    // ── the bot-comment read and the comment-ID dedup ──
    const commentSet = await fetchBotComments(github, { owner: repoEntry.owner, repo: repoEntry.repo, prNumber, token });
    if (commentSet.botComments.length === 0) {
      return noop("no-bot-comments");
    }
    const attemptIds = fixAttemptRunIdsOf(parent);

    // ── DF6.1b: the loop-terminal marker. fixOutcome is write-once at the
    // LOOP's terminal, so its presence means every later invocation reports
    // the recorded outcome, dispatches nothing and posts no second escalation
    // comment — the escalation was posted once, when the outcome was written.
    const recordedOutcome = parseRecordedFixOutcome(parent);
    if (recordedOutcome !== undefined) {
      if (recordedOutcome.outcome === "green") {
        return noop("loop-green", { attempts: recordedOutcome.attempts, runIds: recordedOutcome.runIds });
      }
      note(
        `${JSON.stringify({ code: "loop-terminal", classification: recordedOutcome.classification ?? null, attempts: recordedOutcome.attempts, escalation: "already-posted", message: "the fix loop already escalated on this PR; dispatching nothing" })}\n`,
      );
      errorDetail = { code: "loop-terminal", message: "the fix loop already escalated on this PR; dispatching nothing" };
      code = 1;
      return code;
    }

    // ── DF6.1b: the attempt ladder, derived across the whole ledger ──
    const ladder = deriveAttemptLadder((id) => store.get(id), attemptIds);
    const counts = ladder.counts;

    // The comment-ID dedup (DF6.1a): a FRESH first attempt on comments the
    // loop already answered is a no-op — but only when the LATEST attempt has
    // no terminal story to tell. A terminal latest (charged failure, refusal,
    // orphan) must reach the budget routing below even on an unchanged set:
    // that is precisely the retry case the DF6.1b arms decide.
    const recorded = recordedCommentIds(store, attemptIds);
    const latestPre = ladder.entries.at(-1);
    if (
      commentSet.commentIds.length > 0 &&
      commentSet.commentIds.every((id) => recorded.has(id)) &&
      latestPre !== undefined &&
      latestPre.arm !== "terminal" &&
      latestPre.arm !== "orphaned" &&
      // a poll that never settled is an UNFINISHED answer — the invocation
      // resumes it against the persisted anchor instead of no-oping
      latestPre.arm !== "poll-recovery"
    ) {
      return noop("already-recorded", { commentIds: commentSet.commentIds });
    }
    if (commentSet.commentIds.every((id) => recorded.has(id)) && latestPre === undefined) {
      return noop("already-recorded", { commentIds: commentSet.commentIds });
    }

    /** INV-7's ordering, one place: build → validate → write → THEN post. The loop-terminal marker makes every later invocation exit non-zero without a second comment. */
    const escalateTerminal = async (o: { classification: EscalationClass; charged: boolean; note?: string; diagnostics: EscalationDiagnostic }): Promise<number> => {
      const encoded = encodeFixOutcome({
        schemaVersion: 1,
        prNumber,
        attempts: counts.charged,
        outcome: "escalated",
        classification: o.classification,
        runIds: [parent.runId, ...attemptIds],
      });
      try {
        (deps?.preflightOutcome ?? preflightFixOutcomeWrite)(encoded);
      } catch (e) {
        const x = (e ?? {}) as { message?: string };
        printRefusal(
          "fix-outcome-preflight-failed",
          `the fixOutcome payload failed its validate-only preflight: ${redactSecrets(x.message ?? e)}`,
          "nothing was posted — the payload that cannot be written is refused BEFORE the escalation comment (INV-7)",
        );
        errorDetail = { code: "fix-outcome-preflight-failed", message: redactSecrets(x.message ?? e) };
        return 5;
      }
      store.set(parent.runId, { extensions: { fixLoop: { fixOutcome: encoded } } });
      const escStart = Date.now();
      try {
        await postEscalationComment({
          github,
          owner: repoEntry.owner,
          repo: repoEntry.repo,
          prNumber,
          body: buildEscalationComment({ prNumber, classification: o.classification, charged: o.charged, diagnostics: o.diagnostics, note: o.note }),
          token,
        });
        timings.escalation_ms = Date.now() - escStart;
      } catch (e) {
        const x = (e ?? {}) as { message?: string };
        printRefusal(
          "escalation-post-failed",
          `could not post the escalation comment: ${redactSecrets(x.message ?? e)}`,
          "the loop-terminal outcome IS recorded — the PR has no comment only if GitHub refused the post",
        );
      }
      printRefusal(o.classification, `the fix loop stopped: ${o.note ?? "budget terminal"}`, "inspect the PR and the run records; the loop dispatches nothing further on this PR");
      errorDetail = { code: o.classification, message: o.note ?? "budget terminal" };
      return 1;
    };

    // bot-response-to-fix (the ping-pong stop): the budget is a LIFETIME cap
    // per PR. A comment set whose IDs are ALL absent from every recorded
    // attempt's set — on a PR the loop has already pushed to — is the review
    // bot answering the fix, not new feedback: escalate, never re-dispatch; a
    // fresh comment set never resets anything.
    const pushed = attemptIds.some((id) => {
      try {
        return fixContextHasRealSha(store.get(id).extensions?.fixLoop?.fixContext);
      } catch {
        return false;
      }
    });
    if (pushed && commentSet.commentIds.length > 0 && commentSet.commentIds.every((id) => !recorded.has(id))) {
      logAttemptRefused("bot-response-to-fix", ["bot-response-to-fix"]);
      code = await escalateTerminal({
        classification: "bot-response-to-fix",
        charged: counts.charged > 0,
        note: "every comment in this set was posted AFTER the loop's last push — the review bot is responding to the fix; the attempt budget is a lifetime cap per PR and a fresh comment set never resets it",
        diagnostics: {
          errorLog: `the loop already pushed ${attemptIds.length} attempt(s) to this PR; this comment set is the bot's response to its own fix`,
          diffAttempted: [],
          ciFailureMessages: [],
          runIds: [parent.runId, ...attemptIds],
        },
      });
      return code;
    }

    const latestId = attemptIds.at(-1);
    const latestEntry = ladder.entries.at(-1);

    // Poll recovery: invocation 2 died mid-poll. The window's opening is
    // persisted in fixContext.pollWindowOpenedAt — resume against its
    // remaining time, never a restarted window.
    if (latestEntry !== undefined && latestEntry.arm === "poll-recovery" && latestId !== undefined) {
      fixRunId = latestId;
      code = await pollRecovery({
        deps,
        store,
        github,
        token,
        requestId,
        owner: repoEntry.owner,
        repo: repoEntry.repo,
        pr: { number: prNumber, headRefName: pr.headRefName },
        fixRunId: latestId,
        parentRunId: parent.runId,
        attemptIds,
        counts,
        note,
        printRefusal,
        printResult,
        fixEvent,
        timings,
        setPhase: (p) => {
          phase = p;
        },
        now,
      });
      return code;
    }

    if (latestEntry !== undefined && latestEntry.arm === "continuation" && latestId !== undefined) {
      // The approval state decides (AC3) — read off the LADDER ENTRY, not a
      // second record read: pausing/awaiting-approval is human time and is
      // never polled; an approved record with no fixContext is the sanctioned
      // re-attempt of the scope→push leg (invocation 2).
      const latestState = latestEntry.approvalState;
      if (latestState === "pausing" || latestState === "awaiting-approval") {
        fixRunId = latestId;
        return noop("approval-pending", { runId: latestId, approvalState: latestState });
      }
      if (latestState === "approved") {
        fixRunId = latestId;
        code = await invocation2({
          deps,
          store,
          github,
          token,
          tokenFn,
          requestId,
          hostRoot,
          repoSlug,
          owner: repoEntry.owner,
          repo: repoEntry.repo,
          reposFile: args.reposFile,
          pr: { number: prNumber, headRefName: pr.headRefName },
          fixRunId: latestId,
          parentRunId: parent.runId,
          attemptIds,
          counts,
          attempt: attemptIds.length,
          diffPaths: [],
          note,
          printRefusal,
          printResult,
          logAttemptRefused,
          fixEvent,
          timings,
          setPhase: (p) => {
            phase = p;
          },
          now,
        });
        return code;
      }
    }

    if (latestEntry !== undefined && (latestEntry.arm === "terminal" || latestEntry.arm === "orphaned")) {
      // The ceilings speak before anything dispatches.
      const violations = evaluateCeilings(counts);
      if (violations.length > 0) {
        logAttemptRefused("attempt-budget-exhausted", violations, { classifications: counts.classifications });
        code = await escalateTerminal({
          classification: latestEntry.classification ?? "orphaned",
          charged: latestEntry.arm === "terminal" && latestEntry.classification !== undefined && CHARGED_CLASSES.has(latestEntry.classification),
          note: `the attempt budget is exhausted (${violations.join(", ")}); recorded classifications: ${counts.classifications.join(", ")}`,
          diagnostics: {
            errorLog: `the loop will not dispatch again on this PR: ${violations.join(", ")} ceiling(s) reached across ${attemptIds.length} recorded attempt(s)`,
            diffAttempted: [],
            ciFailureMessages: [],
            runIds: [parent.runId, ...attemptIds],
          },
        });
        return code;
      }
      const cls = latestEntry.classification;
      if (!latestEntry.written && (cls === "approval-timed-out" || cls === "orphaned")) {
        // DISCOVERY: the state was written by a process outside this loop
        // (DF3.4's expiry) or derived from a dead record. Write the class,
        // page once, stop — the operator's next invocation dispatches while
        // the uncharged ceiling allows it.
        fixRunId = latestId!;
        store.set(latestId!, { extensions: { fixLoop: { fixOutcomeClass: cls } } });
        try {
          const escStart = Date.now();
          await postEscalationComment({
            github,
            owner: repoEntry.owner,
            repo: repoEntry.repo,
            prNumber,
            body: buildEscalationComment({
              prNumber,
              classification: cls!,
              charged: false,
              diagnostics: {
                errorLog: cls === "approval-timed-out" ? "the approval window expired undecided (DF3.4's expiry)" : "the attempt's record carries no terminal outcome, no live approval state and no fixContext",
                diffAttempted: [],
                ciFailureMessages: [],
                runIds: [latestId!, parent.runId],
              },
              note: cls === "approval-timed-out" ? "the attempt is uncharged; re-invoke to dispatch the next attempt" : "the attempt is uncharged; re-invoke to dispatch the next attempt",
            }),
            token,
          });
          timings.escalation_ms = Date.now() - escStart;
        } catch (e) {
          const x = (e ?? {}) as { message?: string };
          printRefusal(
            "escalation-post-failed",
            `could not post the ${cls} escalation comment: ${redactSecrets(x.message ?? e)}`,
            "the classification is recorded; check the PR's comments by hand",
          );
        }
        printRefusal(cls!, `attempt ${latestId} ended as ${cls} — escalation posted`, "re-invoke to dispatch the next attempt — the uncharged ceiling still allows it");
        errorDetail = { code: cls!, message: `attempt ${latestId} ended as ${cls}` };
        code = 1;
        return code;
      }
      // A charged failure under budget, or a written uncharged terminal under
      // the ceiling: its escalation was posted when the classification was
      // written — this invocation IS the operator's decision to continue.
    }

    code = await invocation1({
      // deps injection wins over the CLI flag; the flag tightens the production
      // default (defaultKeyCapMicroUsd) only when no test seam overrides it.
      deps: deps?.capMicroUsd !== undefined || args.capMicroUsd === undefined ? deps : { ...deps, capMicroUsd: args.capMicroUsd },
      store,
      hostRoot,
      repoSlug,
      parent,
      pr: { number: prNumber, headRefName: pr.headRefName, headSha: pr.headSha },
      commentSet,
      requestId,
      attempt: attemptIds.length + 1,
      gh: deps?.gh ?? ghRunnerFromToken(token),
      owner: repoEntry.owner,
      repo: repoEntry.repo,
      token,
      github,
      fixEvent,
      priorAttempt:
        latestEntry !== undefined && latestEntry.classification !== undefined && latestEntry.classification !== "green"
          ? { runId: latestEntry.runId, classification: latestEntry.classification }
          : undefined,
      note,
      printRefusal,
      printResult,
      timings,
      setPhase: (p) => {
        phase = p;
      },
      setFixRunId: (id) => {
        fixRunId = id;
      },
    });
    return code;
  } catch (e) {
    // fix-attempt-refused rides every guard/scope/binding refusal (I11) — the
    // no-published-sha arms this CLI owns. The push refusal logs at its site
    // (it carries the failedPrecondition, not one of these codes).
    if (e instanceof FleetError && REFUSAL_EVENT_CODES.has(e.code)) {
      logAttemptRefused(e.code, [e.code], e.payload);
    }
    code = report(e);
    return code;
  } finally {
    // F3's release posture: the parent lock comes off on EVERY path — success,
    // refusal, throw — because the story's contract is that fix-run locks are
    // never held across the approval gate. A failing release keeps its
    // registration, so the module's exit handler retries and reports it; the
    // diagnostic here just names it at the invocation's own exit too.
    if (parentLock !== undefined) {
      try {
        releaseRunLock(parentLock);
      } catch (e) {
        const x = (e ?? {}) as { message?: string };
        printRefusal(
          "parent-lock-release-failed",
          `could not release the parent run's lock: ${redactSecrets(x.message ?? e)}`,
          "the next fix-run invocation for this parent refuses lock-refused until the lock is cleared — rm it only once no invocation is running",
        );
      }
    }
    attemptLog();
  }

  /** Render any throw as the stderr envelope + this CLI's exit code. */
  function report(e: unknown): number {
    if (e instanceof FleetError) {
      printRefusal(e.code, e.message, e.remediation, e.payload);
      errorDetail = { code: e.code, message: e.message };
      // FleetError.exitCode is typed 1-5; a JS caller could still build a 6 —
      // thrown 6 is a thrower bug, classified 2, never "work landed".
      if ((e.exitCode as unknown) === 6) return 2;
      return Number.isInteger(e.exitCode) && e.exitCode >= 1 && e.exitCode <= 5 ? e.exitCode : 2;
    }
    if (e instanceof RunLockedError) {
      printRefusal("lock-refused", e.message, e.remediation);
      errorDetail = { code: "lock-refused", message: e.message };
      return 5;
    }
    if (e instanceof RosterError) {
      // The roster the run would use could not be read or is invalid — a
      // permanent configuration refusal, before anything is provisioned.
      printRefusal(e.code, redactSecrets(e.message), "fix the roster the fix manifest names (config/rosters/roster.yaml) — nothing was provisioned");
      errorDetail = { code: e.code, message: e.message };
      return 5;
    }
    if (e instanceof PrRefusalError) {
      printRefusal(e.precondition, redactSecrets(e.message));
      errorDetail = { code: e.precondition, message: e.message };
      return 5;
    }
    const x = (e ?? {}) as { code?: string; message?: string; stack?: string };
    const message = redactSecrets(x.message ?? e);
    printRefusal(
      typeof x.code === "string" ? x.code : "error",
      message,
      undefined,
      typeof x.stack === "string" ? { stack: redactSecrets(x.stack) } : undefined,
    );
    errorDetail = { code: typeof x.code === "string" ? x.code : "error", message };
    return 1;
  }
}

/**
 * Refusal codes that log `fix-attempt-refused` from run()'s catch — the
 * pre-dispatch guards and the invocation-2 binding/scope arms (I11's
 * no-published-sha arms). The push refusal logs at its own site; transient
 * and usage failures are not attempt refusals and are absent here.
 */
const REFUSAL_EVENT_CODES: ReadonlySet<string> = new Set([
  "empty-required-set",
  "poll-anchor-invalid",
  "fix-scope-missing",
  "fix-ceiling-insufficient",
  "fix-roster-not-single-fixer",
  "credential-probe-hit",
  "approval-binding-mismatch",
  "reverify-unreadable",
  "attempt-base-missing",
  "diff-unreadable",
  "diff-unparseable",
  "out-of-scope-diff",
  "scope-requires-privilege",
  "fix-context-preflight-failed",
]);

// ─── DF6.1b: the loop-terminal marker, the poll verdict, poll recovery ───────

/** Tolerant read of the parent's loop-terminal marker; undefined when absent or torn. */
function parseRecordedFixOutcome(parent: RunRecord): ReturnType<typeof parseFixOutcome> | undefined {
  const raw = (parent.extensions?.fixLoop as Record<string, unknown> | undefined)?.fixOutcome;
  if (typeof raw !== "string") return undefined;
  try {
    return parseFixOutcome(raw);
  } catch {
    // A torn fixOutcome is never a dispatch authority — the ladder decides.
    return undefined;
  }
}

/** The green/charged terminal the poll (or its recovery) settles into — shared by invocation 2 and recovery. */
interface PollSettleCtx {
  deps?: FixRunDeps;
  store: RunRecordStore;
  github: GitHubApi;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  fixRunId: string;
  parentRunId: string;
  attemptIds: readonly string[];
  counts: BudgetCounts;
  attempt: number;
  /** The pushed sha the verdict is bound to — echoed on the result line. */
  attemptSha: string;
  diffPaths: readonly string[];
  verdict: PollVerdict;
  note: (s: string) => void;
  printRefusal: (code: string, message: string, remediation?: string, payload?: Record<string, unknown>) => void;
  printResult: (obj: Record<string, unknown>) => boolean;
  fixEvent: (fields: Record<string, unknown>) => void;
  timings: Record<string, number>;
  now: () => Date;
}

async function settlePollVerdict(ctx: PollSettleCtx): Promise<number> {
  if (ctx.verdict.kind === "green") {
    // Terminal success: the attempt's own class, then the loop-terminal
    // marker on the PARENT record — the record DF5.3's chain reaches from the
    // PR at hop 1. INV-7: the payload is validated before anything else.
    ctx.store.set(ctx.fixRunId, { extensions: { fixLoop: { fixOutcomeClass: "green" } } });
    const encoded = encodeFixOutcome({
      schemaVersion: 1,
      prNumber: ctx.prNumber,
      attempts: ctx.counts.charged + 1,
      outcome: "green",
      runIds: [ctx.parentRunId, ...ctx.attemptIds],
    });
    (ctx.deps?.preflightOutcome ?? preflightFixOutcomeWrite)(encoded);
    ctx.store.set(ctx.parentRunId, { extensions: { fixLoop: { fixOutcome: encoded } } });
    ctx.fixEvent({ event: "ci-verdict-green", runId: ctx.fixRunId, attempt: ctx.attempt, polls: ctx.verdict.polls });
    const printed = ctx.printResult({
      state: "green",
      runId: ctx.fixRunId,
      prNumber: ctx.prNumber,
      attempt: ctx.attempt,
      attempts: ctx.counts.charged + 1,
      polls: ctx.verdict.polls,
      checks: ctx.verdict.checks,
      attemptSha: ctx.attemptSha,
    });
    return printed ? 0 : 6;
  }
  const cls: EscalationClass = ctx.verdict.kind === "ci-red" ? "ci-red" : "ci-verdict-unavailable";
  // A CHARGED failure: the attempt reached CI and failed there. Record the
  // class, then page once with the four diagnostics — the operator's next
  // invocation dispatches the next attempt while the charged budget allows.
  ctx.store.set(ctx.fixRunId, { extensions: { fixLoop: { fixOutcomeClass: cls } } });
  ctx.fixEvent({ event: "ci-verdict", runId: ctx.fixRunId, attempt: ctx.attempt, classification: cls, polls: ctx.verdict.polls });
  const body = buildEscalationComment({
    prNumber: ctx.prNumber,
    classification: cls,
    charged: true,
    diagnostics: {
      errorLog:
        ctx.verdict.kind === "ci-red"
          ? `required check(s) settled non-pass on the pushed sha: ${ctx.verdict.failedChecks.map((c) => `${c.name}=${c.bucket}`).join(", ")}`
          : ctx.verdict.reason,
      diffAttempted: [...ctx.diffPaths],
      ciFailureMessages: ctx.verdict.kind === "ci-red" ? ctx.verdict.failedChecks.map((c) => `${c.name}: ${c.bucket}`) : [],
      runIds: [ctx.fixRunId, ctx.parentRunId],
    },
    note: ctx.verdict.kind === "ci-verdict-unavailable" ? "the 15-minute poll window expired without a settled required-check set" : undefined,
  });
  const escStart = Date.now();
  try {
    await postEscalationComment({ github: ctx.github, owner: ctx.owner, repo: ctx.repo, prNumber: ctx.prNumber, body, token: ctx.token });
    ctx.timings.escalation_ms = Date.now() - escStart;
  } catch (e) {
    const x = (e ?? {}) as { message?: string };
    ctx.printRefusal(
      "escalation-post-failed",
      `could not post the ${cls} escalation comment: ${redactSecrets(x.message ?? e)}`,
      "the classification IS recorded on the attempt — check the PR's comments by hand",
    );
  }
  ctx.printRefusal(
    cls,
    ctx.verdict.kind === "ci-red"
      ? `the required checks failed on the pushed sha (${ctx.verdict.failedChecks.map((c) => c.name).join(", ")}) — the attempt charged the budget`
      : `no settled CI verdict inside the 15-minute window — the attempt charged the budget (${ctx.verdict.reason})`,
    "re-invoke to dispatch the next attempt — the charged budget still allows it; the loop never reruns CI",
    { runId: ctx.fixRunId, polls: ctx.verdict.polls },
  );
  return 1;
}

/** Invocation 2 died mid-poll: resume against the persisted window anchor — remaining time only. */
async function pollRecovery(ctx: {
  deps?: FixRunDeps;
  store: RunRecordStore;
  github: GitHubApi;
  token: string;
  requestId: string;
  owner: string;
  repo: string;
  pr: { number: number; headRefName: string };
  fixRunId: string;
  parentRunId: string;
  attemptIds: readonly string[];
  counts: BudgetCounts;
  note: (s: string) => void;
  printRefusal: (code: string, message: string, remediation?: string, payload?: Record<string, unknown>) => void;
  printResult: (obj: Record<string, unknown>) => boolean;
  fixEvent: (fields: Record<string, unknown>) => void;
  timings: Record<string, number>;
  setPhase: (p: string) => void;
  now: () => Date;
}): Promise<number> {
  ctx.setPhase("recover");
  let payload: ReturnType<typeof parseFixContext>;
  try {
    payload = parseFixContext(ctx.store.get(ctx.fixRunId).extensions?.fixLoop?.fixContext);
  } catch (e) {
    throw new FleetError(
      5,
      "poll-anchor-invalid",
      `the poll-interrupted record ${ctx.fixRunId} carries no parseable fixContext: ${redactSecrets((e as Error).message)}`,
      "the record is torn; inspect it by hand — fail closed: never a restarted window, never a green (INV-6)",
      { runId: ctx.fixRunId },
    );
  }
  if (payload.attemptSha === ATTEMPT_SHA_PLACEHOLDER || !Number.isFinite(Date.parse(payload.pollWindowOpenedAt))) {
    throw new FleetError(
      5,
      "poll-anchor-invalid",
      `the poll-interrupted record ${ctx.fixRunId} carries a placeholder sha or an unparseable pollWindowOpenedAt — the window's opening is unrecoverable`,
      "the record is torn; inspect it by hand — fail closed: never a restarted window, never a green (INV-6)",
      { runId: ctx.fixRunId },
    );
  }
  ctx.setPhase("ci-poll");
  const pollStart = Date.now();
  const gh = ctx.deps?.gh ?? ghRunnerFromToken(ctx.token);
  const verdict = await pollRequiredChecks({
    prNumber: ctx.pr.number,
    attemptSha: payload.attemptSha,
    windowOpenedAt: payload.pollWindowOpenedAt,
    gh,
    now: ctx.now,
    sleep: ctx.deps?.sleep,
  });
  ctx.timings.poll_ms = Date.now() - pollStart;
  return settlePollVerdict({
    deps: ctx.deps,
    store: ctx.store,
    github: ctx.github,
    token: ctx.token,
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.pr.number,
    fixRunId: ctx.fixRunId,
    parentRunId: ctx.parentRunId,
    attemptIds: ctx.attemptIds,
    counts: ctx.counts,
    attempt: payload.attempt,
    attemptSha: payload.attemptSha,
    diffPaths: [],
    verdict,
    note: ctx.note,
    printRefusal: ctx.printRefusal,
    printResult: ctx.printResult,
    fixEvent: ctx.fixEvent,
    timings: ctx.timings,
    now: ctx.now,
  });
}

// ─── invocation 1: guard → dispatch → probe → run → chain ─────────────────────

interface Inv1Ctx {
  deps?: FixRunDeps;
  store: RunRecordStore;
  hostRoot: string;
  repoSlug: string;
  parent: RunRecord;
  pr: { number: number; headRefName: string; headSha: string };
  commentSet: BotCommentSet;
  requestId: string;
  /** This attempt's dispatch ordinal — ledger length + 1 (AC2's attempt bookkeeping). */
  attempt: number;
  /** The gh runner behind AC1's attempt-start required-check probe. */
  gh: GhRunner;
  /** Attempt ≥ 2 carries the prior attempt's classification and runId (its CI failure comes from the probe). */
  priorAttempt?: { runId: string; classification: EscalationClass };
  /** GitHub identity for the terminal-classification escalation comment. */
  owner: string;
  repo: string;
  token: string;
  /** The live GitHub seam for the escalation post. */
  github: GitHubApi;
  fixEvent: (fields: Record<string, unknown>) => void;
  note: (s: string) => void;
  printRefusal: (code: string, message: string, remediation?: string, payload?: Record<string, unknown>) => void;
  printResult: (obj: Record<string, unknown>) => boolean;
  timings: Record<string, number>;
  setPhase: (p: string) => void;
  setFixRunId: (id: string) => void;
}

async function invocation1(ctx: Inv1Ctx): Promise<number> {
  // The write posture is taken HERE, not at intake (F1): from this point the
  // invocation WILL dispatch and write — the attempt record, the parent's
  // attempt-ledger append, the chain's writes — so every store read below
  // (dispatch, startFn, the chain) goes through the writable handle.
  ctx.store = writableStoreFor(ctx.deps, ctx.store, ctx.requestId);
  const { deps, store, hostRoot, repoSlug, parent, pr, requestId } = ctx;
  ctx.setPhase("probe-required");

  // AC1's attempt-start probe: the empty-required-set refusal is evaluated
  // BEFORE the push, BEFORE any box — a PR whose branch carries no required
  // checks is refused, never counted green (nothing ran).
  const requiredProbe = await probeRequiredChecks({ prNumber: pr.number, gh: ctx.gh });
  if (!requiredProbe.present) {
    throw new FleetError(
      5,
      "empty-required-set",
      `PR #${pr.number} carries no required checks (${requiredProbe.message.trim().slice(0, 160)}) — a fix whose CI cannot fail can never prove green`,
      "give the PR's head branch a required check (branch protection or the workflow), then re-invoke",
      { prNumber: pr.number },
    );
  }

  ctx.setPhase("dispatch");

  // AC6's attempt-start probe: the scope artifact read runs BEFORE anything is
  // provisioned — a missing/unreadable artifact refuses at no cost. A missing
  // artifact is DETERMINISTIC: it pages on EVERY invocation until the operator
  // creates it (never a continuation, never a once-per-PR record — no run
  // record is minted on this path and fixOutcome stays write-once-at-terminal).
  try {
    readFixScope(hostRoot, repoSlug);
  } catch (e) {
    if (e instanceof FleetError && e.code === "fix-scope-missing") {
      try {
        await postEscalationComment({
          github: ctx.github,
          owner: ctx.owner,
          repo: ctx.repo,
          prNumber: pr.number,
          body: buildEscalationComment({
            prNumber: pr.number,
            classification: "fix-scope-missing",
            charged: false,
            diagnostics: { errorLog: e.message, diffAttempted: [], ciFailureMessages: [], runIds: [parent.runId] },
            note: "the scope artifact is missing — create .factory/fix-scope.json and re-invoke; this page repeats on every invocation until then",
          }),
          token: ctx.token,
        });
      } catch {
        // the refusal below still fires; the page is best-effort
      }
    }
    throw e;
  }

  // AC5's single-fixer guard, over the roster the run will use, BEFORE the
  // brief reaches the dispatcher. The roster path is injectable so the suite's
  // fixtures never touch the shipped roster.
  const roster = loadRoster(deps?.rosterPath ?? join(hostRoot, DEFAULT_ROSTER_PATH), { repoRoot: hostRoot });
  assertSingleFixer(roster.roles);

  // The issue-ceiling pre-flight (W19): parentSpend + 2 × cap + (3 + 3) × cap,
  // one uniform rate — the cap this invocation passes to dispatch.
  const capMicroUsd = deps?.capMicroUsd ?? defaultKeyCapMicroUsd;
  const issueIdRaw = parent.extensions?.budget?.issueId;
  const ownLedger = deps?.ledger === undefined ? new CostLedger(costLedgerOpts(store.dir)) : undefined;
  try {
    assertFixCeilingCovered({
      ledger: deps?.ledger ?? ownLedger!,
      repoSlug,
      issueId: typeof issueIdRaw === "string" || typeof issueIdRaw === "number" ? issueIdRaw : "",
      parentSpendMicroUsd: parent.spendMicroUsd ?? 0,
      capMicroUsd,
    });
  } finally {
    ownLedger?.close();
  }

  // Built only now: a refusal above must not demand a provider env it never uses.
  const driver =
    deps?.driver ??
    (() => {
      try {
        return resolveDriver(process.env.QDS_PROVIDER_DRIVER?.trim() || "exedev", { requestId });
      } catch (e) {
        const x = (e ?? {}) as { message?: string };
        throw new FleetError(2, "driver-unavailable", redactSecrets(x.message ?? e), "name a registered provider driver via $QDS_PROVIDER_DRIVER");
      }
    })();
  const keyApi =
    deps?.keyApi ??
    (() => {
      try {
        return openRouterKeyApi();
      } catch (e) {
        const x = (e ?? {}) as { message?: string };
        throw new FleetError(2, "provisioning-key-unavailable", redactSecrets(x.message ?? e), "set $OPENROUTER_PROVISIONING_KEY");
      }
    })();

  // An ORDINARY DF3.1 dispatch — the fix run is a normal run pinned to the PR head.
  // Attempt ≥ 2's brief carries attempt 1's CI failure (the failed required
  // buckets read FRESH off this invocation's probe — the red checks are still
  // red on that sha) PATTERN-redacted before it enters the brief (W12's HIGH:
  // box ingress gets the same redactor as the public escalation comment).
  const failedBuckets = requiredProbe.entries.filter((c) => c.bucket !== "pass").map((c) => `${c.name}: ${c.bucket}`);
  const priorAttempt =
    ctx.priorAttempt === undefined
      ? undefined
      : {
          runId: ctx.priorAttempt.runId,
          classification: ctx.priorAttempt.classification,
          ciFailure: redactSecrets(
            failedBuckets.length > 0
              ? `attempt ${ctx.priorAttempt.runId} (${ctx.priorAttempt.classification}): ${failedBuckets.join("; ")}`
              : `attempt ${ctx.priorAttempt.runId} (${ctx.priorAttempt.classification})`,
          ),
        };
  const brief = buildFixBrief({ hostRoot, parent, pr, botComments: ctx.commentSet.botComments, requestId, priorAttempt });
  const dispatchFn = deps?.dispatch ?? fleetDispatch;
  const dispatchDeps: DispatchDeps = {
    driver,
    keyApi,
    store,
    ledgerFactory: deps?.ledgerFactory ?? (() => new CostLedger(costLedgerOpts(store.dir))),
    requestId,
    capMicroUsd,
    repoRoot: hostRoot,
    // The shipped fix manifest prices the 600 s fix phase at runBudgetMs
    // 1 900 000 — the 600 s dispatch default refuses it at the manifest load
    // (measured live, 2026-09-20), so the fix loop names its own ceiling.
    timeoutMs: FIX_DISPATCH_CEILING_MS,
  };
  const ack = await dispatchFn(brief, dispatchDeps);
  ctx.setFixRunId(ack.runId);

  // C21, dispatch-time: the mint marker on the attempt's own record, and the
  // attempt-time ledger append on the parent — both BEFORE the chain runs, so
  // a charged failure keeps them.
  store.set(ack.runId, { extensions: { fixLoop: { fixRun: "true" } } });
  const freshParent = store.get(parent.runId);
  store.set(parent.runId, {
    extensions: { fixLoop: { fixAttemptRunIds: [...fixAttemptRunIdsOf(freshParent), ack.runId] } },
  });

  // INV-3: the last point at which no agent-authored code has run. A hit tears
  // the box down through the driver and refuses — no startRun, no chain.
  ctx.setPhase("probe");
  const probe = await probeBoxCredentials(driver, ack.vmName, ack.runId);
  if (!probe.ok) {
    try {
      await driver.destroy(ack.vmName);
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      ctx.printRefusal(
        "probe-teardown-failed",
        `the credential probe hit on ${ack.vmName} and destroying the box ALSO failed: ${redactSecrets(x.message ?? e)}`,
        `destroy the box by hand — it is billing and carries credential material: ${ack.vmName}`,
        { runId: ack.runId },
      );
    }
    throw new FleetError(
      5,
      "credential-probe-hit",
      `credential material on the fresh fix box ${ack.vmName}: ${probe.hits.join(", ")} — the box was destroyed before any agent work`,
      "find the source of the credential before the next attempt — the box was provisioned dirty",
      { runId: ack.runId, hits: probe.hits },
    );
  }

  ctx.setPhase("run");
  const startFn = deps?.startRun ?? startRun;
  const started = await startFn({ driver, store }, ack.runId);
  if (started.outcome === "run-not-startable") {
    throw new FleetError(
      5,
      "run-not-startable",
      `${ack.runId} cannot be started: it is ${started.state}`,
      "inspect the record with `fleet status` — the identical start refuses identically on retry",
      { runId: ack.runId, state: started.state },
    );
  }
  if (started.outcome === "start-failed") {
    const unreachable = started.reason === "box-unreachable";
    throw new FleetError(
      unreachable ? 1 : 5,
      unreachable ? "engine-start-unreachable" : "engine-start-refused",
      unreachable
        ? `the box for ${ack.runId} never answered the engine start`
        : `systemd refused to start the engine for ${ack.runId} (exit ${started.exitCode ?? "?"})`,
      unreachable
        ? "confirm the box is up (`fleet status`) and re-run — a start that did land makes the retry a systemd no-op"
        : `ssh the box and read \`systemctl status qds-run@${ack.runId}.service\` — the unit is Restart=no, so this failure is terminal`,
      { runId: ack.runId },
    );
  }

  // The caller holds the lock (DF3.7/DF3.8 co-spec): observeAndDriveChain is
  // lock-agnostic and takes this handle as deps.runLock; acquireRunLock is not
  // re-entrant, so this is NEVER wrapped in withRunLock.
  ctx.setPhase("observe");
  const handle = acquireRunLock(store.dir, ack.runId, "fix-run");
  let chainAudit: AuditStoreWriter | undefined;
  let auditLinksDropped = false;
  const recordAuditLink =
    deps?.recordAuditLink ??
    ((link: ProviderAuditLink): void => {
      if (auditLinksDropped) return;
      if (chainAudit === undefined) {
        try {
          chainAudit = openAuditStore();
        } catch (e) {
          // A store that cannot open drops the chain's links, never the chain:
          // the teardown has already landed by the time its link emits.
          auditLinksDropped = true;
          const x = (e ?? {}) as { message?: string };
          ctx.printRefusal(
            "audit-store-unavailable",
            `the chain's audit links for ${ack.runId} were dropped: ${redactSecrets(x.message ?? e)}`,
            "the teardown itself is unaffected; hop 4/5 reports this run unlinked until a later `fleet teardown` re-emits it",
            { runId: ack.runId },
          );
          return;
        }
      }
      chainAudit.record(link);
    });
  let ledgerCloseFailed = false;
  const chainLedger =
    deps?.costLedger ??
    new CostLedger({
      ...costLedgerOpts(store.dir),
      runsDir: store.dir,
      readRunRecord: (id: string) => {
        try {
          return store.get(id);
        } catch (e) {
          if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
          throw e;
        }
      },
    });
  let outcome: ChainOutcome;
  const chainStart = Date.now();
  try {
    outcome = await (deps?.observeChain ?? observeAndDriveChain)(ack.runId, {
      driver,
      store,
      runsDir: store.dir,
      hostRoot,
      runLock: handle,
      keyApi,
      recordAuditLink,
      requestId,
      costLedger: chainLedger,
    });
    ctx.timings.fix_run_ms = Date.now() - chainStart;
  } finally {
    // The lock releases on EVERY path — success, typed refusal, throw.
    releaseRunLock(handle);
    if (deps?.costLedger === undefined) {
      try {
        chainLedger.close();
      } catch (e) {
        ledgerCloseFailed = true;
        const x = (e ?? {}) as { message?: string };
        ctx.printRefusal("ledger-close-failed", `could not close the cost ledger: ${redactSecrets(x.message ?? e)}`, "the handle dies with the process; re-run to confirm it still reads");
      }
    }
    try {
      chainAudit?.close();
    } catch (e) {
      auditLinksDropped = true;
      const x = (e ?? {}) as { message?: string };
      ctx.printRefusal("audit-store-close-failed", `could not close the audit-link store: ${redactSecrets(x.message ?? e)}`, "the handle dies with the process; re-run to confirm it still reads");
    }
  }

  if (outcome.kind === "driven") {
    // The chain landed and the gate registered; report the record's own state.
    let state = "awaiting-approval";
    try {
      state = approvalStateOf(store.get(ack.runId)) ?? "awaiting-approval";
    } catch {
      // The verdict above stands; the state word is a courtesy read.
    }
    const printed = ctx.printResult({ state, runId: ack.runId, prNumber: pr.number, attempt: ctx.attempt, requestId });
    return printed && !ledgerCloseFailed && !auditLinksDropped ? 0 : 6;
  }
  if (outcome.kind === "unsettled") {
    const t = outcome.terminal;
    if (t === undefined) {
      ctx.printRefusal(
        "fix-run-unsettled",
        `the fix run ${ack.runId} did not settle inside the observation window`,
        `re-run \`bun scripts/fix-run.ts --pr ${pr.number}\` — the run keeps progressing between invocations`,
        { runId: ack.runId },
      );
      return 1;
    }
    // A terminal chain outcome is an uncharged-terminal attempt (transient):
    // record the class, page once, stop. The ceilings gate the NEXT dispatch.
    await chargeUnchargedTerminal("transient", t.message, t.code);
    ctx.printRefusal(t.code, t.message, t.remediation, { runId: ack.runId });
    // run-engine-dead is a death certificate (identical on retry) — 5; the
    // transient pair (box-unreachable, run-completion-unobserved) — 1.
    return t.code === "run-engine-dead" ? 5 : 1;
  }
  if (outcome.kind === "refused") {
    // DF6.2's deterministic refusal class (dispatch_task settled fail with
    // exitStatus "logic"): charges NOTHING — no attempt increment — and
    // escalates immediately with the refusal's own message as the diagnostic,
    // naming the refused precondition. One box-hour and one key cap are sunk;
    // the loop never dispatches another attempt for it.
    await chargeUnchargedTerminal("dispatch-refused", outcome.message, outcome.code);
    ctx.printRefusal(outcome.code, outcome.message, outcome.remediation, { runId: ack.runId });
    return 5;
  }
  // vetoed / approval-failed / chain-failed / handed-off: the run LANDED (the
  // chain tore it down and judged it) but the attempt produced nothing
  // publishable — 6, the landed-but-not-reportable family. vetoed is the
  // re-verifier refusing the tree: lead_failure. The rest are transient.
  const chainClass: EscalationClass = outcome.kind === "vetoed" ? "lead_failure" : "transient";
  const chainMessage =
    outcome.kind === "vetoed"
      ? `the re-verifier refused the fix run's tree: ${outcome.reason}`
      : outcome.kind === "approval-failed"
        ? `the approval gate errored: ${outcome.error}`
        : outcome.kind === "chain-failed"
          ? `the completion chain failed at ${outcome.step}: ${outcome.error}`
          : `the approval gate returned ${outcome.outcome}, not a fresh approval request`;
  await chargeUnchargedTerminal(chainClass, chainMessage, `chain-${outcome.kind}`);
  ctx.printRefusal(
    `chain-${outcome.kind}`,
    chainMessage,
    "the run is closed and its box torn down — the records carry the detail",
    { runId: ack.runId },
  );
  return 6;

  /** Record the per-attempt class, page once with the refusal's own message, and keep the invocation's exit. */
  async function chargeUnchargedTerminal(classification: EscalationClass, message: string, code: string): Promise<void> {
    try {
      store.set(ack.runId, { extensions: { fixLoop: { fixOutcomeClass: classification } } });
      // The once-per-PR deterministic refusal is LOOP-TERMINAL: its
      // first-occurrence escalation is its own bound, so the parent record
      // takes the fixOutcome marker now and every later invocation exits
      // non-zero without a second comment.
      if (ONCE_PER_PR_CLASSES.has(classification)) {
        const encodedOutcome = encodeFixOutcome({
          schemaVersion: 1,
          prNumber: pr.number,
          attempts: 0,
          outcome: "escalated",
          classification,
          runIds: [parent.runId, ack.runId],
        });
        (deps?.preflightOutcome ?? preflightFixOutcomeWrite)(encodedOutcome);
        store.set(parent.runId, { extensions: { fixLoop: { fixOutcome: encodedOutcome } } });
      }
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      ctx.printRefusal(
        "fix-outcome-class-write-failed",
        `could not record fixOutcomeClass=${classification} on ${ack.runId}: ${redactSecrets(x.message ?? e)}`,
        "the attempt keeps its chain outcome; the next invocation derives it from the record state",
      );
      return;
    }
    ctx.fixEvent({ event: "attempt-classified", runId: ack.runId, attempt: ctx.attempt, classification });
    const escStart = Date.now();
    try {
      await postEscalationComment({
        github: ctx.github,
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: pr.number,
        body: buildEscalationComment({
          prNumber: pr.number,
          classification,
          charged: false,
          diagnostics: {
            errorLog: message,
            diffAttempted: [],
            ciFailureMessages: [],
            runIds: [ack.runId, parent.runId],
          },
          note:
            classification === "dispatch-refused"
              ? `a deterministic refusal (${code}) — a second identical dispatch cannot fix it, so the loop charges nothing and will not dispatch again`
              : `the attempt is uncharged (${classification}); re-invoke to dispatch the next attempt while the uncharged ceiling allows it`,
        }),
        token: ctx.token,
      });
      ctx.timings.escalation_ms = Date.now() - escStart;
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      ctx.printRefusal(
        "escalation-post-failed",
        `could not post the ${classification} escalation comment: ${redactSecrets(x.message ?? e)}`,
        "the classification IS recorded on the attempt — check the PR's comments by hand",
      );
    }
  }
}

// ─── invocation 2: bind → diff → scope → preflight → push → write ─────────────

interface Inv2Ctx {
  deps?: FixRunDeps;
  store: RunRecordStore;
  github: GitHubApi;
  /** The token already read and validated at intake — the invocation-2 comment re-read uses it. */
  token: string;
  /** The live reader, handed to the push seam (its preflight reads the token LAST, itself). */
  tokenFn: () => Promise<string | null>;
  requestId: string;
  hostRoot: string;
  repoSlug: string;
  owner: string;
  repo: string;
  reposFile?: string;
  pr: { number: number; headRefName: string };
  fixRunId: string;
  /** The parent-run join — the fixOutcome's hop-1 anchor. */
  parentRunId: string;
  attemptIds: readonly string[];
  counts: BudgetCounts;
  /** This attempt's dispatch ordinal (the ledger's length). */
  attempt: number;
  /** The scope-classified diff paths — the escalation's "diff attempted". */
  diffPaths: readonly string[];
  note: (s: string) => void;
  printRefusal: (code: string, message: string, remediation?: string, payload?: Record<string, unknown>) => void;
  printResult: (obj: Record<string, unknown>) => boolean;
  logAttemptRefused: (reason: string, flags: string[], extra?: Record<string, unknown>) => void;
  fixEvent: (fields: Record<string, unknown>) => void;
  timings: Record<string, number>;
  setPhase: (p: string) => void;
  now: () => Date;
}

async function invocation2(ctx: Inv2Ctx): Promise<number> {
  // Same write posture as invocation 1 (F1): the push seam and the post-push
  // fixContext write on the fix run's own record both mutate records, so the
  // store is reopened writable before the binding read below — a binding
  // check is a read, but everything after the scope gate is a write.
  ctx.store = writableStoreFor(ctx.deps, ctx.store, ctx.requestId);
  const { deps, store, hostRoot, fixRunId } = ctx;
  ctx.setPhase("bind");

  // The binding check (AC2/C2), on a FRESH read — the routing read that
  // brought us here is stale by now, and a binding that vanished or moved
  // between the two exits 5 with nothing pushed. The approval must be approved
  // AND bound to THIS attempt's LATEST reverify report — reportId and headSha
  // both. pushVerifiedSha's own preflight re-checks all of it; this check runs
  // FIRST because it is what gates the diff, the scope read and the
  // credential-adjacent work below.
  const fixRec = store.get(fixRunId);
  const approval = fixRec.extensions?.approval;
  const reverifyDir = deps?.reverifyDir ?? join(hostRoot, DEFAULT_REVERIFY_DIR);
  const { reports, lastLineInvalid } = readReportsWithTail(reverifyDir, fixRunId);
  if (lastLineInvalid) {
    throw new FleetError(
      5,
      "reverify-unreadable",
      `the last line of ${join(reverifyDir, `${fixRunId}.jsonl`)} is not a readable ReverifyReport — refusing to fall back to an earlier verdict for ${fixRunId}`,
      "repair or remove the torn last line by hand; the run cannot be re-judged here",
      { runId: fixRunId },
    );
  }
  const latestReport = reports.at(-1);
  const boundReportId = typeof approval?.reportId === "string" ? approval.reportId : "";
  const boundHeadSha = typeof approval?.headSha === "string" ? approval.headSha : "";
  if (
    approval === undefined ||
    approvalStateOf(fixRec) !== "approved" ||
    latestReport === undefined ||
    boundReportId !== latestReport.reverifyId ||
    boundHeadSha !== latestReport.headSha
  ) {
    throw new FleetError(
      5,
      "approval-binding-mismatch",
      latestReport === undefined
        ? `${fixRunId} carries an approval but no reverify report exists at ${reverifyDir} — there is nothing to bind it to`
        : `the approval on ${fixRunId} is ${String(approval?.state)} bound to report ${boundReportId}@${boundHeadSha}, but the latest reverify report is ${latestReport.reverifyId}@${latestReport.headSha} — a stale or mismatched approval never authorizes a push`,
      "re-verify and re-approve this attempt (fleet approve binds the fresh report), then re-run — nothing was pushed",
      { runId: fixRunId, boundReportId, boundHeadSha, latestReportId: latestReport?.reverifyId ?? null, latestHeadSha: latestReport?.headSha ?? null },
    );
  }
  const approvedHeadSha = latestReport.headSha;

  // The lock covers the diff, the scope verdict, the preflight, the push and
  // the record write — released in the finally on every arm.
  ctx.setPhase("scope");
  const handle: RunLockHandle = acquireRunLock(store.dir, fixRunId, "fix-run");
  try {
    const pinned = fixRec.commitSha;
    if (typeof pinned !== "string" || pinned === "") {
      throw new FleetError(
        5,
        "attempt-base-missing",
        `the fix run ${fixRunId} carries no commitSha — the attempt's pinned base is unrecoverable, so its diff cannot be computed`,
        "the record is incomplete; inspect it by hand — nothing was pushed",
        { runId: fixRunId },
      );
    }
    const execFn = deps?.exec ?? hostExec;
    const diff = await execFn(["git", "diff", "--name-status", `${pinned}..${approvedHeadSha}`], { cwd: hostRoot });
    if (diff.exitCode !== 0 || diff.truncated === true) {
      throw new FleetError(
        5,
        "diff-unreadable",
        `git diff --name-status ${pinned}..${approvedHeadSha} failed (exit ${diff.exitCode}${diff.truncated === true ? ", output truncated" : ""}): ${redactSecrets(diff.stderr.trim()).slice(0, 200)}`,
        "run the diff by hand from the hostRoot — an unreadable diff is never pushed past",
        { runId: fixRunId },
      );
    }
    const entries = parseNameStatus(diff.stdout);
    const scope = readFixScope(hostRoot, ctx.repoSlug);
    const verdict = classifyDiffScope(entries, scope);
    if (!verdict.ok) {
      // Both refusals are recorded AT MOST ONCE per PR (the class lands on the
      // attempt's own record before the throw) and page with the refusal's own
      // detail: out-of-scope-diff is capped at 1 (the injection outcome), and
      // scope-requires-privilege is never retried at all.
      const recordRefusalClass = async (cls: EscalationClass, errorLog: string): Promise<void> => {
        try {
          store.set(fixRunId, { extensions: { fixLoop: { fixOutcomeClass: cls } } });
          // scope-requires-privilege is LOOP-TERMINAL (never retried): the
          // marker makes every later invocation exit non-zero silently.
          if (ONCE_PER_PR_CLASSES.has(cls)) {
            const encodedOutcome = encodeFixOutcome({
              schemaVersion: 1,
              prNumber: ctx.pr.number,
              attempts: 0,
              outcome: "escalated",
              classification: cls,
              runIds: [ctx.parentRunId, fixRunId],
            });
            (ctx.deps?.preflightOutcome ?? preflightFixOutcomeWrite)(encodedOutcome);
            store.set(ctx.parentRunId, { extensions: { fixLoop: { fixOutcome: encodedOutcome } } });
          }
        } catch {
          // the typed refusal below still fires; the class write is best-effort
        }
        ctx.fixEvent({ event: "attempt-classified", runId: fixRunId, attempt: ctx.attempt, classification: cls });
        try {
          await postEscalationComment({
            github: ctx.github,
            owner: ctx.owner,
            repo: ctx.repo,
            prNumber: ctx.pr.number,
            body: buildEscalationComment({
              prNumber: ctx.pr.number,
              classification: cls,
              charged: false,
              diagnostics: { errorLog, diffAttempted: entries.map((e2) => e2.path), ciFailureMessages: [], runIds: [fixRunId, ctx.parentRunId] },
              note: cls === "out-of-scope-diff" ? "a second identical out-of-scope diff is a signal about the comments, not the fixer — the loop will not dispatch again" : "the refusal is deterministic — no retry can succeed; the loop will not dispatch again",
            }),
            token: ctx.token,
          });
        } catch {
          // the typed refusal below still fires; the page is best-effort
        }
      };
      // The fix-attempt-refused event fires from run()'s catch (both codes are
      // in REFUSAL_EVENT_CODES) and carries this payload — paths, or glob+reason.
      if (verdict.code === "out-of-scope-diff") {
        await recordRefusalClass("out-of-scope-diff", `the fix's diff touches paths outside the declared scope: ${verdict.paths.join(", ")}`);
        throw new FleetError(
          5,
          "out-of-scope-diff",
          `the fix's diff touches paths outside the declared scope: ${verdict.paths.join(", ")} — agent error; a retry may help`,
          "review the fix run's work; the scope allowlist is .factory/fix-scope.json — nothing was pushed, no fixContext was written",
          { runId: fixRunId, paths: verdict.paths },
        );
      }
      const matched = verdict.matched.map((m) => `${m.path} (deny ${m.glob}: ${m.reason})`);
      await recordRefusalClass("scope-requires-privilege", `the fix necessarily requires privileged paths: ${matched.join("; ")}`);
      throw new FleetError(
        5,
        "scope-requires-privilege",
        `the fix necessarily requires privileged paths: ${matched.join("; ")} — retry can never succeed; this escalates to a human`,
        "the denied paths are the verification surface — address the underlying issue by hand — nothing was pushed, no fixContext was written",
        { runId: fixRunId, matched: verdict.matched },
      );
    }

    ctx.setPhase("push");
    // The comment identity is read FRESH at invocation 2 (I5/I11 semantics):
    // commentIds and the digest describe the PR's bot comments AS OF THE PUSH,
    // not as of the dispatch — a comment that arrived while the attempt waited
    // for its human decision is part of what the append answers to.
    const fresh = await fetchBotComments(ctx.github, { owner: ctx.owner, repo: ctx.repo, prNumber: ctx.pr.number, token: ctx.token });
    const payloadInput = {
      prNumber: ctx.pr.number,
      prBranch: ctx.pr.headRefName,
      commentIds: fresh.commentIds,
      omittedCommentIds: fresh.omittedCommentIds,
      omittedCount: fresh.omittedCount,
      commentsDigest: fresh.commentsDigest,
    };
    // INV-7: the two fields that cannot exist before the push are placeholders;
    // the post-push write differs from this encoding in exactly those two fields.
    const preflighted = encodeFixContext(buildFixContextPayload(payloadInput));
    try {
      (deps?.preflight ?? preflightFixContextWrite)(preflighted);
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      throw new FleetError(
        5,
        "fix-context-preflight-failed",
        `the fixContext payload failed its validate-only preflight: ${redactSecrets(x.message ?? e)}`,
        "the payload that cannot be written is refused BEFORE the push — nothing was pushed",
        { runId: fixRunId },
      );
    }

    const pushFn = deps?.push ?? pushVerifiedSha;
    const pushStart = Date.now();
    const outcome = await pushFn(fixRunId, {
      targetRef: `refs/heads/${ctx.pr.headRefName}`,
      hostRoot,
      runsDir: store.dir,
      store,
      reverifyDir,
      ...(ctx.reposFile === undefined ? {} : { reposFile: ctx.reposFile }),
      token: ctx.tokenFn,
      github: ctx.github,
      exec: execFn,
      log: (e) => ctx.note(`${JSON.stringify(e)}\n`),
    });
    ctx.timings.push_ms = Date.now() - pushStart;
    if (!outcome.ok) {
      // pushVerifiedSha already recorded the refusal durably (.sandbox/pr/);
      // this line is the attempt-level event. No fixContext — there is no
      // attemptSha to write.
      ctx.logAttemptRefused(outcome.refusal.failedPrecondition, [outcome.refusal.failedPrecondition]);
      throw new FleetError(
        5,
        "push-refused",
        `the push was refused (${outcome.refusal.failedPrecondition}): ${redactSecrets(outcome.refusal.message)}`,
        "nothing was pushed and no fixContext was written; the refusal is recorded under .sandbox/pr/",
        { runId: fixRunId, failedPrecondition: outcome.refusal.failedPrecondition },
      );
    }

    // ok:true on EITHER pushed value — the resume arm (pushed:false) is success.
    const attemptSha = outcome.sha;
    const encoded = encodeFixContext(
      buildFixContextPayload({ ...payloadInput, attempt: ctx.attempt, attemptSha, pollWindowOpenedAt: ctx.now().toISOString() }),
    );
    // Written ONCE, post-push, on the fix run's own record (AC4/C4).
    store.set(fixRunId, { extensions: { fixLoop: { fixContext: encoded } } });
    ctx.fixEvent({ event: "fix-attempt-appended", runId: fixRunId, attemptSha });

    // ── DF6.1b: the poll leg attaches HERE, in this same invocation
    // (W6-D-B1): the 15-minute window opened when pushVerifiedSha returned, so
    // polling now is polling while the window is certainly open — a third
    // invocation would gamble the window on the persisted anchor's remaining
    // time instead of polling while it is certainly open.
    ctx.setPhase("ci-poll");
    const pollStart = Date.now();
    const gh = ctx.deps?.gh ?? ghRunnerFromToken(ctx.token);
    const pollVerdict = await pollRequiredChecks({
      prNumber: ctx.pr.number,
      attemptSha,
      windowOpenedAt: ctx.now().toISOString(),
      gh,
      now: ctx.now,
      sleep: ctx.deps?.sleep,
    });
    ctx.timings.poll_ms = Date.now() - pollStart;
    return settlePollVerdict({
      deps: ctx.deps,
      store,
      github: ctx.github,
      token: ctx.token,
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.pr.number,
      fixRunId,
      parentRunId: ctx.parentRunId,
      attemptIds: ctx.attemptIds,
      counts: ctx.counts,
      attempt: ctx.attempt,
      attemptSha,
      diffPaths: entries.map((e) => e.path),
      verdict: pollVerdict,
      note: ctx.note,
      printRefusal: ctx.printRefusal,
      printResult: ctx.printResult,
      fixEvent: ctx.fixEvent,
      timings: ctx.timings,
      now: ctx.now,
    });
  } finally {
    releaseRunLock(handle);
  }
}

if (import.meta.main) {
  process.exit(
    await run(
      process.argv.slice(2),
      (s) => {
        process.stdout.write(s);
      },
      (s) => {
        process.stderr.write(s);
      },
    ),
  );
}
