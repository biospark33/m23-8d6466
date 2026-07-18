/**
 * OQ-1 run-of-record evidence gate (P0.2, review round 4 item D3).
 *
 * Parses the frozen smoke-run JSONs under
 * _bmad-output/sprint-artifacts/_research/ and asserts each decision
 * artifact's Evidence claims against its actual schema: strict gate, all
 * checks ok, AC map green, >=2 agents, >=1 message.
 *
 * Two report generations are exercised:
 *   - gen 1 (2026-07-13): gate_note "PI_SMOKE_STRICT=1: ...", no `strict`
 *     field, bAnswered detector field.
 *   - gen 2 (2026-07-14): gate_note "STRICT (default): ...", explicit
 *     `strict: true`, bAnsweredObserved field.
 * The JSONs are historical runs of record — assertions pin what THOSE runs
 * recorded, not what a future smoke run must produce.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RESEARCH_DIR = join(import.meta.dir, "..", "_bmad-output", "sprint-artifacts", "_research");
const RUN_GEN1 = join(RESEARCH_DIR, "oq-1-smoke-run-2026-07-13.json");
const RUN_GEN2 = join(RESEARCH_DIR, "oq-1-smoke-run-2026-07-14.json");

interface SmokeRun {
  story: string;
  pi_version: string;
  pinned: boolean;
  agents_registered: number;
  messages_exchanged: number;
  ac_map: Record<string, boolean>;
  checks: { name: string; ok: boolean; detail?: string }[];
  strict?: boolean;
  gate_note?: string;
  pass_with_waiver?: boolean;
  pass: boolean;
  paths?: {
    socket_coms?: { sendAcked?: boolean; bAnswered?: boolean; bAnsweredObserved?: boolean };
  };
}

const runGen1 = JSON.parse(readFileSync(RUN_GEN1, "utf-8")) as SmokeRun;
const runGen2 = JSON.parse(readFileSync(RUN_GEN2, "utf-8")) as SmokeRun;

// Strict-gate assertions shared across both report generations. Both
// gate_note forms contain "PI_SMOKE_STRICT" + "strict" + the gating phrasing,
// and neither carries a bare "waived"/"waiver" marker (the gen-2 note's
// "...to waive it" is deliberately not matched by \bwaiv(?:ed|er)\b).
//
// Gen-2 reports (gate_note "STRICT (default)") MUST carry an explicit
// `strict: true` — a regenerated gen-2 report that drops the flag must FAIL
// this gate, not pass by skipping the `"strict" in run` guard. Gen-1 (frozen
// 2026-07-13 run of record) predates the field, so only assert when present.
function assertStrictGate(r: SmokeRun): void {
  expect(r.pass).toBe(true);
  expect(r.pass_with_waiver ?? false).toBe(false);
  const gateNote = r.gate_note ?? "";
  expect(gateNote).toMatch(/strict/i);
  expect(gateNote).toContain("PI_SMOKE_STRICT");
  expect(gateNote).toMatch(/socket_live_round_trip is gating/);
  expect(gateNote).not.toMatch(/\bwaiv(?:ed|er)\b/i);
  const isGen2 = /STRICT \(default\)/i.test(gateNote);
  if (isGen2) {
    expect(r.strict).toBe(true);
  } else if ("strict" in r) {
    expect(r.strict).toBe(true);
  }
}

describe("oq-1 smoke run of record — generation 1 (2026-07-13)", () => {
  test("passed under the strict gate, no waiver", () => {
    assertStrictGate(runGen1);
  });

  test("pi version pin recorded", () => {
    expect(runGen1.pinned).toBe(true);
    expect(runGen1.pi_version).toBe("0.55.0");
  });

  test("acceptance criteria map is green", () => {
    expect(runGen1.ac_map["AC1_make_or_break_rpc_roundtrip_+_>=2socket_peers"]).toBe(true);
    expect(runGen1.ac_map.AC3_extension_loads_coms).toBe(true);
    expect(runGen1.ac_map.AC3_extension_loads_coms_net).toBe(true);
  });

  test("make-or-break thresholds met", () => {
    expect(runGen1.agents_registered).toBeGreaterThanOrEqual(2);
    expect(runGen1.messages_exchanged).toBeGreaterThanOrEqual(1);
  });

  test("every recorded check passed, including both live round-trips", () => {
    expect(runGen1.checks.length).toBeGreaterThan(0);
    for (const check of runGen1.checks) {
      expect(check.ok).toBe(true);
    }
    const names = runGen1.checks.map((c) => c.name);
    expect(names).toContain("socket_live_round_trip");
    expect(names).toContain("rpc_live_round_trip");
  });

  test("bAnswered disclosure matches the artifact (detector heuristic, not a failure)", () => {
    // The gen-1 run of record recorded bAnswered:false despite a successful
    // round trip — the B-side detector was a best-effort stream heuristic.
    // This is disclosed in oq-1-coms-arch-decision.md (Evidence section); the
    // round-trip verdict rests on the sender's acked stream + coms_await.
    // Gen-1 carries bAnswered; gen-2 carries bAnsweredObserved. Exactly one of
    // them must be present, and it must be false.
    expect(runGen1.paths?.socket_coms?.sendAcked).toBe(true);
    const socketComs = runGen1.paths?.socket_coms ?? {};
    const hasOldField = "bAnswered" in socketComs;
    const hasNewField = "bAnsweredObserved" in socketComs;
    expect(hasOldField !== hasNewField).toBe(true);
    expect(socketComs.bAnswered ?? socketComs.bAnsweredObserved).toBe(false);
  });
});

describe("oq-1 smoke run of record — generation 2 (2026-07-14)", () => {
  test("passed under the strict gate with explicit strict:true", () => {
    // Gen-2 reports carry the explicit `strict` flag. The frozen 2026-07-13
    // run is gen 1 (no strict field), so without this fixture the
    // `strict: true` requirement in assertStrictGate never runs — a
    // regenerated gen-2 report that drops `strict` would pass silently.
    assertStrictGate(runGen2);
    expect(runGen2.strict).toBe(true);
  });

  test("acceptance criteria map is green", () => {
    expect(runGen2.ac_map["AC1_make_or_break_rpc_roundtrip_+_>=2socket_peers"]).toBe(true);
    expect(runGen2.ac_map.AC3_extension_loads_coms).toBe(true);
    expect(runGen2.ac_map.AC3_extension_loads_coms_net).toBe(true);
  });

  test("make-or-break thresholds met", () => {
    expect(runGen2.agents_registered).toBeGreaterThanOrEqual(2);
    expect(runGen2.messages_exchanged).toBeGreaterThanOrEqual(1);
  });

  test("every recorded check passed, including both live round-trips", () => {
    expect(runGen2.checks.length).toBeGreaterThan(0);
    for (const check of runGen2.checks) {
      expect(check.ok).toBe(true);
    }
    const names = runGen2.checks.map((c) => c.name);
    expect(names).toContain("socket_live_round_trip");
    expect(names).toContain("rpc_live_round_trip");
  });

  test("bAnsweredObserved disclosure matches the artifact (detector heuristic, not a failure)", () => {
    expect(runGen2.paths?.socket_coms?.sendAcked).toBe(true);
    const socketComs = runGen2.paths?.socket_coms ?? {};
    const hasOldField = "bAnswered" in socketComs;
    const hasNewField = "bAnsweredObserved" in socketComs;
    expect(hasOldField !== hasNewField).toBe(true);
    expect(socketComs.bAnswered ?? socketComs.bAnsweredObserved).toBe(false);
  });

  test("a gen-2 report missing strict fails the gate (not silently skipped)", () => {
    // Omitting strict from a "STRICT (default)" report must fail the gate —
    // the `"strict" in run` guard must not turn a missing flag into a pass.
    const { strict: _omit, ...missing } = runGen2;
    expect(() => assertStrictGate(missing as SmokeRun)).toThrow();
  });

  test("a gen-2 report with strict:false fails the gate", () => {
    expect(() => assertStrictGate({ ...runGen2, strict: false })).toThrow();
  });
});
