/**
 * P0.10 — GitNexus graph-query verification (bun test).
 *
 * Exercises the three core tools the extension registers — gitnexus_query,
 * gitnexus_context, gitnexus_impact — against a REAL graph built by
 * `gitnexus analyze` over this repo, asserting BEHAVIORAL invariants against
 * the lenient schemas in cli-contract.ts (minimal field set + passthrough, so
 * additive upstream changes don't shatter this suite).
 *
 * This file is NOT the drift alarm: strict full-payload validation and the CLI
 * version pin live in contract.test.ts (the one loud, self-explanatory failure
 * when the upstream contract moves). The CLI boundary itself (binary
 * resolution, invocation, index preflight — including the F010 impact-shape
 * guard below) lives in harness.ts.
 *
 * The extension's Pi agent tools shell out to the same `gitnexus` CLI these
 * tests drive directly; live-LLM agent invocation needs API keys that aren't
 * exported in CI, so we exercise the identical underlying query engine
 * headlessly via the CLI.
 *
 * Known symbols come from tests/gitnexus/fixtures/swarmclaw.ts
 * (registerSwarmClawAgent, registerSwarmClawRoutes, dispatch, ...) — a fixture
 * guaranteed to exist in this tree regardless of concurrent P0.7 SwarmClaw
 * work on other branches. NOTE: uniqueness is NOT guaranteed — since DF3.1
 * (2026-08-21) `src/fleet/dispatch.ts:dispatch` shares the fixture's `dispatch`
 * name, so impact targets are disambiguated with `-f FIXTURE_PATH` (the CLI's
 * first-class ambiguity contract — {status:"ambiguous", candidates} — is
 * covered strictly in contract.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  ContextResultSchema,
  ImpactResultSchema,
  QueryResultSchema,
} from "./cli-contract.ts";
import {
  FIXTURE_PATH,
  FIXTURE_SYMBOL,
  GN,
  REPO_ROOT,
  assertSafeQuery,
  expectFixturePath,
  expectRepoRelativePath,
  gn,
  isFixturePath,
  preflightOrWarn,
  staleImpactReason,
} from "./harness.ts";

const SKIP_REASON = preflightOrWarn("graph-queries.test");
/** Index-dependent describes — skipped (never silently blacked out) on a stale index. */
const describeIndexed = describe.skipIf(SKIP_REASON !== null);

// F010: the staleness guard's classifier (harness.ts's `staleImpactReason`),
// exercised WITHOUT a live index. The guard used to probe only one symbol's
// `context` status, so a partially stale index passed the probe and then blew
// up inside the impact assertions below (schema parse error) instead of
// skipping with a diagnostic.
describe("F010: staleness guard probes the impact shape the ACs assert", () => {
  /** A result that satisfies ImpactResultSchema in full. */
  const wellFormed = (name: string = FIXTURE_SYMBOL) => ({
    target: {
      id: `Function:${FIXTURE_PATH}:${name}`,
      name,
      type: "Function",
      filePath: FIXTURE_PATH,
    },
    direction: "upstream",
    impactedCount: 0,
    risk: "LOW",
    affected_processes: [],
    affected_modules: [],
  });

  test.each([
    ["no result at all", null],
    ["a resolved target but no filePath", { target: { name: FIXTURE_SYMBOL } }],
    ["a risk but an unresolved target", { risk: "LOW" }],
    // The case the OLD hand-written subset check missed, observed for real on
    // this worktree's index: target.name and risk were both present and
    // correct, so the old probe returned "usable", and AC-1 then died parsing
    // the result because filePath was absent.
    [
      "a target+risk but no filePath",
      { target: { id: "x", name: FIXTURE_SYMBOL, type: "Function" }, impactedCount: 0, risk: "LOW" },
    ],
    ["a well-formed result for the WRONG symbol", wellFormed("somethingElse")],
  ])("a stale index that returns %s skips rather than failing the impact assertions", (_desc, probe) => {
    expect(staleImpactReason(probe)).toMatch(/reindex/);
  });

  test("an index carrying a fully-shaped impact result is reported usable", () => {
    expect(staleImpactReason(wellFormed())).toBeNull();
  });

  test("the positive-control symbol is judged against ITS own name", () => {
    expect(staleImpactReason(wellFormed("dispatch"), "dispatch")).toBeNull();
    expect(staleImpactReason(wellFormed(), "dispatch")).toMatch(/reindex/);
  });
});

describe("INV-GN2: query input sanitization", () => {
  test.each([
    "registerAgent; rm -rf /",
    "foo | cat /etc/passwd",
    "bar $(whoami)",
    "baz `id`",
    "foo && rm -rf /",
    "foo > /etc/passwd",
  ])("rejects shell metacharacters: %s", (bad) => {
    expect(() => assertSafeQuery(bad)).toThrow(/INV-GN2/);
  });

  test("allows a clean query", () => {
    expect(() => assertSafeQuery("SwarmClaw agent registration")).not.toThrow();
  });
});

