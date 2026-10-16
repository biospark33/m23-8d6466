/**
 * A3 · maintenance sweeps F4 — the factory-half suite.
 *
 * Owns (story Files to Modify): staleness + contention (AC3), bounds and the
 * exit-0 pass (AC4), DD-20 join keys (AC5), the one-gate contract (AC1's
 * import/token fence + parked terminal shape), the durable report handoff,
 * and AC2's factory-side spec-seam fixtures (persisted wake vs the
 * enqueueSystemEvent-only shape; the pass's owned transport). Every negative
 * control named in the story is a test that MUST fail the bad shape.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import {
  A6_ALARM,
  type AuditDeps,
  briefIdentity,
  briefJson,
  briefManifest,
  briefRequestId,
  briefTask,
  classifyGraphChild,
  classifySubmit,
  collectAuditHotspots,
  decideGraphLeg,
  FENCED_TARGET_PREFIXES,
  GRAPH_STALENESS_BUDGET_MS,
  type GraphLeg,
  type Hotspot,
  isFencedTarget,
  markReportDelivered,
  MAX_BRIEFS_PER_SWEEP,
  MAX_WALKED_RUNS,
  parseFanInTable,
  planBriefs,
  readSweepReport,
  recentlyBriefed,
  REPORT_RESIDUE_AFTER_MS,
  runSweep,
  type SubmitAnswer,
  type SweepDeps,
  sweepIdFor,
  undeliveredReports,
} from "../../src/maintenance/sweep-plan.ts";
import { BriefSchema } from "../../src/fleet/brief-schema.ts";
import { WorkKeySchema } from "../../src/managers/manager-config.ts";
import { isValidWorkId, UUID_V4_PATTERN } from "../../src/phase-engine/issue-correlation.ts";
import type { RunRecord } from "../../src/providers/run-record.ts";
import { HomeTurnRefusalError, TURN_REFUSALS, createSeamFakes } from "../managers/home-seam-fakes.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const NOW = new Date("2026-10-19T03:17:00.000Z"); // a Monday fire
const BOT = { homeOwnerId: "operator", botId: "bot-maint" };
const REPO = {
  repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
  repoUrl: "https://github.com/Quantum-Digital-Solutions/QDS-Factory",
  commitSha: "a".repeat(40),
};
const HAS_FLOCK = spawnSync("/bin/bash", ["-c", "command -v flock >/dev/null 2>&1"]).status === 0;

// ─── capture ────────────────────────────────────────────────────────────────

let lines: LogEntry[] = [];
let restore: (() => void) | undefined;
beforeEach(() => {
  lines = [];
  restore = setLogSink((e) => {
    if (e.operation === "maintenance.sweep") lines.push(e);
  });
});
afterEach(() => restore?.());
const ev = (name: string) => lines.filter((l) => l.event === name);

const tmps: string[] = [];
function tmp(prefix = "a3-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function rec(runId: string, createdAt: string, extensions?: RunRecord["extensions"]): RunRecord {
  return { runId, createdAt, ...(extensions ? { extensions } : {}) };
}

const hs = (source: "graph" | "audit", target: string, score: number, runIds: string[] = []): Hotspot => ({
  source,
  kind: source === "graph" ? "refactor" : "chain-repair",
  target,
  score,
  runIds,
});

function emptyAudit(over: Partial<AuditDeps> = {}): AuditDeps {
  return {
    listRecords: () => ({ records: [], skipped: 0 }),
    readRecord: () => {
      throw new Error("no record");
    },
    brokenHops: async () => [],
    resultExit: async () => 0,
    ...over,
  };
}

function ack(runId: string, replayed = false): SubmitAnswer {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ schemaVersion: 1, runId, requestId: "x", state: "running", vmName: "vm", replayed })}\n`,
    stderr: "",
  };
}

function deps(over: Partial<SweepDeps> & { stateDir?: string } = {}): SweepDeps & { submits: string[] } {
  const submits: string[] = [];
  let n = 0;
  const stateDir = over.stateDir ?? tmp();
  return {
    now: () => NOW,
    requestId: "req-test",
    stateDir,
    repo: REPO,
    botTarget: BOT,
    graphLeg: async () => ({ status: "fresh", graphAgeMs: 1000, hotspots: [] }),
    audit: emptyAudit(),
    materialize: (b) => ({ briefPath: join(stateDir, `${b.briefId}.brief.json`), manifestPath: `.sandbox/maintenance/${b.briefId}/pipeline.json` }),
    writeBrief: () => {},
    submit: async (_p, rid) => {
      submits.push(rid);
      return ack(`qds-20261019-${(++n).toString(16).padStart(6, "0")}`);
    },
    ...over,
    submits,
  };
}

// ─── identity derivations ───────────────────────────────────────────────────

describe("identity — sweepId, workKey, requestId", () => {
  test("sweepId is the UTC Monday window start; Sunday folds back, Monday is its own start", () => {
    expect(sweepIdFor(new Date("2026-10-19T03:17:00Z"))).toBe("sweep-2026-10-19"); // Monday
    expect(sweepIdFor(new Date("2026-10-19T00:00:00Z"))).toBe("sweep-2026-10-19");
    expect(sweepIdFor(new Date("2026-10-18T23:59:59Z"))).toBe("sweep-2026-10-12"); // Sunday
    expect(sweepIdFor(new Date("2026-10-21T12:00:00Z"))).toBe("sweep-2026-10-19"); // Wednesday
  });

  test("briefRequestId is a strict UUID v4, deterministic per (sweep, workId), distinct across either", () => {
    const a = briefRequestId("sweep-2026-10-19", "maint/2026-10-19/refactor-00000000");
    expect(a).toMatch(UUID_V4_PATTERN);
    expect(briefRequestId("sweep-2026-10-19", "maint/2026-10-19/refactor-00000000")).toBe(a);
    expect(briefRequestId("sweep-2026-10-26", "maint/2026-10-19/refactor-00000000")).not.toBe(a);
    for (let i = 0; i < 200; i++) expect(briefRequestId("sweep-2026-10-19", `w${i}`)).toMatch(UUID_V4_PATTERN);
  });

  test("AC5: the workKey is w:-namespaced and the workId fits BriefSchema's headless leg", () => {
    const id = briefIdentity("sweep-2026-10-19", hs("graph", "src/fleet/dispatch.ts", 9));
    expect(WorkKeySchema.safeParse(id.workKey).success).toBe(true);
    expect(id.workKey).toBe(`w:${id.workId}`);
    expect(isValidWorkId(id.workId)).toBe(true);
    expect(id.workId).toMatch(/^maint\/2026-10-19\/refactor-[0-9a-f]{8}$/);
  });

  test("the generated brief passes the real BriefSchema (workId leg, no issueId)", () => {
    const b = { ...hs("graph", "src/fleet/dispatch.ts", 9), ...briefIdentity("sweep-2026-10-19", hs("graph", "src/fleet/dispatch.ts", 9)) };
    const parsed = BriefSchema.safeParse(briefJson(b, REPO, ".sandbox/maintenance/briefs/x/pipeline.json"));
    expect(parsed.success).toBe(true);
    expect(briefJson(b, REPO, "m")).not.toHaveProperty("issueId");
  });
});

// ─── AC3a: staleness ─────────────────────────────────────────────────────────

describe("AC3(a) — the graph leg is staleness-gated and never silently degraded", () => {
  const fresh = (h: number) => ({ verdict: "fresh", ageHours: h, stampPath: "/g/cli-version.json" });
  const md = "| file | fanIn |\n| --- | --- |\n| src/a.ts | 4 |";

  test("fresh (≤8h) reads the graph and records graph_age_ms", () => {
    const leg = decideGraphLeg(fresh(2), () => ({ markdown: md }));
    expect(leg.status).toBe("fresh");
    if (leg.status === "fresh") {
      expect(leg.graphAgeMs).toBe(7_200_000);
      expect(leg.hotspots.map((h) => h.target)).toEqual(["src/a.ts"]);
    }
  });

  test("the 8h boundary is inclusive-fresh; one ms past refuses", () => {
    expect(decideGraphLeg(fresh(8), () => ({ markdown: md })).status).toBe("fresh");
    expect(decideGraphLeg(fresh(8 + 1 / 3_600_000), () => ({ markdown: md })).status).toBe("graph-stale");
    expect(GRAPH_STALENESS_BUDGET_MS).toBe(8 * 3_600_000);
  });

  test("NEGATIVE CONTROL: a stale/absent/invalid verdict refuses WITHOUT reading the graph", () => {
    for (const v of [
      { verdict: "stale", ageHours: 9, stampPath: "p" },
      { verdict: "absent", ageHours: null, stampPath: "p" },
      { verdict: "invalid", ageHours: null, stampPath: "p" },
      // A verdict that lies "fresh" over an over-budget age is still refused — the
      // named constant decides, not the reader's word.
      { verdict: "fresh", ageHours: 12, stampPath: "p" },
    ]) {
      let read = 0;
      const leg = decideGraphLeg(v, () => {
        read++;
        return { markdown: md };
      });
      expect(leg.status).toBe("graph-stale");
      expect(read).toBe(0);
    }
    expect(decideGraphLeg(undefined, () => ({ markdown: md })).status).toBe("graph-unavailable");
  });

  test("NEGATIVE CONTROL: graph-stale is never folded into a benign zero-hotspot outcome — named, alarmed, plan proceeds audit-only", async () => {
    const d = deps({
      graphLeg: async () => ({ status: "graph-stale", graphAgeMs: 10 * 3_600_000, verdict: "stale", stampPath: "p" }),
      audit: emptyAudit({
        listRecords: () => ({ records: [rec("qds-20261018-aaaaaa", "2026-10-18T00:00:00Z")], skipped: 0 }),
        brokenHops: async () => ["run-cost"],
      }),
    });
    const r = await runSweep(d);
    expect(r.outcome).toBe("complete");
    const skip = ev("sweep-leg-skipped")[0];
    expect(skip?.code).toBe("graph-stale");
    expect(skip?.alarm).toBe(A6_ALARM);
    expect(skip?.graph_age_ms).toBe(36_000_000);
    const plan = ev("sweep-plan")[0];
    expect(plan?.graph_stale).toBe(true);
    expect(plan?.graph_leg).toBe("graph-stale");
    expect(plan?.briefs).toBe(1); // the audit chain alone still briefs
    expect(ev("sweep-complete")[0]?.graph_stale).toBe(true);
  });

  test("the cypher table parser drops unsafe rows (traversal, absolute, non-integer) and keeps order", () => {
    const { hotspots, rejectedRows } = parseFanInTable(
      "| file | fanIn |\n| --- | --- |\n| src/b.ts | 9 |\n| ../etc/passwd | 99 |\n| /abs.ts | 5 |\n| src/c.ts | x |\n| src/a.ts | 3 |",
    );
    expect(hotspots.map((h) => [h.target, h.score])).toEqual([
      ["src/b.ts", 9],
      ["src/a.ts", 3],
    ]);
    expect(rejectedRows).toBe(3);
  });
});

// ─── AC3b: contention ────────────────────────────────────────────────────────

describe("AC3(b) — one flock, two modes: the refresh's exclusive lock skips the sweep's graph read", () => {
  test("child classification: flock refusal (exit 1, silent) is refresh-in-progress; a crash is named, never guessed as contention", () => {
    expect(classifyGraphChild({ exitCode: 1, stdout: "", stderr: "" }).status).toBe("refresh-in-progress");
    const crash = classifyGraphChild({ exitCode: 1, stdout: "", stderr: "error: boom" });
    expect(crash.status).toBe("graph-unavailable");
    const ok: GraphLeg = { status: "fresh", graphAgeMs: 5, hotspots: [] };
    expect(classifyGraphChild({ exitCode: 0, stdout: `${JSON.stringify(ok)}\n`, stderr: "" })).toEqual(ok);
    expect(classifyGraphChild({ exitCode: 0, stdout: "not json", stderr: "" }).status).toBe("graph-unavailable");
  });

  test("refresh-in-progress is a counted, named skip; the sweep proceeds", async () => {
    const r = await runSweep(deps({ graphLeg: async () => ({ status: "refresh-in-progress" }) }));
    expect(r.outcome).toBe("complete");
    expect(ev("sweep-leg-skipped")[0]?.code).toBe("refresh-in-progress");
    expect(ev("sweep-plan")[0]?.graph_leg).toBe("refresh-in-progress");
  });

  test.skipIf(!HAS_FLOCK)(
    "REAL flock: while A6's exclusive lock is held, the sweep's shared non-blocking acquisition refuses and the graph is never read (skipped where flock is absent — macOS dev; util-linux in CI)",
    async () => {
      const home = tmp("a3-graph-");
      const lock = join(home, ".refresh.lock");
      const marker = join(home, "graph-read");
      const fakeGn = join(home, "gitnexus");
      writeFileSync(fakeGn, `#!/bin/sh\ntouch ${marker}\necho '{"markdown":"| file | fanIn |\\n| --- | --- |\\n| src/x.ts | 2 |","row_count":1}'\n`, { mode: 0o755 });
      writeFileSync(join(home, "cli-version.json"), JSON.stringify({ indexedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }));
      const holder = Bun.spawn(["flock", "-x", lock, "sleep", "5"]);
      await Bun.sleep(300);
      const env = { ...process.env, QDS_GITNEXUS_HOME: home, QDS_GITNEXUS_BIN: fakeGn };
      const r = spawnSync("flock", ["-s", "-n", lock, process.execPath, join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "--graph-leg"], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
      });
      holder.kill();
      expect(classifyGraphChild({ exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }).status).toBe("refresh-in-progress");
      expect(existsSync(marker)).toBe(false);
      // Positive control: lock free → the same invocation reads the graph.
      await holder.exited;
      const ok = spawnSync("flock", ["-s", "-n", lock, process.execPath, join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "--graph-leg"], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
      });
      const leg = classifyGraphChild({ exitCode: ok.status ?? -1, stdout: ok.stdout, stderr: ok.stderr });
      expect(leg.status).toBe("fresh");
      expect(existsSync(marker)).toBe(true);
    },
    20_000,
  );

  test("the lock target is A6's own: <graph-home>/.refresh.lock, shared non-blocking — one vocabulary", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "utf8");
    expect(src).toContain('[flock, "-s", "-n", join(home, ".refresh.lock")');
    const wrapper = readFileSync(join(REPO_ROOT, "scripts", "gitnexus-refresh.sh"), "utf8");
    expect(wrapper).toContain('LOCK_FILE="$GRAPH_HOME/.refresh.lock"');
  });
});

// ─── AC3c: audit chain ───────────────────────────────────────────────────────

describe("AC3(c) — audit-chain hotspots over the trailing window, read-only", () => {
  test("windowed runs only; broken hops, exit-6 and fixloop exhaustion aggregate by target with run evidence", async () => {
    const records = [
      rec("qds-20261018-aaaaaa", "2026-10-18T00:00:00Z"),
      rec("qds-20261017-bbbbbb", "2026-10-17T00:00:00Z", {
        fixLoop: { schemaVersion: 1, fixAttemptRunIds: ["gone-1", "gone-2", "gone-3"] },
      } as RunRecord["extensions"]),
      rec("qds-20261001-cccccc", "2026-10-01T00:00:00Z"), // outside the 7-day window
    ];
    const walked: string[] = [];
    const leg = await collectAuditHotspots(
      emptyAudit({
        listRecords: () => ({ records, skipped: 1 }),
        brokenHops: async (id) => {
          walked.push(id);
          return id === "qds-20261018-aaaaaa" ? ["run-cost", "run-cost", "run-box"] : ["run-cost"];
        },
        resultExit: async (id) => (id === "qds-20261018-aaaaaa" ? 6 : 0),
      }),
      NOW,
    );
    expect(walked.sort()).toEqual(["qds-20261017-bbbbbb", "qds-20261018-aaaaaa"]);
    const by = Object.fromEntries(leg.hotspots.map((h) => [h.target, h]));
    expect(by["hop:run-cost"]?.score).toBe(2);
    expect(by["hop:run-cost"]?.runIds).toEqual(["qds-20261017-bbbbbb", "qds-20261018-aaaaaa"]);
    expect(by["hop:run-box"]?.score).toBe(1);
    expect(by["exit-6"]?.runIds).toEqual(["qds-20261018-aaaaaa"]);
    // Three dangling ledger ids = three orphaned (uncharged) attempts = the ceiling.
    expect(by["fixloop-exhausted"]?.runIds).toEqual(["qds-20261017-bbbbbb"]);
    expect(leg.runsInWindow).toBe(2);
    expect(leg.recordsSkipped).toBe(1);
  });

  test("bounded: past MAX_WALKED_RUNS the newest are walked and the rest counted; a failed walk is counted, never fatal", async () => {
    const records = Array.from({ length: MAX_WALKED_RUNS + 3 }, (_, i) =>
      rec(`qds-20261018-${i.toString(16).padStart(6, "0")}`, new Date(NOW.getTime() - (i + 1) * 60_000).toISOString()),
    );
    let calls = 0;
    const leg = await collectAuditHotspots(
      emptyAudit({
        listRecords: () => ({ records, skipped: 0 }),
        brokenHops: async () => {
          if (calls++ === 0) throw new Error("walk-environment-fault");
          return [];
        },
        resultExit: async () => undefined,
      }),
      NOW,
    );
    expect(leg.runsWalked).toBe(MAX_WALKED_RUNS);
    expect(leg.runsNotWalked).toBe(3);
    expect(leg.walksFailed).toBe(1);
    expect(leg.resultsUnavailable).toBe(MAX_WALKED_RUNS);
  });

  test("NEGATIVE CONTROL: the sweep writes no audit row — src/maintenance + the CLI import no audit writer", () => {
    for (const f of ["src/maintenance/sweep-plan.ts", "scripts/maintenance-sweep.ts"]) {
      const src = readFileSync(join(REPO_ROOT, f), "utf8");
      expect(src).not.toMatch(/link-store|openAuditStore|AuditStoreWriter|AUDIT_HOPS\s*[=.[]/);
    }
  });
});

// ─── planning + AC4 bounds ───────────────────────────────────────────────────

describe("planning — deterministic order, fence, cooldown, cap", () => {
  test("audit before graph; score desc; target asc on ties", () => {
    const p = planBriefs(
      "sweep-2026-10-19",
      [hs("graph", "src/z.ts", 50), hs("audit", "exit-6", 1, ["qds-20261018-aaaaaa"]), hs("graph", "src/b.ts", 7), hs("graph", "src/a.ts", 7)],
      new Set(),
    );
    expect(p.briefs.map((b) => b.target)).toEqual(["exit-6", "src/z.ts", "src/a.ts", "src/b.ts"]);
  });

  test("DoD bounds: 6 eligible hotspots → 5 briefs + a counted remainder of 1", () => {
    const six = Array.from({ length: 6 }, (_, i) => hs("graph", `src/f${i}.ts`, 10 - i));
    const p = planBriefs("sweep-2026-10-19", six, new Set());
    expect(p.briefs).toHaveLength(MAX_BRIEFS_PER_SWEEP);
    expect(p.overCap).toBe(1);
  });

  test("never-edit targets are fenced (counted), and the task text carries the same fence", () => {
    const p = planBriefs(
      "sweep-2026-10-19",
      [hs("graph", "src/providers/run-record.ts", 99), hs("graph", "src/audit/chain.ts", 80), hs("graph", "src/gate/gate-runner.ts", 70), hs("graph", "src/lib/x.ts", 3)],
      new Set(),
    );
    expect(p.fenced).toBe(3);
    expect(p.briefs.map((b) => b.target)).toEqual(["src/lib/x.ts"]);
    for (const prefix of FENCED_TARGET_PREFIXES) expect(isFencedTarget({ source: "graph", target: `${prefix}${prefix.endsWith("/") ? "f.ts" : ""}` })).toBe(true);
    const task = briefTask(p.briefs[0]!);
    expect(task).toContain("Never edit: src/providers/**");
    expect(task).toContain("AUDIT_HOPS");
  });

  test("--max-briefs only lowers the cap", () => {
    const six = Array.from({ length: 6 }, (_, i) => hs("graph", `src/f${i}.ts`, 10 - i));
    expect(planBriefs("sweep-2026-10-19", six, new Set(), 1)).toMatchObject({ overCap: 5 });
    expect(planBriefs("sweep-2026-10-19", six, new Set(), 99).briefs).toHaveLength(MAX_BRIEFS_PER_SWEEP);
  });

  test("a target briefed inside the cooldown is deferred and counted; unsafe targets never reach a brief", () => {
    const id = briefIdentity("sweep-2026-10-19", hs("graph", "src/a.ts", 5));
    const p = planBriefs("sweep-2026-10-19", [hs("graph", "src/a.ts", 5), hs("graph", "src/b.ts", 4), hs("audit", "hop:Run Cost; rm -rf", 3)], new Set([id.briefId]));
    expect(p.alreadyBriefed).toBe(1);
    expect(p.unsafe).toBe(1);
    expect(p.briefs.map((b) => b.target)).toEqual(["src/b.ts"]);
  });

  test("the generated manifest mirrors fix-run's two-phase shape and stays within the dispatch ceiling", () => {
    const b = { ...hs("audit", "hop:run-cost", 2, ["qds-20261018-aaaaaa"]), ...briefIdentity("sweep-2026-10-19", hs("audit", "hop:run-cost", 2)) };
    const m = briefManifest(b) as { phases: { kind: string; roster?: string; task?: string }[]; runBudgetMs: number };
    expect(m.phases.map((p) => p.kind)).toEqual(["dispatch_task", "code"]);
    expect(m.phases[0]?.roster).toBe("config/rosters/roster.yaml");
    expect(m.phases[0]?.task).toContain('"run-cost"');
    expect(m.phases[0]?.task).toContain("qds-20261018-aaaaaa");
    expect(m.runBudgetMs).toBeLessThanOrEqual(2_100_000);
  });
});

describe("AC4 — bounded, exiting, per-brief refusals never fail the pass", () => {
  test("submit exit table → outcomes: 5 fleet-busy, 3 setup-gate, 2 rejected, 1 transient, 6 replay, 0 ack", () => {
    const e = (exitCode: number, stdout = "", stderr = "x") => ({ exitCode, stdout, stderr });
    expect(classifySubmit(e(5))).toMatchObject({ kind: "skipped", code: "fleet-busy" });
    expect(classifySubmit(e(3))).toMatchObject({ kind: "skipped", code: "setup-gate" });
    expect(classifySubmit(e(2))).toMatchObject({ kind: "skipped", code: "brief-rejected" });
    expect(classifySubmit(e(1))).toMatchObject({ kind: "skipped", code: "submit-transient" });
    expect(classifySubmit(e(6))).toEqual({ kind: "replay" });
    expect(classifySubmit(ack("qds-20261019-000001"))).toMatchObject({ kind: "dispatched", runId: "qds-20261019-000001" });
    expect(classifySubmit(e(0, "garbage"))).toMatchObject({ kind: "skipped", code: "ack-unrecovered" });
    expect(classifySubmit({ timedOut: true })).toMatchObject({ kind: "skipped", code: "submit-transient" });
  });

  test("NEGATIVE CONTROL: a busy fleet does not abort the sweep — every brief counted skipped, outcome complete", async () => {
    const d = deps({
      graphLeg: async () => ({ status: "fresh", graphAgeMs: 1, hotspots: [hs("graph", "src/a.ts", 3), hs("graph", "src/b.ts", 2)] }),
      submit: async () => ({ exitCode: 5, stdout: "", stderr: "fleet-busy: no headroom" }),
    });
    const r = await runSweep(d);
    expect(r).toMatchObject({ outcome: "complete", counters: { briefs_planned: 2, briefs_dispatched: 0, briefs_skipped: 2, chain_refused: 0 } });
    expect(ev("brief-skipped").map((l) => l.code)).toEqual(["fleet-busy", "fleet-busy"]);
    // runId is ABSENT, not 0, on an undispatched brief.
    for (const l of ev("brief-skipped")) expect(l).not.toHaveProperty("runId");
  });

  test("a setup-gate refusal counts as chain_refused; exit 6 replays once on the same request id", async () => {
    const answers: SubmitAnswer[] = [{ exitCode: 3, stdout: "", stderr: "gate" }, { exitCode: 6, stdout: "", stderr: "" }, ack("qds-20261019-00000b", true)];
    const d = deps({
      graphLeg: async () => ({ status: "fresh", graphAgeMs: 1, hotspots: [hs("graph", "src/a.ts", 3), hs("graph", "src/b.ts", 2)] }),
      submit: async (_p, rid) => {
        d.submits.push(rid);
        return answers.shift()!;
      },
    });
    const r = await runSweep(d);
    expect(r).toMatchObject({ counters: { briefs_dispatched: 1, briefs_skipped: 1, chain_refused: 1 } });
    expect(d.submits[1]).toBe(d.submits[2]); // the replay reuses the brief's request id
  });

  test("NEGATIVE CONTROL: an empty sweep (zero hotspots) completes with briefs_planned 0 — a quiet tick is not a failure", async () => {
    const r = await runSweep(deps());
    expect(r).toMatchObject({ outcome: "complete", counters: { briefs_planned: 0, briefs_dispatched: 0, briefs_skipped: 0 } });
    expect(ev("sweep-complete")).toHaveLength(1);
  });

  test("NEGATIVE CONTROL: no resident shape — no loop/daemon flag, no PID file, no timer in the pass", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "utf8");
    const plan = readFileSync(join(REPO_ROOT, "src", "maintenance", "sweep-plan.ts"), "utf8");
    for (const s of [src, plan]) {
      expect(s).not.toMatch(/setInterval\(|"--daemon"|"--loop"|\.pid["'`]/);
    }
  });
});

// ─── AC1 + AC5 ───────────────────────────────────────────────────────────────

describe("AC1 — the sweep stops at the gate, and the gate is the one gate", () => {
  test("dispatched briefs carry DD-20 join keys (workKey + runId + botId); the report's terminal shape is parked runs, never a merge", async () => {
    const d = deps({ graphLeg: async () => ({ status: "fresh", graphAgeMs: 1, hotspots: [hs("graph", "src/a.ts", 3)] }) });
    await runSweep(d);
    const line = ev("brief-dispatched")[0];
    expect(line).toMatchObject({ botId: "bot-maint", runId: "qds-20261019-000001" });
    expect(WorkKeySchema.safeParse(line?.workKey).success).toBe(true);
    const report = readSweepReport(d.stateDir, "sweep-2026-10-19");
    expect(report?.report.briefs[0]).toMatchObject({ event: "brief-dispatched", botId: "bot-maint", runId: "qds-20261019-000001" });
  });

  test("NEGATIVE CONTROL: no second approval path — no approve verb, approver file, token, merge, chain or push import in the sweep", () => {
    for (const f of ["src/maintenance/sweep-plan.ts", "scripts/maintenance-sweep.ts"]) {
      const src = readFileSync(join(REPO_ROOT, f), "utf8");
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      const imports = src.split("\n").filter((l) => /^\s*(import\b|} from |from ")/.test(l)).join("\n");
      expect(imports).not.toMatch(/approval-gate|approvers|run-completion|fleet\/observe|fleet\/push|fleet\/index|fleet\/approve/);
      expect(code).not.toMatch(/"approve"|'approve'|"enrol"|"--token"|gh pr merge|"merge"/);
      expect(code).not.toMatch(/observeAndDriveChain|harvest\(|teardownSandbox/);
    }
  });

  test("the only fleet verbs the sweep invokes are submit and result", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "utf8");
    const verbs = [...src.matchAll(/Cli\(\["([a-z]+)"/g)].map((m) => m[1]);
    expect(new Set(verbs)).toEqual(new Set(["submit", "result"]));
  });
});

// ─── the durable report handoff ──────────────────────────────────────────────

describe("the report handoff — durable, correlated, delivered once", () => {
  test("persisted pending; a second firing for the same sweep is already-swept (no second dispatch)", async () => {
    const d = deps({ graphLeg: async () => ({ status: "fresh", graphAgeMs: 1, hotspots: [hs("graph", "src/a.ts", 3)] }) });
    await runSweep(d);
    const r = readSweepReport(d.stateDir, "sweep-2026-10-19");
    expect(r).toMatchObject({ deliveryState: "pending", botTarget: BOT, report: { complete: { briefs_dispatched: 1 } } });
    const again = await runSweep(d);
    expect(again).toEqual({ outcome: "already-swept", sweepId: "sweep-2026-10-19" });
    expect(d.submits).toHaveLength(1);
  });

  test("the wake flips only the matching PENDING record, exactly once", async () => {
    const d = deps();
    await runSweep(d);
    expect(markReportDelivered(d.stateDir, "sweep-2026-10-12", NOW)).toBe(false); // another fire's key
    expect(markReportDelivered(d.stateDir, "sweep-2026-10-19", NOW)).toBe(true);
    expect(markReportDelivered(d.stateDir, "sweep-2026-10-19", NOW)).toBe(false); // a duplicate wake delivers nothing twice
    expect(readSweepReport(d.stateDir, "sweep-2026-10-19")?.deliveryState).toBe("delivered");
  });

  test("residue: a report still pending past the next wake is named on the next pass and by undeliveredReports", async () => {
    const stateDir = tmp();
    await runSweep(deps({ stateDir }));
    const later = new Date(NOW.getTime() + REPORT_RESIDUE_AFTER_MS);
    expect(undeliveredReports(stateDir, later)).toEqual(["sweep-2026-10-19"]);
    lines = [];
    await runSweep(deps({ stateDir, now: () => later }));
    expect(ev("sweep-report-undelivered").map((l) => l.sweepId)).toEqual(["sweep-2026-10-19"]);
    expect(ev("sweep-plan")[0]?.reports_undelivered).toBe(1);
  });

  test("cooldown reads prior reports: a dispatched briefId is deferred next week", async () => {
    const stateDir = tmp();
    const hot = [hs("graph", "src/a.ts", 3)];
    await runSweep(deps({ stateDir, graphLeg: async () => ({ status: "fresh", graphAgeMs: 1, hotspots: hot }) }));
    const nextWeek = new Date(NOW.getTime() + 7 * 86_400_000);
    expect(recentlyBriefed(stateDir, nextWeek).size).toBe(1);
    lines = [];
    const r = await runSweep(deps({ stateDir, now: () => nextWeek, graphLeg: async () => ({ status: "fresh", graphAgeMs: 1, hotspots: hot }) }));
    expect(r).toMatchObject({ counters: { briefs_planned: 0 } });
    expect(ev("sweep-plan")[0]?.hotspots_already_briefed).toBe(1);
  });

  test("a report-persist failure is recorded and non-silent, and never unwinds the dispatched briefs", async () => {
    const parent = tmp();
    const stateDir = join(parent, "state");
    writeFileSync(stateDir, "a file where the state dir should be");
    const d = deps({ stateDir, graphLeg: async () => ({ status: "fresh", graphAgeMs: 1, hotspots: [hs("graph", "src/a.ts", 3)] }) });
    const r = await runSweep(d);
    expect(r).toMatchObject({ outcome: "complete", reportPersisted: false, counters: { briefs_dispatched: 1 } });
    expect(ev("sweep-report-failed")[0]?.error).toMatchObject({ code: "report-persist-failed" });
    expect(ev("sweep-complete")[0]?.report_persisted).toBe(false);
  });
});

// ─── AC2: spec-seam fixtures (factory side) ──────────────────────────────────

/**
 * AC2's durability is the fork's persisted schedule store; factory-side, the
 * contract is pinned with a seam fake shaped on `loadSchedules`/`upsertSchedule`
 * (persisted) beside an `enqueueSystemEvent`-shaped in-memory map (the
 * negative control). A restart is a fresh instance over the same backing file.
 */
