/**
 * A3 · maintenance sweeps F4 — the factory-half suite.
 *
 * Owns (story Files to Modify): staleness + contention (AC3), bounds and the
 * exit-0 pass (AC4), DD-20 join keys (AC5), the one-gate contract (AC1's
 * import/token fence + parked terminal shape + the never-edit tripwire on the
 * box's diff), the durable report handoff, the audit store's
 * read-only snapshot, and AC2's factory-side spec-seam fixtures (persisted
 * wake vs the enqueueSystemEvent-only shape; the pass's owned transport).
 * Every negative control named in the story is a test that MUST fail the bad
 * shape.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import {
  A6_ALARM,
  ackOf,
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
  persistSweepReport,
  planBriefs,
  readSweepReport,
  recentlyBriefed,
  REPORT_RESIDUE_AFTER_MS,
  runSweep,
  type SubmitAnswer,
  type SweepDeps,
  type SweepReport,
  sweepIdFor,
  sweepRunMeta,
  undeliveredReports,
  undeliveredReportsWithProblems,
} from "../../src/maintenance/sweep-plan.ts";
import { AUDIT_DB_DEFAULT, cypherJson, parseGithubRemote, snapshotAuditDb } from "../../scripts/maintenance-sweep.ts";
import { BriefSchema } from "../../src/fleet/brief-schema.ts";
import { WorkKeySchema } from "../../src/managers/manager-config.ts";
import { isValidWorkId, UUID_V4_PATTERN } from "../../src/phase-engine/issue-correlation.ts";
import type { RunRecord } from "../../src/providers/run-record.ts";
import { acquireRunLock, isAlive, releaseRunLock } from "../../scripts/lib/run-lock.ts";
import { HomeTurnRefusalError, TURN_REFUSALS, createSeamFakes } from "../managers/home-seam-fakes.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const NOW = new Date("2026-10-19T03:17:00.000Z"); // a Monday fire
const SWEEP = "sweep-2026-10-19";
const BOT = { homeOwnerId: "operator", botId: "bot-maint" };
const REPO = {
  repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
  repoUrl: "https://github.com/Quantum-Digital-Solutions/QDS-Factory",
  commitSha: "a".repeat(40),
};
const HAS_FLOCK = spawnSync("/bin/bash", ["-c", "command -v flock >/dev/null 2>&1"]).status === 0;
const DAY = 86_400_000;

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

/** A closed run that reached a PR, unless told otherwise (`closedAt` = createdAt + 1 h by default). */
function rec(runId: string, createdAt: string, opts: { closed?: boolean; closedAt?: string; pr?: boolean; extensions?: Record<string, unknown> } = {}): RunRecord {
  const closedAt = opts.closedAt ?? new Date(Date.parse(createdAt) + 3_600_000).toISOString();
  const ext: Record<string, unknown> = { ...(opts.pr === false ? {} : { pr: { schemaVersion: 1, prUrl: "https://github.com/o/r/pull/1" } }), ...(opts.extensions ?? {}) };
  return {
    runId,
    createdAt,
    ...(opts.closed === false ? {} : { closedAt }),
    ...(Object.keys(ext).length === 0 ? {} : { extensions: ext as RunRecord["extensions"] }),
  } as RunRecord;
}

const hs = (source: "graph" | "audit", target: string, score: number, runIds: string[] = []): Hotspot => ({
  source,
  kind: source === "graph" ? "refactor" : "chain-repair",
  target,
  score,
  runIds,
});
const fresh = (hotspots: Hotspot[] = []): GraphLeg => ({ status: "fresh", graphAgeMs: 1, hotspots, rejectedRows: 0 });

function emptyAudit(over: Partial<AuditDeps> = {}): AuditDeps {
  return {
    listRecords: () => ({ records: [], skipped: 0 }),
    readRecord: () => {
      throw new Error("no record");
    },
    brokenHops: async () => [],
    ...over,
  };
}

