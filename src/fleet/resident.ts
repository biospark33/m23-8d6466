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
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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

/**
 * Hard prompt-size ceiling for the `-p` argv delivery (S2-2). pi 0.55.0's
 * prompt contract IS argv (stdin is "ignore"), so the prompt rides the
 * command line: visible to any local `ps` while the call runs (a known,
 * accepted exposure — the run's own host), and Bun.spawn throws E2BIG above
 * ARG_MAX. 128 KiB sits well under every platform's ARG_MAX and is
 * unreachable via the normal path — steering's PROMPT_CHAR_CEILING is 16 000
 * chars — so hitting this means a caller bug, not a big brief.
 */
const MAX_PROMPT_BYTES = 128 * 1024;

/**
 * Transient-fault patterns matched against pi's REDACTED stderr tail (S2-3):
 * provider 429/5xx and network failures heal on retry, so they classify
 * "transient"; every other non-zero exit stays "logic" (a fault retry will
 * not fix). Deliberately conservative — when in doubt, "logic".
 */
const TRANSIENT_STDERR_RE =
  /\b429\b|rate.?limit|too many requests|\b5(?:00|02|03|04)\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i;

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
  /** Key delivery — env-borne, never argv. When omitted, the child gets a
   *  least-privilege allowlist of this process's env (CHILD_ENV_ALLOWLIST),
   *  NOT the whole environment; an explicit value passes through unfiltered
   *  (the unit-test seam). */
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
 * never turn "no brief" into a refusal. Fail-safe (S2-9): anything that is
 * not a non-empty string or a non-empty object (0, false, 42, …) counts as
 * EMPTY — a meaningless brief must disable the resident, never spawn it.
 */
function briefIsEmpty(brief: unknown): boolean {
  if (brief === null || brief === undefined) return true;
  if (typeof brief === "string") return brief.trim() === "";
  if (typeof brief === "object") return Object.keys(brief as Record<string, unknown>).length === 0;
  return true;
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
 * Least-privilege child env (S2-4 — behavior change, round 5): without an
 * explicit `opts.env`, pi receives ONLY this allowlist. pi provably needs
 * PATH (shebang/subprocess resolution), HOME (its ~/.pi config — the rate
 * table lives there), the OpenRouter key (the provider is frozen
 * "openrouter" in argv), and proxy vars to reach the network;
 * QDS_RESIDENT_TIMEOUT_MS is the resident's own knob, read off the child env
 * by solicitTimeoutMs. Everything else in the orchestrator's environment —
 * cloud credentials, unrelated CI tokens — stays OUT of the third-party
 * subprocess. QDS_RESIDENT_ENV_PASSTHROUGH (comma-separated names, read from
 * the BASE env) is the documented escape hatch the e2e harness uses to reach
 * an env-scripted fake pi. `opts.env` bypasses the filter entirely.
 */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "OPENROUTER_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "QDS_RESIDENT_TIMEOUT_MS",
];

function buildChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const passthrough = (base.QDS_RESIDENT_ENV_PASSTHROUGH ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...CHILD_ENV_ALLOWLIST, ...passthrough]) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

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
 * Persist one redacted artifact (§5.2). Fail-closed BOTH ways: the caller
 * invokes this BEFORE Bun.spawn for prompts (an unloggable prompt must not
 * execute), and a failed REPLY write also throws (S2-14 — an unpersisted raw
 * reply must never reach steering to be acted on; the throw degrades the
 * resident to the deterministic default).
 *
 * Writes are atomic (S2-13): a same-dir temp file renamed over the final
 * name, so a crash mid-write never leaves a truncated artifact
 * indistinguishable from a complete one. Fresh files get 0o600; the dir is
 * clamped to 0o700 even when it pre-existed, because mkdir's mode applies
 * only to directories it creates (S2-1). The chmod is best-effort via `warn`
 * — a chmod failure must never break a call.
 */
