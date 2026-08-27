/**
 * DF3.3 — the resident orchestrator agent, fleet side of the steering pair.
 *
 * `startResident` turns a validated DF3.1 brief into a `ResidentSpawn`: a
 * `ResidentCaller` that runs one synchronous pi solicitation per call over
 * `Bun.spawn` (native timeout + SIGKILL), the slug's DF1.5-resolved rate, and
 * the process-end mapping C3 reports in the journal's `resident.exitStatus`.
 * The agent holds no reference to a gate, the journal, or the manifest — its
 * only egress is the raw reply text returned from an engine-initiated call
 * (INV-RES-1). Parsing/validation of that reply is C1's `steering.ts`.
 *
 * Session continuity is the `--session <path>` FILE (one file per runId), not
 * a long-lived process: each call spawns pi, which resumes the session. A
 * resident that dies mid-run therefore degrades (AC3), never invalidates.
 *
 * Spawn shape adapted from cli-anything/scripts/team-lead-driver.ts runWorkerPi
 * (:542-659); reply/usage come from its exported harvestPiStream (message_end
 * totals only, INV-COST-3). Rates come from resolveRate — never re-derived.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redactSecrets, SECRET_KEY_RE } from "../../cli-anything/src/redact.ts";
import { harvestPiStream } from "../../cli-anything/scripts/team-lead-driver.ts";
import type { ExitStatus } from "../../cli-anything/src/types.ts";
import { SOLICIT_TIMEOUT_MS, type ResidentCaller } from "../phase-engine/steering.ts";
import { resolveRate, type RateSources } from "../phase-engine/roster/validate.ts";

/**
 * Provenance default (R5 §6 fact 9). The FULL OpenRouter model id
 * (vendor/model) — the story's "deepseek-v4-flash-0731" is a display name and
 * never resolves as a rate key (canonical key: openrouter/deepseek/…). The
 * runtime rate ALWAYS comes from resolveRate — this constant is configuration,
 * never a price table.
 */
export const DEFAULT_RESIDENT_SLUG = "deepseek/deepseek-v4-flash-0731";

/**
 * The runId lands in file names (`${runId}.resident.jsonl`, artifact names), so
 * anything that escapes the session/persist dirs (path traversal) is refused
 * before it can become a path. Same guard idea as dispatch's
 * `assertValidRunId`, local because the resident's artifact grammar (dots,
 * underscores) is wider than the store's RFC 1123 label.
 */
const RESIDENT_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Upper clamp on QDS_RESIDENT_TIMEOUT_MS — 10 min admits no unbounded hang. */
const MAX_RESIDENT_TIMEOUT_MS = 600_000;

export interface ResidentSpawn {
  /** Implements ResidentCaller over a pi subprocess (one process per call). */
  caller: ResidentCaller;
  rate: { inputPerMTok: number; outputPerMTok: number };
  /**
   * How the resident process itself ended (CC-1 ExitStatus); null when the
   * resident never ran a call, because there is no process end to report.
   */
  exitStatus(): Promise<ExitStatus | null>;
  /** SIGKILL the in-flight call, if any. DF3.6 decides when; this supplies how. */
  stop(): Promise<void>;
}

export interface ResidentSpawnOpts {
  /** DF3.1 BriefSchema value (already validated at ingress). */
  brief: unknown;
  runId: string;
  /** The `--session <path>` file lives here. */
  sessionDir: string;
  /** Default DEFAULT_RESIDENT_SLUG. */
  slug?: string;
  /** Key delivery — env-borne, never argv. Defaults to this process's env. */
  env?: NodeJS.ProcessEnv;
  /** pi binary override — test seam (QDS_PI_BIN env fallback). */
  bin?: string;
  /** Prompt/reply artifacts persist here, redacted, when set (§5.2). */
  persistDir?: string;
}

// ponytail: rate-source injection seam for tests (dispatch-task _injectRunner
// pattern) — lets unit tests pin rates without touching ~/.pi/agent/models.json.
let _rateSources: RateSources | null = null;
export function _injectRateSources(sources: RateSources | null): void {
  _rateSources = sources;
}

