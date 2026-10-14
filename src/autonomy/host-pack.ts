/**
 * Host-side judgment pack (J4) — L7 compact signal, L8 finding pre-filter,
 * pre-dispatch manifest sanity, and the generic sweep-ordering consumer seam.
 *
 * HOST-ONLY (LOCKED #1, AC1). Nothing in the box COPY set imports this file:
 * the L7 leg reaches the observe tick as an INJECTED callback
 * (`makeL7ObserveHook`, passed as `onTick` by scripts/fleet.ts), never as an
 * import from src/fleet/observe.ts. tests/autonomy/host-pack.test.ts fences it.
 *
 * RECORDING-ONLY (LOCKED #5, AC5). `PACK_SIGNALS_ARMED` is a code constant
 * and the ONLY arming path — nothing ambient (environment, config file, deps
 * flag) can arm the pack. While it is false: L7 writes no steering directive,
 * L8 returns its input order unchanged, sanity annotates nothing, and
 * `orderSweepHotspots` returns the deterministic order. Asks still happen;
 * envelopes, provenance and corpus records still land — that is the point.
 *
 * Every ask goes through J1's seam (`JudgmentClient.judge`: egress choke →
 * ceiling → strict parse → provenance emit). Questions are binary (`noul`)
 * and `choice` only — never `score`, no severity calibration (AC6). One
 * `JudgmentCeiling` per leg. Egress per leg (AC7): L7 + sanity
 * `machine-state`, L8 `finding-text`. Every refusal (egress, ceiling, schema,
 * digest divergence, busy corpus lock, any other judge failure) is a RECORDED
 * MISS — one log line carrying `miss` — and is never thrown to the caller.
 *
 * L7 MACHINE STATE — what is observable host-side mid-run, stated honestly:
 *  - The engine's journal (`$HOME/<runId>.journal.jsonl` in the box,
 *    scripts/pipeline-run.ts `--journal`) is flushed on every phase op, so a
 *    mid-run read is real. Its `resident` block, however, is written only at
 *    the pre-walk seed and again after run_end (pipeline-run.ts "the resident
 *    block on disk is still the pre-walk seed"), so mid-run the spend and
 *    steering-iteration numbers read here are the SEED values. The leg is
 *    correct against the file; the file is coarse. A per-op resident flush
 *    is engine work (box-side, re-pin owed), not this story's.
 *  - Resident RSS and context utilization have no host-observable source
 *    mid-run today: they ride as `null`, never fabricated. Thresholds
 *    evaluate only the metrics that are present.
 *
 * The state sent is numbers and ids only (`assertMachineState`): finite
 * numbers, null, or strings matching a strict id grammar, under keys that
 * match the same grammar. Anything else — conversation content, prose, nested
 * objects — is refused as a recorded miss before any request exists.
 *
 * L7 bounds (review round 1): the ask is capped by `L7_ASK_DEADLINE_MS`, so
 * journal read + ask finish inside observe's ON_TICK_DEADLINE_MS and the
 * corpus lock is released in `finally`, never orphaned. Records shard per run
 * (`<machineStateCorpusDir>/<runId>/x-rx.jsonl`); an unchanged state digest
 * (`state_ref`, tick-independent) skips the ask with a `state-unchanged` line.
 * Default dirs anchor to the factory repo root (`FACTORY_ROOT`), never cwd.
 *
 * Known ceilings, documented not fixed (round-1 DISMISS):
 *  - R1-10: thresholds compare against the catalog defaults (8,000 µ$, 3
 *    retries), not a per-run manifest override; the RunRecord carries no
 *    resident bounds host-side. Thresholds-in-code is LOCKED.
 *  - R1-18: the unarmed hook costs one probe+cat box read pair per unsettled
 *    run per pass (bounded by DEFAULT_PER_CALL_DEADLINE_MS); recording while
 *    unarmed is the point of LOCKED #5.
 *  - R1-22: a live ask in flight at CLI exit can be paid but unrecorded. The
 *    CLI wiring is mock-only (no live flag), and provenance is emitted inside
 *    `judge` before it returns.
 */

