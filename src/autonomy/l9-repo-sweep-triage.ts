/**
 * L9 repo-sweep triage (J4) — the SEPARABLE, first-flex-cut leg.
 *
 * One module, imported by nothing in the pack core (cut contract: delete this
 * file + tests/autonomy/l9-repo-sweep-triage.test.ts, flip nothing else). The
 * only consumption point is an optional ranker seam whose absence means the
 * deterministic order. Types are declared LOCALLY with the exact shapes of
 * host-pack's `SweepHotspot` / `SweepRanker` (no import: that would add an
 * edge into the pack core).
 *
 * Recording-only (LOCKED #5): `rank()` ALWAYS returns the deterministic order
 * (score desc, path asc). The would-be Jev ordering is written to the log and
 * the corpus only. Whether that ordering is ever consumed is the core
 * `PACK_SIGNALS_ARMED` constant's job at the consumer seam — this module
 * deliberately has no armed switch of its own.
 *
 * Egress: `ac-prose`, declared once (L9_EGRESS_CLASS). What is sent is
 * host-authored brief prose, length-capped. A refusal, ceiling stop or schema
 * error is a RECORDED MISS (log line with `miss`), never a throw and never a
 * fallback to a wider egress class. Questions are noul + choice only — no
 * severity calibration, no `score` question.
 *
 * Second consumer: `opensrcSpans` — dependency-source spans from
 * `opensrc path <pkg>@<version>` (version from the repo's bun.lock, never
 * latest), fed through the same ranker. See its doc for the egress decision.
 */

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendRecord, TriageRecordSchema, type Disposition } from "../../scripts/corpus/index.ts";
// DEFAULT_CORPUS_DIR is not on the barrel; merge.ts is import-safe (main is import.meta.main-guarded).
import { acquireRunLock, releaseRunLock } from "../../scripts/lib/run-lock.ts";
import { CORPUS_LOCK_ID, DEFAULT_CORPUS_DIR } from "../../scripts/corpus/merge.ts";
import {
  CeilingExceededError,
  DEFAULT_STAGE_CEILING_INPUT_TOKENS,
  EgressRefusedError,
  JudgmentCeiling,
  JudgmentClient,
  JudgmentSchemaError,
  TYPESAFE_MODEL,
  type JudgmentEnvelope,
  type Question,
} from "../judgment/index.ts";
import { log, newRequestId, type LogEntry } from "../lib/log.ts";

// ---- local copies of host-pack's I4 shapes (exact; do not import) ----
export interface SweepHotspot {
  readonly path: string;
  readonly brief: string;
  readonly score: number;
}
export interface SweepRanker {
  rank(hotspots: readonly SweepHotspot[]): Promise<readonly SweepHotspot[]>;
}

/** L9 declares exactly one egress class (AC7). Never `diff-hunk`. */
export const L9_EGRESS_CLASS = "ac-prose" as const;
/** Max hotspots asked per rank() call; the rest are recorded as capped misses. */
export const MAX_HOTSPOTS_PER_CALL = 50;
/** Brief prose is truncated to this many chars before egress. */
export const BRIEF_MAX_CHARS = 2_000;
/** Path is capped too (it is also sent). */
export const PATH_MAX_CHARS = 300;
/** noul at/above this labels a hotspot "worth-brief" (threshold in code, not config). */
export const WORTH_BRIEF_THRESHOLD = 0.5;
/** Max dependency-source spans produced per package. */
export const MAX_OPENSRC_SPANS = 200;
export const OPENSRC_TIMEOUT_MS = 30_000;
export const L9_LABELER = `${TYPESAFE_MODEL}-l9-triage`;

/**
 * noul + choice only. The choice keys map into the LOCKED review DISPOSITIONS
 * enum (see DISPOSITION_BY_CHOICE); no severity question exists.
 */
