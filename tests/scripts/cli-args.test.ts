/**
 * Unit tests for `scripts/lib/parseValueFlags` (issue #64).
 *
 * This helper has an explicit behavior contract written into its own docblock,
 * and three scripts depend on it. The tests below assert THAT CONTRACT clause by
 * clause rather than the implementation, so a rewrite that keeps the grammar
 * keeps the suite green. The two edges that the docblock once left ambiguous
 * (`--help=value`, bare `--`) are now stated explicitly in it, and the tests
 * below assert that reconciled contract rather than pinning a disagreement.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { parseValueFlags, tokenizeArgs, type ValueFlagSpec } from "../../scripts/lib/cli-args.ts";
// The script module is side-effect free outside import.meta.main; parseArgs is
// the unit under test for the CLI's own argv contract.
import { parseArgs as parseTeardownArgs } from "../../scripts/sandbox-teardown.ts";

const HELP = ["usage: thing --repo-slug <slug>", "  --repo-slug  the slug"];

/** Collects every `(flag, value)` pair the parser emits, in argv order. */
function collect(argv: readonly string[], flags: readonly string[] = ["--repo-slug", "--bank-id"]) {
  const seen: Array<[string, string]> = [];
  const spec: ValueFlagSpec = {
    flags,
    onValue: (f, v) => seen.push([f, v]),
    help: HELP,
  };
  parseValueFlags(argv, spec);
  return seen;
}

describe("parseValueFlags — `--flag=value` form", () => {
  test("a non-empty value is delivered to onValue", () => {
    expect(collect(["--repo-slug=owner/repo"])).toEqual([["--repo-slug", "owner/repo"]]);
  });

  test("an empty value is rejected, not silently accepted", () => {
    expect(() => collect(["--repo-slug="])).toThrow("--repo-slug requires a non-empty value");
  });

  test("the value may itself contain `=`", () => {
    expect(collect(["--repo-slug=a=b=c"])).toEqual([["--repo-slug", "a=b=c"]]);
  });

  test("a flag-looking value is allowed in this form (only the space form rejects it)", () => {
    expect(collect(["--repo-slug=--weird"])).toEqual([["--repo-slug", "--weird"]]);
  });

  test("an unknown flag throws and names itself", () => {
    expect(() => collect(["--repo=x"])).toThrow("unknown flag: --repo");
  });

  test("whitespace is a value — it is the caller's job to trim", () => {
    expect(collect(["--repo-slug= "])).toEqual([["--repo-slug", " "]]);
  });
});

describe("parseValueFlags — `--flag value` form", () => {
  test("the next argv element becomes the value", () => {
    expect(collect(["--repo-slug", "owner/repo"])).toEqual([["--repo-slug", "owner/repo"]]);
  });

  test("the value is consumed, not re-parsed as a token", () => {
    // Without the `++i` consume, "bank-1" would fall through as a bare token.
    expect(collect(["--repo-slug", "owner/repo", "--bank-id", "bank-1"])).toEqual([
      ["--repo-slug", "owner/repo"],
      ["--bank-id", "bank-1"],
    ]);
  });

  test("a trailing bare flag with no value throws rather than defaulting", () => {
    expect(() => collect(["--repo-slug"])).toThrow("--repo-slug requires a non-empty value");
  });

  test("an empty-string value throws", () => {
    expect(() => collect(["--repo-slug", ""])).toThrow("--repo-slug requires a non-empty value");
  });

  test("a flag-looking value throws instead of swallowing the next flag", () => {
    // The false-friendly reading: `--repo-slug --bank-id x` must NOT set
    // repo-slug to "--bank-id" and drop bank-id entirely.
    expect(() => collect(["--repo-slug", "--bank-id", "x"])).toThrow(
      "--repo-slug requires a non-empty value",
    );
  });

  test("a single-dash token IS accepted as a value (only `--` prefixes are rejected)", () => {
    expect(collect(["--repo-slug", "-h"])).toEqual([["--repo-slug", "-h"]]);
  });

  test("repeats are delivered in order — precedence is the caller's contract", () => {
    expect(collect(["--repo-slug", "a", "--repo-slug", "b"])).toEqual([
      ["--repo-slug", "a"],
      ["--repo-slug", "b"],
    ]);
  });
});

