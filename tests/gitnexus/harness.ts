/**
 * Shared harness for the gitnexus CLI test suites (graph-queries functional
 * tests + contract drift-triage tests). ONE module owns the CLI boundary —
 * binary resolution, invocation, JSON recovery, index preflight — so a change
 * in how the CLI is driven lands once, not per test file.
 *
 * Process hygiene (investigated 2026-08-28, "killed 1 dangling process" flake):
 * every CLI call here is a synchronous spawn with a timeout, and `ps` before/
 * after repeated suite runs shows zero suite-spawned survivors (resident
 * `gitnexus mcp` processes are the editor's own MCP servers, never spawned
 * here). The dangling-process message is emitted by the host test wrapper,
 * not by this repo's code or bun — harness noise, not a leak in this suite.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expect } from "bun:test";
import { ImpactResultSchema } from "./cli-contract.ts";

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
export const REPO_ROOT = REPO_ROOT_RAW.stdout.trim().replace(/\/+$/, "");

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
export const GN = resolveGitnexus();

/** Run a gitnexus subcommand, returning parsed JSON (gitnexus 1.6.9 emits clean
 * JSON on stdout; log lines go to stderr, but keep the noise-strip for safety). */
export function gn(args: string[]): unknown {
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

/** Probe the installed CLI's version (`gitnexus --version`), once.
 * missing=true means the binary itself is absent (ENOENT) — a MISSING
 * DEPENDENCY, which the suite degrades to a skip, never a failure. version=null
 * with missing=false means the binary ran but produced nothing — broken tool. */
let versionCache: { version: string | null; missing: boolean } | undefined;
export function gitnexusVersion(): { version: string | null; missing: boolean } {
  if (versionCache !== undefined) return versionCache;
  const r = spawnSync(GN, ["--version"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = (r.stdout ?? "").trim();
  versionCache = {
    missing: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
    version: !r.error && r.status === 0 && out.length > 0 ? out : null,
  };
  return versionCache;
}

/** The repo-relative path of the known fixture these tests anchor on. */
export const FIXTURE_PATH = "tests/gitnexus/fixtures/swarmclaw.ts";
/** The fixture symbol every index-dependent AC anchors on. */
export const FIXTURE_SYMBOL = "registerSwarmClawAgent";

/**
 * The `impact` invocations AC-1 (graph-queries.test.ts) makes, probed
 * verbatim at preflight — same symbols, same flags, same schema. A guard that
 * probes a DIFFERENT call than the AC makes is not a guard for that AC.
 *
 * `dispatch` (AC-1's positive control, proving impact queries the index rather
 * than echoing input) MUST carry `-f`: `src/fleet/dispatch.ts` now also defines
 * a `dispatch`, so a bare lookup returns gitnexus's `status: "ambiguous"` shape
 * — not a resolved target — which fails ImpactResultSchema. That is a fixture
 * collision, NOT a stale index, and no reindex fixes it; disambiguating by file
 * does.
 */
const IMPACT_PROBES: ReadonlyArray<{ symbol: string; args: string[] }> = [
  { symbol: FIXTURE_SYMBOL, args: [] },
  { symbol: "dispatch", args: ["-f", FIXTURE_PATH] },
];

/**
 * F010: classify an `impact` probe result. Returns a reason when the index
 * cannot answer the shape the ACs assert, or null when it can.
 *
 * Parses with `ImpactResultSchema` — the SAME schema object the functional
 * tests parse their own real `impact` calls with (imported from
 * cli-contract.ts, not a hand-maintained copy) — so this guard can never drift
 * out of sync with what the ACs actually require. A hand-written subset check
 * here previously passed a real partially-built index whose result was
 * missing `target.filePath`; the probe went green and AC-1 then died on the
 * schema parse instead of skipping with a diagnostic.
 */
export function staleImpactReason(
  probe: unknown,
  symbol: string = FIXTURE_SYMBOL,
  expectedFilePath: string = FIXTURE_PATH,
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
export function indexUnavailableReason(): string | null {
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
      `[gitnexus harness] \`gitnexus list\` exited ${listing.status}: ${(listing.stderr ?? "").slice(0, 300)}`,
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

/** Emit the standard skip warning and return the skip reason (null = usable). */
export function preflightOrWarn(suiteName: string): string | null {
  const reason = indexUnavailableReason();
  if (reason !== null) {
    console.warn(
      `
[${suiteName}] SKIPPING gitnexus graph tests — ${reason}
  Fix: \`bash scripts/install-gitnexus-plus.sh\` from the repo root
       (analyze-only: \`GITNEXUS_SKIP_INSTALL=1 bash scripts/install-gitnexus-plus.sh\`).
  A plain \`gitnexus analyze\` is NOT sufficient: it omits the transient
  .gitnexusignore negation (!tests/ !__tests__/ !fixtures/) these fixtures need.
`,
    );
  }
  return reason;
}

/** Assert a path is repo-relative: no leading slash, no parent-traversal segment.
 * Centralizes the INV-GN1/INV-GN3 invariant checked across query/context/impact
 * result paths, so the rule can't drift between the four assertion sites. */
export function expectRepoRelativePath(p: string): void {
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

/** Match either the repo-relative fixture path or any abspath ending with it —
 * tightens the prior `includes("swarmclaw.ts")` substring check so unrelated
 * files like `notswarmclaw.ts` can't satisfy the assertion. */
export function isFixturePath(p: string): boolean {
  return p === FIXTURE_PATH || p.endsWith(`/${FIXTURE_PATH}`);
}
export function expectFixturePath(p: string): void {
  expect(isFixturePath(p)).toBe(true);
}

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
export function assertSafeQuery(q: string): void {
  // Empty/whitespace query passes the allow-list regex but is never a valid query.
  if (!q || !q.trim()) throw new Error("INV-GN2: rejected empty query");
  if (!SAFE_QUERY.test(q)) throw new Error(`INV-GN2: rejected non-allowlisted chars in query: ${q}`);
}
