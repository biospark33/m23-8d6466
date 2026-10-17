/**
 * The heartbeat digest composer (A1 leaf-1.2.1) — the bounded host-side
 * observe poll behind AC2/AC3/AC5.
 *
 * ONE async invocation: observe (`fleet status --driver exedev` and per-run
 * `fleet result`, both through the CLI invoker dep — never a direct
 * `src/fleet/verbs.ts` import, never a new verb), assemble read-only, emit
 * the digest channel lines, return. No daemon, no PID file, no timer: the
 * schedule is the documented crontab line (DF3.8 precedent), owned by the CLI
 * leaf.
 *
 * ADDITIVE by construction (AC3): the only fixloop surface touched is
 * `deriveAttemptLadder`/`evaluateCeilings` — pure reads over run records. The
 * PR-scoped escalation of record stays the fixloop half's PR comment; this
 * module never names that writer (the fence test enforces it at the source
 * level) and shares no channel with it.
 *
 * AC2's import fence: DIRECT imports from `src/fleet/` are bounded to the
 * allowlist — value imports of `status.ts`/`result.ts` plus a type-only
 * `brief-schema.ts` (the fence test asserts exactly this). The fence is a
 * static import fence: transitive reach through an allowed or unrelated
 * dependency is out of its letter and rides each dependency module's own
 * story invariants. THIS MODULE currently imports none of them: the CLI is a
 * dep, rows and payload are parsed off stdout, and the one fleet vocabulary
 * word it needs (the `"(fleet)"` row id) is restated below with a comment
 * naming its owner. `src/fixloop/escalation.ts` is fixloop, not fleet, and
 * only its pure reads are imported.
 *
 * DD-20 join keys (AC5): every per-run line carries `workKey` (w: form) +
 * `runId`; `botId` is present only on manager-associated lines and ABSENT —
 * never null — on fleet-only lines; `bot_turn_spend_usd` rides manager lines
 * beside the integer `fleet_spend_micro_usd` from the factory cost-ledger,
 * the two denominations side by side and NEVER converted between each other.
 */

import type { ChildProcess } from "node:child_process";
import { log } from "../lib/log.ts";
import { withTimeout, TimeoutError } from "../providers/timeout.ts";
import { redactSecrets } from "../providers/step-log.ts";
import { killTree } from "../../scripts/lib/kill-tree.ts";
// Read-only fixloop surfaces: the ladder derivation and the ceiling check are
// pure functions over run records. The write/egress half of that module
// (the PR comment) is deliberately never imported — see the header.
import { deriveAttemptLadder, evaluateCeilings } from "../fixloop/escalation.ts";
import type { RunRecord } from "../providers/run-record.ts";
import type { CostView } from "../providers/cost-ledger.ts";
import { WorkKeySchema } from "./manager-config.ts";

// ─── the CLI seam ────────────────────────────────────────────────────────────

/** One fleet-CLI invocation's answer — piped stdout/stderr, never a TTY. */
export type CliResult = { exitCode: number; stdout: string; stderr: string };

/** The invoker dep: owns the `bun scripts/fleet.ts` prefix. Tests journal it. */
export type CliInvoker = (argv: readonly string[]) => Promise<CliResult>;

/** Per-verb budget. A wedged CLI degrades the leg to skipped, never hangs. */
export const VERB_TIMEOUT_MS = 30_000;

/**
 * A `fleetCliInvoker` invocation that outlived its budget: the child was
 * killed and this rejection (a distinct class, matched by name-shape at the
 * classify seam below) is what the invoker answers instead of a wedged wait.
 */
export class FleetVerbTimeoutError extends Error {
  constructor(
    what: string,
    readonly ms: number,
  ) {
    super(`${what} timed out after ${ms}ms — child killed`);
    this.name = "FleetVerbTimeoutError";
  }
}

/**
 * The detached children currently in flight across every invoker this
 * process has built: one process-global set so the signal handlers below
 * sweep them all. A child leaves the set the moment its invocation settles
 * (resolved, rejected, or timed out) — only a mid-flight child is ever in it.
 */
const inFlightChildren = new Set<ChildProcess>();