export const L9_QUESTIONS = {
  worth_brief: {
    type: "noul",
    instructions:
      "Judge ONLY the sweep hotspot stated in the state: is the described code area worth a dedicated written brief for a downstream agent? Trivial, generated or purely cosmetic areas are not.",
  },
  disposition: {
    type: "choice",
    instructions: "What should happen next to this sweep hotspot?",
    criteria: {
      patch: "write a brief and act on it in the next change",
      defer: "worth recording, but not acted on yet",
      dismiss: "not worth a brief — drop it",
    },
  },
} as const satisfies Record<string, Question>;

const DISPOSITION_BY_CHOICE: Record<string, Disposition> = { patch: "PATCH", defer: "DEFER", dismiss: "DISMISS" };

/** Judge seam: the real JudgmentClient, or any structural stand-in (tests). */
export interface Judge {
  judge: JudgmentClient["judge"];
}

export interface TriageDeps {
  /** Default: a mock-mode JudgmentClient on `provenanceDir`. */
  client?: Judge;
  /** Used only when `client` is absent. Tests MUST set it. */
  provenanceDir?: string;
  /** Corpus dir for records. Default DEFAULT_CORPUS_DIR. Tests MUST set it. */
  corpusDir?: string;
  /** One ceiling per leg. Default a fresh 1M one per ranker. */
  ceiling?: JudgmentCeiling;
  log?: (entry: LogEntry) => void;
}

const deterministic = (hs: readonly SweepHotspot[]): SweepHotspot[] =>
  [...hs].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL = /[\u0000-\u001f\u007f]/g;
const clip = (s: string, max: number): string => s.replace(CONTROL, " ").slice(0, max);

function missReason(e: unknown): string {
  if (e instanceof EgressRefusedError) return "egress-refused";
  if (e instanceof CeilingExceededError) return "ceiling-exceeded";
  if (e instanceof JudgmentSchemaError) return "schema-error";
  return "judge-failed";
}

/** Project one envelope into a TriageRecord input; throws on off-shape answers (caught as a miss). */
function recordFrom(h: SweepHotspot, path: string, brief: string, env: JudgmentEnvelope) {
  const w = env.answers.worth_brief;
  const d = env.answers.disposition;
  if (!w || w.type !== "noul" || !d || d.type !== "choice") throw new JudgmentSchemaError("L9 envelope answers off-shape", env.requestId, "");
  const disposition = DISPOSITION_BY_CHOICE[d.choice];
  if (disposition === undefined) throw new JudgmentSchemaError(`L9 disposition "${d.choice}" is not an asked criterion`, env.requestId, "");
  const record = TriageRecordSchema.parse({
    finding_id: `sweep:${path}`,
    finding_text: brief,
    diff_context_ref: `sweep:${path}`,
    label: w.noul >= WORTH_BRIEF_THRESHOLD ? "worth-brief" : "skip-brief",
    disposition,
    rationale: `jev: worth_brief=${w.noul}; disposition=${d.choice}; host_score=${h.score}`,
    labeler: L9_LABELER,
    pr: null,
    round: null,
    created_at: env.created_at,
    arm: "jev",
    latency_ms: Math.round(env.latency_ms),
    cost_exact_usd: (env.usage.input_tokens * 0.042) / 1_000_000,
  });
  return { record, worth: w.noul, choice: d.choice };
}