describeIndexed("AC-1 (make-or-break): all three tools return non-empty structured results", () => {
  test("gitnexus_query — 'SwarmClaw routes' returns non-empty structured definitions", () => {
    assertSafeQuery("SwarmClaw routes");
    const raw = gn(["query", "SwarmClaw routes", "-r", REPO_ROOT]);
    const result = QueryResultSchema.parse(raw);
    expect(result.definitions.length).toBeGreaterThan(0);
    // AC-1 load-bearing: the query must surface the known fixture, not just any
    // route-ish symbol — semantic/embedding search can return unrelated neighbours.
    expect(result.definitions.some((d) => isFixturePath(d.filePath))).toBe(true);
    for (const d of result.definitions) {
      expectRepoRelativePath(d.filePath);
    }
  });

  test("gitnexus_context — 'registerSwarmClawAgent' returns symbol + incoming caller", () => {
    const raw = gn(["context", "registerSwarmClawAgent", "-r", REPO_ROOT]);
    const result = ContextResultSchema.parse(raw);
    expect(result.status).toBe("found");
    expect(result.symbol.name).toBe("registerSwarmClawAgent");
    expectFixturePath(result.symbol.filePath);
    // registerSwarmClawRoutes calls registerSwarmClawAgent — a guaranteed incoming edge.
    expect(result.incoming.calls?.length ?? 0).toBeGreaterThan(0);
    expect(result.incoming.calls?.some((c) => c.name === "registerSwarmClawRoutes")).toBe(true);
  });

  test("gitnexus_impact — 'registerSwarmClawAgent' upstream returns a valid risk object", () => {
    // -f disambiguates: symbol-name uniqueness is not a stable property of a
    // growing index (see header — the dispatch/dispatch collision).
    const raw = gn(["impact", "registerSwarmClawAgent", "-f", FIXTURE_PATH, "-r", REPO_ROOT, "--direction", "upstream"]);
    const result = ImpactResultSchema.parse(raw);
    expect(result.target.name).toBe("registerSwarmClawAgent");
    expectFixturePath(result.target.filePath);
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]).toContain(result.risk);
    // impactedCount reflects PDG-weighted blast radius (needs `analyze --pdg`
    // for full inter-procedural depth); this story's analyze builds the call
    // graph — proven by the context test's incoming-calls edge — but not the
    // PDG layer, so the count can be 0 even with a known caller. Assert the
    // field is a well-formed non-negative integer (falsifiable: fails if the
    // field is absent or non-numeric). Target resolution above is the
    // load-bearing proof that impact resolved the fixture symbol.
    expect(Number.isInteger(result.impactedCount)).toBe(true);
    expect(result.impactedCount).toBeGreaterThanOrEqual(0);
    // Positive control: impact must resolve a DIFFERENT target from the graph
    // (proving it queries the index, not echo). `dispatch` is another fixture
    // symbol with a real caller (routeTask) — and since DF3.1 also a fleet
    // symbol, so it is disambiguated to the FIXTURE with -f (a bare `dispatch`
    // returns the CLI's ambiguous-candidates payload, covered in
    // contract.test.ts). impactedCount can still be 0 without --pdg, but
    // target resolution for arbitrary input is falsifiable proof.
    const disp = ImpactResultSchema.parse(
      gn(["impact", "dispatch", "-f", FIXTURE_PATH, "-r", REPO_ROOT, "--direction", "upstream"]),
    );
    expect(disp.target.name).toBe("dispatch");
    expectFixturePath(disp.target.filePath);
  });
});

describeIndexed("AC-2: zero-match query is graceful (never crash / never error object)", () => {
  test("nonexistent symbol query returns a valid QueryResult and does not match the bogus name", () => {
    const q = "ZZZZZZZ_NONEXISTENT_SYMBOL";
    assertSafeQuery(q);
    const raw = gn(["query", q, "-r", REPO_ROOT]);
    // Must parse (arrays present, not null, not thrown). Semantic search returns
    // nearest neighbours rather than a literally empty array — so the load-bearing
    // invariant is "valid structured result, never crash" PLUS "the bogus symbol is
    // not reported as a real definition".
    const result = QueryResultSchema.parse(raw);
    expect(Array.isArray(result.definitions)).toBe(true);
    expect(Array.isArray(result.processes)).toBe(true);
    for (const d of result.definitions) {
      // Case-insensitive: a neighbor whose name case-foldedly contains the bogus
      // query would slip past a case-sensitive check.
      expect(d.name.toLowerCase()).not.toBe(q.toLowerCase());
      expect(d.name.toLowerCase()).not.toContain(q.toLowerCase());
      // The bogus query must not leak into the filePath either — semantic-search
      // neighbours could otherwise surface a path derived from the query string.
      expect(d.filePath.toLowerCase()).not.toContain(q.toLowerCase());
    }
  });
});

