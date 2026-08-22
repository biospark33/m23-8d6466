/**
 * Brief schema (Story DF3.1, Agent A): INV-2 closed validation.
 *
 * C3: requestId is LOOSE at schema layer — any string of sane length with no
 * control characters passes; no UUID shape is required. UUID validation happens
 * in dispatch via resolveRunCorrelation.
 */
import { z } from "zod";

/**
 * `.` and `..` pass the slug charset but are not repository names — they are
 * path segments, and the slug reaches `join()` on both the ledger key and the
 * host-side log path. Refuse them here rather than downstream.
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
 * The repository a clone URL identifies, as a slug: pathname, slashes trimmed,
 * a `.git` suffix dropped. `undefined` when the URL will not parse — the
 * `.url()` check has already refused those, so the cross-check never sees one.
 */
function repoSlugOfUrl(url: string): string | undefined {
  try {
    return new URL(url).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  } catch {
    return undefined;
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
const MAX_URL = 2048;
const MAX_REQUEST_ID = 128;

// DF3.1 AC1, AC2, INV-2: strict object, closed to unknown fields
export const BriefSchema = z.strictObject({
  // DF3.1 D2: validated owner/name (issue-correlation pattern)
  repoSlug: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/)
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
   * Only the PATH is tied. The host deliberately is not: self-hosted forges are
   * legitimate and a host allow-list here would refuse them, which is a bigger
   * operational failure than the one this closes.
   */
  .refine((b) => repoSlugOfUrl(b.repoUrl) === b.repoSlug, {
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
