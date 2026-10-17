/**
 * Brief schema (Story DF3.1, Agent A): INV-2 closed validation.
 *
 * C3: requestId is LOOSE at schema layer — any string of sane length with no
 * control characters passes; no UUID shape is required. UUID validation happens
 * in dispatch via resolveRunCorrelation.
 */
import { z } from "zod";
import {
  MAX_ISSUE_ID,
  REPO_SLUG_PATTERN,
  canonicalRepoSlug,
  isValidWorkId,
} from "../phase-engine/issue-correlation.ts";

/**
 * `.` and `..` pass the slug charset but are not repository names. They are
 * refused here because the slug is an identity key, not free text: it is the
 * SQL predicate every spend aggregate filters on and the `${slug}#${issueId}`
 * lookup key for a per-issue cap override, and neither is a thing `..` should
 * be able to name.
 *
 * (An earlier revision justified this by the slug reaching `join()` on a log
 * path. It does not — no path anywhere is built from the slug, and the
 * dispatch log's path is derived from the store dir. The guard is right; the
 * reason was not.)
 */
function hasNoDotSegment(slug: string): boolean {
  return !slug.split("/").some((seg) => seg === "." || seg === "..");
}

/**
 * `manifestPath` is the one field that IS literally a host filesystem path: the
 * dispatcher resolves it against the repo root and reads the bytes, which then
 * land inside the box or get quoted back in an error. A `..` segment walks out
 * of that root, so it is refused here — INV-2 puts the trust boundary at the
 * schema, and `dispatch.ts`'s containment root + realpath check is the second
 * gate, not the first.
 *
 * Only `..`, unlike `repoSlug` above: in a slug `.` is an entire owner or
 * repository name and so is never legitimate, whereas in a path `./pipeline.json`
 * is an ordinary way to write a path and resolves nowhere new.
 *
 * Backslash counts as a separator, not as a filename character: `..\..\etc\hosts`
 * is a single POSIX filename today, but the guard's claim is about traversal and
 * a Windows host would walk it. Splitting on both costs nothing and cannot
 * over-reject — a real manifest path has no backslash segments either way.
 */
function hasNoParentSegment(p: string): boolean {
  return !p.split(/[\\/]/).includes("..");
}

/**
 * An ABSOLUTE path needs no `..` to escape: `resolve(repoRoot, "/etc/shadow")`
 * discards the root entirely and returns `/etc/shadow`, so the parent-segment
 * guard above was never the containment check its name implied. The trust
 * boundary is here (INV-2), so the schema requires the field to be what its
 * only consumer treats it as — a path RELATIVE to the repo the brief names.
 *
 * Drive-letter and UNC forms (`C:\…`, `\\host\share`) are refused by the same
 * rule for the same reason as the backslash split above.
 */
function isRelativePath(p: string): boolean {
  return !/^[\\/]/.test(p) && !/^[A-Za-z]:/.test(p);
}

/**
 * The Unicode control category (C0, DEL, C1) — written `\p{Cc}` rather than as a
 * `\x00-\x1f` range so the source itself carries no control characters.
 * Two distinct failures, one guard:
 *  - a NUL byte reaches Node `fs` as an untyped `ERR_INVALID_ARG_VALUE` rather
 *    than the exit 2 this schema exists to produce; and
 *  - a newline or CR in a value that is interpolated into the operator-facing
 *    log stream forges a log line ("…\nFLEET dispatch ok runId=fake").
 *
 * It applies to the URL fields too, and there it is load-bearing rather than
 * belt-and-braces: WHATWG `URL` STRIPS tab/LF/CR before parsing, so
 * `https://git\nhub.com/o/r` satisfies `.url()`, the `^https://` regex AND the
 * `repoSlugOfUrl` cross-check — every guard downstream sees the stripped form
 * while the log stream sees the raw one. The check has to run on the RAW
 * string, which is exactly what a `.regex()` on the field does.
 */
/*
 * `\p{Cc}` alone reaches C0/DEL/C1 and stops there, which misses the three
 * classes that forge the very log line this guard exists to protect:
 *   \p{Zl} U+2028 and \p{Zp} U+2029 are JS LINE TERMINATORS, so any consumer
 *     reading the stream through a JS or JSON-ish parser sees a forged record —
 *     the exact threat named above, reachable without a `\n`.
 *   \p{Cf} carries U+202E (RTL override), which reorders what a terminal
 *     renders without changing a byte, and U+200B/U+FEFF, which hide inside an
 *     identifier that later keys the ledger.
 */