describeIndexed("AC-3 / guard: missing-symbol and missing-tool are detectable errors, not hangs", () => {
  test("context on an unknown symbol returns a structured not-found status", () => {
    const raw = gn(["context", "ZZZ_DEFINITELY_NOT_A_SYMBOL", "-r", REPO_ROOT]) as {
      status?: string;
      error?: string;
      symbol?: { name?: string };
    } | null;
    // gitnexus returns not_found, an error field, or (if it fuzzy-resolves) found
    // with a DIFFERENT symbol — all are graceful (never a crash). The load-bearing
    // rule: it must not report the bogus name as a real match.
    const graceful =
      raw?.status === "not_found" ||
      (raw != null && typeof raw.error === "string" && raw.error.length > 0) ||
      raw?.status === "found";
    expect(graceful).toBe(true);
    if (raw?.status === "found") {
      // Without these guards, `raw.symbol` being undefined makes
      // `undefined !== "ZZZ..."` true — the test would pass against a malformed
      // response. Assert the symbol actually exists before the name check.
      expect(raw?.symbol).toBeDefined();
      expect(raw?.symbol?.name).toBeDefined();
      expect(raw?.symbol?.name).not.toBe("ZZZ_DEFINITELY_NOT_A_SYMBOL");
    }
  });

  test("invoking an unregistered gitnexus subcommand fails loudly (tool-not-found analogue)", () => {
    // Pi returns tool-not-found for an unregistered tool; the CLI analogue is a
    // nonzero exit on an unknown subcommand — never a silent success/hang.
    const r = spawnSync(GN, ["definitely_not_a_command"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 10_000,
    });
    // The binary MUST have spawned — r.error (ENOENT) means gitnexus itself is
    // missing, a different failure than "tool rejected an unknown subcommand".
    expect(r.error).toBeUndefined();
    expect(r.status).not.toBe(0);
    const stderr = r.stderr ?? "";
    expect(/unknown|invalid|error|not found/i.test(stderr)).toBeTruthy();
  });
});

describeIndexed("INV-GN1 & INV-GN3: indexed paths stay within the repo, relative & normalized", () => {
  test("no indexed file path is absolute or contains a parent-traversal segment", () => {
    const raw = gn([
      "cypher",
      "MATCH (f:File) WHERE f.filePath STARTS WITH '/' OR f.filePath CONTAINS '..' RETURN count(f) AS bad",
      "-r",
      REPO_ROOT,
    ]) as { markdown?: string } | null;
    // cypher returns a single-column markdown table (`| bad |`); collect every
    // numeric cell and assert the max is 0. Anchoring to `| 0 |` alone would also
    // match `| 10 |` / `| 100 |` — unfalsifiable for the traversal guard.
    expect(raw?.markdown).toBeDefined();
    const md = raw?.markdown ?? "";
    const cells = [...md.matchAll(/\|\s*(\d+)\s*\|/g)].map((m) => Number(m[1]));
    // Diagnose shape changes (e.g. a `| N rows affected |` footer adding stray
    // numbers, or an empty result) with a slice of the raw markdown so the
    // format drift is visible in CI output instead of an opaque expect failure.
    if (cells.length === 0) {
      throw new Error(
        `INV-GN1: no numeric cells parsed from cypher output — table shape changed? markdown: ${md.slice(0, 300)}`,
      );
    }
    const worst = Math.max(...cells);
    if (worst !== 0) {
      throw new Error(
        `INV-GN1: ${worst} indexed path(s) are absolute or contain '..'; markdown: ${md.slice(0, 300)}`,
      );
    }
  });

  test("query/context result file paths are repo-relative (no leading slash, no ..)", () => {
    const result = QueryResultSchema.parse(gn(["query", "SwarmClaw routes", "-r", REPO_ROOT]));
    for (const d of result.definitions) {
      expectRepoRelativePath(d.filePath);
    }
  });

  test("context ref paths and impact target path are repo-relative (INV-GN3 across all three tools)", () => {
    // INV-GN3 names query/context/impact — exercise the ref + target paths the
    // query-only check above doesn't reach.
    const ctx = ContextResultSchema.parse(gn(["context", "registerSwarmClawAgent", "-r", REPO_ROOT]));
    const refPaths = [
      ...(ctx.incoming.calls ?? []).map((c) => c.filePath),
      ...(ctx.outgoing.calls ?? []).map((c) => c.filePath),
    ];
    for (const p of refPaths) {
      expectRepoRelativePath(p);
    }
    const imp = ImpactResultSchema.parse(
      gn(["impact", "registerSwarmClawAgent", "-f", FIXTURE_PATH, "-r", REPO_ROOT, "--direction", "upstream"]),
    );
    expectRepoRelativePath(imp.target.filePath);
  });
});
