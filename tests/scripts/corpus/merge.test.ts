/**
 * JEV-1 — `scripts/corpus/merge.ts`.
 *
 * Forward capture: a skill-shaped `<workdir>/triage.json` (Appendix A) becomes
 * one schema-valid JSONL record per finding under the corpus dir, stamped
 * `labeler`/`arm`/`created_at` per the best-available rule; re-running the same
 * merge appends nothing (AC2 idempotence for this writer); invalid input exits
 * non-zero and writes nothing (AC3/DoD guard).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecord, main, parseArgs, sidecarToRecords } from "../../../scripts/corpus/merge.ts";
import { TriageRecordSchema, type TriageRecord, type TriageSidecar } from "../../../scripts/corpus/schema.ts";

const FIXTURE_WORKDIR = join(import.meta.dir, "fixtures", "sidecar");

function tmpOut(): string {
  return mkdtempSync(join("/tmp", "corpus-merge-"));
}

function records2(sidecar: TriageSidecar, opts: Parameters<typeof sidecarToRecords>[1]): [TriageRecord, TriageRecord] {
  const [a, b] = sidecarToRecords(sidecar, opts);
  return [a!, b!];
}

function readRecords(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("parseArgs", () => {
  test("--workdir required; --out optional", () => {
    expect(parseArgs(["--workdir", "w"])).toEqual({ workdir: "w", out: undefined });
    expect(parseArgs(["--workdir=w", "--out=o"])).toEqual({ workdir: "w", out: "o" });
    expect(() => parseArgs([])).toThrow(/--workdir/);
  });
});

describe("sidecarToRecords", () => {
  const sidecar: TriageSidecar = {
    pr: 277,
    round: 4,
    duration_ms: 541000,
    findings: [
      {
        finding_id: "F-003",
        finding_text: "text",
        diff_context_ref: "src/providers/credentials.ts@6f6bff39",
        label: "BLOCKER",
        disposition: "PATCH",
        rationale: "real",
        created_at: "2026-09-22T14:03:00Z",
        latency_ms: 41000,
      },
      {
        finding_id: "F-004",
        finding_text: "text",
        diff_context_ref: "scripts/lib/run-lock.ts@6f6bff39",
        label: "HIGH",
        disposition: "DEFER",
      },
    ],
  };

  test("best-available-timestamp-wins: preserved when the sidecar supplied one, merge-stamped otherwise", () => {
    const [a, b] = records2(sidecar, { now: "2026-09-22T18:00:00.000Z" });
    expect(a.created_at).toBe("2026-09-22T14:03:00Z");
    expect(b.created_at).toBe("2026-09-22T18:00:00.000Z");
    expect(a.latency_ms).toBe(41000);
    expect(b.latency_ms).toBeNull();
  });

  test("all six reserved A/B fields present; arm stamped frontier; costs null without rate", () => {
    const [a] = records2(sidecar, { now: "2026-09-22T18:00:00.000Z" });
    expect(a.arm).toBe("frontier");
    expect(a.cost_exact_usd).toBeNull();
    expect(a.cost_estimate_usd).toBeNull();
    expect(a.outcome_confirmed).toBeNull();
    expect(a.outcome_source).toBeNull();
  });

  test("cost_estimate_usd = duration_ms x rate only when both the sidecar duration and the rate exist", () => {
    const [a] = records2(sidecar, { now: "2026-09-22T18:00:00.000Z", rateUsdPerMs: 0.0000002 });
    expect(a.cost_estimate_usd).toBeCloseTo(541000 * 0.0000002, 10);
    const noRate = sidecarToRecords(sidecar, { now: "2026-09-22T18:00:00.000Z", rateUsdPerMs: null });
    expect(noRate.every((r) => r.cost_estimate_usd === null)).toBe(true);
  });
});

describe("main — e2e on the skill-shaped fixture", () => {
  test("writes one schema-valid record per finding, stamped, into <pr>-r<round>.jsonl", async () => {
    const out = tmpOut();
    try {
      expect(await main(["--workdir", FIXTURE_WORKDIR, "--out", out])).toBe(0);
      const file = join(out, "277-r4.jsonl");
      expect(existsSync(file)).toBe(true);
      const records = readRecords(file);
      expect(records).toHaveLength(2);
      for (const r of records) {
        const parsed = TriageRecordSchema.safeParse(r);
        expect(parsed.success).toBe(true);
      }
      const f004 = records.find((r) => (r as { finding_id: string }).finding_id === "F-004") as Record<string, unknown>;
      expect(f004.labeler).toBe("frontier-lead");
      expect(f004.arm).toBe("frontier");
      expect(typeof f004.created_at).toBe("string");
      expect(f004.cost_estimate_usd).toBeNull();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("idempotent: the second merge leaves the file byte-identical, no duplicate rows", async () => {
    const out = tmpOut();
    try {
      expect(await main(["--workdir", FIXTURE_WORKDIR, "--out", out])).toBe(0);
      const file = join(out, "277-r4.jsonl");
      const afterFirst = readFileSync(file, "utf8");
      expect(await main(["--workdir", FIXTURE_WORKDIR, "--out", out])).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(afterFirst);
      expect(readRecords(file)).toHaveLength(2);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("invalid sidecar: non-zero exit and zero writes (AC3), through the real CLI boundary", () => {
    const workdir = mkdtempSync(join("/tmp", "corpus-bad-"));
    const out = tmpOut();
    try {
      writeFileSync(join(workdir, "triage.json"), '{"pr":1,"round":1,"findings":[{"finding_id":"F","unknown_key":1}]}');
      const r = Bun.spawnSync(["bun", "scripts/corpus/merge.ts", "--workdir", workdir, "--out", out], {
        cwd: join(import.meta.dir, "..", "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("unknown_key");
      expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("honest limitation pinned: merge validates shape, not authorship — bot-prose-shaped finding_text still merges", async () => {
    const workdir = mkdtempSync(join("/tmp", "corpus-botprose-"));
    const out = tmpOut();
    try {
      // INV-C2's fence lives upstream (the skill edit + the backfill exclusion
      // list), NOT here: merge must not pretend it can sniff authorship.
      writeFileSync(
        join(workdir, "triage.json"),
        JSON.stringify({
          pr: 9,
          round: 1,
          findings: [
            {
              finding_id: "B-1",
              finding_text: "The fix loop reported: fix-a-steering completed, all gates green.",
              diff_context_ref: "pr-comment.md#1",
              label: "LOW",
              disposition: "DISMISS",
            },
          ],
        }),
      );
      expect(await main(["--workdir", workdir, "--out", out])).toBe(0);
      expect(readRecords(join(out, "9-r1.jsonl"))).toHaveLength(1);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("QDS_FRONTIER_USD_PER_MS set + sidecar duration_ms yields the estimated cost", async () => {
    const out = tmpOut();
    const prev = process.env.QDS_FRONTIER_USD_PER_MS;
    process.env.QDS_FRONTIER_USD_PER_MS = "0.0000002";
    try {
      expect(await main(["--workdir", FIXTURE_WORKDIR, "--out", out])).toBe(0);
      const records = readRecords(join(out, "277-r4.jsonl"));
      expect((records[0] as { cost_estimate_usd: number }).cost_estimate_usd).toBeCloseTo(541000 * 0.0000002, 10);
    } finally {
      if (prev === undefined) process.env.QDS_FRONTIER_USD_PER_MS = undefined;
      else process.env.QDS_FRONTIER_USD_PER_MS = prev;
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("AC5 — the barrel is the import surface", () => {
  test("the Wave-3 observer imports the schema + append without re-declaring them", async () => {
    const barrel = await import("../../../scripts/corpus/index.ts");
    expect(barrel.appendRecord).toBe(appendRecord);
    expect(barrel.TriageRecordSchema).toBe(TriageRecordSchema);
    expect([...barrel.DISPOSITIONS]).toEqual(["PATCH", "DISMISS", "DEFER", "DECISION_NEEDED", "POST_MERGE_CHANGED", "GATE_ACTION"]);
  });
});

describe("appendRecord", () => {
  const record = {
    finding_id: "F-1",
    finding_text: "t",
    diff_context_ref: "a@b",
    label: "HIGH",
    disposition: "PATCH" as const,
    labeler: "frontier-lead",
    pr: 1,
    round: 1,
    created_at: "2026-09-22T00:00:00Z",
    arm: "frontier" as const,
    latency_ms: null,
    cost_exact_usd: null,
    cost_estimate_usd: null,
    outcome_confirmed: null,
    outcome_source: null,
  };

  test("appends once, then reports duplicate", () => {
    const out = tmpOut();
    try {
      expect(appendRecord(out, record)).toBe("written");
      expect(appendRecord(out, record)).toBe("duplicate");
      expect(readRecords(join(out, "1-r1.jsonl"))).toHaveLength(1);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("rejects a record that fails the schema, naming the path", () => {
    const out = tmpOut();
    try {
      expect(() => appendRecord(out, { ...record, disposition: "NOPE" })).toThrow(/disposition/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