const CONTROL_CHAR_CLASS = "\\p{Cc}\\p{Zl}\\p{Zp}\\p{Cf}";
const NO_CONTROL_CHARS = new RegExp(`^[^${CONTROL_CHAR_CLASS}]*$`, "u");
/**
 * The same class as a MATCHER rather than a rejecter, for `sanitizeLabel`. Built
 * from one shared source string on purpose: the two are the accept and the
 * repair arm of a single rule, and written as two literals they stop agreeing
 * the moment either grows a category.
 */
const CONTROL_CHARS_G = new RegExp(`[${CONTROL_CHAR_CLASS}]`, "gu");

/**
 * The one ill-formedness the category classes above cannot see: a LONE
 * surrogate. `\uD800` unpaired is an unassigned code point, not Cc/Zl/Zp/Cf,
 * so `cfg/pi\u{D800}pe.json` passes NO_CONTROL_CHARS and reaches Node `fs`,
 * which answers it with the same untyped `ERR_INVALID_ARG_VALUE` the NUL arm
 * exists to prevent — a lone surrogate has no UTF-8 encoding, and every fs
 * call that takes a string refuses mid-surrogate instead of producing the
 * exit 2 this schema owns.
 *
 * `isWellFormed` (ES2024) is exactly that predicate, and it rides WITH the
 * control-char rule wherever the rule applies — as this rejecter on each field
 * that carries NO_CONTROL_CHARS, and as the matcher half inside
 * `sanitizeLabel` — so the two arms keep agreeing by construction.
 *
 * Implemented as a scan rather than `String.prototype.isWellFormed` because the
 * project's lib target predates ES2024; the semantics are copied verbatim: a
 * high surrogate must be followed by a low one, a low one must follow a high.
 */
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (!(s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) return false;
      i++; // the pair was consumed as one unit
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false; // low surrogate with no high before it
    }
  }
  return true;
}

/**
 * The matcher arm of the same rule, shared with `sanitizeLabel`: code points
 * iterated whole, so a PAIRED surrogate survives as one unit while a lone one
 * becomes U+FFFD. Run AFTER any slicing so a cap cut through a pair cannot
 * leave half of one behind either.
 */
function repairLoneSurrogates(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    out += cp >= 0xd800 && cp <= 0xdfff ? "\u{FFFD}" : ch;
  }
  return out;
}

/**
 * Attacker-authored text on its way into an operator-facing label: control
 * characters removed, lone surrogates replaced with U+FFFD, length capped.
 *
 * Every guard above is on a brief VALUE, and that leaves the REJECTION path
 * uncovered — a key NAME is attacker-chosen, is never matched against any
 * schema (that is what makes it unrecognized), and comes straight back out
 * through `extractZodErrorField`. So the one threat this file argues at length,
 * a forged log line, was reachable through the refusal rather than the
 * acceptance. Uncapped, so was 4 MB of it landing in the persisted dispatch log
 * — the same "a 10 MB id in the ledger key" argument the length caps below
 * already make, applied to the side of the boundary that refuses.
 *
 * Applied at the PRODUCER, not left to each consumer. `dispatch.ts` does escape
 * the name with `JSON.stringify` in its message and remediation, and that
 * escaping stays — but a rule every caller has to remember is one a caller
 * eventually forgets, which is the argument `redactDeep` there already makes
 * for redaction. The label is a name, not a payload; the brief JSON the
 * operator is being sent back to still holds the byte-exact key.
 *
 * STRIPS rather than escapes: an escaped form is only readable if the consumer
 * renders it, and the cheapest thing that is safe in EVERY consumer — a raw
 * terminal, a log line, a JSON field — is a string that no longer contains the
 * characters. Callers that want fidelity keep their own escaping on top.
 *
 * Exported because `status.ts` applies the same two rules to substrate-supplied
 * box names and URLs, which are the LESS trusted of the two sources: a brief is
 * refused before it can spend, an orphan row describes a box already billing.
 */
