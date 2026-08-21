/**
 * Brief schema (Story DF3.1, Agent A): INV-2 closed validation.
 *
 * C3: requestId is LOOSE at schema layer — any string passes.
 * UUID validation happens in dispatch via resolveRunCorrelation.
 */
import { z } from "zod";

// DF3.1 AC1, AC2, INV-2: strict object, closed to unknown fields
export const BriefSchema = z.strictObject({
  // DF3.1 D2: validated owner/name (issue-correlation pattern)
  repoSlug: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/),
  // DF3.1 D2: int >0, MAX_ISSUE_ID capped (assertWithinBudget receives String(issueId))
  issueId: z.number().int().positive().max(2 ** 31 - 1),
  // DF3.1 D2: optional string URL
  issueUrl: z.string().url().optional(),
  // DF3.1 D2: 40-hex regex (setup-gate, fill)
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  // C3: requestId is LOOSE — optional string, NOT .uuid() at schema layer
  // Non-UUID strings pass schema; UUID validation happens in dispatch (AC2)
  requestId: z.string().optional(),
  // DF3.1 D2: host path to pipeline manifest (non-empty)
  manifestPath: z.string().min(1),
  // DF3.1 D2: for pinned-SHA fill (fill.ts)
  repoUrl: z.string().url(),
});

export type Brief = z.infer<typeof BriefSchema>;

/**
 * Extract the offending field name from a ZodError for CLI exit-2 message.
 * For unrecognized_keys (unknown field), extracts from the `keys` array.
 * For other errors, joins the path array with ".".
 *
 * DF3.1 AC1: "exits 2 naming the offending field"
 */
export function extractZodErrorField(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) return "";

  // z.strict() produces unrecognized_keys with empty path but named keys
  if (firstIssue.code === "unrecognized_keys") {
    const unrecognized = (firstIssue as { keys?: string[] }).keys;
    return unrecognized && unrecognized.length > 0 ? (unrecognized[0] ?? "") : "";
  }

  return firstIssue.path.join(".");
}
