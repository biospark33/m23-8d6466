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
import { rationaleFrom } from "../../scripts/judgment/observe-round.ts";
import { parseDispositionProbability } from "../../scripts/judgment/route-round.ts";
import { armStateEntryDigest, thresholds, type ArmStateEntry } from "../../src/judgment/arm-gate.ts";
import { TYPESAFE_MODEL, type JudgmentEnvelope } from "../../src/judgment/index.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ROUTE_SRC = join(REPO_ROOT, "scripts", "judgment", "route-round.ts");

/** A manifest entry as parsed from JSON (rationale optional per F18). */
type RoutingEntryJson = { finding_id: string; rationale?: string; armed_state_digest: string };

// The fence.test.ts import-edge scanner (import-from, export-from, and bare
// side-effect edges) — duplicated here because the fence binds src/judgment/,
// not this CLI.
function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g),
  ].map((m) => m[1] ?? "");
}

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
    mkRecord({ finding_id: "F-dismiss-exponent", disposition: "DISMISS", rationale: "jev: is_real_defect=0.05; disposition=dismiss p=1e-7" }),
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

/** An armed run over the given shard (default: the standard partition fixture). */
function armedRun(records: TriageRecord[] = partitionShard()) {
  const corpusDir = tmpDir("route-c-");
  const judgmentDir = tmpDir("route-j-");
  writeShard(corpusDir, records);
  const entries = chainedEntries(1); // genesis flip: recording-only → armed
  writeArmState(judgmentDir, entries);
  const p = runRoute(routeArgs(corpusDir, judgmentDir));
  return { corpusDir, judgmentDir, entries, p };
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
  test("DISMISS p=0.97 → candidate; DISMISS p=0.5, PATCH p=0.99, missing rationale, non-jev arm, clause mismatch, exponent-form p → deep", () => {
    const { corpusDir, judgmentDir, p } = armedRun();
    try {
      expect(p.exitCode).toBe(0);
      const manifest = JSON.parse(readFileSync(join(judgmentDir, "routing", "184-4.json"), "utf8"));
      expect(manifest.pr).toBe(184);
      expect(manifest.round).toBe(4);
      expect(manifest.obvious_dismiss_candidates.map((e: { finding_id: string }) => e.finding_id)).toEqual(["F-dismiss-high"]);
      expect(new Set(manifest.deep_adjudication.map((e: { finding_id: string }) => e.finding_id))).toEqual(
        new Set(["F-dismiss-low", "F-patch-high", "F-no-rationale", "F-frontier-arm", "F-clause-mismatch", "F-dismiss-exponent"]),
      );
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("every entry carries armed_state_digest equal to the manifest armed_digest; rationale present ONLY for jev-arm records with a parseable clause (F18)", () => {
    const { corpusDir, judgmentDir, entries, p } = armedRun();
    try {
      expect(p.exitCode).toBe(0);
      const manifest = JSON.parse(readFileSync(join(judgmentDir, "routing", "184-4.json"), "utf8"));
      expect(manifest.armed_digest).toBe(armStateEntryDigest(entries[0]!));
      const byId = new Map<string, Record<string, unknown>>(
        [...manifest.deep_adjudication, ...manifest.obvious_dismiss_candidates].map((e: RoutingEntryJson) => [e.finding_id, e]),
      );
      for (const e of byId.values()) {
        expect(e["armed_state_digest"]).toBe(manifest.armed_digest);
      }
      // AC4: "the jev rationale" — present exactly when a jev-arm record's
      // recorded rationale yielded a parseable disposition clause; absent (not
      // "" and not frontier text) otherwise.
      expect("rationale" in byId.get("F-dismiss-high")!).toBe(true);
      expect("rationale" in byId.get("F-dismiss-low")!).toBe(true);
      expect("rationale" in byId.get("F-patch-high")!).toBe(true);
      expect("rationale" in byId.get("F-clause-mismatch")!).toBe(true);
      expect("rationale" in byId.get("F-no-rationale")!).toBe(false);
      expect("rationale" in byId.get("F-frontier-arm")!).toBe(false);
      expect(byId.get("F-frontier-arm")).toEqual({ finding_id: "F-frontier-arm", armed_state_digest: manifest.armed_digest });
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
        deep_adjudication: 6,
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

  // The fence.test.ts import-edge scanner, applied to route-round itself: the
  // name blocklist above stays as belt-and-suspenders, but the allowlist is
  // the structural pin — no live-path module can even be imported.
  test("static import specifiers ⊆ node:*, cli-args, corpus merge/schema, arm-gate (F8)", () => {
    const src = readFileSync(ROUTE_SRC, "utf8");
    const specs = importSpecifiers(src);
    expect(specs.length).toBeGreaterThan(0);
    const allowed = new Set(["../lib/cli-args.ts", "../corpus/merge.ts", "../corpus/schema.ts", "../../src/judgment/arm-gate.ts"]);
    const violations = specs.filter((spec) => !spec.startsWith("node:") && !allowed.has(spec));
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Producer/consumer cross-pin: parseDispositionProbability ≡ rationaleFrom (F2)
// ---------------------------------------------------------------------------

/** A minimal-but-honest envelope: rationaleFrom reads only the two answers. */
function mkEnvelope(choice: string, p: number): JudgmentEnvelope {
  return {
    requestId: "req-route-cross-pin",
    model: TYPESAFE_MODEL,
    questions: {},
    answers: {
      is_real_defect: { type: "noul", noul: 0.05 },
      disposition: { type: "choice", choice, probabilities: { [choice]: p }, confidence: p },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
    latency_ms: 1,
    egress_class: "finding-text",
    created_at: "2026-11-04T00:00:00Z",
  };
}

describe("route-round — parseDispositionProbability pinned to observe-round's rationaleFrom (F2)", () => {
  // The agrees()≡outcomeAgrees idiom (arm-gate.test.ts): the consumer must
  // read exactly what the producer writes, or the dismiss lane dies silently
  // with every other test green.
  test("for every asked choice x representative p, the consumer returns the envelope's own choice and exact p", () => {
    for (const choice of ["patch", "dismiss", "gate-action"] as const) {
      for (const p of [1, 0.97, 0.5, 0]) {
        expect(parseDispositionProbability(rationaleFrom(mkEnvelope(choice, p)))).toEqual({ disposition: choice, p });
      }
    }
  });

  test("exponent-form p (1e-7 renders as 'p=1e-7') is not-recorded and routes deep — the documented fail-safe", () => {
    const rationale = rationaleFrom(mkEnvelope("dismiss", 1e-7));
    expect(rationale).toContain("disposition=dismiss p=1e-7");
    expect(parseDispositionProbability(rationale)).toBe("not-recorded");
    // Routes deep is pinned end-to-end by F-dismiss-exponent in the armed
    // manifest describe above.
  });
});

// ---------------------------------------------------------------------------
// Absent shard / malformed corpus / overwrite provenance (F4, F5, F6)
// ---------------------------------------------------------------------------

describe("route-round — absent corpus shard refuses (F4)", () => {
  test("armed state + missing shard file → exit 2 naming the shard, no routing dir or manifest", () => {
    const corpusDir = tmpDir("route-c-"); // shard never written
    const judgmentDir = tmpDir("route-j-");
    try {
      writeArmState(judgmentDir, chainedEntries(1));
      const p = runRoute(routeArgs(corpusDir, judgmentDir));
      expect(p.exitCode).toBe(2);
      const err = p.stderr.toString();
      expect(err).toMatch(/no corpus shard/);
      expect(err).toContain("184-r4.jsonl");
      expect(existsSync(join(judgmentDir, "routing"))).toBe(false);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });
});

describe("route-round — fatal errors are exit 2 with a clean message, never an uncaught stack (F5)", () => {
  test("malformed corpus line in the shard → exit 2, message without a stack trace, nothing written", () => {
    const corpusDir = tmpDir("route-c-");
    const judgmentDir = tmpDir("route-j-");
    try {
      const shard = corpusFilePath(corpusDir, 184, 4);
      mkdirSync(corpusDir, { recursive: true });
      writeFileSync(shard, `${JSON.stringify(partitionShard()[0])}\n{ torn write\n`);
      writeArmState(judgmentDir, chainedEntries(1));
      const p = runRoute(routeArgs(corpusDir, judgmentDir));
      expect(p.exitCode).toBe(2);
      const err = p.stderr.toString();
      expect(err).toMatch(/route-round:/);
      expect(err).not.toMatch(/\n\s*at\s/); // no stack frames
      expect(existsSync(join(judgmentDir, "routing"))).toBe(false);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });
});

describe("route-round — manifest overwrite provenance (F6)", () => {
  test("rerun under a DIFFERENT armed digest → exit 2, the existing manifest byte-unchanged", () => {
    const corpusDir = tmpDir("route-c-");
    const judgmentDir = tmpDir("route-j-");
    try {
      writeShard(corpusDir, partitionShard());
      writeArmState(judgmentDir, chainedEntries(1));
      expect(runRoute(routeArgs(corpusDir, judgmentDir)).exitCode).toBe(0);
      const manifestPath = join(judgmentDir, "routing", "184-4.json");
      const before = readFileSync(manifestPath, "utf8");

      // A second, equally chain-valid armed head with a different digest.
      const alt = chainedEntries(1)[0]!;
      alt.at = "2026-11-05T00:00:00Z";
      writeArmState(judgmentDir, [alt]);

      const p = runRoute(routeArgs(corpusDir, judgmentDir));
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toMatch(/different armed digest/);
      expect(readFileSync(manifestPath, "utf8")).toBe(before);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });

  test("rerun under the SAME armed digest is an idempotent rewrite (exit 0, identical manifest)", () => {
    const corpusDir = tmpDir("route-c-");
    const judgmentDir = tmpDir("route-j-");
    try {
      writeShard(corpusDir, partitionShard());
      writeArmState(judgmentDir, chainedEntries(1));
      expect(runRoute(routeArgs(corpusDir, judgmentDir)).exitCode).toBe(0);
      const manifestPath = join(judgmentDir, "routing", "184-4.json");
      const before = readFileSync(manifestPath, "utf8");
      expect(runRoute(routeArgs(corpusDir, judgmentDir)).exitCode).toBe(0);
      expect(readFileSync(manifestPath, "utf8")).toBe(before);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Partition clamp + strict CLI digits (F12, F14)
// ---------------------------------------------------------------------------

describe("route-round — clause probability must be in [MIN_ROUTE_CONFIDENCE, 1] (F12)", () => {
  test("DISMISS with a percent-style p=97 clause is malformed → deep, never a candidate", () => {
    const { corpusDir, judgmentDir, p } = armedRun([
      mkRecord({ finding_id: "F-dismiss-percent", disposition: "DISMISS", rationale: "jev: is_real_defect=0.01; disposition=dismiss p=97" }),
    ]);
    try {
      expect(p.exitCode).toBe(0);
      const manifest = JSON.parse(readFileSync(join(judgmentDir, "routing", "184-4.json"), "utf8"));
      expect(manifest.obvious_dismiss_candidates).toEqual([]);
      expect(manifest.deep_adjudication.map((e: RoutingEntryJson) => e.finding_id)).toEqual(["F-dismiss-percent"]);
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(judgmentDir, { recursive: true, force: true });
    }
  });
});

describe("route-round — --pr/--round strict plain-digit parse (F14)", () => {
  for (const bad of ["0x10", "1e2", " 5", "0", "-1"]) {
    test(`--pr "${bad}" → exit 2 naming --pr (Number() coercion forms rejected)`, () => {
      const p = runRoute(["--pr", bad, "--round", "4", "--corpus-dir", tmpDir("route-c-"), "--judgment-dir", tmpDir("route-j-")]);
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toMatch(/--pr/);
    });
  }
});