type ScheduleRow = { id: string; botId: string; cron: string; ownerId: string };
interface WakeSource {
  register(row: ScheduleRow): void;
  restart(): WakeSource;
  due(): ScheduleRow[];
}
function persistedScheduleStore(file: string): WakeSource {
  const load = (): ScheduleRow[] => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ScheduleRow[]) : []);
  return {
    register: (row) => writeFileSync(file, JSON.stringify([...load().filter((r) => r.id !== row.id), row])),
    restart: () => persistedScheduleStore(file),
    due: () => load(),
  };
}
function enqueueSystemEventOnly(): WakeSource {
  const mem = new Map<string, ScheduleRow>(); // hmrSingleton-shaped: dies with the process
  return { register: (row) => mem.set(row.id, row), restart: () => enqueueSystemEventOnly(), due: () => [...mem.values()] };
}
/** The AC2 durability property: a wake registered before a restart still fires after it. */
function wakeSurvivesRestart(source: WakeSource): boolean {
  source.register({ id: "maint-weekly", botId: "bot-maint", cron: "17 3 * * 1", ownerId: "operator" });
  return source.restart().due().some((r) => r.id === "maint-weekly");
}

describe("AC2 — durable wake (spec-seam), owned pass transport, legitimate initiator", () => {
  test("the persisted schedule row refires the wake after a restart", () => {
    expect(wakeSurvivesRestart(persistedScheduleStore(join(tmp(), "schedules.json")))).toBe(true);
  });

  test("NEGATIVE CONTROL: an enqueueSystemEvent-only wake evaporates on restart — it MUST fail the durability property", () => {
    expect(wakeSurvivesRestart(enqueueSystemEventOnly())).toBe(false);
  });

  test("the wake turn carries the schedule owner as initiator; a missing or forged initiator is refused by S02b's vocabulary, never defaulted", () => {
    const fakes = createSeamFakes({ gatewayUrl: "https://gw.example", owner: { kind: "user", id: "operator" } });
    fakes.addBot("bot-maint");
    fakes.reserveBudget("bot-maint", 5);
    const row = persistedScheduleStore(join(tmp(), "s.json"));
    row.register({ id: "maint-weekly", botId: "bot-maint", cron: "17 3 * * 1", ownerId: "operator" });
    const fired = row.restart().due()[0]!;
    fakes.runBotTurn(fired.botId, { initiator: { kind: "user", id: fired.ownerId } });
    expect(fakes.turns).toHaveLength(1);
    for (const initiator of [undefined, { kind: "user" as const, id: "someone-else" }]) {
      let refusal: string | undefined;
      try {
        fakes.runBotTurn("bot-maint", initiator === undefined ? {} : { initiator });
      } catch (e) {
        refusal = e instanceof HomeTurnRefusalError ? e.refusal : "other";
      }
      expect(TURN_REFUSALS as readonly string[]).toContain(refusal ?? "<no refusal>");
    }
    expect(fakes.turns).toHaveLength(1);
  });

  test("the pass owns its transport: the A3 crontab entry fires the script; the wake's observe allowlist stays {status,result}", () => {
    const crontab = readFileSync(join(REPO_ROOT, "deploy", "vps", "crontab.factory"), "utf8");
    const entries = crontab.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#") && !l.startsWith("SHELL="));
    const sweep = entries.filter((l) => l.includes("scripts/maintenance-sweep.ts"));
    expect(sweep).toHaveLength(1);
    expect(sweep[0]).toMatch(/^17 3 \* \* 1 cd \/opt\/qds-factory && PATH="\$HOME\/\.bun\/bin:[^"]*" bun scripts\/maintenance-sweep\.ts >> \/var\/log\/qds\/maintenance-sweep\.log 2>&1$/);
    // The CLI header quotes the entry byte-for-byte (A6's G4 discipline).
    const header = readFileSync(join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "utf8").split("\n").map((l) => l.replace(/^\/\/\s+/, ""));
    expect(header).toContain(sweep[0] ?? "<no sweep entry>");
    // NEGATIVE CONTROL: a wake/protocol step that executes the script is outside
    // Z2's read-only observe allowlist — the shape MUST be refused.
    const Z2_OBSERVE_ALLOWLIST = new Set(["status", "result"]);
    const executesScript = (step: { verb: string }) => !Z2_OBSERVE_ALLOWLIST.has(step.verb);
    expect(executesScript({ verb: "result" })).toBe(false);
    expect(executesScript({ verb: "maintenance-sweep" })).toBe(true);
  });
});

