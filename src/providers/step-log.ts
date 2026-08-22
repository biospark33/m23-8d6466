/**
 * Shared per-step observability (DF2.5) — the one timed/logged-step shape
 * behind harvest's `timedStep` and teardown's `runStep`.
 *
 * Both streams emit the credentials.ts `timed` contract: one JSON line per
 * step with `duration` + `durationMs` + a `<step>_ms` sub-timing, `status`,
 * and an outcome drawn from each stream's own vocabulary (harvest ok/error,
 * teardown ran/failed/skipped). The vocabulary and the operation prefix are
 * the only per-caller differences, so they are the only parameters.
 */

import { log } from "../swarmclaw/log.ts";
import { redactKeyManagementUrls } from "./cap-rejection.ts";
import { SECRET_PREFIXES } from "./run-record.ts";

/**
 * INV-2 in the other direction: `assertNoSecret` REFUSES these shapes on the
 * way into a record; this masks them on the way into a log line.
 *
 * Load-bearing on the credentials path. `deliverRunKey` writes the minted
 * OpenRouter key into the box through `driver.exec`, and an exec wrapper that
 * echoes the failed argv — the ordinary way one reports a failure — puts the
 * key plaintext into `err.message`, which this module then writes out. INV-4
 * says the plaintext exists in the mint return and nowhere else. Dispatch's own
 * `redact` is no help here and could not be reused anyway: it enforces INV-6
 * (deep-link URL parameters) and only matches `https?://…`, a bare `sk-…` has no
 * scheme, and `src/providers/` does not import from `src/fleet/`. The two are
 * COMPOSED, not duplicated — dispatch imports this function for the third-party
 * free text its own rule deliberately does not cover (see `errorMessage` there),
 * and there is exactly one implementation of each rule.
 *
 * Four arms, in this order, the middle two lifted from `assertNoSecret`'s
 * reasoning:
 *  - a PEM block, swallowed whole (see `PEM_BLOCK_RE`);
 *  - the known prefixes, matched at a token boundary so `task-runner` does not
 *    trip on `sk-`. This arm is UNCONDITIONAL: a known issuer prefix is the
 *    strong signal, so `AKIA…`/`ghp_…` are redacted whatever their character
 *    classes are. Character-class mixing is never the sole test for a token an
 *    issuer has already labelled;
 *  - a long mixed-class token, the fallback for UNPREFIXED tokens only. The
 *    mixed-class requirement is what keeps a 40-char all-hex git SHA and an
 *    all-lowercase run id — the fields these lines exist to carry — readable,
 *    and `PATH_TOKEN_RE` is what keeps an ordinary absolute path readable;
 *  - the key-management deep link, composed from DF2.4's own implementation
 *    (see below).
 *
 * `redactKeyManagementUrls` is COMPOSED here rather than at each sink, because
 * the shape it catches is structurally invisible to the three arms above and
 * every sink needs it: no `SECRET_PREFIXES` entry matches `https`, and
 * `encodeURIComponent` turns the hash's `+`/`/`/`=` into `%2B`/`%2F`/`%3D`
 * whose `%` is outside every charset here, so the full deep link is never one
 * ≥40-char token. Composing it at the ONE shared redactor is what puts it in
 * front of credentials.ts's `timed`, this module's `timedLoggedStep` and
 * dispatch's `redact` at once — `scripts/cap-hit-demo.ts`'s `safeRedact`
 * already composed it by hand for exactly this shape, and per-sink composition
 * is how the other three sinks were missed.
 *
 * Residual gap, accepted: an unprefixed all-lowercase-hex (or all-uppercase)
 * secret from an issuer not on the list is indistinguishable from a git SHA by
 * shape alone, and passes through. Loosening arm 3 to catch it would redact
 * every SHA and run id in these lines — the wrong trade for a log whose job is
 * to carry them. Close it by adding the issuer's prefix to `SECRET_PREFIXES`.
 */
const REDACTED = "«redacted»";

