/**
 * A6 · FR-MEM-6 · NFR-OBS-5 · DD-28.26(11) — fixture suite for
 * scripts/gitnexus-refresh.sh (interface I2 of .unlazy/a6/PLAN.md).
 *
 * The wrapper is a black-box process boundary: every cycle case spawns the
 * REAL script (`/bin/bash scripts/gitnexus-refresh.sh`) with the fixture
 * overrides the interface mandates — QDS_REFRESH_LOG (sink),
 * QDS_REFRESH_REINDEX_CMD, QDS_REFRESH_CONTRACT_CMD, plus the
 * QDS_GITNEXUS_HOME passthrough (I1) — so no test can ever touch the live
 * graph (.gitnexus/) or the default sink (.sandbox/refresh-cron.jsonl); the
 * hygiene test at the end proves both byte-identical to suite start. The
 * reindex/contract fakes are generated bash scripts in mkdtemp tmpdirs: the
 * reindex fake writes a fixture stamp into the FIXTURE graph home (the same
 * QDS_GITNEXUS_HOME the real writer's target resolves through — and it
 * refuses to run without it), the contract fake records a marker so "stage
 * skipped" is provable by absence.
 *
 * Proven here:
 *   AC1/INV-A6-1 — no-bare-analyze scan over the real wrapper AND the real
 *     crontab (exactly one mandated entry), refusing the bare form by name on
 *     mutated-copy negative controls;
 *   AC2 (wrapper legs) — record-then-cure: a stale incoming stamp still
 *     cycles to success carrying stalenessAlarm; absent/invalid incoming
 *     stamps record stampAgeHours null, never 0 (INV-A6-2);
 *   AC3 — log-line vocabulary: exactly one line per cycle, the 9 base fields
 *     in contract order, a real durationMs (never 0 on a failed cycle), the
 *     skipped-overlapping sha with crossCheck n/a, and crossCheck
 *     match/mismatch on full cycles only;
 *   AC4 — a red contract suite marks the cycle FAILED naming cliInstalled vs
 *     cliExpected from the stamp;
 *   AC5 — flock coalesce: a tick arriving mid-cycle exits 0 skipped-
 *     overlapping while the holder completes — two real wrappers, one lock.
 *
 * Negative-control discipline: every refusal case is a mutated positive (a
 * bare-analyze line injected into a copy, a red contract suite, a competing
 * lock holder, a wrong post-cycle sha, a stripped PATH) asserting a NAMED
 * outcome — a regression flips a named failure, never a generic one.
 *
 * No live graph, no cron, no spend: fixture state lives in os.tmpdir() and is
 * rmSync'd in finally; git is invoked read-only (rev-parse HEAD).
 */
import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── resolution: mirror the wrapper's own root discovery ─────────────────────
// git-first (house idiom — tests/gitnexus/harness.ts), cwd pinned to this
// file's directory so the suite's root and the spawned wrapper's root can
// never diverge (the crossCheck cases compare the wrapper's `git rev-parse
// HEAD` against the REAL_HEAD this module computes).
function resolveRepoRoot(): string {
  try {
    const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: import.meta.dir,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const top = git.status === 0 ? (git.stdout ?? "").trim().replace(/\/+$/, "") : "";
    if (top !== "") return top;
  } catch {
    // git unavailable — mirror the script-dir arithmetic fallback exactly.
  }
  return join(import.meta.dir, "..", "..");
}

const REPO_ROOT = resolveRepoRoot();
const WRAPPER = join(REPO_ROOT, "scripts", "gitnexus-refresh.sh");
const CRONTAB = join(REPO_ROOT, "deploy", "vps", "crontab.factory");
const STAMP_FILE = "cli-version.json";
const CEILING_HOURS = 8; // NFR-OBS-5 literal — must match the I1 reader's constant

// The real repo HEAD (read-only): what a faithful post-cycle stamp carries, so
// a crossCheck "match" fixture compares like with like.
const headRes = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf-8",
  timeout: 10_000,
});
const REAL_HEAD = (headRes.stdout ?? "").trim();
if (!/^[0-9a-f]{40}$/.test(REAL_HEAD)) {
  throw new Error(
    `refresh-cron suite preflight: git rev-parse HEAD failed (${
      headRes.stderr ?? "no stderr"
    }) — the crossCheck fixtures need the real repo HEAD`,
  );
}
// A plausible-but-wrong 40-hex sha for incoming/mutated stamps: never equal to
// the real HEAD by construction (asserted, not assumed).
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";
if (OTHER_SHA === REAL_HEAD) throw new Error("fixture sha collides with the real HEAD — pick another");

// Live-state snapshots (module scope, evaluated before any test runs): the
// hygiene test at the end proves the suite never touched either file.
const LIVE_SINK = join(REPO_ROOT, ".sandbox", "refresh-cron.jsonl");
const LIVE_STAMP = join(REPO_ROOT, ".gitnexus", STAMP_FILE);
const LIVE_SINK_BEFORE = existsSync(LIVE_SINK) ? readFileSync(LIVE_SINK, "utf8") : null;
const LIVE_STAMP_BEFORE = existsSync(LIVE_STAMP) ? readFileSync(LIVE_STAMP, "utf8") : null;

// ── fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
  dir: string;
  graphHome: string;
  stampPath: string;
  sinkDir: string;
  sink: string;
}

function makeFixture(label: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `a6-refresh-${label}-`));
  const graphHome = join(dir, "graph-home");
  mkdirSync(graphHome);
  const sinkDir = join(dir, "sink");
  return {
    dir,
    graphHome,
    stampPath: join(graphHome, STAMP_FILE),
    sinkDir,
    sink: join(sinkDir, "refresh-cron.jsonl"),
  };
}