export function makeSweepTriageRanker(deps: TriageDeps = {}): SweepRanker {
  const emit = deps.log ?? log;
  const corpusDir = deps.corpusDir ?? DEFAULT_CORPUS_DIR;
  const client: Judge = deps.client ?? new JudgmentClient({ provenanceDir: deps.provenanceDir });
  const ceiling = deps.ceiling ?? new JudgmentCeiling(DEFAULT_STAGE_CEILING_INPUT_TOKENS);

  const line = (requestId: string, started: number, extra: Record<string, unknown>, status: "ok" | "error"): void => {
    const now = Date.now();
    try {
      emit({
        requestId,
        operation: "l9-triage",
        agentId: null,
        timestamp: new Date(now).toISOString(),
        duration: now - started,
        status,
        event: "l9-triage",
        leg: "l9",
        egress_class: L9_EGRESS_CLASS,
        armed: false,
        latency_ms: now - started,
        ...extra,
      });
    } catch {
      // a log sink must never break the (recording-only) leg
    }
  };

  return {
    async rank(hotspots) {
      const order = deterministic(hotspots);
      let lock: ReturnType<typeof acquireRunLock> | undefined;
      try {
        // Single-writer discipline of the corpus tooling; held across the asks (sequential, bounded).
        mkdirSync(corpusDir, { recursive: true });
        lock = acquireRunLock(corpusDir, CORPUS_LOCK_ID, "l9 triage");
        const worthByPath = new Map<string, number>();
        let ceilingHit = false;
        for (const [i, h] of order.entries()) {
          const started = Date.now();
          const path = clip(h.path, PATH_MAX_CHARS);
          const miss = (reason: string, requestId = newRequestId()) => line(requestId, started, { miss: reason, path }, "error");
          if (i >= MAX_HOTSPOTS_PER_CALL) {
            miss("capped");
            continue;
          }
          if (ceilingHit) {
            miss("ceiling-exhausted");
            continue;
          }
          const brief = clip(h.brief, BRIEF_MAX_CHARS) || path;
          let env: JudgmentEnvelope | undefined;
          try {
            env = await client.judge({ kind: "sweep-hotspot", path, brief }, L9_QUESTIONS, {
              egressClass: L9_EGRESS_CLASS,
              ceiling,
            });
            const { record, worth, choice } = recordFrom(h, path, brief, env);
            appendRecord(corpusDir, record);
            worthByPath.set(h.path, worth);
            line(env.requestId, started, { answer: { worth_brief: worth, disposition: choice }, path }, "ok");
          } catch (e) {
            if (e instanceof CeilingExceededError) ceilingHit = true;
            miss(missReason(e), env?.requestId);
          }
        }
        // Would-be ordering (noul desc, then the deterministic order) — LOGGED ONLY.
        const would = [...order].sort((a, b) => (worthByPath.get(b.path) ?? -1) - (worthByPath.get(a.path) ?? -1));
        line(newRequestId(), Date.now(), { event: "l9-triage-order", would_order: would.map((h) => h.path) }, "ok");
      } catch (e) {
        line(newRequestId(), Date.now(), { miss: "rank-failed", message: (e as Error).message }, "error");
      } finally {
        if (lock) releaseRunLock(lock);
      }
      return order;
    },
  };
}

// ===== second consumer: dependency-source spans via `opensrc` =====

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
}
export type Exec = (cmd: string, args: readonly string[]) => ExecResult;
export interface SpanFile {
  /** Path relative to the package root. */
  rel: string;
  bytes: number;
}

export interface OpensrcDeps {
  /** Path to bun.lock. Default `<cwd>/bun.lock`. */
  lockfilePath?: string;
  /** Injected in tests; the default spawns the real binary (absent on most hosts => miss). */
  exec?: Exec;
  /** Lists files under the resolved source dir. Default: bounded fs walk. */
  listFiles?: (dir: string) => readonly SpanFile[];
  /**
   * In-memory cache per `pkg@version` (successful lookups only; a miss is
   * never cached, so a later install of the binary heals). Default: a
   * module-level map shared for the process; pass your own to isolate.
   */
  cache?: Map<string, readonly SweepHotspot[]>;
  log?: (entry: LogEntry) => void;
}

export type OpensrcResult =
  | { readonly ok: true; readonly pkg: string; readonly version: string; readonly spans: readonly SweepHotspot[]; readonly cached: boolean }
  | { readonly ok: false; readonly pkg: string; readonly miss: string };

const processCache = new Map<string, readonly SweepHotspot[]>();
const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const LOCKED_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SAFE_REL = /^[\w@./+-]+$/;

