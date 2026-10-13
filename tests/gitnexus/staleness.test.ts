/**
 * A6 · FR-MEM-6 · NFR-OBS-5 · DD-28.26(11) — fixture suite for
 * scripts/gitnexus-staleness.ts (interface I1 of .unlazy/a6/PLAN.md).
 *
 * The script is a black-box process boundary (spawnSync(process.execPath,
 * ["scripts/gitnexus-staleness.ts"]) — process.execPath is the running bun,
 * so the suite has no PATH dependence): every case writes a fixture stamp
 * into a mkdtemp temp dir, points QDS_GITNEXUS_HOME at it, and asserts the
 * exit code AND every JSON field AND the single-line stdout contract.
 *
 * AC2: fresh (≤8h) exits 0; stale (>8h) exits 1 naming age, ceiling, and
 * stamp path — the JSON fields ARE the naming. INV-A6-2: a missing stamp is
 * `absent` with ageHours null, never age 0 (a wiped .gitnexus must read as
 * unknown, not fresh); an unparseable stamp is `invalid`, also never age 0.
 *
 * Negative-control discipline: the stale/absent/invalid cases are mutated
 * positives — each asserts a NAMED verdict + exit code, so a regression (e.g.
 * "treat missing as age 0", "treat invalid as fresh") flips a named failure,
 * never a generic one (tests/deploy/vps-profile.test.ts refusal-naming style).
 *
 * No live-graph writes, no cron, no spend: fixture stamps live in os.tmpdir()
 * and are rmSync'd in finally; the one live-stamp case is read-only.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── resolution: mirror the script's own root discovery ──────────────────────
// git-first (house idiom — tests/gitnexus/harness.ts:20-39), with cwd pinned
// to this file's directory so the test's root and the spawned script's root
// can never diverge (case 10 compares stampPath against the same root).
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
    // git unavailable — the script's fallback and ours must agree on
    // import.meta.dir arithmetic, so mirror it exactly (tests/ parent).
  }
  return join(import.meta.dir, "..", "..");
}

const REPO_ROOT = resolveRepoRoot();
const SCRIPT = join(REPO_ROOT, "scripts", "gitnexus-staleness.ts");
const STAMP_FILE = "cli-version.json";
const CEILING_HOURS = 8; // NFR-OBS-5 literal; must equal INDEX_STALENESS_CEILING_HOURS
const HOUR_MS = 3_600_000;
// 40-hex, same shape the writer stamps (`git rev-parse HEAD`).
const HEAD = "0796a7834f2445e2b4b013b88e472581f28cddc3";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A stamp body byte-shaped like the real writer's (install-gitnexus-plus.sh:
 * installedCliVersion, expectedCliVersion, indexedAt ISO-8601 UTC, indexedHead
 * 40-hex) with a controlled `indexedAt`. */
function stampJson(indexedAt: string): string {
  return `${JSON.stringify(
    {
      installedCliVersion: "1.6.12",
      expectedCliVersion: "1.6.12",
      indexedAt,
      indexedHead: HEAD,
    },
    null,
    2,
  )}\n`;
}

/** `h` hours ago as ISO-8601 UTC (negative h = the future — clock-skew arm). */
function hoursAgoIso(h: number): string {
  return new Date(Date.now() - h * HOUR_MS).toISOString();
}

/** Create a temp fixture dir holding `stampContent` at cli-version.json
 * (null = NO stamp file: the absent arm), run `fn`, then rmSync in finally. */