/**
 * Detached children sit outside the terminal's foreground group, so Ctrl-C
 * no longer reaches them — without compensation, an interrupted poll would
 * orphan the in-flight `bun` and whatever it spawned (F023 round-1 lesson,
 * `scripts/lib/mcp-stdio-client.ts`'s handlers, module-level here because
 * signals are process-global and this module has no close() seam). Wired
 * once per process; each handler drops the wiring FIRST and re-raises under
 * the default disposition — bun re-invokes an installed handler on a
 * self-raised signal (verified against 1.4.3), so the re-raise must land on
 * no handler to actually end the process.
 */
const wiredSignals: Array<[NodeJS.Signals, () => void]> = [];

function wireChildSignals(): void {
  if (wiredSignals.length > 0) return;
  const onSignal = (sig: NodeJS.Signals): void => {
    for (const [s, fn] of wiredSignals) process.removeListener(s, fn);
    wiredSignals.length = 0;
    for (const child of inFlightChildren) killTree(child, "SIGKILL");
    inFlightChildren.clear();
    try {
      process.kill(process.pid, sig); // re-raise: SIGINT stays SIGINT
    } catch {
      process.exit(1);
    }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const fn = () => onSignal(sig);
    wiredSignals.push([sig, fn]);
    process.on(sig, fn);
  }
}

/**
 * The production invoker: one `bun` child per verb, the token-free Bun.spawn
 * idiom (`src/fixloop/ci-status.ts`'s ghRunner shape) — secrets ride the
 * child environment, never argv, and this poll holds none at all. The child
 * is spawned DETACHED — its own process group — so the kill below is
 * killTree's `-pid` group sweep, which takes a wedged child's DESCENDANTS
 * with it instead of orphaning a grandchild that still holds the stdout
 * pipe (the same F024/F023 shape `scripts/lib/mcp-stdio-client.ts` ships).
 * Detaching costs terminal SIGINT delivery, which `wireChildSignals` gives
 * back. The child races a kill timer: past the budget the child is killed
 * and the in-flight promise REJECTS with `FleetVerbTimeoutError`, so a
 * wedged CLI leaks neither a process tree nor a hanging invoker.
 */
export function fleetCliInvoker(opts?: { entry?: string; timeoutMs?: number }): CliInvoker {
  const budgetMs = opts?.timeoutMs ?? VERB_TIMEOUT_MS;
  wireChildSignals();
  return async (argv) => {
    const proc = Bun.spawn(["bun", opts?.entry ?? "scripts/fleet.ts", ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      // Own process group, so killTree's `-pid` sweep reaches the child's
      // descendants. Detaching costs terminal SIGINT delivery, which is what
      // the handlers above give back (F023 round-1 lesson).
      detached: true,
    });
    const child = proc as unknown as ChildProcess;
    inFlightChildren.add(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<CliResult>((resolve, reject) => {
        timer = setTimeout(() => {
          // The house tree-kill primitive (F024) — best-effort, never throws.
          // The process is already being rejected below, so the kill's outcome
          // cannot hold the promise hostage.
          killTree(child);
          reject(new FleetVerbTimeoutError(`fleet ${argv[0]}`, budgetMs));
        }, budgetMs);
        void Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]).then(
          ([stdout, stderr, exitCode]) => resolve({ exitCode, stdout, stderr }),
          reject,
        );
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inFlightChildren.delete(child);
    }
  };
}

// ─── bounds and vocabularies ─────────────────────────────────────────────────

/** Snapshot ceiling: the oldest runs beyond it are dropped, counted, never silent. */
export const MAX_SNAPSHOT_RUNS = 50;

/** status-stdout ceiling: more parsed rows than this degrades the whole leg. */
export const MAX_STATUS_ROWS = 1000;

/** Total wall-clock budget across the poll's verbs (overridable via deps). */
export const TOTAL_BUDGET_MS = 10 * 60 * 1000;

/**
 * Per-line ceiling, the 8 KiB detail discipline the audit store applies to
 * `detail_json` (`src/audit/link-store.ts` — module-private there; restated,
 * never imported). A fat field is truncated and the line flagged, never an
 * over-budget line emitted.
 */
