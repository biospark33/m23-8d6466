/**
 * The single export surface for `src/audit` (DF5.3).
 *
 * `OQ4_VOID_REASON` is defined HERE — once — so DF5.4's gate and
 * `scripts/df5-lights-on-gate.ts` consume a byte-identical void reason by
 * construction rather than by claim. `ChainReport` is exported HERE because it
 * is the two-story wire format: DF5.4-C9 imports the type instead of parsing
 * shape by hand. Neither story changes the shape without the other's row
 * changing in the same PR.
 */

export const OQ4_VOID_REASON =
  "OQ-4 unresolved — Hindsight has never booted on this host (arm64 libpq/openssl@3; :8888 collides with a local Jupyter); step-6 memory wiring is outside the v5 horizon";

export { ChainWalkError, chainVerdict, walkAuditChain } from "./chain.ts";
export type { ChainReport, HopName, HopOutcome, RunChain, WalkOptions } from "./chain.ts";
export type { AuditHop, AuditLinkInput, AuditLinkRow } from "./link-store.ts";
export {
  AUDIT_HOPS,
  AuditStoreError,
  canonicalJson,
  DEFAULT_AUDIT_DB_FILE,
  openAuditStore,
  openAuditStoreForWalk,
  sha256Hex,
  WALK_OBSERVED_EVENT,
} from "./link-store.ts";