import { createHash } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  appendMachineStateRecord,
  appendRecord,
  DEFAULT_MACHINE_STATE_CORPUS_DIR,
  MachineStateRecordSchema,
  readCorpusRecords,
  TriageRecordSchema,
  type CorpusRecord,
  type Disposition,
  type MachineStateRecord,
  type TriageRecord,
} from "../../scripts/corpus/index.ts";
// DEFAULT_CORPUS_DIR / CORPUS_LOCK_ID / corpusFilePath are not on the barrel; merge.ts is import-safe (its main is import.meta.main-guarded).
import { CORPUS_LOCK_ID, DEFAULT_CORPUS_DIR, corpusFilePath } from "../../scripts/corpus/merge.ts";
import { acquireRunLock, releaseRunLock, RunLockedError, RunLockReentrantError } from "../../scripts/lib/run-lock.ts";
import type { ObserveTickInfo } from "../fleet/observe.ts";
import { DEFAULT_PER_CALL_DEADLINE_MS } from "../fleet/fanout-primitive.ts";
import {
  CeilingExceededError,
  DEFAULT_PROVENANCE_DIR,
  DEFAULT_STAGE_CEILING_INPUT_TOKENS,
  DigestDivergenceError,
  EgressRefusedError,
  JudgmentCeiling,
  JudgmentClient,
  JudgmentSchemaError,
  TYPESAFE_MODEL,
  type EgressClass,
  type JudgmentEnvelope,
  type Question,
} from "../judgment/index.ts";
import { log, newRequestId, type LogEntry } from "../lib/log.ts";
import {
  DEFAULT_MAX_STEERING_ITERATIONS,
  DEFAULT_RESIDENT_SPEND_CEILING_MICROS,
  PROVISIONAL_RESIDENT_RSS_BYTES,
} from "../phase-engine/resident-bounds.ts";
import { SteeringDirectiveSchema, type SteeringDirective } from "../phase-engine/steering.ts";
import { readBoxFile as defaultReadBoxFile } from "../providers/exedev/transport.ts";
import { TimeoutError, withTimeout } from "../providers/timeout.ts";

// ─── arming + bounds (code-pinned, AC5) ───────────────────────────────────────

/** THE arming switch. Flipping it is a reviewed PR + DD register entry + operator sign-off (AC5). */
export const PACK_SIGNALS_ARMED = false as const;

/** Serialized L7 state cap — far under the vendor's 32k-token state budget; a numbers-only state is ~400 chars. */
export const L7_ASK_STATE_MAX_CHARS = 2_000;
/** L8 finding-text cap: an over-cap finding is a recorded miss, never truncated into a different finding. */
export const L8_FINDING_MAX_CHARS = 8_000;

export const L7_EGRESS_CLASS = "machine-state" as const satisfies EgressClass;
export const L8_EGRESS_CLASS = "finding-text" as const satisfies EgressClass;
export const SANITY_EGRESS_CLASS = "machine-state" as const satisfies EgressClass;

/**
 * Bound on ONE L7 judge call (both attempts + retry delay). The hook spends at
 * most DEFAULT_PER_CALL_DEADLINE_MS (10 s, the journal probe+cat pair) plus
 * this, so it completes or gives up before observe's ON_TICK_DEADLINE_MS (60 s)
 * abandons it — no orphaned ask can hold the corpus lock past its tick.
 */
export const L7_ASK_DEADLINE_MS = 40_000;
/** Per-attempt HTTP timeout of the DEFAULT client (live mode), so a slow attempt fails inside L7_ASK_DEADLINE_MS. */
export const PACK_JUDGE_TIMEOUT_MS = 15_000;

/**
 * The factory repo root, from this module's own location — never cwd.
 * `fleet observe --all` runs with cwd = the DISPATCHED repo; default pack
 * output must not land in that repo's worktree.
 */
export const FACTORY_ROOT = resolve(import.meta.dir, "..", "..");
export const PACK_PROVENANCE_DIR = join(FACTORY_ROOT, DEFAULT_PROVENANCE_DIR);
export const PACK_MACHINE_STATE_CORPUS_DIR = join(FACTORY_ROOT, DEFAULT_MACHINE_STATE_CORPUS_DIR);
export const PACK_CORPUS_DIR = join(FACTORY_ROOT, DEFAULT_CORPUS_DIR);

export const L7_LABELER = `${TYPESAFE_MODEL}-l7-host-pack`;
/**
 * Mock-mode L8 records default to a SUBDIR of the triage corpus: ab-report
 * reads only the top-level `*.jsonl`, so mock `arm: "jev"` records can never
 * enter a measured-agreement denominator (Observability Contract).
 * L7 records carry `answer_mode` themselves.
 */
export const L8_MOCK_CORPUS_DIR = join(PACK_CORPUS_DIR, "mock");
export const L8_LABELER = `${TYPESAFE_MODEL}-l8-host-pack`;

/**
 * L7 ask thresholds — deterministic, in code, never ambient. Each one asks
 * EARLIER than the bound it shadows (AC3: a host-side nudge inside the
 * in-box substrate, which keeps its own soft_at/at/HARD_CAP untouched):
 *  - spend ≥ 75% of the resident ceiling: at the default catalog rate
 *    (~504 µ$/projected call) that leaves ~4 calls of headroom — time for a
 *    compact to matter before the 8,000 µ$ bound refuses.
 *  - any phase's accepted retry count ≥ cap − 1: one more retry hits the bound.
 *  - RSS ≥ 80% of the provisional ceiling (only when RSS is observed).
 *  - context utilization within 0.05 of the roster's own soft_at (only when both are observed).
 */