/**
 * A PEM block, swallowed whole. `-----BEGIN` IS in `SECRET_PREFIXES`, but the
 * prefix arm's charset excludes the space in `-----BEGIN RSA PRIVATE KEY-----`,
 * so it stops at the header and leaves the body to the long-token arm — which
 * sees the body one line at a time and passes every line that is under 40
 * characters or single-class, i.e. the last line of essentially every key. A
 * private key is not a token, it is a block, and the block is what has to go.
 *
 * The match runs to `-----END …-----` or, failing that, to end of text: a
 * truncated key is still a key. Prose that merely mentions `-----BEGIN` is
 * therefore eaten to the end of the line's text — over-redaction, the safe
 * direction, and the only shape that pays for it is a log message quoting the
 * marker without a key attached.
 */
const PEM_BLOCK_RE = /-----BEGIN[\s\S]*?(?:-----END[^\n]*-----|$)/g;

const SECRET_PREFIX_RE = new RegExp(
  `(^|[^A-Za-z0-9])(?:${SECRET_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})[A-Za-z0-9+/=_.:-]*`,
  "g",
);
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_.:-]{40,}/g;

/**
 * The long-token arm's own test, factored out so the path exemption can
 * re-apply it per path segment.
 */
function isLongMixedToken(t: string): boolean {
  return t.length >= 40 && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t);
}

/**
 * The long-token arm's path exemption. `/`, `.`, `-` and `_` are all inside
 * `LONG_TOKEN_RE`'s charset, so an ordinary absolute path is ONE token that
 * mixes all three character classes:
 * `/Users/steve/QDS-Factory/.sandbox/runs/qds-20260822-a1b2c3.json` was
 * redacted whole, and every stack frame with it — every `/Users`-rooted or
 * CamelCase-repo path with a digit in it erased, unevenly, which reads in the
 * field as a redaction bug and hides the very fields these lines carry.
 *
 * A token is a path when it has ≥2 `/` separators, every segment is a
 * plausible path component (≤32 chars; the leaf ≤64, which is where a
 * `driver.ts:318:20` frame suffix lands), and it carries at least one of
 * `.` `_` `:` `-`. That last clause is what keeps a base64 blob out: standard
 * base64 is `A-Za-z0-9+/=` and holds none of those four, while URL-safe base64
 * swaps `/` for `_` and so never satisfies the separator count.
 *
 * The exemption is not a pass — the segments are re-tested individually, so
 * `/tmp/keys/<40-char mixed token>` still redacts the leaf and keeps the
 * directory readable. Residual, accepted: a standard-base64 secret carrying ≥2
 * `/` AND one of `._:-` (i.e. mixing both alphabets) whose every `/`-delimited
 * run is under 40 characters would survive. Nothing an issuer mints has that
 * shape, and the prefix arm covers every issuer we know by name.
 */
const PATH_TOKEN_RE = /^(?:[A-Za-z0-9+=_.:-]{0,32}\/){2,}[A-Za-z0-9+=_.:-]{0,64}$/;
const PATH_PUNCT_RE = /[._:-]/;

function redactLongToken(t: string): string {
  if (!isLongMixedToken(t)) return t;
  if (!PATH_TOKEN_RE.test(t) || !PATH_PUNCT_RE.test(t)) return REDACTED;
  return t
    .split("/")
    .map((segment) => (isLongMixedToken(segment) ? REDACTED : segment))
    .join("/");
}

/**
 * Anything → a string, without ever throwing: a rejection may carry a
 * non-string `message` (`{message: 42}`, `{message: {detail}}`), and `String`
 * itself throws on a null-prototype or hostile-`toString` value. A logger that
 * throws while reporting a failure REPLACES the failure it was reporting.
 */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return String(v);
  } catch {
    return "[unprintable]";
  }
}