async function withFixture<T>(label: string, fn: (fx: Fixture) => Promise<T> | T): Promise<T> {
  const fx = makeFixture(label);
  try {
    return await fn(fx);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
}

/** `h` hours ago as ISO-8601 UTC (negative h = the future — clock-skew arm). */
function hoursAgoIso(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

interface StampOpts {
  hoursAgo?: number;
  head?: string;
  installed?: string;
  expected?: string;
}

/** A stamp byte-shaped like the real writer's (install-gitnexus-plus.sh:
 * installedCliVersion, expectedCliVersion, indexedAt ISO-8601 UTC, indexedHead
 * 40-hex) with controlled fields. */
function stampJson(o: StampOpts = {}): string {
  return `${JSON.stringify(
    {
      installedCliVersion: o.installed ?? "1.6.12",
      expectedCliVersion: o.expected ?? "1.6.12",
      indexedAt: hoursAgoIso(o.hoursAgo ?? 0),
      indexedHead: o.head ?? OTHER_SHA,
    },
    null,
    2,
  )}\n`;
}

/** Absent arm: content === null leaves the fixture graph home without a stamp
 * — a wiped .gitnexus, which must read as unknown, never fresh (INV-A6-2). */
function writeStamp(fx: Fixture, content: string | null): void {
  if (content !== null) writeFileSync(fx.stampPath, content);
}

function shq(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

let fakeCounter = 0;

interface ReindexOpts {
  head?: string;
  installed?: string;
  expected?: string;
  exitCode?: number;
  sleepSec?: number;
  /** Touch this marker when the (fake) reindex actually starts — the coalesce
   * fixture polls it to know the holder holds the lock mid-cycle. */
  marker?: string;
  /** false = "reindex succeeded but wrote nothing" — the unreadable-post-cycle-
   * stamp arm of the crossCheck fail-closed case. */
  writeStamp?: boolean;
}

/** A generated fake reindex command string. The stamp target is the FIXTURE
 * graph home named by QDS_GITNEXUS_HOME, and the fake REFUSES to run without
 * it, so a wiring mistake fails loudly instead of defaulting toward the live
 * graph. Every fixture spawn MUST pair the home with an explicit
 * QDS_REFRESH_REINDEX_CMD override — the BH-002 split-brain guard refuses
 * (pre-cycle exit 3) a non-empty home override left with the production
 * default, because the canonical reindex hardcodes <repoRoot>/.gitnexus as
 * its stamp target regardless of the home. No fixture spawns the production
 * default, so no fixture trips that guard. */
function fakeReindex(fx: Fixture, o: ReindexOpts = {}): string {
  const stampBody = `${JSON.stringify(
    {
      installedCliVersion: o.installed ?? "1.6.12",
      expectedCliVersion: o.expected ?? "1.6.12",
      indexedAt: hoursAgoIso(0),
      indexedHead: o.head ?? REAL_HEAD,
    },
    null,
    2,
  )}\n`;
  const parts = [
    "#!/usr/bin/env bash",
    "# a6-refresh FIXTURE reindex — never the live graph: the stamp target is",
    "# the fixture graph home named by QDS_GITNEXUS_HOME, and the fake refuses",
    "# to run without it.",
    "set -eu",
    '[ -n "${QDS_GITNEXUS_HOME:-}" ] || { echo "fixture reindex: QDS_GITNEXUS_HOME unset — refusing (live-graph default)" >&2; exit 90; }',
  ];
  if (o.marker !== undefined) parts.push(`touch ${shq(o.marker)}`);
  if (o.sleepSec !== undefined) parts.push(`sleep ${o.sleepSec}`);
  if (o.writeStamp !== false) {
    parts.push(
      `cat > "$QDS_GITNEXUS_HOME/${STAMP_FILE}" <<'A6_FIXTURE_STAMP'`,
      stampBody.trimEnd(),
      "A6_FIXTURE_STAMP",
    );
  }
  parts.push(`exit ${o.exitCode ?? 0}`);
  const path = join(fx.dir, `fake-reindex-${fakeCounter++}.sh`);
  writeFileSync(path, `${parts.join("\n")}\n`);
  return `bash ${path}`;
}

interface FakeContract {
  cmd: string;
  /** Exists once the fake contract suite has RUN — "skipped" is provable by
   * absence, "ran and failed" by presence (the AC4 distinction). */
  marker: string;
}

/** A generated fake contract-suite command: records that it ran (marker) and
 * exits with the scripted code — 1 IS the alarm firing, not a skip. */
function fakeContract(fx: Fixture, exitCode: number): FakeContract {
  const marker = join(fx.dir, `contract-ran-${fakeCounter++}`);
  const path = join(fx.dir, `fake-contract-${fakeCounter++}.sh`);
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "# a6-refresh FIXTURE contract suite — records that it ran, exits with",
      "# the scripted code.",
      `echo ran > ${shq(marker)}`,
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  return { cmd: `bash ${path}`, marker };
}

// ── spawn + env helpers ─────────────────────────────────────────────────────

const OVERRIDE_KEYS = [
  "QDS_GITNEXUS_HOME",
  "QDS_REFRESH_LOG",
  "QDS_REFRESH_REINDEX_CMD",
  "QDS_REFRESH_CONTRACT_CMD",
] as const;

/** Parent env with every QDS_REFRESH_* and QDS_GITNEXUS_HOME override
 * stripped (a value leaking from the operator shell must never redirect a
 * fixture case), then the fixture overrides applied. */
function baseEnv(fx: Fixture, reindexCmd: string, contractCmd: string): NodeJS.ProcessEnv {
  const stripped: Record<string, string | undefined> = { ...process.env };
  for (const k of OVERRIDE_KEYS) delete stripped[k];
  return {
    ...stripped,
    QDS_GITNEXUS_HOME: fx.graphHome,
    QDS_REFRESH_LOG: fx.sink,
    QDS_REFRESH_REINDEX_CMD: reindexCmd,
    QDS_REFRESH_CONTRACT_CMD: contractCmd,
  };
}

/** Spawn the REAL wrapper and capture exit + stdio. Structural live-graph
 * guard: every spawn must carry all four overrides non-empty — a missing one
 * would aim the wrapper at the live graph or the live sink. The only sanctioned
 * exception is the wrapper's own empty-override FATAL leg, which must spawn an
 * intentionally empty command override to prove the refusal. */
function runWrapper(
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
  opts: { allowEmptyOverride?: boolean } = {},
): { exitCode: number | null; stdout: string; stderr: string } {
  if (opts.allowEmptyOverride !== true) {
    for (const k of OVERRIDE_KEYS) {
      expect(typeof env[k]).toBe("string");
      expect((env[k] ?? "").length).toBeGreaterThan(0);
    }
  }
  const res = spawnSync("/bin/bash", [WRAPPER], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  return { exitCode: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function spawnWrapperAsync(
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [WRAPPER], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitFor(marker: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} (${marker})`);
}

/** Poll for the sink's FIRST line to be present AND newline-terminated — the
 * lock-coalesce handshake's observation primitive. Mere file-existence is not
 * enough: the wrapper's `>>` creates the file a moment before the line's
 * single atomic append lands, and a raced read would parse an empty file.
 * Bounded wait, 25ms interval — no fixed sleep gates any assertion. */
async function waitForLine(sink: string, timeoutMs: number, what: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sink)) {
      const first = readFileSync(sink, "utf8").split("\n")[0] ?? "";
      if (first.trim().length > 0) return first;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} (${sink})`);
}

// ── log-line parsing (the exactly-one-JSON-line contract) ───────────────────

const BASE_KEYS = [
  "ts",
  "cycle",
  "result",
  "durationMs",
  "indexedHeadSha",
  "stampAgeHours",
  "cliInstalled",
  "cliExpected",
  "crossCheck",
] as const;
const EXTRA_KEYS = new Set(["stage", "stalenessAlarm", "detail"]);
const RESULT_ENUM = new Set(["success", "failed", "skipped-overlapping"]);
const CROSSCHECK_ENUM = ["match", "mismatch", "n/a"];
const ISO_Z_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

interface StalenessAlarm {
  fired: boolean;
  ageHours: number;
  ceilingHours: number;
  stampPath: string;
}

interface CycleLine {
  ts: string;
  cycle: string;
  result: string;
  durationMs: number;
  indexedHeadSha: string;
  stampAgeHours: number | null;
  cliInstalled: string;
  cliExpected: string;
  crossCheck: string;
  stage?: string;
  detail?: string;
  stalenessAlarm?: StalenessAlarm;
}

/** Assert the I2 log-line contract for ONE sink line: valid JSON, the 9 base
 * fields FIRST in the story's order, only the three documented conditional
 * fields after, enum-valid result/crossCheck, ISO-Z ts/cycle, and a real
 * durationMs (≥1 — the "0 on a failed cycle" negative control dies here for
 * every line in the suite, not just the case built to catch it). */
function parseCycleLine(line: string): CycleLine {
  const parsed = JSON.parse(line) as CycleLine;
  const keys = Object.keys(parsed);
  expect(keys.length).toBeGreaterThanOrEqual(BASE_KEYS.length);
  expect(keys.slice(0, BASE_KEYS.length)).toEqual([...BASE_KEYS]);
  for (const k of keys.slice(BASE_KEYS.length)) {
    expect(EXTRA_KEYS.has(k)).toBe(true);
  }
  expect(RESULT_ENUM.has(parsed.result)).toBe(true);
  expect(CROSSCHECK_ENUM).toContain(parsed.crossCheck);
  expect(parsed.ts).toMatch(ISO_Z_RE);
  expect(parsed.cycle).toMatch(ISO_Z_RE);
  // The cycle starts the tick; the ts is written at log time — never before.
  expect(parsed.cycle <= parsed.ts).toBe(true);
  expect(typeof parsed.durationMs).toBe("number");
  expect(parsed.durationMs).toBeGreaterThanOrEqual(1);
  expect(parsed.durationMs).toBeLessThan(60_000); // a fixture cycle is sub-second; a runaway shows here
  return parsed;
}

function readSink(fx: Fixture, n: number): CycleLine[] {
  expect(existsSync(fx.sink)).toBe(true);
  const raw = readFileSync(fx.sink, "utf8");
  expect(raw.endsWith("\n")).toBe(true); // every append is newline-terminated
  const lines = raw.slice(0, -1).split("\n");
  expect(lines).toHaveLength(n); // exactly one line per cycle — no extras, no blanks
  return lines.map(parseCycleLine);
}

// ── the no-bare-analyze scan (AC1/INV-A6-1) ─────────────────────────────────

// Boundary: "gitnexus analyze" not preceded by an identifier-ish char. A `-`
// before "gitnexus" IS a boundary here — the only hyphenated context in these
// files is `${VAR:-gitnexus ...}` (a real invocation) and `pi-gitnexus-plus`
// (never followed by " analyze", so it cannot match either way).
const BARE_ANALYZE_RE = /(^|[^A-Za-z0-9_.])gitnexus[ \t]+analyze\b/;

/** Scan source text for a bare `gitnexus analyze` EXECUTION. Comment lines are
 * exempt — prose may discuss the bare form (the refusal naming IS prose
 * elsewhere); executable lines may not run it. Each violation names the file,
 * the line, and the bare form itself. */
function scanBareAnalyze(text: string, label: string): string[] {
  const violations: string[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (BARE_ANALYZE_RE.test(line)) {
      violations.push(
        `${label}:${i + 1}: bare \`gitnexus analyze\` — the canonical reindex is ` +
          `\`bash scripts/install-gitnexus-plus.sh\` (INV-A6-1): ${trimmed}`,
      );
    }
  }
  return violations;
}

/** Crontab entry lines: non-empty, non-comment, not the SHELL= line. */
function entryLines(crontabText: string): string[] {
  return crontabText
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith("#") && !t.startsWith("SHELL=");
    });
}

const ENTRY_RE =
  /^7 \*\/5 \* \* \* \/opt\/qds-factory\/scripts\/gitnexus-refresh\.sh >> \/var\/log\/qds\/refresh-cron\.log 2>&1$/;

// ── AC1 / INV-A6-1: no-bare-analyze scan (real files, no spawning) ──────────

describe("AC1/INV-A6-1 — no-bare-analyze scan (real wrapper + real crontab)", () => {
  it("AC1: the real wrapper resolves the canonical reindex and never a bare gitnexus analyze", () => {
    const text = readFileSync(WRAPPER, "utf8");
    const lines = text.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env bash"); // PLAN I2 shebang letter
    const code = lines.filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).toContain("set -euo pipefail"); // house bash contract
    // The canonical invocation is real code, not prose: the default reindex
    // command names the canonical script on an executable line — and the
    // production defaults are pinned byte-exactly (fixture overrides exist,
    // but the shipped default must stay the canonical one).
    expect(code).toContain("QDS_REFRESH_REINDEX_CMD:-bash scripts/install-gitnexus-plus.sh");
    expect(code).toContain("QDS_REFRESH_CONTRACT_CMD:-bun test tests/gitnexus/contract.test.ts");
    expect(code).toContain("QDS_REFRESH_LOG:-$REPO_ROOT/.sandbox/refresh-cron.jsonl");
    // The lock mechanism is pinned in source: flock -n on fd 9, on the
    // interface's exact lock target under the graph home.
    expect(code).toContain("flock -n 9");
    expect(code).toContain(".refresh.lock");
    expect(scanBareAnalyze(text, "scripts/gitnexus-refresh.sh")).toEqual([]);
    // The crontab invokes the wrapper DIRECTLY by absolute path — a wrapper
    // without the exec bit is a dead cron entry.
    expect(statSync(WRAPPER).mode & 0o111).not.toBe(0);
  });

  it("AC1/AC2: the real crontab carries exactly the mandated absolute-path entry plus SHELL=/bin/bash", () => {
    const text = readFileSync(CRONTAB, "utf8");
    expect(scanBareAnalyze(text, "deploy/vps/crontab.factory")).toEqual([]);
    const entries = entryLines(text);
    expect(entries).toHaveLength(1); // one entry only — no A3 sweep line in v6a
    expect(entries[0]).toMatch(ENTRY_RE);
    expect(text).toContain("SHELL=/bin/bash");
  });

  it("G4 groundwork: the wrapper header quotes the crontab entry byte-for-byte", () => {
    const entry = entryLines(readFileSync(CRONTAB, "utf8"))[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    // Strip the header's comment decoration (`#` + whitespace) from every
    // wrapper line and require the bare remainder to EQUAL the entry — a
    // byte-for-byte quote, not a paraphrase.
    const stripped = readFileSync(WRAPPER, "utf8")
      .split("\n")
      .map((l) => l.replace(/^#\s+/, ""));
    expect(stripped).toContain(entry);
  });

  it("AC1 negative control (mutated positive): a wrapper whose reindex is bare gitnexus analyze is refused by name", () => {
    const original = readFileSync(WRAPPER, "utf8");
    const mutant = original.replaceAll(
      "bash scripts/install-gitnexus-plus.sh",
      'gitnexus analyze "$REPO_ROOT" --force --skip-agents-md',
    );
    expect(mutant).not.toBe(original); // the mutation must actually land
    const violations = scanBareAnalyze(mutant, "mutated-wrapper");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("gitnexus analyze");
  });

  it("AC1 negative control (mutated positive): a crontab line invoking the bare binary is refused by name and breaks the one-entry rule", () => {
    const original = readFileSync(CRONTAB, "utf8");
    const mutant = `${original}\n* * * * * cd /opt/qds-factory && gitnexus analyze .\n`;
    const violations = scanBareAnalyze(mutant, "mutated-crontab");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("gitnexus analyze");
    expect(entryLines(mutant)).toHaveLength(2); // the one-entry rule detects the second line too
  });
});

// ── source pins: bun fallback (EH-001) and lock-fd hygiene (EH-003) ─────────
// These pin WRAPPER SOURCE, not behavior: the failure modes they guard
// (a cron PATH with no bun; a child inheriting the lock fd) only manifest on
// hosts/paths a fixture spawn cannot reach deterministically.

describe("source pins — bun fallback (EH-001) and lock-fd hygiene (EH-003)", () => {
  it("EH-001: the wrapper carries the bun fallback probe as CODE — PATH, then the three standard install locations — because a Debian cron PATH ships neither bun nor a probe rescue", () => {
    const code = readFileSync(WRAPPER, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    // The fallback MARKER and all three probed locations must be executable
    // lines — header prose documenting the fallback is not the fallback.
    expect(code).toContain("$HOME/.bun/bin/bun");
    expect(code).toContain('"/usr/local/bin/bun"');
    expect(code).toContain("$HOME/.local/bin/bun");
  });

  it("EH-003: BOTH child invocations drop the lock fd (9>&-) — the wrapper is the lock's only holder and the kernel-releases-on-any-exit claim stays true", () => {
    const code = readFileSync(WRAPPER, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    // Two independent pins: losing the redirection on EITHER child silently
    // re-opens the orphaned-holder hole the fix closes.
    expect(code).toMatch(/bash -c "\$REINDEX_CMD" 9>&- <\/dev\/null/);
    expect(code).toMatch(/bash -c "\$CONTRACT_CMD" 9>&- <\/dev\/null/);
  });
});

// ── AC6: output-surface boundary — no dispatch-path integration in src/ ─────

describe("AC6 boundary — the refresh surface never crosses into src/", () => {
  it("AC6 negative control: src/ carries ZERO references to the refresh surface (staleness reader, cron wrapper, stamp, sink)", () => {
    // The negative control, committed: A6's output surface is exactly the
    // stamp + the alarm + the sink — NO src/ bytes. A future dispatch-path
    // integration (gating deploys or scheduling on staleness) lands in src/
    // FIRST and MUST trip this test before it ships. Verified zero hits when
    // committed; any hit names the offending file.
    const srcDir = join(REPO_ROOT, "src");
    if (!existsSync(srcDir)) return; // vacuous without src/ — it exists today
    const REFRESH_SURFACE_RE =
      /gitnexus-staleness|refresh-cron|INDEX_STALENESS|cli-version\.json|refresh-cron\.jsonl/;
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(p);
          continue;
        }
        if (!ent.isFile()) continue;
        if (REFRESH_SURFACE_RE.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(srcDir);
    expect(hits).toEqual([]);
  });
});

// ── AC2 (wrapper legs): staleness record-then-cure ──────────────────────────

describe("AC2 wrapper legs — staleness record-then-cure", () => {
  it("AC2 record-then-cure: a stale incoming stamp still cycles to success — stalenessAlarm survives the cure in the record", async () => {
    await withFixture("cure-stale", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 9, installed: "8.0.0", expected: "8.0.0-pin" }));
      const contract = fakeContract(fx, 0);
      const r = runWrapper(
        baseEnv(
          fx,
          fakeReindex(fx, { head: REAL_HEAD, installed: "9.9.9", expected: "0.0.1-pin" }),
          contract.cmd,
        ),
      );
      expect(r.exitCode).toBe(0); // the stale verdict NEVER aborts — record, then cure
      const [line] = readSink(fx, 1);
      expect(line?.result).toBe("success");
      // The alarm survives the cure: fired, with the MEASURED incoming age
      // (≈9h — never a constant), I1's ceiling, and the incoming stamp path.
      expect(line?.stalenessAlarm).toBeDefined();
      expect(line?.stalenessAlarm?.fired).toBe(true);
      expect(line?.stalenessAlarm?.ageHours).toBeGreaterThan(8.5);
      expect(line?.stalenessAlarm?.ageHours).toBeLessThan(9.5);
      expect(line?.stalenessAlarm?.ceilingHours).toBe(CEILING_HOURS);
      expect(line?.stalenessAlarm?.stampPath).toBe(fx.stampPath);
      // The base field and the alarm describe the SAME pre-cycle measurement.
      expect(line?.stampAgeHours).toBe(line?.stalenessAlarm?.ageHours);
      // Full cycle: the post-cycle stamp sha cross-checked against git HEAD.
      expect(line?.indexedHeadSha).toBe(REAL_HEAD);
      expect(line?.crossCheck).toBe("match");
      // The record names the CURED versions (current stamp at log time), not
      // the stale incoming ones — and no failure stage exists on a success.
      expect(line?.cliInstalled).toBe("9.9.9");
      expect(line?.cliExpected).toBe("0.0.1-pin");
      expect(line?.stage).toBeUndefined();
    });
  });

  it("INV-A6-2 negative control: an absent incoming stamp records stampAgeHours null — never age 0 — and the cycle still cures", async () => {
    await withFixture("cure-absent", (fx) => {
      writeStamp(fx, null); // a wiped .gitnexus — no stamp file at all
      const r = runWrapper(
        baseEnv(fx, fakeReindex(fx, { head: REAL_HEAD, installed: "9.9.9" }), fakeContract(fx, 0).cmd),
      );
      expect(r.exitCode).toBe(0);
      const [line] = readSink(fx, 1);
      expect(line?.result).toBe("success");
      // The whole point of INV-A6-2: an unknown age is recorded as UNKNOWN.
      // Both assertions name the failure the mutated positive exists to catch
      // ("missing stamp treated as age 0" fails here by construction).
      expect(line?.stampAgeHours).toBeNull();
      expect(line?.stampAgeHours).not.toBe(0);
      expect(line?.stalenessAlarm).toBeUndefined(); // absent ≠ stale — no alarm
      expect(line?.indexedHeadSha).toBe(REAL_HEAD);
      expect(line?.crossCheck).toBe("match");
      expect(line?.cliInstalled).toBe("9.9.9"); // post-cycle stamp at log time
    });
  });

  it("INV-A6-2: an unparseable incoming stamp records stampAgeHours null — never age 0", async () => {
    await withFixture("cure-invalid", (fx) => {
      writeStamp(fx, "{ not json at all\n");
      const r = runWrapper(
        baseEnv(fx, fakeReindex(fx, { head: REAL_HEAD }), fakeContract(fx, 0).cmd),
      );
      expect(r.exitCode).toBe(0);
      const [line] = readSink(fx, 1);
      expect(line?.result).toBe("success");
      expect(line?.stampAgeHours).toBeNull();
      expect(line?.stampAgeHours).not.toBe(0);
      expect(line?.stalenessAlarm).toBeUndefined();
    });
  });

  it("AC2: a fresh incoming stamp logs no stalenessAlarm and a measured sub-ceiling age", async () => {
    await withFixture("fresh-incoming", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 0.02 }));
      const r = runWrapper(baseEnv(fx, fakeReindex(fx, { head: REAL_HEAD }), fakeContract(fx, 0).cmd));
      expect(r.exitCode).toBe(0);
      const [line] = readSink(fx, 1);
      expect(line?.result).toBe("success");
      expect(line?.stalenessAlarm).toBeUndefined();
      expect(line?.stampAgeHours).toBeGreaterThan(0); // real measured age, not a constant
      expect(line?.stampAgeHours).toBeLessThan(CEILING_HOURS);
    });
  });
});

