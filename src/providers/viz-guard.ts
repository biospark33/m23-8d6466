/**
 * INV-2 guard, owned by the provider seam.
 *
 * `assertNeverPublic` used to live in visualizer/server/auth.ts, which made
 * src/providers/driver.ts (the seam) import from visualizer/ (a consumer of
 * the seam) — backwards, and fragile to any refactor on the visualizer side.
 * The guard and its error type live here instead; visualizer/server/auth.ts
 * re-exports both so every existing `from "../server/auth.ts"` import keeps
 * working unchanged.
 */

/** Named error carrying a machine code and the remediation (cost-ledger pattern). */
export class VizError extends Error {
  readonly code: string;
  /** The literal next step; secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = "VizError";
    this.code = code;
    this.remediation = remediation;
  }
}

/**
 * INV-2: the box's one anonymous public port is never the visualizer's.
 * Any exposure path (share port / set-public) must route its port operand
 * through this guard — it raises rather than registers.
 */
export function assertNeverPublic(port: number): never {
  throw new VizError(
    "VIZ_PORT_PUBLIC",
    `refusing to expose port ${port}: the visualizer is loopback-only (INV-2)`,
    "Reach the visualizer through an SSH forward to 127.0.0.1; never through share port / set-public.",
  );
}