describe("parseValueFlags — unknown flags and bare tokens", () => {
  test("an unknown `--flag` throws (typo protection)", () => {
    expect(() => collect(["--bankid", "x"])).toThrow("unknown flag: --bankid");
  });

  test("bare tokens that follow no flag are ignored", () => {
    expect(collect(["positional", "--repo-slug", "x", "another"])).toEqual([["--repo-slug", "x"]]);
  });

  test("an empty argv is a no-op", () => {
    expect(collect([])).toEqual([]);
  });

  test("a single-dash unknown flag is ignored, not thrown on", () => {
    expect(collect(["-x"])).toEqual([]);
  });

  test("the unknown-flag check runs before any value is emitted for it", () => {
    const seen: Array<[string, string]> = [];
    expect(() =>
      parseValueFlags(["--repo-slug", "ok", "--nope", "v"], {
        flags: ["--repo-slug"],
        onValue: (f, v) => seen.push([f, v]),
        help: HELP,
      }),
    ).toThrow("unknown flag: --nope");
    expect(seen).toEqual([["--repo-slug", "ok"]]);
  });
});

// ---------------------------------------------------------------------------
// Documented contract — the edges between the help clause and the unknown-flag
// clause. These used to be a docblock/behavior disagreement pinned as such;
// the docblock now states both explicitly, so these assert the contract.
// ---------------------------------------------------------------------------
describe("parseValueFlags — documented-contract edges", () => {
  test("`--help=anything` throws unknown-flag instead of printing help", () => {
    // Documented: the `--flag=value` branch is evaluated before the help
    // branch, so the `=` form never reaches it. Treated as a typo.
    expect(() => collect(["--help=1"])).toThrow("unknown flag: --help");
  });

  test("a bare `--` throws unknown-flag rather than ending option parsing", () => {
    // Documented: no POSIX end-of-options handling — no consumer script takes
    // positional arguments that would need it.
    expect(() => collect(["--", "positional"])).toThrow("unknown flag: --");
  });

  test("a value flag shadows `--help` when it is also declared as a value flag", () => {
    expect(collect(["--help", "x"], ["--help"])).toEqual([["--help", "x"]]);
  });
});

describe("parseValueFlags — `--help` exits 0 (subprocess: process.exit)", () => {
  const libPath = path.resolve(import.meta.dir, "../../scripts/lib/cli-args.ts");

  /** Runs the parser in a child so `process.exit(0)` is observable. */
  function runHelp(arg: string) {
    const src = `import { parseValueFlags } from ${JSON.stringify(libPath)};
      parseValueFlags([${JSON.stringify(arg)}], {
        flags: ["--repo-slug"],
        onValue: () => { process.stderr.write("onValue must not fire\\n"); },
        help: ${JSON.stringify(HELP)},
      });
      process.stderr.write("returned instead of exiting\\n");
      process.exit(9);`;
    return spawnSync("bun", ["-e", src], { encoding: "utf8" });
  }

  for (const arg of ["--help", "-h"]) {
    test(`\`${arg}\` writes the help text and exits 0`, () => {
      const r = runHelp(arg);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("usage: thing");
      expect(r.stdout).toContain("--repo-slug  the slug");
      // Must not fall through to the unknown-flag throw or return normally.
      expect(r.stderr).not.toContain("returned instead of exiting");
    });
  }

  test("an unknown flag exits non-zero rather than exiting 0 like help", () => {
    const r = runHelp("--nope");
    expect(r.status).not.toBe(0);
  });
});

describe("tokenizeArgs — the shared positional/flag split for the per-script CLIs", () => {
  test("value flag consumes a non-flag token; positionals and bools separate out", () => {
    const t = tokenizeArgs(["harvest", "run-1", "--driver", "exedev", "--no-harvest"], {
      valueFlags: ["--driver"],
      boolFlags: ["--no-harvest"],
    });
    expect(t.positionals).toEqual(["harvest", "run-1"]);
    expect(t.flagTokens).toEqual(["--driver", "exedev"]);
    expect([...t.bools]).toEqual(["--no-harvest"]);
  });

  test("a flag-looking next token is NOT consumed — bool still recognized, missing value reported downstream", () => {
    // `--driver --no-harvest run-1`: the old inline loops ate `--no-harvest` as
    // the driver value, silently dropping the bool. The tokenizer leaves it
    // free; parseValueFlags then reports the missing --driver value.
    const t = tokenizeArgs(["--driver", "--no-harvest", "run-1"], {
      valueFlags: ["--driver"],
      boolFlags: ["--no-harvest"],
    });
    expect(t.flagTokens).toEqual(["--driver"]);
    expect([...t.bools]).toEqual(["--no-harvest"]);
    expect(t.positionals).toEqual(["run-1"]);
    expect(() =>
      parseValueFlags(t.flagTokens, { flags: ["--driver"], onValue: () => {}, help: HELP }),
    ).toThrow("--driver requires a non-empty value");
  });

  test("a trailing value flag passes through bare (parseValueFlags owns that error)", () => {
    const t = tokenizeArgs(["--dir"], { valueFlags: ["--dir"] });
    expect(t.flagTokens).toEqual(["--dir"]);
    expect(() =>
      parseValueFlags(t.flagTokens, { flags: ["--dir"], onValue: () => {}, help: HELP }),
    ).toThrow("--dir requires a non-empty value");
  });

  test("unknown flags are forwarded, and their next token stays positional", () => {
    const t = tokenizeArgs(["--wat", "x", "pos"], { valueFlags: ["--dir"] });
    expect(t.flagTokens).toEqual(["--wat"]); // --wat is unknown → consumes nothing
    expect(t.positionals).toEqual(["x", "pos"]);
    expect(() =>
      parseValueFlags(t.flagTokens, { flags: ["--dir"], onValue: () => {}, help: HELP }),
    ).toThrow("unknown flag: --wat");
  });
});

