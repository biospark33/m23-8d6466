/**
 * DF3.3 E2E slice (cluster C3): the pipeline-run wiring for the resident
 * orchestrator — `scripts/pipeline-run.ts` solicits at exactly the three
 * engine-owned points, composes DF1.2's commandGate + DF1.3's retry
 * authorization on code phases that declare a testCommand (the R2 gap), and
 * lands the resident telemetry block in the journal.
 *
 * The runner is spawned for real (pipeline-run.test.ts:36-47 pattern) with C1's
 * fake-resident.ts as the pi binary (QDS_PI_BIN) and a fixture catalog dir
 * (QDS_PI_CATALOG_DIR, the validate.test.ts:279 seam) so the resident slug's
 * rate resolves without touching ~/.pi or the network.
 *
 * Coverage: AC1a proceed-only byte-identity vs --no-resident, AC1b steered-run
 * invariants (NO byte-identity assertion, by AC1's own words), the mandatory
 * demo slice, and the telemetry boundary.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { readJournal } from "./journal-test-util.ts";
import { CORE_FIELDS } from "../../src/providers/run-record.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "pipeline-run.ts");
const FIXTURES = path.join(import.meta.dir, "fixtures");
const FIXTURE = path.join(FIXTURES, "pipeline.resident.json");
const FAKE_PI = path.join(FIXTURES, "fake-resident.ts");
const CATALOG_DIR = path.join(FIXTURES, "pi-catalog");

/** The fixture's build testCommand counts invocations in $TMPDIR under this name. */
const STATE_NAME = "qds-resident-fixture-count";

/**
 * The journal's resident block, as the e2e reads it (structural — the
 * JournalFile type grows the field in the same story, the test keeps its own
 * read-side view so assertions name exactly what the DOD names).
 */
interface ResidentBlock {
  status: string;
  directives: number;
  directivesRejected: number;
  steeringIterations: Record<string, number>;
  spendMicros: number;
  exitStatus: string | null;
  tripwires: unknown[];
}

type GateRow = {
  phase?: string;
  type?: string;
  attempt?: number;
  action?: string;
  guidance?: string;
  checks?: Array<{ item: string; ok: boolean; note: string }>;
};

type E2eJournal = ReturnType<typeof readJournal> & {
  resident?: ResidentBlock;
  gateEvents: GateRow[];
};

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df3-3-e2e-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** C1's fake contract: reply STRINGS in invocation order, last one repeats. */
const PROCEED_ONLY = [JSON.stringify({ action: "proceed" })];
const STEERED = [
  JSON.stringify({ action: "proceed" }),
  JSON.stringify({ action: "retry", guidance: "the assertion compares bytes, not strings" }),
  JSON.stringify({ action: "proceed", note: "report: steered run complete" }),
];

function stateFile(): string {
  return path.join(process.env.TMPDIR ?? os.tmpdir(), STATE_NAME);
}