/**
 * Per-call timeout. Default SOLICIT_TIMEOUT_MS (the frozen constant); the
 * QDS_RESIDENT_TIMEOUT_MS override is bounds-checked exactly like
 * PI_COMS_TIMEOUT_MS in team-lead-driver.ts:691-697 — only integers in
 * [1, 600_000] count, because `setTimeout(NaN)` fires at ~0 ms, Bun's
 * timeout option would reject a non-positive value outright, and an unclamped
 * upper bound would let a typo hang a run for 2^31-1 ms (~24.8 days).
 * Reads `env` (the spawn seam), falling back to this process's env.
 */
function solicitTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.QDS_RESIDENT_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= 1 && raw <= MAX_RESIDENT_TIMEOUT_MS
    ? raw
    : SOLICIT_TIMEOUT_MS;
}

/**
 * Test seam for the timeout's resolution table (the `_injectRateSources`
 * convention): lets the clamp tests assert the resolved value directly
 * instead of burning the 60 s default on a real hang.
 */
export function _resolvedSolicitTimeoutMs(env: NodeJS.ProcessEnv): number {
  return solicitTimeoutMs(env);
}

/**
 * AC4: absent/empty brief means the resident is NEVER spawned — an explicit
 * non-error path checked before rate resolution, so a rate-less config can
 * never turn "no brief" into a refusal.
 */
function briefIsEmpty(brief: unknown): boolean {
  if (brief === null || brief === undefined) return true;
  if (typeof brief === "string") return brief.trim() === "";
  if (typeof brief === "object") return Object.keys(brief as Record<string, unknown>).length === 0;
  return false;
}

/**
 * Credential-shaped env KEY NAMES bound for redaction. Explicit common names
 * first, then the repo's SECRET_KEY_RE heuristic (cli-anything redact.ts)
 * catches the rest (anything *TOKEN/*SECRET/*KEY-shaped) from the env the
 * child actually receives; empty/whitespace values are excluded.
 */
const SECRET_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "PI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

/**
 * Redaction bind (dispatch-task.ts:120-126 pattern): the explicit key set
 * above plus every SECRET_KEY_RE-shaped key from the env the child actually
 * receives. Every persisted artifact and every error message passes through
 * this one chokepoint.
 */
function bindRedact(env: NodeJS.ProcessEnv): (s: string) => string {
  const secretEnv: Record<string, string> = {};
  const add = (key: string, v: string | undefined) => {
    if (v !== undefined && v.trim().length > 0) secretEnv[key] = v;
  };
  for (const key of SECRET_ENV_KEYS) add(key, env[key]);
  for (const [key, v] of Object.entries(env)) {
    if (typeof v === "string" && SECRET_KEY_RE.test(key)) add(key, v);
  }
  return (s: string) => redactSecrets(s, secretEnv);
}

/**
 * Persist one redacted artifact (§5.2). Pre-execution for prompts: the caller
 * invokes this BEFORE Bun.spawn. A failed write throws — an unloggable prompt
 * must not execute (fail-closed), which degrades the resident rather than
 * running an unpersisted solicitation. Replies call this same helper but wrap
 * it: the spend is already metered, so the artifact must not cost the reply.
 */
function persistArtifact(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), body, { mode: 0o600 });
}

/**
 * Start (arm) the resident for one run. Returns `{disabled:true}` for an
 * empty/absent brief without spawning anything (AC4). Throws RateError from
 * resolveRate BEFORE any spawn when the slug has no resolvable rate — the
 * caller refuses the run (DF1.5 rule, consumed here, never re-derived).
 */
