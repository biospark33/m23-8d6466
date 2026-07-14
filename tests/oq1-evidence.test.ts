/**
 * OQ-1 run-of-record evidence gate (P0.2, review round 4 item D3).
 *
 * Parses the frozen smoke-run JSON at
 * _bmad-output/sprint-artifacts/_research/oq-1-smoke-run-2026-07-13.json and
 * asserts the decision artifact's Evidence claims against its actual schema:
 * strict gate, all checks ok, AC map green, >=2 agents, >=1 message.
 *
 * The JSON is a historical run of record — assertions pin what THAT run
 * recorded, not what a future smoke run must produce.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUN_OF_RECORD = join(
  import.meta.dir,
  "..",
  "_bmad-output",
  "sprint-artifacts",
  "_research",
  "oq-1-smoke-run-2026-07-13.json",
);

interface SmokeRun {
  story: string;
  pi_version: string;
  pinned: boolean;
  agents_registered: number;
  messages_exchanged: number;
  ac_map: Record<string, boolean>;
  checks: { name: string; ok: boolean; detail?: string }[];
  gate_note?: string;
  pass_with_waiver?: boolean;
  pass: boolean;
  paths?: {
    socket_coms?: { sendAcked?: boolean; bAnswered?: boolean; bAnsweredObserved?: boolean };
  };
}

const run = JSON.parse(readFileSync(RUN_OF_RECORD, "utf-8")) as SmokeRun;

describe("oq-1 smoke run of record (2026-07-13)", () => {
  test("passed under the strict gate, no waiver", () => {
    expect(run.pass).toBe(true);
    // The run of record was strict: socket_live_round_trip was gating and
    // there is no pass_with_waiver escape hatch on this report.
    // Gate-note assertion accepts both report-schema generations; the frozen
    // 2026-07-13 JSON is generation 1 — do not silently regenerate in place
    // without updating this test.
    const gateNote = run.gate_note ?? "";
    expect(gateNote).toMatch(/strict/i);
    expect(gateNote).toContain("PI_SMOKE_STRICT");
    expect(run.pass_with_waiver ?? false).toBe(false);
  });

  test("pi version pin recorded", () => {
    expect(run.pinned).toBe(true);
    expect(run.pi_version).toBe("0.55.0");
  });

  test("acceptance criteria map is green", () => {
    expect(run.ac_map["AC1_make_or_break_rpc_roundtrip_+_>=2socket_peers"]).toBe(true);
    expect(run.ac_map.AC3_extension_loads_coms).toBe(true);
    expect(run.ac_map.AC3_extension_loads_coms_net).toBe(true);
  });

  test("make-or-break thresholds met", () => {
    expect(run.agents_registered).toBeGreaterThanOrEqual(2);
    expect(run.messages_exchanged).toBeGreaterThanOrEqual(1);
  });

  test("every recorded check passed, including both live round-trips", () => {
    expect(run.checks.length).toBeGreaterThan(0);
    for (const check of run.checks) {
      expect(check.ok).toBe(true);
    }
    const names = run.checks.map((c) => c.name);
    expect(names).toContain("socket_live_round_trip");
    expect(names).toContain("rpc_live_round_trip");
  });

  test("bAnswered disclosure matches the artifact (detector heuristic, not a failure)", () => {
    // The run of record recorded bAnswered:false despite a successful round
    // trip — the B-side detector was a best-effort stream heuristic. This is
    // disclosed in oq-1-coms-arch-decision.md (Evidence section); the
    // round-trip verdict rests on the sender's acked stream + coms_await.
    // Field assertion accepts both report-schema generations; the frozen
    // 2026-07-13 JSON is generation 1 — do not silently regenerate in place
    // without updating this test. Exactly one of bAnswered (gen 1) or
    // bAnsweredObserved (gen 2) must be present, and it must be false.
    expect(run.paths?.socket_coms?.sendAcked).toBe(true);
    const socketComs = run.paths?.socket_coms ?? {};
    const hasOldField = "bAnswered" in socketComs;
    const hasNewField = "bAnsweredObserved" in socketComs;
    expect(hasOldField !== hasNewField).toBe(true);
    expect(socketComs.bAnswered ?? socketComs.bAnsweredObserved).toBe(false);
  });
});