export const L7_THRESHOLDS = Object.freeze({
  spendFraction: 0.75,
  steeringIterationsBelowCap: 1,
  rssFraction: 0.8,
  contextLeadBelowSoftAt: 0.05,
});

/** An answered L7 ask "would signal" when the noul clears this AND the choice is `compact` (no cross-type arithmetic). */
export const L7_SHOULD_COMPACT_MIN = 0.5;
/** An answered L8 ask "would filter" when the noul is under this AND the choice is `dismiss`. */
export const L8_REAL_DEFECT_MIN = 0.5;

/**
 * Where the engine's journal lives in the box: `$HOME/<runId>.journal.jsonl`
 * (pipeline-run.ts derives `--journal` from HOME). The host cannot expand the
 * box's HOME through `readBoxFile` (it shell-quotes the path), so the home is
 * the unit's own user: oci/exedev/systemd/qds-run@.service `User=exedev`.
 * Injectable via `PackDeps.boxJournalPath`.
 */
export const BOX_ENGINE_HOME = "/home/exedev";
export function defaultBoxJournalPath(runId: string): string {
  return `${BOX_ENGINE_HOME}/${runId}.journal.jsonl`;
}

// ─── types ────────────────────────────────────────────────────────────────────

/** Numbers and ids only — never conversation content (I4). */
export interface ResidentMachineState {
  readonly runId: string;
  /** The tick's idempotence key — the observe sweep's requestId. */
  readonly tickKey: string;
  readonly spendMicros: number | null;
  readonly spendCeilingMicros: number;
  /** Max accepted retry count across phases. */
  readonly steeringIterationsMax: number | null;
  readonly steeringIterationCap: number;
  readonly rssBytes: number | null;
  readonly rssCeilingBytes: number;
  readonly contextUtilization: number | null;
  readonly compactSoftAt: number | null;
}

/** A QA hunter-pack finding as L8 receives it. Only `author: "factory"` text may egress. */
export interface PackFinding {
  readonly findingId: string;
  readonly runId: string;
  readonly lens: string;
  readonly text: string;
  readonly author: string;
}

/** Dispatch-manifest machine state for the sanity leg: counts, ids, numbers only. */
export type SanityManifest = Readonly<Record<string, number | string | null>>;

export interface SweepHotspot {
  readonly path: string;
  readonly brief: string;
  readonly score: number;
}
export interface SweepRanker {
  rank(h: readonly SweepHotspot[]): Promise<readonly SweepHotspot[]>;
}

/** Judge seam: the real JudgmentClient or a structural stand-in. `mode` flags mock envelopes on every line/record. */
export interface Judge {
  readonly mode: "live" | "mock";
  judge: JudgmentClient["judge"];
}

export type SteeringWriter = (runId: string, directive: SteeringDirective) => void | Promise<void>;

export interface PackDeps {
  /** Default: a mock-default JudgmentClient on `provenanceDir`. */
  client?: Judge;
  /** Provenance side-channel dir for the default client. Default PACK_PROVENANCE_DIR. Tests MUST set it. */
  provenanceDir?: string;
  /** L7 records (sharded per run beneath it). Default PACK_MACHINE_STATE_CORPUS_DIR. Tests MUST set it. */
  machineStateCorpusDir?: string;
  /** L8 records. Default PACK_CORPUS_DIR (live) / L8_MOCK_CORPUS_DIR (mock). Tests MUST set it. */
  corpusDir?: string;
  log?: (entry: LogEntry) => void;
  now?: () => number;
  /** Receives a compact directive ONLY when armed. Never called while PACK_SIGNALS_ARMED is false. */
  writeSteering?: SteeringWriter;
  readBoxFile?: typeof defaultReadBoxFile;
  boxJournalPath?: (runId: string) => string;
  /** Per-leg ceiling (input tokens). Default 1M. */
  ceilingTokens?: number;
  /** Override of L7_ASK_DEADLINE_MS (tests). */
  l7AskDeadlineMs?: number;
}

/** Resolved deps: one context per hook/caller, so each leg's ceiling persists across its asks. */
export interface PackContext {
  readonly client: Judge;
  readonly machineStateCorpusDir: string;
  readonly corpusDir: string;
  readonly log: (entry: LogEntry) => void;
  readonly now: () => number;
  readonly writeSteering: SteeringWriter | undefined;
  readonly readBoxFile: typeof defaultReadBoxFile;
  readonly boxJournalPath: (runId: string) => string;
  readonly l7AskDeadlineMs: number;
  readonly ceilings: { readonly l7: JudgmentCeiling; readonly l8: JudgmentCeiling; readonly sanity: JudgmentCeiling };
}