// ── AC4 / C4: contract-suite failure marks the cycle FAILED ─────────────────

describe("AC4/C4 — contract-suite failure marks the cycle FAILED", () => {
  it("AC4: a red contract suite fails the cycle naming cliInstalled vs cliExpected from the post-reindex stamp", async () => {
    await withFixture("contract-red", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 1 }));
      const contract = fakeContract(fx, 1);
      const r = runWrapper(
        baseEnv(
          fx,
          fakeReindex(fx, { head: OTHER_SHA, installed: "9.9.9", expected: "0.0.1-pin" }),
          contract.cmd,
        ),
      );
      expect(r.exitCode).toBe(1);
      const [line] = readSink(fx, 1);
      // The negative control inverted: a wrapper reporting SUCCESS while the
      // contract suite is red would let CLI drift survive unlimited cadences —
      // the cycle MUST be failed, by name.
      expect(line?.result).toBe("failed");
      expect(line?.stage).toBe("contract");
      // The alarm names installed vs pinned FROM THE STAMP (the reindex
      // completed — the post-cycle versions are the ones named).
      expect(line?.cliInstalled).toBe("9.9.9");
      expect(line?.cliExpected).toBe("0.0.1-pin");
      // The reindex completed, so the post-cycle sha is recorded — but a
      // contract-red cycle never reaches the crossCheck stage (n/a).
      expect(line?.indexedHeadSha).toBe(OTHER_SHA);
      expect(line?.crossCheck).toBe("n/a");
      // The contract stage provably RAN (its marker exists) — it failed, it
      // was not skipped.
      expect(existsSync(contract.marker)).toBe(true);
    });
  });
});