function spawnRunner(args: string[], markerRoot: string, env: Record<string, string>) {
  // `process.execPath`, not "bun": a sibling suite that rewrites PATH must not
  // decide which runtime this spawns (pipeline-run.test.ts:38-41).
  return Bun.spawn({
    cmd: [process.execPath, RUNNER, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      QDS_RUN_ROOT: markerRoot,
      QDS_PI_BIN: FAKE_PI,
      QDS_PI_CATALOG_DIR: CATALOG_DIR,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

interface LegOpts {
  runId: string;
  requestId: string;
  noResident?: boolean;
  replies?: string[];
  /** Replaces the default run-context.json body (the arm-on-content test drops requestId). */
  witness?: Record<string, unknown>;
}

/** One e2e leg: fresh workspace, manifest + dispatch witness, reset counter, run. */
async function runLeg(
  name: string,
  opts: LegOpts,
): Promise<{ dir: string; journal: E2eJournal; exitCode: number; stderr: string }> {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "pipeline.resident.json");
  fs.copyFileSync(FIXTURE, manifest);
  // The pair dispatch leaves beside the manifest: requestId routes the runner
  // onto the resident path; the ceiling satisfies the cap-witness reader.
  fs.writeFileSync(
    path.join(dir, "run-context.json"),
    JSON.stringify(
      opts.witness ?? {
        runId: opts.runId,
        pipelineId: "resident-e2e",
        requestId: opts.requestId,
        repoSlug: "qds/demo",
        issueId: 42,
        effectiveCeilingMicros: 250_000,
      },
    ),
  );
  // The counter starts at zero for this leg — attempt 1 fails, attempt 2 passes.
  fs.rmSync(stateFile(), { force: true });
  const markerRoot = path.join(dir, "marker");
  const journalPath = path.join(dir, "out.json");
  const proc = spawnRunner(
    [
      "--manifest", manifest,
      "--budget-ms", "200000",
      "--journal", journalPath,
      "--run-root", dir,
      "--run-id", opts.runId,
      "--request-id", opts.requestId,
      ...(opts.noResident ? ["--no-resident"] : []),
    ],
    markerRoot,
    opts.replies === undefined ? {} : { FAKE_RESIDENT_REPLIES: JSON.stringify(opts.replies) },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return {
    dir,
    journal: JSON.parse(fs.readFileSync(journalPath, "utf8")) as E2eJournal,
    exitCode,
    stderr,
  };
}

/** Parsed JSON-object stderr lines; relayed child output is skipped. */
function jsonLines(stderr: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of stderr.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      parsed.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* relayed child noise that merely starts with "{" */
    }
  }
  return parsed;
}

/** Timing fields deleted at every depth: timestamps, durations, and *_ms sub-timings. */
const TIMING_KEYS = new Set([
  "completedAt",
  "startedAt",
  "updatedAt",
  "durationMs",
  "subTimings",
  "gate_exec_ms",
  "gate_report_ms",
  "gate_ms",
]);

/** AC1a's comparable view: `resident.*` and timing fields deleted, recursively. */
function stripped(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripped);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "resident" || TIMING_KEYS.has(k)) continue;
    out[k] = stripped(v);
  }
  return out;
}