export function packContext(deps: PackDeps = {}): PackContext {
  const tokens = deps.ceilingTokens ?? DEFAULT_STAGE_CEILING_INPUT_TOKENS;
  const client = deps.client ?? new JudgmentClient({ provenanceDir: deps.provenanceDir ?? PACK_PROVENANCE_DIR, timeoutMs: PACK_JUDGE_TIMEOUT_MS });
  return {
    client,
    machineStateCorpusDir: deps.machineStateCorpusDir ?? PACK_MACHINE_STATE_CORPUS_DIR,
    corpusDir: deps.corpusDir ?? (client.mode === "mock" ? L8_MOCK_CORPUS_DIR : PACK_CORPUS_DIR),
    log: deps.log ?? log,
    now: deps.now ?? Date.now,
    writeSteering: deps.writeSteering,
    readBoxFile: deps.readBoxFile ?? defaultReadBoxFile,
    boxJournalPath: deps.boxJournalPath ?? defaultBoxJournalPath,
    l7AskDeadlineMs: deps.l7AskDeadlineMs ?? L7_ASK_DEADLINE_MS,
    ceilings: { l7: new JudgmentCeiling(tokens), l8: new JudgmentCeiling(tokens), sanity: new JudgmentCeiling(tokens) },
  };
}

// ─── questions (noul + choice only, AC6) ──────────────────────────────────────

export const L7_QUESTIONS = {
  should_compact: {
    type: "noul",
    instructions:
      "From these resident-orchestrator machine metrics alone (spend vs its ceiling, retry counts vs their cap, memory and context use where present; null means not observed), should the resident compact its context now?",
  },
  compact_choice: {
    type: "choice",
    instructions: "Which action fits these resident metrics at this observe tick?",
    criteria: {
      compact: "compact the resident's carried context at the next allowed steering point",
      "no-compact": "leave the resident's context as it is",
    },
  },
} as const satisfies Record<string, Question>;

export const L8_QUESTIONS = {
  is_real_defect: {
    type: "noul",
    instructions:
      "Judge ONLY the factory-authored QA finding in the state: is it a real defect — a genuine bug, vulnerability, or broken contract? Style preferences, hypotheticals, and code that already behaves correctly are not real defects.",
  },
  disposition: {
    type: "choice",
    instructions: "If this finding went to deep adjudication, what should happen next to it?",
    criteria: {
      patch: "fix it within this change before merge",
      dismiss: "not actionable — close it without a fix",
      "gate-action": "hold the merge pending a decision or action outside this change",
    },
  },
} as const satisfies Record<string, Question>;

export const SANITY_QUESTIONS = {
  manifest_consistent: {
    type: "noul",
    instructions:
      "From these dispatch-manifest counts, ids and numbers alone, is the manifest internally consistent (no count, budget or bound that contradicts another)?",
  },
} as const satisfies Record<string, Question>;

const L8_DISPOSITION_BY_CHOICE: Readonly<Record<string, Disposition>> = {
  patch: "PATCH",
  dismiss: "DISMISS",
  "gate-action": "GATE_ACTION",
};

// ─── pure pieces ──────────────────────────────────────────────────────────────

/** Strict id grammar for strings allowed in machine state: no spaces, no prose. */
export const MACHINE_STATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/** Throws on anything but finite numbers / null / id strings (flat). The machine-state legs' pack-side egress validator. */
export function assertMachineState(state: unknown): void {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new EgressRefusedError("machine-state refused: state must be a flat object", "machine-state");
  }
  for (const [k, v] of Object.entries(state)) {
    if (!MACHINE_STATE_ID_RE.test(k)) {
      throw new EgressRefusedError("machine-state refused: a key is not an id (prose in a key name)", "machine-state");
    }
    const ok =
      v === null ||
      (typeof v === "number" && Number.isFinite(v)) ||
      (typeof v === "string" && MACHINE_STATE_ID_RE.test(v));
    if (!ok) {
      throw new EgressRefusedError(`machine-state refused: field "${k}" is not a finite number, null, or id`, "machine-state");
    }
  }
}

