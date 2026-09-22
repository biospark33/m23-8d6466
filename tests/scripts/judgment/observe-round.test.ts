/**
 * JEV-3 — `scripts/judgment/observe-round.ts` (S1 observer).
 *
 * All tests run in MOCK mode with NO key and NO network: the observer
 * constructs its client with normal mode resolution (default mock), and every
 * write goes to temp dirs — never the real `_bmad-output/judgment/` paths.
 *
 * Pinned honest behavior: a mid-round ceiling refusal KEEPS the judged
 * prefix's appended records (real measurements, not garbage) and exits 2
 * naming the refusal — partial writes are reported, never silent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JEV_LABELER,
  OBSERVER_EGRESS_CLASS,
  OBSERVER_QUESTIONS,
  buildState,
  dispositionFromChoice,
  observeRound,
  parseArgs,
  rationaleFrom,
  recordFrom,
} from "../../../scripts/judgment/observe-round.ts";
import { TriageRecordSchema, type TriageRecord } from "../../../scripts/corpus/schema.ts";
import { corpusFilePath } from "../../../scripts/corpus/merge.ts";
import { DEFAULT_STAGE_CEILING_INPUT_TOKENS, JudgmentClient, type JudgmentEnvelope } from "../../../src/judgment/index.ts";

// ---------------------------------------------------------------------------
// env hygiene — the observer's client must resolve mock with no env at all.
// ---------------------------------------------------------------------------

const SAVED_MOCK = process.env.TYPESAFE_MOCK;
const SAVED_KEY = process.env.TYPESAFE_API_KEY;

let tmp: string;

beforeEach(() => {
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.TYPESAFE_MOCK;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.TYPESAFE_API_KEY;
  tmp = mkdtempSync(join(tmpdir(), "jev-observe-"));
});

afterEach(() => {
  if (SAVED_MOCK === undefined) {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.TYPESAFE_MOCK;
  } else {
    process.env.TYPESAFE_MOCK = SAVED_MOCK;
  }
  if (SAVED_KEY === undefined) {
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.TYPESAFE_API_KEY;
  } else {
    process.env.TYPESAFE_API_KEY = SAVED_KEY;
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const FIXTURE_ROUND = join(import.meta.dir, "fixtures", "frontier-round.jsonl");
const PR = 277;
const ROUND = 4;

function seedCorpus(lines: string[]): string {
  const dir = join(tmp, "corpus");
  mkdirSync(dir, { recursive: true });
  writeFileSync(corpusFilePath(dir, PR, ROUND), `${lines.join("\n")}\n`);
  return dir;
}

const FIXTURE_LINES = () => readFileSync(FIXTURE_ROUND, "utf8").split("\n").filter((l) => l.trim() !== "");

function readJsonl(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

/** A minimal schema-valid frontier record for in-test seeding. */
function frontier(id: string, overrides: Partial<TriageRecord> = {}): string {
  const record = TriageRecordSchema.parse({
    finding_id: id,
    finding_text: `Finding ${id}: the described path mishandles its error arm.`,
    diff_context_ref: "src/x.ts@8b4a8f39",
    label: "MEDIUM",
    disposition: "DISMISS",
    labeler: "frontier-lead",
    pr: PR,
    round: ROUND,
    created_at: "2026-09-22T14:03:00Z",
    arm: "frontier",
    ...overrides,
  });
  return JSON.stringify(record);
}

/** Canned provenance envelope (shape pinned by src/judgment EnvelopeSchema). */
function cannedEnvelope(over: Partial<JudgmentEnvelope> = {}): JudgmentEnvelope {
  return {
    requestId: "req-test-1",
    model: "jev-1.13.0",
    questions: OBSERVER_QUESTIONS,
    answers: {
      is_real_defect: { type: "noul", noul: 0 },
      disposition: {
        type: "choice",
        choice: "dismiss",
        probabilities: { patch: 0.1, dismiss: 0.82, "gate-action": 0.08 },
        confidence: 0.9,
      },
    },
    usage: { input_tokens: 500, output_tokens: 3 },
    latency_ms: 123,
    egress_class: "finding-text",
    created_at: "2026-09-22T18:00:00.000Z",
    ...over,
  };
}

