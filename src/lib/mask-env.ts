/**
 * One masking function for subprocess environment snapshots (INV-SC5).
 *
 * Extracted from the MCP tool bridge so the invariant has a single home:
 * every surface that echoes a subprocess environment back to a client masks
 * through this one function. It deliberately imports nothing, so the masking
 * primitive stays dependency-free and trivially auditable.
 */

// ---------------------------------------------------------------------------
// Secret masking (INV-SC5).
// ---------------------------------------------------------------------------

/**
 * Mask every env value to `***` for diagnostics/responses (INV-SC5). Key names
 * stay visible; heuristic key-matching both under-covers (PASS, DSN) and
 * over-covers (MONKEY), so all values are masked regardless of key name.
 */
export function maskEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const k of Object.keys(env)) {
    out[k] = "***";
  }
  return out;
}
