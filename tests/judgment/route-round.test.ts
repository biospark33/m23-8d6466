/**
 * J2 leaf-1.1.2 — `scripts/judgment/route-round.ts` (AC4): the armed routing
 * surface. While the arm-state head is not a chain-valid armed entry the CLI
 * refuses exit 2 `not-armed` having written nothing; when armed it writes
 * `<judgment-dir>/routing/N-R.json` partitioning the round's records by their
 * RECORDED jev answers only.
 *
 * Fixtures are hand-written inline TriageRecord literals (merge.test.ts
 * precedent — the mock adapter cannot fabricate DISMISS answers, C13) and the
 * armed arm-state.jsonl is built through arm-gate's real digest function so
 * the chain fixtures stay honest (never hand-rolled).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpusFilePath } from "../../scripts/corpus/merge.ts";
import type { TriageRecord } from "../../scripts/corpus/schema.ts";
import { armStateEntryDigest, thresholds, type ArmStateEntry } from "../../src/judgment/arm-gate.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ROUTE_SRC = join(REPO_ROOT, "scripts", "judgment", "route-round.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tmpDir(prefix: string): string {
  return mkdtempSync(join("/tmp", prefix));
}

function mkEntry(seq: number, prev_digest: string | null, from: "recording-only" | "armed", to: "recording-only" | "armed"): ArmStateEntry {
  return {
    seq,
    at: `2026-11-04T00:00:${String(seq).padStart(2, "0")}Z`,
    from,
    to,
    sign_off: `steve 2026-11-04 #${seq}`,
    evidence: {
      confirmed: 240,
      agreed: 60,
      rate: 1,
      ci_lower: 0.9399,
      thresholds: thresholds(),
      corpus_digest: "ab".repeat(32),
    },
    prev_digest,
  };
}

/** Chain-valid entries ending ARMED when n is odd, recording-only when n is even. */
function chainedEntries(n: number): ArmStateEntry[] {
  const entries: ArmStateEntry[] = [];
  let prev: string | null = null;
  for (let s = 1; s <= n; s++) {
    const from = entries.length === 0 ? "recording-only" : entries[entries.length - 1]!.to;
    const to = from === "recording-only" ? "armed" : "recording-only";
    const e = mkEntry(s, prev, from, to);
    entries.push(e);
    prev = armStateEntryDigest(e);
  }
  return entries;
}