/** The fixture's first frontier record — real seeded data, not a synthetic twin. */
function anyFrontier(): TriageRecord {
  return TriageRecordSchema.parse(JSON.parse(readFileSync(FIXTURE_ROUND, "utf8").split("\n")[0]!));
}

/** Runs against the seeded `tmp/corpus` — seeding is the caller's job, so a re-run observes the SAME file. */
async function observe(over: Partial<Parameters<typeof observeRound>[0]> = {}) {
  return observeRound({
    pr: PR,
    round: ROUND,
    corpusDir: join(tmp, "corpus"),
    provenanceDir: join(tmp, "provenance"),
    ...over,
  });
}

// ---------------------------------------------------------------------------
// question contract (LOCKED §3.9 — exactly two questions, nothing else)
// ---------------------------------------------------------------------------

describe("observer question contract", () => {
  test("exactly two questions: is_real_defect (noul) + disposition (choice); no severity, no score", () => {
    expect(Object.keys(OBSERVER_QUESTIONS).sort()).toEqual(["disposition", "is_real_defect"]);
    expect(OBSERVER_QUESTIONS.is_real_defect.type).toBe("noul");
    expect(OBSERVER_QUESTIONS.disposition.type).toBe("choice");
    expect(Object.keys(OBSERVER_QUESTIONS.disposition.criteria).sort()).toEqual([
      "dismiss",
      "gate-action",
      "patch",
    ]);
  });

  test("declares egress class finding-text (stage-1 legal, per ADR 0001)", () => {
    expect(OBSERVER_EGRESS_CLASS).toBe("finding-text");
  });

  test("the judged state carries the finding, its pointer and ids — never the frontier verdict", () => {
    const f = anyFrontier();
    const state = buildState(f, PR, ROUND);
    expect(state).toEqual({
      pr: PR,
      round: ROUND,
      finding_id: "F-101",
      finding_text: f.finding_text,
      diff_context_ref: f.diff_context_ref,
    });
    const s = JSON.stringify(state);
    expect(s).not.toContain("BLOCKER");
    expect(s).not.toContain("disposition");
  });
});

// ---------------------------------------------------------------------------
// answer → record mapping
// ---------------------------------------------------------------------------