function withFixture<T>(stampContent: string | null, fn: (dir: string, stampPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "a6-staleness-"));
  try {
    const stampPath = join(dir, STAMP_FILE);
    if (stampContent !== null) writeFileSync(stampPath, stampContent);
    return fn(dir, stampPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── spawn + assertion helpers ───────────────────────────────────────────────

/** Parent env, always with QDS_GITNEXUS_HOME explicitly controlled: set to
 * `home`, or DELETED when undefined (a value leaking from the operator shell
 * must never redirect a fixture case — and case 10 needs the var gone). */
function envWithHome(home: string | undefined): NodeJS.ProcessEnv {
  const { QDS_GITNEXUS_HOME: _omitted, ...rest } = process.env;
  return home === undefined ? rest : { ...rest, QDS_GITNEXUS_HOME: home };
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runScript(env: NodeJS.ProcessEnv, args: string[] = []): RunResult {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { exitCode: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

interface VerdictJson {
  verdict: string;
  ageHours: number | null;
  ceilingHours: number;
  stampPath: string;
}

/** Assert the I1 output contract — exactly ONE newline-terminated JSON line
 * on stdout with the FIXED key order — and return the parsed verdict. */
function parseSingleLineJson(stdout: string): VerdictJson {
  expect(stdout.endsWith("\n")).toBe(true);
  const lines = stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!) as VerdictJson;
  expect(Object.keys(parsed)).toEqual(["verdict", "ageHours", "ceilingHours", "stampPath"]);
  return parsed;
}

// ── AC2 verdict cases ───────────────────────────────────────────────────────

describe("A6 staleness check (scripts/gitnexus-staleness.ts)", () => {
  it("AC2 happy path: a stamp indexed now reads fresh — exit 0, 0 ≤ ageHours ≤ ceiling", () => {
    withFixture(stampJson(hoursAgoIso(0)), (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      const json = parseSingleLineJson(r.stdout);
      expect(r.exitCode).toBe(0);
      expect(json.verdict).toBe("fresh");
      expect(typeof json.ageHours).toBe("number");
      expect(json.ageHours).toBeGreaterThanOrEqual(0);
      expect(json.ageHours).toBeLessThanOrEqual(CEILING_HOURS);
      expect(json.ceilingHours).toBe(CEILING_HOURS);
      expect(json.stampPath).toBe(stampPath);
    });
  });

  it("AC2 negative control (mutated positive): a 9h-old stamp exits 1 — verdict stale naming age, ceiling, stamp path", () => {
    withFixture(stampJson(hoursAgoIso(9)), (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      expect(r.exitCode).toBe(1);
      const json = parseSingleLineJson(r.stdout);
      expect(json.verdict).toBe("stale");
      // The named age is the real measured age (≈9h), not a constant.
      expect(json.ageHours).toBeGreaterThan(8.5);
      expect(json.ageHours).toBeLessThan(9.5);
      expect(json.ceilingHours).toBe(CEILING_HOURS);
      // The alarm names THIS fixture's stamp path — the naming half of AC2.
      expect(json.stampPath).toBe(stampPath);
    });
  });

  // Boundary note (measured, not pedantic): a literal exactly-8h-ago stamp is
  // PAST the ceiling by the time a separate process reads it — the reading
  // clock is strictly later than the fixture-writing clock by at least one
  // spawn. The boundary is therefore bracketed from both sides with margins
  // (−60s / +120s) that dwarf spawn jitter (tens of ms) yet stay unambiguous.
  it("NFR-OBS-5 boundary, inside: a stamp 60s inside the 8h ceiling reads fresh — exit 0", () => {
    withFixture(stampJson(hoursAgoIso(CEILING_HOURS - 1 / 60)), (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      expect(r.exitCode).toBe(0);
      const json = parseSingleLineJson(r.stdout);
      expect(json.verdict).toBe("fresh");
      expect(json.ageHours).toBeLessThanOrEqual(CEILING_HOURS);
      expect(json.stampPath).toBe(stampPath);
    });
  });

  it("NFR-OBS-5 boundary, past: a stamp 2min past the 8h ceiling reads stale — exit 1", () => {
    withFixture(stampJson(hoursAgoIso(CEILING_HOURS + 2 / 60)), (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      expect(r.exitCode).toBe(1);
      const json = parseSingleLineJson(r.stdout);
      expect(json.verdict).toBe("stale");
      expect(json.ageHours).toBeGreaterThan(CEILING_HOURS);
      expect(json.stampPath).toBe(stampPath);
    });
  });

  it("INV-A6-2 negative control: a missing stamp reads absent with ageHours null — never age 0", () => {
    withFixture(null, (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      expect(r.exitCode).toBe(2);
      const json = parseSingleLineJson(r.stdout);
      expect(json.verdict).toBe("absent");
      // The whole point of INV-A6-2: a wiped .gitnexus reads as UNKNOWN.
      // Both assertions name the failure the mutated positive exists to catch
      // ("missing stamp treated as age 0" fails here by construction).
      expect(json.ageHours).toBeNull();
      expect(json.ageHours).not.toBe(0);
      expect(json.ceilingHours).toBe(CEILING_HOURS);
      expect(json.stampPath).toBe(stampPath);
    });
  });

  it("INV-A6-2: an unparseable stamp reads invalid — exit 2, ageHours null", () => {
    withFixture("{ not json at all\n", (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      expect(r.exitCode).toBe(2);
      const json = parseSingleLineJson(r.stdout);
      expect(json.verdict).toBe("invalid");
      expect(json.ageHours).toBeNull();
      expect(json.stampPath).toBe(stampPath);
    });
  });

  it("INV-A6-2: a non-ISO indexedAt reads invalid — exit 2, ageHours null", () => {
    withFixture(stampJson("not-a-timestamp"), (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      expect(r.exitCode).toBe(2);
      const json = parseSingleLineJson(r.stdout);
      expect(json.verdict).toBe("invalid");
      expect(json.ageHours).toBeNull();
      expect(json.stampPath).toBe(stampPath);
    });
  });

  it("INV-A6-2: a non-string or missing indexedAt reads invalid — exit 2, ageHours null", () => {
    // numeric indexedAt — typeof must be checked BEFORE any parse attempt, so
    // this arm catches an implementation that skips the guard.
    const numeric = `${JSON.stringify(
      { installedCliVersion: "1.6.12", expectedCliVersion: "1.6.12", indexedAt: 42, indexedHead: HEAD },
      null,
      2,
    )}\n`;
    expect(numeric).toContain('"indexedAt": 42'); // a NUMBER, not the string "42" (Date.parse("42") coerces to a year)
    withFixture(numeric, (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      expect(r.exitCode).toBe(2);
      const json = parseSingleLineJson(r.stdout);
      expect(json.verdict).toBe("invalid");
      expect(json.ageHours).toBeNull();
      expect(json.stampPath).toBe(stampPath);
    });

    // indexedAt key absent entirely — the invalid arm, not absent (the FILE
    // exists; its content is unusable).
    const missingKey = `{"installedCliVersion":"1.6.12","expectedCliVersion":"1.6.12","indexedHead":"${HEAD}"}\n`;
    withFixture(missingKey, (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      expect(r.exitCode).toBe(2);
      const json = parseSingleLineJson(r.stdout);
      expect(json.verdict).toBe("invalid");
      expect(json.ageHours).toBeNull();
      expect(json.stampPath).toBe(stampPath);
    });
  });

  it("AC2 clock skew: a stamp indexed 1h in the FUTURE reads fresh — exit 0, negative age", () => {
    withFixture(stampJson(hoursAgoIso(-1)), (dir, stampPath) => {
      const r = runScript(envWithHome(dir));
      expect(r.exitCode).toBe(0);
      const json = parseSingleLineJson(r.stdout);
      expect(json.verdict).toBe("fresh");
      expect(json.ageHours).toBeLessThan(0);
      expect(json.stampPath).toBe(stampPath);
    });
  });

  it("I1 usage contract: argv beyond the script path exits 2 with NO stdout JSON", () => {
    withFixture(stampJson(hoursAgoIso(0)), (dir) => {
      const r = runScript(envWithHome(dir), ["--json"]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/usage/i);
    });
  });

  it("I1 portability: a trailing-slash QDS_GITNEXUS_HOME resolves to the same absolute stampPath", () => {
    withFixture(stampJson(hoursAgoIso(0)), (dir, stampPath) => {
      const r = runScript(envWithHome(`${dir}/`));
      expect(r.exitCode).toBe(0); // same stamp, same verdict — only the spelling differed
      const json = parseSingleLineJson(r.stdout);
      expect(json.stampPath).toBe(stampPath);
      expect(json.verdict).toBe("fresh");
    });
  });
});

// ── default-home resolution (live-stamp dependent → skippable) ──────────────

const DEFAULT_STAMP = join(REPO_ROOT, ".gitnexus", STAMP_FILE);
// Named skip reason (house preflight pattern, harness.ts preflightOrWarn):
// environmental gap only — the live stamp is tool-written and may legitimately
// not exist on a fresh clone.
const DEFAULT_HOME_SKIP_REASON =
  `default-home resolution needs the live stamp ${DEFAULT_STAMP} — run \`bash scripts/install-gitnexus-plus.sh\` from the repo root to create it`;

describe.skipIf(!existsSync(DEFAULT_STAMP))(
  `I1: QDS_GITNEXUS_HOME unset reads <repoRoot>/.gitnexus/cli-version.json (skipped: ${DEFAULT_HOME_SKIP_REASON})`,
  () => {
    it("stampPath names the repo-root stamp — the default home, not the git-less fallback", () => {
      const r = runScript(envWithHome(undefined));
      // Only path resolution is under test here: the live stamp's age is
      // whatever the wall clock says (fresh or stale both fine), and the
      // verdict fields are covered by the fixture cases above.
      const json = parseSingleLineJson(r.stdout);
      expect(json.stampPath).toBe(DEFAULT_STAMP);
    });

    it("F-017: a SET-BUT-EMPTY QDS_GITNEXUS_HOME counts as unset — default home, never <cwd>/cli-version.json", () => {
      // An empty path can never name a stamp dir; letting it through would
      // resolve against the cron's cwd ($HOME) — the masquerade F-017 refuses.
      const r = runScript(envWithHome(""));
      const json = parseSingleLineJson(r.stdout);
      expect(json.stampPath).toBe(DEFAULT_STAMP);
    });
  },
);