/** Deterministic JSON text: object keys sorted at every depth. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

describe("DF3.3 resident e2e — pipeline-run wiring", () => {
  test("AC1a: a proceed-only resident yields a journal byte-identical to the --no-resident control", async () => {
    const runId = "resident-ac1a-run";
    const requestId = crypto.randomUUID();
    const proceed = await runLeg("ac1a-proceed", { runId, requestId, replies: PROCEED_ONLY });
    const control = await runLeg("ac1a-control", { runId, requestId, noResident: true });
    expect(proceed.exitCode).toBe(0);
    expect(control.exitCode).toBe(0);

    // Byte-identity once resident.* and timing fields are excluded — asserted
    // BOTH as deep equality and as stable-stringified text (the DOD's shape).
    expect(stripped(proceed.journal)).toEqual(stripped(control.journal));
    expect(stable(stripped(proceed.journal))).toBe(stable(stripped(control.journal)));

    // The strips were load-bearing: the raw journals differ exactly by the
    // resident block, and the control leg says WHY it has no resident.
    expect(proceed.journal.resident).toBeDefined();
    expect(control.journal.resident?.status).toBe("disabled");
  }, 120_000);

  test("AC1b: a steered run preserves phase order, derives verdicts from evidence, promotes nothing unearned", async () => {
    const steered = await runLeg("ac1b-steered", {
      runId: "resident-ac1b-run",
      requestId: crypto.randomUUID(),
      replies: STEERED,
    });
    expect(steered.exitCode).toBe(0);
    const j = steered.journal;

    // Phase order preserved: declaration order, nothing reordered, added, or dropped.
    expect(j.phases.map((p) => p.name)).toEqual(["plan", "build"]);

    // Every gate verdict computed from real evidence: the build gate events
    // carry the test command's actual exit codes as their check notes.
    const buildGates = j.gateEvents.filter(
      (e) => e.phase === "build" && (e.type === "gate_fail" || e.type === "gate_pass"),
    );
    expect(buildGates).toHaveLength(2);
    expect(buildGates[0]?.type).toBe("gate_fail");
    expect(buildGates[0]?.attempt).toBe(1);
    expect(JSON.stringify(buildGates[0]?.checks)).toContain("exit 1");
    expect(buildGates[1]?.type).toBe("gate_pass");
    expect(buildGates[1]?.attempt).toBe(2);
    expect(JSON.stringify(buildGates[1]?.checks)).toContain("exit 0");

    // No unearned promotion: the plan phase (no testCommand) never touches a
    // gate — its success is a clean body exit and nothing else — and build's
    // success exists only on the attempt-2 pass above, the same evidence the
    // --no-resident control promotes on (AC1a proved the control equivalent).
    expect(j.gateEvents.filter((e) => e.phase === "plan")).toHaveLength(0);
    expect(j.phases.map((p) => p.status)).toEqual(["success", "success"]);

    // Byte-identity is deliberately NOT asserted of a steered run (AC1).
  }, 60_000);

  test("demo: out.json shows gate fail → steered retry with guidance → pass, plus resident telemetry", async () => {
    const steered = await runLeg("demo", {
      runId: "resident-demo-run",
      requestId: crypto.randomUUID(),
      replies: STEERED,
    });
    expect(steered.exitCode).toBe(0);
    const j = steered.journal;

    // The E2E slice, in journal order: gate fails on attempt 1, the accepted
    // retry directive carries its guidance text, the gate passes on attempt 2.
    const seq = j.gateEvents
      .filter((e) => e.phase === "build")
      .map((e) => ({ type: e.type, attempt: e.attempt }));
    expect(seq).toEqual([
      { type: "gate_fail", attempt: 1 },
      { type: "resident_directive", attempt: 2 },
      { type: "gate_pass", attempt: 2 },
    ]);
    const directive = j.gateEvents.find((e) => e.type === "resident_directive");
    expect(directive?.action).toBe("retry");
    expect(directive?.guidance).toBe("the assertion compares bytes, not strings");

    const r = j.resident;
    expect(r?.status).toBe("active");
    expect(r?.directives).toBe(3);
    expect(r?.steeringIterations).toEqual({ build: 1 });
    expect(typeof r?.spendMicros).toBe("number");
    expect(Number.isInteger(r?.spendMicros)).toBe(true);

    // §5.2 / DOD-Security: every prompt and raw reply persisted PRE-EXECUTION,
    // redacted, beside the journal — 3 solicited points => 3 prompts + 3 replies.
    const artifacts = fs
      .readdirSync(steered.dir)
      .filter((f) => f.startsWith("resident-demo-run-solicit-"))
      .sort();
    expect(artifacts).toHaveLength(6);
    const promptFile = path.join(steered.dir, "resident-demo-run-solicit-1-prompt.txt");
    expect(fs.statSync(promptFile).mode & 0o777).toBe(0o600);
    // And the brief's content (not just its presence) reached the resident.
    expect(fs.readFileSync(promptFile, "utf8")).toContain("repoSlug");
  }, 60_000);

  test("select_roster outside DF1.5's closed set is rejected at the wiring level, never accepted", async () => {
    const leg = await runLeg("roster-closed-set", {
      runId: "resident-roster-run",
      requestId: crypto.randomUUID(),
      replies: [
        JSON.stringify({ action: "select_roster", phase: "build", rosterId: "no-such-role" }),
        JSON.stringify({ action: "proceed" }),
      ],
    });
    // A rejected directive resolves to the deterministic default: the run
    // itself is unaffected — gate fail → authorized retry → pass, exit 0.
    expect(leg.exitCode).toBe(0);
    const r = leg.journal.resident;
    expect(r?.directives).toBe(2);
    expect(r?.directivesRejected).toBe(1);
    expect(r?.tripwires).toHaveLength(1);
    const tripwire = (r?.tripwires ?? [])[0] as { cause?: string; detail?: string } | undefined;
    expect(tripwire?.cause).toBe("gate_bypass_attempt");
    expect(tripwire?.detail).toContain("no-such-role");

    // The observability line tells the truth about acceptance: a rejected
    // reply resolves to the deterministic default (directiveAction "proceed"),
    // and accepted is FALSE — the count did not move; the later accepted
    // proceed is accepted:true.
    const solicits = jsonLines(leg.stderr).filter((l) => l.event === "resident_solicit");
    const runStart = solicits.find((l) => l.point === "run_start");
    expect(runStart?.directiveAction).toBe("proceed");
    expect(runStart?.accepted).toBe(false);
    const postGate = solicits.find((l) => l.point === "post_gate_failure");
    expect(postGate?.directiveAction).toBe("proceed");
    expect(postGate?.accepted).toBe(true);
  }, 60_000);

  test("arming reads the brief's CONTENT, not requestId alone — a witness without requestId still arms", async () => {
    const leg = await runLeg("arm-on-content", {
      runId: "resident-arm-run",
      requestId: crypto.randomUUID(),
      replies: PROCEED_ONLY,
      witness: { repoSlug: "qds/demo", issueId: 42, effectiveCeilingMicros: 250_000 },
    });
    expect(leg.exitCode).toBe(0);
    expect(leg.journal.resident?.status).toBe("active");
    expect(leg.journal.resident?.directives).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test("telemetry boundary: spec fields present, zero ratio/percentage/share fields, DF2.1 run record untouched", async () => {
    const steered = await runLeg("telemetry", {
      runId: "resident-telemetry-run",
      requestId: crypto.randomUUID(),
      replies: STEERED,
    });
    const j = steered.journal;

    // The resident block carries exactly the spec's field set (AC5) — closed,
    // no extras smuggled in alongside.
    expect(Object.keys(j.resident ?? {}).sort()).toEqual([
      "directives",
      "directivesRejected",
      "exitStatus",
      "spendMicros",
      "status",
      "steeringIterations",
      "tripwires",
    ]);
    expect(j.resident?.exitStatus === null || typeof j.resident?.exitStatus === "string").toBe(true);
    expect(Array.isArray(j.resident?.tripwires)).toBe(true);

    // ZERO ratio / percentage / share-of-run-total fields anywhere (R5 §6 fact
    // 12). Segment-level, not substring: "durationMs" merely CONTAINS "ratio"
    // (du-ratio-n) — a timing field, not a ratio field.
    const FORBIDDEN_SEGMENTS = new Set(["ratio", "percent", "share"]);
    const segmentsOf = (key: string): string[] =>
      key
        .split(/(?=[A-Z])|[_-]/)
        .map((s) => s.toLowerCase())
        .filter((s) => s.length > 0);
    const ratioKeys: string[] = [];
    const walkKeys = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const x of v) walkKeys(x);
        return;
      }
      if (v === null || typeof v !== "object") return;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (segmentsOf(k).some((s) => FORBIDDEN_SEGMENTS.has(s))) ratioKeys.push(k);
        walkKeys(val);
      }
    };
    walkKeys(j);
    expect(ratioKeys).toEqual([]);

    // DF2.1's closed run record: still exactly the 13 core fields — this
    // story adds none (the journal's own file grew only the optional block).
    expect(Object.keys(CORE_FIELDS)).toHaveLength(13);
    expect(Object.keys(CORE_FIELDS)).toEqual([
      "runId", "vmName", "httpsUrl", "keyHash", "limitMicroUsd", "spendMicroUsd",
      "sessionId", "commitSha", "requestId", "ports", "pid", "createdAt", "closedAt",
    ]);
    expect(Object.keys(j).sort()).toEqual([
      "completedAt", "gateEvents", "ok", "phases", "resident", "runId", "version",
    ]);
  }, 60_000);
});