export function sanitizeLabel(text: string, max: number): string {
  // `max < 1` cannot hold a label; returning "" keeps the length invariant
  // below total rather than letting `slice(0, max - 1)` read as `slice(0, -1)`
  // (everything but the last unit) at that bound.
  if (max < 1) return "";
  // `repairLoneSurrogates` is the matcher arm of the lone-surrogate rule: a
  // stripped string can still carry one — including one born from the length
  // cap slicing through a pair — and the label's whole claim is that nothing in
  // it can surprise a consumer — an fs path among them.
  const capped = text.replace(CONTROL_CHARS_G, "");
  // `max - 1` before the ellipsis, not `max`: appending to a full `max`-unit
  // slice produced `max + 1` UTF-16 units, so "capped at `max`" was false by
  // exactly one character on every input long enough to be capped at all.
  // The result is now never longer than `max` units.
  const sliced = capped.length > max ? `${capped.slice(0, max - 1)}…` : capped;
  return repairLoneSurrogates(sliced);
}

/**
 * The repository a clone URL identifies, as a CANONICAL slug: pathname,
 * slashes trimmed, a `.git` suffix dropped, case folded. `undefined` when the
 * URL will not parse — the `.url()` check has already refused those, so the
 * cross-check never sees one — and ONLY then.
 *
 * A path that cannot name a slug is deliberately NOT a second `undefined` arm.
 * `https://github.com/` yields `""` and `https://host/a/b/c` yields `a/b/c`,
 * and both are handed on as-is: `canonicalRepoSlug` is a trim-and-fold with no
 * assertion in it (see its source — it cannot throw), and the caller's
 * comparison is the guard. `""` and `a/b/c` compare unequal to every value
 * `REPO_SLUG_PATTERN` admits, so both refuse as exit 2 through the refine, and
 * a segment-count or charset check here would be a second gate that can only
 * ever agree with the first. (An earlier revision of this docstring claimed the
 * missing arm existed; it never did, and nothing depended on it.)
 *
 * Nothing here percent-DECODES, and nothing needs to: `URL.pathname` leaves
 * escapes encoded, and `%` is not in the slug charset `[A-Za-z0-9._-]` — so an
 * escaped path can never compare equal to a slug and is refused by the
 * comparison itself. Decoding would only invite the double-encoding question
 * (`%252e`) for no reachable gain.
 *
 * Canonical on both sides, so `github.com/Owner/Repo` satisfies a
 * `repoSlug: "owner/repo"` — the forge folds that case, and after
 * `resolveRunCorrelation` so does the ledger.
 */
function repoSlugOfUrl(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  // Case-INSENSITIVE, like every other comparison on this path: the strip ran
  // case-sensitively while `canonicalRepoSlug` around it folds case, so
  // `https://github.com/owner/repo.GIT` kept the suffix, compared unequal to
  // `owner/repo` and was refused as naming a different repository.
  return canonicalRepoSlug(pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, ""));
}

/**
 * No `user:pass@host` in a brief-supplied URL — a credential by construction
 * (INV-CRED-1: no second secret in a box).
 *
 * `assertRepoUrl` in `exedev/fill.ts` refuses one too, but that runs AFTER
 * `driver.create()`: a brief this schema can refuse must never burn a billing
 * box INV-5 then forbids destroying. The trust boundary is here (INV-2), and
 * the same rule covers `issueUrl`, which fill never sees at all.
 *
 * Parsed, not sliced: `@` is legal in a path (`/@scope/pkg/issues/1`), so the
 * test is on the parsed userinfo, not on the character. A URL that will not
 * parse is `.url()`'s refusal, not this one's.
 */
function hasNoUserinfo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username === "" && parsed.password === "";
  } catch {
    return true;
  }
}

/**
 * Length caps. Every string field but `repoSlug` was uncapped, and the two
 * things an uncapped field reaches are both unbounded: `manifestPath` goes to
 * `fs`, and `requestId` rides the brief into the run record, the ledger keys and
 * every log correlation line. Sized to be far above any legitimate value and far
 * below "a megabyte of it lands in a persisted record".
 */
const MAX_MANIFEST_PATH = 1024;
/** Exported for `status.ts`, which caps substrate-supplied URLs to the same bound. */
export const MAX_URL = 2048;
/** Exported for `status.ts`, which caps record-supplied request ids to the same bound. */
export const MAX_REQUEST_ID = 128;