export const MAX_LINE_BYTES = 8192;

/**
 * The approval-park threshold: an awaiting-approval parked at least this long
 * is an escalation mark. Derived from the approval gate's 24 h default
 * timeout (`src/fleet/approval-gate.ts` DEFAULT_TIMEOUT_MS = 24*60*60*1000) —
 * re-derived as a literal, NOT imported: approval-gate.ts is outside the AC2
 * allowlist, and the fence holds even for a read-only constant. A drift
 * tripwire test reads the literal back out of that file so the two can never
 * silently diverge.
 */
export const PARK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * The escalation kinds, exactly: A1's three run-scoped kinds, plus A3's
 * adds-only `sweep-report-undelivered` — a maintenance sweep report record
 * still `pending` after the next scheduled wake came and went (the bot never
 * carried it). Sweep-scoped, not run-scoped: its mark carries `sweepId`.
 */
export const ESCALATION_KINDS = ["approval-park", "fixloop-exhausted", "exit-6", "sweep-report-undelivered"] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

/**
 * status.ts's fleet-level row id (`FLEET_ROW_ID`), restated rather than
 * imported so this module keeps zero fleet imports. Its owner names the
 * vocabulary; this comment is the join.
 */
const FLEET_ROW_ID = "(fleet)";

// ─── parsed CLI surfaces (structural: the composer trusts only what it checks) ─

/** The fields this composer reads off a `fleet status` stdout row. */
export type FleetRow = { runId: string; state: string; createdAt?: string };

/**
 * Strict JSONL row parse: one JSON object per line, each carrying a string
 * runId and state. ANY malformed line fails the whole leg — a status output
 * this module cannot fully parse is a status output it must not summarize.
 */
function parseRows(stdout: string): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("status row is not an object");
    const r = parsed as Record<string, unknown>;
    if (typeof r.runId !== "string" || typeof r.state !== "string") {
      throw new Error("status row is missing a string runId/state");
    }
    rows.push({
      runId: r.runId,
      state: r.state,
      ...(typeof r.createdAt === "string" ? { createdAt: r.createdAt } : {}),
    });
  }
  return rows;
}

// ─── deps and outcome ────────────────────────────────────────────────────────

export type DigestDeps = {
  /** The fleet CLI seam — the ONLY way this module reaches fleet state. */
  cli: CliInvoker;
  /** Run-record reads (approval state + fixloop ledger ids). Read-only. */
  readRecord(runId: string): RunRecord | undefined;
  /** The factory cost-ledger's read-only handle (integer micro-USD). */
  costLedger: { readRunCost(runId: string): CostView };
  /**
   * The gateway-ledger seam (zeropoint E08, out of factory scope): bot-turn
   * spend in USD, or undefined when the ledger carries no figure. Never a 0
   * invented here.
   */
  botTurnSpendUsd(botId: string): number | undefined;
  /**
   * Manager association for a run: botId (+ optional record-stamped workKey).
   * A1 has NO producer — every run is fleet-only until A2 lands the adds-only
   * `workKey` stamp and a botId source; the default wiring is `() => undefined`
   * and the absent-not-null rules make the absence visible, not fabricated.
   */
  runMeta(runId: string): { botId: string; workKey?: string } | undefined;
  /**
   * A3: sweepIds of maintenance sweep reports still undelivered past the next
   * wake (src/maintenance/sweep-plan.ts `undeliveredReports`). Optional and
   * adds-only: absent ⇒ no sweep marks, the A1 digest byte-identical. A
   * throwing read degrades to no marks, never a failed digest.
   */
  undeliveredSweepReports?(): string[];
  now(): Date;
  requestId(): string;
  /** Test override of VERB_TIMEOUT_MS. */
  verbTimeoutMs?: number;
  /** Test override of TOTAL_BUDGET_MS (the poll's whole wall-clock budget). */
  totalBudgetMs?: number;
};

/** A1: a pure observe poll — the CLI leaf owns config validation and argv. */
export type DigestInput = Record<string, never>;

