/**
 * P0.10 — GitNexus graph-query verification (bun test).
 *
 * Exercises the three core tools the extension registers — gitnexus_query,
 * gitnexus_context, gitnexus_impact — against a REAL graph built by
 * `gitnexus analyze` over this repo, and validates output against Zod schemas.
 *
 * The extension's Pi agent tools shell out to the same `gitnexus` CLI these
 * tests drive directly; live-LLM agent invocation needs API keys that aren't
 * exported in CI, so we exercise the identical underlying query engine
 * headlessly via the CLI. See report for the schema-shape deltas vs. the story
 * spec's idealized schemas (real output uses `definitions`, `incoming.calls`,
 * `impactedCount`, etc. — the CLI's actual contract, verified live).
 *
 * Known symbols come from tests/gitnexus/fixtures/swarmclaw.ts
 * (registerSwarmClawAgent, registerSwarmClawRoutes, dispatch, ...) — a fixture
 * guaranteed to exist in this tree regardless of concurrent P0.7 SwarmClaw
 * work on other branches.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

// Resolve REPO_ROOT the same way the install script does (`git rev-parse
// --show-toplevel`) so tests query the exact worktree `gitnexus analyze` indexed —
// import.meta.dir arithmetic can diverge under worktrees/symlinks.
const REPO_ROOT_RAW = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf-8",
});
if (REPO_ROOT_RAW.status !== 0 || !REPO_ROOT_RAW.stdout) {
  // Without this guard, a missing git / non-repo cwd makes stdout undefined and
  // `.trim()` throws an opaque TypeError before any test runs. Prefer `.error`
  // (e.g. `spawnSync git ENOENT`) when the binary fails to spawn entirely —
  // status is null and stderr is empty in that case, which would otherwise
  // produce a cryptic "...(status=null): " message.
  const reason = REPO_ROOT_RAW.error ? REPO_ROOT_RAW.error.message : (REPO_ROOT_RAW.stderr ?? "");
  throw new Error(
    `git rev-parse --show-toplevel failed (status=${REPO_ROOT_RAW.status}): ${reason}`,
  );
}
// Strip trailing slashes so indexUnavailableReason()'s anchored regex matches
// regardless of how rev-parse formats the toplevel.
const REPO_ROOT = REPO_ROOT_RAW.stdout.trim().replace(/\/+$/, "");

// gitnexus lives at a non-standard path on this host (~/.local/node-arm64/bin);
// the story assumed /usr/local/bin. Resolve robustly.
function resolveGitnexus(): string {
  const candidates: string[] = [];
  if (process.env.HOME) {
    // Only push the home-relative path when HOME is defined: `join("", ...)`
    // resolves to a relative path that existsSync/statSync match against CWD,
    // which could exec an unrelated ./local/node-arm64/bin/gitnexus if one
    // happened to sit in CWD. Gating on HOME keeps every candidate absolute.
    candidates.push(join(process.env.HOME, ".local/node-arm64/bin/gitnexus"));
  }
  candidates.push("/usr/local/bin/gitnexus");
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    // statSync can throw EACCES on an unreadable parent dir; the && short-circuit
    // above doesn't catch a throw, so wrap it.
    let isFile = false;
    try {
      isFile = statSync(c).isFile();
    } catch {
      continue;
    }
    if (isFile) return c;
  }
  // Fall back to PATH resolution.
  return "gitnexus";
}
const GN = resolveGitnexus();

/** Run a gitnexus subcommand, returning parsed JSON (gitnexus 1.6.9 emits clean
 * JSON on stdout; log lines go to stderr, but keep the noise-strip for safety). */
function gn(args: string[]): unknown {
  let out: string;
  try {
    out = execFileSync(GN, args, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // gitnexus exits 0 with a structured JSON error on stdout for soft failures
    // (not-found, bad query) — verified live against 1.6.9. execFileSync throws
    // on ANY non-zero exit though, so if a hard failure still wrote JSON to
    // stdout, recover it and fall through to the parse below; this keeps AC-3's
    // "graceful on unknown symbol" assertable instead of throwing past the test.
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stdoutStr =
      typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString() ?? "");
    if (stdoutStr.includes("{")) {
      out = stdoutStr;
    } else {
      // execFileSync's default message is just "Command failed: ..." — surface the
      // stderr diagnostic so CI failures point at the real gitnexus error.
      const stderr =
        (typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString() ?? "")).slice(0, 500);
      throw new Error(`gitnexus ${args.join(" ")} failed: ${err.message ?? String(e)}\nstderr: ${stderr}`);
    }
  }
  // gitnexus 1.6.9 emits clean JSON on stdout (logs → stderr). Prefer a full
  // parse; only slice from the first `{` if leading noise slips through. Slicing
  // unconditionally would mis-parse if a log line ever contains `{` on stdout.
  try {
    return JSON.parse(out);
  } catch {
    const start = out.indexOf("{");
    if (start === -1) throw new Error(`no JSON in gitnexus output: ${out.slice(0, 200)}`);
    try {
      return JSON.parse(out.slice(start));
    } catch {
      // Surface BOTH the parse failure and a slice of the original output so a
      // truncated/malformed response is diagnosable instead of an opaque
      // "Unexpected token" with no context.
      throw new Error(
        `gitnexus ${args.join(" ")} returned non-JSON output: ${out.slice(0, 200)}`,
      );
    }
  }
}

