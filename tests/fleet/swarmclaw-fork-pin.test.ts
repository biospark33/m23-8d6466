/**
 * The fork-rev DRIFT ALARM suite (Z1 AC6/AC7) — provenance-scoped, not blind
 * pin-equality.
 *
 * `validateEvidenceForkRevs` is the alarm: a stamped evidence rev is judged
 * against `SWARMCLAW_FORK_REV` only when its manifest row's citing.timestamp
 * is post-pin (`>= SWARMCLAW_FORK_REV_PINNED_AT`, ISO-Z string compare,
 * inclusive at the pin); a pre-pin stamped rev must equal its OWN manifest
 * row's rev, so legitimate older revisions pass. This suite proves the real
 * corpus stays green and every failure mode fires with the file and BOTH
 * revisions named — the drift report must be actionable without re-deriving
 * provenance (same discipline as the gitnexus cli-contract alarm).
 *
 * Scenario coverage (z1-r1 re-pin of the hardened validator):
 * - meta coherence: every fixture manifest carries pinRev/pinnedAt agreeing
 *   with the exports; missing or disagreeing meta fails
 * - corrupt evidence JSON fails loud (never a silent unstamped skip)
 * - unreadable manifest / rounds non-array / bad pinnedAt: exactly ONE
 *   failure, full stop (no N+1 coverage spam)
 * - missing stamped subdir is a failure; missing evidenceDir THROWS
 * - pre-pin row missing rev, duplicate rows, ghost rows, non-string stamps
 *   each fire exactly one named failure
 * - row keys are exact subdir-relative paths (no basename collision across
 *   round subdirs); uppercase .JSON is walked; the manifest filename is
 *   excluded only at the stamped dir's top level
 * - production invocation shape: one drift fixture stages the manifest
 *   INSIDE the stamped dir, exactly as the real corpus does
 * - AC7 negative control (F-012): a source-lint test fails loud if
 *   sc2-harness writeEvidence stops stamping swarmclawForkRev — linted on
 *   COMMENT-STRIPPED source (R2-12), and the writer's guard throws and
 *   exclusive 'wx' write are asserted present (R2-13)
 *
 * z1-r2 re-pin (fx2-validator hardening), each with a named fixture:
 * impossible-but-parseable pinnedAt rollover; the new F-004 citing-instant
 * failure naming the value (R2-15); empty / duplicate / multi stampedDirs
 * gates in gate order (pinnedAt → stampedDirs → evidenceDir stat → manifest
 * read); null/non-object manifest; evidenceDir-is-a-file throw; same-named
 * manifest decoys now walked (exclusion by resolved path, not name);
 * symlinked evidence entries; post-pin row rev rules incl. the
 * both-failures case (R2-01); 1+N ghost suppression under a missing dir;
 * real-manifest rows timestamp-validated before the newest-row computation
 * (R2-11)
 *
 * INV-Z1-1 boundary: this suite imports metadata about the fork
 * (scripts/swarmclaw-fork-pin.ts) and NOTHING from src/ or the fork itself.
 * All fixtures are staged in mkdtemp tmp dirs — `_bmad-output/` is read-only
 * here (the F-012 source-lint test READS the harness file with fs).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  STAMPED_EVIDENCE_DIRS,
  SWARMCLAW_FORK_REV,
  SWARMCLAW_FORK_REV_PINNED_AT,
  validateEvidenceForkRevs,
} from "../../scripts/swarmclaw-fork-pin.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const REAL_EVIDENCE_DIR = join(REPO_ROOT, "_bmad-output", "evidence");
const REAL_MANIFEST_PATH = join(
  REAL_EVIDENCE_DIR,
  "openrig-sc2",
  "fork-rev-manifest.json",
);
const HARNESS_PATH = join(REPO_ROOT, "tests", "fleet", "e2e", "sc2-harness.ts");

// fixture revs are 40-hex placeholders, all distinct so a report naming the
// wrong one fails the assertion instead of passing by coincidence
const PIN = SWARMCLAW_FORK_REV;
const WRONG_REV = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const ROW_REV = "cafebabecafebabecafebabecafebabecafebabe";
const PRE_PIN_TS = "2026-09-01T00:00:00Z";

type ManifestRow = {
  file: string;
  rev?: string;
  citing: { timestamp: string };
};

let stagedRoots: string[] = [];

afterEach(() => {
  for (const root of stagedRoots) rmSync(root, { recursive: true, force: true });
  stagedRoots = [];
});

/**
 * The manifest is the record: fixtures default to meta agreeing with the
 * exported pin values. Pass `meta` (even undefined) to override — undefined
 * omits the key entirely.
 */
