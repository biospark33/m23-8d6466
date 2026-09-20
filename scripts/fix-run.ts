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
  buildFixBrief,
  buildFixContextPayload,
  classifyDiffScope,
  encodeFixContext,
  fetchBotComments,
  FIX_DISPATCH_CEILING_MS,
  parseFixContext,
  preflightFixContextWrite,
  probeBoxCredentials,
  readFixScope,
  type BotCommentSet,
  type FixScopeAction,
  type IssueBudgetSnapshotSource,
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
import { log, newRequestId } from "../src/swarmclaw/log.ts";
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
        // create:false — a no-op invocation (closed PR, empty feedback, dedup)
        // must not mkdir/chmod anything, and with no records directory there
        // are no factory runs, so there is no factory PR to fix.
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

    // ── the bot-comment read and the comment-ID dedup ──
    const commentSet = await fetchBotComments(github, { owner: repoEntry.owner, repo: repoEntry.repo, prNumber, token });
    if (commentSet.botComments.length === 0) {
      return noop("no-bot-comments");
    }
    const attemptIds = fixAttemptRunIdsOf(parent);
    const recorded = recordedCommentIds(store, attemptIds);
    if (commentSet.commentIds.every((id) => recorded.has(id))) {
      return noop("already-recorded", { commentIds: commentSet.commentIds });
    }

    // ── routing on the LATEST attempt's approval state ──
    const latestId = attemptIds.at(-1);
    let latest: RunRecord | undefined;
    if (latestId !== undefined) {
      try {
        latest = store.get(latestId);
      } catch {
        // A dangling ledger id (reaped/damaged record) routes to a fresh attempt.
        latest = undefined;
      }
    }
    const latestState = latest === undefined ? undefined : approvalStateOf(latest);

    if (latest !== undefined && (latestState === "pausing" || latestState === "awaiting-approval")) {
      // Approval wait is human time and is never polled (AC3).
      fixRunId = latest.runId;
      return noop("approval-pending", { runId: latest.runId, approvalState: latestState });
    }

    if (latest !== undefined && latestState === "approved") {
      fixRunId = latest.runId;
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
        fixRunId: latest.runId,
        note,
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
  note: (s: string) => void;
  printRefusal: (code: string, message: string, remediation?: string, payload?: Record<string, unknown>) => void;
  printResult: (obj: Record<string, unknown>) => boolean;
  timings: Record<string, number>;
  setPhase: (p: string) => void;
  setFixRunId: (id: string) => void;
}

async function invocation1(ctx: Inv1Ctx): Promise<number> {
  const { deps, store, hostRoot, repoSlug, parent, pr, requestId } = ctx;
  ctx.setPhase("dispatch");

  // AC6's attempt-start probe: the scope artifact read runs BEFORE anything is
  // provisioned — a missing/unreadable artifact refuses at no cost.
  readFixScope(hostRoot, repoSlug);

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
  const brief = buildFixBrief({ hostRoot, parent, pr, botComments: ctx.commentSet.botComments, requestId });
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
    const printed = ctx.printResult({ state, runId: ack.runId, prNumber: pr.number, attempt: 1, requestId });
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
    ctx.printRefusal(t.code, t.message, t.remediation, { runId: ack.runId });
    // run-engine-dead is a death certificate (identical on retry) — 5; the
    // transient pair (box-unreachable, run-completion-unobserved) — 1.
    return t.code === "run-engine-dead" ? 5 : 1;
  }
  if (outcome.kind === "refused") {
    ctx.printRefusal(outcome.code, outcome.message, outcome.remediation, { runId: ack.runId });
    return 5;
  }
  // vetoed / approval-failed / chain-failed / handed-off: the run LANDED (the
  // chain tore it down and judged it) but the attempt produced nothing
  // publishable — 6, the landed-but-not-reportable family.
  ctx.printRefusal(
    `chain-${outcome.kind}`,
    outcome.kind === "vetoed"
      ? `the re-verifier refused the fix run's tree: ${outcome.reason}`
      : outcome.kind === "approval-failed"
        ? `the approval gate errored: ${outcome.error}`
        : outcome.kind === "chain-failed"
          ? `the completion chain failed at ${outcome.step}: ${outcome.error}`
          : `the approval gate returned ${outcome.outcome}, not a fresh approval request`,
    "the run is closed and its box torn down — the records carry the detail",
    { runId: ack.runId },
  );
  return 6;
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
  note: (s: string) => void;
  printResult: (obj: Record<string, unknown>) => boolean;
  logAttemptRefused: (reason: string, flags: string[], extra?: Record<string, unknown>) => void;
  fixEvent: (fields: Record<string, unknown>) => void;
  timings: Record<string, number>;
  setPhase: (p: string) => void;
  now: () => Date;
}

async function invocation2(ctx: Inv2Ctx): Promise<number> {
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
      // The fix-attempt-refused event fires from run()'s catch (both codes are
      // in REFUSAL_EVENT_CODES) and carries this payload — paths, or glob+reason.
      if (verdict.code === "out-of-scope-diff") {
        throw new FleetError(
          5,
          "out-of-scope-diff",
          `the fix's diff touches paths outside the declared scope: ${verdict.paths.join(", ")} — agent error; a retry may help`,
          "review the fix run's work; the scope allowlist is .factory/fix-scope.json — nothing was pushed, no fixContext was written",
          { runId: fixRunId, paths: verdict.paths },
        );
      }
      const matched = verdict.matched.map((m) => `${m.path} (deny ${m.glob}: ${m.reason})`);
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
      buildFixContextPayload({ ...payloadInput, attemptSha, pollWindowOpenedAt: ctx.now().toISOString() }),
    );
    // Written ONCE, post-push, on the fix run's own record (AC4/C4).
    store.set(fixRunId, { extensions: { fixLoop: { fixContext: encoded } } });
    ctx.fixEvent({ event: "fix-attempt-appended", runId: fixRunId, attemptSha });
    const printed = ctx.printResult({ state: "appended", runId: fixRunId, prNumber: ctx.pr.number, attempt: 1, attemptSha, requestId: ctx.requestId });
    return printed ? 0 : 6;
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
