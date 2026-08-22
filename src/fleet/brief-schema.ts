/**
 * Brief schema (Story DF3.1, Agent A): INV-2 closed validation.
 *
 * C3: requestId is LOOSE at schema layer — any string of sane length with no
 * control characters passes; no UUID shape is required. UUID validation happens
 * in dispatch via resolveRunCorrelation.
 */
import { z } from "zod";
import { REPO_SLUG_PATTERN, canonicalRepoSlug } from "../phase-engine/issue-correlation.ts";

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
 */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

/**
 * The repository a clone URL identifies, as a CANONICAL slug: pathname,
 * slashes trimmed, a `.git` suffix dropped, case folded. `undefined` when the
 * URL will not parse (the `.url()` check has already refused those, so the
 * cross-check never sees one) or when the path cannot name a slug at all.
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
  return canonicalRepoSlug(pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, ""));
}

/**
 * Length caps. Every string field but `repoSlug` was uncapped, and the two
 * things an uncapped field reaches are both unbounded: `manifestPath` goes to
 * `fs`, and `requestId` rides the brief into the run record, the ledger keys and
 * every log correlation line. Sized to be far above any legitimate value and far
 * below "a megabyte of it lands in a persisted record".
 */
const MAX_MANIFEST_PATH = 1024;
const MAX_URL = 2048;
const MAX_REQUEST_ID = 128;

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
  issueId: z.number().int().positive().max(2 ** 31 - 1),
  // DF3.1 D2: optional string URL. Same scheme allow-list as repoUrl below:
  // this value lands in the box's run-context.json and in log lines an operator
  // clicks, and `.url()` alone admits `file://` and `javascript:`.
  // The scheme is matched case-INSENSITIVELY against the raw string. URL schemes
  // are case-insensitive, so `.url()` accepts `HTTPS://…` and a case-sensitive
  // `.startsWith` then refused a URL that IS https — a false rejection with a
  // message telling the operator to use the scheme they already used.
  issueUrl: z
    .string()
    .max(MAX_URL)
    .url()
    .regex(/^https:\/\//i, "issueUrl must be an https:// URL")
    .optional(),
  // DF3.1 D2: 40-hex regex (setup-gate, fill)
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  // C3: requestId is LOOSE — optional string, NOT .uuid() at schema layer.
  // Non-UUID strings pass schema; UUID validation happens in dispatch (AC2).
  // Capped and control-char-free all the same: C3 relaxes the FORMAT, and
  // neither a 10 MB id in the ledger key nor a newline in the log stream is a
  // format question.
  requestId: z
    .string()
    .max(MAX_REQUEST_ID)
    .regex(NO_CONTROL_CHARS, "requestId may not contain control characters")
    .optional(),
  // DF3.1 D2: repo-relative path to the pipeline manifest (non-empty, capped,
  // no control chars, no parent traversal, not absolute)
  manifestPath: z
    .string()
    .min(1)
    .max(MAX_MANIFEST_PATH)
    .regex(NO_CONTROL_CHARS, "manifestPath may not contain control characters")
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
    .url()
    .regex(/^https:\/\//i, "repoUrl must be an https:// URL"),
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
 * DF3.1 AC1: "exits 2 naming the offending field"
 */
export const ROOT_FIELD_LABEL = "(root)";

export function extractZodErrorField(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) return ROOT_FIELD_LABEL;

  // z.strict() produces unrecognized_keys with empty path but named keys
  if (firstIssue.code === "unrecognized_keys") {
    const unrecognized = (firstIssue as { keys?: string[] }).keys;
    return unrecognized?.[0] ?? ROOT_FIELD_LABEL;
  }

  return firstIssue.path.join(".") || ROOT_FIELD_LABEL;
}
