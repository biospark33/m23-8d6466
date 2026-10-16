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
 * `observeAndDriveChain`, driven by DF3.8's `fleet observe --all` sweep. This
 * module never imports the chain, the approval gate, the approver allowlist,
 * or `push.ts`, and holds no token — the fence test greps for each.
 *
 * Read-only on the audit chain (AC3c): `walkAuditChain` + `chainVerdict` are
 * consumed; `src/audit/**` is byte-identical. The walker records its own
 * first-observation digest baselines (its tamper-evidence, DF5.3) — that is
 * the walker's behavior, not a hop this module writes; this module writes no
 * audit row of any kind.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
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
/** The weekly cadence's window: the trailing 7 days of chain activity. */
export const SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Audit-leg bound: the newest N windowed runs are walked; the rest are counted, never silent. */
export const MAX_WALKED_RUNS = 20;
/**
 * Graph-leg bound: the top-N production fan-in files the query returns. Deep
 * enough that the never-edit fence (FENCED_TARGET_PREFIXES — measured on this
 * repo, 8 of the top 10 fan-in files sit behind it) still leaves candidates.
 */
export const MAX_GRAPH_HOTSPOTS = 25;
/**
 * A target briefed in the trailing 4 weeks is deferred, counted: fan-in is
 * stable week to week, and re-proposing the same parked brief every Monday is
 * the rubber-stamp failure MAX_BRIEFS_PER_SWEEP exists to prevent.
 */
export const REBRIEF_COOLDOWN_MS = 28 * 24 * 60 * 60 * 1000;
/**
 * A report still `pending` this long after its sweep is residue: the next
 * scheduled wake has come and gone without delivering it.
 */
export const REPORT_RESIDUE_AFTER_MS = SWEEP_WINDOW_MS;
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

export type HotspotKind = "refactor" | "chain-repair";

/** One code-computed candidate. `target` is charset-checked before it can reach a brief. */
export type Hotspot = {
  source: "graph" | "audit";
  kind: HotspotKind;
  /** graph: a repo-relative file path; audit: `hop:<name>` | `fixloop-exhausted` | `exit-6`. */
  target: string;
  /** graph: production fan-in; audit: distinct runs carrying the signal. */
  score: number;
  /** audit: the runIds carrying the signal (sorted, capped); graph: empty. */
  runIds: string[];
};

/** Typed skip reasons — a skip is a counted outcome, never silence. */
export type SkipCode =
  | "fleet-busy"
  | "setup-gate"
  | "submit-transient"
  | "brief-rejected"
  | "ack-unrecovered"
  | "submit-failed"
  | "brief-write-failed";

/** The graph leg's answer, as the in-lock child reports it. */
export type GraphLeg =
  | { status: "fresh"; graphAgeMs: number; hotspots: Hotspot[] }
  | { status: "graph-stale"; graphAgeMs: number | null; verdict: string; stampPath: string }
  | { status: "refresh-in-progress" }
  | { status: "graph-unavailable"; message: string };

/** The A6 alarm the output names whenever the graph leg is refused (AC3a: never a silent stale traversal). */
export const A6_ALARM =
  "A6 staleness alarm — the GitNexus refresh cron (deploy/vps/crontab.factory → scripts/gitnexus-refresh.sh) has not completed an analyze inside the 8h budget";

// ─── identity derivations ────────────────────────────────────────────────────

/**
 * The correlation key: the scheduled fire's window start — the UTC Monday on
 * or before `now`, as `sweep-YYYY-MM-DD`. The wake leg derives the same key
 * from its own fire time, so pass and wake meet without sharing a process.
 */
