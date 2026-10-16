/**
 * A3 · Maintenance sweeps F4 — the sweep pass's planning + dispatch core.
 *
 * ONE bounded, exiting pass (the caller is a crontab line, never a loop):
 * collect deterministic hotspots, assemble at most MAX_BRIEFS_PER_SWEEP
 * briefs, submit each as a fleet run, persist the durable report record, and
 * return. Every input crosses an injected dep, so the pass is testable without
 * a box, a graph, or an audit store; `scripts/maintenance-sweep.ts` wires the
 * production deps.
 *
 * Signal-first (INV-A3-SIGNAL-FIRST, charter §6): hotspots are computed here,
 * by code — graph fan-in from A6's GitNexus graph and the audit chain over the
 * trailing window. No LLM picks or ranks a candidate; the in-box agent only
 * investigates or executes against a signal this module already verified.
 *
 * The gate is the one gate (AC1, INV-A3-GATE): a brief becomes a run through
 * the fleet CLI's `submit` verb (dispatch + engine start, replay-safe on its
 * `--request-id`), and the run reaches `awaiting-approval` through DF3.7's
 * `observeAndDriveChain`, driven by DF3.8's `fleet observe --all` sweep (its
 * cron line sits beside A3's in deploy/vps/crontab.factory). This module never
 * imports the chain, the approval gate, the approver allowlist, or `push.ts`,
 * and holds no token — the fence test greps for each.
 *
 * Read-only on the audit chain (AC3c): `walkAuditChain` + `chainVerdict` are
 * consumed, and the CLI walks a throwaway SNAPSHOT of the audit store — the
 * walker records first-observation digest baselines, and an unattended weekly
 * pass must not become the first observer of the operator's store. The
 * production store is never opened for write; `src/audit/**` is byte-identical.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../lib/log.ts";
import { atomicReplaceFile } from "../providers/fs-atomic.ts";
import type { RunRecord } from "../providers/run-record.ts";
import { deriveAttemptLadder, evaluateCeilings } from "../fixloop/escalation.ts";
import { WorkKeySchema } from "../managers/manager-config.ts";

// ─── named guards (story Technical Notes) ────────────────────────────────────

/** Five parked PRs a week is reviewable; fifty is a rubber stamp (operator approval burden + one-box live tier). */
export const MAX_BRIEFS_PER_SWEEP = 5;
/** NFR-OBS-5 verbatim: no agent run against a graph whose last completed analyze is >8h old. */
export const GRAPH_STALENESS_BUDGET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The weekly cadence's window: the trailing 7 days of chain activity. */
export const SWEEP_WINDOW_MS = 7 * DAY_MS;
/**
 * Audit-leg bound (not a spec number — a pass budget): the newest N CLOSED
 * windowed runs are walked; the rest are counted (`runs_not_walked`), never
 * silent. Each walk carries the walker's own 30 s ceiling.
 */
export const MAX_WALKED_RUNS = 20;
/**
 * Graph-leg bound: the top-N production fan-in files the query returns. Deep
 * enough that the never-edit fence (FENCED_TARGET_PREFIXES — measured on this
 * repo, 8 of the top 10 fan-in files sit behind it) still leaves candidates.
 */
export const MAX_GRAPH_HOTSPOTS = 25;
/**
 * A GRAPH target briefed by one of the previous 3 sweeps is deferred, counted:
 * fan-in is stable week to week, and re-proposing the same parked brief every
 * Monday is the rubber-stamp failure MAX_BRIEFS_PER_SWEEP exists to prevent.
 * Measured in sweep weeks (sweepId dates), not wall-clock, so cron jitter
 * cannot move the boundary. Audit signals are NOT cooled down: a breakage that
 * recurs is new evidence every week.
 */
export const REBRIEF_COOLDOWN_SWEEPS = 4;
/**
 * A report still `pending` this long after its sweep is residue: the next
 * weekly wake has come and gone (plus a day of grace for a wake that fires
 * later on the Monday than the pass). The A1 digest (which runs far more
 * often than weekly) names it from day 8; the sweep pass itself names it on
 * the following Monday. Residue never ages out — "never silence" (story
 * Technical Notes).
 */
export const REPORT_RESIDUE_AFTER_MS = 8 * DAY_MS;
/**
 * A graph stamp dated further in the future than this is not "fresh": a small
 * negative age is clock skew (A6's reader treats it as fresh), a large one is
 * a bad stamp that would otherwise read fresh indefinitely.
 */
export const STAMP_SKEW_TOLERANCE_MS = 60 * 60 * 1000;
/**
 * The submit verb's `--timeout-ms`: dispatch refuses a manifest whose
 * runBudgetMs exceeds it, so it must cover the generated manifest's budget —
 * the same pricing as the DF6.1a fix-run manifest this one mirrors
 * (src/fixloop/feedback-run.ts FIX_DISPATCH_CEILING_MS, restated: fixloop's
 * constant prices fixloop's manifest, not this one).
 */
export const MAINT_DISPATCH_CEILING_MS = 2_100_000;
/** The generated manifest's run budget — fix-run.pipeline.json's pricing (one 600 s dispatch_task + a 15 s code phase). */
export const MAINT_RUN_BUDGET_MS = 1_900_000;

/** The pass's state home (`.sandbox/` structured-store convention, dispatch-log.jsonl precedent). */
export const DEFAULT_SWEEP_STATE_DIR = ".sandbox/maintenance";

// ─── vocabularies ────────────────────────────────────────────────────────────

/**
 * `refactor` — a structural (graph) signal. `chain-repair` — an audit-chain
 * signal: a broken hop or an exhausted fix loop the in-box agent investigates
 * for a code defect. (No deterministic dependency signal exists inside AC3's
 * two inputs, so no dep-bump kind is minted — see the story's Dev Agent Record.)
 */
export type HotspotKind = "refactor" | "chain-repair";

/** One code-computed candidate. `target` is charset-checked before it can reach a brief. */
export type Hotspot = {
  source: "graph" | "audit";
  kind: HotspotKind;
  /** graph: a repo-relative file path; audit: `hop:<name>` | `fixloop-exhausted`. */
  target: string;
  /** graph: production fan-in; audit: distinct closed runs carrying the signal. */
  score: number;
  /** audit: the runIds carrying the signal (sorted, capped); graph: empty. */
  runIds: string[];
};

/** Typed skip reasons — a skip is a counted outcome, never silence. */
export type SkipCode =
  | "fleet-busy"
  | "submit-in-flight"
  | "setup-gate"
  | "submit-transient"
  | "brief-rejected"
  | "ack-unrecovered"
  | "submit-failed"
  | "brief-write-failed";