function withMeta(rounds: ManifestRow[], meta?: unknown) {
  return {
    meta: meta === undefined ? { pinRev: PIN, pinnedAt: SWARMCLAW_FORK_REV_PINNED_AT } : meta,
    rounds,
  };
}

/**
 * Stage a throwaway corpus: evidence/<stampedDir>/<files> plus the manifest
 * alongside it (NOT the production layout — the production-layout test stages
 * its own manifest inside the stamped dir). File values are JSON-stringified;
 * a string value lands verbatim (for corrupt-JSON fixtures). Returns opts
 * ready for validateEvidenceForkRevs with the real exported pin values.
 */
function stageFixture(files: Record<string, unknown>, rounds: ManifestRow[], meta?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "fork-pin-alarm-"));
  stagedRoots.push(root);
  const evidenceDir = join(root, "evidence");
  const stamped = STAMPED_EVIDENCE_DIRS[0];
  if (stamped === undefined) {
    throw new Error("STAMPED_EVIDENCE_DIRS is empty — the fixture cannot stage a stamped dir");
  }
  const stampedDir = join(evidenceDir, stamped);
  mkdirSync(stampedDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = join(stampedDir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
  }
  const manifestPath = join(root, "fork-rev-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(withMeta(rounds, meta)));
  return { root, evidenceDir, stampedDir, manifestPath };
}

/** Run the alarm exactly as production does: exported pin values, stamped dirs. */
function runAlarm(evidenceDir: string, manifestPath: string) {
  return validateEvidenceForkRevs({
    evidenceDir,
    manifestPath,
    pin: PIN,
    pinnedAt: SWARMCLAW_FORK_REV_PINNED_AT,
    stampedDirs: STAMPED_EVIDENCE_DIRS,
  });
}

/** Run the alarm with a caller-chosen stampedDirs list (gate fixtures only). */
function runAlarmWith(stampedDirs: readonly string[], evidenceDir: string, manifestPath: string) {
  return validateEvidenceForkRevs({
    evidenceDir,
    manifestPath,
    pin: PIN,
    pinnedAt: SWARMCLAW_FORK_REV_PINNED_AT,
    stampedDirs,
  });
}

// the validator's real-instant rule, mirrored for R2-11 (the rule under test
// is the validator's, so the mirror must stay identical to it)
const ISO_Z_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function isRealInstant(input: string): boolean {
  const parsed = new Date(input);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().replace(/\.000Z$/, "Z") === input
  );
}