function ack(runId: string, replayed = false, requestId = "x"): SubmitAnswer {
  // A real submit stdout carries the CLI's own JSONL log lines beside the ack.
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ requestId: "log", operation: "fleet.submit", status: "ok" })}\n${JSON.stringify({ schemaVersion: 1, runId, requestId, state: "running", vmName: "vm", replayed })}\n${JSON.stringify({ operation: "fleet.verb", exit: 0 })}\n`,
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
    graphLeg: async () => fresh(),
    audit: emptyAudit(),
    materialize: (b) => ({ briefPath: join(stateDir, `${b.briefId}.brief.json`), manifestPath: `.sandbox/maintenance/${b.briefId}/pipeline.json` }),
    writeBrief: () => {},
    submit: async (_p, rid) => {
      submits.push(rid);
      return ack(`qds-20261019-${(++n).toString(16).padStart(6, "0")}`, false, rid);
    },
    ...over,
    submits,
  };
}

function report(sweepId: string, createdAt: string, briefs: SweepReport["report"]["briefs"], deliveryState: "pending" | "delivered" = "pending"): SweepReport {
  return {
    schemaVersion: 1,
    sweepId,
    window: { from: createdAt, to: createdAt },
    botTarget: BOT,
    report: {
      complete: {
        briefs_planned: briefs.length,
        briefs_dispatched: briefs.filter((b) => b.event === "brief-dispatched").length,
        briefs_skipped: briefs.filter((b) => b.event === "brief-skipped").length,
        graph_stale: false,
        graph_leg: "fresh",
        chain_refused: 0,
      },
      briefs,
    },
    deliveryState,
    createdAt,
  };
}

// ─── identity derivations ───────────────────────────────────────────────────

describe("identity — sweepId, workKey, requestId", () => {
  test("sweepId is the UTC Monday on/before now+14h — a Monday 03:17 fire on any host timezone keys the same week; manual runs Mon–Sat key their own week", () => {
    expect(sweepIdFor(new Date("2026-10-19T03:17:00Z"))).toBe(SWEEP); // UTC host
    expect(sweepIdFor(new Date("2026-10-18T13:17:00Z"))).toBe(SWEEP); // UTC+14 host: Sunday 13:17 UTC
    expect(sweepIdFor(new Date("2026-10-18T22:17:00Z"))).toBe(SWEEP); // UTC+5 host
    expect(sweepIdFor(new Date("2026-10-19T15:17:00Z"))).toBe(SWEEP); // UTC−12 host
    expect(sweepIdFor(new Date("2026-10-23T12:00:00Z"))).toBe(SWEEP); // a Friday manual run keys THIS week
    expect(sweepIdFor(new Date("2026-10-25T09:59:59Z"))).toBe(SWEEP); // the last Sunday instant that keys this week
    // The documented price of the timezone lead: from Sunday 10:00 UTC a manual run keys the COMING week.
    expect(sweepIdFor(new Date("2026-10-25T10:00:00Z"))).toBe("sweep-2026-10-26");
    expect(sweepIdFor(new Date("2026-10-26T03:17:00Z"))).toBe("sweep-2026-10-26"); // the next Monday's fire
    expect(sweepIdFor(new Date("2026-12-31T12:00:00Z"))).toBe("sweep-2026-12-28"); // year boundary
    expect(sweepIdFor(new Date("2027-01-03T09:00:00Z"))).toBe("sweep-2026-12-28");
  });

  test("briefRequestId is a strict UUID v4, deterministic per (sweep, workId), distinct across either", () => {
    const a = briefRequestId(SWEEP, "maint/2026-10-19/refactor-00000000", REPO.commitSha);
    expect(a).toMatch(UUID_V4_PATTERN);
    expect(briefRequestId(SWEEP, "maint/2026-10-19/refactor-00000000", REPO.commitSha)).toBe(a);
    expect(briefRequestId("sweep-2026-10-26", "maint/2026-10-19/refactor-00000000", REPO.commitSha)).not.toBe(a);
    for (let i = 0; i < 200; i++) expect(briefRequestId(SWEEP, `w${i}`, REPO.commitSha)).toMatch(UUID_V4_PATTERN);
    // A redeploy mid-week is a different brief: the replay key covers the commit.
    expect(briefRequestId(SWEEP, "maint/2026-10-19/refactor-00000000", "b".repeat(40))).not.toBe(a);
  });

  test("AC5: the workKey is w:-namespaced and the workId fits BriefSchema's headless leg", () => {
    const id = briefIdentity(SWEEP, hs("graph", "src/fleet/dispatch.ts", 9), REPO.commitSha);
    expect(WorkKeySchema.safeParse(id.workKey).success).toBe(true);
    expect(id.workKey).toBe(`w:${id.workId}`);
    expect(isValidWorkId(id.workId)).toBe(true);
    expect(id.workId).toMatch(/^maint\/2026-10-19\/refactor-[0-9a-f]{8}$/);
  });

  test("origin parsing: github https/ssh/scp forms with optional .git and trailing slash; credentials and other hosts refused", () => {
    for (const r of ["https://github.com/o/r", "https://github.com/o/r.git", "https://github.com/o/r/", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git"]) {
      expect(parseGithubRemote(r)).toBe("o/r");
    }
    for (const r of ["https://tok@github.com/o/r", "https://user:pw@github.com/o/r.git", "https://gitlab.com/o/r", "git@github.com:o/r/extra", "file:///o/r"]) {
      expect(parseGithubRemote(r)).toBeUndefined();
    }
  });

  test("the generated brief passes the real BriefSchema (workId leg, no issueId)", () => {
    const b = { ...hs("graph", "src/fleet/dispatch.ts", 9), ...briefIdentity(SWEEP, hs("graph", "src/fleet/dispatch.ts", 9), REPO.commitSha) };
    expect(BriefSchema.safeParse(briefJson(b, REPO, ".sandbox/maintenance/briefs/x/pipeline.json")).success).toBe(true);
    expect(briefJson(b, REPO, "m")).not.toHaveProperty("issueId");
  });
});

// ─── AC3a: staleness ─────────────────────────────────────────────────────────

describe("AC3(a) — the graph leg is staleness-gated and never silently degraded", () => {
  const v = (h: number) => ({ verdict: "fresh", ageHours: h, stampPath: "/g/cli-version.json" });
  const md = "| file | fanIn |\n| --- | --- |\n| src/a.ts | 4 |\n| ../x | 9 |";

  test("fresh (≤8h) reads the graph, records graph_age_ms, and carries the rejected-row count", () => {
    const leg = decideGraphLeg(v(2), () => ({ markdown: md }));
    expect(leg).toMatchObject({ status: "fresh", graphAgeMs: 7_200_000, rejectedRows: 1 });
    if (leg.status === "fresh") expect(leg.hotspots.map((h) => h.target)).toEqual(["src/a.ts"]);
  });

  test("the 8h boundary is inclusive-fresh; one ms past refuses", () => {
    expect(decideGraphLeg(v(8), () => ({ markdown: md })).status).toBe("fresh");
    expect(decideGraphLeg(v(8 + 1 / 3_600_000), () => ({ markdown: md })).status).toBe("graph-stale");
    expect(GRAPH_STALENESS_BUDGET_MS).toBe(8 * 3_600_000);
  });

  test("NEGATIVE CONTROL: a stale/absent/invalid verdict refuses WITHOUT reading the graph", () => {
    for (const verdict of [
      { verdict: "stale", ageHours: 9, stampPath: "p" },
      { verdict: "absent", ageHours: null, stampPath: "p" },
      { verdict: "invalid", ageHours: null, stampPath: "p" },
      // A verdict that says "fresh" over an over-budget age is still refused — the
      // named constant decides, not the reader's word.
      { verdict: "fresh", ageHours: 12, stampPath: "p" },
    ]) {
      let read = 0;
      const leg = decideGraphLeg(verdict, () => {
        read++;
        return { markdown: md };
      });
      expect(leg.status).toBe("graph-stale");
      expect(read).toBe(0);
    }
    expect(decideGraphLeg(undefined, () => ({ markdown: md })).status).toBe("graph-unavailable");
    // Small negative ages are clock skew (fresh); a stamp hours in the future is a bad stamp.
    expect(decideGraphLeg(v(-0.5), () => ({ markdown: md })).status).toBe("fresh");
    expect(decideGraphLeg(v(-2), () => ({ markdown: md })).status).toBe("graph-stale");
  });

  test("NEGATIVE CONTROL: graph-stale is never folded into a benign zero-hotspot outcome — named, alarmed, in the counters, plan proceeds audit-only", async () => {
    const d = deps({
      graphLeg: async () => ({ status: "graph-stale", graphAgeMs: 10 * 3_600_000, verdict: "stale", stampPath: "p" }),
      audit: emptyAudit({
        listRecords: () => ({ records: [rec("qds-20261018-aaaaaa", "2026-10-18T00:00:00Z")], skipped: 0 }),
        brokenHops: async () => ["run-cost"],
      }),
    });
    const r = await runSweep(d);
    expect(r.outcome).toBe("complete");
    expect(ev("sweep-leg-skipped")[0]).toMatchObject({ code: "graph-stale", alarm: A6_ALARM, graph_age_ms: 36_000_000 });
    expect(ev("sweep-plan")[0]).toMatchObject({ graph_stale: true, graph_leg: "graph-stale", briefs: 1 });
    expect(ev("sweep-complete")[0]).toMatchObject({ graph_stale: true, graph_leg: "graph-stale" });
    expect(readSweepReport(d.stateDir, SWEEP)?.report.complete.graph_leg).toBe("graph-stale");
  });

  test("a graph leg that was never read is distinguishable from a fresh empty one in the persisted counters", async () => {
    const d = deps({ graphLeg: async () => ({ status: "graph-unavailable", message: "flock not found" }) });
    await runSweep(d);
    expect(readSweepReport(d.stateDir, SWEEP)?.report.complete).toMatchObject({ graph_stale: false, graph_leg: "graph-unavailable" });
    expect(ev("sweep-leg-skipped")[0]?.error).toMatchObject({ code: "graph-unavailable" });
  });

  test("the cypher table parser drops unsafe rows (traversal, absolute, non-integer, zero) and keeps order", () => {
    const { hotspots, rejectedRows } = parseFanInTable(
      "| file | fanIn |\n| :--- | ---: |\n| src/b.ts | 9 |\n| ../etc/passwd | 99 |\n| /abs.ts | 5 |\n| src/c.ts | x |\n| src/z.ts | 0 |\n| src/a.ts | 3 |",
    );
    expect(hotspots.map((h) => [h.target, h.score])).toEqual([
      ["src/b.ts", 9],
      ["src/a.ts", 3],
    ]);
    expect(rejectedRows).toBe(4);
  });

  test("rejected rows surface on the plan line (counted, never silent)", async () => {
    await runSweep(deps({ graphLeg: async () => ({ status: "fresh", graphAgeMs: 1, hotspots: [], rejectedRows: 3 }) }));
    expect(ev("sweep-plan")[0]?.hotspots_rejected).toBe(3);
  });

  test("the cypher JSON is taken from the first line BEGINNING with `{` — a brace inside the banner is not it", () => {
    expect(cypherJson('  GitNexus Cypher {1.6.12}\n{\n  "markdown": "| a |",\n  "row_count": 1\n}\n')).toEqual({ markdown: "| a |" });
    expect(cypherJson("banner only")).toEqual({ error: "cypher output carried no JSON object" });
  });
});

// ─── AC3b: contention ────────────────────────────────────────────────────────

describe("AC3(b) — one flock, two modes: the refresh's exclusive lock skips the sweep's graph read", () => {
  test("child classification: a silent flock refusal is refresh-in-progress; any output or a crash is named, never guessed as contention", () => {
    expect(classifyGraphChild({ exitCode: 1, stdout: "", stderr: "" }).status).toBe("refresh-in-progress");
    expect(classifyGraphChild({ exitCode: 1, stdout: "", stderr: "error: boom" }).status).toBe("graph-unavailable");
    expect(classifyGraphChild({ exitCode: 1, stdout: "partial", stderr: "" }).status).toBe("graph-unavailable");
    const ok = fresh();
    expect(classifyGraphChild({ exitCode: 0, stdout: `${JSON.stringify(ok)}\n`, stderr: "" })).toEqual(ok);
    expect(classifyGraphChild({ exitCode: 0, stdout: "not json", stderr: "" }).status).toBe("graph-unavailable");
  });

  test("refresh-in-progress is a counted, named skip; the sweep proceeds", async () => {
    const r = await runSweep(deps({ graphLeg: async () => ({ status: "refresh-in-progress" }) }));
    expect(r.outcome).toBe("complete");
    expect(ev("sweep-leg-skipped")[0]?.code).toBe("refresh-in-progress");
    expect(ev("sweep-plan")[0]?.graph_leg).toBe("refresh-in-progress");
  });

  async function holdExclusive(lock: string): Promise<ReturnType<typeof Bun.spawn>> {
    const holder = Bun.spawn(["flock", "-x", lock, "sleep", "10"]);
    // Poll until the lock is provably held (a probe that cannot take it), so a
    // slow CI box never races the assertion.
    for (let i = 0; i < 100; i++) {
      if (spawnSync("flock", ["-n", lock, "true"]).status !== 0) return holder;
      await Bun.sleep(50);
    }
    holder.kill();
    throw new Error("the exclusive holder never acquired the lock");
  }

  test.skipIf(!HAS_FLOCK)(
    "REAL flock: while A6's exclusive lock is held, the sweep's shared non-blocking acquisition refuses and the graph is never read (skipped where flock is absent — macOS dev; util-linux in CI)",
    async () => {
      const home = tmp("a3-graph-");
      const lock = join(home, ".refresh.lock");
      const marker = join(home, "graph-read");
      const fakeGn = join(home, "gitnexus");
      writeFileSync(fakeGn, `#!/bin/sh\ntouch ${marker}\necho '{"markdown":"| file | fanIn |\\n| --- | --- |\\n| src/x.ts | 2 |","row_count":1}'\n`, { mode: 0o755 });
      writeFileSync(join(home, "cli-version.json"), JSON.stringify({ indexedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }));
      const holder = await holdExclusive(lock);
      const env = { ...process.env, QDS_GITNEXUS_HOME: home, QDS_GITNEXUS_BIN: fakeGn, QDS_SWEEP_GRAPH_LEG_CHILD: "1" };
      const argv = ["-s", "-n", lock, process.execPath, join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "--graph-leg"];
      const r = spawnSync("flock", argv, { cwd: REPO_ROOT, env, encoding: "utf8" });
      holder.kill();
      await holder.exited;
      expect(classifyGraphChild({ exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }).status).toBe("refresh-in-progress");
      expect(existsSync(marker)).toBe(false);
      // Positive control: lock free → the same invocation reads the graph.
      const ok = spawnSync("flock", argv, { cwd: REPO_ROOT, env, encoding: "utf8" });
      expect(classifyGraphChild({ exitCode: ok.status ?? -1, stdout: ok.stdout, stderr: ok.stderr }).status).toBe("fresh");
      expect(existsSync(marker)).toBe(true);
    },
    30_000,
  );

  test("--graph-leg without the parent's marker is refused (never an unlocked graph read)", () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "--graph-leg"], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, QDS_SWEEP_GRAPH_LEG_CHILD: "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--graph-leg is internal");
  });

  test("the lock target is A6's own: <graph-home>/.refresh.lock, shared non-blocking — one vocabulary", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "utf8");
    expect(src).toContain('[flock, "-s", "-n", join(home, ".refresh.lock")');
    expect(readFileSync(join(REPO_ROOT, "scripts", "gitnexus-refresh.sh"), "utf8")).toContain('LOCK_FILE="$GRAPH_HOME/.refresh.lock"');
  });
});