const SKIP_REMEDIATION: Record<SkipCode, string> = {
  "fleet-busy": "admission refused (no headroom or cap) — the brief is re-planned on a later sweep",
  "submit-in-flight": "this request id's submit intent is stuck (in-flight or failed) — inspect .sandbox/runs/submits/<requestId>.json and `fleet status`; the id stays spoken-for until an operator clears it",
  "setup-gate": "the setup gate refused a LIVE box (INV-5 leaves it up) — inspect the roster and image, then `fleet status` / `fleet cancel` the run; the target is cooled down",
  "submit-transient": "the submit did not settle (no answer, or the engine did not start) — check `fleet status` and .sandbox/runs/submits/<requestId>.json before re-running; the target is cooled down so it is not re-briefed blind",
  "brief-rejected": "the brief or manifest failed validation — a sweep defect; file it with the brief under .sandbox/maintenance/briefs/",
  "ack-unrecovered": "the run may be live without an ack — check `fleet status`; the target is cooled down so it is not re-briefed blind",
  "submit-failed": "the fleet CLI could not run — check bun and the checkout on the host",
  "brief-write-failed": "the brief files could not be written under the state dir — check its permissions",
};

/**
 * Outcomes after which a run MAY exist without this pass holding its runId:
 * the target is cooled down exactly like a dispatched one, so the next week
 * never provisions a second box for it blind.
 */
const POSSIBLY_LIVE: ReadonlySet<string> = new Set<SkipCode>(["submit-transient", "ack-unrecovered", "submit-failed", "submit-in-flight", "setup-gate"]);

/** The graph leg's answer, as the in-lock child reports it. */
export type GraphLeg =
  | { status: "fresh"; graphAgeMs: number; hotspots: Hotspot[]; rejectedRows: number }
  | { status: "graph-stale"; graphAgeMs: number | null; verdict: string; stampPath: string }
  | { status: "refresh-in-progress" }
  | { status: "graph-unavailable"; message: string };

/** The A6 alarm the output names whenever the graph leg is refused as stale (AC3a: never a silent stale traversal). */
export const A6_ALARM =
  "A6 staleness alarm — the GitNexus refresh cron (deploy/vps/crontab.factory → scripts/gitnexus-refresh.sh) has not completed an analyze inside the 8h budget";

// ─── identity derivations ────────────────────────────────────────────────────

/** The furthest-ahead host timezone (UTC+14): a local Monday 03:17 there is Sunday 13:17 UTC. */
const MAX_TZ_LEAD_MS = 14 * 60 * 60 * 1000;

/**
 * The correlation key: the scheduled fire's window start — the UTC Monday on
 * or before `now + 14 h`, as `sweep-YYYY-MM-DD`. The 14 h lead absorbs host
 * timezones ahead of UTC (a Monday 03:17 fire on a UTC+14 box is still Sunday
 * in UTC), so the key does not depend on the host's timezone. The price of
 * that lead: a MANUAL run from Sunday 10:00 UTC onward already keys the
 * coming week (and, if it dispatches, that Monday's scheduled pass is
 * `already-swept`) — run on-demand sweeps Monday–Saturday. The wake leg
 * derives the same key from its own fire time.
 */
export function sweepIdFor(now: Date): string {
  const t = new Date(now.getTime() + MAX_TZ_LEAD_MS);
  const midnight = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const back = (new Date(midnight).getUTCDay() + 6) % 7; // days since Monday
  return `sweep-${new Date(midnight - back * DAY_MS).toISOString().slice(0, 10)}`;
}