// ── stage d: reindex failure staging ────────────────────────────────────────

describe("stage d — reindex failure staging", () => {
  it("a red reindex fails the cycle at stage reindex; the contract stage provably never ran; durationMs is the real elapsed attempt", async () => {
    await withFixture("reindex-red", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 1, installed: "1.2.3", expected: "4.5.6-pin" }));
      const contract = fakeContract(fx, 0);
      const r = runWrapper(
        baseEnv(fx, fakeReindex(fx, { exitCode: 1, writeStamp: false }), contract.cmd),
      );
      expect(r.exitCode).toBe(1);
      const [line] = readSink(fx, 1);
      expect(line?.result).toBe("failed");
      expect(line?.stage).toBe("reindex");
      expect(line?.crossCheck).toBe("n/a"); // no full cycle — no cross-check
      // No completed reindex: the CURRENT stamp at log time is still the
      // incoming one, so its versions are named.
      expect(line?.cliInstalled).toBe("1.2.3");
      expect(line?.cliExpected).toBe("4.5.6-pin");
      // The contract stage was SKIPPED, not run-and-green: no marker.
      expect(existsSync(contract.marker)).toBe(false);
      // durationMs ≥ 1 is enforced for EVERY line by parseCycleLine — the
      // "duration 0 on a failed cycle" negative control dies there.
    });
  });

  it("INV-A6-2 fallback vocabulary: an absent stamp plus a red reindex names cliInstalled unknown / cliExpected unpinned", async () => {
    await withFixture("reindex-red-absent", (fx) => {
      writeStamp(fx, null);
      const r = runWrapper(
        baseEnv(fx, fakeReindex(fx, { exitCode: 1, writeStamp: false }), fakeContract(fx, 0).cmd),
      );
      expect(r.exitCode).toBe(1);
      const [line] = readSink(fx, 1);
      expect(line?.result).toBe("failed");
      expect(line?.stage).toBe("reindex");
      expect(line?.stampAgeHours).toBeNull(); // absent, never 0
      // The writer's own fallback vocabulary, per the interface contract.
      expect(line?.cliInstalled).toBe("unknown");
      expect(line?.cliExpected).toBe("unpinned");
      expect(line?.indexedHeadSha).toBe("unknown"); // no stamp, no sha — never fabricated
    });
  });
});

