/**
 * The gate report (Story DF1.2).
 *
 * A gate is `gate(envelope, run) -> GateReport`. The report holds one check
 * per item examined; `violations` and `passed` are DERIVED from those checks
 * and are never authored (INV-4). Every check is recorded either way — pass
 * and fail — so a green gate says WHAT it verified instead of only that it
 * passed (`MOD/gates.py:5-6`; `MOD/data_types.py:252-283`; R4 §1.4).
 *
 * Hardening over the SSSF source, binding on this port: a report that
 * examined nothing is `passed: false` (AC1, INV-5). The SSSF original passes
 * vacuously on zero checks; this story's INV-5 closes that door.
 */
/** One examined item. `note` is the evidence ("exists, 2.1KB", "exit 0") and on a failed check doubles as the reason. */
export interface GateCheck {
  item: string;
  ok: boolean;
  note: string;
}

export class GateReport {
  // Private: the only way in is `check()`. There is no constructor parameter,
  // no setter, and no deserialization path that accepts a violations list —
  // an agent cannot hand the harness a self-certified clean report (INV-4).
  readonly #checks: GateCheck[] = [];

  /** Appends one `GateCheck` per item examined and returns itself. */
  check(item: string, ok: boolean, note: string): this {
    this.#checks.push({ item, ok, note });
    return this;
  }

  get checks(): readonly GateCheck[] {
    return this.#checks;
  }

  /** The failed checks, as `"item: note"` (or `"item: failed"` when the note is empty). */
  get violations(): string[] {
    return this.#checks
      .filter((c) => !c.ok)
      .map((c) => `${c.item}: ${c.note || "failed"}`);
  }

  /**
   * A gate that examined nothing has verified nothing: zero checks is not
   * green (INV-5).
   */
  get passed(): boolean {
    return this.#checks.length > 0 && this.violations.length === 0;
  }
}