/**
 * `keep` is a caller-known NON-secret identifier (in practice a provider
 * keyHash) that arm 2 would otherwise swallow — see `credentials.ts`'s
 * revoke-failed line, whose "the key may still be live" remediation is useless
 * without the hash naming which key. It is parked behind a redaction-inert
 * mark and restored afterwards; nothing else is exempted, and the ≥8 floor is
 * what stops a short `keep` from splitting a real secret into unmatchable
 * pieces (same boundary as `redactWithKey`'s).
 *
 * The mark reuses the guillemets of the placeholder itself: neither character
 * is in either token charset, so the mark cannot merge with a neighbouring
 * token — and text that forges one only gets a non-secret hash spliced back in.
 */
const KEEP_MARK = "«keep»";
const MIN_KEEP_LEN = 8;

export function redactSecrets(text: unknown, keep?: string): string {
  const parked = keep && keep.length >= MIN_KEEP_LEN;
  const source = parked ? asText(text).split(keep).join(KEEP_MARK) : asText(text);
  // The deep-link arm runs FIRST, on the untouched text: it is the only arm
  // that matches a whole URL rather than a token, and it must not have to
  // recognize one the other three have already partly rewritten.
  const redacted = redactKeyManagementUrls(source)
    .replace(PEM_BLOCK_RE, REDACTED)
    .replace(SECRET_PREFIX_RE, (_m, lead: string) => `${lead}${REDACTED}`)
    .replace(LONG_TOKEN_RE, redactLongToken);
  return parked ? redacted.split(KEEP_MARK).join(keep) : redacted;
}

/** Per-step log context — propagated ids plus the driver name. */
export interface StepCtx {
  requestId: string;
  runId: string;
  driver: string;
}

/** Base fields of every step line; `operation` is `<prefix>.<step>`. */
export function stepBase(ctx: StepCtx, prefix: string, step: string) {
  return {
    requestId: ctx.requestId,
    operation: `${prefix}.${step}`,
    agentId: null,
    timestamp: new Date().toISOString(),
    runId: ctx.runId,
    step,
    driver: ctx.driver,
  };
}

export interface StepLogLabels {
  /** Ok-path outcome (harvest: "ok"; teardown: "ran"). */
  ok: string;
  /** Error-path outcome (harvest: "error"; teardown: "failed"). */
  error: string;
  /** Fallback code when the thrown value carries none of its own. */
  errorCode: string;
}

/**
 * Run `fn` as one timed, logged step. A throw is logged (code + remediation,
 * env-var NAMES only, never expanded) and re-thrown unchanged — the logger
 * never swallows or reshapes a failure. The message and remediation are
 * secret-redacted on the way OUT (see `redactSecrets`); the re-thrown error is
 * untouched, so a caller that needs the raw text still has it.
 */
export async function timedLoggedStep<T>(
  ctx: StepCtx,
  prefix: string,
  step: string,
  labels: StepLogLabels,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const base = stepBase(ctx, prefix, step);
  try {
    const result = await fn();
    const durationMs = Date.now() - started;
    log({ ...base, duration: durationMs, durationMs, status: "ok", outcome: labels.ok, [`${step}_ms`]: durationMs });
    return result;
  } catch (e) {
    const durationMs = Date.now() - started;
    // `fn` may reject with a non-Error — even null/undefined. Normalize so the
    // logger cannot itself throw (and mask the original failure) while
    // reporting one.
    const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
    log({
      ...base,
      duration: durationMs,
      durationMs,
      status: "error",
      // Redacted, not dropped: the free text is how an operator diagnoses a
      // failed step, and every step here can carry provider text. The code is
      // ours and never carries a value.
      // `?? e`, not `?? String(e)`: `redactSecrets` coerces (and `String` is
      // itself throwable on a null-prototype value), so the whole message path
      // — a non-string `message`, a missing one, a hostile one — is normalized
      // in exactly one place instead of at each of the four sinks.
      error: { code: err.code ?? labels.errorCode, message: redactSecrets(err.message ?? e) },
      // `typeof`, not `??`: a non-Error carrying a null remediation must log a
      // null remediation, not the string "null".
      remediation: typeof err.remediation === "string" ? redactSecrets(err.remediation) : null,
      outcome: labels.error,
      [`${step}_ms`]: durationMs,
    });
    throw e;
  }
}