// ── AC3 stage f: crossCheck on full cycles ──────────────────────────────────

describe("AC3 stage f — crossCheck (full cycles only)", () => {
  it("AC3 negative control: a post-cycle stamp sha != git HEAD fails the cycle naming BOTH shas", async () => {
    await withFixture("cross-mismatch", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 1 }));
      const r = runWrapper(
        baseEnv(fx, fakeReindex(fx, { head: OTHER_SHA }), fakeContract(fx, 0).cmd),
      );
      expect(r.exitCode).toBe(1);
      const [line] = readSink(fx, 1);
      expect(line?.result).toBe("failed");
      expect(line?.stage).toBe("crossCheck");
      expect(line?.crossCheck).toBe("mismatch");
      // The detail names BOTH shas — the mutated stamp's and the repo's real HEAD.
      expect(line?.detail).toContain(OTHER_SHA);
      expect(line?.detail).toContain(REAL_HEAD);
      expect(line?.indexedHeadSha).toBe(OTHER_SHA); // the post-cycle stamp sha is recorded
    });
  });

  it("fail-closed: a completed reindex with an unreadable post-cycle stamp fails crossCheck — never reports match on an unknown sha", async () => {
    await withFixture("cross-unreadable", (fx) => {
      writeStamp(fx, null); // no incoming stamp; the fake reindex writes nothing either
      const r = runWrapper(
        baseEnv(fx, fakeReindex(fx, { writeStamp: false }), fakeContract(fx, 0).cmd),
      );
      expect(r.exitCode).toBe(1);
      const [line] = readSink(fx, 1);
      expect(line?.result).toBe("failed");
      expect(line?.stage).toBe("crossCheck");
      expect(line?.crossCheck).toBe("mismatch");
      expect(line?.indexedHeadSha).toBe("unknown");
      expect(line?.detail).toContain(REAL_HEAD); // the one sha that IS known is named
    });
  });
});

