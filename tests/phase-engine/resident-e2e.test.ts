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
 * demo slice, the telemetry boundary, the arming negative control, the
 * degraded-resident path, and the non-positive-ceiling witness refusal.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { readJournal } from "./journal-test-util.ts";
import { EXIT_STATUSES } from "../../cli-anything/src/types.ts";
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
 * The counter lives in the LEG DIR — the same value spawnRunner hands the
 * runner as TMPDIR, which childEnv forwards to the fixture's `sh -c`. One
 * source of truth: a TMPDIR-unset host (empty `$TMPDIR` → the counter lands
 * at /) and concurrent suite processes (a fixed name in the global TMPDIR)
 * both diverge from the test's own reset unless the two sides agree.
 */
function stateFile(dir: string): string {
  return path.join(dir, STATE_NAME);
}

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

/**
 * DOD-Security redaction probe (D11): a value long enough to clear
 * cli-anything redact.ts's MIN_REDACTABLE_VALUE_LEN, env-borne under a name
 * the SECRET_KEY_RE heuristic already matches. The brief carries no
 * credential-shaped value, so INV-RES-3's run refusal is not triggered — the
 * only thing this exercises is artifact redaction.
 */
const REDACTION_PROBE = "sk-fake-e2e-redaction-probe-000000";

/** C1's fake contract: reply STRINGS in invocation order, last one repeats. */
const PROCEED_ONLY = [JSON.stringify({ action: "proceed" })];
const STEERED = [
  JSON.stringify({ action: "proceed" }),
  JSON.stringify({ action: "retry", guidance: "the assertion compares bytes, not strings" }),
  JSON.stringify({ action: "proceed", note: "report: steered run complete" }),
];

function spawnRunner(
  args: string[],
  markerRoot: string,
  tmpDir: string,
  env: Record<string, string>,
) {
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
      // #219 / INV-RES-3: startResident refuses an arming whose child env
      // carries no non-blank OPENROUTER_API_KEY. The fake pi needs no real
      // key, but the SEAM asserts presence regardless — supply a fixture
      // value so the runner's arming is the production shape, never
      // host-env-dependent (a dev shell with a real key set would otherwise
      // change which tests pass).
      OPENROUTER_API_KEY: "sk-or-v1-df33-e2e-fixture-key-000000111111",
      // S2-4's least-privilege child env (src/fleet/resident.ts's
      // CHILD_ENV_ALLOWLIST) strips everything the fake pi is scripted by.
      // QDS_RESIDENT_ENV_PASSTHROUGH is the documented escape hatch: these
      // names are read from the RUNNER's env and forwarded to the pi child.
      QDS_RESIDENT_ENV_PASSTHROUGH:
        "FAKE_RESIDENT_REPLIES,FAKE_RESIDENT_USAGE,FAKE_RESIDENT_EXIT,FAKE_RESIDENT_HANG,FAKE_RESIDENT_HANG_AT,FAKE_RESIDENT_ECHO_ENV",
      // Per-leg scratch: childEnv forwards it to the manifest command, whose
      // counter then lives in THIS leg's dir (stateFile's single source), not
      // in a host-global TMPDIR other suite processes share.
      TMPDIR: tmpDir,
      // The custom rate registry is unsteered on a host that has one — an
      // EACCES there fails every leg, a priced entry silently changes the
      // fixture's spendMicros. ENOENT is the sanctioned empty registry.
      QDS_PI_MODELS_JSON: path.join(tmpDir, "no-such-models.json"),
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
  /** Replaces the default run-context.json body (the arming legs shape the
   *  brief the arming predicate reads). */
  witness?: Record<string, unknown>;
  /** Extra child env (the redaction probe, the fixture's own knobs). */
  env?: Record<string, string>;
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
  fs.rmSync(stateFile(dir), { force: true });
  const markerRoot = path.join(dir, "marker");
  const journalPath = path.join(dir, "out.json");
  // Matches the fixture's runBudgetMs and sits below every test timeout: a
  // hung run fails an assertion inside the test rather than outliving it, so
  // the finally's kill is the backstop, not the mechanism.
  const proc = spawnRunner(
    [
      "--manifest", manifest,
      "--budget-ms", "50000",
      "--journal", journalPath,
      "--run-root", dir,
      "--run-id", opts.runId,
      "--request-id", opts.requestId,
      ...(opts.noResident ? ["--no-resident"] : []),
    ],
    markerRoot,
    dir,
    {
      ...(opts.replies === undefined ? {} : { FAKE_RESIDENT_REPLIES: JSON.stringify(opts.replies) }),
      ...opts.env,
    },
  );
  try {
    // stdout AND stderr both drained: piped-but-undrained fds deadlock at the
    // 64KB pipe buffer (the banner relays a manifest's stderr in full).
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let journal: E2eJournal;
    try {
      journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as E2eJournal;
    } catch (err) {
      // A runner that died before the journal file existed (arming refusal,
      // cap refusal) must not surface as a bare ENOENT — the operator (and
      // the failure diff) needs the exit code and the stderr tail.
      throw new Error(
        `journal ${journalPath} unreadable after exit ${exitCode}: ` +
          `${(err as Error).message}\nstderr tail: ${stderr.slice(-2000)}`,
        { cause: err },
      );
    }
    void stdout;
    return { dir, journal, exitCode, stderr };
  } finally {
    // The tree dies with the test even on a timeout: budget overruns and
    // fixture hangs must not orphan a runner into the next suite.
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    // Per-leg, not per-suite: legs may share a name across re-runs and the
    // counter must start at zero for THIS leg only.
    fs.rmSync(stateFile(dir), { force: true });
  }
}