export function startResident(opts: ResidentSpawnOpts): ResidentSpawn | { disabled: true } {
  if (briefIsEmpty(opts.brief)) return { disabled: true };

  if (!RESIDENT_RUN_ID_RE.test(opts.runId)) {
    throw new Error(
      `resident refused: runId ${JSON.stringify(opts.runId.slice(0, 32))} is not ` +
        `${RESIDENT_RUN_ID_RE.source} — it becomes file names under the session and persist dirs`,
    );
  }

  // SOURCE-vs-spec drift: resolveRate's tables key `${providerId}/${id}`
  // (validate.ts:396) where id is itself vendor/model — e.g.
  // openrouter/deepseek/deepseek-v4-flash-0731 — so the story's short slug can
  // never resolve. The resident's provider is frozen "openrouter" (argv), so:
  // rateKey is always provider-qualified and --model always carries the bare id.
  const slug = opts.slug ?? DEFAULT_RESIDENT_SLUG;
  const qualified = slug.startsWith("openrouter/");
  const modelArg = qualified ? slug.slice("openrouter/".length) : slug;
  // Slug shape (B10): the remainder must be a non-empty vendor/model id —
  // `openrouter/` alone or a bare "/" is configuration garbage, never a model.
  if (!modelArg.includes("/") || modelArg.split("/").some((part) => part.length === 0)) {
    throw new Error(
      `resident refused: slug ${JSON.stringify(slug.slice(0, 64))} is not a vendor/model id`,
    );
  }
  const rateKey = qualified ? slug : `openrouter/${slug}`;
  const rate = resolveRate(rateKey, _rateSources ?? undefined);
  const bin = opts.bin ?? process.env.QDS_PI_BIN ?? "pi";
  const sessionPath = join(opts.sessionDir, `${opts.runId}.resident.jsonl`);
  mkdirSync(opts.sessionDir, { recursive: true, mode: 0o700 });
  const childEnv = opts.env ?? process.env;
  const redact = bindRedact(childEnv);
  const timeoutMs = solicitTimeoutMs(childEnv);
  let seq = 0;
  let lastExit: ExitStatus | null = null;
  let current: Bun.Subprocess | null = null;
  let stopped = false;

  const call = async (prompt: string) => {
    if (stopped) throw new Error("resident stopped: stop() was called before this call");
    seq += 1;
    if (opts.persistDir !== undefined) {
      persistArtifact(opts.persistDir, `${opts.runId}-solicit-${seq}-prompt.txt`, redact(prompt));
    }
    // Timeout via Bun.spawn native timeout + SIGKILL (exedev/transport.ts:64-77
    // pattern). Bun.spawn THROWS synchronously on a missing binary (ENOENT) —
    // that throw IS the AC3 unreachable path.
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(
        [
          bin,
          "--provider",
          "openrouter",
          "--model",
          modelArg,
          "--mode",
          "json",
          "--no-tools",
          "--session",
          sessionPath,
          "-p",
          prompt,
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          env: childEnv,
        },
      );
    } catch (err) {
      // Bun.spawn throws synchronously on a missing binary (ENOENT) — that is
      // a configuration fault (wrong QDS_PI_BIN / pi not installed), which
      // will not heal on retry: "logic", not "transient".
      lastExit = "logic";
      throw err;
    }
    current = proc;
    let stdout = "";
    let stderr = "";
    try {
      const [out, errText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        // NOTE: on a signal death `exited` resolves 128+signal (137 for
        // SIGKILL), NOT null — the reliable signals are the post-exit
        // `exitCode`/`signalCode` properties checked below.
        proc.exited,
      ]);
      stdout = out;
      stderr = errText;
    } catch (err) {
      current = null;
      lastExit = "transient";
      throw err;
    }
    current = null;
    if (proc.exitCode === null || proc.signalCode !== null) {
      // Killed by signal — the native timeout's SIGKILL or stop().
      lastExit = "transient";
      throw new Error(`resident pi killed by signal ${proc.signalCode ?? "unknown"} before exit`);
    }
    const exitCode = proc.exitCode;
    if (exitCode !== 0) {
      lastExit = "logic";
      // Redact FULL output, THEN cut (command-gate rule): cutting first can
      // split a secret at the boundary and leak the surviving fragment.
      throw new Error(`resident pi exited ${exitCode}: ${redact(stderr).slice(-400)}`);
    }
    lastExit = "success";
    const harvest = harvestPiStream(stdout);
    if (opts.persistDir !== undefined) {
      // Reply persistence is BEST-EFFORT: the call already ran and was billed,
      // so throwing here would degrade the resident AND lose the usage.
      try {
        persistArtifact(
          opts.persistDir,
          `${opts.runId}-solicit-${seq}-reply.txt`,
          redact(harvest.text),
        );
      } catch (err) {
        console.error(
          `[resident] reply artifact not persisted (${opts.runId}-solicit-${seq}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return {
      raw: harvest.text,
      usage: { inputTokens: harvest.inputTokens, outputTokens: harvest.outputTokens },
    };
  };

  return {
    caller: { call },
    rate: { inputPerMTok: rate.inputPerMTok, outputPerMTok: rate.outputPerMTok },
    // null before any call: a never-solicited resident has no process end to
    // report, and "transient" would be a fact about nothing.
    exitStatus: async () => lastExit,
    stop: async () => {
      stopped = true;
      const proc = current;
      if (proc === null) return;
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone — the awaited exit below is the truth
      }
      await proc.exited.catch(() => {});
      if (current === proc) current = null;
    },
  };
}