// ── AC5 / C5: whole-cycle lock coalesce ─────────────────────────────────────

const hasFlock =
  spawnSync("/bin/bash", ["-c", "command -v flock >/dev/null 2>&1"], { timeout: 10_000 })
    .status === 0;
const FLOCK_SKIP_REASON =
  "flock is a brew-only binary on macOS dev hosts (util-linux provides it on the VPS)";

describe.skipIf(!hasFlock)(`AC5/C5 — whole-cycle lock coalesce${hasFlock ? "" : ` (skipped: ${FLOCK_SKIP_REASON})`}`, () => {
  it(
    "AC5: a tick arriving mid-cycle exits 0 skipped-overlapping (incoming sha, crossCheck n/a) — one line per cycle, proven without a fixed sleep",
    async () => {
      await withFixture("lock-coalesce", async (fx) => {
        const INCOMING_SHA = OTHER_SHA;
        writeStamp(fx, stampJson({ hoursAgo: 1, head: INCOMING_SHA }));
        const marker = join(fx.dir, "reindex-started");
        const holderEnv = baseEnv(
          fx,
          fakeReindex(fx, {
            head: REAL_HEAD,
            installed: "9.9.9",
            expected: "0.0.1-pin",
            sleepSec: 30, // hold ≫ worst-case tick-B latency — never an assertion gate
            marker,
          }),
          fakeContract(fx, 0).cmd,
        );
        // Handshake (determinized, EH-002): holder A acquires the lock at
        // stage c and parks INSIDE its reindex (marker touched, sleep 30 ≫
        // B's worst-case bash-boot + rev-parse + staleness latency). Tick B
        // then runs; B's skip line ON THE SINK is the observed refusal — the
        // release signal. Only then is A killed: no assertion is gated on a
        // fixed sleep, and the kill guarantees cleanup.
        const holder = spawn("/bin/bash", [WRAPPER], {
          cwd: REPO_ROOT,
          env: holderEnv,
          stdio: "ignore",
          detached: true, // own process group — the tree dies with one kill
        });
        const holderExit = new Promise<number | null>((resolve) => {
          holder.on("exit", (code) => resolve(code));
        });
        await waitFor(marker, 8_000, "the holder cycle to reach its reindex stage");
        // Second real tick B while A holds the lock mid-cycle:
        const second = spawnWrapperAsync(holderEnv);
        await waitForLine(fx.sink, 15_000, "tick B's skipped-overlapping refusal line");
        // B's refusal is observed — the handshake is complete. Kill A's tree
        // (wrapper + its reindex child share the detached group) and reap it:
        // A dies MID-reindex, before its own emit, by construction.
        const pgid = holder.pid;
        if (typeof pgid === "number") {
          try {
            process.kill(-pgid, "SIGTERM");
          } catch {
            // already gone — the lock claim died with it either way
          }
        }
        expect(await holderExit).toBeNull(); // reaped: signal death, not a completed cycle
        expect(await second).toMatchObject({ code: 0 }); // coalesce, never collide — exit 0
        // Exactly ONE line: B's skip. A was killed mid-reindex and produced
        // no line — the one-cycle-per-tick invariant read off the final sink.
        const [skip] = readSink(fx, 1);
        expect(skip?.result).toBe("skipped-overlapping");
        expect(skip?.crossCheck).toBe("n/a"); // no work ran to cross-check
        expect(skip?.indexedHeadSha).toBe(INCOMING_SHA); // the INCOMING stamp sha — no reindex this cycle
        expect(skip?.stage).toBeUndefined(); // a skip is not a failure
      });
    },
    60_000,
  );

  it("AC5/AC2: the lock target is exactly <graph-home>/.refresh.lock — an external holder there skips the tick, and a stale incoming stamp still truthfully carries stalenessAlarm on the skip line", async () => {
    await withFixture("lock-target", async (fx) => {
      const INCOMING_SHA = OTHER_SHA;
      writeStamp(fx, stampJson({ hoursAgo: 9, head: INCOMING_SHA }));
      const lockFile = join(fx.graphHome, ".refresh.lock"); // the interface's exact target
      writeFileSync(lockFile, "");
      const holderMarker = join(fx.dir, "holder-holds");
      // External holder: acquires flock ON THE INTERFACE'S LOCK PATH and only
      // then touches its marker — marker exists ⟺ the lock is held, so the
      // wrapper below cannot race the acquisition. (If the wrapper locked any
      // OTHER path, it would acquire and run — this test's named failure.)
      // The hold is 30 s ≫ the wrapper's worst-case latency; it is a hold,
      // never an assertion gate — the wrapper's observed refusal is the
      // handshake's release signal, and the kill afterwards guarantees
      // cleanup (determinized, EH-002: no fixed sleep gates any assertion).
      const holder = spawn(
        "/bin/bash",
        ["-c", `flock ${shq(lockFile)} bash -c 'touch ${shq(holderMarker)}; sleep 30'`],
        { stdio: "ignore", detached: true }, // own process group — one kill reaps the tree
      );
      const holderExit = new Promise<number | null>((resolve) => {
        holder.on("error", () => resolve(null));
        holder.on("exit", (code) => resolve(code));
      });
      await waitFor(holderMarker, 8_000, "the external holder to acquire the interface lock");
      const second = spawnWrapperAsync(
        baseEnv(fx, fakeReindex(fx, { head: REAL_HEAD }), fakeContract(fx, 0).cmd),
      );
      await waitForLine(fx.sink, 15_000, "the wrapper's skipped-overlapping refusal line");
      expect(await second).toMatchObject({ code: 0 }); // coalesce — exit 0 even with a stale incoming stamp
      // Refusal observed; release the handshake. The holder is NOT a cycle:
      // its kill is cleanup, and its signal death is the deterministic end.
      const pgid = holder.pid;
      if (typeof pgid === "number") {
        try {
          process.kill(-pgid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      expect(await holderExit).toBeNull(); // reaped: killed, never completed
      const [skip] = readSink(fx, 1); // the skip is the ONLY line — the holder is not a cycle
      expect(skip?.result).toBe("skipped-overlapping");
      expect(skip?.crossCheck).toBe("n/a");
      expect(skip?.indexedHeadSha).toBe(INCOMING_SHA);
      // The incoming verdict was STALE and the tick measured it before the
      // lock refusal — the skip line truthfully carries the alarm trio.
      expect(skip?.stalenessAlarm).toBeDefined();
      expect(skip?.stalenessAlarm?.fired).toBe(true);
      expect(skip?.stalenessAlarm?.ageHours).toBeGreaterThan(8.5);
      expect(skip?.stalenessAlarm?.ageHours).toBeLessThan(9.5);
      expect(skip?.stalenessAlarm?.ceilingHours).toBe(CEILING_HOURS);
      expect(skip?.stalenessAlarm?.stampPath).toBe(fx.stampPath);
      expect(skip?.stampAgeHours).toBe(skip?.stalenessAlarm?.ageHours);
      expect(skip?.stage).toBeUndefined();
    });
  }, 30_000);
});

// ── pre-cycle configuration failures: FATAL, exit 3, NO log line ────────────

describe("pre-cycle configuration failures — FATAL, exit 3, no log line", () => {
  it("a PATH stripped of flock/bun FATALs with exit 3 BEFORE any cycle — no sink dir, no graph home, nothing spawned", async () => {
    await withFixture("config-fatal", (fx) => {
      const neverGraph = join(fx.dir, "never-created-graph");
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(fx, "bash /nonexistent-reindex.sh", "bash /nonexistent-contract.sh"),
        QDS_GITNEXUS_HOME: neverGraph,
        PATH: "/usr/bin:/bin", // measured on this host: neither bun nor brew's flock lives here
        // HOME is neutered so the bun fallback probe's $HOME-derived legs
        // (~/.bun/bin, ~/.local/bin) miss deterministically: a Linux dev box
        // with curl-installed bun would otherwise sail past the bun leg and
        // find no missing prereq to FATAL on. The last probe
        // (/usr/local/bin/bun, a root install) is irreducible host state — on
        // a host where EVERY prereq resolves (flock + a probed bun) this
        // test legitimately has no FATAL to assert; the exit-3 contract is
        // pinned by the missing-prereq hosts (macOS dev: flock leg; CI's
        // setup-bun tool-cache bun: bun leg).
        HOME: fx.dir,
      };
      const r = runWrapper(env);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toMatch(/FATAL/);
      // The refusal NAMES the missing prereq. Guarded: a future host that
      // ships flock in /usr/bin:/bin would fail the bun check instead — the
      // naming assertion follows the measured host, the exit-3 contract does not.
      if (!existsSync("/usr/bin/flock") && !existsSync("/bin/flock")) {
        expect(r.stderr).toContain("flock");
      }
      // Pre-cycle, so NO cycle ran: no sink dir was created, no graph home was
      // touched (the staleness reader never spawned — the live graph is
      // structurally unreachable from a config-failed wrapper).
      expect(existsSync(fx.sinkDir)).toBe(false);
      expect(existsSync(fx.sink)).toBe(false);
      expect(existsSync(neverGraph)).toBe(false);
    });
  });

  it("a set-but-empty override command is a FATAL exit 3 — a no-op reindex must never read as a successful cycle", async () => {
    await withFixture("empty-override", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 1 }));
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(fx, fakeReindex(fx, { head: REAL_HEAD }), fakeContract(fx, 0).cmd),
        QDS_REFRESH_REINDEX_CMD: "", // the misconfiguration under test
      };
      const r = runWrapper(env, 30_000, { allowEmptyOverride: true }); // the sanctioned exception — this IS the refusal leg
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toMatch(/FATAL/);
      expect(r.stderr).toContain("QDS_REFRESH_REINDEX_CMD"); // refusal names the env var — never its value
      // Pre-cycle: no line was appended for the would-be no-op cycle.
      expect(existsSync(fx.sink)).toBe(false);
    });
  });

  it("EH-004: a set-but-empty QDS_REFRESH_LOG is a FATAL exit 3 — the `:-` default would aim the record at the LIVE sink", async () => {
    await withFixture("empty-log", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 1 }));
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(fx, fakeReindex(fx, { head: REAL_HEAD }), fakeContract(fx, 0).cmd),
        QDS_REFRESH_LOG: "", // the misconfiguration under test
      };
      const r = runWrapper(env, 30_000, { allowEmptyOverride: true }); // the sanctioned exception — this IS the refusal leg
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toMatch(/FATAL/);
      expect(r.stderr).toContain("QDS_REFRESH_LOG"); // refusal names the env var — never its value
      // The guard fires BEFORE the defaults resolve: no sink dir was created
      // (mkdir -p of the empty name would target the cwd), no line anywhere.
      expect(existsSync(fx.sinkDir)).toBe(false);
      expect(existsSync(fx.sink)).toBe(false);
    });
  });

  it("BH-002 split-brain guard: a non-empty QDS_GITNEXUS_HOME with NO reindex override FATALs exit 3 — the canonical reindex would write a different graph home than the wrapper reads", async () => {
    await withFixture("split-brain", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 1 }));
      // All overrides EXCEPT the reindex command — that absence is the
      // misconfiguration under test (the production default would run).
      const stripped: Record<string, string | undefined> = { ...process.env };
      for (const k of OVERRIDE_KEYS) delete stripped[k];
      const env: NodeJS.ProcessEnv = {
        ...stripped,
        QDS_GITNEXUS_HOME: fx.graphHome,
        QDS_REFRESH_LOG: fx.sink,
        QDS_REFRESH_CONTRACT_CMD: fakeContract(fx, 0).cmd,
      };
      const r = runWrapper(env, 30_000, { allowEmptyOverride: true }); // the sanctioned exception — the MISSING override IS the refusal leg
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toMatch(/FATAL/);
      // The refusal names BOTH variables and the reason by name — every past
      // cycle failing as `crossCheck` is exactly the misdiagnosis this guard
      // exists to prevent.
      expect(r.stderr).toContain("QDS_GITNEXUS_HOME");
      expect(r.stderr).toContain("QDS_REFRESH_REINDEX_CMD");
      expect(r.stderr).toContain("split-brain");
      // Pre-cycle, nothing ran: no lock file (stage c never reached — and the
      // canonical reindex never spawned, so no stamp was written here; the
      // live graph's integrity is pinned by the fixture-hygiene test).
      expect(existsSync(join(fx.graphHome, ".refresh.lock"))).toBe(false);
      expect(existsSync(fx.sinkDir)).toBe(false);
      expect(existsSync(fx.sink)).toBe(false);
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "BH-004: a completed cycle whose record cannot be appended to the sink is a FAILED cycle — exit 1 with a FATAL naming the sink, never exit 3",
    async () => {
      await withFixture("sink-readonly", async (fx) => {
        // The sink lives in a read-only dir: the cycle runs fully green (all
        // four overrides, fresh stamp) and must STILL fail loudly at the
        // append — a ran-but-unrecorded cycle is a failed cycle, not a
        // pre-cycle config no-op. (Root ignores dir perms — skipped there;
        // CI runs unprivileged.)
        const roDir = join(fx.dir, "sink-readonly");
        mkdirSync(roDir);
        chmodSync(roDir, 0o555);
        const roSink = join(roDir, "refresh-cron.jsonl");
        try {
          writeStamp(fx, stampJson({ hoursAgo: 1 }));
          const env: NodeJS.ProcessEnv = {
            ...baseEnv(fx, fakeReindex(fx, { head: REAL_HEAD }), fakeContract(fx, 0).cmd),
            QDS_REFRESH_LOG: roSink,
          };
          const r = runWrapper(env);
          expect(r.exitCode).toBe(1);
          expect(r.stderr).toMatch(/FATAL/);
          expect(r.stderr).toContain(roSink); // the FATAL names the sink — the operator can fix the cause
          expect(existsSync(roSink)).toBe(false); // no line was written anywhere
        } finally {
          chmodSync(roDir, 0o755); // restore before the fixture teardown's rmSync
        }
      });
    },
    30_000,
  );

  it("exit contract: a successful cycle exits 0 and a failed cycle exits 1", async () => {
    await withFixture("exit-contract", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 1 }));
      const ok = runWrapper(
        baseEnv(fx, fakeReindex(fx, { head: REAL_HEAD }), fakeContract(fx, 0).cmd),
      );
      expect(ok.exitCode).toBe(0);
      const bad = runWrapper(
        baseEnv(fx, fakeReindex(fx, { exitCode: 3, writeStamp: false }), fakeContract(fx, 0).cmd),
      );
      expect(bad.exitCode).toBe(1);
      // Both cycles logged exactly one line each: 1 (success) + 1 (failed).
      const lines = readSink(fx, 2);
      expect(lines[0]?.result).toBe("success");
      expect(lines[1]?.result).toBe("failed");
      expect(lines[1]?.stage).toBe("reindex");
    });
  });
});

