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

import { log } from "../lib/log.ts";
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
 *  - a long OPAQUE token, the fallback for UNPREFIXED tokens only. The hex-digest
 *    exemption is what keeps a 40-char git SHA — the field these lines exist to
 *    carry — readable, and `PATH_TOKEN_RE` is what keeps an ordinary absolute
 *    path readable;
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
 * Residual gap, accepted: an unprefixed HEX secret from an issuer not on the
 * list is indistinguishable from a git SHA by shape alone, and passes through
 * (see `isLongOpaqueToken` for why that one exemption survives and the other
 * single-class exemptions did not). Close it by adding the issuer's prefix to
 * `SECRET_PREFIXES`.
 *
 * Fail-safe, not fail-open: the whole body is guarded, and a throw returns the
 * REDACTED marker rather than the raw text. Every caller here is a CATCH block
 * logging someone else's failure — a redactor that throws does not merely lose
 * a diagnostic, it REPLACES the failure being reported with its own.
 */
const REDACTED = "«redacted»";

/**
 * A PEM block, swallowed whole. `-----BEGIN` IS in `SECRET_PREFIXES`, but the
 * prefix arm's charset excludes the space in `-----BEGIN RSA PRIVATE KEY-----`,
 * so it stops at the header and leaves the body to the long-token arm — which
 * sees the body one line at a time and passes every line that is under 40
 * characters, i.e. the last line of essentially every key. A private key is not
 * a token, it is a block, and the block is what has to go.
 *
 * The match runs to `-----END …-----`, or — a truncated key is still a key —
 * for `PEM_MAX_BODY` characters, whichever comes first. The tail used to be
 * `|$`, i.e. UNBOUNDED: one `-----BEGIN` in provider free text with no closing
 * marker swallowed the message to its end, so a whole multi-KB `driver.exec`
 * diagnostic came out as the six characters of the placeholder. That text is
 * whatever the box printed, which makes a whole-message eraser purchasable for
 * ten literal characters. MEASURED on 1 MB of `-----BEGIN` mentions: 3 bytes
 * of surviving diagnostic before, 507 KB after.
 *
 * The alternation is ordered terminated-first and its SECOND branch cannot
 * fail, which is what keeps the scan linear. A bounded arm that can fail is
 * retried at every `-----BEGIN` in the text, paying the full cap each time —
 * measured at 3.7 s on that same 1 MB input. Here every attempt consumes as
 * much as it inspects, so the cost is amortised away (1 ms on the same input,
 * and on END-heavy and long-line shapes).
 *
 * The footer label is `[^\n-]*`, not `[^\n]*`: the class stops at the first
 * `-`, so the required `-----` either matches right there or the attempt dies
 * without giving characters back. Real PEM labels ("RSA PRIVATE KEY",
 * "OPENSSH PRIVATE KEY") carry no dash, and one that somehow did falls into
 * the second branch — bounded, and still redacted.
 *
 * `PEM_MAX_BODY` is sized past the largest key anyone mints (an 8192-bit RSA
 * private key PEM is ~6.5 KB). Residual, accepted: a block LONGER than the cap
 * keeps its tail — but that tail is 64-char base64 lines, which the long-token
 * arm now redacts one line at a time (only a sub-40-char final line survives,
 * as a fragment).
 */
const PEM_MAX_BODY = 8192;
const PEM_BLOCK_RE = new RegExp(
  `-----BEGIN(?:[\\s\\S]{0,${PEM_MAX_BODY}}?-----END[^\\n-]*-----|[\\s\\S]{0,${PEM_MAX_BODY}})`,
  "g",
);

const SECRET_PREFIX_RE = new RegExp(
  `(^|[^A-Za-z0-9])(?:${SECRET_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})[A-Za-z0-9+/=_.:-]*`,
  "g",
);
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_.:-]{40,}/g;