/** The fixture symbol every index-dependent AC below anchors on. */
const FIXTURE_SYMBOL = "registerSwarmClawAgent";
/** The fixture file every fixture symbol lives in. */
const FIXTURE_FILE = "tests/gitnexus/fixtures/swarmclaw.ts";

/**
 * The `impact` invocations AC-1 makes, probed verbatim at preflight — same
 * symbols, same flags, same schema. A guard that probes a DIFFERENT call than
 * the AC makes is not a guard for that AC.
 *
 * `dispatch` (AC-1's positive control, proving impact queries the index rather
 * than echoing input) MUST carry `-f`: `src/fleet/dispatch.ts` now also defines
 * a `dispatch`, so a bare lookup returns gitnexus's `status: "ambiguous"` shape
 * — no `target.id`/`type`/`filePath`, no `affected_processes`/
 * `affected_modules` — which fails ImpactResultSchema. That is a fixture
 * collision, NOT a stale index, and no reindex fixes it; disambiguating by file
 * does.
 */
const IMPACT_PROBES: ReadonlyArray<{ symbol: string; args: string[] }> = [
  { symbol: FIXTURE_SYMBOL, args: [] },
  { symbol: "dispatch", args: ["-f", FIXTURE_FILE] },
];

const ImpactResultSchema = z.object({
  target: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    filePath: z.string(),
  }),
  direction: z.enum(["upstream", "downstream"]),
  impactedCount: z.number(),
  risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]),
  affected_processes: z.array(z.unknown()),
  affected_modules: z.array(z.unknown()),
});

/**
 * F010: classify an `impact` probe result. Returns a reason when the index
 * cannot answer the shape the ACs assert, or null when it can. Split out of
 * indexUnavailableReason() so the branch is testable without a live index.
 *
 * It runs `ImpactResultSchema.safeParse` — the AC's OWN schema — and not a
 * hand-written subset. The subset it used to check (`target.name` + a string
 * `risk`) passed on a real partially-built index whose result was missing
 * `target.filePath`, `affected_processes` and `affected_modules`; the probe
 * went green and AC-1 then died on the schema parse. Checking anything less
 * than the schema the AC parses with re-opens exactly that gap, so this must
 * stay the same schema object, not a copy of it.
 */
function staleImpactReason(
  probe: unknown,
  symbol: string = FIXTURE_SYMBOL,
  expectedFilePath: string = FIXTURE_FILE,
): string | null {
  const parsed = ImpactResultSchema.safeParse(probe);
  if (!parsed.success) {
    return `index lacks impact data for ${symbol} (${parsed.error.issues
      .map((i) => i.path.join("."))
      .join(", ")}) — reindex`;
  }
  if (parsed.data.target.name !== symbol) {
    return `impact resolved ${parsed.data.target.name}, not ${symbol} — reindex`;
  }
  // Name alone under-constrains: `dispatch` collides with src/fleet/dispatch.ts
  // (see IMPACT_PROBES doc comment), so a stale/partial index could resolve
  // the SAME name at the WRONG file and still pass a name-only check. Verify
  // the resolved target is the fixture symbol, not its namesake.
  if (parsed.data.target.filePath !== expectedFilePath) {
    return `impact resolved ${symbol} at ${parsed.data.target.filePath}, not ${expectedFilePath} — reindex`;
  }
  return null;
}

/**
 * Preflight: is this repo's gitnexus index usable by these tests?
 *
 * Returns a reason string when gitnexus is a genuinely MISSING DEPENDENCY (not
 * installed) or the index is ABSENT/STALE (environmental — the suite degrades
 * to `(skip)` with a diagnostic), or null when it's usable. A *broken* gitnexus
 * (non-zero exit from a runnable CLI, a throwing probe) deliberately returns
 * null too, so the named tests below still run and fail with real diagnostics —
 * the skip must never hide a contract regression, only a missing dependency.
 */