// ─── AC3c: audit chain ───────────────────────────────────────────────────────

describe("AC3(c) — audit-chain hotspots over the trailing window, read-only", () => {
  test("walks runs CLOSED in the window that reached a PR; PR-less runs (parked, rejected, a sweep's own brief) are counted, never walked", async () => {
    const timedOut = (id: string) => rec(id, "2026-10-10T00:00:00Z", { pr: false, extensions: { approval: { schemaVersion: 1, state: "timed-out" } } });
    const attempts = new Map([["att-1", timedOut("att-1")], ["att-2", timedOut("att-2")], ["att-3", timedOut("att-3")]]);
    const records = [
      rec("qds-20261018-aaaaaa", "2026-10-18T00:00:00Z"),
      rec("qds-20261017-bbbbbb", "2026-10-17T00:00:00Z", { extensions: { fixLoop: { schemaVersion: 1, fixAttemptRunIds: ["att-1", "att-2", "att-3"] } } }),
      rec("qds-20261016-ffffff", "2026-10-16T00:00:00Z", { extensions: { fixLoop: { schemaVersion: 1, fixAttemptRunIds: ["att-1", "pruned-x", "att-3"] } } }),
      rec("qds-20261018-cccccc", "2026-10-18T06:00:00Z", { closed: false }), // open: not in the window at all
      rec("qds-20261018-dddddd", "2026-10-18T07:00:00Z", { pr: false }), // parked/rejected: no PR
      rec("qds-20261009-eeeeee", "2026-10-09T00:00:00Z", { closedAt: "2026-10-15T00:00:00Z" }), // created before, CLOSED inside
      rec("qds-20261001-gggggg", "2026-10-01T00:00:00Z"), // closed before the window
    ];
    const walked: string[] = [];
    const leg = await collectAuditHotspots(
      emptyAudit({
        listRecords: () => ({ records, skipped: 1 }),
        readRecord: (id) => {
          const r = attempts.get(id);
          if (r === undefined) throw new Error(`no record ${id}`);
          return r;
        },
        brokenHops: async (id) => {
          walked.push(id);
          return id === "qds-20261018-aaaaaa" ? ["run-cost", "run-cost", "run-box"] : ["run-cost"];
        },
      }),
      NOW,
    );
    expect(walked.sort()).toEqual(["qds-20261009-eeeeee", "qds-20261016-ffffff", "qds-20261017-bbbbbb", "qds-20261018-aaaaaa"]);
    const by = Object.fromEntries(leg.hotspots.map((h) => [h.target, h]));
    expect(by["hop:run-cost"]?.score).toBe(4);
    expect(by["hop:run-box"]?.score).toBe(1);
    // Three READABLE timed-out attempts = the uncharged ceiling; a ledger with a pruned record is not judged.
    expect(by["fixloop-exhausted"]?.runIds).toEqual(["qds-20261017-bbbbbb"]);
    expect(by["exit-6"]).toBeUndefined(); // no producer carries a run's exit 6
    expect(leg).toMatchObject({ runsInWindow: 5, runsWithoutPr: 1, runsWalked: 4, ledgersIncomplete: 1, recordsSkipped: 1 });
  });

  test("malformed ledgers and off-charset signals are counted, never silent; one bad ledger never discards the leg", async () => {
    const leg = await collectAuditHotspots(
      emptyAudit({
        listRecords: () => ({
          records: [
            rec("qds-20261018-aaaaaa", "2026-10-18T00:00:00Z", { extensions: { fixLoop: { schemaVersion: 1, fixAttemptRunIds: [42] } } }),
            rec("qds-20261018-bbbbbb", "2026-10-18T01:00:00Z"),
          ],
          skipped: 0,
        }),
        brokenHops: async (id) => (id === "qds-20261018-bbbbbb" ? ["run-cost", "Bad_Hop9"] : ["run-box"]),
      }),
      NOW,
    );
    expect(leg).toMatchObject({ ledgersIncomplete: 1, signalsRejected: 1 });
    expect(leg.hotspots.map((h) => h.target).sort()).toEqual(["hop:run-box", "hop:run-cost"]);
  });

  test("bounded: past MAX_WALKED_RUNS the NEWEST are walked and the rest counted; a failed walk is counted, never fatal", async () => {
    const id = (i: number) => `qds-20261018-${i.toString(16).padStart(6, "0")}`;
    const records = Array.from({ length: MAX_WALKED_RUNS + 3 }, (_, i) => rec(id(i), new Date(NOW.getTime() - (i + 2) * 3_600_000).toISOString()));
    const walked: string[] = [];
    const leg = await collectAuditHotspots(
      emptyAudit({
        listRecords: () => ({ records: [...records].reverse(), skipped: 0 }),
        brokenHops: async (runId) => {
          walked.push(runId);
          if (walked.length === 1) throw new Error("walk-environment-fault");
          return [];
        },
      }),
      NOW,
    );
    expect(leg).toMatchObject({ runsWalked: MAX_WALKED_RUNS, runsNotWalked: 3, walksFailed: 1 });
    expect(walked[0]).toBe(id(0)); // newest first
    expect(walked).not.toContain(id(MAX_WALKED_RUNS + 2)); // the oldest is the one left unwalked
  });

  test("an unreadable run store is a counted, named audit-unavailable skip — the pass still completes", async () => {
    const r = await runSweep(
      deps({
        audit: emptyAudit({
          listRecords: () => {
            throw new Error("EACCES: .sandbox/runs");
          },
        }),
      }),
    );
    expect(r.outcome).toBe("complete");
    expect(ev("sweep-leg-skipped").find((l) => l.leg === "audit")).toMatchObject({ code: "audit-unavailable", error: { code: "audit-unavailable" } });
  });

  test("the walk reads a SNAPSHOT: the source store's bytes are unchanged and the copy carries its rows", () => {
    const dir = tmp("a3-audit-");
    const source = join(dir, "audit.db");
    const db = new Database(source);
    db.run("CREATE TABLE audit_links (id INTEGER PRIMARY KEY, hop TEXT)");
    db.run("INSERT INTO audit_links (hop) VALUES ('run-cost')");
    db.close();
    const before = readFileSync(source);
    const copy = snapshotAuditDb(source, mkdtempSync(join(dir, "snap-")));
    expect(copy).toBeDefined();
    const c = new Database(copy as string);
    c.run("INSERT INTO audit_links (hop) VALUES ('first-observation')"); // the walker's write lands HERE
    expect((c.query("SELECT count(*) AS n FROM audit_links").get() as { n: number }).n).toBe(2);
    c.close();
    expect(readFileSync(source).equals(before)).toBe(true);
    expect(snapshotAuditDb(join(dir, "missing.db"), dir)).toBeUndefined();
  });

  test("only the walked run's OWN chain counts — contributing fix runs (no PR of their own) never mint hops", () => {
    const cli = readFileSync(join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "utf8");
    expect(cli).toContain("const own = report.runs[runId];");
    expect(cli).toContain("chainVerdict({ ...report, runs: { [runId]: own } })");
  });

  test("the restated audit-store default is the link store's own literal (drift tripwire)", () => {
    expect(readFileSync(join(REPO_ROOT, "src", "audit", "link-store.ts"), "utf8")).toContain(`export const DEFAULT_AUDIT_DB_FILE = "${AUDIT_DB_DEFAULT}";`);
  });

  test("NEGATIVE CONTROL: no audit writer is imported, and the walk is always handed the snapshot path", () => {
    for (const f of ["src/maintenance/sweep-plan.ts", "scripts/maintenance-sweep.ts"]) {
      const imports = readFileSync(join(REPO_ROOT, f), "utf8")
        .split("\n")
        .filter((l) => /^\s*(import\b|} from |from ")/.test(l))
        .join("\n");
      expect(imports).not.toMatch(/link-store|openAuditStore|AuditStoreWriter/);
    }
    expect(readFileSync(join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "utf8")).toContain("walkAuditChain(runId, { requestId, auditDb })");
  });
});

// ─── planning + AC4 bounds ───────────────────────────────────────────────────

describe("planning — deterministic order, fence, cap", () => {
  test("audit before graph; score desc; target asc on ties", () => {
    const p = planBriefs(
      SWEEP,
      REPO.commitSha,
      [hs("graph", "src/z.ts", 50), hs("audit", "hop:run-box", 1, ["qds-20261018-aaaaaa"]), hs("graph", "src/b.ts", 7), hs("graph", "src/a.ts", 7)],
      new Set(),
    );
    expect(p.briefs.map((b) => b.target)).toEqual(["hop:run-box", "src/z.ts", "src/a.ts", "src/b.ts"]);
  });

  test("DoD bounds: 6 eligible hotspots → 5 briefs + a counted remainder of 1; --max-briefs only lowers the cap", () => {
    const six = Array.from({ length: 6 }, (_, i) => hs("graph", `src/f${i}.ts`, 10 - i));
    const p = planBriefs(SWEEP, REPO.commitSha, six, new Set());
    expect(p.briefs).toHaveLength(MAX_BRIEFS_PER_SWEEP);
    expect(p.overCap).toBe(1);
    expect(planBriefs(SWEEP, REPO.commitSha, six, new Set(), 1)).toMatchObject({ overCap: 5 });
    expect(planBriefs(SWEEP, REPO.commitSha, six, new Set(), 99).briefs).toHaveLength(MAX_BRIEFS_PER_SWEEP);
  });

  test("the never-edit fence covers exactly the guardrail + approval/verification surfaces (explicit list, not self-referential)", () => {
    const expected = [
      ".github/",
      "deploy/",
      "oci/",
      "config/",
      "package.json",
      "src/providers/",
      "src/audit/",
      "src/reverify/",
      "src/gate/gate-runner.ts",
      "src/fixloop/feedback-run.ts",
      "src/fleet/approval-gate.ts",
      "src/fleet/approvers.ts",
      "src/fleet/push.ts",
      "src/maintenance/",
    ];
    expect([...FENCED_TARGET_PREFIXES].sort()).toEqual([...expected].sort());
    const targets = ["src/providers/run-record.ts", "src/audit/chain.ts", "src/reverify/approval.ts", "src/gate/gate-runner.ts", "src/fixloop/feedback-run.ts", "src/fleet/approval-gate.ts", "src/fleet/approvers.ts", "src/fleet/push.ts", "src/maintenance/sweep-plan.ts"];
    const p = planBriefs(SWEEP, REPO.commitSha, [...targets.map((t) => hs("graph", t, 50)), hs("graph", "src/lib/x.ts", 3)], new Set());
    expect(p.fenced).toBe(targets.length);
    expect(p.briefs.map((b) => b.target)).toEqual(["src/lib/x.ts"]);
    expect(isFencedTarget({ source: "audit", target: "hop:run-cost" })).toBe(false);
    const task = briefTask(p.briefs[0] as (typeof p.briefs)[number]);
    expect(task).toContain("Never edit: src/providers/**");
    expect(task).toContain("AUDIT_HOPS");
  });

  test("the in-box TRIPWIRE: the closing phase fails a diff touching a fenced path, passes a clean one (a tripwire, not a control — the agent owns the box)", () => {
    const repo = tmp("a3-fence-");
    const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README"), "x");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").stdout.trim();
    const b = { ...hs("graph", "src/lib/x.ts", 3), ...briefIdentity(SWEEP, hs("graph", "src/lib/x.ts", 3), REPO.commitSha) };
    const verify = (briefManifest(b, base) as { phases: { command?: string[] }[] }).phases[1]?.command ?? [];
    expect(verify.slice(0, 2)).toEqual(["bash", "-c"]); // no login profile runs first
    const run = () => spawnSync(verify[0] as string, verify.slice(1), { cwd: repo, encoding: "utf8" }).status;
    mkdirSync(join(repo, "src", "lib"), { recursive: true });
    writeFileSync(join(repo, "src", "lib", "x.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-qm", "allowed");
    expect(run()).toBe(0);
    mkdirSync(join(repo, "src", "providers"), { recursive: true });
    writeFileSync(join(repo, "src", "providers", "driver.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-qm", "fenced");
    expect(run()).toBe(1);
    // A RENAME out of a fenced dir is seen (--no-renames lists the old path too).
    git("reset", "-q", "--hard", "HEAD~1");
    mkdirSync(join(repo, "src", "audit"), { recursive: true });
    writeFileSync(join(repo, "src", "audit", "chain.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-qm", "seed fenced file");
    const seeded = git("rev-parse", "HEAD").stdout.trim();
    const seededVerify = (briefManifest(b, seeded) as { phases: { command?: string[] }[] }).phases[1]?.command ?? [];
    git("mv", "src/audit/chain.ts", "src/lib/chain.ts");
    git("commit", "-qm", "rename out of the fence");
    expect(spawnSync(seededVerify[0] as string, seededVerify.slice(1), { cwd: repo, encoding: "utf8" }).status).toBe(1);
    // A fenced path git would C-QUOTE (a tab in the name) is still seen: -z + case, no line parsing.
    git("reset", "-q", "--hard", seeded);
    writeFileSync(join(repo, "src", "audit", "we\tird.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-qm", "quoted-path edit in the fence");
    expect(spawnSync(seededVerify[0] as string, seededVerify.slice(1), { cwd: repo, encoding: "utf8" }).status).toBe(1);
    // An unresolvable base fails CLOSED, never an empty pass.
    const ghost = (briefManifest(b, "f".repeat(40)) as { phases: { command?: string[] }[] }).phases[1]?.command ?? [];
    expect(spawnSync(ghost[0] as string, ghost.slice(1), { cwd: repo, encoding: "utf8" }).status).toBe(1);
    expect(() => briefManifest(b, "not-a-sha")).toThrow();
  });

  test("the generated manifest mirrors fix-run's two-phase shape and stays within the dispatch ceiling", () => {
    const b = { ...hs("audit", "hop:run-cost", 2, ["qds-20261018-aaaaaa"]), ...briefIdentity(SWEEP, hs("audit", "hop:run-cost", 2), REPO.commitSha) };
    const m = briefManifest(b, REPO.commitSha) as { phases: { kind: string; roster?: string; task?: string }[]; runBudgetMs: number };
    expect(m.phases.map((p) => p.kind)).toEqual(["dispatch_task", "code"]);
    expect(m.phases[0]?.roster).toBe("config/rosters/roster.yaml");
    expect(m.phases[0]?.task).toContain('"run-cost"');
    expect(m.phases[0]?.task).toContain("qds-20261018-aaaaaa");
    expect(m.runBudgetMs).toBeLessThanOrEqual(2_100_000);
  });

  test("unsafe targets never reach a brief", () => {
    const p = planBriefs(SWEEP, REPO.commitSha, [hs("graph", "src/b.ts", 4), hs("audit", "hop:Run Cost; rm -rf", 3), hs("graph", "../x.ts", 9)], new Set());
    expect(p.unsafe).toBe(2);
    expect(p.briefs.map((b) => b.target)).toEqual(["src/b.ts"]);
  });
});

describe("cooldown — graph targets only, sweep-week arithmetic, possibly-live outcomes count", () => {
  const briefLine = (b: Hotspot, event: "brief-dispatched" | "brief-skipped", code?: string) => {
    const id = briefIdentity(SWEEP, b, REPO.commitSha);
    return { event, briefId: id.briefId, workKey: id.workKey, botId: "bot-maint", source: b.source, target: b.target, kind: b.kind, ...(code ? { code } : {}) } as SweepReport["report"]["briefs"][number];
  };
  const g = hs("graph", "src/a.ts", 5);

  test("a dispatched graph target is deferred for the next 3 sweeps and eligible on the 4th", () => {
    const stateDir = tmp();
    persistSweepReport(stateDir, report(SWEEP, NOW.toISOString(), [briefLine(g, "brief-dispatched")]));
    const id = briefIdentity(SWEEP, g, REPO.commitSha).briefId;
    expect(recentlyBriefed(stateDir, SWEEP).has(id)).toBe(false); // the same week is not "previous"
    expect(recentlyBriefed(stateDir, "sweep-2026-10-26").has(id)).toBe(true);
    expect(recentlyBriefed(stateDir, "sweep-2026-11-09").has(id)).toBe(true);
    expect(recentlyBriefed(stateDir, "sweep-2026-11-16").has(id)).toBe(false); // 4 sweeps on: eligible again
  });

  test("possibly-live skips are cooled down; a fleet-busy skip is not (nothing exists to collide with)", () => {
    const stateDir = tmp();
    const h2 = hs("graph", "src/b.ts", 4);
    const h3 = hs("graph", "src/c.ts", 3);
    persistSweepReport(stateDir, report(SWEEP, NOW.toISOString(), [briefLine(g, "brief-skipped", "submit-transient"), briefLine(h2, "brief-skipped", "ack-unrecovered"), briefLine(h3, "brief-skipped", "fleet-busy")]));
    const set = recentlyBriefed(stateDir, "sweep-2026-10-26");
    expect(set.has(briefIdentity(SWEEP, g, REPO.commitSha).briefId)).toBe(true);
    expect(set.has(briefIdentity(SWEEP, h2, REPO.commitSha).briefId)).toBe(true);
    expect(set.has(briefIdentity(SWEEP, h3, REPO.commitSha).briefId)).toBe(false);
  });

  test("a POSSIBLY-LIVE audit brief is cooled down too (a second box never follows blind); a dispatched one is not", async () => {
    const stateDir = tmp();
    const a = hs("audit", "hop:run-cost", 2, ["qds-20261018-aaaaaa"]);
    const first = deps({ stateDir, graphLeg: async () => fresh(), audit: emptyAudit({ listRecords: () => ({ records: [rec("qds-20261018-aaaaaa", "2026-10-18T00:00:00Z")], skipped: 0 }), brokenHops: async () => ["run-cost"] }) });
    first.submit = async () => ({ exitCode: 3, stdout: "", stderr: "gate" });
    await runSweep(first);
    lines = [];
    const nextWeek = new Date(NOW.getTime() + 7 * DAY);
    const second = deps({ stateDir, now: () => nextWeek, graphLeg: async () => fresh(), audit: emptyAudit({ listRecords: () => ({ records: [rec("qds-20261025-aaaaaa", "2026-10-25T00:00:00Z")], skipped: 0 }), brokenHops: async () => ["run-cost"] }) });
    await runSweep(second);
    expect(second.submits).toEqual([]);
    expect(ev("sweep-plan")[0]?.hotspots_already_briefed).toBe(1);
    expect(a.target).toBe("hop:run-cost");
  });

  test("audit signals are never cooled down — a recurring breakage is new evidence every week", () => {
    const a = hs("audit", "hop:run-cost", 2, ["qds-20261018-aaaaaa"]);
    const p = planBriefs(SWEEP, REPO.commitSha, [a], new Set([briefIdentity(SWEEP, a, REPO.commitSha).briefId]));
    expect(p.briefs).toHaveLength(1);
    expect(p.alreadyBriefed).toBe(0);
  });

  test("end to end: next week's pass defers the target and counts it", async () => {
    const stateDir = tmp();
    await runSweep(deps({ stateDir, graphLeg: async () => fresh([g]) }));
    lines = [];
    const r = await runSweep(deps({ stateDir, now: () => new Date(NOW.getTime() + 7 * DAY), graphLeg: async () => fresh([g]) }));
    expect(r).toMatchObject({ counters: { briefs_planned: 0 } });
    expect(ev("sweep-plan")[0]?.hotspots_already_briefed).toBe(1);
  });
});

describe("AC4 — bounded, exiting, per-brief refusals never fail the pass", () => {
  test("submit exit table → outcomes", () => {
    const e = (exitCode: number, stderr = "x") => ({ exitCode, stdout: "", stderr });
    expect(classifySubmit(e(5))).toMatchObject({ kind: "skipped", code: "fleet-busy" });
    expect(classifySubmit(e(5, "error: submit-in-flight: intent stuck"))).toMatchObject({ kind: "skipped", code: "submit-in-flight" });
    expect(classifySubmit(e(5, '{"error":{"code":"submit-intent-corrupt"}}'))).toMatchObject({ kind: "skipped", code: "submit-in-flight" });
    const provisioned = { exitCode: 0, stdout: `${JSON.stringify({ schemaVersion: 1, runId: "qds-20261019-000001", requestId: "x", state: "provisioned", vmName: "vm", replayed: true })}\n`, stderr: "" };
    expect(classifySubmit(provisioned)).toEqual({ kind: "replay", after: "submit-transient" }); // a box with no engine is never "dispatched"
    // A replayed run that already moved on (a crashed earlier pass) IS this brief's run.
    const movedOn = { exitCode: 0, stdout: `${JSON.stringify({ schemaVersion: 1, runId: "qds-20261019-000001", requestId: "rid-1", state: "awaiting-approval", vmName: "vm", replayed: true })}\n`, stderr: "" };
    expect(classifySubmit(movedOn, "rid-1")).toMatchObject({ kind: "dispatched", runId: "qds-20261019-000001", replayed: true });
    // An ack echoed for ANOTHER request id is no ack for this one.
    expect(classifySubmit(movedOn, "rid-other")).toMatchObject({ kind: "skipped", code: "ack-unrecovered" });
    expect(classifySubmit(e(3))).toMatchObject({ kind: "skipped", code: "setup-gate" });
    expect(classifySubmit(e(2))).toMatchObject({ kind: "skipped", code: "brief-rejected" });
    expect(classifySubmit(e(1))).toEqual({ kind: "replay", after: "submit-transient" });
    expect(classifySubmit(e(6))).toEqual({ kind: "replay", after: "ack-unrecovered" });
    expect(classifySubmit(ack("qds-20261019-000001"))).toMatchObject({ kind: "dispatched", runId: "qds-20261019-000001", state: "running" });
    expect(classifySubmit({ exitCode: 0, stdout: "garbage", stderr: "" })).toMatchObject({ kind: "skipped", code: "ack-unrecovered" });
    expect(classifySubmit({ timedOut: true })).toMatchObject({ kind: "skipped", code: "submit-transient" });
  });

  test("the ack is found by shape among log lines; an off-charset runId is no ack", () => {
    const a = ack("qds-20261019-000001");
    expect("stdout" in a ? ackOf(a.stdout)?.runId : undefined).toBe("qds-20261019-000001");
    expect(ackOf(`${JSON.stringify({ schemaVersion: 1, runId: "../evil", requestId: "x" })}\n`)).toBeUndefined();
    expect(ackOf(`${JSON.stringify({ runId: "qds-20261019-000001" })}\n`)).toBeUndefined(); // a log line naming a runId is not the ack
  });

  test("NEGATIVE CONTROL: a busy fleet does not abort the sweep — every brief counted skipped with a remediation, outcome complete", async () => {
    const d = deps({
      graphLeg: async () => fresh([hs("graph", "src/a.ts", 3), hs("graph", "src/b.ts", 2)]),
      submit: async () => ({ exitCode: 5, stdout: "", stderr: "fleet-busy: no headroom" }),
    });
    const r = await runSweep(d);
    expect(r).toMatchObject({ outcome: "complete", counters: { briefs_planned: 2, briefs_dispatched: 0, briefs_skipped: 2, chain_refused: 0 } });
    expect(ev("brief-skipped").map((l) => l.code)).toEqual(["fleet-busy", "fleet-busy"]);
    for (const l of ev("brief-skipped")) {
      expect(l).not.toHaveProperty("runId"); // ABSENT, not 0, on an undispatched brief
      expect(l.error).toMatchObject({ code: "fleet-busy", remediation: expect.any(String) });
    }
  });

  test("a setup-gate refusal counts as chain_refused; exit 6 / exit 1 replay ONCE on the brief's own request id", async () => {
    const answers: SubmitAnswer[] = [
      { exitCode: 3, stdout: "", stderr: "gate" },
      { exitCode: 6, stdout: "", stderr: "" },
      ack("qds-20261019-00000b", true),
      { exitCode: 1, stdout: "", stderr: "unreachable" },
      { exitCode: 1, stdout: "", stderr: "unreachable" },
      { exitCode: 6, stdout: "", stderr: "" },
      { exitCode: 6, stdout: "", stderr: "" },
    ];
    const hot = [hs("graph", "src/a.ts", 5), hs("graph", "src/b.ts", 4), hs("graph", "src/c.ts", 3), hs("graph", "src/d.ts", 2)];
    const d = deps({ graphLeg: async () => fresh(hot) });
    d.submit = async (_p, rid) => {
      d.submits.push(rid);
      const a = answers.shift() as SubmitAnswer;
      // The canned acks answer whichever brief asks: stamp the submitted id in.
      return "stdout" in a ? { ...a, stdout: a.stdout.replaceAll('"requestId":"x"', `"requestId":"${rid}"`) } : a;
    };
    const r = await runSweep(d);
    expect(r).toMatchObject({ counters: { briefs_dispatched: 1, briefs_skipped: 3, chain_refused: 1 } });
    expect(d.submits[1]).toBe(d.submits[2]);
    expect(ev("brief-skipped").map((l) => l.code)).toEqual(["setup-gate", "submit-transient", "ack-unrecovered"]);
  });

  test("replay safety across re-fires: every submit carries briefRequestId(sweepId, workId), and a re-run of a zero-dispatch week reuses them", async () => {
    const stateDir = tmp();
    const hot = [hs("graph", "src/a.ts", 3)];
    const id = briefIdentity(SWEEP, hot[0] as Hotspot, REPO.commitSha);
    expect(id.requestId).toBe(briefRequestId(SWEEP, id.workId, REPO.commitSha));
    const first = deps({ stateDir, graphLeg: async () => fresh(hot) });
    first.submit = async (_p, rid) => {
      first.submits.push(rid);
      return { exitCode: 5, stdout: "", stderr: "busy" };
    };
    await runSweep(first);
    expect(first.submits).toEqual([id.requestId]);
    lines = [];
    const second = deps({ stateDir, graphLeg: async () => fresh(hot) });
    const r = await runSweep(second);
    expect(r.outcome).toBe("complete"); // a zero-dispatch week may be re-run
    expect(ev("sweep-resweep")).toHaveLength(1);
    expect(second.submits).toEqual([id.requestId]);
  });

  test("a re-sweep carries the prior pass's possibly-live briefs into the record, never re-submits them, and counts them against the cap", async () => {
    const stateDir = tmp();
    const a = hs("graph", "src/a.ts", 9);
    const b = hs("graph", "src/b.ts", 8);
    const first = deps({ stateDir, maxBriefs: 1, graphLeg: async () => fresh([a, b]) });
    first.submit = async (_p, rid) => {
      first.submits.push(rid);
      return { exitCode: 3, stdout: "", stderr: "setup gate refused" }; // a live box under INV-5
    };
    await runSweep(first);
    lines = [];
    const second = deps({ stateDir, maxBriefs: 2, graphLeg: async () => fresh([a, b]) });
    await runSweep(second);
    const idA = briefIdentity(SWEEP, a, REPO.commitSha);
    const idB = briefIdentity(SWEEP, b, REPO.commitSha);
    expect(second.submits).toEqual([idB.requestId]); // A is held; the cap (2) minus the held one leaves 1
    const briefs = readSweepReport(stateDir, SWEEP)?.report.briefs ?? [];
    expect(briefs.map((x) => [x.briefId, x.event, x.code])).toEqual([
      [idB.briefId, "brief-dispatched", undefined],
      [idA.briefId, "brief-skipped", "setup-gate"],
    ]);
    expect(recentlyBriefed(stateDir, "sweep-2026-10-26").has(idA.briefId)).toBe(true); // the cooldown still knows A may be live
  });

  test("dispatched briefs join the A1 digest: sweepRunMeta maps runId → botId + w: workKey", async () => {
    const stateDir = tmp();
    await runSweep(deps({ stateDir, graphLeg: async () => fresh([hs("graph", "src/a.ts", 3)]) }));
    const meta = sweepRunMeta(stateDir);
    expect(meta.get("qds-20261019-000001")).toEqual({ botId: "bot-maint", workKey: briefIdentity(SWEEP, hs("graph", "src/a.ts", 3), REPO.commitSha).workKey });
    // Two reports naming one runId with different workKeys: ambiguous, never attributed.
    persistSweepReport(stateDir, report("sweep-2026-10-12", NOW.toISOString(), [
      { event: "brief-dispatched", briefId: "refactor-ffffffff", workKey: "w:maint/2026-10-12/refactor-ffffffff", botId: "bot-maint", source: "graph", target: "src/z.ts", kind: "refactor", runId: "qds-20261019-000001" },
    ]));
    expect(sweepRunMeta(stateDir).has("qds-20261019-000001")).toBe(false);
  });

  test("NEGATIVE CONTROL: an empty sweep (zero hotspots) completes with briefs_planned 0 — a quiet tick is not a failure", async () => {
    const r = await runSweep(deps());
    expect(r).toMatchObject({ outcome: "complete", counters: { briefs_planned: 0, briefs_dispatched: 0, briefs_skipped: 0 } });
    expect(ev("sweep-complete")).toHaveLength(1);
  });

  test("NEGATIVE CONTROL: no resident shape — no loop/daemon flag, no PID file, no timer loop in the pass", () => {
    for (const f of ["scripts/maintenance-sweep.ts", "src/maintenance/sweep-plan.ts"]) {
      expect(readFileSync(join(REPO_ROOT, f), "utf8")).not.toMatch(/setInterval\(|"--daemon"|"--loop"|\.pid["'`]/);
    }
  });
});

// ─── AC1 + AC5 ───────────────────────────────────────────────────────────────

describe("AC1 — the sweep stops at the gate, and the gate is the one gate", () => {
  test("AC5: EVERY dispatched brief carries workKey + runId + botId, on the line and in the report", async () => {
    const d = deps({ graphLeg: async () => fresh([hs("graph", "src/a.ts", 3), hs("graph", "src/b.ts", 2)]) });
    await runSweep(d);
    const dispatched = ev("brief-dispatched");
    expect(dispatched).toHaveLength(2);
    const persisted = readSweepReport(d.stateDir, SWEEP)?.report.briefs ?? [];
    expect(persisted).toHaveLength(2);
    for (const l of [...dispatched, ...persisted] as Record<string, unknown>[]) {
      expect(l.botId).toBe("bot-maint");
      expect(String(l.runId)).toMatch(/^qds-20261019-/);
      expect(WorkKeySchema.safeParse(l.workKey).success).toBe(true);
    }
  });

  test("NEGATIVE CONTROL: no second approval path, chain, or spend ledger — import + verb + token fence", () => {
    for (const f of ["src/maintenance/sweep-plan.ts", "scripts/maintenance-sweep.ts"]) {
      const src = readFileSync(join(REPO_ROOT, f), "utf8");
      const imports = src
        .split("\n")
        .filter((l) => /^\s*(import\b|} from |from ")/.test(l))
        .join("\n");
      expect(imports).not.toMatch(/approval-gate|approvers|run-completion|fleet\/observe|fleet\/push|fleet\/index|fleet\/teardown|fleet\/run\.ts|fleet\/dispatch|src\/reverify|cost-ledger/);
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(code).not.toMatch(/"approve"|'approve'|"reject"|"enrol"|"--token"|gh pr merge|"merge"|observeAndDriveChain|teardownSandbox|enqueueSystemEvent/);
    }
  });

  test("the only fleet verb the sweep invokes is submit", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "utf8");
    expect(new Set([...src.matchAll(/Cli\(\["([a-z]+)"/g)].map((m) => m[1]))).toEqual(new Set(["submit"]));
  });
});

// ─── the durable report handoff ──────────────────────────────────────────────

describe("the report handoff — durable, correlated, delivered once", () => {
  test("persisted pending; a second firing after a dispatching pass is already-swept (no second dispatch) and still closes the channel", async () => {
    const d = deps({ graphLeg: async () => fresh([hs("graph", "src/a.ts", 3)]) });
    await runSweep(d);
    expect(readSweepReport(d.stateDir, SWEEP)).toMatchObject({ deliveryState: "pending", botTarget: BOT, report: { complete: { briefs_dispatched: 1 } } });
    lines = [];
    expect(await runSweep(d)).toEqual({ outcome: "already-swept", sweepId: SWEEP });
    expect(d.submits).toHaveLength(1);
    expect(ev("sweep-complete")[0]).toMatchObject({ already_swept: true, briefs_dispatched: 1, briefs_planned: 1 }); // the prior counters ride the line
  });

  test("this week's record present but corrupt: refused (named), never re-planned over", async () => {
    const stateDir = tmp();
    mkdirSync(join(stateDir, "sweep-reports"), { recursive: true });
    writeFileSync(join(stateDir, "sweep-reports", `${SWEEP}.json`), "{ not json");
    const d = deps({ stateDir, graphLeg: async () => fresh([hs("graph", "src/a.ts", 3)]) });
    expect(await runSweep(d)).toEqual({ outcome: "already-swept", sweepId: SWEEP });
    expect(d.submits).toEqual([]);
    expect(ev("sweep-report-corrupt")[0]?.error).toMatchObject({ code: "report-corrupt" });
  });

  test("a re-sweep keeps the first pass's createdAt (the residue clock) and never clobbers a delivery flip", async () => {
    const stateDir = tmp();
    await runSweep(deps({ stateDir })); // zero-dispatch week
    const firstCreated = readSweepReport(stateDir, SWEEP)?.createdAt;
    markReportDelivered(stateDir, SWEEP, NOW);
    // A delivered week is already-swept; force the re-sweep path by restoring pending, then deliver mid-pass.
    const r = readSweepReport(stateDir, SWEEP) as SweepReport;
    persistSweepReport(stateDir, { ...r, deliveryState: "pending" });
    const later = new Date(NOW.getTime() + 3_600_000);
    const d = deps({
      stateDir,
      now: () => later,
      graphLeg: async () => {
        markReportDelivered(stateDir, SWEEP, later); // the wake fires while the re-sweep runs
        return fresh();
      },
    });
    await runSweep(d);
    const after = readSweepReport(stateDir, SWEEP);
    expect(after?.createdAt).toBe(firstCreated);
    expect(after?.deliveryState).toBe("delivered");
  });

  test("the wake flips only the matching PENDING record, exactly once; a delivered week is never re-swept", async () => {
    const d = deps();
    await runSweep(d);
    expect(markReportDelivered(d.stateDir, "sweep-2026-10-12", NOW)).toBe(false);
    expect(markReportDelivered(d.stateDir, SWEEP, NOW)).toBe(true);
    expect(markReportDelivered(d.stateDir, SWEEP, NOW)).toBe(false);
    expect(readSweepReport(d.stateDir, SWEEP)?.deliveryState).toBe("delivered");
    lines = [];
    expect((await runSweep(d)).outcome).toBe("already-swept");
  });

  test("residue: pending past the next wake + grace is named; a delivered report never is; residue never ages out", () => {
    const stateDir = tmp();
    persistSweepReport(stateDir, report(SWEEP, NOW.toISOString(), []));
    persistSweepReport(stateDir, report("sweep-2026-10-12", new Date(NOW.getTime() - 7 * DAY).toISOString(), [], "delivered"));
    expect(undeliveredReports(stateDir, new Date(NOW.getTime() + 7 * DAY))).toEqual([]); // the next wake may not have fired yet
    expect(undeliveredReports(stateDir, new Date(NOW.getTime() + REPORT_RESIDUE_AFTER_MS))).toEqual([SWEEP]);
    expect(undeliveredReports(stateDir, new Date(NOW.getTime() + 365 * DAY))).toEqual([SWEEP]); // never ages out — never silence
  });

  test("residue surfaces on the next pass as a coded error line", async () => {
    const stateDir = tmp();
    persistSweepReport(stateDir, report("sweep-2026-10-12", new Date(NOW.getTime() - 9 * DAY).toISOString(), []));
    await runSweep(deps({ stateDir }));
    expect(ev("sweep-report-undelivered")[0]).toMatchObject({ sweepId: "sweep-2026-10-12", error: { code: "report-undelivered" } });
    expect(ev("sweep-plan")[0]?.reports_undelivered).toBe(1);
  });

  test("a malformed report record is unreadable (counted, named), never a crash", async () => {
    const stateDir = tmp();
    mkdirSync(join(stateDir, "sweep-reports"), { recursive: true });
    writeFileSync(join(stateDir, "sweep-reports", "sweep-2026-10-12.json"), JSON.stringify({ schemaVersion: 1, sweepId: "sweep-2026-10-12", deliveryState: "pending", createdAt: "nope" }));
    const r = await runSweep(deps({ stateDir }));
    expect(r.outcome).toBe("complete");
    expect(ev("sweep-reports-unreadable")[0]?.error).toMatchObject({ code: "reports-unreadable" });
    expect(undeliveredReportsWithProblems(stateDir, NOW).problem).toContain("failed validation");
  });

  test("a report-persist failure is recorded and non-silent, and never unwinds the dispatched briefs", async () => {
    const stateDir = join(tmp(), "state");
    writeFileSync(stateDir, "a file where the state dir should be");
    const r = await runSweep(deps({ stateDir, graphLeg: async () => fresh([hs("graph", "src/a.ts", 3)]) }));
    expect(r).toMatchObject({ outcome: "complete", reportPersisted: false, counters: { briefs_dispatched: 1 } });
    expect(ev("sweep-report-failed")[0]?.error).toMatchObject({ code: "report-persist-failed" });
    expect(ev("sweep-complete")[0]?.report_persisted).toBe(false);
  });
});

// ─── AC2: spec-seam fixtures (factory side) ──────────────────────────────────

/**
 * AC2's durability is the fork's persisted schedule store — no wake code lives
 * in this repo (the schedule row is E21 platform config, A1's surface). The
 * factory side pins the CONTRACT the fork must meet with a seam fake shaped on
 * `loadSchedules`/`upsertSchedule` (persisted) beside an
 * `enqueueSystemEvent`-shaped in-memory map (the negative control); the
 * production-code half is the fence above (nothing in A3 enqueues a system
 * event or wakes a bot) and the crontab assertions below.
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
    const fired = row.restart().due()[0] as ScheduleRow;
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

  test("the pass owns its transport: the A3 crontab entry fires the script; DF3.8's observe sweep stays an operator prerequisite", () => {
    const crontab = readFileSync(join(REPO_ROOT, "deploy", "vps", "crontab.factory"), "utf8");
    const entries = crontab.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#") && !l.startsWith("SHELL="));
    const sweep = entries.filter((l) => l.includes("scripts/maintenance-sweep.ts"));
    expect(sweep).toHaveLength(1);
    expect(sweep[0]).toMatch(/^17 3 \* \* 1 cd \/opt\/qds-factory && PATH="\$HOME\/\.bun\/bin:[^"]*" bun scripts\/maintenance-sweep\.ts >> \/var\/log\/qds\/maintenance-sweep\.log 2>&1$/);
    const header = readFileSync(join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), "utf8").split("\n").map((l) => l.replace(/^\/\/\s+/, ""));
    expect(header).toContain(sweep[0] ?? "<no sweep entry>");
    // DF3.8's observe sweep is the OPERATOR's cron (INV-IBOX-19: documented,
    // never installed) — named as a prerequisite, never shipped as an entry.
    expect(entries.filter((l) => l.includes("observe"))).toEqual([]);
    expect(crontab).toContain("fleet observe --all");
    expect(crontab).toContain(".factory/");
  });
});

// ─── the real binaries ───────────────────────────────────────────────────────

describe("A3 — the bounded CLI (bun scripts/maintenance-sweep.ts)", () => {
  const work = tmp("a3-cli-");
  // The state dir must sit under the repo root (dispatch resolves manifestPath
  // there); .sandbox/ is gitignored. Removed after the suite.
  const stateRoot = join(REPO_ROOT, ".sandbox", `a3-test-${process.pid}`);
  afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));

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
if (verb === "submit") { console.log(JSON.stringify({ operation: "fleet.submit", status: "ok" })); console.log(JSON.stringify({ schemaVersion: 1, runId: "qds-20261019-0000aa", requestId: process.argv[process.argv.indexOf("--request-id") + 1], state: "running", vmName: "vm", replayed: false })); process.exit(0); }
process.exit(2);
`,
  );

  let seq = 0;
  async function run(args: string[], env: Record<string, string> = {}, cwd = REPO_ROOT) {
    const leg = join(work, `leg-${++seq}`);
    mkdirSync(leg, { recursive: true });
    const stateDir = join(stateRoot, `leg-${seq}`);
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "scripts", "maintenance-sweep.ts"), ...args], {
      cwd,
      env: {
        ...process.env,
        QDS_LOG_VERBOSE: "1",
        QDS_SWEEP_ALLOW_UNPUSHED: "1",
        QDS_RUNS_DIR: join(leg, "runs"),
        QDS_SWEEP_STATE_DIR: stateDir,
        QDS_SWEEP_FLEET_ENTRY: fleetEntry,
        QDS_GITNEXUS_HOME: join(leg, "no-graph-home"),
        QDS_AUDIT_DB: join(leg, "audit.db"),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const events = stdout
      .split("\n")
      .filter((l) => l.includes('"operation":"maintenance.sweep"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code, stdout, stderr, events, stateDir };
  }

  function freshGraphHome(rows: string[]): { home: string; bin: string } {
    const home = join(work, `graph-home-${++seq}`);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "cli-version.json"), JSON.stringify({ indexedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }));
    const bin = join(home, "gitnexus");
    const md = ["| file | fanIn |", "| --- | --- |", ...rows].join("\\n");
    writeFileSync(bin, `#!/bin/sh\necho 'GitNexus Cypher'\necho '{"markdown":"${md}","row_count":${rows.length}}'\n`, { mode: 0o755 });
    return { home, bin };
  }

  test(
    "an empty sweep exits 0 with briefs_planned 0, the stale graph named, and a pending report persisted",
    async () => {
      const { code, events, stateDir } = await run(["--config", configPath]);
      expect(code).toBe(0);
      expect(events.find((e) => e.event === "sweep-leg-skipped")).toMatchObject({ code: "graph-stale" });
      expect(events.find((e) => e.event === "sweep-complete")).toMatchObject({ briefs_planned: 0, briefs_dispatched: 0, graph_stale: true });
      expect(existsSync(join(stateDir, "sweep-reports"))).toBe(true);
    },
    60_000,
  );

  test(
    "flock missing on PATH: the graph leg is a named graph-unavailable and the sweep still completes",
    async () => {
      const { home, bin } = freshGraphHome(["| src/lib/x.ts | 2 |"]);
      const binDir = join(work, "path-no-flock");
      mkdirSync(binDir, { recursive: true });
      const realGit = Bun.which("git");
      if (realGit !== null) symlinkSync(realGit, join(binDir, "git"));
      const { code, events } = await run(["--config", configPath], { QDS_GITNEXUS_HOME: home, QDS_GITNEXUS_BIN: bin, PATH: `${dirname(process.execPath)}:${binDir}` });
      expect(code).toBe(0);
      expect(events.find((e) => e.event === "sweep-leg-skipped")).toMatchObject({ code: "graph-unavailable" });
      expect(events.find((e) => e.event === "sweep-complete")).toMatchObject({ graph_leg: "graph-unavailable" });
    },
    60_000,
  );

  test(
    "split-brain guard: a graph-home override that is not this checkout's index is graph-unavailable unless the binary is pinned too",
    async () => {
      const { home } = freshGraphHome(["| src/lib/x.ts | 2 |"]);
      const { code, events } = await run(["--config", configPath], { QDS_GITNEXUS_HOME: home });
      expect(code).toBe(0);
      const skip = events.find((e) => e.event === "sweep-leg-skipped") as { code?: string; error?: { message?: string } } | undefined;
      expect(skip?.code).toBe("graph-unavailable");
      expect(skip?.error?.message).toContain("not this checkout's index");
    },
    60_000,
  );

  test.skipIf(!HAS_FLOCK)(
    "a fresh graph briefs and submits through the real binary; --max-briefs 1 is honored (one submit of two candidates)",
    async () => {
      const { home, bin } = freshGraphHome(["| src/lib/x.ts | 3 |", "| src/lib/y.ts | 2 |"]);
      const { code, events, stateDir } = await run(["--config", configPath, "--max-briefs", "1"], { QDS_GITNEXUS_HOME: home, QDS_GITNEXUS_BIN: bin });
      expect(code).toBe(0);
      const dispatched = events.filter((e) => e.event === "brief-dispatched");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({ runId: "qds-20261019-0000aa", botId: "bot-maint", target: "src/lib/x.ts" });
      expect(events.find((e) => e.event === "sweep-plan")).toMatchObject({ hotspots_over_cap: 1 });
      expect(existsSync(join(stateDir, "briefs"))).toBe(true);
    },
    60_000,
  );

  test(
    "a report-persist failure exits 1 (the pass's own failure), naming the code",
    async () => {
      const leg = join(stateRoot, "persist-fail");
      mkdirSync(leg, { recursive: true });
      writeFileSync(join(leg, "sweep-reports"), "a file, not a dir");
      const { code, stderr } = await run(["--config", configPath], { QDS_SWEEP_STATE_DIR: leg });
      expect(code).toBe(1);
      expect(stderr).toContain("report-persist-failed");
    },
    60_000,
  );

  test(
    "a STALE sweep run lock exits 3; a LIVE-held one coalesces with exit 0 and a channel line",
    async () => {
      const runsDir = join(work, "runs-lock");
      mkdirSync(runsDir, { recursive: true });
      const probe = acquireRunLock(runsDir, "probe-run", "a3-test");
      const host = readFileSync(join(runsDir, "probe-run.lock"), "utf8").trim().split(/\s+/)[1] as string;
      releaseRunLock(probe);
      const victim = Bun.spawn(["true"]);
      await victim.exited;
      expect(isAlive(victim.pid)).toBe(false);
      writeFileSync(join(runsDir, "maintenance-sweep.lock"), `${victim.pid} ${host} ${new Date().toISOString()} deadbeef\n`);
      const stale = await run(["--config", configPath], { QDS_RUNS_DIR: runsDir });
      expect(stale.code).toBe(3);
      expect(stale.stderr).toContain("stale-run-lock");
      rmSync(join(runsDir, "maintenance-sweep.lock"));
      const held = acquireRunLock(runsDir, "maintenance-sweep", "a3-test-holder");
      try {
        const coalesced = await run(["--config", configPath], { QDS_RUNS_DIR: runsDir });
        expect(coalesced.code).toBe(0);
        expect(coalesced.events.find((e) => e.event === "sweep-coalesced")).toBeDefined();
      } finally {
        releaseRunLock(held);
      }
    },
    60_000,
  );

  test(
    "usage, config, state-dir and repo-root refusals exit 2/3 with a structured error, before any sweep",
    async () => {
      for (const args of [["--daemon"], ["--driver", "fake"], ["--max-briefs", "6"], ["--max-briefs", "0"], ["--config", join(work, "missing.json")]]) {
        const r = await run(args);
        expect(r.code).toBe(2);
        expect(JSON.parse(r.stderr.trim()).error.code).toEqual(expect.any(String));
        expect(r.events).toEqual([]);
      }
      const org = join(work, "org.json");
      writeFileSync(org, JSON.stringify({ ...config, homes: [{ owner: { kind: "org", id: "acme" }, gatewayBaseUrl: "https://gateway.internal" }] }));
      expect((await run(["--config", org])).stderr).toContain("org-owner-refused");
      const outside = await run(["--config", configPath], { QDS_SWEEP_STATE_DIR: join(work, "outside-state") });
      expect(outside.code).toBe(2);
      expect(outside.stderr).toContain("state-dir-outside-repo");
      expect(existsSync(join(work, "outside-state"))).toBe(false); // refused BEFORE any write
      for (const bad of [".", ".git", ".git/maint"]) {
        const r = await run(["--config", configPath], { QDS_SWEEP_STATE_DIR: bad });
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("state-dir-outside-repo");
      }
      const elsewhere = await run(["--config", configPath], {}, work);
      expect(elsewhere.code).toBe(3);
      expect(elsewhere.stderr).toContain("not-repo-root");
    },
    120_000,
  );
});

describe("A1 digest — the second channel reads A3's residue (real binary)", () => {
  test(
    "manager-digest emits a sweep-report-undelivered escalation for an aged pending report, and a sweep run's line carries the Maintenance botId (DD-20)",
    async () => {
      const work = tmp("a3-digest-");
      const stateDir = join(work, "state");
      persistSweepReport(stateDir, report("sweep-2026-10-05", new Date(Date.now() - 9 * DAY).toISOString(), []));
      const configPath = join(work, "manager.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          homes: [{ owner: { kind: "user", id: "operator" }, gatewayBaseUrl: "https://gateway.internal" }],
          bots: [
            { id: "bot-dev", department: "dev", spendCeilingUsd: 5 },
            { id: "bot-qa", department: "qa", spendCeilingUsd: 5 },
            { id: "bot-maint", department: "maintenance", spendCeilingUsd: 5 },
          ],
        }),
      );
      // A dispatched brief in an older report: its run's digest line must carry the bot.
      const dispatchedReport = report("sweep-2026-10-12", new Date(Date.now() - 2 * DAY).toISOString(), [
        { event: "brief-dispatched", briefId: "refactor-0000abcd", workKey: "w:maint/2026-10-12/refactor-0000abcd", botId: "bot-maint", source: "graph", target: "src/lib/x.ts", kind: "refactor", runId: "qds-20261012-0000aa" },
      ]);
      persistSweepReport(stateDir, dispatchedReport);
      const entry = join(work, "fake-fleet.mjs");
      writeFileSync(
        entry,
        `if (process.argv[2] === "status") console.log(JSON.stringify({ runId: "qds-20261012-0000aa", state: "closed", createdAt: ${JSON.stringify(new Date().toISOString())} }));\nprocess.exit(0);\n`,
      );
      const proc = Bun.spawn(["bun", join(REPO_ROOT, "scripts", "manager-digest.ts"), "--config", configPath], {
        cwd: REPO_ROOT,
        env: { ...process.env, QDS_LOG_VERBOSE: "1", QDS_RUNS_DIR: join(work, "runs"), QDS_MANAGER_FLEET_ENTRY: entry, QDS_SWEEP_STATE_DIR: stateDir, QDS_COST_LEDGER_FILE: join(work, "none.db") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(0);
      expect(stdout).toContain('"kind":"sweep-report-undelivered"');
      expect(stdout).toContain('"sweepId":"sweep-2026-10-05"');
      const run = stdout
        .split("\n")
        .filter((l) => l.includes('"event":"digest-run"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>)[0];
      expect(run).toMatchObject({ runId: "qds-20261012-0000aa", botId: "bot-maint", workKey: "w:maint/2026-10-12/refactor-0000abcd" });
    },
    60_000,
  );
});