export function sweepIdFor(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const back = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - back);
  return `sweep-${d.toISOString().slice(0, 10)}`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * A deterministic UUID-v4-SHAPED id from (sweepId, workId): the submit verb's
 * replay key. A re-fired pass for the same sweep resolves every brief to the
 * same run instead of a second box (Q1.1's replay safety, consumed).
 */
export function briefRequestId(sweepId: string, workId: string): string {
  const h = sha256(`${sweepId}|${workId}`);
  const variant = ((Number.parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Repo-relative path charset: the only shape a graph target may take into a brief. */
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;
/** The audit targets this module mints itself. */
const AUDIT_TARGET_RE = /^(?:hop:[a-z-]{1,40}|fixloop-exhausted|exit-6)$/;
const RUN_ID_SAFE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Never-edit surfaces (the Jev §8 guardrails the story binds verbatim, plus
 * the approval modules INV-A3-GATE fences): a graph hotspot inside one is
 * FENCED — dropped and counted, never briefed. Fan-in ranks these files
 * highest precisely because everything depends on them; that is the reason
 * not to hand them to an unattended refactor.
 */
export const FENCED_TARGET_PREFIXES: readonly string[] = [
  "src/providers/",
  "src/audit/",
  "src/gate/gate-runner.ts",
  "src/fixloop/feedback-run.ts", // classifyDiffScope
  "src/fleet/approval-gate.ts",
  "src/fleet/approvers.ts",
  "src/fleet/push.ts",
  "src/maintenance/",
];

export function isFencedTarget(h: Pick<Hotspot, "source" | "target">): boolean {
  return h.source === "graph" && FENCED_TARGET_PREFIXES.some((p) => h.target === p || h.target.startsWith(p));
}

/** Repeated in every task: the fence the in-box agent is told, beside the planner's own. */
const NEVER_EDIT =
  "Never edit: src/providers/** (the provider layer), src/audit/** (including AUDIT_HOPS), the verdict logic in src/gate/gate-runner.ts, classifyRunExit, classifyDiffScope, or the approval gate and approver modules.";

export function isSafeTarget(h: Pick<Hotspot, "source" | "target">): boolean {
  return h.source === "graph" ? SAFE_PATH_RE.test(h.target) : AUDIT_TARGET_RE.test(h.target);
}

/** Brief identity: the target hashes into a stable id, so the cooldown and the replay key both see "the same work". */
export function briefIdentity(sweepId: string, h: Pick<Hotspot, "kind" | "target">) {
  const hash8 = sha256(h.target).slice(0, 8);
  const briefId = `${h.kind}-${hash8}`;
  const workId = `maint/${sweepId.slice("sweep-".length)}/${briefId}`;
  const workKey = WorkKeySchema.parse(`w:${workId}`);
  return { briefId, workId, workKey, requestId: briefRequestId(sweepId, workId) };
}

// ─── graph leg: cypher markdown → hotspots ───────────────────────────────────

/**
 * The production fan-in query: IMPORTS edges from non-test `src/` files into
 * `src/` files, highest first, path as the deterministic tie-break.
 */
export const FAN_IN_CYPHER =
  `MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.type = 'IMPORTS' AND a.filePath STARTS WITH 'src/' AND b.filePath STARTS WITH 'src/' RETURN b.filePath AS file, count(a) AS fanIn ORDER BY fanIn DESC, file ASC LIMIT ${String(MAX_GRAPH_HOTSPOTS)}`;

/**
 * Parse the cypher CLI's `{markdown}` table (`| file | fanIn |`). A row this
 * parser cannot fully check is dropped and counted — an unsafe path never
 * reaches a brief.
 */
export function parseFanInTable(markdown: string): { hotspots: Hotspot[]; rejectedRows: number } {
  const hotspots: Hotspot[] = [];
  let rejectedRows = 0;
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    // `| a | b |` splits to ["", a, b, ""]; header and separator rows are skipped.
    if (cells.length !== 4 || cells[1] === "file" || /^-+$/.test(cells[1] ?? "")) continue;
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

/**
 * The in-lock decision (AC3a): A6's freshness verdict (parsed by the CLI —
 * the refresh surface stays out of src/, A6's AC6 boundary) gates the read. Fresh
 * means `verdict === "fresh"` AND age ≤ the 8 h budget (re-checked here
 * against the named constant, not the reader's own); anything else refuses
 * the graph leg without reading it.
 */
export type StalenessVerdict = { verdict: string; ageHours: number | null; stampPath: string };

export function decideGraphLeg(
  staleness: StalenessVerdict | undefined,
  readGraph: () => { markdown: string } | { error: string },
): GraphLeg {
  if (staleness === undefined) return { status: "graph-unavailable", message: "staleness verdict unparseable" };
  const ageMs = staleness.ageHours === null ? null : Math.round(staleness.ageHours * 3_600_000);
  if (staleness.verdict !== "fresh" || ageMs === null || ageMs > GRAPH_STALENESS_BUDGET_MS) {
    return { status: "graph-stale", graphAgeMs: ageMs, verdict: staleness.verdict, stampPath: staleness.stampPath };
  }
  const read = readGraph();
  if ("error" in read) return { status: "graph-unavailable", message: read.error };
  return { status: "fresh", graphAgeMs: Math.max(0, ageMs), hotspots: parseFanInTable(read.markdown).hotspots };
}

/**
 * Classify the flock-wrapped child: `flock -s -n` exits 1 with no output when
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
  /** The run population (record-store listing); anomalies are the store's to count. */
  listRecords(): { records: RunRecord[]; skipped: number };
  readRecord(runId: string): RunRecord;
  /** walkAuditChain + chainVerdict, reduced to the broken hop names. Throws = a walk that could not look. */
  brokenHops(runId: string): Promise<string[]>;
  /** `fleet result <runId>`'s exit code — the only per-run exit-6 carrier (A1's surface fact). undefined = no answer. */
  resultExit(runId: string): Promise<number | undefined>;
};

export type AuditLeg = {
  hotspots: Hotspot[];
  windowFrom: string;
  windowTo: string;
  runsInWindow: number;
  runsWalked: number;
  runsNotWalked: number;
  walksFailed: number;
  resultsUnavailable: number;
  recordsSkipped: number;
};

const MAX_EVIDENCE_RUN_IDS = 10;

export async function collectAuditHotspots(deps: AuditDeps, now: Date): Promise<AuditLeg> {
  const to = now.getTime();
  const from = to - SWEEP_WINDOW_MS;
  const { records, skipped } = deps.listRecords();
  const windowed = records
    .filter((r) => {
      const t = Date.parse(r.createdAt);
      return Number.isFinite(t) && t >= from && t <= to;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.runId.localeCompare(b.runId));
  const walked = windowed.slice(0, MAX_WALKED_RUNS);

  const signal = new Map<string, Set<string>>();
  const add = (target: string, runId: string) => {
    if (!AUDIT_TARGET_RE.test(target) || !RUN_ID_SAFE_RE.test(runId)) return;
    const s = signal.get(target) ?? new Set<string>();
    s.add(runId);
    signal.set(target, s);
  };
  let walksFailed = 0;
  let resultsUnavailable = 0;

  for (const rec of walked) {
    try {
      for (const hop of new Set(await deps.brokenHops(rec.runId))) add(`hop:${hop}`, rec.runId);
    } catch {
      walksFailed++;
    }
    const ledger = rec.extensions?.fixLoop?.fixAttemptRunIds;
    if (Array.isArray(ledger) && ledger.length > 0 && ledger.every((id) => typeof id === "string")) {
      try {
        const { counts } = deriveAttemptLadder((id) => deps.readRecord(id), ledger as string[]);
        if (evaluateCeilings(counts).length > 0) add("fixloop-exhausted", rec.runId);
      } catch {
        walksFailed++;
      }
    }
    let exit: number | undefined;
    try {
      exit = await deps.resultExit(rec.runId);
    } catch {
      exit = undefined;
    }
    if (exit === undefined) resultsUnavailable++;
    else if (exit === 6) add("exit-6", rec.runId);
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
    runsWalked: walked.length,
    runsNotWalked: windowed.length - walked.length,
    walksFailed,
    resultsUnavailable,
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
  hotspots: Hotspot[],
  recentlyBriefed: ReadonlySet<string>,
  cap: number = MAX_BRIEFS_PER_SWEEP,
): { briefs: PlannedBrief[]; unsafe: number; fenced: number; alreadyBriefed: number; overCap: number } {
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
    const id = briefIdentity(sweepId, h);
    if (seen.has(id.briefId)) continue; // the same target from two legs is one brief
    seen.add(id.briefId);
    if (recentlyBriefed.has(id.briefId)) {
      alreadyBriefed++;
      continue;
    }
    eligible.push({ ...h, ...id });
  }
  return {
    briefs: eligible.slice(0, Math.min(cap, MAX_BRIEFS_PER_SWEEP)),
    unsafe,
    fenced,
    alreadyBriefed,
    overCap: Math.max(0, eligible.length - Math.min(cap, MAX_BRIEFS_PER_SWEEP)),
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
    signal = `The audit-chain hop "${b.target.slice(4)}" was reported broken on ${b.score} run(s) in the last 7 days.${runs} Find the code that emits or resolves this hop (search the hop name across src/ — the defect, if any, lies in an emitter or resolver outside src/audit) and fix it if it is evident from the code; if the cause is operational rather than code, make no change and explain.`;
  } else if (b.target === "exit-6") {
    signal = `${b.score} run(s) in the last 7 days ended with fleet exit 6 (the work landed but reporting or cleanup failed after it).${runs} Review the CLI's output and cleanup paths for a defect evident from the code; if none, make no change and explain.`;
  } else {
    signal = `${b.score} fix loop(s) in the last 7 days exhausted their attempt ceilings.${runs} Review the fix-loop ladder and brief-building path for a defect evident from the code; if none, make no change and explain.`;
  }
  return `Maintenance sweep brief (${b.kind}; deterministic ${b.source} signal). ${signal} ${NEVER_EDIT} ${COMMIT_DISCIPLINE}`;
}

/** The generated manifest — fix-run.pipeline.json's two-phase shape and pricing. */
export function briefManifest(b: PlannedBrief): Record<string, unknown> {
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
          "Fails the run when work was left uncommitted: harvest counts commits on the sandbox branch, so a dirty tree would silently drop the change.",
        command: [
          "bash",
          "-lc",
          "test -z \"$(git status --porcelain)\" || { echo 'uncommitted work remains in the checkout — the maintain phase must commit everything on the sandbox branch' >&2; exit 1; }; git log --oneline -1",
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

function ackOf(stdout: string): { runId: string; state: string; replayed: boolean } | undefined {
  try {
    const ack = JSON.parse(stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
    if (typeof ack.runId !== "string" || !RUN_ID_SAFE_RE.test(ack.runId)) return undefined;
    return {
      runId: ack.runId,
      state: typeof ack.state === "string" ? ack.state : "unknown",
      replayed: ack.replayed === true,
    };
  } catch {
    return undefined;
  }
}

const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 300);

/**
 * The submit verb's exit table (verbs.ts) folded into per-brief outcomes:
 * 5 admission refusal and 3 setup gate are COUNTED skips inside a pass that
 * still exits 0 (AC4); 6 = landed but the ack was lost — replay-safe, so the
 * caller retries once with the same request id before calling it unrecovered.
 */
export function classifySubmit(a: SubmitAnswer): BriefOutcome | { kind: "replay" } {
  if ("timedOut" in a) return { kind: "skipped", code: "submit-transient", message: "submit timed out — the same request id replays it next sweep" };
  if ("failed" in a) return { kind: "skipped", code: "submit-failed", message: a.failed.slice(0, 300) };
  if (a.exitCode === 0) {
    const ack = ackOf(a.stdout);
    return ack === undefined
      ? { kind: "skipped", code: "ack-unrecovered", message: "submit exited 0 with no parseable ack" }
      : { kind: "dispatched", ...ack };
  }
  if (a.exitCode === 6) return { kind: "replay" };
  if (a.exitCode === 5) return { kind: "skipped", code: "fleet-busy", message: tail(a.stderr) };
  if (a.exitCode === 3) return { kind: "skipped", code: "setup-gate", message: tail(a.stderr) };
  if (a.exitCode === 2) return { kind: "skipped", code: "brief-rejected", message: tail(a.stderr) };
  if (a.exitCode === 1) return { kind: "skipped", code: "submit-transient", message: tail(a.stderr) };
  return { kind: "skipped", code: "submit-failed", message: `submit exited ${a.exitCode}: ${tail(a.stderr)}` };
}

// ─── the durable report handoff ──────────────────────────────────────────────

export type BriefLine = {
  event: "brief-dispatched" | "brief-skipped";
  briefId: string;
  workKey: string;
  botId: string;
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
  chain_refused: number;
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

export function persistSweepReport(stateDir: string, report: SweepReport): void {
  mkdirSync(reportsDir(stateDir), { recursive: true });
  atomicReplaceFile(reportPath(stateDir, report.sweepId), `${JSON.stringify(report, null, 2)}\n`);
}

export function readSweepReport(stateDir: string, sweepId: string): SweepReport | undefined {
  if (!SWEEP_ID_RE.test(sweepId)) return undefined;
  try {
    const r = JSON.parse(readFileSync(reportPath(stateDir, sweepId), "utf8")) as SweepReport;
    return r.schemaVersion === 1 && r.sweepId === sweepId ? r : undefined;
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

/** Every readable report, oldest first. An unreadable file is skipped (counted by the caller via `unreadable`). */
export function listSweepReports(stateDir: string): { reports: SweepReport[]; unreadable: number } {
  let names: string[];
  try {
    names = readdirSync(reportsDir(stateDir));
  } catch {
    return { reports: [], unreadable: 0 };
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

/** Residue: reports still pending past REPORT_RESIDUE_AFTER_MS — the next wake came and went. */
export function undeliveredReports(stateDir: string, now: Date): string[] {
  return listSweepReports(stateDir)
    .reports.filter(
      (r) => r.deliveryState === "pending" && now.getTime() - Date.parse(r.createdAt) >= REPORT_RESIDUE_AFTER_MS,
    )
    .map((r) => r.sweepId);
}

/** briefIds dispatched by a sweep inside the cooldown — the planner's dedupe set. */
export function recentlyBriefed(stateDir: string, now: Date): Set<string> {
  const out = new Set<string>();
  for (const r of listSweepReports(stateDir).reports) {
    if (now.getTime() - Date.parse(r.createdAt) > REBRIEF_COOLDOWN_MS) continue;
    for (const b of r.report.briefs) if (b.event === "brief-dispatched") out.add(b.briefId);
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
  /** Write the brief's manifest + roster + brief files; returns the repo-relative brief + manifest paths. */
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

/**
 * Run one sweep. Never throws for a per-brief or per-leg failure — those are
 * counted outcomes; the only non-complete outcome is `already-swept` (a
 * second firing for a sweep whose report already exists).
 */
export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const startedAt = Date.now();
  const now = deps.now();
  const sweepId = sweepIdFor(now);
  const rid = deps.requestId;

  if (readSweepReport(deps.stateDir, sweepId) !== undefined) {
    line(rid, startedAt, { event: "sweep-already-swept", sweepId });
    return { outcome: "already-swept", sweepId };
  }

  const residue = undeliveredReports(deps.stateDir, now);
  for (const id of residue) {
    line(rid, startedAt, { event: "sweep-report-undelivered", sweepId: id, remediation: "the bot wake has not delivered this report — check the E21 schedule row and the Maintenance manager bot's turn log" }, "error");
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
      ...(graph.status === "graph-unavailable" ? { message: graph.message } : {}),
    }, "error");
  }

  // ── audit leg ──
  const audit = await collectAuditHotspots(deps.audit, now);

  // ── plan ──
  const hotspots = [...audit.hotspots, ...(graph.status === "fresh" ? graph.hotspots : [])];
  const plan = planBriefs(sweepId, hotspots, recentlyBriefed(deps.stateDir, now), deps.maxBriefs);
  const graphStale = graph.status === "graph-stale";
  line(rid, startedAt, {
    event: "sweep-plan",
    sweepId,
    hotspots: hotspots.length,
    briefs: plan.briefs.length,
    graph_age_ms: graph.status === "fresh" ? graph.graphAgeMs : graph.status === "graph-stale" ? graph.graphAgeMs : null,
    graph_stale: graphStale,
    graph_leg: graph.status,
    chain_window: { from: audit.windowFrom, to: audit.windowTo },
    runs_in_window: audit.runsInWindow,
    runs_walked: audit.runsWalked,
    ...(audit.runsNotWalked === 0 ? {} : { runs_not_walked: audit.runsNotWalked }),
    ...(audit.walksFailed === 0 ? {} : { walks_failed: audit.walksFailed }),
    ...(audit.resultsUnavailable === 0 ? {} : { results_unavailable: audit.resultsUnavailable }),
    ...(audit.recordsSkipped === 0 ? {} : { records_skipped: audit.recordsSkipped }),
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
    const base = { briefId: b.briefId, workKey: b.workKey, botId: deps.botTarget.botId, target: b.target, kind: b.kind };
    let outcome: BriefOutcome;
    try {
      const { briefPath, manifestPath } = deps.materialize(b, briefManifest(b));
      deps.writeBrief(briefPath, briefJson(b, deps.repo, manifestPath));
      let c = classifySubmit(await deps.submit(briefPath, b.requestId));
      if (c.kind === "replay") c = classifySubmit(await deps.submit(briefPath, b.requestId));
      outcome = c.kind === "replay" ? { kind: "skipped", code: "ack-unrecovered", message: "submit exited 6 twice — the run may be live; `fleet status` shows it" } : c;
    } catch (e) {
      outcome = { kind: "skipped", code: "brief-write-failed", message: String((e as Error)?.message ?? e).slice(0, 300) };
    }
    if (outcome.kind === "dispatched") {
      dispatched++;
      const bl: BriefLine = { event: "brief-dispatched", ...base, runId: outcome.runId };
      briefLines.push(bl);
      line(rid, startedAt, { ...bl, state: outcome.state, replayed: outcome.replayed });
    } else {
      skipped++;
      if (outcome.code === "setup-gate") chainRefused++;
      const bl: BriefLine = { event: "brief-skipped", ...base, code: outcome.code };
      briefLines.push(bl);
      line(rid, startedAt, { ...bl, message: outcome.message });
    }
  }

  const counters: SweepCounters = {
    briefs_planned: plan.briefs.length,
    briefs_dispatched: dispatched,
    briefs_skipped: skipped,
    graph_stale: graphStale,
    chain_refused: chainRefused,
  };

  // ── the report persist is the pass's last step; a failure is recorded, never unwinds a dispatch ──
  let reportPersisted = true;
  let reportError: string | undefined;
  try {
    persistSweepReport(deps.stateDir, {
      schemaVersion: 1,
      sweepId,
      window: { from: audit.windowFrom, to: audit.windowTo },
      botTarget: deps.botTarget,
      report: { complete: counters, briefs: briefLines },
      deliveryState: "pending",
      createdAt: now.toISOString(),
    });
  } catch (e) {
    reportPersisted = false;
    reportError = String((e as Error)?.message ?? e).slice(0, 300);
    line(rid, startedAt, {
      event: "sweep-report-failed",
      error: { code: "report-persist-failed", message: reportError, remediation: `check that ${reportsDir(deps.stateDir)} is writable; the dispatched briefs stand` },
    }, "error");
  }
  line(rid, startedAt, { event: "sweep-complete", sweepId, ...counters, ...(reportPersisted ? {} : { report_persisted: false }) });
  return { outcome: "complete", counters, reportPersisted, ...(reportError === undefined ? {} : { reportError }) };
}