/** Whole sweep weeks from `older` to `newer` (both sweepIds). */
function sweepWeeksBetween(older: string, newer: string): number {
  const ms = Date.parse(`${newer.slice(6)}T00:00:00Z`) - Date.parse(`${older.slice(6)}T00:00:00Z`);
  return Math.round(ms / (7 * DAY_MS));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * A deterministic UUID-v4-SHAPED id from (sweepId, workId, commitSha): the
 * submit verb's replay key. A re-fired pass for the same sweep at the same
 * commit resolves every brief to the same run instead of a second box (Q1.1's
 * replay safety, consumed); a redeploy mid-week is a different brief (new
 * commit, new manifest) and never replays a run pinned to the old commit.
 */
export function briefRequestId(sweepId: string, workId: string, commitSha: string): string {
  const h = sha256(`${sweepId}|${workId}|${commitSha}`);
  const variant = ((Number.parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Repo-relative path charset: the only shape a graph target may take into a brief. */
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;
/** The audit targets this module mints itself. */
const AUDIT_TARGET_RE = /^(?:hop:[a-z-]{1,40}|fixloop-exhausted)$/;
const RUN_ID_SAFE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Never-edit surfaces (the Jev §8 guardrails the story binds verbatim —
 * provider layer incl. classifyRunExit, AUDIT_HOPS, gate-runner verdicts,
 * classifyDiffScope — plus the approval/verification modules INV-A3-GATE
 * fences): a graph hotspot inside one is FENCED — dropped and counted, never
 * briefed — and the generated manifest's closing phase fails a run whose diff
 * touches one. That closing check is a TRIPWIRE, not a security control: it
 * runs inside the box the agent controls, so a hostile agent can defeat it
 * (rewrite history, the manifest copy, the git environment). It catches the
 * honest-mistake case early and cheaply; the controls of record stay outside
 * the box — host-side reverify and the human approve gate (INV-A3-GATE). Fan-in ranks these files highest precisely because
 * everything depends on them; that is the reason not to hand them to an
 * unattended refactor.
 */
export const FENCED_TARGET_PREFIXES: readonly string[] = [
  "src/providers/",
  "src/audit/",
  "src/reverify/",
  "src/gate/gate-runner.ts",
  "src/fixloop/feedback-run.ts",
  "src/fleet/approval-gate.ts",
  "src/fleet/approvers.ts",
  "src/fleet/push.ts",
  "src/maintenance/",
  // The task text forbids CI configuration and deployment surfaces too; the
  // tripwire carries them so the prompt is not the only place they are named.
  ".github/",
  "deploy/",
  "oci/",
  // What shapes FUTURE runs and the host's own verification: rosters and
  // pipeline manifests, and the package scripts CI and reverify invoke.
  "config/",
  "package.json",
];

export function isFencedTarget(h: Pick<Hotspot, "source" | "target">): boolean {
  return h.source === "graph" && FENCED_TARGET_PREFIXES.some((p) => h.target === p || h.target.startsWith(p));
}

/** Repeated in every task: the fence the in-box agent is told, beside the planner's and the closing phase's. */
const NEVER_EDIT =
  "Never edit: src/providers/** (the provider layer, including classifyRunExit), src/audit/** (including AUDIT_HOPS), src/reverify/**, the verdict logic in src/gate/gate-runner.ts, classifyDiffScope in src/fixloop/feedback-run.ts, the approval gate, approver, and push modules under src/fleet/, .github/, deploy/, oci/, config/, or package.json — the closing phase fails the run if the diff touches any of them.";

export function isSafeTarget(h: Pick<Hotspot, "source" | "target">): boolean {
  return h.source === "graph" ? SAFE_PATH_RE.test(h.target) : AUDIT_TARGET_RE.test(h.target);
}

/** Brief identity: the target hashes into a stable id, so the cooldown and the replay key both see "the same work". */
export function briefIdentity(sweepId: string, h: Pick<Hotspot, "kind" | "target">, commitSha: string) {
  const hash8 = sha256(h.target).slice(0, 8);
  const briefId = `${h.kind}-${hash8}`;
  const workId = `maint/${sweepId.slice("sweep-".length)}/${briefId}`;
  const workKey = WorkKeySchema.parse(`w:${workId}`);
  return { briefId, workId, workKey, requestId: briefRequestId(sweepId, workId, commitSha) };
}

// ─── graph leg: cypher markdown → hotspots ───────────────────────────────────

/**
 * The production fan-in query: DISTINCT importing files under `src/` (tests
 * live outside src/) per imported `src/` file, highest first, path as the
 * deterministic tie-break.
 */
export const FAN_IN_CYPHER = `MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.type = 'IMPORTS' AND a.filePath STARTS WITH 'src/' AND b.filePath STARTS WITH 'src/' RETURN b.filePath AS file, count(DISTINCT a) AS fanIn ORDER BY fanIn DESC, file ASC LIMIT ${String(MAX_GRAPH_HOTSPOTS)}`;

/**
 * Parse the cypher CLI's `{markdown}` table (`| file | fanIn |`). A row this
 * parser cannot fully check is dropped and counted (`rejectedRows`, surfaced
 * as `hotspots_rejected`) — an unsafe path never reaches a brief.
 */
export function parseFanInTable(markdown: string): { hotspots: Hotspot[]; rejectedRows: number } {
  const hotspots: Hotspot[] = [];
  let rejectedRows = 0;
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    // `| a | b |` splits to ["", a, b, ""]; header and separator rows are skipped.
    if (cells.length !== 4 || cells[1] === "file" || /^:?-+:?$/.test(cells[1] ?? "")) continue;
    const file = cells[1] ?? "";
    const fanIn = Number(cells[2]);
    if (!SAFE_PATH_RE.test(file) || !Number.isInteger(fanIn) || fanIn < 1) {
      rejectedRows++;
      continue;
    }
    hotspots.push({ source: "graph", kind: "refactor", target: file, score: fanIn, runIds: [] });
  }
  return { hotspots: hotspots.slice(0, MAX_GRAPH_HOTSPOTS), rejectedRows };
}

export type StalenessVerdict = { verdict: string; ageHours: number | null; stampPath: string };

/**
 * The in-lock decision (AC3a): A6's freshness verdict (parsed by the CLI —
 * the refresh surface stays out of src/, A6's AC6 boundary) gates the read.
 * Fresh means `verdict === "fresh"` AND age ≤ the 8 h budget (re-checked here
 * against the named constant, not the reader's own); anything else refuses
 * the graph leg without reading it.
 */
export function decideGraphLeg(
  staleness: StalenessVerdict | undefined,
  readGraph: () => { markdown: string } | { error: string },
): GraphLeg {
  if (staleness === undefined) return { status: "graph-unavailable", message: "staleness verdict unparseable" };
  const ageMs = staleness.ageHours === null ? null : Math.round(staleness.ageHours * 3_600_000);
  if (staleness.verdict !== "fresh" || ageMs === null || ageMs > GRAPH_STALENESS_BUDGET_MS || ageMs < -STAMP_SKEW_TOLERANCE_MS) {
    return { status: "graph-stale", graphAgeMs: ageMs, verdict: staleness.verdict, stampPath: staleness.stampPath };
  }
  const read = readGraph();
  if ("error" in read) return { status: "graph-unavailable", message: read.error };
  const parsed = parseFanInTable(read.markdown);
  return { status: "fresh", graphAgeMs: Math.max(0, ageMs), hotspots: parsed.hotspots, rejectedRows: parsed.rejectedRows };
}

/**
 * Classify the flock-wrapped child: `flock -s -n` exits 1 with NO output when
 * the refresh holds the exclusive lock; the child itself always prints one
 * JSON line and exits 0. Anything else is a named graph-unavailable, never a
 * guessed contention.
 */
export function classifyGraphChild(r: { exitCode: number; stdout: string; stderr: string }): GraphLeg {
  if (r.exitCode === 0) {
    try {
      const leg = JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as GraphLeg;
      if (leg.status === "fresh" || leg.status === "graph-stale" || leg.status === "graph-unavailable") return leg;
    } catch {
      // fall through
    }
    return { status: "graph-unavailable", message: "graph leg printed no verdict" };
  }
  if (r.exitCode === 1 && r.stdout.trim() === "" && r.stderr.trim() === "") return { status: "refresh-in-progress" };
  return { status: "graph-unavailable", message: `graph leg exited ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}` };
}

// ─── audit leg ───────────────────────────────────────────────────────────────

export type AuditDeps = {
  /** The run population (record-store listing); a throw is a counted unavailable leg. */
  listRecords(): { records: RunRecord[]; skipped: number };
  readRecord(runId: string): RunRecord;
  /** walkAuditChain + chainVerdict (on a store snapshot), reduced to the broken hop names. Throws = a walk that could not look. */
  brokenHops(runId: string): Promise<string[]>;
};

export type AuditLeg = {
  hotspots: Hotspot[];
  windowFrom: string;
  windowTo: string;
  /** Runs CLOSED inside the window. */
  runsInWindow: number;
  /** Closed in the window but never reached a PR (parked, rejected, failed, or a sweep's own brief) — not walked. */
  runsWithoutPr: number;
  runsWalked: number;
  runsNotWalked: number;
  walksFailed: number;
  /** Fix-loop ledgers that are malformed or carry an unreadable attempt record — not judged (a pruned record is not an exhausted loop). */
  ledgersIncomplete: number;
  /** Signals dropped because a hop name or runId failed the charset check — counted, never silent. */
  signalsRejected: number;
  recordsSkipped: number;
};

const MAX_EVIDENCE_RUN_IDS = 10;

/**
 * The walk population: runs CLOSED inside the window that reached a PR
 * (`extensions.pr`). A run's audit chain is only complete-able once a PR
 * exists — hop 1 (pr-run) is `broken` on every PR-less run by the walker's
 * own rules, so a parked, rejected or failed run (including a sweep's own
 * parked brief) would mint a false `hop:pr-run` brief every week and the
 * sweep would feed itself. PR-less closed runs are counted, never walked. The
 * window keys on `closedAt`, so a run created before the window and closed
 * inside it is not lost between two sweeps.
 *
 * No exit-6 signal: no run record field carries an exit code, and the only
 * per-run surface that reports 6 (`fleet result`) means "the payload could not
 * print", not "the run ended 6" (verbs.ts). The leg reports what is
 * measurable; the exit-6 hotspot has no producer to read (story Dev Record).
 */
export async function collectAuditHotspots(deps: AuditDeps, now: Date): Promise<AuditLeg> {
  const to = now.getTime();
  const from = to - SWEEP_WINDOW_MS;
  const { records, skipped } = deps.listRecords();
  const closedAt = (r: RunRecord) => (typeof r.closedAt === "string" ? Date.parse(r.closedAt) : Number.NaN);
  const windowed = records.filter((r) => {
    const t = closedAt(r);
    return Number.isFinite(t) && t >= from && t <= to;
  });
  const withPr = windowed
    .filter((r) => r.extensions?.pr !== undefined)
    .sort((a, b) => closedAt(b) - closedAt(a) || a.runId.localeCompare(b.runId));
  const walked = withPr.slice(0, MAX_WALKED_RUNS);

  const signal = new Map<string, Set<string>>();
  let signalsRejected = 0;
  const add = (target: string, runId: string) => {
    if (!AUDIT_TARGET_RE.test(target) || !RUN_ID_SAFE_RE.test(runId)) {
      signalsRejected++;
      return;
    }
    const s = signal.get(target) ?? new Set<string>();
    s.add(runId);
    signal.set(target, s);
  };
  let walksFailed = 0;
  let ledgersIncomplete = 0;

  for (const rec of walked) {
    try {
      for (const hop of new Set(await deps.brokenHops(rec.runId))) add(`hop:${hop}`, rec.runId);
    } catch {
      walksFailed++;
    }
    const ledger = rec.extensions?.fixLoop?.fixAttemptRunIds;
    if (ledger !== undefined && !(Array.isArray(ledger) && ledger.every((id) => typeof id === "string"))) {
      ledgersIncomplete++; // a malformed ledger is counted, never silently skipped
    } else if (Array.isArray(ledger) && ledger.length > 0) {
      // Every attempt record must be readable: the ladder counts a dangling id
      // as an orphaned attempt, so record PRUNING alone would read as an
      // exhausted loop. An incomplete ledger is counted, never judged.
      const readable = (ledger as string[]).every((id) => {
        try {
          deps.readRecord(id);
          return true;
        } catch {
          return false;
        }
      });
      if (!readable) {
        ledgersIncomplete++;
      } else {
        try {
          const { counts } = deriveAttemptLadder((id) => deps.readRecord(id), ledger as string[]);
          if (evaluateCeilings(counts).length > 0) add("fixloop-exhausted", rec.runId);
        } catch {
          ledgersIncomplete++; // one bad ledger never discards the leg's other signals
        }
      }
    }
  }

  const hotspots: Hotspot[] = [...signal.entries()].map(([target, runs]) => ({
    source: "audit",
    kind: "chain-repair",
    target,
    score: runs.size,
    runIds: [...runs].sort().slice(0, MAX_EVIDENCE_RUN_IDS),
  }));
  return {
    hotspots,
    windowFrom: new Date(from).toISOString(),
    windowTo: new Date(to).toISOString(),
    runsInWindow: windowed.length,
    runsWithoutPr: windowed.length - withPr.length,
    runsWalked: walked.length,
    runsNotWalked: withPr.length - walked.length,
    walksFailed,
    ledgersIncomplete,
    signalsRejected,
    recordsSkipped: skipped,
  };
}

// ─── planning ────────────────────────────────────────────────────────────────

export type PlannedBrief = Hotspot & ReturnType<typeof briefIdentity>;

/**
 * Deterministic ordering: audit hotspots (operational breakage) before graph
 * hotspots (structural coupling); within a source, score desc then target asc.
 * Unsafe, fenced, and cooled-down targets are dropped, counted; the remainder
 * past the cap is counted, never silent.
 */
export function planBriefs(
  sweepId: string,
  commitSha: string,
  hotspots: Hotspot[],
  recentlyBriefed: ReadonlySet<string>,
  cap: number = MAX_BRIEFS_PER_SWEEP,
  /** briefIds this week already holds as possibly live (a re-sweep): never re-submitted, any source. */
  heldThisWeek: ReadonlySet<string> = new Set(),
  /** briefIds a PREVIOUS sweep left possibly live: cooled down for every source (a second box must never follow blind). */
  possiblyLivePrior: ReadonlySet<string> = new Set(),
): { briefs: PlannedBrief[]; unsafe: number; fenced: number; alreadyBriefed: number; overCap: number } {
  const limit = Math.max(0, Math.min(cap, MAX_BRIEFS_PER_SWEEP) - heldThisWeek.size);
  const rank = (h: Hotspot) => (h.source === "audit" ? 0 : 1);
  const ordered = [...hotspots].sort(
    (a, b) => rank(a) - rank(b) || b.score - a.score || a.target.localeCompare(b.target),
  );
  let unsafe = 0;
  let fenced = 0;
  let alreadyBriefed = 0;
  const seen = new Set<string>();
  const eligible: PlannedBrief[] = [];
  for (const h of ordered) {
    if (!isSafeTarget(h)) {
      unsafe++;
      continue;
    }
    if (isFencedTarget(h)) {
      fenced++;
      continue;
    }
    const id = briefIdentity(sweepId, h, commitSha);
    if (seen.has(id.briefId)) continue; // the same target from two legs is one brief
    seen.add(id.briefId);
    if (heldThisWeek.has(id.briefId) || possiblyLivePrior.has(id.briefId) || (h.source === "graph" && recentlyBriefed.has(id.briefId))) {
      alreadyBriefed++;
      continue;
    }
    eligible.push({ ...h, ...id });
  }
  return {
    briefs: eligible.slice(0, limit),
    unsafe,
    fenced,
    alreadyBriefed,
    overCap: Math.max(0, eligible.length - limit),
  };
}

// ─── brief materialization ───────────────────────────────────────────────────

export type RepoIdentity = { repoSlug: string; repoUrl: string; commitSha: string };

const COMMIT_DISCIPLINE =
  "Have the fixer make the edits in this checkout and COMMIT the work on the current sandbox branch (git add + git commit) — uncommitted work is invisible to harvest. Keep the change behavior-preserving and as small as the signal warrants; if no safe improvement exists, make no change and say why. Do not push, do not open PRs, do not touch git remotes, CI configuration, or the verification surface. Finish with a JSON object of shape {\"changedFiles\": [...], \"result\": {\"summary\": \"<what changed and why>\"}}.";

/** The task text: a fixed template filled ONLY with charset-checked, code-computed values. */
export function briefTask(b: PlannedBrief): string {
  const runs = b.runIds.length === 0 ? "" : ` Runs carrying the signal: ${b.runIds.join(", ")}.`;
  let signal: string;
  if (b.source === "graph") {
    signal = `Target file: ${b.target}. The code graph ranks it among the highest production fan-in files (${b.score} importing src/ files). Look for a mechanical refactor that reduces its coupling or size — a cohesive helper extracted, an exported surface narrowed — without changing behavior.`;
  } else if (b.target.startsWith("hop:")) {
    signal = `The audit-chain hop "${b.target.slice(4)}" was reported broken on ${b.score} closed run(s) in the last 7 days.${runs} Find the code that emits or resolves this hop (search the hop name across src/ — the defect, if any, lies in an emitter or resolver outside the never-edit paths below) and fix it if it is evident from the code; if the cause is operational rather than code, make no change and explain.`;
  } else {
    signal = `${b.score} fix loop(s) in the last 7 days exhausted their attempt ceilings.${runs} Review the fix-loop ladder and brief-building path for a defect evident from the code; if none, make no change and explain.`;
  }
  return `Maintenance sweep brief (${b.kind}; deterministic ${b.source} signal). ${signal} ${NEVER_EDIT} ${COMMIT_DISCIPLINE}`;
}

/** An ERE over the fenced prefixes, for the closing phase's diff check (prefixes are fixed literals — no input reaches it). */
const FENCED_PATH_ERE = `^(${FENCED_TARGET_PREFIXES.map((p) => p.replaceAll(".", "\\.")).join("|")})`;

/**
 * The generated manifest — fix-run.pipeline.json's two-phase shape and
 * pricing. The closing phase fails the run when work was left uncommitted OR
 * when the committed diff (from the brief's pinned commit) touches a fenced
 * path — the never-edit TRIPWIRE (an in-box check the agent could defeat;
 * reverify + the human approver are the controls of record).
 */
export function briefManifest(b: PlannedBrief, commitSha: string): Record<string, unknown> {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("commitSha must be 40-hex");
  return {
    version: "1.0.0",
    pipelineId: `qds-maintenance-${b.kind}`,
    runBudgetMs: MAINT_RUN_BUDGET_MS,
    phases: [
      {
        name: "maintain",
        kind: "dispatch_task",
        description: `A3 maintenance sweep brief ${b.briefId}: one bounded investigate-and-fix pass against a code-computed hotspot; parks at the approve gate via DF3.7.`,
        roster: "config/rosters/roster.yaml",
        task: briefTask(b),
        maxDurationMs: 600_000,
        retries: 0,
      },
      {
        name: "verify-committed",
        kind: "code",
        description:
          "Fails the run when work was left uncommitted (harvest counts commits on the sandbox branch) or when the committed diff touches a never-edit path (the A3 fence's in-box tripwire; the human approver remains the control of record).",
        command: [
          "bash",
          "-c",
          // bash -c (not -lc: no box profile runs first). The diff is captured
          // BEFORE grep so a failing `git diff` fails CLOSED (an unresolvable
          // base is a refusal, never an empty pass), and --no-renames lists a
          // moved file's OLD path too, so a rename out of a fenced dir is seen.
          `test -z "$(git status --porcelain)" || { echo 'uncommitted work remains in the checkout — the maintain phase must commit everything on the sandbox branch' >&2; exit 1; }; changed=$(git -c core.quotePath=false diff --no-renames --name-only ${commitSha}..HEAD) || { echo 'the fence could not diff against the brief commit — refusing' >&2; exit 1; }; if printf '%s\n' "$changed" | grep -E '${FENCED_PATH_ERE}'; then echo 'the diff touches a never-edit path (listed above) — the A3 tripwire refuses this run' >&2; exit 1; fi; git log --oneline -1`,
        ],
        maxDurationMs: 15_000,
        retries: 0,
      },
    ],
  };
}

/** The dispatch brief (BriefSchema's headless `workId` leg — no issueId, no synthetic numbers). */
export function briefJson(b: PlannedBrief, repo: RepoIdentity, manifestPath: string): Record<string, unknown> {
  return { repoSlug: repo.repoSlug, workId: b.workId, commitSha: repo.commitSha, manifestPath, repoUrl: repo.repoUrl };
}

// ─── submit outcome classification ───────────────────────────────────────────

export type SubmitAnswer = { exitCode: number; stdout: string; stderr: string } | { timedOut: true } | { failed: string };

export type BriefOutcome =
  | { kind: "dispatched"; runId: string; state: string; replayed: boolean }
  | { kind: "skipped"; code: SkipCode; message: string };

/**
 * The ack among stdout lines: the fleet CLI also writes its JSONL log lines to
 * stdout, so the ack is found by SHAPE (schemaVersion 1 + string requestId +
 * a run-id-shaped runId), never by position.
 */
export function ackOf(stdout: string, requestId?: string): { runId: string; state: string; replayed: boolean } | undefined {
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const ack = JSON.parse(text) as Record<string, unknown>;
      if (ack.schemaVersion !== 1 || typeof ack.requestId !== "string") continue;
      if (requestId !== undefined && ack.requestId !== requestId) continue; // an ack for THIS submit, never an echoed one
      if (typeof ack.runId !== "string" || !RUN_ID_SAFE_RE.test(ack.runId)) continue;
      return {
        runId: ack.runId,
        state: typeof ack.state === "string" ? ack.state : "unknown",
        replayed: ack.replayed === true,
      };
    } catch {
      // not the ack — keep scanning
    }
  }
  return undefined;
}

const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 300);