/**
 * Cap on the field NAME `extractZodErrorField` hands back. Sized like
 * MAX_REQUEST_ID rather than like a path: this is an identifier an operator
 * greps their brief for, not a value.
 */
const MAX_FIELD_LABEL = 128;

/**
 * DF6.1a's `fixContext` bounds. `bodySnippet` is untrusted quoted review data
 * (CRLF-normalized and redacted BEFORE the brief is built — the schema sees the
 * result), so the caps are the trust boundary that keeps a PR's comment count
 * from growing the brief without limit: at most 20 comments, each snippet at
 * most 4 000 chars (P1.18's own injection cap), and the snippets' UTF-8-encoded
 * bytes summing to at most 40 000. The byte sum is measured on the ENCODED
 * form, not the char count — a 4 000-char snippet of 4-byte code points is 16
 * KB, and the bound exists to size the payload a box receives.
 */
const MAX_FIX_COMMENTS = 20;
const MAX_FIX_COMMENT_ID_CHARS = 20;
const MAX_FIX_AUTHOR_CHARS = 100;
const MAX_FIX_SNIPPET_CHARS = 4000;
const MAX_FIX_SNIPPET_BYTES_TOTAL = 40_000;

/**
 * M1.2 AC3: the `<kg_context>` memory appendix ceiling. The same number lives
 * producer-side as `KG_CONTEXT_MAX_CHARS` (src/hindsight/kg-context.ts) and is
 * DELIBERATELY NOT imported from there: this schema is the box-compiled trust
 * boundary (INV-2), so importing from src/hindsight/ would couple what the box
 * ships to what the host compiles. The duplication is the accepted cost of that
 * separation, and the drift it permits is loud in the dangerous direction: the
 * producer assembles to its own ceiling, so a producer that outgrows this copy
 * of the number is REFUSED here (exit-2 class at dispatch), never truncated —
 * reaching this refusal means the boundary was bypassed, and a silently
 * truncated context would disguise exactly the bug the ceiling exists to
 * surface.
 */
const BRIEF_KG_CONTEXT_MAX_CHARS = 8_000;

/**
 * kgContext's charset, unlike every other field's NO_CONTROL_CHARS above: the
 * value is a MULTI-LINE XML block rendered verbatim into the resident's prompt
 * (pipeline-run.ts's residentContextLines), so \n (0x0a) and \t (0x09) are the
 * payload, not an attack — they are the only C0 code points allowed through.
 * Refused is the full Unicode `Cc` category minus those two — the rest of C0,
 * DEL, and C1 (U+0080–U+009F, the NEL U+0085 among them) — plus the two code
 * points Zl (U+2028) and Zp (U+2029): JS line terminators, so a JS or JSON-ish
 * consumer of the rendered prompt sees a forged record boundary without a `\n`
 * ever appearing. \r is included even though it is only a line boundary for
 * CRLF-folding consumers: the block is \n-joined, so a bare CR mid-line can
 * only ever be a forgery attempt.
 *
 * Written as `\u` ranges rather than `\p{Cc}` because a character class cannot
 * subtract, and because ONE string is the single source the two arms of the
 * rule are built from — the matcher below (kgContextSanitize, the repair arm)
 * and the schema's refine (kgContextIsWellFormed, the reject arm) — so they
 * cannot stop agreeing the way two hand-written literals would.
 *
 * The guard's substance now runs at ALL THREE boundaries: the host schema here,
 * the producer's own assembly, and pipeline-run.ts's box-side render — which
 * re-validates even though the schema already refused, because the value the
 * box reads arrives through run-context.json, a witness FILE inside the
 * checkout that the run's own phases can rewrite (the same reason fixContext's
 * copy is add-only and re-checked). There a non-well-formed value is DROPPED
 * rather than fatal: grounding is best-effort and the resident proceeds
 * unprimed.
 */
const KG_CONTEXT_CONTROL_CLASS = "\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u2028\\u2029";
const KG_CONTEXT_CONTROL_CHARS_G = new RegExp(`[${KG_CONTEXT_CONTROL_CLASS}]`, "gu");