function writeArmState(judgmentDir: string, entries: ArmStateEntry[]): void {
  mkdirSync(judgmentDir, { recursive: true });
  writeFileSync(join(judgmentDir, "arm-state.jsonl"), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

/** A full TriageRecord literal with overrides (schema is .strict() — every field explicit). */
function mkRecord(overrides: Partial<TriageRecord> & Pick<TriageRecord, "finding_id" | "disposition">): TriageRecord {
  const { finding_id, disposition, ...rest } = overrides;
  return {
    finding_id,
    finding_text: "finding text",
    diff_context_ref: "a@b",
    label: "LOW",
    disposition,
    rationale: rest.rationale,
    labeler: "jev",
    pr: 184,
    round: 4,
    created_at: "2026-11-04T00:00:00Z",
    arm: "jev",
    latency_ms: null,
    cost_exact_usd: null,
    cost_estimate_usd: null,
    outcome_confirmed: null,
    outcome_source: null,
    ...rest,
  };
}

/** The round's shard: one jev clause per AC4 leg, plus a frontier record and a rationale-less one. */
function partitionShard(): TriageRecord[] {
  return [
    mkRecord({ finding_id: "F-dismiss-high", disposition: "DISMISS", rationale: "jev: is_real_defect=0.05; disposition=dismiss p=0.97" }),
    mkRecord({ finding_id: "F-dismiss-low", disposition: "DISMISS", rationale: "jev: is_real_defect=0.40; disposition=dismiss p=0.5" }),
    mkRecord({ finding_id: "F-patch-high", disposition: "PATCH", rationale: "jev: is_real_defect=0.90; disposition=patch p=0.99" }),
    mkRecord({ finding_id: "F-no-rationale", disposition: "DISMISS" }),
    mkRecord({ finding_id: "F-frontier-arm", disposition: "DISMISS", labeler: "frontier-lead", arm: "frontier", rationale: "obvious noise" }),
    mkRecord({ finding_id: "F-clause-mismatch", disposition: "DISMISS", rationale: "jev: is_real_defect=0.90; disposition=patch p=0.99" }),
  ];
}

function writeShard(corpusDir: string, records: TriageRecord[], pr = 184, round = 4): void {
  mkdirSync(corpusDir, { recursive: true });
  writeFileSync(corpusFilePath(corpusDir, pr, round), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function runRoute(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", join("scripts", "judgment", "route-round.ts"), ...args],
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function routeArgs(corpusDir: string, judgmentDir: string): string[] {
  return ["--pr", "184", "--round", "4", "--corpus-dir", corpusDir, "--judgment-dir", judgmentDir];
}

// ---------------------------------------------------------------------------
// not-armed refusal (INV-ARM-1 fail-closed)
// ---------------------------------------------------------------------------

describe("route-round — not-armed refusal (fail-closed, writes nothing)", () => {
  test("absent or empty arm-state log refuses exit 2 not-armed, writing nothing", () => {
    const corpusDir = tmpDir("route-c-");
    const judgmentDir = tmpDir("route-j-");
    try {
      writeShard(corpusDir, partitionShard());
      for (const lines of [null, ""] as const) {
        if (lines !== null) {
          mkdirSync(judgmentDir, { recursive: true });
          writeFileSync(join(judgmentDir, "arm-state.jsonl"), lines);
        }
        const p = runRoute(routeArgs(corpusDir, judgmentDir));
        expect(p.exitCode).toBe(2);
        expect(p.stderr.toString()).toMatch(/not-armed/);
        expect(existsSync(join(judgmentDir, "routing"))).toBe(false);
      }
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("tampered chain (hand-edited middle entry) refuses exit 2 naming the chain, writing nothing", () => {
    const corpusDir = tmpDir("route-c-");
    const judgmentDir = tmpDir("route-j-");
    try {
      writeShard(corpusDir, partitionShard());
      const entries = chainedEntries(3);
      const edited = JSON.parse(JSON.stringify(entries[1]!)) as ArmStateEntry;
      edited.sign_off = "attacker 2026-11-04";
      writeArmState(judgmentDir, [entries[0]!, edited, entries[2]!]);
      const p = runRoute(routeArgs(corpusDir, judgmentDir));
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toMatch(/not-armed/);
      expect(p.stderr.toString()).toMatch(/chain|prev_digest|digest/i);
      expect(existsSync(join(judgmentDir, "routing"))).toBe(false);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("chain-valid recording-only head still refuses (the head IS the state)", () => {
    const corpusDir = tmpDir("route-c-");
    const judgmentDir = tmpDir("route-j-");
    try {
      writeShard(corpusDir, partitionShard());
      writeArmState(judgmentDir, chainedEntries(2)); // arm then unarm: head recording-only
      const p = runRoute(routeArgs(corpusDir, judgmentDir));
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toMatch(/not-armed/);
      expect(existsSync(join(judgmentDir, "routing"))).toBe(false);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Armed manifest (AC4)
// ---------------------------------------------------------------------------

describe("route-round — armed manifest partition by recorded answers only", () => {
  function armedRun() {
    const corpusDir = tmpDir("route-c-");
    const judgmentDir = tmpDir("route-j-");
    writeShard(corpusDir, partitionShard());
    const entries = chainedEntries(1); // genesis flip: recording-only → armed
    writeArmState(judgmentDir, entries);
    const p = runRoute(routeArgs(corpusDir, judgmentDir));
    return { corpusDir, judgmentDir, entries, p };
  }

  test("DISMISS p=0.97 → candidate; DISMISS p=0.5, PATCH p=0.99, missing rationale, non-jev arm, clause mismatch → deep", () => {
    const { corpusDir, judgmentDir, p } = armedRun();
    try {
      expect(p.exitCode).toBe(0);
      const manifest = JSON.parse(readFileSync(join(judgmentDir, "routing", "184-4.json"), "utf8"));
      expect(manifest.pr).toBe(184);
      expect(manifest.round).toBe(4);
      expect(manifest.obvious_dismiss_candidates.map((e: { finding_id: string }) => e.finding_id)).toEqual(["F-dismiss-high"]);
      expect(new Set(manifest.deep_adjudication.map((e: { finding_id: string }) => e.finding_id))).toEqual(
        new Set(["F-dismiss-low", "F-patch-high", "F-no-rationale", "F-frontier-arm", "F-clause-mismatch"]),
      );
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("every entry carries armed_state_digest equal to the manifest armed_digest and the armed head's digest", () => {
    const { corpusDir, judgmentDir, entries, p } = armedRun();
    try {
      expect(p.exitCode).toBe(0);
      const manifest = JSON.parse(readFileSync(join(judgmentDir, "routing", "184-4.json"), "utf8"));
      expect(manifest.armed_digest).toBe(armStateEntryDigest(entries[0]!));
      for (const e of [...manifest.deep_adjudication, ...manifest.obvious_dismiss_candidates]) {
        expect(e.armed_state_digest).toBe(manifest.armed_digest);
        expect(e.rationale).toBeDefined();
      }
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("prints exactly one summary line: pr, round, armed_digest, and the two counts", () => {
    const { corpusDir, judgmentDir, p } = armedRun();
    try {
      expect(p.exitCode).toBe(0);
      const lines = p.stdout.toString().trim().split("\n");
      expect(lines).toHaveLength(1);
      const summary = JSON.parse(lines[0]!);
      expect(summary).toEqual({
        pr: 184,
        round: 4,
        armed_digest: expect.any(String),
        deep_adjudication: 5,
        obvious_dismiss_candidates: 1,
      });
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 negative control: re-judging live is structurally impossible
// ---------------------------------------------------------------------------

describe("route-round — no live judgment path (AC4 negative control)", () => {
  test("the source imports no provider registry/maker/client/adapter — recorded answers only", () => {
    const src = readFileSync(ROUTE_SRC, "utf8");
    expect(src).not.toMatch(/JUDGMENT_PROVIDERS|resolveProvider|makeJevProvider|makeMockProvider|JudgmentClient|src\/judgment\/adapters|typesafe/);
  });
});