describe("answer mapping", () => {
  test("choice → disposition enum: patch/dismiss/gate-action only (LOCKED §3.9)", () => {
    expect(dispositionFromChoice("patch")).toBe("PATCH");
    expect(dispositionFromChoice("dismiss")).toBe("DISMISS");
    expect(dispositionFromChoice("gate-action")).toBe("GATE_ACTION");
    expect(() => dispositionFromChoice("defer")).toThrow(/patch\|dismiss\|gate-action/);
  });

  test("rationale records the noul answer; the probability rides as computed text", () => {
    expect(rationaleFrom(cannedEnvelope())).toBe("jev: is_real_defect=0; disposition=dismiss p=0.82");
    expect(
      rationaleFrom(
        cannedEnvelope({
          answers: {
            is_real_defect: { type: "noul", noul: 1 },
            disposition: { type: "choice", choice: "patch", probabilities: { patch: 1, dismiss: 0, "gate-action": 0 }, confidence: 1 },
          },
        }),
      ),
    ).toBe("jev: is_real_defect=1; disposition=patch p=1");
  });

  test("record fields from a canned envelope: latency/cost derived in code, frontier label copied, arm jev", () => {
    const record = recordFrom(anyFrontier(), cannedEnvelope(), PR, ROUND);
    expect(record.finding_id).toBe("F-101");
    expect(record.label).toBe("BLOCKER"); // severity stays with the lead — copied, not re-judged
    expect(record.labeler).toBe(JEV_LABELER);
    expect(record.arm).toBe("jev");
    expect(record.disposition).toBe("DISMISS");
    expect(record.rationale).toBe("jev: is_real_defect=0; disposition=dismiss p=0.82");
    expect(record.latency_ms).toBe(123);
    expect(record.cost_exact_usd).toBeCloseTo((500 * 0.042) / 1_000_000, 12); // input-token-only billing
    expect(record.cost_estimate_usd).toBeNull();
    expect(record.outcome_confirmed).toBeNull();
    expect(record.created_at).toBe("2026-09-22T18:00:00.000Z");
    expect(TriageRecordSchema.safeParse(record).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// observeRound — mock client, temp dirs
// ---------------------------------------------------------------------------

describe("observeRound (mock, keyless)", () => {
  test("happy path: paired jev records appear alongside the frontier records", async () => {
    seedCorpus(FIXTURE_LINES());
    const result = await observe();
    expect(result.refused).toBeNull();
    expect(result.frontierFindings).toBe(2);
    expect(result.judged).toBe(2);
    expect(result.written).toBe(2);
    expect(result.duplicateSkipped).toBe(0);
    expect(result.ceilingLimit).toBe(DEFAULT_STAGE_CEILING_INPUT_TOKENS);
    expect(result.ceilingObserved).toBe(20); // 2 mock calls × 10 input tokens

    const all = readJsonl(result.recordsFile).map((r) => TriageRecordSchema.parse(r));
    const jev = all.filter((r) => r.arm === "jev");
    expect(jev).toHaveLength(2);
    expect(all.filter((r) => r.arm === "frontier")).toHaveLength(2); // untouched, paired alongside
    for (const r of jev) {
      expect(r.labeler).toBe("jev-1.13.0-observer");
      expect(r.disposition).toBe("PATCH"); // mock answers the first criterion
      expect(r.rationale).toContain("jev: is_real_defect=0.9");
      expect(typeof r.latency_ms).toBe("number");
      expect(r.cost_exact_usd).toBeGreaterThan(0);
    }
    expect(jev.map((r) => r.finding_id).sort()).toEqual(["F-101", "F-102"]);
    expect(jev.every((r) => r.label === (r.finding_id === "F-101" ? "BLOCKER" : "HIGH"))).toBe(true);
  });

  test("idempotent re-run: byte-identical file, everything duplicate-skipped", async () => {
    seedCorpus(FIXTURE_LINES());
    const first = await observe();
    const bytes = readFileSync(first.recordsFile, "utf8");
    const second = await observe();
    expect(readFileSync(second.recordsFile, "utf8")).toBe(bytes);
    expect(second.written).toBe(0);
    expect(second.duplicateSkipped).toBe(2);
    expect(second.judged).toBe(2); // judged again — the recording is what dedupes
  });

  test("missing frontier corpus file → error naming the expected path, nothing written", async () => {
    await expect(observe({ corpusDir: join(tmp, "absent") })).rejects.toThrow(/277-r4\.jsonl/);
    expect(existsSync(join(tmp, "absent"))).toBe(false);
  });

  test("a corpus file with no frontier records → error naming the file", async () => {
    const dir = seedCorpus([frontier("F-900", { arm: "jev" })]);
    await expect(observe({ corpusDir: dir })).rejects.toThrow(/arm="frontier"/);
  });

  test("oversized finding → pre-flight refusal naming it, before any append", async () => {
    const dir = seedCorpus([frontier("F-BIG", { finding_text: "x".repeat(120_000) }), frontier("F-SMALL")]);
    await expect(observe({ corpusDir: dir })).rejects.toThrow(/F-BIG/);
    const all = readJsonl(corpusFilePath(dir, PR, ROUND));
    expect(all).toHaveLength(2); // the seeded frontier rows only — no partial jev writes
  });

  test("ceiling exceeded mid-round: typed refusal naming the finding, judged prefix kept", async () => {
    const dir = seedCorpus([frontier("F-1"), frontier("F-2"), frontier("F-3")]);
    const result = await observe({ corpusDir: dir, ceilingTokens: 15 }); // 10 tokens/mock call → third refused
    expect(result.judged).toBe(2);
    expect(result.written).toBe(2);
    expect(result.refused).not.toBeNull();
    expect(result.refused?.findingId).toBe("F-3");
    expect(result.refused?.unjudged).toEqual(["F-3"]);
    expect(result.refused?.reason).toContain("stage ceiling exceeded");
    const all = readJsonl(result.recordsFile).map((r) => TriageRecordSchema.parse(r));
    expect(all).toHaveLength(5); // 3 frontier + exactly the 2 judged jev records
    expect(all.filter((r) => r.arm === "jev").map((r) => r.finding_id).sort()).toEqual(["F-1", "F-2"]);
  });
});

describe("mode resolution at the observer seam", () => {
  test("default mock with no env and no key (INV-J5)", () => {
    expect(new JudgmentClient({ provenanceDir: join(tmp, "provenance") }).mode).toBe("mock");
  });
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("--pr/--round required; --corpus-dir/--out/--provenance-dir/--ceiling-tokens optional", () => {
    expect(parseArgs(["--pr", "277", "--round", "4"])).toEqual({
      pr: 277,
      round: 4,
      corpusDir: undefined,
      out: undefined,
      provenanceDir: undefined,
      ceilingTokens: undefined,
    });
    expect(
      parseArgs(["--pr=9", "--round=1", "--corpus-dir=c", "--out=o", "--provenance-dir=p", "--ceiling-tokens", "42"]),
    ).toEqual({ pr: 9, round: 1, corpusDir: "c", out: "o", provenanceDir: "p", ceilingTokens: 42 });
    expect(() => parseArgs([])).toThrow(/--pr/);
    expect(() => parseArgs(["--pr", "277"])).toThrow(/--round/);
    expect(() => parseArgs(["--pr", "x", "--round", "1"])).toThrow(/--pr/);
    expect(() => parseArgs(["--pr", "0", "--round", "1"])).toThrow(/--pr/);
  });
});

describe("CLI (subprocess, mock, temp dirs)", () => {
  const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

  function runCli(args: string[], env: Record<string, string> = {}) {
    return Bun.spawnSync({
      cmd: ["bun", join("scripts", "judgment", "observe-round.ts"), ...args],
      cwd: REPO_ROOT,
      env: { ...process.env, TYPESAFE_API_KEY: "", TYPESAFE_MOCK: "", ...env },
    });
  }

  test("happy path exits 0, prints the per-run summary, appends paired records", () => {
    const dir = seedCorpus(FIXTURE_LINES());
    const proc = runCli(["--pr", String(PR), "--round", String(ROUND), "--corpus-dir", dir, "--provenance-dir", join(tmp, "provenance")]);
    expect(proc.exitCode).toBe(0);
    const out = proc.stdout.toString();
    expect(out).toContain("2 frontier findings");
    expect(out).toContain("2 written");
    expect(out).toContain("ceiling 20/");
    expect(readJsonl(corpusFilePath(dir, PR, ROUND))).toHaveLength(4);
  });

  test("missing round exits 2 naming the expected file, with no writes", () => {
    const dir = join(tmp, "empty");
    const proc = runCli(["--pr", String(PR), "--round", String(ROUND), "--corpus-dir", dir, "--provenance-dir", join(tmp, "provenance")]);
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("277-r4.jsonl");
    expect(existsSync(dir)).toBe(false);
  });

  test("mid-round ceiling exits 2 with the partial summary and keeps the judged prefix", () => {
    const dir = seedCorpus([frontier("F-1"), frontier("F-2"), frontier("F-3")]);
    const proc = runCli([
      "--pr", String(PR),
      "--round", String(ROUND),
      "--corpus-dir", dir,
      "--provenance-dir", join(tmp, "provenance"),
      "--ceiling-tokens", "15",
    ]);
    expect(proc.exitCode).toBe(2);
    expect(proc.stdout.toString()).toContain("2 written");
    expect(proc.stderr.toString()).toContain("F-3");
    expect(proc.stderr.toString()).toContain("stage ceiling exceeded");
    const all = readJsonl(corpusFilePath(dir, PR, ROUND)).map((r) => TriageRecordSchema.parse(r));
    expect(all.filter((r) => r.arm === "jev")).toHaveLength(2);
  });

  test("TYPESAFE_MOCK=1 forces mock and the round still runs keyless", () => {
    const dir = seedCorpus(FIXTURE_LINES());
    const proc = runCli(["--pr", String(PR), "--round", String(ROUND), "--corpus-dir", dir, "--provenance-dir", join(tmp, "provenance")], {
      TYPESAFE_MOCK: "1",
    });
    expect(proc.exitCode).toBe(0);
    expect(readJsonl(corpusFilePath(dir, PR, ROUND))).toHaveLength(4);
  });
});