/** Structured stderr lines: an `event` field is the runner's own; relayed
 *  child JSON (phase log lines start with "{") is skipped. */
function jsonLines(stderr: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of stderr.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const row = JSON.parse(t) as Record<string, unknown>;
      if (typeof row.event === "string") parsed.push(row);
    } catch {
      /* relayed child noise that merely starts with "{" */
    }
  }
  return parsed;
}

/** The runner's resident_solicit observability lines for one point. */
const solicitsAt = (stderr: string, point: string): Record<string, unknown>[] =>
  jsonLines(stderr).filter((l) => l.event === "resident_solicit" && l.point === point);

type TraceRow = { type?: string; name?: string; payload_json?: string | null };

/** The tracer's JSONL mirror (`<run-root>/trace/events.jsonl`), parsed. */
function readTraceRows(dir: string): TraceRow[] {
  return fs
    .readFileSync(path.join(dir, "marker", "trace", "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceRow);
}

/** The run's resident_directive trace rows (accepted non-proceed directives). */
const directiveRows = (dir: string): TraceRow[] =>
  readTraceRows(dir).filter((r) => r.type === "log" && r.name === "resident_directive");

/** Timing-shaped keys, pattern-based (the old allowlist grew by hand and closed
 *  on itself): suffix `Ms`/`ms` and `At`/`_at` cover timestamps, durations and
 *  the sub-timing family; `subTimings` is the one container name. A future
 *  timing field must not reopen AC1a's diff. */
const TIMING_KEY_RE = /Ms$|MS$|(^|[^A-Za-z])ms$|(At|_at)$|^at$|^subTimings$/;

/** AC1a's comparable view: the journal's top-level `resident` block and every
 * timing-shaped key at every depth, deleted. */
function stripped(value: unknown, top = true): unknown {
  if (Array.isArray(value)) return value.map((v) => stripped(v, false));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (top && k === "resident") continue;
    if (TIMING_KEY_RE.test(k)) continue;
    out[k] = stripped(v, false);
  }
  return out;
}

describe("DF3.3 resident e2e — pipeline-run wiring", () => {
  test("AC1a: a proceed-only resident yields a journal byte-identical to the --no-resident control", async () => {
    const runId = "resident-ac1a-run";
    const requestId = crypto.randomUUID();
    const proceed = await runLeg("ac1a-proceed", { runId, requestId, replies: PROCEED_ONLY });
    const control = await runLeg("ac1a-control", { runId, requestId, noResident: true });
    expect(proceed.exitCode).toBe(0);
    expect(control.exitCode).toBe(0);

    // Byte-identity once resident.* and timing fields are excluded. Deep
    // equality only: `stable()` re-stated the same comparison as text (and
    // bun's own diff output is the readable form when it fails), so the second
    // assertion was redundancy, not extra strength.
    expect(stripped(proceed.journal)).toEqual(stripped(control.journal));

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
    expect(JSON.stringify(buildGates[0]?.checks)).toMatch(/exit 1\b/);
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

  test("demo: gate fail → steered retry with guidance → pass, directive on the trace, telemetry in the journal", async () => {
    const runId = "resident-demo-run";
    const steered = await runLeg("demo", {
      runId,
      requestId: crypto.randomUUID(),
      replies: [
        STEERED[0]!,
        STEERED[1]!,
        // The probe rides into the reply artifact PRE-redaction: the fixture
        // substitutes the named env var's value for the placeholder, so the
        // run_end reply genuinely carries the credential-shaped value until
        // resident.ts's persist chokepoint redacts it.
        JSON.stringify({ action: "proceed", note: "report: steered run complete {{FAKE_RESIDENT_ECHO}}" }),
      ],
      env: { OPENROUTER_API_KEY: REDACTION_PROBE, FAKE_RESIDENT_ECHO_ENV: "OPENROUTER_API_KEY" },
    });
    expect(steered.exitCode).toBe(0);
    const j = steered.journal;

    // The E2E slice, in journal order: gate fails on attempt 1, gate passes
    // on attempt 2. The directive itself is NOT a gate event — accepted
    // directives are trace rows (wave-1 C2: a gate event would fabricate a
    // passed:0 verdict in the DF1.4 bridge, and `log` is the closed event
    // type they ride) — asserted below against the trace mirror.
    const seq = j.gateEvents
      .filter((e) => e.phase === "build")
      .map((e) => ({ type: e.type, attempt: e.attempt }));
    expect(seq).toEqual([
      { type: "gate_fail", attempt: 1 },
      { type: "gate_pass", attempt: 2 },
    ]);

    // The directive's own record: `<run-root>/trace/events.jsonl` (the
    // tracer's JSONL mirror of trace.db), payload naming the action and the
    // guidance the engine-authorized attempt N+1 consumed.
    const directives = directiveRows(steered.dir);
    expect(directives).toHaveLength(1);
    const payload = JSON.parse(directives[0]?.payload_json ?? "{}") as {
      action?: string;
      guidance?: string;
      attempt?: number;
      phase?: string;
    };
    expect(payload.action).toBe("retry");
    expect(payload.guidance).toBe("the assertion compares bytes, not strings");
    expect(payload.attempt).toBe(2);
    expect(payload.phase).toBe("build");

    const r = j.resident;
    expect(r?.status).toBe("active");
    // The partition: 3 solicitations, all accepted, none rejected (D8).
    expect(r?.directives).toBe(3);
    expect(r?.directivesRejected).toBe(0);
    expect(r?.steeringIterations).toEqual({ build: 1 });
    // Deterministic from the fixture's fixed usage (1000 in / 64 out) and the
    // catalog's fixed rate ($0.08/$0.18 per MTok → 80_000/180_000 µ$): every
    // call rounds to 80 + 12 = 92 µ$, three calls = 276 (D7 — the meter is
    // pinned, not merely typed).
    expect(r?.spendMicros).toBe(276);
    // CC-1 enum membership (AC5 DOD): the journaled exitStatus must parse
    // against the closed 5-value taxonomy — a regression writing e.g. "ok"
    // would pass a mere null-or-string type check. All three calls in this
    // run succeeded, so the value is pinned as well as parsed. (Widened to
    // unknown[] only so the nullable read-side view typechecks against the
    // const tuple; the runtime comparison is unchanged.)
    const cc1: readonly unknown[] = EXIT_STATUSES;
    expect(cc1).toContain(r?.exitStatus);
    expect(r?.exitStatus).toBe("success");

    // §5.2 / DOD-Security: every prompt and raw reply persisted PRE-EXECUTION,
    // redacted, beside the journal — 3 solicited points => 3 prompts + 3 replies.
    const artifacts = fs
      .readdirSync(steered.dir)
      .filter((f) => f.startsWith(`${runId}-solicit-`))
      .sort();
    expect(artifacts).toHaveLength(6);
    const promptFile = path.join(steered.dir, `${runId}-solicit-1-prompt.txt`);
    // 0600, asserted portably: no group/other access bits (a umask-dependent
    // host that lands the file at 0400 still honours the contract).
    expect(fs.statSync(promptFile).mode & 0o077).toBe(0);
    // And the brief's content (not just its presence) reached the resident.
    expect(fs.readFileSync(promptFile, "utf8")).toContain("repoSlug");

    // DOD-Security redaction, actually asserted: a credential the child was
    // handed must not survive into any persisted artifact. NON-VACUOUS: the
    // run_end reply carried the probe pre-redaction (the fixture's echo mode
    // above), so the redacted form must be PRESENT — deleting the redaction
    // chokepoint now fails this twice over.
    const runEndReply = fs.readFileSync(path.join(steered.dir, `${runId}-solicit-3-reply.txt`), "utf8");
    expect(runEndReply).toContain("[REDACTED:OPENROUTER_API_KEY]");
    expect(runEndReply).not.toContain(REDACTION_PROBE);
    for (const f of artifacts) {
      expect(fs.readFileSync(path.join(steered.dir, f), "utf8")).not.toContain(REDACTION_PROBE);
    }
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
    // The partition holds under rejection too: 3 solicitations = 2 accepted
    // + 1 rejected (D8's sum is the solicitation count, not a second truth).
    expect(r?.directives).toBe(2);
    expect(r?.directivesRejected).toBe(1);
    expect((r?.directives ?? 0) + (r?.directivesRejected ?? 0)).toBe(3);
    expect(r?.tripwires).toHaveLength(1);
    const tripwire = (r?.tripwires ?? [])[0] as { cause?: string; detail?: string } | undefined;
    expect(tripwire?.cause).toBe("gate_bypass_attempt");
    expect(tripwire?.detail).toContain("no-such-role");

    // The observability line tells the truth about acceptance: a rejected
    // reply resolves to the deterministic default (directiveAction "proceed"),
    // and accepted is FALSE — the count did not move; the later accepted
    // proceed is accepted:true.
    const [runStart] = solicitsAt(leg.stderr, "run_start");
    expect(runStart?.directiveAction).toBe("proceed");
    expect(runStart?.accepted).toBe(false);
    const [postGate] = solicitsAt(leg.stderr, "post_gate_failure");
    expect(postGate?.directiveAction).toBe("proceed");
    expect(postGate?.accepted).toBe(true);
  }, 60_000);

  test("run_start abort: zero phases walked, the empty run settles not-ok (exit 1), run_end never solicited", async () => {
    const leg = await runLeg("abort-run-start", {
      runId: "resident-abort-start-run",
      requestId: crypto.randomUUID(),
      replies: [JSON.stringify({ action: "abort", reason: "manifest targets the wrong repo" })],
    });
    // abort is the engine's own fail transition: finish settles the empty run
    // not-ok (ok = phases > 0 && …), so the run exits 1, not 0 or 2.
    expect(leg.exitCode).toBe(1);
    const j = leg.journal;
    expect(j.ok).toBe(false);
    // walkPhases never ran: no phase rows, no gate events.
    expect(j.phases).toHaveLength(0);
    expect(j.gateEvents).toHaveLength(0);
    const r = j.resident;
    expect(r?.status).toBe("active");
    expect(r?.directives).toBe(1);
    expect(r?.directivesRejected).toBe(0);

    // The run_end solicitation is SKIPPED on an aborted run (abort stops the
    // resident conversation too): exactly one solicitation line exists.
    const lines = jsonLines(leg.stderr).filter((l) => l.event === "resident_solicit");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.point).toBe("run_start");
    expect(lines[0]?.directiveAction).toBe("abort");
    expect(lines[0]?.accepted).toBe(true);

    // The accepted non-proceed directive is recorded (S3-15): one trace row
    // carrying the abort and the agent's reason.
    const directives = directiveRows(leg.dir);
    expect(directives).toHaveLength(1);
    const payload = JSON.parse(directives[0]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload.point).toBe("run_start");
    expect(payload.action).toBe("abort");
    expect(payload.reason).toBe("manifest targets the wrong repo");
  }, 60_000);

  test("post_gate_failure abort: the authorized retry is declined, the phase settles fail, no second attempt runs", async () => {
    const leg = await runLeg("abort-post-gate", {
      runId: "resident-abort-gate-run",
      requestId: crypto.randomUUID(),
      replies: [
        JSON.stringify({ action: "proceed" }),
        JSON.stringify({ action: "abort", reason: "the failure is not retryable" }),
        JSON.stringify({ action: "proceed" }),
      ],
    });
    // The caught GateFailureError is rethrown: build settles fail on attempt
    // 1, the walk halts, and the run settles not-ok.
    expect(leg.exitCode).toBe(1);
    const j = leg.journal;
    expect(j.ok).toBe(false);
    expect(j.phases.map((p) => [p.name, p.status])).toEqual([
      ["plan", "success"],
      ["build", "fail"],
    ]);
    // No retry attempt: exactly one gate event — the attempt-1 failure.
    expect(j2GateSeq(j)).toEqual([{ type: "gate_fail", attempt: 1 }]);

    // The abort's own record: a resident_directive trace row carrying the
    // reason and the attempt the retry would have been.
    const directives = directiveRows(leg.dir);
    expect(directives).toHaveLength(1);
    const payload = JSON.parse(directives[0]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload.action).toBe("abort");
    expect(payload.reason).toBe("the failure is not retryable");
    expect(payload.attempt).toBe(2);
    expect(payload.phase).toBe("build");

    // A post-gate abort is NOT residentAborted — the run_end solicitation
    // still fires: three solicitations, all accepted.
    const lines = jsonLines(leg.stderr).filter((l) => l.event === "resident_solicit");
    expect(lines.map((l) => l.point)).toEqual(["run_start", "post_gate_failure", "run_end"]);
    expect(lines.map((l) => l.directiveAction)).toEqual(["proceed", "abort", "proceed"]);
    const r = j.resident;
    expect(r?.status).toBe("active");
    expect(r?.directives).toBe(3);
    expect(r?.directivesRejected).toBe(0);
    // An abort never counts as a steering iteration (retries only).
    expect(r?.steeringIterations).toEqual({});
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
    // All 3 engine-owned points solicited — an armed resident is never silent.
    expect(leg.journal.resident?.directives).toBe(3);
  }, 60_000);

  test("arming negative control: a brief with no identity field leaves the resident disabled", async () => {
    const leg = await runLeg("arm-negative", {
      runId: "resident-arm-negative-run",
      requestId: crypto.randomUUID(),
      replies: PROCEED_ONLY,
      // --request-id still rides the argv (runLeg passes it), and the witness
      // still satisfies the cap reader — but the BRIEF carries none of the
      // identity fields arming reads, so a resident that armed on "a witness
      // happened to exist" would be the bug.
      witness: { effectiveCeilingMicros: 250_000 },
    });
    expect(leg.exitCode).toBe(0);
    // AC4's explicit disabled shape — not an absent block, never a half-armed one.
    expect(leg.journal.resident).toEqual({
      status: "disabled",
      directives: 0,
      directivesRejected: 0,
      steeringIterations: {},
      spendMicros: 0,
      exitStatus: null,
      tripwires: [],
    });
    // And the run is fully deterministic: no solicitation observability line,
    // because nothing was solicited.
    expect(jsonLines(leg.stderr).filter((l) => l.event === "resident_solicit")).toHaveLength(0);
  }, 60_000);

  test("telemetry boundary: spec fields present, zero ratio/percentage/share fields, DF2.1 run record untouched", async () => {
    const steered = await runLeg("telemetry", {
      runId: "resident-telemetry-run",
      requestId: crypto.randomUUID(),
      replies: STEERED,
    });
    expect(steered.exitCode).toBe(0);
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
    // Canary: the splitter must actually see the ratio segment a smuggled key
    // carries — a broken camelCase/snake_case splitter would silently pass
    // everything below and the detector would be dead code.
    expect(segmentsOf("costRatio").some((s) => FORBIDDEN_SEGMENTS.has(s))).toBe(true);
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

  test("degraded resident: a dying resident process degrades to the deterministic default and the run still settles", async () => {
    const leg = await runLeg("degraded", {
      runId: "resident-degraded-run",
      requestId: crypto.randomUUID(),
      env: { FAKE_RESIDENT_EXIT: "3" },
    });
    // The resident process exits non-zero on EVERY call (the fixture prints
    // its reply, then exits 3), so the very first solicitation at run_start
    // fails the call — and the RUN is unaffected: AC3's degrade, never a
    // failed run, never a skipped gate.
    expect(leg.exitCode).toBe(0);
    const r = leg.journal.resident;
    expect(r?.status).toBe("degraded");
    expect(r?.directives).toBe(0);
    expect(r?.directivesRejected).toBe(0);
    expect(r?.spendMicros).toBe(0);
    // Every later point short-circuits on the degraded status: still exactly
    // 3 observability lines, each resolving to the deterministic default.
    const lines = jsonLines(leg.stderr).filter((l) => l.event === "resident_solicit");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.directiveAction)).toEqual(["proceed", "proceed", "proceed"]);
    // The engine-authorized retry runs unguided and passes.
    expect(j2GateSeq(leg.journal)).toEqual([
      { type: "gate_fail", attempt: 1 },
      { type: "gate_pass", attempt: 2 },
    ]);
    expect(leg.journal.phases.map((p) => p.status)).toEqual(["success", "success"]);
    // C3's process-end mapping (wave-1 B6): a non-zero pi exit is "logic",
    // surfaced in the journal's resident block even though the run succeeded.
    expect(r?.exitStatus).toBe("logic");
  }, 60_000);

  test("first SIGINT during the run-end solicitation stops the resident via the normal cleanup path", async () => {
    // The CodeRabbit scenario: the run has already settled, the run_end pi
    // call hangs, and Run.terminate has no abort target left — so the FIRST
    // signal must stop the owned resident itself. Without that, the runner
    // sits on the hung call until the pi timeout (600 s here) or a second
    // Ctrl-C; with it, the kill lands as a degraded PROCEED and the ordinary
    // tail (exitStatus, idempotent re-stop, resident block, tracer close)
    // finishes the process promptly with the run's own verdict intact.
    const dir = path.join(tmpRoot, "run-end-signal");
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, "pipeline.resident.json");
    fs.copyFileSync(FIXTURE, manifest);
    fs.writeFileSync(
      path.join(dir, "run-context.json"),
      JSON.stringify({
        runId: "sig-run-end",
        pipelineId: "resident-e2e",
        requestId: "req-sig-run-end",
        repoSlug: "qds/demo",
        issueId: 42,
        effectiveCeilingMicros: 250_000,
      }),
    );
    fs.rmSync(stateFile(dir), { force: true });
    const journalPath = path.join(dir, "out.json");
    // startResident's sessionDir is the journal's directory; the fixture
    // appends one marker per invocation, so the file is the readiness probe.
    const sessionPath = path.join(dir, "sig-run-end.resident.jsonl");
    const invocations = (): number => {
      try {
        return fs
          .readFileSync(sessionPath, "utf8")
          .split("\n")
          .filter((l) => l.includes('"fake_resident_invocation"')).length;
      } catch {
        return 0;
      }
    };
    const proc = spawnRunner(
      [
        "--manifest", manifest,
        "--budget-ms", "50000",
        "--journal", journalPath,
        "--run-root", dir,
        "--run-id", "sig-run-end",
        "--request-id", "req-sig-run-end",
      ],
      path.join(dir, "marker"),
      dir,
      {
        FAKE_RESIDENT_REPLIES: JSON.stringify(PROCEED_ONLY),
        // Hang ONLY invocation 2 (run_end): run_start and post_gate answered,
        // the run settles, and the third pi call is the one under signal fire.
        FAKE_RESIDENT_HANG_AT: "2",
        // The hang must outlive the test by a wide margin — the first-signal
        // stop, not the timeout, is the mechanism that ends this run.
        QDS_RESIDENT_TIMEOUT_MS: "600000",
      },
    );
    try {
      // Three markers = run_start + post_gate answered and the run_end call
      // STARTED (markers append pre-hang), i.e. finish() has already settled
      // the run and the hung solicitation is the only await left in main.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && invocations() < 3) {
        await Bun.sleep(50);
      }
      expect(invocations()).toBe(3);

      proc.kill("SIGINT");
      // Start the drains BEFORE the exit poll (W2-4): piped-but-undrained
      // fds deadlock at the 64KB pipe buffer, so a burst between signal and
      // exit would deadlock the runner into the 30s timeout below — the same
      // concurrent Promise.all shape runLeg uses.
      const drained = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      // Poll-until-exit with a generous bound, not a wall-clock pin: between
      // signal and exit the runner does a SIGKILL + await, a journal flush
      // (write+fsync+rename), a SQLite checkpoint/close and the banner write —
      // on a saturated CI host that can legitimately outlast any fixed
      // millisecond budget, and a timeout there must read as host slowness
      // (with the stderr tail for the failure diff), not a functional
      // regression. 30 s is still far below the 600 s resident timeout the
      // first-signal stop exists to avoid.
      const exitDeadline = Date.now() + 30_000;
      while (proc.exitCode === null && proc.signalCode === null && Date.now() < exitDeadline) {
        await Bun.sleep(50);
      }
      const [, stderr] = await drained;
      // Prompt exit: the stop→degrade→cleanup chain, not a 600 s timeout.
      // The run settled ok BEFORE the signal; a signal aimed at telemetry must
      // not rewrite a settled verdict — the normal path returns finish's code.
      expect(
        proc.exitCode,
        `runner still alive 30 s after SIGINT; stderr tail: ${stderr.slice(-2000)}`,
      ).toBe(0);
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as E2eJournal;
      expect(journal.ok).toBe(true);
      expect(journal.phases.map((p) => p.status)).toEqual(["success", "success"]);
      // The killed run_end call degrades the resident and records the process
      // end as transient (a signal death), in the refreshed resident block.
      expect(journal.resident?.status).toBe("degraded");
      expect(journal.resident?.exitStatus).toBe("transient");
      // All three solicitation lines emit — the killed run_end call degrades
      // INSIDE steering.solicit (its catch returns PROCEED), so the line still
      // lands — and no second-signal "again" line exists: the FIRST signal
      // carried the cancellation.
      const solicitLines = jsonLines(stderr).filter((l) => l.event === "resident_solicit");
      expect(solicitLines).toHaveLength(3);
      expect(solicitLines.map((l) => l.directiveAction)).toEqual(["proceed", "proceed", "proceed"]);
      expect(stderr).not.toContain("again — exiting immediately");
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      // W2-1 backstop: on a regression where the runner fails to kill the
      // hung fake-pi child, killing only the runner would orphan the
      // grandchild (its 600s sleep outlives the suite). Reap it by its
      // unique argv marker — this test's own session path, which resident.ts
      // puts on the pi child's command line as `--session <path>` and which
      // appears on no unrelated process's command line (the runner's own
      // argv carries the run ROOT, never this file). pkill's no-match exit
      // (1) is the normal path: the runner's stop already killed the child.
      Bun.spawnSync({
        cmd: ["pkill", "-KILL", "-f", sessionPath],
        stdout: "ignore",
        stderr: "ignore",
      });
      fs.rmSync(stateFile(dir), { force: true });
    }
  }, 60_000);

  test("retry authorization: a non-positive admitted ceiling refuses the run before any journal row", async () => {
    // The cap witness reader (`admittedCeilingBeside`) demands a positive
    // integer effectiveCeilingMicros on BOTH the declared and undeclared
    // paths — a ceiling of 0 is a refusal, not an authorization to spend.
    // Assert THAT refusal rather than a retry-loop behaviour the wiring never
    // reaches: the manifest declares no limitMicroUsd, so the witness supplies
    // the cap, and a zero cap is rejected at reconciliation.
    const leg = await runLeg("zero-ceiling", {
      runId: "resident-zero-ceiling-run",
      requestId: crypto.randomUUID(),
      replies: PROCEED_ONLY,
      witness: { effectiveCeilingMicros: 0 },
    });
    expect(leg.exitCode).toBe(2);
    expect(leg.stderr).toContain("carries no positive integer effectiveCeilingMicros");
    // The refusal lands before any phase: the journal file on disk is the
    // constructor's header flush only — ok:false, no phases, no gate events,
    // no resident block — the honest residue of a run that never started.
    expect(leg.journal).toEqual({
      version: "1.0.0",
      runId: "resident-zero-ceiling-run",
      ok: false,
      phases: [],
      gateEvents: [],
    });
    // toEqual ignores undefined-valued keys, so `resident: undefined` would
    // pass the shape above — pin the CLOSED key set (the telemetry-boundary
    // leg's idiom) to prove the block is absent, not merely undefined.
    expect(Object.keys(leg.journal).sort()).toEqual([
      "gateEvents", "ok", "phases", "runId", "version",
    ]);
  }, 60_000);
});

/** Gate-event sequence for the build phase, the two steered legs' spine. */
function j2GateSeq(j: E2eJournal): Array<Pick<GateRow, "type" | "attempt">> {
  return j.gateEvents
    .filter((e) => e.phase === "build")
    .map((e) => ({ type: e.type as GateRow["type"], attempt: e.attempt as GateRow["attempt"] }));
}