/**
 * The submit verb's exit table (verbs.ts) folded into per-brief outcomes:
 * 5 admission refusal and 3 setup gate are COUNTED skips inside a pass that
 * still exits 0 (AC4); 5 carrying `submit-in-flight` is its own code (a stuck
 * intent needs an operator, not patience). 1 (the engine start did not land)
 * and 6 (landed, ack lost) are both replay-safe, so the caller retries ONCE
 * with the same request id before calling the brief transient/unrecovered.
 */
export function classifySubmit(a: SubmitAnswer, requestId?: string): BriefOutcome | { kind: "replay"; after: SkipCode } {
  if ("timedOut" in a) return { kind: "skipped", code: "submit-transient", message: "submit timed out — a re-run this week replays the same request id" };
  if ("failed" in a) return { kind: "skipped", code: "submit-failed", message: a.failed.slice(0, 300) };
  if (a.exitCode === 0) {
    const ack = ackOf(a.stdout, requestId);
    if (ack === undefined) return { kind: "skipped", code: "ack-unrecovered", message: "submit exited 0 with no parseable ack" };
    // `provisioned` = a box whose engine has not started: replay once (the
    // replay retries the start idempotently), never "dispatched". Any other
    // state is a run that EXISTS and is under way or past it — including a
    // replayed run that already moved on to pausing/awaiting-approval after a
    // crashed earlier pass — and is the run this brief owns.
    return ack.state === "provisioned" ? { kind: "replay", after: "submit-transient" } : { kind: "dispatched", ...ack };
  }
  if (a.exitCode === 6) return { kind: "replay", after: "ack-unrecovered" };
  if (a.exitCode === 1) return { kind: "replay", after: "submit-transient" };
  if (a.exitCode === 5) {
    return /submit-in-flight|submit-intent-corrupt/.test(a.stderr)
      ? { kind: "skipped", code: "submit-in-flight", message: tail(a.stderr) }
      : { kind: "skipped", code: "fleet-busy", message: tail(a.stderr) };
  }
  if (a.exitCode === 3) return { kind: "skipped", code: "setup-gate", message: tail(a.stderr) };
  if (a.exitCode === 2) return { kind: "skipped", code: "brief-rejected", message: tail(a.stderr) };
  return { kind: "skipped", code: "submit-failed", message: `submit exited ${a.exitCode}: ${tail(a.stderr)}` };
}