function persistArtifact(
  dir: string,
  name: string,
  body: string,
  warn: (msg: string) => void,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    warn(`chmod 0700 on persist dir failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const finalPath = join(dir, name);
  writeFileSync(`${finalPath}.tmp`, body, { mode: 0o600 });
  renameSync(`${finalPath}.tmp`, finalPath);
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
  // S2-4: `opts.env` is the test seam and passes through unfiltered; without
  // it the child gets the least-privilege allowlist, NOT this process's whole
  // environment. The redaction bind reads the SAME env the child receives.
  const childEnv = opts.env ?? buildChildEnv(process.env);
  const redact = bindRedact(childEnv);
  const timeoutMs = solicitTimeoutMs(childEnv);
  /** The single warn chokepoint: redacted, tail-bounded, never throws. */
  const warn = (msg: string): void => {
    console.error(`[resident] ${redact(msg).slice(-400)}`);
  };
  mkdirSync(opts.sessionDir, { recursive: true, mode: 0o700 });
  // S2-1: clamp the dir even when it pre-existed (mkdir's mode applies only
  // to directories it creates) — pi's own session jsonl holds the RAW prompt
  // and reply, unredacted, so its dir must not keep lax permissions.
  try {
    chmodSync(opts.sessionDir, 0o700);
  } catch (err) {
    warn(`chmod 0700 on session dir failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let seq = 0;
  let lastExit: ExitStatus | null = null;
  let current: Bun.Subprocess | null = null;
  let stopped = false;

  const call = async (prompt: string) => {
    if (stopped) throw new Error("resident stopped: stop() was called before this call");
    // S2-5: the ResidentCaller contract is strictly sequential — `current` is
    // a single slot and every call appends the SAME session file, so an
    // overlapping call would clobber the handle stop() kills and interleave
    // writers on the session jsonl. Refuse (logic: a caller-contract
    // violation a retry will not fix). lastExit is deliberately untouched —
    // no process ends here; the in-flight call owns the process-end report.
    if (current !== null) {
      throw new Error("resident busy: a solicitation is already in flight (calls are sequential)");
    }
    // S2-2: the prompt rides `-p` argv (pi 0.55.0's contract — stdin is
    // "ignore"), so refuse BEFORE persist/spawn rather than dying on E2BIG.
    // Only the byte count is reported, never prompt content.
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > MAX_PROMPT_BYTES) {
      lastExit = "logic";
      throw new Error(
        `resident refused: prompt is ${promptBytes} bytes, over the ${MAX_PROMPT_BYTES}-byte argv ceiling`,
      );
    }
    seq += 1;
    if (opts.persistDir !== undefined) {
      try {
        persistArtifact(opts.persistDir, `${opts.runId}-solicit-${seq}-prompt.txt`, redact(prompt), warn);
      } catch (err) {
        throw new Error(
          `resident prompt artifact not persisted (${opts.runId}-solicit-${seq}): ${redact(err instanceof Error ? err.message : String(err))}`,
        );
      }
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
    const spawnedAt = performance.now();
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
      // S2-8: a stream-read failure must not orphan the child — kill it
      // BEFORE dropping the handle, or it lives until the native timeout and
      // stop() can never reach it again.
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone — the awaited exit below is the truth
      }
      await proc.exited.catch(() => {});
      current = null;
      lastExit = "transient";
      throw err;
    }
    current = null;
    // S2-1: pi wrote the session jsonl with its own default mode and it holds
    // the RAW prompt + reply — clamp it after every call. Best-effort: a
    // chmod failure warns through the chokepoint, never breaks the call.
    try {
      if (existsSync(sessionPath)) chmodSync(sessionPath, 0o600);
    } catch (err) {
      warn(`chmod 0600 on session file failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (proc.exitCode === null || proc.signalCode !== null) {
      // Killed by signal — the native timeout's SIGKILL or stop().
      lastExit = "transient";
      // S2-7: Bun exposes no timed-out flag, so elapsed time discriminates
      // the native timeout from stop()/external kills (25 ms slack for timer
      // scheduling — a stop() landing inside the slack reads as a timeout).
      if (performance.now() - spawnedAt >= timeoutMs - 25) {
        // S2-6: a SIGKILLed pi may have torn the session jsonl mid-append —
        // quarantine it so the next call starts a FRESH session instead of
        // resuming a truncated file and degrading every later call.
        try {
          if (existsSync(sessionPath)) renameSync(sessionPath, `${sessionPath}.torn-${seq}`);
        } catch (err) {
          warn(`session quarantine after timeout failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        throw new Error(`resident pi timed out after ${timeoutMs} ms (SIGKILL on native timeout)`);
      }
      throw new Error(`resident pi killed by signal ${proc.signalCode ?? "unknown"} before exit`);
    }
    const exitCode = proc.exitCode;
    if (exitCode !== 0) {
      // Redact FULL output, THEN cut (command-gate rule): cutting first can
      // split a secret at the boundary and leak the surviving fragment.
      const detail = redact(stderr).slice(-400);
      // S2-3: provider 429/5xx and network failures are transient (they heal
      // on retry); every other non-zero exit stays "logic". Conservative:
      // unmatched stderr means logic.
      lastExit = TRANSIENT_STDERR_RE.test(detail) ? "transient" : "logic";
      throw new Error(`resident pi exited ${exitCode}: ${detail}`);
    }
    lastExit = "success";
    // S2-12: warnings/deprecations pi prints on a successful call are the
    // only signal of a degrading provider — surface them once (warn redacts
    // and bounds the line).
    if (stderr.trim().length > 0) {
      warn(`pi wrote to stderr on a successful call (${opts.runId} solicit ${seq}): ${stderr.trim()}`);
    }
    const harvest = harvestPiStream(stdout);
    // S2-11: exit 0 with NO harvested message_end is not a success — the
    // solicitation silently produced nothing. Classify the process end
    // "logic" (pi exited clean but its stream is unharvestable, which a
    // retry will not fix); the empty raw still flows to steering, whose
    // reply validation fails closed downstream.
    if (harvest.turnCount === 0) lastExit = "logic";
    if (opts.persistDir !== undefined) {
      // §5.2 is fail-closed for replies too (S2-14): an unpersisted raw reply
      // must NOT flow to steering to be parsed and acted on — throwing here
      // degrades the resident to the deterministic default, matching the
      // prompt path. lastExit stays "success": the fault is host-side
      // persistence, not the process end. The message passes the redact
      // chokepoint like every other error (S2-10).
      try {
        persistArtifact(opts.persistDir, `${opts.runId}-solicit-${seq}-reply.txt`, redact(harvest.text), warn);
      } catch (err) {
        throw new Error(
          `resident reply artifact not persisted (${opts.runId}-solicit-${seq}): ${redact(err instanceof Error ? err.message : String(err))}`,
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