/** The composer's outcomes, mirrored in the CLI leaf's exit table. */
export const DIGEST_EXIT = { composed: 0, statusUnavailable: 1, configRefused: 2 } as const;

export type DigestOutcome = {
  outcome: "composed" | "status-unavailable";
  exitCode: number;
  requestId: string;
  runsObserved: number;
  truncated: number;
  approvalsParked: number;
  fixloopsActive: number;
  botsAggregated: number;
  escalationMarks: number;
  /**
   * Set on status-unavailable (why the observe leg degraded) and on composed
   * when the total wall-clock budget cut result verbs short — the digest
   * still fired with partial legs, and the reason documents it.
   */
  reason?: string;
};

/** A digest channel line: the log sink's entry plus the event name. */
export type DigestLine = {
  event: string;
  requestId: string;
  operation: string;
  [k: string]: unknown;
};

// ─── the channel ─────────────────────────────────────────────────────────────

/**
 * The composer's only egress: one `managers.digest` line per event, on the
 * repo log sink (muted under bun test; tests install their own sink). Over
 * budget, the heavy string fields are capped and the line flagged — a fat
 * field never becomes a fat line (INV-MGR-5 posture: bounded, visible).
 */
function digestLine(requestId: string, fields: Record<string, unknown>): void {
  const cap = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, Math.max(0, max - 40))}[truncated, ${text.length} chars total]`;
  try {
    const base = {
      requestId,
      operation: "managers.digest",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "ok",
      ...fields,
    };
    let line: Record<string, unknown> = base;
    if (Buffer.byteLength(JSON.stringify(base)) > MAX_LINE_BYTES) {
      const capped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(base)) {
        capped[k] = typeof v === "string" && v.length > 256 ? cap(v, 256) : v;
      }
      line = { ...capped, line_truncated: true };
      // Still over (a non-string mass or a field count problem): the flagged
      // skeleton is the honest remainder, never the fat body. Accepted
      // UNREACHABLE today — every cap-able field is string-capped above, so
      // this branch guards only a future field-type change (a number or
      // object field that could mass past the cap on its own).
      if (Buffer.byteLength(JSON.stringify(line)) > MAX_LINE_BYTES) {
        line = {
          requestId,
          operation: "managers.digest",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: typeof fields.duration === "number" ? fields.duration : 0,
          status: "ok",
          event: fields.event,
          line_truncated: true,
          line_bytes: Buffer.byteLength(JSON.stringify(base)),
        };
      }
    }
    log(line as Parameters<typeof log>[0]);
  } catch {
    // A raising sink must never replace the digest's outcome.
  }
}

// ─── the poll ────────────────────────────────────────────────────────────────

/**
 * How a verb failed when it produced no CliResult at all: the per-verb budget
 * expired ("timeout") or the invoker itself could not run the child
 * ("failed", detail = the error's message).
 */
export type VerbFailure = { kind: "timeout" | "failed"; detail?: string };

/** One verb's answer: a CliResult, or the structured reason there is none. */
export type VerbAnswer = { result?: CliResult; failure?: VerbFailure };

/**
 * One CLI verb under the per-verb budget. A skipped leg carries no result —
 * the failure field carries WHY (timeout vs failed), and the degrade reasons
 * built from it distinguish the cases instead of a single "timed out" lie.
 */
async function runVerb(cli: CliInvoker, argv: readonly string[], budgetMs: number): Promise<VerbAnswer> {
  try {
    return { result: await withTimeout(Promise.resolve(cli(argv)), budgetMs, `fleet ${argv[0]}`) };
  } catch (e) {
    if (e instanceof TimeoutError || e instanceof FleetVerbTimeoutError) {
      return { failure: { kind: "timeout" } };
    }
    return { failure: { kind: "failed", detail: String((e as Error)?.message ?? e) } };
  }
}

/**
 * A redacted, capped stderr tail for a degrade reason — child stderr is
 * provider-shaped text, so it goes through the same redaction the step log
 * applies before any of it reaches the channel.
 */
function stderrTail(stderr: string | undefined): string {
  if (stderr === undefined || stderr.trim() === "") return "";
  try {
    const tail = redactSecrets(stderr).trim().slice(0, 200);
    return ` — ${tail}`;
  } catch {
    return " — unprintable";
  }
}

/**
 * Compose one digest. Invoked once, returns, exits — the caller (cron) is the
 * loop. Never throws: a degraded leg degrades the outcome, and the channel
 * always hears digest-complete.
 */
export async function composeDigest(deps: DigestDeps, _input: DigestInput): Promise<DigestOutcome> {
  const requestId = deps.requestId();
  const startedAt = deps.now().getTime();
  const budgetMs = deps.verbTimeoutMs ?? VERB_TIMEOUT_MS;
  const totalBudgetMs = deps.totalBudgetMs ?? TOTAL_BUDGET_MS;
  // Wall clock (not deps.now) is the only real duration source the verbs'
  // elapsed time can come from — deps.now may be a fixed test clock.
  const pollBeganAt = Date.now();

  // ── observe: status leg ──
  let rows: FleetRow[] | undefined;
  let statusReason: string | undefined;
  const status = await runVerb(deps.cli, ["status", "--driver", "exedev"], budgetMs);
  if (status.failure !== undefined) {
    statusReason =
      status.failure.kind === "timeout"
        ? "the fleet status invocation timed out"
        : `fleet status failed: ${(status.failure.detail ?? "unknown error").slice(0, 200)}`;
  } else if (status.result === undefined) {
    statusReason = "the fleet status invocation returned nothing";
  } else if (status.result.exitCode !== 0) {
    statusReason = `fleet status exited ${status.result.exitCode}${stderrTail(status.result.stderr)}`;
  } else {
    // Cheap pre-parse cap check: one row can come from at most one nonblank
    // line, so an over-cap line count proves an over-cap parse without paying
    // for it — the malformed-line detection below stays for under-cap stdout.
    const lineCount = status.result.stdout.split("\n").filter((l) => l.trim() !== "").length;
    if (lineCount > MAX_STATUS_ROWS) {
      statusReason = `fleet status returned ${lineCount} rows, over the cap`;
    } else {
      try {
        rows = parseRows(status.result.stdout);
      } catch (e) {
        statusReason = `fleet status stdout did not parse: ${String((e as Error)?.message ?? e)}`;
      }
    }
  }
  const observed = rows ?? [];

  // ── duplicate runIds: last occurrence wins (fleet status lists its rows
  //    newest-first), dropped count visible ──
  const seen = new Map<string, FleetRow>();
  let duplicateRowsDropped = 0;
  for (const r of observed) {
    if (seen.has(r.runId)) duplicateRowsDropped++;
    seen.set(r.runId, r);
  }
  const deduped = [...seen.values()];

  // ── the run population: record-backed runs only ──
  // Orphan rows (a box no record claims) and the fleet-level rows have no
  // record-backed runId to carry join keys with — status is where they
  // surface; the digest's population is runs. Rows the filter drops are
  // counted, never silent.
  const isRunRow = (r: FleetRow): boolean =>
    r.runId !== FLEET_ROW_ID &&
    r.state !== "orphan" &&
    r.state !== "listUnavailable" &&
    r.state !== "recordsSkipped";
  let nonRunRowsDropped = 0;
  const runs = deduped
    .filter((r) => {
      if (isRunRow(r)) return true;
      nonRunRowsDropped++;
      return false;
    })
    // Oldest first, so truncation drops the oldest and keeps the newest.
    // A missing OR unparseable createdAt sorts first — it is the row whose
    // age is least known, and status's own table reads it the same way.
    .sort((a, b) => {
      const at = (t: FleetRow): number => {
        if (t.createdAt === undefined) return Number.NEGATIVE_INFINITY;
        const parsed = Date.parse(t.createdAt);
        return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
      };
      return at(a) - at(b);
    });
  const truncated = Math.max(0, runs.length - MAX_SNAPSHOT_RUNS);
  const kept = runs.slice(runs.length - MAX_SNAPSHOT_RUNS);

  const marks: { kind: EscalationKind; runId?: string; approvalId?: string; sweepId?: string }[] = [];
  let approvalsParked = 0;
  let fixloopsActive = 0;
  let runLinesSkipped = 0;
  let resultVerbsSkipped = 0;
  let resultVerbsFailed = 0;
  let botIdsRejected = 0;
  let stampKeysInvalidated = 0;
  let malformedLedgerLegs = 0;
  const now = deps.now();

  const throwingRead = (id: string): RunRecord => {
    const rec = deps.readRecord(id);
    if (rec === undefined) throw new Error(`record unavailable: ${id}`);
    return rec;
  };

  const runLines: Record<string, unknown>[] = [];
  const botsAggregatedIds = new Set<string>();

  for (const run of kept) {
    const kinds: EscalationKind[] = [];
    // Marks are held per-run until the line actually renders: a run whose
    // workKey fails validation is skipped AFTER these blocks ran, and its
    // digest-escalation lines must not reference a digest-run that never
    // emitted.
    const runMarks: typeof marks = [];
    // Same discipline for the two per-run figures: parked and fix-active are
    // latched here and applied only past the workKey gate, so they count
    // exactly the runs whose lines rendered — matching marks, run lines, and
    // bots_aggregated.
    let parkedThisRun = false;
    let fixActiveThisRun = false;

    // ── the record (a damaged read is a record without facts, not a crash) ──
    let rec: RunRecord | undefined;
    try {
      rec = deps.readRecord(run.runId);
    } catch {
      rec = undefined;
    }
    const approval = rec?.extensions?.approval as { state?: unknown; requestedAt?: unknown; reportId?: unknown; requestId?: unknown } | undefined;

    // ── approval-park (AC threshold over requestedAt; a missing or
    //    unparseable stamp carries no threshold evidence — no mark, never a
    //    fabricated elapsed). Inclusive at the boundary, the same reading the
    //    gate's expiry oracle applies to a decision window. ──
    if (approval?.state === "awaiting-approval") {
      parkedThisRun = true;
      const requestedAt = typeof approval.requestedAt === "string" ? Date.parse(approval.requestedAt) : Number.NaN;
      if (Number.isFinite(requestedAt) && now.getTime() - requestedAt >= PARK_THRESHOLD_MS) {
        kinds.push("approval-park");
        const approvalId =
          (typeof approval.reportId === "string" && approval.reportId !== "" && approval.reportId) ||
          (typeof rec?.requestId === "string" && rec.requestId !== "" && rec.requestId) ||
          run.runId;
        runMarks.push({ kind: "approval-park", approvalId });
      }
    }

    // ── fixloop ledger (parent records carry the attempt ids; the ladder is
    //    DERIVED from each attempt's own record) ──
    const ledgerIds = rec?.extensions?.fixLoop?.fixAttemptRunIds;
    if (Array.isArray(ledgerIds) && ledgerIds.length > 0) {
      if (ledgerIds.every((id) => typeof id === "string")) {
        const { counts } = deriveAttemptLadder(throwingRead, ledgerIds as string[]);
        if (evaluateCeilings(counts).length > 0) {
          kinds.push("fixloop-exhausted");
          runMarks.push({ kind: "fixloop-exhausted", runId: run.runId });
        } else {
          fixActiveThisRun = true;
        }
      } else {
        // A ledger leg this module cannot walk (a non-string attempt id) is
        // skipped — counted, never silent.
        malformedLedgerLegs++;
      }
    }

    // ── result leg. SURFACE FACT: no run-record field and no StatusRow field
    //    carries an exit code today — the fleet CLI's exit table (verbs.ts)
    //    defines 6 per INVOCATION ("the verb's work landed but it could not
    //    finish or report it"), and the composer's own `fleet result <runId>`
    //    child is therefore the only exit-6 carrier observable per run. A
    //    future record-side producer supersedes this derivation, it does not
    //    contradict it. ──
    // result_ms stays wall-clock: Date.now is the only real duration source
    // (deps.now may be a fixed test clock).
    let resultMs: number | undefined;
    if (Date.now() - pollBeganAt >= totalBudgetMs) {
      // Past the total budget: stop issuing result verbs. The run's line keeps
      // its other facts with the result leg skipped (result_ms absent, no
      // exit-6 check) — the skip is counted, never silent.
      resultVerbsSkipped++;
    } else {
      const resultBeganAt = Date.now();
      const result = await runVerb(deps.cli, ["result", run.runId], budgetMs);
      if (result.result !== undefined) {
        // Clamped at 0 — a backward-ticking clock must not render a negative
        // duration.
        resultMs = Math.max(0, Date.now() - resultBeganAt);
        if (result.result.exitCode === 6) {
          kinds.push("exit-6");
          runMarks.push({ kind: "exit-6", runId: run.runId });
        }
      } else {
        // A result leg that produced no CliResult (timeout or spawn-fail via
        // the failure channel) is a FAILED leg, distinct from a budget-cut
        // skipped one.
        resultVerbsFailed++;
      }
    }

    // ── spend: factory ledger (integer micro-USD) beside the gateway figure
    //    (USD) — a failed ledger read is an ABSENT figure, never a 0, and the
    //    absent-not-0 seam extends across the dep boundary: a CostView with no
    //    events carries no spend to speak of, so its figure stays absent too ──
    let fleetSpendMicroUsd: number | undefined;
    try {
      const view = deps.costLedger.readRunCost(run.runId);
      if (view.hasEvents && Number.isFinite(view.totalMicroUsd)) fleetSpendMicroUsd = view.totalMicroUsd;
    } catch {
      fleetSpendMicroUsd = undefined;
    }

    // ── DD-20 join keys ──
    let botId: string | undefined;
    let botSpend: number | undefined;
    let workKey: string | undefined;
    let meta: { botId: string; workKey?: string } | undefined;
    try {
      meta = deps.runMeta(run.runId);
    } catch {
      meta = undefined; // a throwing association dep skips the association, not the poll
    }
    if (meta !== undefined) {
      // ADR-RUN-2 D1's bot- vocabulary, the same grammar the config of record
      // enforces (`/^bot-.+$/` — the bare prefix alone is not a bot id). A
      // manager association naming anything else is not a bot id this digest
      // can attribute — the whole association is skipped (the line renders
      // fleet-only) and the rejection is counted, never silent.
      if (typeof meta.botId === "string" && /^bot-.+$/.test(meta.botId)) {
        botId = meta.botId;
        try {
          botSpend = deps.botTurnSpendUsd(botId);
        } catch {
          botSpend = undefined; // a throwing gateway read is an ABSENT figure, never a 0
        }
        // bots_aggregated counts DISTINCT associated botIds, gateway figure or
        // no — added below, once the line actually renders, so the counter
        // agrees with the distinct botIds on rendered lines.
        if (typeof meta.workKey === "string") {
          // An injected stamp must pass the namespace schema; one that does
          // not falls back to the derived form rather than rendering an
          // off-namespace key — and the silent-swap is counted.
          const stamped = WorkKeySchema.safeParse(meta.workKey);
          if (stamped.success) workKey = stamped.data;
          else stampKeysInvalidated++;
        }
      } else {
        botIdsRejected++;
      }
    }
    if (workKey === undefined) {
      // The run itself is the trivial work identity under DD-20's w: namespace
      // until A2 stamps richer keys onto records — and the derived form is
      // validated like any other: a runId whose w:-form fails the schema
      // (control characters, empty remainder) SKIPS the line, it never
      // renders an invalid key.
      const derived = WorkKeySchema.safeParse(`w:${run.runId}`);
      if (!derived.success) {
        runLinesSkipped++;
        continue;
      }
      workKey = derived.data;
    }
    // The line renders: the marks this run accumulated are real, its bot
    // joins the aggregation counter, and the two latched figures apply.
    marks.push(...runMarks);
    if (parkedThisRun) approvalsParked++;
    if (fixActiveThisRun) fixloopsActive++;
    if (botId !== undefined) botsAggregatedIds.add(botId);

    runLines.push({
      event: "digest-run",
      workKey,
      runId: run.runId,
      ...(botId === undefined ? {} : { botId }),
      // A non-finite figure (a NaN an upstream ledger handed over) is ABSENT,
      // never rendered — JSON.stringify would turn it into a null.
      ...(Number.isFinite(fleetSpendMicroUsd) ? { fleet_spend_micro_usd: fleetSpendMicroUsd } : {}),
      ...(Number.isFinite(botSpend) ? { bot_turn_spend_usd: botSpend } : {}),
      ...(kinds.length === 0 ? {} : { escalation: kinds }),
      ...(resultMs === undefined ? {} : { result_ms: resultMs }),
    });
  }

  // ── A3 sweep-report residue: sweep-scoped marks, after every run mark ──
  let sweepIds: string[] = [];
  try {
    sweepIds = deps.undeliveredSweepReports?.() ?? [];
  } catch {
    sweepIds = []; // an unreadable report dir is no marks, never a failed digest
  }
  for (const sweepId of sweepIds) {
    if (typeof sweepId === "string" && /^sweep-\d{4}-\d{2}-\d{2}$/.test(sweepId)) {
      marks.push({ kind: "sweep-report-undelivered", sweepId });
    }
  }

  // ── emit: snapshot → runs → escalations → complete ──
  // duration carries the snapshot's own elapsed (clamped at 0 — a clock that
  // ticks backwards must not render a negative duration), on every line the
  // invocation produced.
  const snapshotMs = Math.max(0, deps.now().getTime() - startedAt);
  digestLine(requestId, {
    event: "digest-snapshot",
    duration: snapshotMs,
    snapshot_ms: snapshotMs,
    runs_observed: runs.length,
    approvals_parked: approvalsParked,
    fixloops_active: fixloopsActive,
    bots_aggregated: botsAggregatedIds.size,
    truncated,
    ...(statusReason === undefined ? {} : { degraded: true, reason: statusReason }),
    ...(runLinesSkipped === 0 ? {} : { run_lines_skipped: runLinesSkipped }),
    ...(nonRunRowsDropped === 0 ? {} : { non_run_rows_dropped: nonRunRowsDropped }),
    ...(duplicateRowsDropped === 0 ? {} : { duplicate_rows_dropped: duplicateRowsDropped }),
    ...(resultVerbsSkipped === 0 ? {} : { result_verbs_skipped: resultVerbsSkipped }),
    ...(resultVerbsFailed === 0 ? {} : { result_verbs_failed: resultVerbsFailed }),
    ...(botIdsRejected === 0 ? {} : { bot_ids_rejected: botIdsRejected }),
    ...(stampKeysInvalidated === 0 ? {} : { stamp_keys_invalidated: stampKeysInvalidated }),
    ...(malformedLedgerLegs === 0 ? {} : { malformed_ledger_legs: malformedLedgerLegs }),
  });
  for (const line of runLines) digestLine(requestId, { duration: snapshotMs, ...line });
  for (const mark of marks) {
    digestLine(requestId, {
      event: "digest-escalation",
      duration: snapshotMs,
      kind: mark.kind,
      ...(mark.approvalId === undefined ? {} : { approvalId: mark.approvalId }),
      ...(mark.runId === undefined ? {} : { runId: mark.runId }),
      ...(mark.sweepId === undefined ? {} : { sweepId: mark.sweepId }),
    });
  }
  digestLine(requestId, { event: "digest-complete", duration: snapshotMs });

  const budgetNote =
    resultVerbsSkipped === 0
      ? undefined
      : `${resultVerbsSkipped} result verb${resultVerbsSkipped === 1 ? "" : "s"} skipped — total wall-clock budget (${totalBudgetMs}ms) exhausted; the digest fired with partial legs`;
  const composed = statusReason === undefined;
  return {
    outcome: composed ? "composed" : "status-unavailable",
    exitCode: composed ? DIGEST_EXIT.composed : DIGEST_EXIT.statusUnavailable,
    requestId,
    runsObserved: runs.length,
    truncated,
    approvalsParked,
    fixloopsActive,
    botsAggregated: botsAggregatedIds.size,
    escalationMarks: marks.length,
    ...(composed ? (budgetNote === undefined ? {} : { reason: budgetNote }) : { reason: statusReason }),
  };
}