// ─── the durable report handoff ──────────────────────────────────────────────

export type BriefLine = {
  event: "brief-dispatched" | "brief-skipped";
  briefId: string;
  workKey: string;
  botId: string;
  source: Hotspot["source"];
  target: string;
  kind: HotspotKind;
  runId?: string;
  code?: SkipCode;
};

export type SweepCounters = {
  briefs_planned: number;
  briefs_dispatched: number;
  briefs_skipped: number;
  graph_stale: boolean;
  /** The graph leg's status — `graph_stale:false` alone cannot tell a fresh leg from one never read. */
  graph_leg: GraphLeg["status"];
  chain_refused: number;
  /** A re-sweep's possibly-live lines carried from the prior pass (they sit in briefs[] beside this pass's own). */
  briefs_carried?: number;
};

/** ONE record per sweep, written before exit; the wake leg delivers whichever matches its fire. */
export type SweepReport = {
  schemaVersion: 1;
  sweepId: string;
  window: { from: string; to: string };
  /** A1's config of record — never a bot name re-derived at pass time. */
  botTarget: { homeOwnerId: string; botId: string };
  report: { complete: SweepCounters; briefs: BriefLine[] };
  deliveryState: "pending" | "delivered";
  createdAt: string;
  deliveredAt?: string;
};