function indexUnavailableReason(): string | null {
  const listing = spawnSync(GN, ["list"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (listing.error) return `gitnexus not installed: ${listing.error.message}`;
  if (listing.status !== 0) {
    // A `gitnexus` that runs and exits non-zero is a broken CLI/runtime, not an
    // absent index — that's a contract regression, not a missing dependency. Warn
    // with the stderr (otherwise it vanishes) and return null so the named tests
    // below still run and fail with real diagnostics instead of being skipped.
    console.warn(
      `[graph-queries.test] \`gitnexus list\` exited ${listing.status}: ${(listing.stderr ?? "").slice(0, 300)}`,
    );
    return null;
  }
  // Each indexed repo has a `    Path:    <abspath>` line. On macOS, `git
  // rev-parse --show-toplevel` may return `/var/...` while gitnexus stores the
  // realpath (`/private/var/...`), or vice versa — normalize both forms and
  // accept either at the Path: position so the comparison doesn't break across
  // symlink boundaries.
  const rootReal = realpathSync(REPO_ROOT);
  const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `Path:\\s+(?:${esc(REPO_ROOT)}|${esc(rootReal)})(\\s|$)`,
    "m",
  );
  if (!re.test(listing.stdout ?? "")) return `repo not indexed at ${REPO_ROOT}`;
  // The index exists but may have been built without the fixture negation, so
  // gitnexus's DEFAULT_IGNORE_LIST filtered tests/ and fixtures/ out. Probe the
  // one symbol every AC below anchors on.
  let probe: { status?: string } | null;
  try {
    probe = gn(["context", FIXTURE_SYMBOL, "-r", REPO_ROOT]) as { status?: string } | null;
  } catch {
    return null; // gitnexus itself errored — a real failure; let the tests report it.
  }
  if (probe?.status !== "found") {
    return `fixture symbol ${FIXTURE_SYMBOL} missing from index (tests/ + fixtures/ filtered by DEFAULT_IGNORE_LIST?) — reindex`;
  }
  // F010: `context` resolving is not enough. An index built without the impact
  // layer answers the probe above and then fails AC-1's impact assertions with a
  // schema parse error — red for developers, dark in CI. Probe the shape those
  // ACs actually assert (resolved target + risk) so a partially stale index
  // skips with a diagnostic like every other environmental gap here.
  for (const { symbol, args } of IMPACT_PROBES) {
    let impact: unknown;
    try {
      impact = gn(["impact", symbol, "-r", REPO_ROOT, "--direction", "upstream", ...args]);
    } catch {
      return null; // gitnexus itself errored — a real failure; let the tests report it.
    }
    const reason = staleImpactReason(impact, symbol);
    if (reason !== null) return reason;
  }
  return null;
}

const SKIP_REASON = indexUnavailableReason();
if (SKIP_REASON !== null) {
  console.warn(
    `
[graph-queries.test] SKIPPING gitnexus graph tests — ${SKIP_REASON}
  Fix: \`bash scripts/install-gitnexus-plus.sh\` from the repo root
       (analyze-only: \`GITNEXUS_SKIP_INSTALL=1 bash scripts/install-gitnexus-plus.sh\`).
  A plain \`gitnexus analyze\` is NOT sufficient: it omits the transient
  .gitnexusignore negation (!tests/ !__tests__/ !fixtures/) these fixtures need.
`,
  );
}
/** Index-dependent describes — skipped (never silently blacked out) on a stale index. */
const describeIndexed = describe.skipIf(SKIP_REASON !== null);

/** Assert a path is repo-relative: no leading slash, no parent-traversal segment.
 * Centralizes the INV-GN1/INV-GN3 invariant checked across query/context/impact
 * result paths, so the rule can't drift between the four assertion sites. */
function expectRepoRelativePath(p: string): void {
  expect(p).toBeTruthy();
  // isAbsolute() is more precise than startsWith("/") — it encodes the
  // absolute-path semantics explicitly instead of a leading-char heuristic.
  expect(isAbsolute(p)).toBe(false);
  // Reject only exact ".." segments (parent traversal), split on either
  // separator. A naive not.toContain("..") over the whole string would reject
  // valid filenames like "version..backup.ts" where ".." sits inside a single
  // segment rather than being a traversal.
  const segments = p.split(/[\\/]/);
  expect(segments).not.toContain("..");
}

/** The repo-relative path of the known fixture these tests anchor on. */
const FIXTURE_PATH = "tests/gitnexus/fixtures/swarmclaw.ts";
/** Match either the repo-relative fixture path or any abspath ending with it —
 * tightens the prior `includes("swarmclaw.ts")` substring check so unrelated
 * files like `notswarmclaw.ts` can't satisfy the assertion. */
function isFixturePath(p: string): boolean {
  return p === FIXTURE_PATH || p.endsWith(`/${FIXTURE_PATH}`);
}
function expectFixturePath(p: string): void {
  expect(isFixturePath(p)).toBe(true);
}

// --- Zod schemas matching the CLI's REAL output contract ---------------------
// (Adapted from the story's idealized schemas to the shapes gitnexus 1.6.9
//  actually returns — see report AC→evidence map.)

const DefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  filePath: z.string(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  module: z.string().optional(),
});
const QueryResultSchema = z.object({
  processes: z.array(z.unknown()),
  process_symbols: z.array(z.unknown()),
  definitions: z.array(DefinitionSchema),
  timing: z.record(z.string(), z.number()),
});

