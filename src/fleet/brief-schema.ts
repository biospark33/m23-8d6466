/**
 * Brief schema (Story DF3.1, Agent A): INV-2 closed validation.
 *
 * C3: requestId is LOOSE at schema layer — any string passes.
 * UUID validation happens in dispatch via resolveRunCorrelation.
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
 */
function hasNoParentSegment(p: string): boolean {
  return !p.split("/").includes("..");
}

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
  issueUrl: z.string().url().startsWith("https://", "issueUrl must be an https:// URL").optional(),
  // DF3.1 D2: 40-hex regex (setup-gate, fill)
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  // C3: requestId is LOOSE — optional string, NOT .uuid() at schema layer
  // Non-UUID strings pass schema; UUID validation happens in dispatch (AC2)
  requestId: z.string().optional(),
  // DF3.1 D2: host path to pipeline manifest (non-empty, no parent traversal)
  manifestPath: z
    .string()
    .min(1)
    .refine(hasNoParentSegment, "manifestPath segments may not be '..'"),
  // DF3.1 D2: for pinned-SHA fill (fill.ts). `.url()` admits every scheme, and
  // this value is handed to a clone inside the box — `file://` would exfiltrate
  // a host path and `ssh://`/`git://` a host key, so the scheme is allow-listed
  // to the one the factory clones over.
  repoUrl: z.string().url().startsWith("https://", "repoUrl must be an https:// URL"),
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
