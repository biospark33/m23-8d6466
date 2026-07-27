/**
 * Non-fatal warnings collected during a harness run and surfaced in its
 * summary (version drift, ambiguous installs, cleanup failures, a stalled
 * child that had to be force-killed).
 *
 * Deliberately its own module with NO dependencies. The MCP stdio transport
 * and the pi-lens domain helpers both need a place to record a warning, and
 * routing that through the pi-lens module would point the transport layer at
 * the domain layer — the wrong dependency direction, and one that would make a
 * plain MCP client drag pi-lens along with it.
 */
export const harnessNotes: string[] = [];

export type Status = "pass" | "fail" | "skip";

/**
 * One recorded assertion in a harness run. Harnesses that carry extra
 * per-check metadata extend this rather than redeclaring it.
 */
export interface Check {
  ac: string;
  name: string;
  status: Status;
  evidence: Record<string, unknown>;
  reason?: string;
  /** A skip of an optional check never fails --strict (environment-dependent). */
  optional?: boolean;
}

/**
 * Collector for a harness's check results — the array plus its append fn,
 * which `scripts/lsp-verify.ts` and `scripts/pi-lens-verify.ts` each used to
 * declare separately. Generic so a harness can record its own Check subtype.
 */
export function createChecklist<T extends Check = Check>(): { checks: T[]; record: (c: T) => void } {
  const checks: T[] = [];
  return {
    checks,
    record: (c: T) => {
      checks.push(c);
    },
  };
}
