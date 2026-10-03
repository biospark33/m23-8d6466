#!/usr/bin/env bun
/**
 * Story/artifact consistency gate.
 *
 * WHY THIS EXISTS. The 2026-09-08 pre-dev review campaign found the SAME drift in six
 * separate artifacts — `sprint-status.yaml`'s meta block, the story files, the epics
 * index, a merged story, and the handoff brief written to prevent it. That is not six
 * mistakes; it is one missing mechanism. Three full review waves (350 findings) could not
 * hold the discipline by hand, and the campaign's own fix commits kept generating fresh
 * instances — including a docstring that warns about stale line citations and commits one
 * about itself in the same sentence.
 *
 * So: the checks below are the ones a machine can decide. Everything a machine cannot
 * decide stays a human's job, and this file deliberately does not pretend otherwise.
 *
 * ponytail: five checks, one file, no dependencies, regex over the yaml rather than a YAML
 * parser — the row grammar is fixed and generated. Reach for a parser if the schema ever
 * grows nesting inside a story row.
 *
 * Exit 0 = consistent. Exit 1 = drift (each finding printed with its fix). Exit 2 = the
 * checker could not run (missing input), which is NOT a pass.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const YAML = join(ROOT, "_bmad-output/sprint-artifacts/sprint-status.yaml");
const STORIES = join(ROOT, "_bmad-output/sprint-artifacts/dark-factory-v5/stories");
const EPICS = join(ROOT, "_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md");
// v6 slate (DD-27): same checks, second directory + second index. A v6 row invisible to
// this gate would make the charter's "rows must reconcile" discipline honor-system — the
// exact failure this file exists to prevent.
const V6_STORIES = join(ROOT, "_bmad-output/sprint-artifacts/dark-factory-v6/stories");
const V6_EPICS = join(ROOT, "_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v6.md");

type Finding = { check: string; where: string; problem: string; fix: string; info?: boolean };
const findings: Finding[] = [];
const add = (check: string, where: string, problem: string, fix: string, info = false) =>
  findings.push({ check, where, problem, fix, info });

function bail(msg: string): never {
  console.error(`check-story-consistency: cannot run — ${msg}`);
  process.exit(2);
}

for (const p of [YAML, STORIES, EPICS, V6_STORIES, V6_EPICS]) if (!existsSync(p)) bail(`missing ${p}`);

// ── The repo's file index, for citation resolution ────────────────────────────
// Built once. Keyed by basename so we can detect the dangerous case: a bare
// `report.ts:123` that resolves to TWO real files — in this repo that pair is
// `src/reverify/report.ts` and `src/phase-engine/gates/report.ts`, i.e. the two
// sides of R9's two-layer evidence doctrine. Picking the wrong one collapses both
// layers, which is the exact failure the tier-2 ADR exists to prevent.
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".gitnexus", "coverage"]);
const byBasename = new Map<string, string[]>();
(function walk(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
    } else {
      const rel = join(dir, e.name).slice(ROOT.length + 1);
      const list = byBasename.get(e.name);
      if (list) list.push(rel);
      else byBasename.set(e.name, [rel]);
    }
  }
})(ROOT);

const lineCount = (rel: string): number =>
  readFileSync(join(ROOT, rel), "utf8").split("\n").length;

// ── Parse the per-story rows (the authoritative slate) ────────────────────────
// v5 `DF{n}[.{n}]` + v6 `Z1 / M1.1 / A6 / J1 / G1` (DD-27). The P-prefix phase rows are
// a retired slate and stay outside this gate.
const yamlText = readFileSync(YAML, "utf8");
const ROW = /^\s{6}((?:DF|Z|M|A|J|G)[0-9]+(?:\.[0-9]+)?[a-z]?):\s*\{([^}]*)\}/gm;
type Row = { id: string; points: number; status: string; deps: string[]; raw: string };
const rows: Row[] = [];
for (const m of yamlText.matchAll(ROW)) {
  const body = m[2]!;
  rows.push({
    id: m[1]!,
    points: Number(body.match(/points:\s*(\d+)/)?.[1] ?? Number.NaN),
    status: body.match(/status:\s*([a-z-]+)/)?.[1] ?? "?",
    deps: (body.match(/deps:\s*\[([^\]]*)\]/)?.[1] ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    raw: m[0]!,
  });
}
if (rows.length === 0) bail("parsed zero DF story rows from sprint-status.yaml (row grammar changed?)");

// ── CHECK 1 — slate arithmetic: every stated total must equal the summed rows ──
// A hand-maintained total sitting beside its own authoritative source can only go
// stale. This is the one that was wrong for eight days and that DF5.5's own ACs read.
{
  const total = rows.reduce((n, r) => n + r.points, 0);
  const notDone = rows.filter((r) => r.status !== "done");
  const ndPts = notDone.reduce((n, r) => n + r.points, 0);
  const claimed = [...yamlText.matchAll(/SLATE NOW (\d+) stories \/ (\d+) pts/g)];
  for (const c of claimed) {
    if (Number(c[1]) !== rows.length || Number(c[2]) !== total) {
      add("slate", "sprint-status.yaml meta",
        `meta claims ${c[1]} stories / ${c[2]} pts; the rows sum to ${rows.length} / ${total}`,
        "recompute — never increment. Rows are authoritative.");
    }
  }
  // The cross-check paragraph asserts a not-done count and point sum.
  const xc = yamlText.match(/=\s*(\d+)\s*pts, and (\d+) - \1 = (\d+)/);
  if (xc && (Number(xc[1]) !== ndPts || Number(xc[2]) !== total)) {
    add("slate", "sprint-status.yaml cross-check",
      `cross-check asserts ${xc[1]} not-done pts of ${xc[2]}; rows give ${ndPts} of ${total}`,
      `the paragraph claims it was "recomputed from the per-story entries" — make that true`);
  }
  // v6 slate claim (DD-14a): the v6 meta note states the row-derived totals. The claim
  // must exist EXACTLY ONCE and parse — a missing/malformed/duplicated claim would make
  // this loop silently green (the honor-system failure the gate exists to prevent).
  const v6Rows = rows.filter((r) => /^(Z|M|A|J|G)/.test(r.id));
  const v6Total = v6Rows.reduce((n, r) => n + r.points, 0);
  const v6Claims = [...yamlText.matchAll(/V6 ROWS: (\d+) stories \/ (\d+) pts/g)];
  if (v6Claims.length !== 1) {
    add("slate", "sprint-status.yaml v6 meta",
      `expected exactly one parseable "V6 ROWS: <n> stories / <n> pts" claim, found ${v6Claims.length}`,
      "write one claim in the v6 meta block — the gate cannot reconcile what it cannot parse");
  }
  for (const c of v6Claims) {
    if (Number(c[1]) !== v6Rows.length || Number(c[2]) !== v6Total) {
      add("slate", "sprint-status.yaml v6 meta",
        `v6 meta claims ${c[1]} stories / ${c[2]} pts; the v6 rows sum to ${v6Rows.length} / ${v6Total}`,
        "recompute — never increment. Rows are authoritative (DD-14a).");
    }
  }
}

// ── CHECK 2 — every story row has a spec file, and its header agrees ───────────
const specFiles = [
  ...readdirSync(STORIES).map((f) => ({ f, dir: STORIES })),
  ...readdirSync(V6_STORIES).map((f) => ({ f, dir: V6_STORIES })),
].filter((e) => e.f.endsWith(".md"));
const specFor = (id: string): { f: string; dir: string } | undefined => {
  const slug = id.toLowerCase().replace(/\./g, "-");
  return specFiles.find((e) => e.f === `${slug}-` || e.f.startsWith(`${slug}-`));
};
for (const r of rows) {
  const spec = specFor(r.id);
  if (!spec) {
    if (r.status !== "done") {
      add("spec-file", r.id, "no spec file in a stories directory",
        "author it, or mark the row done if it shipped before the story convention");
    }
    continue;
  }
  const f = spec.f;
  const head = readFileSync(join(spec.dir, f), "utf8").slice(0, 4000);
  // Both header spellings live in the wild (`**Story Points:**` v5-late/v6, `**Points:**` v5)
  // — a spelling the regex misses parses as NaN and the row is silently skipped, which is a
  // green check that checked nothing.
  const pts = head.match(/\*\*Story Points:\*\*\s*(\d+)|\*\*Points:\*\*\s*(\d+)|Points:\s*(\d+)/);
  const p = Number(pts?.[1] ?? pts?.[2] ?? pts?.[3] ?? Number.NaN);
  if (Number.isFinite(p) && p !== r.points) {
    add("header", `${r.id} (${f})`, `story header says ${p} points; yaml row says ${r.points}`,
      `make them equal — the yaml row is the slate's source of truth`);
  }
  // The value itself may be bold-wrapped (`**Status:** **gated**` — Z3) — `\*{0,2}` around
  // the capture keeps an unparsed status from reading as "no header status to compare".
  const st = head.match(/\*\*Status:\*\*\s*\*{0,2}([a-z-]+)\*{0,2}/)?.[1];
  if (st && st !== r.status) {
    add("header", `${r.id} (${f})`, `story header status "${st}"; yaml row "${r.status}"`,
      `correct against git history, not against either document's prose`);
  }
}

// ── CHECK 3 — every not-done story appears in the epics index ─────────────────
// DF2.13 was authored after the index was last resynced and had zero hits.
{
  const epics = readFileSync(EPICS, "utf8") + readFileSync(V6_EPICS, "utf8");
  for (const r of rows) {
    if (r.status === "done") continue;
    if (!epics.includes(r.id)) {
      add("epics-index", r.id, "absent from the epics index",
        "add its section — the index is a marker-grep participant and silently under-counts");
    }
  }
}

// ── CHECK 4 — dependency edges resolve to real stories ────────────────────────
{
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    for (const d of r.deps) {
      // Retired-slate KEEP ids (P0.x / P1.x / P2.x) are not our business. The exemption is
      // scoped to exactly those three forms: a later-phase P id (`P3.1`) is NOT a retired
      // slate id — it falls through to the grammar check and fails there, like any other
      // unknown id, instead of silently skipping the gate.
      if (/^P[012]\./.test(d)) continue;
      // Both active slate grammars resolve (v5 `DF{n}[.n][a-z]`, v6 `Z|M|A|J|G{n}[.n][a-z]` —
      // DD-27). Filtering on DF alone left every v6 dep edge silently unresolved.
      if (!/^(?:DF|Z|M|A|J|G)\d/.test(d)) {
        add("deps", r.id, `deps names "${d}", which matches no active slate id grammar (v5 DF{n}, v6 Z|M|A|J|G{n})`,
          "re-point it — deps must name a story id from an active slate");
        continue;
      }
      if (!ids.has(d)) {
        add("deps", r.id, `deps names "${d}", which is not a story id in this slate`,
          "re-point it — a split (DF6.1 -> DF6.1a/b) retires the old id");
      }
    }
  }
}

// ── CHECK 5 — line citations in the story specs ───────────────────────────────
// Two decidable failures: a citation past EOF, and a BARE BASENAME that resolves to
// more than one real file. The second is the dangerous one and is why this check
// exists at all — a reader (human or agent) silently resolves to the wrong file.
// What this canNOT decide: whether line N still holds the symbol the prose names.
// That is why the campaign's standing rule is to cite by SYMBOL and drop the `:NNN`.
//
// SCOPE, and why it is not a dodge. This gate FAILS only for stories that are not yet
// `done`, and reports the rest as info. A done story's citations describe shipped history
// and a reader has the merged code to hand; a ready-for-dev story's citations are
// INSTRUCTIONS a developer will follow, and a wrong one sends them to the wrong file. The
// cost of drift is asymmetric, so the gate is too. Nothing is grandfathered permanently:
// a story flipping to ready-for-dev pulls its citations into the gate automatically.
{
  const statusOf = new Map(rows.map((r) => [r.id, r.status]));
  const gated = (f: string): boolean => {
    const id = [...statusOf.keys()].find((k) => f.startsWith(`${k.toLowerCase().replace(/\./g, "-")}-`));
    return id ? statusOf.get(id) !== "done" : false;
  };
  const CITE = /((?:fork:|solstice:)?[A-Za-z0-9_./-]+\.(?:ts|tsx|sh|json|yaml|yml|md)):(\d+)/g;
  for (const spec of specFiles) {
    const f = spec.f;
    const text = readFileSync(join(spec.dir, f), "utf8");
    const isInfo = !gated(f);
    for (const m of text.matchAll(CITE)) {
      const [, pRaw, nStr] = m as unknown as [string, string, string];
      // fork:/solstice:-prefixed cites point OUTSIDE this repo by contract (v6-crossrepo-contract
      // §0: zeropoint code is never in the factory import graph, so the factory walker cannot
      // and must not resolve them). The prefix is the reviewer's marker that the citation is
      // cross-repo and was verified against the OTHER checkout.
      if (pRaw.startsWith("fork:") || pRaw.startsWith("solstice:")) continue;
      const p = pRaw;
      const n = Number(nStr);
      let cands: string[];
      if (existsSync(join(ROOT, p))) cands = [p];
      else {
        const all = byBasename.get(basename(p)) ?? [];
        const suffixed = all.filter((c) => c.endsWith(p));
        cands = suffixed.length > 0 ? suffixed : all;
      }
      if (cands.length === 0) {
        add("citation", `${f} -> ${p}:${n}`, "no such file in the repo",
          "fix the path, or cite by symbol and drop the line number", isInfo);
      } else if (cands.length > 1) {
        add("citation", `${f} -> ${p}:${n}`,
          `AMBIGUOUS: resolves to ${cands.length} real files — ${cands.join(" | ")}`,
          "write the full path from the repo root, or cite by symbol and drop the line number", isInfo);
      } else if (n > lineCount(cands[0]!)) {
        add("citation", `${f} -> ${p}:${n}`,
          `past EOF: ${cands[0]} has ${lineCount(cands[0]!)} lines`,
          "cite by symbol and drop the line number", isInfo);
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const blocking = findings.filter((f) => !f.info);
const info = findings.filter((f) => f.info);
const pts = rows.reduce((n, r) => n + r.points, 0);

if (info.length > 0) {
  const files = new Set(info.map((f) => f.where.split(" ->")[0]));
  console.log(`check-story-consistency: ${info.length} citation issue(s) in ${files.size} already-done stor(ies) — reported, not gated.`);
  console.log("  (run with --all to list them; they gate automatically if a story returns to ready-for-dev)");
  if (process.argv.includes("--all")) {
    for (const f of info) console.log(`   ${f.where}\n     ${f.problem}`);
  }
  console.log("");
}

if (blocking.length === 0) {
  console.log(`check-story-consistency: OK — ${rows.length} stories, ${pts} pts, all gated artifacts agree.`);
  process.exit(0);
}
const byCheck = new Map<string, Finding[]>();
for (const f of blocking) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
console.error(`check-story-consistency: ${blocking.length} drift finding(s)\n`);
for (const [check, list] of byCheck) {
  console.error(`── ${check} (${list.length})`);
  for (const f of list) console.error(`   ${f.where}\n     problem: ${f.problem}\n     fix:     ${f.fix}`);
  console.error("");
}
process.exit(1);