describe("tokenizeArgs — stray single-dash tokens (opt-in strictness)", () => {
  const strict = {
    valueFlags: ["--driver", "--dir"],
    boolFlags: ["--no-harvest"],
    rejectStraySingleDash: true,
  } as const;

  test("a stray single-dash token throws unknown flag instead of being dropped", () => {
    // The destructive case: `sandbox-teardown -n run-1` used to drop `-n`
    // (parseValueFlags only inspects `--`-prefixed flags) and tear the run
    // down anyway.
    expect(() => tokenizeArgs(["-n", "run-1"], strict)).toThrow("unknown flag: -n");
  });

  test("a single-dash token still serves as a pending value (the value grammar is unchanged)", () => {
    // `--driver -n`: `-n` follows a value flag still awaiting its value, so it
    // is a value continuation — parseValueFlags' documented "single-dash token
    // IS accepted as a value" contract keeps holding under strictness.
    const t = tokenizeArgs(["--driver", "-n"], strict);
    expect(t.flagTokens).toEqual(["--driver", "-n"]);
  });

  test("a bool flag between a value flag and its would-be value keeps the pair intact", () => {
    const t = tokenizeArgs(["--driver", "--no-harvest", "run-1"], strict);
    expect(t.flagTokens).toEqual(["--driver"]);
    expect([...t.bools]).toEqual(["--no-harvest"]);
    expect(() =>
      parseValueFlags(t.flagTokens, { flags: ["--driver"], onValue: () => {}, help: HELP }),
    ).toThrow("--driver requires a non-empty value");
  });

  test("a bool flag clears the pending-value state — a later single-dash token still rejects", () => {
    // `--driver --no-harvest -n`: a stale awaitingValue let `-n` ride through
    // as --driver's value, silently defeating rejectStraySingleDash. The bool
    // flag terminates the continuation; `-n` is then the stray it always was.
    expect(() => tokenizeArgs(["--driver", "--no-harvest", "-n"], strict)).toThrow("unknown flag: -n");
  });

  test("without the option, single-dash tokens pass through — the run-record.ts grammar relies on this default", () => {
    const t = tokenizeArgs(["-n", "x"], { valueFlags: ["--dir"] });
    expect(t.flagTokens).toEqual(["-n"]);
    expect(t.positionals).toEqual(["x"]);
  });
});

describe("sandbox-teardown parseArgs — positional arity and flag strictness", () => {
  test("a second positional in teardown mode is an error, not a silent ignore", () => {
    // `sandbox-teardown run-a run-b` used to tear down run-a and exit 0.
    expect(() => parseTeardownArgs(["run-a", "run-b"])).toThrow("unexpected argument: run-b");
  });

  test("a third positional in harvest mode is an error", () => {
    expect(() => parseTeardownArgs(["harvest", "run-a", "run-b"])).toThrow("unexpected argument: run-b");
  });

  test("the legal shapes still parse", () => {
    expect(parseTeardownArgs(["run-a"])).toEqual({ mode: "teardown", runId: "run-a", noHarvest: false });
    expect(parseTeardownArgs(["harvest", "run-a", "--driver", "fake"])).toEqual({
      mode: "harvest",
      runId: "run-a",
      noHarvest: false,
      driver: "fake",
    });
  });

  test("a stray single-dash flag is rejected at parse time", () => {
    expect(() => parseTeardownArgs(["-n", "run-a"])).toThrow("unknown flag: -n");
  });

  test("an unknown double-dash flag is still reported by the shared grammar", () => {
    expect(() => parseTeardownArgs(["run-a", "--driver-name", "fake"])).toThrow("unknown flag: --driver-name");
  });
});