// ─── the real binary ─────────────────────────────────────────────────────────

describe("A3 — the bounded CLI (bun scripts/maintenance-sweep.ts)", () => {
  const work = tmp("a3-cli-");
  // The state dir must sit under the repo root (dispatch resolves manifestPath
  // there); .sandbox/ is gitignored. Removed after the suite.
  const stateDir = join(REPO_ROOT, ".sandbox", `a3-test-${process.pid}`);
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  const config = {
    homes: [{ owner: { kind: "user", id: "operator" }, gatewayBaseUrl: "https://gateway.internal" }],
    bots: [
      { id: "bot-dev", department: "dev", spendCeilingUsd: 5 },
      { id: "bot-qa", department: "qa", spendCeilingUsd: 5 },
      { id: "bot-maint", department: "maintenance", spendCeilingUsd: 5 },
    ],
  };
  const configPath = join(work, "manager.json");
  writeFileSync(configPath, JSON.stringify(config));
  const fleetEntry = join(work, "fake-fleet.mjs");
  writeFileSync(
    fleetEntry,
    `const verb = process.argv[2];
if (verb === "submit") { console.log(JSON.stringify({ schemaVersion: 1, runId: "qds-20261019-0000aa", requestId: process.argv[process.argv.indexOf("--request-id") + 1], state: "running", vmName: "vm", replayed: false })); process.exit(0); }
if (verb === "result") process.exit(0);
process.exit(2);
`,
  );

  let seq = 0;
  async function run(args: string[], env: Record<string, string> = {}) {
    const leg = join(work, `leg-${++seq}`);
    mkdirSync(leg, { recursive: true });
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        QDS_LOG_VERBOSE: "1",
        QDS_RUNS_DIR: join(leg, "runs"),
        QDS_SWEEP_STATE_DIR: join(stateDir, `leg-${seq}`),
        QDS_SWEEP_FLEET_ENTRY: fleetEntry,
        QDS_GITNEXUS_HOME: join(leg, "no-graph-home"),
        QDS_AUDIT_DB: join(leg, "audit.db"),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  }

  test(
    "an empty sweep exits 0 with briefs_planned 0, the stale graph named, and a pending report persisted",
    async () => {
      const { code, stdout } = await run(["--config", configPath]);
      expect(code).toBe(0);
      expect(stdout).toContain('"event":"sweep-leg-skipped"');
      expect(stdout).toContain('"code":"graph-stale"');
      const complete = stdout
        .split("\n")
        .filter((l) => l.includes('"event":"sweep-complete"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>)[0];
      expect(complete).toMatchObject({ briefs_planned: 0, briefs_dispatched: 0, graph_stale: true });
      const reports = join(stateDir, `leg-${seq}`, "sweep-reports");
      expect(existsSync(reports)).toBe(true);
    },
    60_000,
  );

  test.skipIf(!HAS_FLOCK)(
    "a fresh graph briefs and submits through the real binary: brief + manifest + roster written under the state dir, ack runId on the line",
    async () => {
      const home = join(work, "graph-home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "cli-version.json"), JSON.stringify({ indexedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }));
      const fakeGn = join(work, "gitnexus");
      writeFileSync(fakeGn, `#!/bin/sh\necho '{"markdown":"| file | fanIn |\\n| --- | --- |\\n| src/lib/x.ts | 2 |","row_count":1}'\n`, { mode: 0o755 });
      const { code, stdout } = await run(["--config", configPath], { QDS_GITNEXUS_HOME: home, QDS_GITNEXUS_BIN: fakeGn });
      expect(code).toBe(0);
      expect(stdout).toContain('"event":"brief-dispatched"');
      expect(stdout).toContain('"runId":"qds-20261019-0000aa"');
      expect(stdout).toContain('"botId":"bot-maint"');
    },
    60_000,
  );

  test("usage and config refusals exit 2 before any sweep", async () => {
    expect((await run(["--daemon"])).code).toBe(2);
    expect((await run(["--driver", "fake"])).code).toBe(2);
    expect((await run(["--max-briefs", "6"])).code).toBe(2);
    expect((await run(["--max-briefs", "0"])).code).toBe(2);
    expect((await run(["--config", join(work, "missing.json")])).code).toBe(2);
    const org = join(work, "org.json");
    writeFileSync(org, JSON.stringify({ ...config, homes: [{ owner: { kind: "org", id: "acme" }, gatewayBaseUrl: "https://gateway.internal" }] }));
    const refused = await run(["--config", org]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("org-owner-refused");
  }, 60_000);
});
