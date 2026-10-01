// DF5.5 KEEP-repoint regression test.
// Story: _bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-5-keep-repoint-chore.md
// Four assertions from §Infra Prerequisites (count-based retired-ID scan, per-pair
// correctness, marker set, yaml scan) plus the AC4 missing-successor halt and the
// W10E-2 provenance negative control. Repo root resolves from import.meta.dir —
// never process.cwd() (bun test does not guarantee CWD).

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dir, "..", "..");
const ARTIFACTS = path.join(ROOT, "_bmad-output", "sprint-artifacts");
const YAML = path.join(ARTIFACTS, "sprint-status.yaml");
const MARKER = "v5 amendment (DF5.5)";

// The 12 in-scope files (11 KEEP + P0.7 DONE-KEEP). p0-5 is in grep scope and is
// never amended — it must carry zero markers (it is absent from AMENDED below).
const IN_SCOPE = [
  "phase-1/stories/p1-2-qds-intake-issue.md",
  "phase-1/stories/p1-3-seeds-decompose-mirror.md",
  "phase-1/stories/p1-5-model-router-hindsight.md",
  "phase-1/stories/p1-7-lsp-diagnostics-gate.md",
  "phase-1/stories/p1-9-restart-policy.md",
  "phase-1/stories/p1-11-hindsight-prime-retain.md",
  "phase-1/stories/p1-12-mulch-prime-record.md",
  "phase-1/stories/p1-14-outcome-record-router.md",
  "phase-1/stories/p1-18-pr-comment-polling.md",
  "phase-0/stories/p0-5-pi-lens-headless-tdi.md",
  "phase-0/stories/p0-7-swarmclaw-agent-mcp-hindsight.md",
  "phase-0/stories/p0-9-hindsight-banks-mulch.md",
];

// The 11 amended files (marker set, sorted, ARTIFACTS-relative). p0-5 absent.
const AMENDED = [
  "phase-0/stories/p0-7-swarmclaw-agent-mcp-hindsight.md",
  "phase-0/stories/p0-9-hindsight-banks-mulch.md",
  "phase-1/stories/p1-11-hindsight-prime-retain.md",
  "phase-1/stories/p1-12-mulch-prime-record.md",
  "phase-1/stories/p1-14-outcome-record-router.md",
  "phase-1/stories/p1-18-pr-comment-polling.md",
  "phase-1/stories/p1-2-qds-intake-issue.md",
  "phase-1/stories/p1-3-seeds-decompose-mirror.md",
  "phase-1/stories/p1-5-model-router-hindsight.md",
  "phase-1/stories/p1-7-lsp-diagnostics-gate.md",
  "phase-1/stories/p1-9-restart-policy.md",
].sort();

// Binding successor map (story §Technical Notes; source R5 §2 + audit §2).
const SUCCESSOR: Record<string, string> = {
  "P1.1": "DF3.1",
  "P1.4": "DF1.1",
  "P1.6": "DF1.6",
  "P1.8": "DF1.8",
  "P1.10": "DF3.4",
  "P1.13": "DF2.8",
  "P1.15": "DF5.2",
  "P1.16": "DF5.3",
  "P1.17": "DF5.4",
  "P1.19": "DF6.1a",
};
const RETIRED_RE = /P1\.(1|4|6|8|10|13|15|16|17|19)\b/g;

// Provenance sites (story amendment A): these keep the old ID and gain a
// `(now DF<x>.<y>)` annotation — substituting them erases the record of which
// story owns the fact (the W10E-2 negative-control class).
const PROVENANCE_SITES: Array<{ file: string; anchor: string; retired: string; successor: string }> = [
  {
    file: "phase-0/stories/p0-7-swarmclaw-agent-mcp-hindsight.md",
    anchor: "requires both agentType and endpointUrl",
    retired: "P1.1",
    successor: "DF3.1",
  },
  {
    file: "phase-0/stories/p0-9-hindsight-banks-mulch.md",
    anchor: "distinct from P1.1",
    retired: "P1.1",
    successor: "DF3.1",
  },
  {
    file: "phase-1/stories/p1-3-seeds-decompose-mirror.md",
    anchor: "A2A-level errors",
    retired: "P1.1",
    successor: "DF3.1",
  },
];

// Canonical successor set (IDs the amendments actually write; §E2E Slice).
const CANONICAL_SUCCESSORS = [
  "DF1.3", "DF1.5", "DF1.6", "DF1.8", "DF2.8", "DF2.10",
  "DF3.1", "DF5.2", "DF5.3", "DF1.10",
];

function storyFile(id: string): string {
  // DF<n>.<m>(a|b)? → dark-factory-v5/stories/df<n>-<m><suffix>-*.md
  const m = id.match(/^DF(\d+)\.(\d+)([ab])?$/);
  if (!m) throw new Error(`unparseable successor id: ${id}`);
  const prefix = `df${m[1]}-${m[2]}${m[3] ?? ""}-`;
  const dir = path.join(ARTIFACTS, "dark-factory-v5", "stories");
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(prefix));
  return hit ?? "";
}