/** Deterministic, code-pinned ask decision over the PRESENT metrics only. */
export function l7ShouldAsk(s: ResidentMachineState): boolean {
  const t = L7_THRESHOLDS;
  if (s.spendMicros !== null && s.spendMicros >= s.spendCeilingMicros * t.spendFraction) return true;
  if (s.steeringIterationsMax !== null && s.steeringIterationsMax >= s.steeringIterationCap - t.steeringIterationsBelowCap) return true;
  if (s.rssBytes !== null && s.rssBytes >= s.rssCeilingBytes * t.rssFraction) return true;
  if (s.contextUtilization !== null && s.compactSoftAt !== null && s.contextUtilization >= s.compactSoftAt - t.contextLeadBelowSoftAt) {
    return true;
  }
  return false;
}

/** The only directive the armed L7 leg may write: schema-parsed, never raw NDJSON. */
export function compactDirective(note?: string): SteeringDirective {
  return SteeringDirectiveSchema.parse(note === undefined ? { action: "compact" } : { action: "compact", note });
}

/** Deterministic hotspot order: score desc, then path asc. */
function deterministicOrder(h: readonly SweepHotspot[]): SweepHotspot[] {
  return [...h].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The generic sweep consumer seam. Ranker absent OR pack unarmed ⇒ the
 * deterministic order. A present ranker is still invoked while unarmed (so
 * its asks are recorded) — its ordering is discarded, and its failure never
 * reaches the consumer.
 */
export async function orderSweepHotspots(h: readonly SweepHotspot[], ranker?: SweepRanker): Promise<readonly SweepHotspot[]> {
  const order = deterministicOrder(h);
  if (ranker === undefined) return order;
  try {
    const ranked = await ranker.rank(order);
    if (PACK_SIGNALS_ARMED) return ranked;
  } catch {
    // a ranker failure is the fallback working: deterministic order
  }
  return order;
}

function missReason(e: unknown): string {
  if (e instanceof EgressRefusedError) return "egress-refused";
  if (e instanceof CeilingExceededError) return "ceiling-exceeded";
  if (e instanceof JudgmentSchemaError) return "schema-error";
  if (e instanceof DigestDivergenceError) return "digest-divergence";
  if (e instanceof RunLockedError || e instanceof RunLockReentrantError) return "corpus-locked";
  if (e instanceof CorpusUnreadableError) return "corpus-unreadable";
  if (e instanceof TimeoutError) return "ask-deadline";
  return "judge-failed";
}

/** A corpus file with a torn or schema-invalid line: an operator fact, its own miss reason. */
class CorpusUnreadableError extends Error {
  constructor(file: string, cause: unknown) {
    super(`corpus file ${file} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CorpusUnreadableError";
  }
}

function readCorpusOrThrow(file: string): CorpusRecord[] {
  try {
    return readCorpusRecords(file);
  } catch (e) {
    throw new CorpusUnreadableError(file, e);
  }
}

type Leg = "l7" | "l8" | "sanity";
const EVENT: Record<Leg, string> = { l7: "l7-ask", l8: "l8-filter", sanity: "sanity-check" };
const EGRESS: Record<Leg, EgressClass> = { l7: L7_EGRESS_CLASS, l8: L8_EGRESS_CLASS, sanity: SANITY_EGRESS_CLASS };

/** One pack line (Observability Contract) on the house LogEntry shape. A sink fault never breaks a leg. */
function packLine(
  ctx: PackContext,
  leg: Leg,
  requestId: string,
  started: number,
  extra: { answer?: Record<string, unknown>; would_signal?: boolean; miss?: string; [k: string]: unknown },
): void {
  const now = ctx.now();
  try {
    ctx.log({
      requestId,
      operation: EVENT[leg],
      agentId: null,
      timestamp: new Date(now).toISOString(),
      duration: now - started,
      status: extra.miss === undefined ? "ok" : "error",
      event: EVENT[leg],
      leg,
      egress_class: EGRESS[leg],
      armed: PACK_SIGNALS_ARMED,
      answer_mode: ctx.client.mode,
      latency_ms: now - started,
      ...extra,
    });
  } catch {
    // the log sink must never break a recording-only leg
  }
}

function noulOf(env: JudgmentEnvelope, id: string): number {
  const a = env.answers[id];
  if (a === undefined || a.type !== "noul") throw new JudgmentSchemaError(`envelope has no noul answer for "${id}"`, env.requestId, "");
  return a.noul;
}
function choiceOf(env: JudgmentEnvelope, id: string, allowed: readonly string[]): string {
  const a = env.answers[id];
  if (a === undefined || a.type !== "choice") throw new JudgmentSchemaError(`envelope has no choice answer for "${id}"`, env.requestId, "");
  if (!allowed.includes(a.choice)) throw new JudgmentSchemaError(`choice "${a.choice}" is not an asked criterion`, env.requestId, "");
  return a.choice;
}

/** Was this key already recorded by this labeler? (Avoids a second PAID ask; appendRecord's dedupe is the at-most-once backstop.) */
function alreadyRecorded(dir: string, findingId: string, labeler: string): boolean {
  return readCorpusOrThrow(corpusFilePath(dir, null, null)).some((r) => r.finding_id === findingId && r.labeler === labeler);
}

/** The lock is released in `finally` on every path, including a rejected or deadline-abandoned ask. */
async function withCorpusLock<T>(dir: string, holder: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lock = acquireRunLock(dir, CORPUS_LOCK_ID, holder);
  try {
    return await fn();
  } finally {
    releaseRunLock(lock);
  }
}

/** Per-run shard of the machine-state corpus: one file never grows across runs. */
export function l7ShardDir(machineStateCorpusDir: string, runId: string): string {
  return join(machineStateCorpusDir, runId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/** Tick-independent digest of the state (tickKey excluded), so an unchanged state across sweeps is detectable. */
export function l7StateRef(state: ResidentMachineState): string {
  const stable = Object.fromEntries(Object.entries(state).filter(([k]) => k !== "tickKey"));
  return `machine-state:sha256:${createHash("sha256").update(JSON.stringify(stable)).digest("hex")}`;
}

// ─── L7 ───────────────────────────────────────────────────────────────────────

export type L7Result =
  | { kind: "not-asked" }
  | { kind: "duplicate" }
  | { kind: "state-unchanged" }
  | { kind: "miss"; reason: string }
  | { kind: "asked"; envelope: JudgmentEnvelope; wouldSignal: boolean; record: MachineStateRecord };

/**
 * One L7 ask for one resident at one tick. Below every threshold ⇒ nothing
 * asked, nothing logged. Idempotent on `${runId}@${tickKey}`; a state whose
 * digest equals the run's last recorded `state_ref` is not re-asked (one
 * `state-unchanged` line). A torn shard is set aside (renamed, kept for the
 * operator) after its `corpus-unreadable` miss, so the next tick can record.
 */
export async function l7Ask(ctx: PackContext, state: ResidentMachineState): Promise<L7Result> {
  const started = ctx.now();
  let requestId = newRequestId();
  try {
    assertMachineState(state);
    const stateText = JSON.stringify(state);
    if (stateText.length > L7_ASK_STATE_MAX_CHARS) {
      throw new EgressRefusedError(`machine-state refused: ${stateText.length} chars over L7_ASK_STATE_MAX_CHARS`, "machine-state");
    }
    if (!l7ShouldAsk(state)) return { kind: "not-asked" };
    const findingId = `${state.runId}@${state.tickKey}`;
    const shard = l7ShardDir(ctx.machineStateCorpusDir, state.runId);
    const stateRef = l7StateRef(state);
    return await withCorpusLock(shard, "l7 host-pack", async (): Promise<L7Result> => {
      const file = corpusFilePath(shard, null, null);
      let prior: CorpusRecord[];
      try {
        prior = readCorpusOrThrow(file);
      } catch (e) {
        // ponytail: set the torn shard aside so one bad line costs one miss, not the run's leg; the file is kept for the operator.
        try {
          renameSync(file, `${file}.unreadable-${ctx.now()}`);
        } catch {
          // a failed rename leaves the next tick to miss again — still a recorded miss, never a throw
        }
        throw e;
      }
      const mine = prior.filter((r) => r.labeler === L7_LABELER && r.finding_id.startsWith(`${state.runId}@`));
      if (mine.some((r) => r.finding_id === findingId)) return { kind: "duplicate" };
      const last = mine.at(-1);
      if (last !== undefined && "state_ref" in last && last.state_ref === stateRef) {
        packLine(ctx, "l7", requestId, started, { skip: "state-unchanged", state_ref: stateRef, runId: state.runId });
        return { kind: "state-unchanged" };
      }
      const envelope = await withTimeout(
        ctx.client.judge(state, L7_QUESTIONS, { egressClass: L7_EGRESS_CLASS, ceiling: ctx.ceilings.l7 }),
        ctx.l7AskDeadlineMs,
        `l7 ask (${state.runId})`,
      );
      requestId = envelope.requestId;
      const shouldCompact = noulOf(envelope, "should_compact");
      const choice = choiceOf(envelope, "compact_choice", ["compact", "no-compact"]);
      const wouldSignal = shouldCompact >= L7_SHOULD_COMPACT_MIN && choice === "compact";
      const record = MachineStateRecordSchema.parse({
        finding_id: findingId,
        state_ref: stateRef,
        label: wouldSignal ? "would-signal" : "would-hold",
        disposition: choice,
        rationale: `jev: should_compact=${shouldCompact}; compact_choice=${choice}`,
        labeler: L7_LABELER,
        answer_mode: ctx.client.mode,
        pr: null,
        round: null,
        created_at: envelope.created_at,
        latency_ms: Math.round(envelope.latency_ms),
      });
      appendMachineStateRecord(shard, record);
      if (PACK_SIGNALS_ARMED && wouldSignal) {
        // Unreachable in the merged default. When armed, the ONLY write is a schema-parsed compact directive.
        if (ctx.writeSteering === undefined) {
          packLine(ctx, "l7", requestId, started, { miss: "no-steering-writer", runId: state.runId });
        } else {
          await ctx.writeSteering(state.runId, compactDirective(`l7 host-pack ${findingId}`));
        }
      }
      packLine(ctx, "l7", requestId, started, {
        answer: { should_compact: shouldCompact, compact_choice: choice },
        would_signal: wouldSignal,
        runId: state.runId,
      });
      return { kind: "asked", envelope, wouldSignal, record };
    });
  } catch (e) {
    const reason = missReason(e);
    packLine(ctx, "l7", requestId, started, { miss: reason, runId: state.runId });
    return { kind: "miss", reason };
  }
}

/** The journal's resident block, as much of it as L7 reads. Lenient on everything else. */
const JournalResidentSchema = z.object({
  resident: z
    .object({
      status: z.string(),
      spendMicros: z.number().finite().nonnegative(),
      steeringIterations: z.record(z.number().int().nonnegative()),
    })
    .passthrough(),
});

/**
 * The observe hook (interface I3's `onTick`): read the resident block of the
 * box journal, build the numbers-only state, ask L7. Never throws. A cleanly
 * absent journal, a journal with no resident block, or a resident that is not
 * `active` is silence. `active` is the only live status: `degraded` is a
 * one-way latch (steering.ts: nothing writes "active" back, the resident is
 * never solicited again), `stopped` is past run_end, `disabled` never ran —
 * a compact signal could reach none of them. An unproven absence (the probe
 * never answered), an unreadable/unparseable journal, or a resident block
 * that fails its schema is a recorded miss.
 */
export function makeL7ObserveHook(deps: PackDeps = {}): (info: ObserveTickInfo) => Promise<void> {
  const ctx = packContext(deps);
  return async (info) => {
    const started = ctx.now();
    try {
      const read = await ctx.readBoxFile(info.driver, info.vm, ctx.boxJournalPath(info.runId), DEFAULT_PER_CALL_DEADLINE_MS);
      if (read.kind === "absent") {
        // probeExit 1 (or none) is `test -f` saying "not there"; 255/137/… means the box never answered.
        if (read.probeExit !== undefined && read.probeExit !== 1) {
          packLine(ctx, "l7", newRequestId(), started, { miss: "journal-absent-unproven", probe_exit: read.probeExit, runId: info.runId });
        }
        return;
      }
      if (read.kind !== "content") {
        packLine(ctx, "l7", newRequestId(), started, { miss: `journal-${read.kind}`, runId: info.runId });
        return;
      }
      const doc: unknown = JSON.parse(read.content);
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        packLine(ctx, "l7", newRequestId(), started, { miss: "journal-unparseable", runId: info.runId });
        return;
      }
      // No resident block: no resident to nudge.
      if (!("resident" in doc) || doc.resident === undefined || doc.resident === null) return;
      const parsed = JournalResidentSchema.safeParse(doc);
      if (!parsed.success) {
        packLine(ctx, "l7", newRequestId(), started, { miss: "resident-block-invalid", runId: info.runId });
        return;
      }
      const r = parsed.data.resident;
      if (r.status !== "active") return;
      const iterations = Object.values(r.steeringIterations);
      await l7Ask(ctx, {
        runId: info.runId,
        tickKey: info.sweepRequestId,
        spendMicros: r.spendMicros,
        spendCeilingMicros: DEFAULT_RESIDENT_SPEND_CEILING_MICROS,
        steeringIterationsMax: iterations.length === 0 ? 0 : Math.max(...iterations),
        steeringIterationCap: DEFAULT_MAX_STEERING_ITERATIONS,
        rssBytes: null,
        rssCeilingBytes: PROVISIONAL_RESIDENT_RSS_BYTES,
        contextUtilization: null,
        compactSoftAt: null,
      });
    } catch (e) {
      packLine(ctx, "l7", newRequestId(), started, { miss: e instanceof SyntaxError ? "journal-unparseable" : "journal-read-failed", runId: info.runId });
    }
  };
}

// ─── L8 ───────────────────────────────────────────────────────────────────────

/**
 * Pre-filter factory-authored QA findings before deep adjudication. One ask
 * per finding; one TriageRecord per answered finding. Returns the INPUT
 * ORDER unchanged while unarmed — the would-be kept set is only logged.
 */
export async function l8Prefilter(ctx: PackContext, findings: readonly PackFinding[]): Promise<readonly PackFinding[]> {
  const unchanged = [...findings];
  // Only an ANSWERED would-filter enters this set: a miss, a refusal, a lock failure or an
  // already-recorded finding is never filtered (fail-open to deep adjudication).
  const filtered = new Set<string>();
  const key = (f: PackFinding): string => `${f.runId}/${f.findingId}`;
  const started = ctx.now();
  try {
    await withCorpusLock(ctx.corpusDir, "l8 host-pack", async () => {
      for (const f of findings) {
        const t0 = ctx.now();
        let requestId = newRequestId();
        const findingId = key(f);
        try {
          if (f.author !== "factory") {
            throw new EgressRefusedError(`finding-text refused: author "${f.author}" is not factory (INV-7 fence)`, "finding-text");
          }
          if (f.text.length === 0 || f.text.length > L8_FINDING_MAX_CHARS) {
            throw new EgressRefusedError(`finding-text refused: ${f.text.length} chars outside 1..${L8_FINDING_MAX_CHARS}`, "finding-text");
          }
          if (alreadyRecorded(ctx.corpusDir, findingId, L8_LABELER)) continue;
          const envelope = await ctx.client.judge(
            { finding_id: findingId, lens: f.lens, finding_text: f.text },
            L8_QUESTIONS,
            { egressClass: L8_EGRESS_CLASS, ceiling: ctx.ceilings.l8 },
          );
          requestId = envelope.requestId;
          const real = noulOf(envelope, "is_real_defect");
          const choice = choiceOf(envelope, "disposition", Object.keys(L8_DISPOSITION_BY_CHOICE));
          const wouldFilter = real < L8_REAL_DEFECT_MIN && choice === "dismiss";
          const record: TriageRecord = TriageRecordSchema.parse({
            finding_id: findingId,
            finding_text: f.text,
            diff_context_ref: `run:${f.runId}/lens:${f.lens}`,
            label: f.lens,
            disposition: L8_DISPOSITION_BY_CHOICE[choice],
            rationale: `jev: is_real_defect=${real}; disposition=${choice}; answer_mode=${ctx.client.mode}`,
            labeler: L8_LABELER,
            pr: null,
            round: null,
            created_at: envelope.created_at,
            arm: "jev",
            latency_ms: Math.round(envelope.latency_ms),
            cost_exact_usd: (envelope.usage.input_tokens * 0.042) / 1_000_000,
          });
          appendRecord(ctx.corpusDir, record);
          if (wouldFilter) filtered.add(findingId);
          packLine(ctx, "l8", requestId, t0, {
            answer: { is_real_defect: real, disposition: choice },
            would_signal: wouldFilter,
            findingId: f.findingId,
          });
        } catch (e) {
          // A refused/missed finding is never filtered: it stays for deep adjudication.
          packLine(ctx, "l8", requestId, t0, { miss: missReason(e), findingId: f.findingId });
        }
      }
    });
  } catch (e) {
    packLine(ctx, "l8", newRequestId(), started, { miss: missReason(e) });
  }
  const kept = findings.filter((f) => !filtered.has(key(f)));
  packLine(ctx, "l8", newRequestId(), started, { would_keep: kept.map(key), input_count: findings.length });
  return PACK_SIGNALS_ARMED ? kept : unchanged;
}

// ─── pre-dispatch sanity ──────────────────────────────────────────────────────

export type SanityResult = { kind: "miss"; reason: string } | { kind: "asked"; envelope: JudgmentEnvelope };

/**
 * Provenance-only (no corpus record, no disposition value until its answer
 * pair is named in a register amendment). Annotates nothing; refuses no
 * dispatch, armed or not (INV-J-NOGATE).
 */
export async function sanityCheck(ctx: PackContext, manifest: SanityManifest): Promise<SanityResult> {
  const started = ctx.now();
  let requestId = newRequestId();
  try {
    assertMachineState(manifest);
    if (JSON.stringify(manifest).length > L7_ASK_STATE_MAX_CHARS) {
      throw new EgressRefusedError("machine-state refused: manifest state over the size cap", "machine-state");
    }
    const envelope = await ctx.client.judge(manifest, SANITY_QUESTIONS, {
      egressClass: SANITY_EGRESS_CLASS,
      ceiling: ctx.ceilings.sanity,
    });
    requestId = envelope.requestId;
    packLine(ctx, "sanity", requestId, started, { answer: { manifest_consistent: noulOf(envelope, "manifest_consistent") } });
    return { kind: "asked", envelope };
  } catch (e) {
    const reason = missReason(e);
    packLine(ctx, "sanity", requestId, started, { miss: reason });
    return { kind: "miss", reason };
  }
}
