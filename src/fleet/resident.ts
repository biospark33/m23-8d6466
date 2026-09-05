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
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * Output byte ceilings for the harvest buffers (S2-4, round 7). The prompt
 * guard bounds what goes IN; nothing bounded what comes OUT — a looping pi
 * could fill stdout/stderr faster than any timeout fires and exhaust host
 * memory first. 4 MiB of stdout is ~250× a healthy solicitation's NDJSON; the
 * 1 MiB stderr ceiling matches the redacted-tail diagnostics role (only the
 * last 400 chars are ever read). On cap trip the child is SIGKILLed and
 * classified "logic": a flood is a pi-side fault a retry will not fix — the
 * same conservative default as every unmatched non-zero exit.
 */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

/** Sentinel distinguishing an S2-4 cap trip (we killed the child) from an ordinary stream fault. */
class OutputCapError extends Error {}

/**
 * Bounded replacement for `new Response(stream).text()` (S2-4): accumulate
 * chunks up to `cap` bytes, then throw OutputCapError so the caller can kill
 * the child instead of buffering unboundedly. The error message is byte
 * counts only — no output content ever crosses into it.
 */
async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        throw new OutputCapError(`resident pi ${label} exceeded the ${cap}-byte output cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
 * Once-only enforcement per session FILE across startResident instances
 * (S2-5, round 7): two live residents sharing one `--session` jsonl would
 * interleave appends and collide on artifact seq numbers. A second
 * startResident for a path already in this set throws at arming; stop()
 * releases the path. Documented private seam — module-level, never exported.
 * (Per-call overlap WITHIN one instance is the `current`-slot guard in call().)
 */
const LIVE_SESSION_PATHS = new Set<string>();

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
 * #219 / INV-RES-3 — the spawn-seam key assertion. The resident's credential
 * channel is env-borne delivery of the run's ONE minted key: on the box, the
 * unit's `EnvironmentFile` (`KEY_ENV_FILE`, src/providers/credentials.ts —
 * `app/.env` under the exec user's home) puts it into the manager environment
 * before this process starts. The resident CANNOT verify file origin from
 * inside its own environment, so this asserts exactly what is assertable at
 * the seam: the key EXISTS and is NON-BLANK before pi is armed.
 *
 * Fail-closed both ways this class of fault demands: a resident with no key
 * never spawns (it must not mint, borrow, or fall back to a second key — the
 * second-mint prohibition), and the runner's arming policy (pipeline-run.ts)
 * refuses the run on this throw rather than degrade, because an absent key is
 * a credential-CHANNEL fault — the same class as a credential-shaped brief
 * value (DF1.1 INV-4) — not an agent-reachability fault (INV-RES-5's degrade
 * list). Blank counts as absent: bindRedact already treats whitespace-only
 * secrets as "not a key", and a whitespace key would only ever produce
 * provider auth failures one call at a time.
 */
export class ResidentKeyAbsentError extends Error {
  readonly code = "RESIDENT_KEY_ABSENT" as const;
  constructor() {
    super(
      "resident refused: OPENROUTER_API_KEY is absent or blank in the env the resident would hand pi — " +
        "INV-RES-3 (#219): the run's single key must arrive env-borne from the unit's EnvironmentFile " +
        "(app/.env, KEY_ENV_FILE); the resident never mints, borrows, or falls back to a second key",
    );
    this.name = "ResidentKeyAbsentError";
  }
}

/**
 * INV-RES-3 seam check (throws ResidentKeyAbsentError). Reads the SAME env
 * the child receives (`opts.env` unfiltered, else the allowlist build) — never
 * a second source — so the assertion cannot pass against an env pi never gets.
 */
function assertRunKeyPresent(childEnv: NodeJS.ProcessEnv): void {
  const key = childEnv.OPENROUTER_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    throw new ResidentKeyAbsentError();
  }
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
  // S2-2 (round 7): writeFileSync's mode applies on CREATE only — a stale
  // lax-mode .tmp would survive truncation and be renamed onto the artifact.
  // Remove first so every artifact is a fresh 0o600 create.
  rmSync(`${finalPath}.tmp`, { force: true });
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
  // S2-5 (round 7): refuse a second live resident on the same session file —
  // concurrent instances would interleave jsonl appends and collide on
  // artifact seq numbers. Released by stop().
  if (LIVE_SESSION_PATHS.has(sessionPath)) {
    throw new Error(
      `resident refused: session ${sessionPath} is already held by a live startResident instance (stop() it first)`,
    );
  }
  // S2-4: `opts.env` is the test seam and passes through unfiltered; without
  // it the child gets the least-privilege allowlist, NOT this process's whole
  // environment. The redaction bind reads the SAME env the child receives.
  const childEnv = opts.env ?? buildChildEnv(process.env);
  // INV-RES-3 (#219): the key must exist, non-blank, in the env pi would
  // receive — checked BEFORE mkdir/chmod/session-claim so a refusal leaves
  // zero filesystem side effects and no claim to leak (the runId/slug/rate
  // refusals above already ran, so this is the last pre-arm gate).
  assertRunKeyPresent(childEnv);
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
  // S2-5: armed — claim the session path (added after the dir setup above, so
  // a throwing mkdir/chmod never leaks a claim for a resident that does not
  // exist; nothing between here and `return` throws).
  LIVE_SESSION_PATHS.add(sessionPath);
  let seq = 0;
  let lastExit: ExitStatus | null = null;
  let current: Bun.Subprocess | null = null;
  let stopped = false;

  /**
   * S2-1 (round 7): ANY signal death of the child — the native timeout's
   * SIGKILL, stop()'s SIGKILL, or an external kill — can tear the session
   * jsonl mid-append. Quarantine it (rename aside) so the next call starts a
   * FRESH session instead of resuming a truncated file and degrading every
   * later call. Best-effort via `warn`: a failed rename must never break a
   * call. The timeout-vs-stop ERROR TEXT distinction lives at the throw
   * sites, not here.
   */
  const quarantineSession = (reason: string): void => {
    try {
      if (existsSync(sessionPath)) renameSync(sessionPath, `${sessionPath}.torn-${seq}`);
    } catch (err) {
      warn(
        `session quarantine after ${reason} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

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
    // S2-9 (round 7): an empty/whitespace prompt passes the byte ceiling and
    // would spawn pi with `-p ""` — refuse pre-spawn (fail-safe). lastExit
    // stays untouched, matching the busy path: no process ever ran.
    if (prompt.trim().length === 0) {
      throw new Error("resident refused: prompt is empty — nothing to solicit");
    }
    // S2-2: the prompt rides `-p` argv (pi 0.55.0's contract — stdin is
    // "ignore"), so refuse BEFORE persist/spawn rather than dying on E2BIG.
    // Only the byte count is reported, never prompt content. S2-3 (round 7):
    // lastExit stays untouched — no process ever ran, so exitStatus keeps the
    // previous call's end (or null), never a fabricated one.
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > MAX_PROMPT_BYTES) {
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
      // Bun.spawn throws synchronously on a missing binary (ENOENT) — a
      // configuration fault (wrong QDS_PI_BIN / pi not installed). S2-3
      // (round 7): no process ever ran, so lastExit stays untouched (the
      // busy-path rule). S2-7 (round 7): the message passes the redact
      // chokepoint like every other error — a spawn error can echo argv or
      // env fragments.
      throw new Error(
        `resident pi spawn failed: ${redact(err instanceof Error ? err.message : String(err))}`,
      );
    }
    current = proc;
    const spawnedAt = performance.now();
    let stdout = "";
    let stderr = "";
    try {
      const [out, errText] = await Promise.all([
        // S2-4 (round 7): bounded collectors — a looping pi hits the byte cap
        // (and is killed) long before it can exhaust host memory; the native
        // timeout bounds TIME, not bytes.
        collectBounded(proc.stdout, MAX_STDOUT_BYTES, "stdout"),
        collectBounded(proc.stderr, MAX_STDERR_BYTES, "stderr"),
        // NOTE: on a signal death `exited` resolves 128+signal (137 for
        // SIGKILL), NOT null — the reliable signals are the post-exit
        // `exitCode`/`signalCode` properties checked below.
        proc.exited,
      ]);
      stdout = out;
      stderr = errText;
    } catch (err) {
      // S2-8: a stream-read failure (or an S2-4 cap trip) must not orphan the
      // child — kill it BEFORE dropping the handle, or it lives until the
      // native timeout and stop() can never reach it again.
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone — the awaited exit below is the truth
      }
      await proc.exited.catch(() => {});
      current = null;
      if (err instanceof OutputCapError) {
        // S2-4: we SIGKILLed the child mid-append, so the session jsonl may
        // be torn — quarantine exactly like any other signal death (S2-1).
        // "logic": a flood is a pi-side fault a retry will not fix. The cap
        // message is byte counts only, so the raw rethrow leaks no content.
        quarantineSession("output cap");
        lastExit = "logic";
        throw err;
      }
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
    // S2-10 (round 7): Bun reports a signal death as signalCode set /
    // exitCode null, but if it ever reports SIGKILL as exitCode 137
    // (128+SIGKILL) with a null signalCode, treat that as a signal death too —
    // otherwise the kill would fall into the generic non-zero branch and skip
    // both the "transient" classification and the quarantine.
    if (proc.exitCode === null || proc.signalCode !== null || proc.exitCode === 137) {
      // Killed by signal — the native timeout's SIGKILL, stop(), or an
      // external kill. S2-8 (round 7): the CC-1 ExitStatus enum cannot widen,
      // so a PLANNED stop() kill is recorded "transient" here — deliberately
      // indistinguishable from a genuine transient crash; the error text
      // thrown below keeps the timeout-vs-stop distinction for humans.
      lastExit = "transient";
      // S2-1 (round 7): quarantine for ANY signal death, not just the
      // timeout's — a stop()/external SIGKILL can tear the session jsonl
      // mid-append too, and the next call must not resume a truncated file.
      quarantineSession("signal death");
      // S2-7: Bun exposes no timed-out flag, so elapsed time discriminates
      // the native timeout from stop()/external kills (25 ms slack for timer
      // scheduling — a stop() landing inside the slack reads as a timeout).
      // S2-6 (round 7): only trust the discriminator when timeoutMs clears
      // the slack — at timeoutMs <= 25 the clamp floor (1 ms) makes
      // `elapsed >= timeoutMs - 25` true for EVERY signal death, so those
      // classify as plain signal deaths instead.
      if (timeoutMs > 25 && performance.now() - spawnedAt >= timeoutMs - 25) {
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
      // S2-5: with no process ever spawned there is no exit to wait for —
      // release the claim immediately so a later startResident can arm.
      if (proc === null) {
        LIVE_SESSION_PATHS.delete(sessionPath);
        return;
      }
      try {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone — the awaited exit below is the truth
        }
        // S2-5 (round 8): hold the session-path claim until the child has
        // fully exited — releasing it before this await lets a concurrent
        // startResident arm a second live resident on the same session file
        // while the dying child can still append to it.
        await proc.exited.catch(() => {});
        if (current === proc) current = null;
      } finally {
        LIVE_SESSION_PATHS.delete(sessionPath);
      }
    },
  };
}