/**
 * Every refused code point removed, \t and \n kept. The repair arm of the rule
 * above: the producer sanitizes with this same function before assembly, so
 * what reaches the schema is already clean and the two layers repair with the
 * exact class the schema refuses on.
 */
export function kgContextSanitize(s: string): string {
  return s.replace(KG_CONTEXT_CONTROL_CHARS_G, "");
}

/**
 * The full kgContext well-formedness predicate: at or under the ceiling, and
 * unchanged by kgContextSanitize (callers holding an unknown-typed value gate
 * on `typeof` first — pipeline-run.ts does). The schema's refine is this
 * predicate outright — the ceiling stays `.max()` above it so a length problem
 * still reports as a length problem — and the box-side render re-applies the
 * SAME predicate against the witness rather than trusting the schema's refusal
 * to have happened on the host.
 */
export function kgContextIsWellFormed(s: string): boolean {
  return s.length <= BRIEF_KG_CONTEXT_MAX_CHARS && kgContextSanitize(s) === s;
}

/**
 * Non-blank, for the two fields whose `.min(1)` was doing the job blankness
 * defeats.
 *
 * `.min(1)` refuses `""` and nothing else, and the reasons it was added — a
 * falsy-vs-present split on `requestId`, an `fs` path on `manifestPath` — are
 * both satisfied by `" "`, which is `\p{Zs}` and so passes NO_CONTROL_CHARS
 * too. `manifestPath: " "` resolves to `<repoRoot>/ ` and fails at `fs` as an
 * untyped error rather than as the exit 2 this schema exists to produce.
 * `.trim().length` is what the `.min(1)` comment's own reasoning implies.
 */
function isNotBlank(s: string): boolean {
  return s.trim().length > 0;
}

