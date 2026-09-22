/**
 * JEV-1 — `scripts/corpus/backfill.ts`.
 *
 * Historical ledgers become honestly-labeled records: per-encoding
 * normalization (pr123 word forms, pr184 letter+bold+compound, pr128-r5 bare N
 * and section-implied), the bot-prose exclusion fence (INV-C2), non-directory
 * and unbackable reporting, one created_at rule, nulls never guessed (INV-C4),
 * idempotence for this writer (AC2), and the MANDATORY e2e round against the
 * real repo ledgers (`_bmad-output/workflow-state/code-review/`).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  EXCLUDED_LEDGER_DIRS,
  EXCLUDED_LEDGER_FILES,
  ledgerDate,
  main,
  normalizeDispositionCell,
  parseLedgerText,
} from "../../../scripts/corpus/backfill.ts";
import { TriageRecordSchema, type TriageRecord } from "../../../scripts/corpus/schema.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURE_LEDGER = join(import.meta.dir, "fixtures", "ledger");
const REAL_LEDGER = join(REPO_ROOT, "_bmad-output", "workflow-state", "code-review");

function tmpOut(): string {
  return mkdtempSync(join("/tmp", "corpus-backfill-"));
}

function readAll(out: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const f of readdirSync(out)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(out, f), "utf8").split("\n")) {
      if (line.trim() !== "") records.push(JSON.parse(line));
    }
  }
  return records;
}

describe("normalizeDispositionCell", () => {
  test("pr123 word forms", () => {
    expect(normalizeDispositionCell("PATCH")?.disposition).toBe("PATCH");
    expect(normalizeDispositionCell("PATCH(story)")).toEqual({ disposition: "PATCH", rationale: "story" });
    expect(normalizeDispositionCell("DEFER")?.disposition).toBe("DEFER");
    expect(normalizeDispositionCell("DISMISS")?.disposition).toBe("DISMISS");
  });

  test("pr184 letter + bold + annotation + trailing rationale + compound", () => {
    expect(normalizeDispositionCell("**P**")?.disposition).toBe("PATCH");
    expect(normalizeDispositionCell("**P** (comment)")).toEqual({ disposition: "PATCH", rationale: "comment" });
    const d = normalizeDispositionCell("**D** — acknowledged in-file; out of scope");
    expect(d?.disposition).toBe("DEFER");
    expect(d?.rationale).toContain("acknowledged in-file");
    const dn = normalizeDispositionCell("**DN→P** (assert + fail closed)");
    expect(dn?.disposition).toBe("PATCH");
    expect(dn?.rationale).toContain("DN→P");
    expect(normalizeDispositionCell("**X** — verified against source")?.disposition).toBe("DISMISS");
  });

  test("bare N and any unknown code are never guessed", () => {
    expect(normalizeDispositionCell("N")).toBeNull();
    expect(normalizeDispositionCell("**N**")).toBeNull();
    expect(normalizeDispositionCell("MAYBE")).toBeNull();
  });
});

describe("parseLedgerText", () => {
  const meta = { pr: 184, round: 4, sourceRef: "pr184/round4-triage.md", createdAt: null };

  test("an escaped pipe stays inside its cell — no column shift or truncation", () => {
    const text = [
      "| id | sev | finding | class |",
      "|----|-----|---------|-------|",
      '| EP1 | HIGH | run `[ "a" \\| "b" ]` gate | PATCH |',
      "| EP2 | LOW | plain finding | X |",
    ].join("\n");
    const { records, skipped } = parseLedgerText(text, meta);
    expect(skipped).toHaveLength(0);
    expect(records).toHaveLength(2);
    const ep1 = records.find((r) => r.finding_id === "EP1")!;
    expect(ep1.finding_text).toBe('run `[ "a" | "b" ]` gate'); // escape consumed, cell intact
    expect(ep1.disposition).toBe("PATCH");
    expect(ep1.label).toBe("HIGH");
    expect(records.find((r) => r.finding_id === "EP2")!.disposition).toBe("DISMISS");
  });

  test("every pr184-style row yields a record; compound maps to the final state", () => {
    const text = readFileSync(join(FIXTURE_LEDGER, "pr184", "round4-triage.md"), "utf8");
    const { records, skipped } = parseLedgerText(text, meta);
    expect(records).toHaveLength(6);
    expect(skipped).toHaveLength(0);
    const a3 = records.find((r) => r.finding_id === "A3")!;
    expect(a3.disposition).toBe("PATCH");
    expect(a3.rationale).toContain("DN→P");
    expect(a3.rationale).toContain("assert + fail closed");
    const a4 = records.find((r) => r.finding_id === "A4")!;
    expect(a4.rationale).toBe("comment");
    expect(records.every((r) => r.labeler === "agreement-with-claude")).toBe(true);
    expect(records.every((r) => r.arm === "frontier")).toBe(true);
    expect(records.every((r) => r.created_at === null)).toBe(true);
    expect(records.every((r) => r.latency_ms === null && r.cost_exact_usd === null)).toBe(true);
  });

  test("pr123 word forms yield records with the file-stated day-granular date", () => {
    const text = readFileSync(join(FIXTURE_LEDGER, "pr123", "triage.md"), "utf8");
    const { records } = parseLedgerText(text, { pr: 123, round: 10, sourceRef: "pr123/triage.md", createdAt: "2026-08-24" });
    expect(records).toHaveLength(4);
    expect(records.every((r) => r.created_at === "2026-08-24")).toBe(true);
    expect(records.find((r) => r.finding_id === "DF2")!.rationale).toBe("story");
    expect(records.find((r) => r.finding_id === "DF4")!.disposition).toBe("DISMISS");
  });

  test("pr128-r5: section-implied dispositions, stated location as diff_context_ref, bare N skipped-with-reason", () => {
    const text = readFileSync(join(FIXTURE_LEDGER, "pr128-r5", "triage.md"), "utf8");
    const { records, skipped } = parseLedgerText(text, { pr: 128, round: 5, sourceRef: "pr128-r5/triage.md", createdAt: "2026-08-24" });
    expect(records).toHaveLength(3);
    const p1 = records.find((r) => r.finding_id === "P1")!;
    expect(p1.disposition).toBe("PATCH");
    expect(p1.diff_context_ref).toBe("src/fleet/fleet-lock.ts:561-564");
    const x1 = records.find((r) => r.finding_id === "X1")!;
    expect(x1.disposition).toBe("DISMISS");
    expect(x1.label).toBe("HIGH");
    expect(x1.created_at).toBe("2026-08-24");
    expect(skipped.some((s) => s.reason.includes('"N"'))).toBe(true);
    expect(records.some((r) => r.finding_id === "N1")).toBe(false);
  });

  test("rows without a finding/title column are skipped-with-reason, never guessed", () => {
    const { records, skipped } = parseLedgerText(
      "| id | sev | source | owner | work |\n|----|-----|--------|-------|------|\n| WT1 | HIGH | blind | W2a | Add assertions. |\n",
      meta,
    );
    expect(records).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });
});

describe("ledgerDate", () => {
  test("reads ONLY a recognized metadata Date: line — never the first date anywhere", () => {
    expect(ledgerDate("Date: 2026-08-24. Reviewers: 9 spawned.")).toBe("2026-08-24");
    expect(ledgerDate("**Date:** 2025-01-25")).toBe("2025-01-25");
    // pr184 round 4, live: finding A1's shell snippet carries 2026-09-02 — a
    // date-in-a-finding must NOT stamp the ledger.
    const poisoned = '# ledger\n\n| A1 | BLOCKER | `[ "2026-09-02" \\> "null" ]` bypass |\n';
    expect(ledgerDate(poisoned)).toBeNull();
    expect(ledgerDate("# no date anywhere\nnothing states one")).toBeNull();
    expect(ledgerDate("Date: not-a-date")).toBeNull();
  });
});

describe("main on the fixture ledger root", () => {
  // The yield report is captured through a subprocess, not console.log
  // monkeypatching: in-process interception races with other test files that
  // also touch console (bun runs files in parallel), truncating the capture.
  function runBackfillCli(out: string): { exitCode: number; report: string } {
    const proc = Bun.spawnSync({
      cmd: ["bun", join("scripts", "corpus", "backfill.ts"), "--dir", FIXTURE_LEDGER, "--out", out],
      cwd: REPO_ROOT,
    });
    return { exitCode: proc.exitCode, report: proc.stdout.toString() };
  }

  test("exclusions, non-directory skip, unbackable report, honesty fields", async () => {
    const out = tmpOut();
    try {
      const { exitCode, report } = runBackfillCli(out);
      expect(exitCode).toBe(0);
      const records = readAll(out);
      expect(records.length).toBeGreaterThanOrEqual(13);
      for (const r of records) {
        expect(TriageRecordSchema.safeParse(r).success).toBe(true);
        expect(r.labeler).toBe("agreement-with-claude");
        expect(r.arm).toBe("frontier");
        expect(r.latency_ms).toBeNull();
        expect(r.cost_exact_usd).toBeNull();
        expect(r.cost_estimate_usd).toBeNull();
        expect(r.outcome_confirmed).toBeNull();
        expect(r.outcome_source).toBeNull();
      }
      // INV-C2: the bot-prose file is skipped by data, and the report says so.
      expect(EXCLUDED_LEDGER_FILES).toContain("pr135/pr-comment.md");
      expect(report).toContain("pr135/pr-comment.md");
      expect(report.toLowerCase()).toContain("excluded");
      expect(report.toLowerCase()).toContain("non-directory");
      expect(report.toLowerCase()).toContain("unbackable");
      // Story AC4b: the raw pre-triage dir is skipped BY NAME, before any file
      // of its is read — even though the fixture's e2e-audit table is
      // backfill-compatible on purpose.
      expect(EXCLUDED_LEDGER_DIRS).toContain("e2e-audit");
      expect(report).toContain("dir e2e-audit: EXCLUDED");
      expect(records.some((r) => r.finding_id === "EA1" || r.finding_id === "EA2")).toBe(false);
      // INV-C2 content fence: the excluded prose never landed as a record.
      expect(JSON.stringify(records)).not.toContain("BOT COMMENT TRANSCRIPT");
      // pr135 triage row landed, sourced from the ledger — not the excluded comment.
      expect(records.some((r) => r.finding_id === "T1" && r.pr === 135)).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("idempotent: the second backfill leaves every corpus file byte-identical", async () => {
    const out = tmpOut();
    try {
      expect(await main(["--dir", FIXTURE_LEDGER, "--out", out])).toBe(0);
      const snapshot = Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(join(out, f), "utf8")]));
      expect(await main(["--dir", FIXTURE_LEDGER, "--out", out])).toBe(0);
      for (const [f, body] of Object.entries(snapshot)) expect(readFileSync(join(out, f), "utf8")).toBe(body);
      expect(Object.keys(snapshot).length).toBeGreaterThan(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("main — MANDATORY e2e against the real repo ledgers", () => {
  test("pr184/round4 and pr123 yield their EXACT row counts, no cross-file padding; every record schema-valid", async () => {
    expect(existsSync(REAL_LEDGER)).toBe(true);
    const out = tmpOut();
    try {
      expect(await main(["--dir", REAL_LEDGER, "--out", out])).toBe(0);
      const parse = (file: string) =>
        readFileSync(join(out, file), "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as TriageRecord);
      // pr184/round4-triage.md carries 108 verdict rows (clusters A–H) and is
      // the ONLY source of pr=184/round=4 — exact equality, so rows missing
      // from the target ledger can never hide behind records from elsewhere.
      const round4 = parse("184-r4.jsonl");
      expect(round4).toHaveLength(108);
      expect(round4.every((r) => r.pr === 184 && r.round === 4)).toBe(true);
      expect(new Set(round4.map((r) => r.finding_id)).size).toBe(108);
      // INV-C4 regression pin: the ledger states NO metadata Date:, so every
      // created_at must be null — the old first-date-anywhere extractor stamped
      // all 108 with 2026-09-02 out of finding A1's shell snippet.
      expect(round4.every((r) => r.created_at === null)).toBe(true);
      // pr123/triage.md carries 91 verdict rows in clusters W1a–W1g — exactly.
      const pr123 = parse("123-rx.jsonl");
      expect(pr123).toHaveLength(91);
      expect(pr123.every((r) => r.pr === 123 && r.round === null)).toBe(true);
      // Positive control for metadata extraction: pr128-r5/triage.md states
      // `Date: 2026-08-24` on its header line — all 24 records carry it.
      const r128 = parse("128-r5.jsonl");
      expect(r128).toHaveLength(24);
      expect(r128.every((r) => r.created_at === "2026-08-24")).toBe(true);
      for (const record of [...round4, ...pr123, ...r128]) {
        expect(TriageRecordSchema.safeParse(record).success).toBe(true);
      }
      const all = readAll(out).map((r) => JSON.stringify(r)).join("\n");
      // Raw pre-triage dirs produce no records of their own encoding class.
      expect(all).not.toContain("e2e-coverage");
      expect(all).not.toContain("EA1"); // the fixture's raw-dir canary, in case REAL_LEDGER ever mirrors it
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
