/**
 * Brief schema (Story DF3.1, Agent A): INV-2 closed validation.
 *
 * C3: requestId is LOOSE at schema layer — any string of sane length with no
 * control characters passes; no UUID shape is required. UUID validation happens
 * in dispatch via resolveRunCorrelation.
 */
import { z } from "zod";
import { MAX_ISSUE_ID, REPO_SLUG_PATTERN, canonicalRepoSlug } from "../phase-engine/issue-correlation.ts";

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
 * Attacker-authored text on its way into an operator-facing label: control
 * characters removed, length capped.
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
  const stripped = text.replace(CONTROL_CHARS_G, "");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
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
const MAX_REQUEST_ID = 128;

/**
 * Cap on the field NAME `extractZodErrorField` hands back. Sized like
 * MAX_REQUEST_ID rather than like a path: this is an identifier an operator
 * greps their brief for, not a value.
 */
const MAX_FIELD_LABEL = 128;

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
  issueId: z.number().int().positive().max(MAX_ISSUE_ID),
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
    .refine(isNotBlank, "requestId may not be blank — omit the key instead")
    .optional(),
  // DF3.1 D2: repo-relative path to the pipeline manifest (non-empty, capped,
  // no control chars, no parent traversal, not absolute)
  manifestPath: z
    .string()
    .min(1)
    .max(MAX_MANIFEST_PATH)
    .regex(NO_CONTROL_CHARS, "manifestPath may not contain control characters")
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
    .refine(hasNoUserinfo, "repoUrl may not carry userinfo (user:pass@host)"),
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
  });

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