/**
 * Remove // line and /* block comments, leaving string/template contents
 * byte-intact — the F-012 lint must not match a stamp literal inside a
 * comment (R2-12). Regex literals in the harness (only `/[:.]/g`) contain no
 * quote or `//` and pass through untouched.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1] ?? "";
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue; // the newline itself is copied next iteration
    }
    if (c === "/" && next === "*") {
      i += 2;
      let closed = false;
      while (i < src.length) {
        if (src[i] === "*" && src[i + 1] === "/") {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      out += " "; // block comment collapses to one space, never joins tokens
      if (!closed) break;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      out += src[i] ?? ""; // closing quote (or EOF)
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

describe("swarmclaw fork-rev drift alarm", () => {
  test("the real openrig-sc2 corpus validates green against the exported pin values", () => {
    // the alarm's live run over the actual corpus in CI: meta coherence is now
    // enforced by the validator itself, every real row pre-dates the pin, and
    // no evidence file carries a swarmclawForkRev stamp yet (AC7 arms with the
    // first post-pin round) — ok:true keeps the alarm honest against reality
    const result = runAlarm(REAL_EVIDENCE_DIR, REAL_MANIFEST_PATH);
    expect(result).toEqual({ ok: true });
  });

  test("a post-pin stamped rev that drifted from the pin fails and names the file and both revisions", () => {
    // row.rev equals the pin (R2-01: a coherent post-pin row records the
    // pin), so the EVIDENCE drift is the sole failure — and the expected
    // value naming the pin proves the post-pin branch was taken
    const name = "2026-10-02T16-00-00-000Z-sc2-drift.json";
    const { evidenceDir, manifestPath } = stageFixture(
      { [name]: { swarmclawForkRev: WRONG_REV } },
      [{ file: name, rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
    );
    const result = runAlarm(evidenceDir, manifestPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const line = result.failures.find((f) => f.includes(name));
    expect(line).toBeDefined();
    expect(line).toContain(`evidence=${WRONG_REV}`);
    expect(line).toContain(`expected=${PIN}`);
    expect(line).toContain("post-pin pin");
    expect(line).not.toContain(`expected=${ROW_REV}`);
  });

  test("a pre-pin stamped rev that disagrees with its own manifest row fails and names the file and both revisions", () => {
    const name = "2026-09-01T12-00-00-000Z-sc2-prepin-drift.json";
    const { evidenceDir, manifestPath } = stageFixture(
      { [name]: { swarmclawForkRev: WRONG_REV } },
      [{ file: name, rev: ROW_REV, citing: { timestamp: PRE_PIN_TS } }],
    );
    const result = runAlarm(evidenceDir, manifestPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const line = result.failures.find((f) => f.includes(name));
    expect(line).toBeDefined();
    expect(line).toContain(`evidence=${WRONG_REV}`);
    expect(line).toContain(`expected=${ROW_REV}`);
    expect(line).toContain("pre-pin manifest row");
  });

  test("a legitimate pre-pin rev that matches its manifest row passes — older revisions are not pin violations", () => {
    const name = "2026-09-01T12-00-00-000Z-sc2-prepin-legacy.json";
    const { evidenceDir, manifestPath } = stageFixture(
      { [name]: { swarmclawForkRev: ROW_REV } },
      [{ file: name, rev: ROW_REV, citing: { timestamp: PRE_PIN_TS } }],
    );
    expect(runAlarm(evidenceDir, manifestPath)).toEqual({ ok: true });
  });

  test("a stamped evidence file with no manifest row is a coverage finding telling the author to source its rev, not a drift verdict", () => {
    const name = "2026-10-02T17-00-00-000Z-sc2-unmapped.json";
    const { evidenceDir, manifestPath } = stageFixture(
      { [name]: { swarmclawForkRev: PIN } },
      [], // manifest empty: the stamped file has nowhere to be bracketed
    );
    const result = runAlarm(evidenceDir, manifestPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toBe(
      `unmapped evidence file openrig-sc2/${name}: add its rev from round provenance — never guess`,
    );
  });

  test("a stamp claiming post-pin inside the evidence file cannot save a wrong rev — only the manifest row timestamp brackets", () => {
    const name = "comment-cannot-save-sc2.json";
    const { evidenceDir, manifestPath } = stageFixture(
      {
        [name]: {
          swarmclawForkRev: WRONG_REV,
          // the file's self-description is ignored: bracketing is
          // machine-derived from the manifest row, never read from the stamp
          provenance: `post-pin as of ${SWARMCLAW_FORK_REV_PINNED_AT} — rev matches the pin`,
        },
      },
      [{ file: name, rev: ROW_REV, citing: { timestamp: PRE_PIN_TS } }],
    );
    const result = runAlarm(evidenceDir, manifestPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const line = result.failures.find((f) => f.includes(name));
    expect(line).toBeDefined();
    expect(line).toContain(`evidence=${WRONG_REV}`);
    expect(line).toContain(`expected=${ROW_REV}`);
  });

  test("evidence files without a swarmclawForkRev stamp are ignored even when manifest rows exist", () => {
    const { evidenceDir, manifestPath } = stageFixture(
      {
        "unstamped-a.json": { run: "sc2", ok: true },
        "unstamped-b.json": { nested: { deep: [{ noRevHere: true }] } },
      },
      [{ file: "unstamped-a.json", rev: ROW_REV, citing: { timestamp: PRE_PIN_TS } }],
    );
    expect(runAlarm(evidenceDir, manifestPath)).toEqual({ ok: true });
  });

  test("a row stamped exactly at the pin instant is post-pin and passes when its rev equals the pin", () => {
    const name = "boundary-inclusive-sc2.json";
    const { evidenceDir, manifestPath } = stageFixture(
      { [name]: { swarmclawForkRev: PIN } },
      [{ file: name, rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
    );
    expect(runAlarm(evidenceDir, manifestPath)).toEqual({ ok: true });
  });

  describe("manifest record coherence (F-013)", () => {
    test("a manifest without meta fails — pinRev/pinnedAt coherence is part of the record", () => {
      const { evidenceDir, manifestPath } = stageFixture(
        { "a.json": { swarmclawForkRev: PIN } },
        [],
      );
      writeFileSync(manifestPath, JSON.stringify({ rounds: [
        { file: "a.json", rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } },
      ] }));
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("manifest meta missing");
    });

    test("a manifest whose meta disagrees with the exported pin fails naming both values", () => {
      const { evidenceDir, manifestPath } = stageFixture(
        { "a.json": { swarmclawForkRev: PIN } },
        [{ file: "a.json", rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
        { pinRev: WRONG_REV, pinnedAt: SWARMCLAW_FORK_REV_PINNED_AT },
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const line = result.failures.find((f) => f.includes("pinRev"));
      expect(line).toBeDefined();
      expect(line).toContain(`"${WRONG_REV}"`);
      expect(line).toContain(PIN);
    });

    test("a manifest whose meta pinnedAt disagrees with the exported pin instant fails", () => {
      const { evidenceDir, manifestPath } = stageFixture(
        { "a.json": { swarmclawForkRev: PIN } },
        [{ file: "a.json", rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
        { pinRev: PIN, pinnedAt: PRE_PIN_TS },
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const line = result.failures.find((f) => f.includes("pinnedAt"));
      expect(line).toBeDefined();
      expect(line).toContain(PRE_PIN_TS);
      expect(line).toContain(SWARMCLAW_FORK_REV_PINNED_AT);
    });
  });

  describe("fail-loud malformations (one failure, full stop)", () => {
    test("an unreadable manifest returns exactly one failure — no N+1 coverage spam", () => {
      const { evidenceDir, manifestPath } = stageFixture(
        { "stamped.json": { swarmclawForkRev: PIN } },
        [{ file: "stamped.json", rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
      );
      writeFileSync(manifestPath, "{not json at all");
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("fork-rev manifest unreadable");
      expect(result.failures[0]).toContain(manifestPath);
    });

    test("a manifest whose rounds is not an array returns exactly one failure", () => {
      const { evidenceDir, manifestPath } = stageFixture({}, []);
      writeFileSync(manifestPath, JSON.stringify({
        meta: { pinRev: PIN, pinnedAt: SWARMCLAW_FORK_REV_PINNED_AT },
        rounds: "not-an-array",
      }));
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("rounds missing or not an array");
    });

    test("a non-ISO-Z or impossible pinnedAt returns exactly one failure naming the value", () => {
      // three rejection shapes pinned: not a timestamp at all; ISO-Z shape
      // but out of range (Date.parse NaN); and the z1-r2 rollover —
      // 2026-02-30 parses to Mar 2, so only the re-serialization roundtrip
      // catches it (R2-03)
      const { evidenceDir, manifestPath } = stageFixture({}, []);
      for (const bad of ["not-a-timestamp", "2026-13-45T99:99:99Z", "2026-02-30T00:00:00Z"]) {
        const result = validateEvidenceForkRevs({
          evidenceDir,
          manifestPath,
          pin: PIN,
          pinnedAt: bad,
          stampedDirs: STAMPED_EVIDENCE_DIRS,
        });
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toContain(`"${bad}"`);
        expect(result.failures[0]).toContain("not a real ISO-Z instant");
      }
    });

    test("an unreadable evidence file fails loud instead of counting as unstamped", () => {
      const name = "corrupt-evidence.json";
      const { evidenceDir, manifestPath } = stageFixture({ [name]: "{not json" }, []);
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(`unreadable evidence file openrig-sc2/${name}`);
      expect(result.failures[0]).toContain("never skips silently");
    });

    test("a pre-pin row with no rev is a malformed row, not an expected=undefined compare", () => {
      const name = "2026-09-01T12-00-00-000Z-sc2-revless.json";
      const { evidenceDir, manifestPath } = stageFixture(
        { [name]: { swarmclawForkRev: WRONG_REV } },
        [{ file: name, citing: { timestamp: PRE_PIN_TS } }],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(`malformed manifest row for openrig-sc2/${name}`);
      expect(result.failures[0]).toContain("rev missing");
      expect(result.failures.join("\n")).not.toContain("expected=undefined");
    });

    test("duplicate manifest rows for the same file fail naming the file and both indexes", () => {
      const name = "duplicated-row-sc2.json";
      const row = { file: name, rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } };
      const { evidenceDir, manifestPath } = stageFixture(
        { [name]: { swarmclawForkRev: PIN } },
        [row, { ...row }],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(`duplicate manifest rows for ${name}`);
      expect(result.failures[0]).toContain("indexes 0, 1");
    });

    test("a manifest row naming no walked evidence file fails (ghost row)", () => {
      const { evidenceDir, manifestPath } = stageFixture(
        {},
        [{ file: "ghost.json", rev: PIN, citing: { timestamp: PRE_PIN_TS } }],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toBe("manifest row ghost.json has no evidence file (F-009)");
    });

    test("a non-string swarmclawForkRev value fails instead of escaping the alarm", () => {
      const name = "structured-stamp-sc2.json";
      const { evidenceDir, manifestPath } = stageFixture({ [name]: { swarmclawForkRev: 42 } }, []);
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(`stamp at openrig-sc2/${name} is not a string`);
    });
  });

  describe("invocation and layout", () => {
    test("a missing stamped subdir under an existing evidence dir is a failure, not silent inertness", () => {
      const root = mkdtempSync(join(tmpdir(), "fork-pin-alarm-"));
      stagedRoots.push(root);
      const evidenceDir = join(root, "evidence");
      mkdirSync(evidenceDir);
      const manifestPath = join(evidenceDir, "fork-rev-manifest.json");
      writeFileSync(manifestPath, JSON.stringify(withMeta([])));
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("stamped dir openrig-sc2 missing");
    });

    test("an absent evidence dir THROWS — a misconfigured invocation is never green silence", () => {
      const { evidenceDir, manifestPath } = stageFixture({}, []);
      const absent = join(evidenceDir, "does-not-exist");
      expect(() => runAlarm(absent, manifestPath)).toThrow(/evidence dir .*does not exist/);
    });

    test("row keys are exact subdir-relative paths — the same basename in two round subdirs never collides", () => {
      const { evidenceDir, manifestPath } = stageFixture(
        {
          "r1/result.json": { swarmclawForkRev: PIN },
          "r2/result.json": { swarmclawForkRev: ROW_REV },
        },
        [
          { file: "r1/result.json", rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } },
          { file: "r2/result.json", rev: ROW_REV, citing: { timestamp: PRE_PIN_TS } },
        ],
      );
      expect(runAlarm(evidenceDir, manifestPath)).toEqual({ ok: true });
    });

    test("uppercase .JSON files are walked and same-named decoys are evidence — exclusion is by resolved path, not name", () => {
      // STAMPED.JSON must be walked (else its row goes ghost); the SUBDIR
      // fork-rev-manifest.json must be treated as evidence (else its drift
      // never fires) — exactly one failure proves both directions at once.
      // z1-r2: exclusion was narrowed from filename to resolved path, so this
      // decoy is walked wherever it sits.
      const { evidenceDir, manifestPath } = stageFixture(
        {
          "STAMPED.JSON": { swarmclawForkRev: PIN },
          "rounds/fork-rev-manifest.json": { swarmclawForkRev: WRONG_REV },
        },
        [
          { file: "STAMPED.JSON", rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } },
          {
            file: "rounds/fork-rev-manifest.json",
            rev: PIN,
            citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT },
          },
        ],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("rounds/fork-rev-manifest.json");
      expect(result.failures[0]).toContain(`evidence=${WRONG_REV}`);
      expect(result.failures[0]).toContain(`expected=${PIN}`);
    });

    test("production invocation shape: manifest INSIDE the stamped dir still walks evidence and catches drift", () => {
      // exact production layout — _bmad-output/evidence/openrig-sc2/ holds the
      // manifest beside the evidence JSONs; the top-level manifest filename is
      // excluded from the walk while rows match by stamped-dir-relative keys
      const name = "2026-10-02T18-00-00-000Z-sc2-prod-drift.json";
      const { evidenceDir, stampedDir } = stageFixture(
        { [name]: { swarmclawForkRev: WRONG_REV } },
        [],
      );
      const manifestPath = join(stampedDir, "fork-rev-manifest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify(withMeta([
          { file: name, rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } },
        ])),
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(`fork-rev drift in openrig-sc2/${name}`);
      expect(result.failures[0]).toContain(`evidence=${WRONG_REV}`);
      expect(result.failures[0]).toContain(`expected=${PIN}`);
    });
  });

  describe("validator gates (z1-r2 re-pin of fx2-validator hardening)", () => {
    test("an empty stampedDirs list fails instead of passing vacuously", () => {
      const { evidenceDir, manifestPath } = stageFixture({}, []);
      const result = runAlarmWith([], evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toEqual([
        "no stamped dirs — the alarm would pass vacuously",
      ]);
    });

    test("duplicate stampedDirs entries fail naming the repeated dir — the specific gate, not Z3", () => {
      const { evidenceDir, manifestPath } = stageFixture({}, []);
      const result = runAlarmWith(
        ["openrig-sc2", "openrig-sc2"],
        evidenceDir,
        manifestPath,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toEqual([
        "duplicate stamped dir openrig-sc2 — it would be validated twice",
      ]);
    });

    test("multi-dir stampedDirs hit the Z3 gate before the evidenceDir stat — one line, no throw", () => {
      // gate ORDER (z1-r2 change 5): pinnedAt → stampedDirs gates → stat →
      // manifest read, so even an absent evidenceDir cannot preempt Z3 with
      // a misconfiguration throw
      const root = mkdtempSync(join(tmpdir(), "fork-pin-alarm-"));
      stagedRoots.push(root);
      const manifestPath = join(root, "fork-rev-manifest.json");
      writeFileSync(manifestPath, JSON.stringify(withMeta([])));
      const result = runAlarmWith(
        ["openrig-sc2", "second-dir"],
        join(root, "evidence-never-created"),
        manifestPath,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toEqual([
        "multi-dir stampedDirs need dir-qualified manifest row keys — extend the manifest format deliberately (Z3)",
      ]);
    });

    test("a shape-valid impossible citing.timestamp fails the F-004 branch naming the value (R2-15)", () => {
      // 2026-02-30 passes the ISO-Z shape and Date.parse, but Feb 30 does not
      // exist — only the roundtrip catches it; the evidence file is stamped
      // with the pin itself so this failure is the row's, not the stamp's
      const IMPOSSIBLE = "2026-02-30T12:00:00Z";
      const name = "2026-10-02T20-00-00-000Z-sc2-impossible-citing.json";
      const { evidenceDir, manifestPath } = stageFixture(
        { [name]: { swarmclawForkRev: PIN } },
        [{ file: name, rev: PIN, citing: { timestamp: IMPOSSIBLE } }],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toEqual([
        `citing.timestamp "${IMPOSSIBLE}" is not a real instant for openrig-sc2/${name} (F-004)`,
      ]);
    });

    test("a manifest whose root JSON is null or a bare string fails structured, not TypeError", () => {
      const { evidenceDir, manifestPath } = stageFixture(
        { "stamped.json": { swarmclawForkRev: PIN } },
        [{ file: "stamped.json", rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
      );
      for (const bad of ["null", '"just a string"']) {
        writeFileSync(manifestPath, bad);
        const result = runAlarm(evidenceDir, manifestPath);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toBe(
          `fork-rev manifest malformed at ${manifestPath}: not a JSON object — no row can be validated`,
        );
      }
    });

    test("an evidenceDir that is a regular file THROWS — ENOTDIR must not read as a missing corpus", () => {
      const { root, manifestPath } = stageFixture({}, []);
      const asFile = join(root, "evidence-is-a-file.json");
      writeFileSync(asFile, "{}");
      expect(() => runAlarm(asFile, manifestPath)).toThrow(
        `evidence dir ${asFile} is not a directory`,
      );
    });

    test("a same-named decoy file inside the stamped dir is walked as evidence — unparseable decoy fails loud (F-001)", () => {
      // z1-r2 change 8: the name-based exclusion is gone; only the manifest
      // arg's resolved path is skipped, so this top-level decoy is walked —
      // and being unparseable it must fail loud, never count as unstamped
      const name = "2026-10-02T19-00-00-000Z-sc2-real.json";
      const { evidenceDir, stampedDir, manifestPath } = stageFixture(
        { [name]: { swarmclawForkRev: PIN } },
        [{ file: name, rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
      );
      writeFileSync(join(stampedDir, "fork-rev-manifest.json"), "{decoy, not json");
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // exactly one: the decoy's F-001 line — the real row matched and no
      // ghost fired, proving the decoy did not shadow the walk
      expect(result.failures).toEqual([
        "unreadable evidence file openrig-sc2/fork-rev-manifest.json — cannot confirm it is unstamped; the alarm never skips silently (F-001)",
      ]);
    });

    test("a symlinked entry inside a stamped dir fails loud and is never followed", () => {
      const name = "2026-10-02T19-30-00-000Z-sc2-symlinked.json";
      const { evidenceDir, stampedDir, manifestPath } = stageFixture(
        { [name]: { swarmclawForkRev: PIN } },
        [{ file: name, rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
      );
      // dangling target: keeps the failure count at exactly one while proving
      // the walker never resolves through the link (loop risk)
      symlinkSync(join(stampedDir, "missing-target.json"), join(stampedDir, "link.json"));
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toEqual([
        "symlinked evidence path openrig-sc2/link.json is not walked — flatten the corpus",
      ]);
    });

    test("a post-pin row with no rev is malformed, naming the pin as the expected value (R2-01)", () => {
      const name = "2026-10-02T21-00-00-000Z-sc2-postpin-revless.json";
      const { evidenceDir, manifestPath } = stageFixture(
        { [name]: { swarmclawForkRev: PIN } },
        [{ file: name, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(
        `malformed manifest row for openrig-sc2/${name}`,
      );
      expect(result.failures[0]).toContain("rev missing");
      expect(result.failures[0]).toContain("post-pin expected value is the pin");
    });

    test("a post-pin row recording a rev other than the pin fails — the manifest is the record (R2-01)", () => {
      const name = "2026-10-02T21-30-00-000Z-sc2-postpin-rowrev.json";
      const { evidenceDir, manifestPath } = stageFixture(
        // evidence carries the pin, so this failure is purely the manifest's:
        // the drift check (expected=pin) is green and must not fire
        { [name]: { swarmclawForkRev: PIN } },
        [{ file: name, rev: ROW_REV, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toEqual([
        `post-pin manifest row for openrig-sc2/${name} records rev "${ROW_REV}" but the pin is ${PIN} — the manifest is the record`,
      ]);
    });

    test("a post-pin row with a wrong rev AND drifted evidence carries both failures — drift is never masked (R2-01)", () => {
      const name = "2026-10-02T22-00-00-000Z-sc2-postpin-both.json";
      const { evidenceDir, manifestPath } = stageFixture(
        { [name]: { swarmclawForkRev: WRONG_REV } },
        [{ file: name, rev: ROW_REV, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(2);
      expect(result.failures.some((f) =>
        f.startsWith(`post-pin manifest row for openrig-sc2/${name} records rev "${ROW_REV}"`),
      )).toBe(true);
      const drift = result.failures.find((f) => f.startsWith(`fork-rev drift in openrig-sc2/${name}`));
      expect(drift).toBeDefined();
      expect(drift).toContain(`evidence=${WRONG_REV}`);
      expect(drift).toContain(`expected=${PIN}`);
    });

    test("a missing stamped dir with N rows under it is exactly ONE failure — the ghost check defers (1+N suppression)", () => {
      const root = mkdtempSync(join(tmpdir(), "fork-pin-alarm-"));
      stagedRoots.push(root);
      const evidenceDir = join(root, "evidence");
      mkdirSync(evidenceDir);
      const manifestPath = join(evidenceDir, "fork-rev-manifest.json");
      // both rows name files under the absent stamped dir: they would read as
      // ghosts if the check ran anyway — the missing-dir line is the root cause
      writeFileSync(manifestPath, JSON.stringify(withMeta([
        { file: "r1/a.json", rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } },
        { file: "r2/b.json", rev: ROW_REV, citing: { timestamp: PRE_PIN_TS } },
      ])));
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("stamped dir openrig-sc2 missing");
      expect(result.failures.join("\n")).not.toContain("no evidence file");
    });

    // Round-2 review: the stamp scan fails CLOSED at its depth cap. A scan
    // that silently stopped at depth 10 would let a stamp nested deeper than
    // it pass validation unseen — the contract sets no nesting exception —
    // so the cap is a named validation failure, and one level BELOW the cap
    // must still validate normally (the guard is a floor, not a widening of
    // what the alarm refuses).
    test("a stamp nested past the scan cap fails validation by name, not silence (round-2)", () => {
      const name = "2026-10-02T23-00-00-000Z-sc2-postpin-toodeep.json";
      const wrap = (node: Record<string, unknown>, times: number): Record<string, unknown> => {
        let out = node;
        for (let i = 0; i < times; i++) out = { nested: out };
        return out;
      };
      const { evidenceDir, manifestPath } = stageFixture(
        { [name]: wrap({ swarmclawForkRev: PIN }, 10) },
        [{ file: name, rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures).toEqual([
        `evidence JSON openrig-sc2/${name} exceeds the supported stamp-scan depth`,
      ]);
    });

    test("a stamp at one level below the cap still validates — the cap is not a refusal window (round-2)", () => {
      const name = "2026-10-02T23-10-00-000Z-sc2-postpin-deep-ok.json";
      const wrap = (node: Record<string, unknown>, times: number): Record<string, unknown> => {
        let out = node;
        for (let i = 0; i < times; i++) out = { nested: out };
        return out;
      };
      const { evidenceDir, manifestPath } = stageFixture(
        { [name]: wrap({ swarmclawForkRev: PIN }, 9) },
        [{ file: name, rev: PIN, citing: { timestamp: SWARMCLAW_FORK_REV_PINNED_AT } }],
      );
      const result = runAlarm(evidenceDir, manifestPath);
      expect(result.ok).toBe(true);
    });
  });

  describe("authorship invariants (the exports themselves)", () => {
    test("pin constants are well-formed metadata and the real manifest record agrees (F-013)", () => {
      expect(PIN).toMatch(/^[0-9a-f]{40}$/);
      expect(SWARMCLAW_FORK_REV_PINNED_AT).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      const manifest = JSON.parse(readFileSync(REAL_MANIFEST_PATH, "utf8")) as {
        meta?: { pinRev?: string; pinnedAt?: string };
        rounds?: Array<{ file?: string; rev?: string; citing?: { timestamp?: string } }>;
      };
      // the manifest is the record: its meta must agree with the exported pin,
      // or the corpus and the pin have already drifted apart at authorship
      expect(manifest.meta?.pinRev).toBe(PIN);
      expect(manifest.meta?.pinnedAt).toBe(SWARMCLAW_FORK_REV_PINNED_AT);
      // and the pin is exactly the newest round's rev (AC4's equality target):
      // a pin bump without an evidence round behind it breaks here.
      // R2-11: garbage timestamps must not feed the newest-row reduce —
      // every row's citing.timestamp is validated (ISO-Z shape + real-instant
      // roundtrip) BEFORE the computation; a malformed one is a named failure
      const rows = manifest.rounds ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const ts = row.citing?.timestamp;
        if (typeof ts !== "string" || !ISO_Z_SHAPE.test(ts) || !isRealInstant(ts)) {
          throw new Error(
            `real manifest row ${JSON.stringify(row.file ?? "<no file>")} has citing.timestamp ${JSON.stringify(ts ?? null)} — not a real ISO-Z instant; the newest-row pin check is invalid until this row is fixed`,
          );
        }
      }
      const newest = rows.reduce((a, b) =>
        (b.citing?.timestamp ?? "") > (a.citing?.timestamp ?? "") ? b : a,
      );
      expect(newest.rev).toBe(PIN);
    });

    test("STAMPED_EVIDENCE_DIRS is exactly the openrig-sc2 corpus (F-018: reorder fails loud)", () => {
      expect([...STAMPED_EVIDENCE_DIRS]).toEqual(["openrig-sc2"]);
    });

    test("sc2-harness writeEvidence still stamps swarmclawForkRev — AC7's enforcing link (F-012)", () => {
      // R2-12: lint the COMMENT-STRIPPED source — a commented-out stamp
      // literal must not read as an armed stamp
      const stripped = stripComments(readFileSync(HARNESS_PATH, "utf8"));
      // the harness must import the pin module it stamps from
      expect(stripped).toContain("scripts/swarmclaw-fork-pin");
      const start = stripped.indexOf("export function writeEvidence");
      expect(start).toBeGreaterThanOrEqual(0);
      const nextExport = stripped.indexOf("\nexport ", start + 1);
      const body = nextExport === -1 ? stripped.slice(start) : stripped.slice(start, nextExport);
      if (!body.includes("swarmclawForkRev: SWARMCLAW_FORK_REV")) {
        throw new Error(
          "sc2-harness writeEvidence no longer stamps swarmclawForkRev — AC7's alarm arming is broken",
        );
      }
      // R2-13: the writer's guards are part of the stamping contract — a
      // throw that disappears would first surface as a live E2E failure
      // (behavioral tests would pollute the real corpus), so the lint pins
      // the guard code, not just its message
      const missing = ([
        ["plain-object guard", "evidence payload must be a plain object"],
        ["caller-stamp guard", '"swarmclawForkRev" in payload'],
        ["nested-stamp deep guard", "hasSwarmclawForkRevDeep(payload)"],
        ["exclusive 'wx' write", 'flag: "wx"'],
      ] as const).filter(([, needle]) => !body.includes(needle));
      if (missing.length > 0) {
        throw new Error(
          `sc2-harness writeEvidence guard contract broken — missing: ${missing.map(([label]) => label).join(", ")}`,
        );
      }
      // Round-2 review: the deep guard FAILS CLOSED at its cap — a scan that
      // silently returned false past depth 10 would let a caller-supplied
      // nested stamp land on disk and ride under the alarm's identically
      // capped scan. Pin the throw, not the absence of a return.
      const guardStart = stripped.indexOf("function hasSwarmclawForkRevDeep");
      expect(guardStart).toBeGreaterThanOrEqual(0);
      const guardBody = stripped.slice(guardStart, stripped.indexOf("\n}", guardStart));
      expect(guardBody).toContain('throw new Error("evidence payload exceeds the supported stamp-scan depth")');
    });
  });
});