export const reportsDir = (stateDir: string) => join(stateDir, "sweep-reports");
const reportPath = (stateDir: string, sweepId: string) => join(reportsDir(stateDir), `${sweepId}.json`);
const SWEEP_ID_RE = /^sweep-\d{4}-\d{2}-\d{2}$/;

/** A record file sits at this week's path (whatever its content) — an unusable state dir is NOT one. */
function reportFileExists(stateDir: string, sweepId: string): boolean {
  return existsSync(reportPath(stateDir, sweepId));
}

export function persistSweepReport(stateDir: string, report: SweepReport): void {
  mkdirSync(reportsDir(stateDir), { recursive: true });
  atomicReplaceFile(reportPath(stateDir, report.sweepId), `${JSON.stringify(report, null, 2)}\n`);
}

/** A structurally complete record or undefined — a record any reader below can trust without re-checking. */
export function readSweepReport(stateDir: string, sweepId: string): SweepReport | undefined {
  if (!SWEEP_ID_RE.test(sweepId)) return undefined;
  try {
    const r = JSON.parse(readFileSync(reportPath(stateDir, sweepId), "utf8")) as SweepReport;
    const ok =
      r.schemaVersion === 1 &&
      r.sweepId === sweepId &&
      (r.deliveryState === "pending" || r.deliveryState === "delivered") &&
      Number.isFinite(Date.parse(r.createdAt)) &&
      Array.isArray(r.report?.briefs) &&
      typeof r.report?.complete?.briefs_dispatched === "number";
    return ok ? r : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The wake leg's delivery flip (the counterpart fork seam's half of the
 * contract): only a PENDING record whose sweepId matches the fire flips, so a
 * duplicate wake delivers nothing twice.
 */
export function markReportDelivered(stateDir: string, sweepId: string, now: Date): boolean {
  const r = readSweepReport(stateDir, sweepId);
  if (r === undefined || r.deliveryState !== "pending") return false;
  persistSweepReport(stateDir, { ...r, deliveryState: "delivered", deliveredAt: now.toISOString() });
  return true;
}

/**
 * Every readable report, oldest first. `unreadable` counts report files that
 * failed validation; `dirError` is set when the directory itself could not be
 * read for any reason other than not existing yet (never an empty silence).
 */
export function listSweepReports(stateDir: string): { reports: SweepReport[]; unreadable: number; dirError?: string } {
  let names: string[];
  try {
    names = readdirSync(reportsDir(stateDir));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { reports: [], unreadable: 0 } : { reports: [], unreadable: 0, dirError: String(code ?? e) };
  }
  const reports: SweepReport[] = [];
  let unreadable = 0;
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const r = readSweepReport(stateDir, name.slice(0, -".json".length));
    if (r === undefined) unreadable++;
    else reports.push(r);
  }
  return { reports, unreadable };
}

/**
 * Residue: reports still pending past REPORT_RESIDUE_AFTER_MS (the next wake
 * plus a day's grace). Never ages out. A reports dir that cannot be read, or
 * records that fail validation, are returned as `problem` so a caller can
 * surface them — an unreadable dir must never read as "no residue".
 */
export function undeliveredReportsWithProblems(stateDir: string, now: Date): { sweepIds: string[]; problem?: string } {
  const l = listSweepReports(stateDir);
  const sweepIds = l.reports
    .filter((r) => r.deliveryState === "pending" && now.getTime() - Date.parse(r.createdAt) >= REPORT_RESIDUE_AFTER_MS)
    .map((r) => r.sweepId);
  const problem =
    l.dirError !== undefined
      ? `sweep reports dir unreadable: ${l.dirError}`
      : l.unreadable > 0
        ? `${l.unreadable} sweep report record(s) failed validation`
        : undefined;
  return problem === undefined ? { sweepIds } : { sweepIds, problem };
}

export function undeliveredReports(stateDir: string, now: Date): string[] {
  return undeliveredReportsWithProblems(stateDir, now).sweepIds;
}

/**
 * runId → { botId, workKey } for every brief a sweep report says it
 * dispatched: the A1 digest's `runMeta` source, so a sweep-originated run's
 * digest line carries DD-20's botId + workKey (AC5).
 */
export function sweepRunMeta(stateDir: string): Map<string, { botId: string; workKey: string }> {
  const out = new Map<string, { botId: string; workKey: string }>();
  const conflicted = new Set<string>();
  for (const r of listSweepReports(stateDir).reports) {
    for (const b of r.report.briefs) {
      if (b.event !== "brief-dispatched" || typeof b.runId !== "string") continue;
      const prev = out.get(b.runId);
      // Two reports naming one runId with different keys: ambiguous, so never
      // attributed (the line stays fleet-only) rather than last-writer-wins.
      if (prev !== undefined && (prev.workKey !== b.workKey || prev.botId !== b.botId)) conflicted.add(b.runId);
      else out.set(b.runId, { botId: b.botId, workKey: b.workKey });
    }
  }
  for (const id of conflicted) out.delete(id);
  return out;
}

/**
 * briefIds a PREVIOUS sweep inside the cooldown dispatched — or left possibly
 * live (a timeout, a lost ack, a setup-gate box, a stuck intent): those are
 * cooled down too, so the next week never provisions a second box for the
 * target blind. (The planner applies this set to graph targets.)
 */