// DF3.1 AC1, AC2, INV-2: strict object, closed to unknown fields
export const BriefSchema = z.strictObject({
  // DF3.1 D2: validated owner/name. The pattern is IMPORTED from DF1.8's
  // issue-correlation, not restated: that module owns (repoSlug, issueId)
  // identity, and a second copy of the rule here is a second rule the moment
  // either moves. Note the shape is deliberately two segments — a forge path
  // with more (a GitLab subgroup) has never been expressible as a repoSlug,
  // independently of any cross-check below.
  repoSlug: z
    .string()
    .regex(REPO_SLUG_PATTERN)
    .refine(hasNoDotSegment, "repoSlug segments may not be '.' or '..'"),
  // DF3.1 D2: int >0, MAX_ISSUE_ID capped (assertWithinBudget receives String(issueId))
  // `MAX_ISSUE_ID` is IMPORTED, not restated: DF1.8's issue-correlation owns the
  // bound and `resolveRunCorrelation` refuses against its copy, so a literal
  // here is a second money-adjacent rule that silently stops agreeing the moment
  // either moves — the same argument `REPO_SLUG_PATTERN` above already makes.
  //
  // Q1.7: OPTIONAL. Headless (non-issue) DAG work carries `workId` instead of a
  // synthetic issue id (G8); the object-level refine below enforces exactly one
  // of the two, so neither-at-all is as unrepresentable as both-at-once.
  issueId: z.number().int().positive().max(MAX_ISSUE_ID).optional(),
  // Q1.7 headless briefs: the caller-chosen work id (e.g. "dag/build-docs").
  // The shape rule LIVES in issue-correlation (isValidWorkId) and is imported,
  // not restated — same discipline as REPO_SLUG_PATTERN/MAX_ISSUE_ID above:
  // that module owns (repoSlug, issueId | workId) identity, and the all-digit
  // refusal is a MONEY-adjacent rule (`workId: "42"` would share issue 42's
  // cap) that must not silently diverge between the two layers.
  workId: z
    .string()
    .refine(isValidWorkId, {
      message:
        "workId must match ^[A-Za-z0-9._:/-]{1,64}$ and may not be all digits (all digits collide with a numeric issue's spend identity)",
    })
    .optional(),
  // DF3.1 D2: optional string URL. Same scheme allow-list as repoUrl below:
  // this value lands in the box's run-context.json and in log lines an operator
  // clicks, and `.url()` alone admits `file://` and `javascript:`.
  // The scheme is matched case-INSENSITIVELY against the raw string. URL schemes
  // are case-insensitive, so `.url()` accepts `HTTPS://…` and a case-sensitive
  // `.startsWith` then refused a URL that IS https — a false rejection with a
  // message telling the operator to use the scheme they already used.
  //
  // DELIBERATELY UNBOUND to `repoSlug`/`issueId`, unlike `repoUrl` below. The
  // reason `repoUrl` is bound is spend identity: it is the code that RUNS, and
  // separable from the slug it lets a brief attribute an attacker's repository
  // to a trusted slug's budget. `issueUrl` runs nothing, keys nothing and pays
  // for nothing — `resolveRunCorrelation` carries it through as an opaque
  // `issueUrl ?? null`, and identity is (repoSlug, issueId) with or without it.
  // Binding it would also have to name a URL SHAPE, and `/issues/<n>` is
  // GitHub's; a GitLab subgroup, a self-hosted forge under a path prefix and a
  // `.../-/issues/<n>` all exit 2 against it, which is the over-rejection the
  // host half of the `repoUrl` refine is deliberately avoiding one field down.
  //
  // The residual is real and accepted: a brief can point the human-facing link
  // at any repository and any issue number, so an operator who CLICKS the link
  // in a log line may land somewhere other than the issue that authorized the
  // spend. Nothing downstream trusts it — it is a link, not a lookup.
  issueUrl: z
    .string()
    .max(MAX_URL)
    .regex(NO_CONTROL_CHARS, "issueUrl may not contain control characters")
    .url()
    .regex(/^https:\/\//i, "issueUrl must be an https:// URL")
    .refine(isWellFormed, "issueUrl may not contain unpaired surrogates")
    .refine(hasNoUserinfo, "issueUrl may not carry userinfo (user:pass@host)")
    .optional(),
  // DF3.1 D2: 40-hex regex (setup-gate, fill)
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  // C3: requestId is LOOSE — optional string, NOT .uuid() at schema layer.
  // Non-UUID strings pass schema; UUID validation happens in dispatch (AC2).
  // Capped and control-char-free all the same: C3 relaxes the FORMAT, and
  // neither a 10 MB id in the ledger key nor a newline in the log stream is a
  // format question.
  // `.min(1)` because "" is the one value that is neither absent nor usable:
  // it is falsy, so a downstream `requestId || mint()` reads it as ABSENT while
  // `requestId !== undefined` reads it as PRESENT. That split lets the ack, the
  // run record, the ledger key and the log correlation disagree about one run,
  // and collapses every concurrent run carrying it onto a single empty key.
  requestId: z
    .string()
    .min(1, "requestId may not be empty — omit the key instead")
    .max(MAX_REQUEST_ID)
    .regex(NO_CONTROL_CHARS, "requestId may not contain control characters")
    .refine(isWellFormed, "requestId may not contain unpaired surrogates")
    .refine(isNotBlank, "requestId may not be blank — omit the key instead")
    .optional(),
  // DF3.1 D2: repo-relative path to the pipeline manifest (non-empty, capped,
  // no control chars, no parent traversal, not absolute)
  manifestPath: z
    .string()
    .min(1)
    .max(MAX_MANIFEST_PATH)
    .regex(NO_CONTROL_CHARS, "manifestPath may not contain control characters")
    .refine(isWellFormed, "manifestPath may not contain unpaired surrogates")
    .refine(isNotBlank, "manifestPath may not be blank")
    .refine(hasNoParentSegment, "manifestPath segments may not be '..'")
    .refine(isRelativePath, "manifestPath must be relative to the repo root, not absolute"),
  // DF3.1 D2: for pinned-SHA fill (fill.ts). `.url()` admits every scheme, and
  // this value is handed to a clone inside the box — `file://` would exfiltrate
  // a host path and `ssh://`/`git://` a host key, so the scheme is allow-listed
  // to the one the factory clones over. Case-insensitive for the reason issueUrl
  // gives above.
  repoUrl: z
    .string()
    .max(MAX_URL)
    .regex(NO_CONTROL_CHARS, "repoUrl may not contain control characters")
    .url()
    .regex(/^https:\/\//i, "repoUrl must be an https:// URL")
    .refine(isWellFormed, "repoUrl may not contain unpaired surrogates")
    .refine(hasNoUserinfo, "repoUrl may not carry userinfo (user:pass@host)"),
  // DF6.1a: the allow-listed PR-review-feedback carrier. Optional and strict —
  // it is the validated host-side carrier only (dispatch copies it into the
  // run-context.json witness adds-only; a brief without it is byte-identical to
  // before). The comment payload itself is normalized, bounded and redacted by
  // the brief-build path BEFORE this schema sees it; the schema's job is the
  // closed shape and the ceilings named on the MAX_FIX_* constants above.
  fixContext: z
    .strictObject({
      schemaVersion: z.literal(1),
      botComments: z
        .array(
          z.strictObject({
            // GitHub comment IDs arrive as numbers; carried as digit strings so
            // no precision question ever reaches the dedupe key.
            commentId: z.string().regex(/^\d+$/).max(MAX_FIX_COMMENT_ID_CHARS),
            author: z.string().min(1).max(MAX_FIX_AUTHOR_CHARS),
            bodySnippet: z.string().max(MAX_FIX_SNIPPET_CHARS),
          }),
        )
        .max(MAX_FIX_COMMENTS),
      // DF6.1b: attempt 2's brief carries attempt 1's CI failure and its runId
      // (story AC2 — the one channel that hands content to the box). The
      // ciFailure text is PATTERN-redacted on the host BEFORE it reaches this
      // schema (buildFixBrief's caller), so the box sees what the public PR
      // comment sees. Optional adds-only: a brief without it is byte-identical
      // to before.
      priorAttempt: z
        .strictObject({
          runId: z.string().regex(/^[a-z0-9-]{6,64}$/),
          classification: z.string().min(1).max(64),
          ciFailure: z.string().max(MAX_FIX_SNIPPET_CHARS),
        })
        .optional(),
    })
    .refine(
      (fc) => {
        const encoder = new TextEncoder();
        return (
          fc.botComments.reduce((sum, c) => sum + encoder.encode(c.bodySnippet).length, 0) <=
          MAX_FIX_SNIPPET_BYTES_TOTAL
        );
      },
      {
        message: `fixContext bodySnippets exceed the ${MAX_FIX_SNIPPET_BYTES_TOTAL}-byte UTF-8 total`,
        path: ["botComments"],
      },
    )
    .optional(),
  // M1.2 AC3: the dispatch-time memory appendix, carried VERBATIM into the
  // resident's context by pipeline-run.ts's residentContextLines. Optional and
  // adds-only: a brief without it parses byte-identical to v5. The ceiling and
  // charset above are the trust boundary (INV-KG-3); the refine is the
  // exported predicate outright (see its comment), and the renderer re-applies
  // it box-side rather than re-sanitizing — the value IS a multi-line block
  // and escaping would destroy it.
  kgContext: z
    .string()
    .max(BRIEF_KG_CONTEXT_MAX_CHARS)
    .refine(
      kgContextIsWellFormed,
      "kgContext may not contain control characters other than newline and tab",
    )
    .optional(),
})
  /**
   * `repoSlug` and `repoUrl` are two names for one repository, and validating
   * them independently let them name two DIFFERENT ones. `repoSlug` is the
   * spend identity — the ledger key, the per-issue cap, the host-side log path,
   * `run-context.json` — while `repoUrl` is the code that actually RUNS inside
   * the box. Separable, they let a brief attribute an attacker's repository to a
   * trusted slug's budget.
   *
   * Only the PATH is tied, and it is tied EXACTLY. The host deliberately is
   * not: self-hosted forges are legitimate and a host allow-list here would
   * refuse them, which is a bigger operational failure than the one this
   * closes. An `endsWith` relaxation — to admit a forge served under a path
   * prefix — is what it looks like, and it is not safe: it would also admit
   * `https://evil.example/x/owner/repo` against a trusted slug, which is the
   * separation this refine exists to close.
   *
   * RESIDUAL, stated plainly because leaving the host unbound is a choice and
   * not an oversight: an ATTACKER-CONTROLLED HOST serving a MATCHING PATH
   * passes. `{repoSlug: "trusted/repo", repoUrl: "https://evil.example/trusted/repo"}`
   * is accepted, and the box then clones and RUNS evil.example's code while the
   * ledger, the per-issue cap and `run-context.json` all say `trusted/repo`.
   * What this refine buys is narrower than "the URL is the slug": it is that a
   * brief cannot name a DIFFERENT REPOSITORY on the same forge. Closing the
   * host half needs repository authority to move off the brief entirely, which
   * is the design below, not a tighter predicate here.
   *
   * The narrowing is also not free in the other direction, and that is accepted
   * too: a forge served under a path prefix (`https://git.example.com/scm/owner/repo`)
   * and a GitLab subgroup URL both exit 2. Neither was ever expressible as a
   * two-segment `repoSlug` in the first place (see the field's own comment), so
   * the refine refuses at the URL what the slug would have refused anyway.
   *
   * SUPERSEDED BY DESIGN: DF5.2's INV-PR-3 puts repository authority in the
   * host-side allowlist (`.factory/repos.json`) — "the remote and base branch
   * resolve from the allowlist, never from the harvested tree's git config".
   * When that lands, `repoUrl` should be DERIVED from `repoSlug` through it
   * rather than accepted from the brief, at which point two fields that must
   * agree collapse into one that cannot disagree, and this refine (and the
   * field) can go. Until then this is the only thing tying the code that RUNS
   * to the identity that PAYS.
   */
  .refine((b) => repoSlugOfUrl(b.repoUrl) === canonicalRepoSlug(b.repoSlug), {
    message: "repoUrl must name the same repository as repoSlug",
    path: ["repoUrl"],
  })
  /**
   * Q1.7: exactly one of issueId / workId. Field-level rules run FIRST (so a
   * malformed workId is named as a workId problem), and this refine names the
   * SHAPE problem: a brief is issue work or headless work, never both, never
   * neither. The missing-identity arm keeps its path on `issueId` — the field
   * an operator upgrading a pre-Q1.7 brief already has — and its message names
   * both fields, because the refusal is about the pair, not either half.
   */
  .refine(
    (b) => (b.issueId !== undefined) !== (b.workId !== undefined),
    (b) => ({
      message:
        b.workId !== undefined
          ? "exactly one of issueId or workId is required — a brief cannot carry both"
          : "exactly one of issueId or workId is required — issue work carries issueId, headless work carries workId",
      path: [b.workId !== undefined ? "workId" : "issueId"],
    }),
  );

export type Brief = z.infer<typeof BriefSchema>;

/**
 * Extract the offending field name from a ZodError for CLI exit-2 message.
 * For unrecognized_keys (unknown field), extracts from the `keys` array.
 * For other errors, joins the path array with ".".
 *
 * A root-level rejection — the brief is not an object at all — carries an empty
 * path, and `field ""` names nothing the operator can act on, so the root is
 * named explicitly. Every return is a non-empty label.
 *
 * SANITIZED, and this is the only exit through which attacker text leaves this
 * module. An unrecognized key's NAME is chosen by whoever wrote the brief and
 * matched against nothing (that is what makes it unrecognized), so it was the
 * one uncapped, unfiltered string in a file whose every other rule is about
 * exactly those two properties. See `sanitizeLabel` for why the repair is here
 * and not left to each consumer. A name that is ENTIRELY control characters
 * sanitizes to `""`, which is why both arms still fall through to the root
 * label — "every return is a non-empty label" is the invariant, not a side
 * effect of zod always having handed back something.
 *
 * DF3.1 AC1: "exits 2 naming the offending field"
 */
export const ROOT_FIELD_LABEL = "(root)";

export function extractZodErrorField(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) return ROOT_FIELD_LABEL;

  // z.strict() produces unrecognized_keys with empty path but named keys
  if (firstIssue.code === "unrecognized_keys") {
    const unrecognized = (firstIssue as { keys?: string[] }).keys;
    const key = unrecognized?.[0];
    return (key === undefined ? "" : sanitizeLabel(key, MAX_FIELD_LABEL)) || ROOT_FIELD_LABEL;
  }

  // The path too: for THIS schema every segment is one of the object's own
  // declared keys, but a `path` element is an `unknown` off a structural error
  // object, and a nested or array schema would put an input-derived index or key
  // there. One sanitizer over both exits costs nothing and cannot be forgotten
  // the day the schema grows a nested field.
  return sanitizeLabel(firstIssue.path.join("."), MAX_FIELD_LABEL) || ROOT_FIELD_LABEL;
}