const defaultExec: Exec = (cmd, args) => {
  const r = Bun.spawnSync([cmd, ...args], { timeout: OPENSRC_TIMEOUT_MS, stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
};

function defaultListFiles(dir: string): SpanFile[] {
  const out: SpanFile[] = [];
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (rel.split("/").includes("node_modules") || rel.endsWith(".d.ts") || rel.includes(".min.") || !SOURCE_FILE.test(rel)) continue;
    const st = statSync(join(dir, rel));
    if (st.isFile()) out.push({ rel, bytes: st.size });
  }
  return out;
}

/**
 * The version `pkg` is LOCKED at in bun.lock (text JSONC, trailing commas —
 * parsed with Bun's built-in JSONC, no new dep). Only the top-level
 * (hoisted) `packages[pkg]` entry counts; nested per-parent copies
 * (`parent/pkg`) are ambiguous and deliberately not guessed at. Workspace,
 * git, and tarball entries have no registry version => undefined (a miss).
 */
export function lockedVersion(lockText: string, pkg: string): string | undefined {
  const lock = Bun.JSONC.parse(lockText) as { packages?: Record<string, unknown> };
  const entry = lock.packages?.[pkg];
  const ident = Array.isArray(entry) ? entry[0] : undefined;
  if (typeof ident !== "string" || !ident.startsWith(`${pkg}@`)) return undefined;
  const version = ident.slice(pkg.length + 1);
  return LOCKED_VERSION.test(version) ? version : undefined;
}

/**
 * Dependency-source spans for `pkg` at its LOCKED version, as SweepHotspots
 * ready for `makeSweepTriageRanker().rank()`.
 *
 * EGRESS DECISION: third-party source is NOT factory-authored prose, and there
 * is no egress class for it (diff-hunk is ZDR-gated). So no source text ever
 * leaves: each span's `brief` is a host-authored metadata line (package,
 * version, relative path, byte size) and `score` is the byte size; the only
 * third-party-derived string is the file path, which is charset-restricted
 * (SAFE_REL) and length-capped. The leg then rides the ordinary `ac-prose`
 * class. Misses (bad name, unlocked/unknown package, missing binary, non-zero
 * exit, empty output) return `{ok:false}` + a log line; never `latest`.
 */
export function opensrcSpans(pkg: string, deps: OpensrcDeps = {}): OpensrcResult {
  const emit = deps.log ?? log;
  const miss = (reason: string): OpensrcResult => {
    const now = Date.now();
    try {
      emit({
        requestId: newRequestId(), operation: "l9-opensrc", agentId: null, timestamp: new Date(now).toISOString(), duration: 0,
        status: "error", event: "l9-triage", leg: "l9", egress_class: L9_EGRESS_CLASS, armed: false, latency_ms: 0, miss: reason, pkg,
      });
    } catch {
      // sink failures never break the leg
    }
    return { ok: false, pkg, miss: reason };
  };
  if (!NPM_NAME.test(pkg)) return miss("invalid-package-name");
  let version: string | undefined;
  try {
    version = lockedVersion(readFileSync(deps.lockfilePath ?? join(process.cwd(), "bun.lock"), "utf8"), pkg);
  } catch {
    return miss("lockfile-unreadable");
  }
  if (!version) return miss("package-not-locked");

  const key = `${pkg}@${version}`;
  const cache = deps.cache ?? processCache;
  const hit = cache.get(key);
  if (hit) return { ok: true, pkg, version, spans: hit, cached: true };

  let res: ExecResult;
  try {
    res = (deps.exec ?? defaultExec)("opensrc", ["path", key]);
  } catch {
    return miss("opensrc-unavailable");
  }
  if (res.exitCode !== 0) return miss("opensrc-nonzero-exit");
  const dir = res.stdout.trim().split("\n").pop()?.trim();
  if (!dir) return miss("opensrc-empty-output");

  let files: readonly SpanFile[];
  try {
    files = (deps.listFiles ?? defaultListFiles)(dir);
  } catch {
    return miss("source-unreadable");
  }
  const spans = deterministic(
    files
      .filter((f) => SAFE_REL.test(f.rel) && f.rel.length <= PATH_MAX_CHARS)
      .map((f) => ({
        path: `${key}/${f.rel}`,
        brief: `dependency source span ${f.rel} of ${key} (${f.bytes} bytes)`,
        score: f.bytes,
      })),
  ).slice(0, MAX_OPENSRC_SPANS);
  cache.set(key, spans);
  return { ok: true, pkg, version, spans, cached: false };
}
