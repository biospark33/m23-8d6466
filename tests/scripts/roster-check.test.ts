/**
 * DF1.5 — `scripts/roster-check.ts` operator surface.
 *
 * Flag grammar (through the shared `parseValueFlags`), row rendering, exit
 * codes 0/1/2, and the MANDATORY e2e demo: the shipped roster against the live
 * OpenRouter model list exits 0, and the same roster with one slug flipped to
 * `openrouter/does-not-exist` exits 1 naming the provider-API gate.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReport, main, parseArgs, sanitize } from "../../scripts/roster-check.ts";
import type { RosterReport } from "../../src/phase-engine/roster/validate.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DEFAULT_ROSTER = "config/rosters/qds-default.roster.yaml";

describe("parseArgs", () => {
  test("accepts both flag forms", () => {
    expect(parseArgs(["--roster", "a.yaml"])).toEqual({ roster: "a.yaml" });
    expect(parseArgs(["--roster=a.yaml", "--request-id=r1"])).toEqual({
      roster: "a.yaml",
      requestId: "r1",
    });
  });

  test("rejects an unknown flag and a valueless flag", () => {
    expect(() => parseArgs(["--rooster", "a"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["--roster"])).toThrow(/non-empty value/);
  });
});

describe("formatReport", () => {
  const base: RosterReport = {
    requestId: "r1",
    roles: [
      {
        requestId: "r1",
        role: "planner",
        slug: "openrouter/anthropic/claude-haiku-4.5",
        provider: "openrouter",
        piCatalog: "pass",
        providerApi: "pass",
        source: "bundled",
        rate: {
          inputPerMTok: 1_000_000,
          outputPerMTok: 5_000_000,
          cacheReadPerMTok: 0,
          cacheWritePerMTok: 0,
          source: "bundled",
          warnings: [],
        },
        durationMs: 1,
        problems: [],
        warnings: [],
      },
    ],
    problems: [],
    warnings: [],
    exitCode: 0,
    catalogProbeMs: 5,
    providerProbeMs: 6,
    durationMs: 12,
  };

  test("renders `role · slug · pi:… · provider:… · source:…`", () => {
    expect(formatReport(base)).toEqual([
      "planner · openrouter/anthropic/claude-haiku-4.5 · pi:pass · provider:pass · source:bundled",
    ]);
  });

  test("an unpriced role renders source:none and its problem lines", () => {
    const lines = formatReport({
      ...base,
      roles: [{ ...base.roles[0]!, source: null, rate: null, problems: ["no rate for X"] }],
      problems: ["models.json: model \"p/m\" cost block is missing cacheWrite"],
      warnings: ["pi 0.84.1 is not the F13-pinned 0.55.x line"],
      exitCode: 1,
    });
    expect(lines[0]).toContain("source:none");
    expect(lines.some((l) => l.startsWith("WARN "))).toBe(true);
    expect(lines.some((l) => l === "FAIL [planner] no rate for X")).toBe(true);
    expect(lines.some((l) => l.startsWith("FAIL models.json:"))).toBe(true);
  });

  test("control characters from the roster are escaped, not sent to the terminal", () => {
    // Role names and slugs come from an operator-supplied YAML file; a crafted
    // one must not be able to repaint the verdict table it appears in.
    expect(sanitize("bad\u001b[2Kname")).toBe("bad\\x1b[2Kname");
    const lines = formatReport({
      ...base,
      roles: [{ ...base.roles[0]!, role: "a\u001b[31m", slug: "p/m" }],
    });
    expect(lines[0]).not.toContain("\u001b");
    expect(lines[0]).toContain("\\x1b");
  });

  test("C1 introducers and bidi overrides are escaped too, not just C0", () => {
    // U+009B is a working CSI introducer and U+009D an OSC one on any UTF-8
    // terminal, so stopping at DEL would miss the exact sequences this exists
    // to stop; U+202E lets a role name visually reorder the verdict text.
    expect(sanitize("a\u009b31mb")).toBe("a\\x9b31mb");
    expect(sanitize("a\u009db")).toBe("a\\x9db");
    expect(sanitize("a\u202eb")).toBe("a\\u202eb");
    expect(sanitize("a\u2028b")).toBe("a\\u2028b");
    expect(sanitize("a\u0000b")).toBe("a\\x00b");
    // Ordinary text, including the row separator, is untouched.
    expect(sanitize("planner \u00b7 openrouter/anthropic/claude-haiku-4.5")).toBe(
      "planner \u00b7 openrouter/anthropic/claude-haiku-4.5",
    );
  });
});

describe("main — argument and roster failures", () => {
  test("a missing --roster is exit 2, not a silent pass", async () => {
    expect(await main([])).toBe(2);
  });

  test("a bad flag is exit 2", async () => {
    expect(await main(["--nope", "x"])).toBe(2);
  });

  test("a path outside the repo root is refused (INV-2) without any probe", async () => {
    const dir = mkdtempSync(join("/tmp", "roster-out-"));
    try {
      const p = join(dir, "x.roster.yaml");
      writeFileSync(p, "roles:\n  - name: a\n    model: openrouter/m\n    writes: []\n");
      // Exit 1: a roster problem. `loadRoster` throws before `validateRoster` is
      // ever reached, so no gate is probed — a probe would take tens of seconds
      // and this returns immediately.
      expect(await main(["--roster", p])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a roster that cannot be READ is exit 2, not 1 (INV-4)", async () => {
    // A typo'd --roster path is an unavailable control, not "your slugs are bad".
    expect(await main(["--roster", "config/rosters/no-such-file.roster.yaml"])).toBe(2);
  });

  test("the stderr record stream is sanitized too, not just stdout", async () => {
    // JSON.stringify escapes only C0, so U+009B/U+202E survive it verbatim —
    // and stderr lands on the same terminal by default, bypassing the stdout
    // hardening if it is left raw.
    const dir = mkdtempSync(join(REPO_ROOT, "config", "rosters", ".stderr-"));
    const captured: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const p = join(dir, "bad.roster.yaml");
      // A closed-schema violation (e.g. `bogus: 1`) fails with `roles[<index>]:
      // Unrecognized key(s)`, which never interpolates the role NAME -- this
      // assertion would still pass even with `sanitize` deleted from `main`.
      // Omitting the required `writes` field instead fails with
      // `roles[<name>]: writes is required ...`, which does carry the crafted
      // name into both streams, and still short-circuits before any probe.
      writeFileSync(p, 'roles:\n  - name: "a\\u009bb\\u202ec"\n    model: p/m\n');
      expect(await main(["--roster", p])).toBe(1);
    } finally {
      process.stderr.write = write;
      rmSync(dir, { recursive: true, force: true });
    }
    const err = captured.join("");
    expect(err).toContain("\\\\x9b");
    expect(err).toContain("\\\\u202e");
    expect(err).not.toContain("\u009b");
    expect(err).not.toContain("\u202e");
  });

  test("a schema-invalid roster is exit 1 and never probes a gate", async () => {
    const dir = mkdtempSync(join(REPO_ROOT, "config", "rosters", ".test-"));
    try {
      const p = join(dir, "bad.roster.yaml");
      writeFileSync(p, "roles:\n  - name: a\n    model: openrouter/m\n    bogus: 1\n");
      // INV-2: the schema failure short-circuits, so no probe fires against an
      // unvalidated file — this returns immediately rather than spawning pi.
      expect(await main(["--roster", p])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// MANDATORY e2e demo — real pi catalog + live OpenRouter model list.
//
// Skipped only where the controls this story validates are absent. It is not
// stubbed: the whole point is that both gates are real. pi refreshes provider
// catalogs on startup, so the budget is generous.
//
// `OPENROUTER_API_KEY` is required because pi's catalog only lists a provider's
// models once that provider's credential is visible to it — without one the
// openrouter slugs are absent from the catalog and the demo would measure the
// host's auth gap rather than the roster. The key is read by pi from the
// ambient env; this file never reads, logs, or passes its value (INV-1).
// ---------------------------------------------------------------------------

const e2eReady = Bun.which("pi") !== null && Boolean(process.env.OPENROUTER_API_KEY);
const e2e = e2eReady ? test : test.skip;

describe("e2e demo — the shipped roster against the live gates", () => {
  e2e(
    "the shipped roster passes both gates on every role and exits 0",
    async () => {
      // Strictly 0. Accepting 2 here would let a run where every gate was
      // unevaluable satisfy the one DoD item marked MANDATORY.
      expect(await main(["--roster", DEFAULT_ROSTER, "--request-id", "e2e-pass"])).toBe(0);
    },
    300_000,
  );

  e2e(
    "one slug flipped to openrouter/does-not-exist exits 1 naming the provider gate",
    async () => {
      const dir = mkdtempSync(join(REPO_ROOT, "config", "rosters", ".e2e-"));
      const p = join(dir, "broken.roster.yaml");
      const source = await Bun.file(join(REPO_ROOT, DEFAULT_ROSTER)).text();
      writeFileSync(p, source.replace(/model: deepseek\/\S+/, "model: does-not-exist"));

      const captured: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let code: number;
      try {
        code = await main(["--roster", p, "--request-id", "e2e-fail"]);
      } finally {
        process.stdout.write = write;
        rmSync(dir, { recursive: true, force: true });
      }

      const out = captured.join("");
      expect(code).toBe(1);
      expect(out).toContain("openrouter/does-not-exist");
      expect(out).toContain("provider-API gate rejected");
    },
    300_000,
  );
});