// Per-pair line check: every line carrying a retired ID must also name its
// mapped successor. Returns failures; empty = clean.
function perPairFailures(text: string): string[] {
  const fails: string[] = [];
  text.split("\n").forEach((line, i) => {
    RETIRED_RE.lastIndex = 0;
    for (const m of line.matchAll(RETIRED_RE)) {
      const id = `P1.${m[1]}`;
      const succ = SUCCESSOR[id];
      if (!succ) throw new Error(`successor map has no entry for ${id}`);
      if (!line.includes(succ)) {
        fails.push(`line ${i + 1}: ${id} without ${succ}`);
      }
    }
  });
  return fails;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("keep-repoints: retired-ID scan (AC1 assertion 1, count-based)", () => {
  test("all 12 in-scope files are readable and carry an H1 (positive control)", () => {
    for (const rel of IN_SCOPE) {
      const text = fs.readFileSync(path.join(ARTIFACTS, rel), "utf8");
      expect(text.length, `${rel} is empty`).toBeGreaterThan(0);
      expect(text, `${rel} has no H1 — file may be unreadable/_binary`).toMatch(/^# \S/m);
    }
  });

  test("every surviving retired-ID occurrence names its successor on the same line", () => {
    for (const rel of IN_SCOPE) {
      if (rel.includes("p0-5")) continue; // zero hits — covered by its own test
      const text = fs.readFileSync(path.join(ARTIFACTS, rel), "utf8");
      const fails = perPairFailures(text);
      expect(fails, `${rel} has unannotated retired IDs:\n${fails.join("\n")}`).toEqual([]);
    }
  });

  test("p0-5 has zero retired-ID occurrences (never opened for edit)", () => {
    const text = fs.readFileSync(path.join(ARTIFACTS, "phase-0/stories/p0-5-pi-lens-headless-tdi.md"), "utf8");
    expect(text.match(RETIRED_RE)).toBeNull();
  });

  test("the three provenance sites keep the old ID with their (now DF…) annotation", () => {
    for (const site of PROVENANCE_SITES) {
      const text = fs.readFileSync(path.join(ARTIFACTS, site.file), "utf8");
      const line = text.split("\n").find((l) => l.includes(site.anchor));
      expect(line, `provenance anchor not found in ${site.file}: ${site.anchor}`).toBeDefined();
      expect(line, `${site.file} provenance lost the old ID (substitution destroys the record)`).toContain(site.retired);
      expect(line, `${site.file} provenance lacks (now ${site.successor})`).toContain(`(now ${site.successor})`);
    }
  });
});

describe("keep-repoints: per-pair correctness (AC1 assertion 2, table-driven)", () => {
  test("a line annotating the WRONG successor fails the per-pair check", () => {
    const fails = perPairFailures("P1.6 is served by DF3.1 (wrong successor)");
    expect(fails).toEqual(["line 1: P1.6 without DF1.6"]);
  });

  test("a correctly annotated line passes", () => {
    expect(perPairFailures("P1.6 (now DF1.6) and P1.8 (now DF1.8)")).toEqual([]);
  });
});

describe("keep-repoints: marker set (AC1 assertion 3)", () => {
  test("directory-scoped grep -rl deep-equals the 11-path literal array", () => {
    const r = spawnSync("grep", ["-rl", MARKER, path.join(ARTIFACTS, "phase-0/stories"), path.join(ARTIFACTS, "phase-1/stories")], { encoding: "utf8" });
    expect(r.status, `grep failed: ${r.stderr}`).toBe(0);
    const found = r.stdout.trim().split("\n").filter(Boolean).map((p) => path.relative(ARTIFACTS, p)).sort();
    expect(found).toEqual(AMENDED);
  });

  test("sprint-status.yaml carries no marker (amendment G is markerless — the count depends on it)", () => {
    const yaml = fs.readFileSync(YAML, "utf8");
    expect(yaml.includes(MARKER)).toBe(false);
  });
});

describe("keep-repoints: yaml deps scan (AC1 assertion 3 bullet / AC1 third grep)", () => {
  const KEEP_KEYS = ["P1.2", "P1.3", "P1.5", "P1.7", "P1.9", "P1.11", "P1.12", "P1.14", "P1.18"];

  test("every KEEP row's deps array parses (positive control — not a vacuous pass)", () => {
    const yaml = fs.readFileSync(YAML, "utf8");
    let parsed = 0;
    for (const key of KEEP_KEYS) {
      const row = yaml.split("\n").find((l) => new RegExp(`^\\s{6}${key}:\\s*\\{`).test(l));
      expect(row, `${key} row not found in sprint-status.yaml`).toBeDefined();
      expect(row, `${key} row has no deps array`).toMatch(/deps: \[/);
      parsed++;
    }
    expect(parsed).toBe(KEEP_KEYS.length);
  });

  test("no KEEP row's deps array names a retired ID (superseded rows keep theirs — historical record)", () => {
    const yaml = fs.readFileSync(YAML, "utf8");
    for (const key of KEEP_KEYS) {
      const row = yaml.split("\n").find((l) => new RegExp(`^\\s{6}${key}:\\s*\\{`).test(l)) ?? "";
      const deps = row.match(/deps: \[([^\]]*)\]/)?.[1] ?? "";
      expect(deps, `${key} deps still name a retired ID`).not.toMatch(/P1\.(1|4|6|8|10|13|15|16|17|19)\b/);
    }
  });
});

describe("keep-repoints: AC4 missing-successor halt", () => {
  test("every canonical successor resolves to a story file on disk (precondition, before any edit)", () => {
    const missing = CANONICAL_SUCCESSORS.filter((id) => storyFile(id) === "");
    expect(missing, `successor files missing: ${missing.join(", ")}`).toEqual([]);
  });

  test("a synthetic map entry pointing at a nonexistent story halts (DF9.9)", () => {
    expect(storyFile("DF9.9")).toBe("");
  });
});