export function recentlyBriefed(stateDir: string, sweepId: string): Set<string> {
  const out = new Set<string>();
  for (const r of listSweepReports(stateDir).reports) {
    const weeks = sweepWeeksBetween(r.sweepId, sweepId);
    if (weeks < 1 || weeks >= REBRIEF_COOLDOWN_SWEEPS) continue;
    for (const b of r.report.briefs) {
      if (b.event === "brief-dispatched" || (b.code !== undefined && POSSIBLY_LIVE.has(b.code))) out.add(b.briefId);
    }
  }
  return out;
}

/** The possibly-live subset of `recentlyBriefed` — applied to EVERY source, audit included. */
export function possiblyLiveBriefs(stateDir: string, sweepId: string): Set<string> {
  const out = new Set<string>();
  for (const r of listSweepReports(stateDir).reports) {
    const weeks = sweepWeeksBetween(r.sweepId, sweepId);
    if (weeks < 1 || weeks >= REBRIEF_COOLDOWN_SWEEPS) continue;
    for (const b of r.report.briefs) if (b.code !== undefined && POSSIBLY_LIVE.has(b.code)) out.add(b.briefId);
  }
  return out;
}

// ─── the pass ────────────────────────────────────────────────────────────────

export type SweepDeps = {
  now(): Date;
  requestId: string;
  stateDir: string;
  repo: RepoIdentity;
  botTarget: { homeOwnerId: string; botId: string };
  /** Lower-only override of MAX_BRIEFS_PER_SWEEP (the one-box live tier runs at 1); never raises it. */
  maxBriefs?: number;
  /** The graph leg, already lock-wrapped (the CLI spawns the flock child). */
  graphLeg(): Promise<GraphLeg>;
  audit: AuditDeps;
  /** Write the brief's manifest (+ the roster beside it); returns the brief file path and the repo-relative manifest path. */
  materialize(b: PlannedBrief, manifest: Record<string, unknown>): { briefPath: string; manifestPath: string };
  /** `fleet submit --driver exedev --brief <path> --request-id <id> --timeout-ms <ceiling>`. */
  submit(briefPath: string, requestId: string): Promise<SubmitAnswer>;
  /** Persist the brief JSON at briefPath (separate so manifestPath can be known first). */
  writeBrief(briefPath: string, brief: Record<string, unknown>): void;
};

export type SweepResult =
  | { outcome: "complete"; counters: SweepCounters; reportPersisted: boolean; reportError?: string }
  | { outcome: "already-swept"; sweepId: string };

function line(requestId: string, startedAt: number, fields: Record<string, unknown>, status: "ok" | "error" = "ok"): void {
  try {
    const sweepMs = Math.max(0, Date.now() - startedAt);
    log({
      requestId,
      operation: "maintenance.sweep",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: sweepMs,
      status,
      sweep_ms: sweepMs,
      ...fields,
    });
  } catch {
    // A raising sink never replaces the pass's outcome.
  }
}

const emptyAuditLeg = (now: Date): AuditLeg => ({
  hotspots: [],
  windowFrom: new Date(now.getTime() - SWEEP_WINDOW_MS).toISOString(),
  windowTo: now.toISOString(),
  runsInWindow: 0,
  runsWithoutPr: 0,
  runsWalked: 0,
  runsNotWalked: 0,
  walksFailed: 0,
  ledgersIncomplete: 0,
  signalsRejected: 0,
  recordsSkipped: 0,
});

