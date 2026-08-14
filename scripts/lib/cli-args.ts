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
 *  - `--flag=value`: non-empty value required; unknown flag → throw. The value
 *    may contain `=` and may itself look like a flag (`--a=--b` yields `--b`);
 *    only the space form rejects a flag-looking value.
 *  - `--flag value`: the next argv element must exist, be non-empty, and not
 *    look like a flag (`--…`). Otherwise → throw "requires a non-empty value".
 *  - `--help` / `-h` (exact token): write `help` to stdout and `process.exit(0)`.
 *  - any other `--flag` → throw "unknown flag".
 *  - bare tokens not starting with `--` are ignored (positional tolerance).
 *
 * Two edges the clauses above used to leave ambiguous. Both are pinned in
 * tests/scripts/cli-args.test.ts; stated here so the docblock and the code
 * agree (#56, and the review note on #88):
 *  - `--help=anything` throws "unknown flag: --help" rather than printing help.
 *    The `--flag=value` branch is evaluated first, so the `=` form never
 *    reaches the help clause. Treated as a typo, not a help request.
 *  - a bare `--` throws "unknown flag: --". This parser has NO POSIX
 *    end-of-options handling; none of the three consumer scripts take
 *    positional arguments that would need it.
 *
 * A flag declared in `spec.flags` always wins over these built-ins — declaring
 * `--help` as a value flag makes `--help x` deliver `("--help", "x")`.
 */

import { writeSync } from "node:fs";

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

/**
 * Writes a `<prefix>` header plus an indented `- ` line per message to
 * stderr, then `process.exit(code)`. `generate-notice.ts` and
 * `build-image.ts` each declared this identically (down to the exit-code
 * contract: 1 = compliance failure, 2 = fatal before conclusion) under a
 * different local name (`fail` / `die`) and a different prefix string —
 * duplication with no behavioral difference. Callers wrap this in a
 * prefix-bound local so call sites don't change.
 *
 * Uses `fs.writeSync` rather than `process.stderr.write`: when stderr is a
 * pipe (the common case in CI and redirected output), `process.stderr.write`
 * can be asynchronous, and `process.exit` right after it would tear the
 * process down before the write lands — the failure message gets truncated
 * or dropped even though the exit code is still correct. `writeSync` blocks
 * until the write completes, so nothing races the exit.
 */
export function exitWithFailure(prefix: string, code: 1 | 2, lines: readonly string[]): never {
  writeSync(2, `${[prefix, ...lines.map((l) => `  - ${l}`)].join("\n")}\n`);
  process.exit(code);
}
