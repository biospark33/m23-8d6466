/**
 * Shared CLI argument parsing for the Hindsight scripts.
 *
 * `provision-hindsight-banks.ts` and `import-mulch-expertise.ts` accept the
 * same flag grammar (`--flag value`, `--flag=value`, `--help`, reject unknown
 * flags, require non-empty values). The only per-script differences are the
 * set of value flags, how each maps to an output field, and the help text.
 * This helper owns the grammar + validation mechanics once; each script owns
 * its flag table, output mapping, and help lines.
 *
 * Behavior contract (parity with the prior inline parsers):
 *  - `--flag=value`: non-empty value required; unknown flag → throw.
 *  - `--flag value`: the next argv element must exist, be non-empty, and not
 *    look like a flag (`--…`). Otherwise → throw "requires a non-empty value".
 *  - `--help` / `-h`: write `help` to stdout and `process.exit(0)`.
 *  - any other `--flag` → throw "unknown flag".
 *  - bare tokens not starting with `--` are ignored (positional tolerance).
 */

export interface ValueFlagSpec {
  /** Recognized value flags, e.g. `["--repo-slug", "--repo"]`. */
  flags: readonly string[];
  /** Called for every parsed `(flag, value)` pair, in argv order. */
  onValue: (flag: string, value: string) => void;
  /** Help text written on `--help` / `-h` (joined with `\n`). */
  help: readonly string[];
}

/**
 * Walk `argv` applying the value-flag grammar. Mutates state via `spec.onValue`
 * callbacks; throws on a bad flag / missing value. `process.exit(0)` on `--help`.
 */
export function parseValueFlags(argv: readonly string[], spec: ValueFlagSpec): void {
  const known = new Set(spec.flags);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // `--flag=value` form.
    const eqMatch = a.match(/^--([^=]+)=(.*)$/);
    if (eqMatch) {
      const flag = `--${eqMatch[1]!}`;
      const v = eqMatch[2]!;
      if (!known.has(flag)) {
        throw new Error(`unknown flag: ${flag}`);
      }
      if (v.length === 0) {
        throw new Error(`${flag} requires a non-empty value`);
      }
      spec.onValue(flag, v);
      continue;
    }
    if (known.has(a)) {
      // A value flag MUST be followed by a non-empty value. A bare `--flag`
      // (missing value) or a flag-looking value is a user typo — error loudly
      // rather than silently proceeding with defaults.
      const v = argv[++i];
      if (typeof v !== "string" || v.length === 0 || v.startsWith("--")) {
        throw new Error(`${a} requires a non-empty value`);
      }
      spec.onValue(a, v);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(spec.help.join("\n"));
      process.exit(0);
    } else if (a.startsWith("--")) {
      // Unknown flag — surface typos loudly (e.g. `--bankid` vs `--bank-id`).
      throw new Error(`unknown flag: ${a}`);
    }
  }
}