/**
 * Run one sweep. Never throws for a per-brief or per-leg failure — those are
 * counted outcomes. The only non-complete outcome is `already-swept`: this
 * week's report exists AND it delivered or dispatched something. A week whose
 * pass dispatched nothing (every brief refused, a mid-refresh graph) may be
 * re-run; its request ids are the same, so a submit that did land replays
 * instead of provisioning a second box.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const startedAt = Date.now();
  const now = deps.now();
  const sweepId = sweepIdFor(now);
  const rid = deps.requestId;

  const prior = readSweepReport(deps.stateDir, sweepId);
  if (prior === undefined && reportFileExists(deps.stateDir, sweepId)) {
    // This week's record exists but cannot be trusted: re-planning over it
    // could re-submit briefs it names under a new commit's request ids. Refuse.
    line(rid, startedAt, {
      event: "sweep-report-corrupt",
      sweepId,
      error: { code: "report-corrupt", message: `this week's report ${sweepId} exists but failed validation`, remediation: `inspect ${reportsDir(deps.stateDir)}/${sweepId}.json; move it aside to re-run the week` },
    }, "error");
    line(rid, startedAt, { event: "sweep-complete", sweepId, already_swept: true, report_corrupt: true });
    return { outcome: "already-swept", sweepId };
  }
  if (prior !== undefined && (prior.deliveryState === "delivered" || prior.report.complete.briefs_dispatched > 0)) {
    line(rid, startedAt, { event: "sweep-already-swept", sweepId, deliveryState: prior.deliveryState });
    line(rid, startedAt, { event: "sweep-complete", sweepId, already_swept: true, ...prior.report.complete });
    return { outcome: "already-swept", sweepId };
  }
  // A re-sweep of a zero-dispatch week: the prior pass's POSSIBLY-LIVE briefs
  // are carried into this week's record (so the cooldown never forgets them)
  // and held out of this plan, and they count against this week's cap.
  const carried = (prior?.report.briefs ?? []).filter((b) => b.code !== undefined && POSSIBLY_LIVE.has(b.code));
  const held = new Set(carried.map((b) => b.briefId));
  if (prior !== undefined) line(rid, startedAt, { event: "sweep-resweep", sweepId, prior: prior.report.complete, briefs_held: held.size });

  const listing = listSweepReports(deps.stateDir);
  if (listing.dirError !== undefined || listing.unreadable > 0) {
    line(rid, startedAt, {
      event: "sweep-reports-unreadable",
      error: {
        code: "reports-unreadable",
        message: listing.dirError ?? `${listing.unreadable} report record(s) failed validation`,
        remediation: `inspect ${reportsDir(deps.stateDir)} — an unreadable record drops out of the cooldown and the residue check`,
      },
    }, "error");
  }
  const residue = undeliveredReports(deps.stateDir, now);
  for (const id of residue) {
    line(rid, startedAt, {
      event: "sweep-report-undelivered",
      sweepId: id,
      error: {
        code: "report-undelivered",
        message: `sweep report ${id} is still pending past the next scheduled wake`,
        remediation: "the bot wake has not delivered this report — check the E21 schedule row and the Maintenance manager bot's turn log",
      },
    }, "error");
  }

  // ── graph leg (lock-wrapped, staleness-gated) ──
  let graph: GraphLeg;
  try {
    graph = await deps.graphLeg();
  } catch (e) {
    graph = { status: "graph-unavailable", message: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  if (graph.status !== "fresh") {
    line(rid, startedAt, {
      event: "sweep-leg-skipped",
      leg: "graph",
      code: graph.status,
      ...(graph.status === "graph-stale" ? { graph_age_ms: graph.graphAgeMs, verdict: graph.verdict, alarm: A6_ALARM } : {}),
      ...(graph.status === "graph-unavailable"
        ? { error: { code: "graph-unavailable", message: graph.message, remediation: "check flock and gitnexus on the host PATH (crontab prerequisites); the sweep ran audit-only" } }
        : {}),
    }, "error");
  }

  // ── audit leg (an unreadable run store is a counted, named skip) ──
  let audit: AuditLeg;
  try {
    audit = await collectAuditHotspots(deps.audit, now);
  } catch (e) {
    audit = emptyAuditLeg(now);
    line(rid, startedAt, {
      event: "sweep-leg-skipped",
      leg: "audit",
      code: "audit-unavailable",
      error: { code: "audit-unavailable", message: String((e as Error)?.message ?? e).slice(0, 300), remediation: "check the runs dir (QDS_RUNS_DIR / .sandbox/runs) is readable; the sweep ran graph-only" },
    }, "error");
  }

  // ── plan ──
  const hotspots = [...audit.hotspots, ...(graph.status === "fresh" ? graph.hotspots : [])];
  const plan = planBriefs(
    sweepId,
    deps.repo.commitSha,
    hotspots,
    recentlyBriefed(deps.stateDir, sweepId),
    deps.maxBriefs,
    held,
    possiblyLiveBriefs(deps.stateDir, sweepId),
  );
  const graphStale = graph.status === "graph-stale";
  line(rid, startedAt, {
    event: "sweep-plan",
    sweepId,
    hotspots: hotspots.length,
    briefs: plan.briefs.length,
    graph_age_ms: graph.status === "fresh" || graph.status === "graph-stale" ? graph.graphAgeMs : null,
    graph_stale: graphStale,
    graph_leg: graph.status,
    chain_window: { from: audit.windowFrom, to: audit.windowTo },
    runs_in_window: audit.runsInWindow,
    runs_walked: audit.runsWalked,
    ...(audit.runsWithoutPr === 0 ? {} : { runs_without_pr: audit.runsWithoutPr }),
    ...(audit.ledgersIncomplete === 0 ? {} : { ledgers_incomplete: audit.ledgersIncomplete }),
    ...(audit.signalsRejected === 0 ? {} : { signals_rejected: audit.signalsRejected }),
    ...(audit.runsNotWalked === 0 ? {} : { runs_not_walked: audit.runsNotWalked }),
    ...(audit.walksFailed === 0 ? {} : { walks_failed: audit.walksFailed }),
    ...(audit.recordsSkipped === 0 ? {} : { records_skipped: audit.recordsSkipped }),
    ...(graph.status === "fresh" && graph.rejectedRows > 0 ? { hotspots_rejected: graph.rejectedRows } : {}),
    ...(plan.unsafe === 0 ? {} : { hotspots_unsafe: plan.unsafe }),
    ...(plan.fenced === 0 ? {} : { hotspots_fenced: plan.fenced }),
    ...(plan.alreadyBriefed === 0 ? {} : { hotspots_already_briefed: plan.alreadyBriefed }),
    ...(plan.overCap === 0 ? {} : { hotspots_over_cap: plan.overCap }),
    ...(residue.length === 0 ? {} : { reports_undelivered: residue.length }),
  });

  // ── dispatch, one brief at a time ──
  const briefLines: BriefLine[] = [];
  let dispatched = 0;
  let skipped = 0;
  let chainRefused = 0;
  for (const b of plan.briefs) {
    const base = { briefId: b.briefId, workKey: b.workKey, botId: deps.botTarget.botId, source: b.source, target: b.target, kind: b.kind };
    let outcome: BriefOutcome;
    try {
      const { briefPath, manifestPath } = deps.materialize(b, briefManifest(b, deps.repo.commitSha));
      deps.writeBrief(briefPath, briefJson(b, deps.repo, manifestPath));
      const first = classifySubmit(await deps.submit(briefPath, b.requestId), b.requestId);
      if (first.kind === "replay") {
        const second = classifySubmit(await deps.submit(briefPath, b.requestId), b.requestId);
        outcome =
          second.kind === "replay"
            ? { kind: "skipped", code: first.after, message: "submit did not settle after one same-id replay — the run may be live; `fleet status` shows it" }
            : second;
      } else {
        outcome = first;
      }
    } catch (e) {
      outcome = { kind: "skipped", code: "brief-write-failed", message: String((e as Error)?.message ?? e).slice(0, 300) };
    }
    if (outcome.kind === "dispatched") {
      dispatched++;
      const bl: BriefLine = { event: "brief-dispatched", ...base, runId: outcome.runId };
      briefLines.push(bl);
      line(rid, startedAt, { ...bl, requestIdSubmitted: b.requestId, state: outcome.state, replayed: outcome.replayed });
    } else {
      skipped++;
      if (outcome.code === "setup-gate") chainRefused++;
      const bl: BriefLine = { event: "brief-skipped", ...base, code: outcome.code };
      briefLines.push(bl);
      line(rid, startedAt, {
        ...bl,
        requestIdSubmitted: b.requestId,
        error: { code: outcome.code, message: outcome.message, remediation: SKIP_REMEDIATION[outcome.code] },
      });
    }
  }

  const counters: SweepCounters = {
    ...(carried.length === 0 ? {} : { briefs_carried: carried.length }),
    briefs_planned: plan.briefs.length,
    briefs_dispatched: dispatched,
    briefs_skipped: skipped,
    graph_stale: graphStale,
    graph_leg: graph.status,
    chain_refused: chainRefused,
  };

  // ── the report persist is the pass's last step; a failure is recorded, never unwinds a dispatch ──
  let reportPersisted = true;
  let reportError: string | undefined;
  try {
    // A wake may have delivered the prior record while this re-sweep ran:
    // never clobber that flip back to pending. The residue clock keeps the
    // first pass's createdAt.
    const latest = prior === undefined ? undefined : readSweepReport(deps.stateDir, sweepId);
    persistSweepReport(deps.stateDir, {
      schemaVersion: 1,
      sweepId,
      window: { from: audit.windowFrom, to: audit.windowTo },
      botTarget: deps.botTarget,
      report: { complete: counters, briefs: [...briefLines, ...carried] },
      deliveryState: latest?.deliveryState ?? "pending",
      createdAt: prior?.createdAt ?? now.toISOString(),
      ...(latest?.deliveredAt === undefined ? {} : { deliveredAt: latest.deliveredAt }),
    });
  } catch (e) {
    reportPersisted = false;
    reportError = String((e as Error)?.message ?? e).slice(0, 300);
    line(rid, startedAt, {
      event: "sweep-report-failed",
      error: { code: "report-persist-failed", message: reportError, remediation: `check that ${reportsDir(deps.stateDir)} is writable; the dispatched briefs stand (their lines above carry the runIds)` },
    }, "error");
  }
  line(rid, startedAt, { event: "sweep-complete", sweepId, ...counters, ...(reportPersisted ? {} : { report_persisted: false }) });
  return { outcome: "complete", counters, reportPersisted, ...(reportError === undefined ? {} : { reportError }) };
}