/**
 * The long-token arm's own test, factored out so the path exemption can
 * re-apply it per path segment.
 *
 * THE RULE: ≥40 characters and not a hex digest.
 *
 * It used to be ≥40 characters AND all three of `[a-z]`, `[A-Z]`, `\d`, which
 * meant any token missing ONE class passed at ANY length — an all-lowercase
 * base64url blob, an uppercase+digits token, a 60-char all-digit run. Those are
 * shapes issuers actually mint, so requiring all three was not the
 * "all-lowercase-hex residual" the header used to admit to; it was a hole the
 * width of every single-class alphabet.
 *
 * The exemption is narrowed to the ONE shape this log exists to carry: a hex
 * digest — all `[0-9a-f]` or all `[0-9A-F]`, AND carrying at least one `a-f`
 * letter. Git SHAs, sha256 digests and content hashes are exactly that and stay
 * readable. The letter clause is what stops an all-DIGIT token from riding the
 * exemption: a real 40-char hex digest contains no a–f at probability
 * (10/16)^40 ≈ 1e-9, so nothing readable is lost and an all-digit secret is now
 * caught.
 *
 * Two classes is NOT the rule, and cannot be: a lowercase-hex git SHA has two
 * (letters + digits), so "≥2 classes" would redact every SHA in these lines.
 *
 * Cost, accepted: a ≥40-char non-hex identifier with no `/` separators — a long
 * dotted package name, say — is now redacted whole. The long readable tokens
 * these lines actually carry are paths and SHAs, and both keep an exemption.
 */
const HEX_DIGEST_RE = /^(?:[0-9a-f]+|[0-9A-F]+)$/;
const HEX_LETTER_RE = /[a-fA-F]/;

function isLongOpaqueToken(t: string): boolean {
  if (t.length < 40) return false;
  return !(HEX_DIGEST_RE.test(t) && HEX_LETTER_RE.test(t));
}

/**
 * The long-token arm's path exemption. `/`, `.`, `-` and `_` are all inside
 * `LONG_TOKEN_RE`'s charset, so an ordinary absolute path is ONE token, and one
 * no hex-digest exemption will ever cover:
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
  if (!isLongOpaqueToken(t)) return t;
  if (!PATH_TOKEN_RE.test(t) || !PATH_PUNCT_RE.test(t)) return REDACTED;
  return t
    .split("/")
    .map((segment) => (isLongOpaqueToken(segment) ? REDACTED : segment))
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
 * token. Text that forges a mark still only gets a non-secret identifier
 * spliced back in — and only as many times as this call actually parked one,
 * which is what stops the forgery being an amplifier (see the budget below).
 */
const KEEP_MARK = "«keep»";
/** Literal, no metacharacters — `«`, `k`, `e`, `p`, `»` are all inert. */
const KEEP_MARK_RE = /«keep»/g;
const MIN_KEEP_LEN = 8;

export function redactSecrets(text: unknown, keep?: string): string {
  try {
    // The deep-link arm runs FIRST and on the GENUINELY untouched text — it is
    // the only arm that matches a whole URL rather than a token, so it must not
    // have to recognize one anything else has rewritten. Parking `keep` counted
    // as rewriting: `KEY_MANAGEMENT_URL_RE`'s tail is `[0-9a-zA-Z%_-]{8,}` and
    // the mark's guillemets are outside that charset, so once `keep` (or any
    // longer id merely CONTAINING it) had been parked, `…/keys/«keep»…` no
    // longer matched — and the splice-back then handed the id back inside a
    // live URL the arm exists to remove. Running before the park is what makes
    // the arm see the text as the provider wrote it.
    const linkRedacted = redactKeyManagementUrls(asText(text));

    // The ≥8 floor stops a short `keep` from splitting a real secret into
    // unmatchable pieces (same boundary as `redactWithKey`'s).
    const keepToken = keep !== undefined && keep.length >= MIN_KEEP_LEN ? keep : undefined;
    // How many marks THIS call parked. The splice-back below restores at most
    // that many: `split(KEEP_MARK).join(keep)` restored at EVERY mark including
    // ones the SOURCE text supplied, so provider text carrying N forged marks
    // expanded the log line by N × the hash length — a cheap, attacker-chosen
    // amplification into the log sink. The forged marks are harmless in
    // themselves (only a non-secret identifier is ever spliced in); the COUNT
    // was the problem, and the budget is what bounds it.
    let budget = 0;
    let source = linkRedacted;
    if (keepToken !== undefined) {
      const parts = linkRedacted.split(keepToken);
      budget = parts.length - 1;
      source = parts.join(KEEP_MARK);
    }

    const redacted = source
      .replace(PEM_BLOCK_RE, REDACTED)
      .replace(SECRET_PREFIX_RE, (_m, lead: string) => `${lead}${REDACTED}`)
      .replace(LONG_TOKEN_RE, redactLongToken);

    if (keepToken === undefined) return redacted;
    return redacted.replace(KEEP_MARK_RE, () => (budget-- > 0 ? keepToken : KEEP_MARK));
  } catch {
    // Fail SAFE, not fail open. Every caller is a catch block logging someone
    // else's failure, so a throw escaping here would replace that failure with
    // this function's own — and the fallback can never be the raw text, because
    // the raw text is exactly what was not yet proven free of key material.
    // Losing a diagnostic beats leaking a key.
    return REDACTED;
  }
}