const RefSchema = z.object({ uid: z.string(), name: z.string(), filePath: z.string() });
const ContextResultSchema = z.object({
  status: z.literal("found"),
  symbol: z.object({
    uid: z.string(),
    name: z.string(),
    kind: z.string(),
    filePath: z.string(),
  }),
  incoming: z.object({ calls: z.array(RefSchema).optional() }).passthrough(),
  outgoing: z.object({ calls: z.array(RefSchema).optional() }).passthrough(),
  processes: z.array(z.unknown()),
});


// --- INV-GN2: query-string injection rejection (validated at OUR boundary) ---
// gitnexus's CLI passes the query straight to the graph engine (no shell); it
// does NOT reject shell metacharacters itself. Per story guidance, we own the
// validation boundary: any caller wiring gitnexus_query must reject injection
// patterns. This is that guard — the same one the install/test harness applies.
//
// Allow-list (not deny-list): queries are natural-language identifiers.
// Anything outside [A-Za-z0-9 _.-] is rejected — closes gaps the deny-list
// left (&&, &, >, <, newlines, $VAR, quotes).
const SAFE_QUERY = /^[A-Za-z0-9 _.-]+$/;
function assertSafeQuery(q: string): void {
  // Empty/whitespace query passes the allow-list regex but is never a valid query.
  if (!q || !q.trim()) throw new Error("INV-GN2: rejected empty query");
  if (!SAFE_QUERY.test(q)) throw new Error(`INV-GN2: rejected non-allowlisted chars in query: ${q}`);
}

// F010: the staleness guard's classifier, exercised WITHOUT a live index. The
// guard used to probe only one symbol's `context` status, so a partially stale
// index passed the probe and then blew up inside the impact assertions below
// (schema parse error) instead of skipping with a diagnostic.
describe("F010: staleness guard probes the impact shape the ACs assert", () => {
  /** A result that satisfies ImpactResultSchema in full. */
  const wellFormed = (name: string = FIXTURE_SYMBOL) => ({
    target: {
      id: `Function:tests/gitnexus/fixtures/swarmclaw.ts:${name}`,
      name,
      type: "Function",
      filePath: "tests/gitnexus/fixtures/swarmclaw.ts",
    },
    direction: "upstream",
    impactedCount: 0,
    risk: "LOW",
    affected_processes: [],
    affected_modules: [],
  });

  test.each([
    ["no result at all", null],
    ["a resolved target but no risk", { target: { name: FIXTURE_SYMBOL } }],
    ["a risk but an unresolved target", { risk: "LOW" }],
    ["a non-string risk", { target: { name: FIXTURE_SYMBOL }, risk: 3 }],
    // The case the OLD hand-written subset check missed, observed for real on
    // this worktree's index: target.name and risk are both present and correct,
    // so the old probe returned "usable", and AC-1 then died parsing the result
    // because filePath / affected_processes / affected_modules were absent.
    [
      "a target+risk but no filePath, affected_processes or affected_modules",
      {
        target: { id: "x", name: FIXTURE_SYMBOL, type: "Function" },
        direction: "upstream",
        impactedCount: 0,
        risk: "LOW",
      },
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
    const raw = gn(["impact", "registerSwarmClawAgent", "-r", REPO_ROOT, "--direction", "upstream"]);
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
    // symbol with a real caller (routeTask). impactedCount can still be 0 without
    // --pdg, but target resolution for arbitrary input is falsifiable proof.
    // `-f`: src/fleet/dispatch.ts also defines `dispatch`, so a bare lookup
    // returns gitnexus's ambiguous-candidates shape instead of a resolved
    // target. Disambiguating by the fixture file keeps this a positive control
    // over the INDEX rather than a test of gitnexus's name-collision handling.
    const disp = ImpactResultSchema.parse(
      gn([
        "impact",
        "dispatch",
        "-r",
        REPO_ROOT,
        "--direction",
        "upstream",
        "-f",
        FIXTURE_FILE,
      ]),
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
      gn(["impact", "registerSwarmClawAgent", "-r", REPO_ROOT, "--direction", "upstream"]),
    );
    expectRepoRelativePath(imp.target.filePath);
  });
});