// ── AC3 / C3: log-line vocabulary ───────────────────────────────────────────

describe("AC3/C3 — log-line vocabulary", () => {
  it("a plain success line carries exactly the 9 base fields — no conditional fields, no undocumented fields", async () => {
    await withFixture("vocabulary", (fx) => {
      writeStamp(fx, stampJson({ hoursAgo: 1 }));
      const r = runWrapper(
        baseEnv(fx, fakeReindex(fx, { head: REAL_HEAD }), fakeContract(fx, 0).cmd),
      );
      expect(r.exitCode).toBe(0);
      const [line] = readSink(fx, 1);
      expect(line).toBeDefined();
      if (line === undefined) return;
      // parseCycleLine already asserted the base-9 order and enum validity for
      // every line in the suite; this case additionally pins that a plain
      // success carries NOTHING beyond the 9 base fields.
      expect(Object.keys(line)).toHaveLength(9);
      expect(line.result).toBe("success");
      expect(line.crossCheck).toBe("match");
      expect(line.indexedHeadSha).toMatch(/^[0-9a-f]{40}$/);
      expect(line.cliInstalled.length).toBeGreaterThan(0);
      expect(line.cliExpected.length).toBeGreaterThan(0);
      expect(line.stage).toBeUndefined();
      expect(line.detail).toBeUndefined();
      expect(line.stalenessAlarm).toBeUndefined();
    });
  });

  it("fixture hygiene: the live sink and the live graph stamp are byte-identical to suite start", () => {
    // Live sink: absent stayed absent, present stayed byte-identical — no
    // fixture cycle ever appended to it (every spawn carried QDS_REFRESH_LOG).
    if (LIVE_SINK_BEFORE === null) {
      expect(existsSync(LIVE_SINK)).toBe(false);
    } else {
      expect(existsSync(LIVE_SINK)).toBe(true);
      expect(readFileSync(LIVE_SINK, "utf8")).toBe(LIVE_SINK_BEFORE);
    }
    // Live graph stamp: read-only across the suite — every staleness read
    // happened against a fixture graph home (every spawn carried
    // QDS_GITNEXUS_HOME; runWrapper refuses to spawn without it).
    if (LIVE_STAMP_BEFORE === null) {
      expect(existsSync(LIVE_STAMP)).toBe(false);
    } else {
      expect(readFileSync(LIVE_STAMP, "utf8")).toBe(LIVE_STAMP_BEFORE);
    }
  });
});