/**
 * An operator-supplied identifier, made safe to echo into a log line: redacted,
 * then capped.
 *
 * Lifted here from `scripts/fleet.ts` when the approval gate became a second
 * caller — one implementation, next to the redactor it composes, rather than
 * two copies drifting apart. `src/` cannot import from `scripts/`, so the
 * shared callee is the only shape that works.
 *
 * REDACT first, THEN cap. Capping first sliced a pasted credential across the
 * 96-char boundary into halves neither redaction rule matches, and nothing
 * downstream of these sinks redacts at all, so the head went out verbatim.
 * Minted ids (`qds-YYYYMMDD-hex`, well under `redactSecrets`' 40-char floor)
 * pass through untouched, so ordinary runs log exactly as before.
 *
 * The cap is what stops an unvalidated id — these sinks are reached from
 * `finally`/`catch` blocks that run BEFORE or INSTEAD OF the grammar check —
 * from writing 200 KB into the operator's log stream.
 *
 * The cap is on the RETURN, not the head: `…(N chars)` rides inside it, so the
 * total is never more than `MAX_ECHO` UTF-16 units. The head is cut on CODE
 * POINTS — slicing units put a lone surrogate at the boundary, and the halved
 * pair is what then reached the log sink (JSON.stringify mangles it, a file
 * write replaces it with U+FFFD).
 */
export const MAX_ECHO = 96;
export function boundedEcho(s: string | undefined): string {
  if (s === undefined) return "(none)";
  const safe = redactSecrets(s);
  if (safe.length <= MAX_ECHO) return safe;
  const suffix = `…(${safe.length} chars)`;
  return `${cutBeforeBrokenSurrogate(safe, MAX_ECHO - suffix.length)}${suffix}`;
}

/** Slice to at most `cap` UTF-16 units without splitting a surrogate pair: a
 * low surrogate at the cut belongs to the high surrogate before it, so the cut
 * backs up one unit to keep the pair whole (no-op when `cap` already lands on a
 * code-point boundary). */
function cutBeforeBrokenSurrogate(s: string, cap: number): string {
  if (cap <= 0) return "";
  const hi = s.charCodeAt(cap - 1);
  const lo = s.charCodeAt(cap);
  const split = hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
  return s.slice(0, split ? cap - 1 : cap);
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
 * `extra` is caller-supplied CODE run at log time. Round 4 (P46/D10) made its
 * long-standing docstring contract ENFORCED rather than advised: a throwing
 * callback degrades to `{}`, so it can neither convert a successful step into
 * a reported failure (the success arm's spread used to sit inside the try) nor
 * replace the failure being reported (the catch arm's).
 */
function extraFields(
  extra: ((durationMs: number) => Record<string, unknown>) | undefined,
  durationMs: number,
): Record<string, unknown> {
  if (extra === undefined) return {};
  try {
    return extra(durationMs);
  } catch {
    return {};
  }
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
  /**
   * Extra fields for BOTH outcome arms, computed from the step's own measured
   * duration. Exists for the DF1.10 Observability Contract's sub-timing keys
   * (e.g. `harvest_pull_ms`): the value is the duration the line already
   * carries, but a consumer greps the EXACT key, so the key has to literally
   * be on the line — and only the step knows which contract alias its line
   * must answer to. A throwing callback is degraded to {} (`extraFields`), so
   * it can never reshape the outcome — but keep it to an object literal
   * anyway: on throw, the fields it was asked for are silently absent.
   */
  extra?: (durationMs: number) => Record<string, unknown>,
): Promise<T> {
  const started = Date.now();
  const base = stepBase(ctx, prefix, step);
  try {
    const result = await fn();
    const durationMs = Date.now() - started;
    log({
      ...base,
      duration: durationMs,
      durationMs,
      status: "ok",
      outcome: labels.ok,
      [`${step}_ms`]: durationMs,
      ...extraFields(extra, durationMs),
    });
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
      ...extraFields(extra, durationMs),
    });
    throw e;
  }
}
