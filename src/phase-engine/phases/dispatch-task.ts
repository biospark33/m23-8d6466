/**
 * dispatch_task phase body (Story DF1.6, Task T7).
 *
 * Spawns a pi team via team-lead-driver.ts through the QDS_TEAM_RUNNER=local
 * seam, adapts the NDJSON event stream (each surviving line through
 * parseTeamEventLine), classifies the run by the story's precedence rule,
 * runs the engine-side testCommand, and returns a schema-validated merged
 * step output.
 *
 * Flow: AC5 refusal → key presence → roster dual-gate → TeamManifest →
 * prompt events PRE-SPAWN → runTeamManifest (forced local, ceiling raised) →
 * event adaptation + stream counters → precedence classification →
 * engine-side testCommand → INV-1/2 path validation → buildMergedOutput.
 */
import { resolveArtifactBeneathRoot } from "../manifest.ts";
import { loadRoster } from "../roster/schema.ts";
import type { ResolvedRoster } from "../roster/schema.ts";
import { validateRoster } from "../roster/validate.ts";
import type { ValidateDeps } from "../roster/validate.ts";
import type { Tracer } from "../trace/tracer.ts";
import { rosterToTeamManifest } from "./roster-adapter.ts";
import {
  coerceTestsExecuted,
  runTestCommand,
  ZERO_TEST_RESULTS,
} from "./test-results.ts";
import {
  adaptTeamEvent,
  classifyRun,
  costAttributionFields,
  makeStreamHealth,
  isExitStatus,
} from "./team-event-adapter.ts";
import { buildMergedOutput } from "../../../cli-anything/src/merger.ts";
import { redactSecrets } from "../../../cli-anything/src/redact.ts";
import { runTeamManifest } from "../../../cli-anything/src/runner.ts";
import type { RunFacts } from "../../../cli-anything/src/runner.ts";
import type { MergedOutput, TeamManifest } from "../../../cli-anything/src/types.ts";
import type { PhaseBody, PhaseBodyContext } from "../phase.ts";
import type { PhaseSpec, PhaseSubTimings, ExitStatus } from "../types.ts";
import { closeSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

/** What the dispatch_task body returns: the step output plus the
 * stream-health counters and sub-timings Run.phase merges onto the record. */
export type DispatchTaskValue = MergedOutput & {
  malformedLines: number;
  droppedOversizeLines: number;
  dispatchSubTimings: Partial<PhaseSubTimings>;
};

/** Structured log sink default (F059): one JSON object per line on stderr,
 * matching phase.ts's RunOptions.log contract. Shared by dispatchTask's
 * closure and validateArtifacts's parameter default. */
const defaultLog = (o: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(o)}\n`);
};

/** One envelope builder for every dispatch-task log site (F059) — avoids
 * repeating {type,level,phase,event,message} at each call. Shared by
 * dispatchTask's closure and the standalone validateArtifacts. */
function emitLog(
  log: (line: Record<string, unknown>) => void,
  level: "warn" | "error",
  event: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  log({ type: "log", level, phase: "dispatch-task", event, message, ...extra });
}

/** Factory deps: the pipeline runner passes its tracer + requestId so prompt
 * events and adapted team events land in the run's trace store. Tests pass
 * offline roster probes (the real dual-gate spawns pi for the catalog probe). */
export interface DispatchTaskDeps {
  tracer?: Tracer;
  requestId?: string;
  rosterValidateDeps?: ValidateDeps;
  /**
   * Canonical run root for artifact reads (INV-1/2). The pipeline runner
   * passes its --run-root; falls back to QDS_RUN_ROOT then cwd. Without
   * this, a --run-root invocation would validate artifacts against the
   * process cwd — a different canonical root.
   */
  rootDir?: string;
  /** Structured log sink (F059): one JSON object per line on stderr, matching
   * `phase.ts`'s RunOptions.log contract. Defaults to stderr so callers that
   * don't inject one still get the same one-JSON-object-per-line stream the
   * engine promises to parsers. */
  log?: (line: Record<string, unknown>) => void;
  /**
   * INV-COST-10 (DF2.12): the money line's dedicated sink — never `log`. A
   * caller that injects a logger may lose trace lines; it must not be able to
   * lose money rows, so money rides its own dep. Production (pipeline-run)
   * injects `moneyLineTee()`, which tees the line onto the ext4 engine log
   * AND the live stderr; the default writes raw stderr for standalone
   * callers. See `defaultMoneyLine` for the full rationale.
   */
  emitMoneyLine?: (line: Record<string, unknown>) => void;
  /**
   * DF2.12 INV-COST-8 (PR #253 review): the RUN-scoped per-agent ordinal
   * counter. The pipeline runner's `makeBodyFactory` creates ONE map per run
   * and injects it into every dispatch_task body it builds, so an agent's
   * cost-event ordinal stays monotonic across PHASES — two dispatch_task
   * phases whose agentId domains overlap would otherwise each restart at 0,
   * breaking the story's per-`(runId, agentId)` monotonic contract. Optional:
   * a caller that omits it (standalone bodies, tests) gets a factory-local
   * counter spanning only that body's retries — the phase-local ceiling this
   * had before the injection seam existed.
   */
  invocationSeqByAgent?: Map<string, number>;
}

// NOTE: minimal runner injection seam for tests — default is real runTeamManifest.
// `_injectRunner(null)` restores it; there is no separate reset export.
let _runTeamManifest = runTeamManifest;
export function _injectRunner(fn: typeof runTeamManifest | null): void {
  _runTeamManifest = fn ?? runTeamManifest;
}

/**
 * INV-COST-10 (DF2.12): the money line's default writer. NOT the injectable
 * `log` seam — a caller that injects a logger may lose trace lines; it must
 * not be able to lose money rows, so money rides its OWN dep. Production
 * (pipeline-run) injects `moneyLineTee()` through `deps.emitMoneyLine`: a
 * plain `process.stderr.write` here would bypass pipeline-run's fd-2 tee (the
 * tee is caller-level, not an OS-level dup), and under the in-box systemd unit
 * fd 2 is journald — the line would never reach the harvested engine log and
 * every run would read zero token rows. The default keeps standalone callers
 * (and tests) on the same one-JSON-per-line stderr stream the engine promises.
 * Durability is asserted, not inherited: the tee capture is pinned by
 * `tests/phase-engine/pipeline-run-money-line.test.ts` (real subprocess, real
 * `--engine-log` file) and end-to-end by the TIER-2 live round.
 */
const defaultMoneyLine = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

/** Build a refusal-shaped value. Never spawns anything; counters are
 * truthfully zero (nothing was parsed) and sub-timings omitted (never ran). */
function refuse(message: string, redact: (s: string) => string): DispatchTaskValue {
  const merged = buildMergedOutput({
    exitStatus: "logic",
    partial: false,
    result: {},
    agentOutputs: {},
    changedFiles: [],
    comsLog: [],
    durationMs: 0,
    waivers: [],
    error: { reason: "logic", message },
    redact,
    testResults: { passed: 0, failed: 0 },
    testsExecuted: false,
    summary: message,
    mulchPrimed: false,
    mulchPrimeError: null,
    artifacts: [],
    partialOutput: null,
  });
  return {
    ...merged,
    malformedLines: 0,
    droppedOversizeLines: 0,
    dispatchSubTimings: {},
  };
}

/**
 * The exit-signal evidence dispatch reconciles against — a projection of the
 * runner's own RunFacts, never a restatement of its killOrigin union (the
 * union widens on the runner's side and every copy of it drifts).
 */
export type DispatchRunFacts = Pick<RunFacts, "exitCode" | "termSignal" | "killOrigin">;

/**
 * F061: the three-stage exit reconciliation, pure. The phase's own
 * classification is the starting point; the runner's verdict overrides it in
 * exactly two cases:
 *
 *   D2 — no exit-signal evidence at all (no code, no signal, no kill origin)
 *        and the runner reported something other than success/lead_failure:
 *        a spawn/stream failure the phase would otherwise call lead_failure.
 *   D3 — the phase says success but the runner does not. Dispatch must never
 *        force success over a non-success runner verdict.
 *
 * runResultStatus must already be validated (isExitStatus) by the caller —
 * sanitising untrusted runner output is a separate concern with its own warn.
 */
export function reconcileExitStatus(input: {
  classified: ExitStatus;
  runResultStatus: ExitStatus;
  runFacts: DispatchRunFacts;
}): ExitStatus {
  const { classified, runResultStatus, runFacts } = input;
  let finalExitStatus = classified;
  // D2: Spawn/stream failure → runner settles transient, but dispatch classifies lead_failure
  // when there's no exit signal evidence. Prefer runResult.exitStatus when it exists.
  if (runFacts.exitCode === null && runFacts.termSignal === null && runFacts.killOrigin === null &&
      runResultStatus !== "success" && runResultStatus !== "lead_failure") {
    finalExitStatus = runResultStatus;
  }
  // D3: When classification would return success but runResult.exitStatus is non-success,
  // take runResult.exitStatus and keep its error + partial.
  if (finalExitStatus === "success" && runResultStatus !== "success") {
    finalExitStatus = runResultStatus;
  }
  return finalExitStatus;
}

/**
 * F061: the output merge, given a settled exit status. Uniformity invariants
 * (merger.ts) keyed on OUR classification, not the harness's: success requires
 * error=null/partial=false; non-success requires a populated error;
 * lead_failure forces empty agentOutputs and changedFiles.
 */
export function buildDispatchOutput(input: {
  finalExitStatus: ExitStatus;
  runResult: MergedOutput;
  runFacts: DispatchRunFacts;
  health: { malformedLines: number; droppedOversizeLines: number };
  changedFiles: string[];
  artifacts: MergedOutput["artifacts"];
  durationMs: number;
  testResult: { testResults: { passed: number; failed: number }; testsExecuted: boolean };
  redact: (s: string) => string;
}): DispatchTaskValue {
  const {
    finalExitStatus,
    runResult,
    runFacts,
    health,
    changedFiles,
    artifacts,
    durationMs,
    testResult,
    redact,
  } = input;

  const error =
    finalExitStatus === "success"
      ? null
      : (runResult.error ?? {
          reason: finalExitStatus,
          message: `run classified ${finalExitStatus} (exit=${runFacts.exitCode ?? "null"} signal=${runFacts.termSignal ?? "none"} malformed=${health.malformedLines} dropped=${health.droppedOversizeLines})`,
        });
  const partialOutput =
    runResult.partialOutput ??
    (finalExitStatus === "success"
      ? null
      : `run ended ${finalExitStatus}: exit=${runFacts.exitCode ?? "null"} signal=${runFacts.termSignal ?? "none"}`);

  const merged = buildMergedOutput({
    exitStatus: finalExitStatus,
    partial: finalExitStatus === "success" ? false : runResult.partial,
    result: runResult.result,
    agentOutputs: finalExitStatus === "lead_failure" ? {} : runResult.agentOutputs,
    changedFiles: finalExitStatus === "lead_failure" ? [] : changedFiles,
    comsLog: runResult.comsLog,
    durationMs,
    waivers: runResult.waivers,
    error,
    redact,
    testResults: testResult.testResults,
    testsExecuted: testResult.testsExecuted,
    summary: runResult.summary,
    // Priming degradation (p1-6:87): no priming integration runs in S1 —
    // an empty/unreachable bank is not an error; mulchPrimed reports false.
    mulchPrimed: runResult.mulchPrimed,
    mulchPrimeError: runResult.mulchPrimeError,
    artifacts,
    partialOutput,
  });

  // Observability Contract: counters and v5 sub-timings ride on the phase
  // value; Run.phase merges them onto the phase record. durationMs is
  // wall-clock from driver spawn to exit and excludes priming.
  return {
    ...merged,
    malformedLines: health.malformedLines,
    droppedOversizeLines: health.droppedOversizeLines,
    dispatchSubTimings: {
      team_execution_ms: durationMs,
    },
  };
}

/**
 * dispatch_task phase body factory. Registered in scripts/pipeline-run.ts
 * makeBodyFactory for kind === "dispatch_task".
 */
export function dispatchTask(
  spec: PhaseSpec,
  deps: DispatchTaskDeps = {},
): PhaseBody<DispatchTaskValue> {
  // DF2.12 INV-COST-8: invocationSeq is the ordinal of that agent's cost
  // events within the run, incremented AT the emission point — DF2.7 emits
  // exactly one cost event per pi subprocess invocation, so the cost-event
  // ordinal and the invocation ordinal are the same number without any
  // spawn-site plumbing. Scope: the INJECTED run-scoped counter when the
  // pipeline runner supplies one (makeBodyFactory builds one map per run, so
  // the ordinal is monotonic across every dispatch_task phase of the run —
  // PR #253 review); the factory-local fallback spans only phase-body retries
  // of THIS body. ponytail: engine-memory counter, safe because DF1.10 ships
  // Restart=no and a reboot ENDS the run (DF1.11 AC4a) — there is no resumed
  // run for a restarted counter to collide with. If a resumable engine ever
  // lands, seed this from the durable engine log's last ordinal (story
  // Technical Notes).
  const invocationSeqByAgent = deps.invocationSeqByAgent ?? new Map<string, number>();
  return async (ctx: PhaseBodyContext): Promise<DispatchTaskValue> => {
    const { signal, phaseId, ctx: runCtx } = ctx;
    const { runId, pipelineId } = runCtx;
    const requestId = deps.requestId ?? runCtx.requestId;
    const log = deps.log ?? defaultLog;
    const emitMoneyLine = deps.emitMoneyLine ?? defaultMoneyLine;
    const emit = (
      level: "warn" | "error",
      event: string,
      message: string,
      extra?: Record<string, unknown>,
    ): void => emitLog(log, level, event, message, extra);

    // DF2.12 review: the money seam is a SIDECAR, in steering's posture — a
    // throwing sink must never degrade the phase body. The production sink
    // (moneyLineTee → writeAll) never throws, but the DEFAULT writer is raw
    // `process.stderr.write`, which can (EPIPE on a closed pipe) for a
    // standalone caller, and a throw inside `onTeamEvent` aborts the REST of
    // that callback — the runner catches it, but this body's own state after
    // the emission (the coms_init_error capture, later stream counters) is
    // what would be lost. Never silent: the first failure emits ONE deps.log
    // error diagnostic (redacted); every later cost event still ATTEMPTS
    // emission — the latch deduplicates the diagnostic, not the sink.
    let moneySinkFaultLogged = false;
    const emitMoney = (line: Record<string, unknown>): void => {
      try {
        emitMoneyLine(line);
      } catch (err) {
        if (!moneySinkFaultLogged) {
          moneySinkFaultLogged = true;
          emit(
            "error",
            "money_line_sink_failed",
            "[dispatch-task] cost-attribution sink failed; the money row did not reach its sink",
            { requestId, phaseId, error: redact(err instanceof Error ? err.message : String(err)) },
          );
        }
      }
    };

    // INV-4 boundary redaction: real provider key values, name-only logging.
    const secretEnv: Record<string, string> = {};
    for (const key of ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) {
      const v = process.env[key];
      // Empty or whitespace-only values don't count as present — they'd fail at spawn
      if (v !== undefined && v.trim().length > 0) secretEnv[key] = v;
    }
    // The redaction map is the WHOLE parent env, not the two provider keys:
    // this closure scrubs traced prompts, team-event payloads and every
    // refusal message — the same records `phase.ts` scrubs against all of
    // process.env and `command-gate.ts` against parentEnvStrings(). Two
    // definitions of "secret" over one body of text is the bug (F058);
    // `redactSecrets` already filters by SECRET_KEY_RE, so widening the map
    // costs nothing and cannot mangle ordinary env values. `secretEnv` stays
    // the PRESENCE gate below, and nothing else.
    const redactEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") redactEnv[k] = v;
    }
    const redact = (s: string): string => redactSecrets(s, redactEnv);

    // AC5: QDS_TEAM_RUNNER refusal FIRST — unset and every non-"local" value
    // alike refuse before any spawn. The seam's own code default is "warren"
    // (demoted-optional, D9), so treating unset as local would silently hand
    // the run to the wrong branch. The child env is set to "local" at the
    // spawn seam (forceLocalRunner) — never written into our own env.
    const runnerValue = process.env.QDS_TEAM_RUNNER;
    if (runnerValue !== "local") {
      return refuse(
        `QDS_TEAM_RUNNER must be "local" (got ${runnerValue === undefined ? "unset" : `"${redact(runnerValue)}"`})`,
        redact,
      );
    }

    // Infra Prerequisite: a provider key must exist — absent refuses before
    // spawn. Logged/persisted by key NAME only, never the value.
    if (Object.keys(secretEnv).length === 0) {
      return refuse(
        "At least one of ANTHROPIC_API_KEY or OPENROUTER_API_KEY must be set",
        redact,
      );
    }

    // INV-5: schema guarantees these on dispatch_task phases; the direct-
    // construction path (tests, future callers) still fails closed here
    // rather than spawning with undefined inputs.
    const rosterPath = spec.roster;
    const taskBrief = spec.task;
    if (rosterPath === undefined || taskBrief === undefined) {
      // D4: log refusal reason for observability
      emit(
        "warn",
        "refused_missing_roster_or_task",
        `[dispatch-task] refused: phase '${spec.name}' — dispatch_task requires roster and task`,
      );
      return refuse(
        `phase '${spec.name}': dispatch_task requires roster and task`,
        redact,
      );
    }

    // D6: cardinality checks BEFORE dual-gate (pi spawn ~180s) — local checks first
    // D9/F056: one run root for the whole dispatch — the roster path below and
    // the manifest dir further down anchor at the same value, not process.cwd().
    // NOTE: this is NOT `runMarkerRoot()`: the runner's --run-root wins here and
    // the fallback is the cwd, because a dispatch reads artifacts from the
    // workspace it was invoked in, not from the marker root.
    //
    // The blank-value rule therefore differs from `runMarkerRoot()`'s too, and
    // deliberately: there, a blank `QDS_RUN_ROOT` is treated as UNSET and falls
    // back to the `/run` literal — a real path, safe to use. Here the fallback
    // is the process cwd, which is NOT a safe silent substitute for a root the
    // operator meant to name, so a blank value is refused instead of falling
    // through. Both directions are fail-closed; harmonizing them onto
    // `runMarkerRoot()` would swap this loud refusal for a silent relocation to
    // `/run` and change the whole precedence chain, which is the wrong trade.
    const runRoot = deps.rootDir ?? process.env.QDS_RUN_ROOT ?? process.cwd();
    // S2/D14: empty or whitespace-only is not a root; refuse before the
    // expensive loadRoster + dual-gate (~180s) rather than resolving to "".
    if (runRoot.trim() === "") {
      return refuse("QDS_RUN_ROOT is empty (use unset or a non-empty path)", redact);
    }
    let roster: ResolvedRoster;
    try {
      // repoRoot: runRoot, not just cwd. loadRoster's containment root falls
      // back to defaultRepoRoot() — three levels above schema.ts, which is the
      // REPO on the host but /opt/qds-factory IN THE IMAGE (the engine ships
      // as unbundled source there), so every run-root roster was refused
      // in-box with "roster path is outside the repo root" — measured live,
      // first in-box dispatch_task round (DF2.12 G10, run qds-20260912-de25bf
      // in the evidence). The manifest read and the witness read already
      // anchor at this same run root (deriveInBoxArgv's AC2b), and the
      // host-side runner anchors --run-root at the checkout too, so the
      // roster containment follows the one anchor everything else shares.
      roster = loadRoster(rosterPath, { cwd: runRoot, repoRoot: runRoot });
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err), redact);
    }
    const roles = roster.roles;
    if (roles.length < 2) {
      return refuse("roster must declare a lead role and at least one worker", redact);
    }

    // Resolve + dual-gate the roster (DF1.5). An unverified gate refuses the
    // dispatch rather than spawning.
    // The run's requestId, not a fresh UUID: every RoleRecord the gate emits is
    // correlatable back to this run (F051).
    const gate = await validateRoster(roster, { ...deps.rosterValidateDeps, requestId });
    if (gate.exitCode !== 0) {
      const first = gate.problems[0];
      return refuse(
        `roster gate failed (exit ${gate.exitCode})${first !== undefined ? `: ${first}` : ""}`,
        redact,
      );
    }

    const leadRole = roles[0]!;
    const workerRoles = roles.slice(1);
    // DF2.12 INV-COST-8: role comes from the roster entry the dispatcher
    // spawned the agentId with — roles[0] is the lead, the rest are workers
    // (DF1.5 precedence). NEVER inferred from the model slug, the agent name
    // or emission order. CostRole's closed set lives host-side (the
    // `CostRole` export in cost-ledger.ts); the engine writes only the two
    // values a roster can produce.
    const agentRoles = new Map<string, "lead" | "worker">([
      [leadRole.name, "lead"],
      ...workerRoles.map((r) => [r.name, "worker"] as const),
    ]);
    const prompts: Record<string, string> = {};
    for (const role of roles) {
      prompts[role.name] = taskBrief;
    }

    // A schema-invalid derived manifest (e.g. >3 workers passing the roster
    // gate) refuses the phase with a logic step output — the adapter's
    // ZodError never escapes the body, so the output stays schema-validated
    // (roster-adapter's caller contract) with a redacted reason.
    let manifest: TeamManifest;
    try {
      manifest = rosterToTeamManifest(roster, {
        name: `${pipelineId}-${phaseId}`,
        // ponytail: the local driver branch ignores `project` (TeamManifestSchema
        // still requires it); pipelineId keeps the trace line honest. Revisit
        // when a second driver lands and actually reads `project`.
        project: pipelineId,
        leadRoleName: leadRole.name,
        workerRoleNames: workerRoles.map((r) => r.name),
        prompts,
      });
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err), redact);
    }

    // DD-8 prompt persistence (NET-NEW): every compiled prompt is written to
    // the trace BEFORE the spawn that consumes it — a run killed mid-phase
    // still shows what it was asked to do.
    const tracer = deps.tracer;
    for (const role of roles) {
      tracer?.trace({
        requestId,
        phaseId,
        type: "prompt",
        name: role.name,
        payloadJson: JSON.stringify({
          agentId: role.name,
          prompt: redact(prompts[role.name] ?? taskBrief),
          model: `${role.provider}/${role.model}`,
        }),
      });
    }

    // runTeamManifest takes a manifest FILE path.
    const manifestDir = join(runRoot, ".qds-manifests");
    // D7: wrap mkdirSync to refuse logic on EACCES/ENOTDIR/disk-full
    try {
      mkdirSync(manifestDir, { recursive: true });
    } catch (err) {
      return refuse(
        `failed to create manifest directory ${manifestDir}: ${err instanceof Error ? err.message : String(err)}`,
        redact,
      );
    }
    const manifestFile = join(
      manifestDir,
      `manifest-${runId}-${phaseId}-${randomBytes(8).toString("hex")}.json`,
    );
    // AC2 stream health: malformed (parser rejections) and droppedOversize
    // (cap drops that never reach the parser) are distinct counters.
    const streamHealth = makeStreamHealth();
    // Precedence inputs collected from the run (story Technical Notes):
    // how the process died > envelope presence > exit code.
    // First-wins for merged: later duplicates are ignored (stream-health marker).
    let mergedResult: Record<string, unknown> | null = null;
    let mergedSeen = false;
    let comsInitError: string | null = null;
    let runFacts: DispatchRunFacts = { exitCode: null, termSignal: null, killOrigin: null };

    try {
      writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
      const runResult = await _runTeamManifest(manifestFile, {
        forceLocalRunner: true,
        effectiveCeilingMicros: runCtx.effectiveCeilingMicros,
        // Phase-overflow cancellation kills the team tree at the abort, not
        // at the team's own wall-clock cap (resource-leak guard).
        abortSignal: signal,
        onTeamEvent: (event, meta) => {
          if (meta.droppedOversize) {
            streamHealth.dropped();
            return;
          }
          if (event === null) {
            streamHealth.malformed("");
            return;
          }
          const adapted = adaptTeamEvent(
            event,
            { requestId, phaseId, redact },
          );
          switch (adapted.type) {
            case "coms":
            case "cost":
            case "coms_init_error": {
              tracer?.trace({
                requestId,
                phaseId,
                type: adapted.type,
                name: adapted.name,
                payloadJson:
                  "payloadJson" in adapted ? adapted.payloadJson : JSON.stringify(adapted),
              });
              // DF2.12 review round: a cost event whose money figure is
              // malformed (non-finite or beyond safe-integer µ$) is adapted as
              // a `cost_skipped_*` coms note — the TRACE row must not carry the
              // bad figure, but the SPEND EVIDENCE must not die with it. The
              // raw event is still a cost event, so its attribution line emits
              // with NO usable money (NaN): the bridge coerces that to NaN at
              // the seam and the ledger persists the row unpriced (AC5).
              // Skipping the emission entirely would drop the evidence on the
              // floor — a run whose only cost events were malformed would read
              // `no-token-spend` downstream, the false negative AC4's negative
              // control rules out.
              const skippedCost =
                adapted.type === "coms" &&
                (adapted.name === "cost_skipped_nonfinite" || adapted.name === "cost_skipped_unsafe");
              if (adapted.type === "cost" || skippedCost) {
                // DF2.12: one attribution line per cost event, stamped where
                // the attribution is known (in the box) onto the fd-2 engine
                // log harvest already pulls — never on the tmpfs trace row.
                // `timestamp` is the WIRE event's emission time (a digest
                // input), never this log's clock. INV-COST-8: a line whose
                // role or invocationSeq cannot be supplied is refused with a
                // structured error naming the field and never emitted — an
                // unattributable cost is not persisted under a guessed key.
                const costMicroUsd = adapted.type === "cost" ? adapted.costMicros : Number.NaN;
                const fields = costAttributionFields(event);
                const role = fields === null ? undefined : agentRoles.get(fields.agentId);
                if (fields === null || role === undefined) {
                  emit(
                    "error",
                    "cost_attribution_refused",
                    "[dispatch-task] cost attribution refused: missing role — no roster entry spawned this agentId (INV-COST-8)",
                    { requestId, phaseId, agentId: fields?.agentId ?? "unknown" },
                  );
                  // The refusal also rides the DEDICATED money seam: a
                  // deps.log/defaultLog line is journald-only under the in-box
                  // unit, and a run whose cost events were ALL refused would
                  // read as `no-token-spend` downstream — a false negative on
                  // exactly what AC4's negative control rules out. The marker
                  // is evidence, never money: the bridge counts it in
                  // rowsRefused and writes no row (INV-COST-8 holds — nothing
                  // is attributed, and nothing is silently dropped).
                  emitMoney({
                    type: "cost_attribution_refused",
                    requestId,
                    runId,
                    phaseId,
                    agentId: fields?.agentId ?? "unknown",
                    reason: "missing role — no roster entry spawned this agentId (INV-COST-8)",
                  });
                } else {
                  const invocationSeq = invocationSeqByAgent.get(fields.agentId) ?? 0;
                  invocationSeqByAgent.set(fields.agentId, invocationSeq + 1);
                  emitMoney({
                    type: "cost_attribution",
                    requestId,
                    runId,
                    phaseId,
                    agentId: fields.agentId,
                    role,
                    invocationSeq,
                    model: fields.model,
                    // µ$, already converted once at the adapter's sanctioned
                    // DD-9 boundary — the engine never carries the wire's
                    // float USD past it. The host reader converts µ$ → USD
                    // once at the ledger seam (round trip exact, pinned by
                    // the ledger's µ$ property test).
                    costMicroUsd,
                    inputTokens: fields.inputTokens,
                    outputTokens: fields.outputTokens,
                    cacheReadTokens: fields.cacheReadTokens,
                    cacheWriteTokens: fields.cacheWriteTokens,
                    turnCount: fields.turnCount,
                    unpricedTurns: fields.unpricedTurns,
                    timestamp: fields.timestamp,
                  });
                }
              }
              break;
            }
            case "envelope":
              tracer?.trace({
                requestId,
                phaseId,
                type: "worker_output",
                name: adapted.label,
                payloadJson: JSON.stringify(adapted),
              });
              break;
            case "merged":
              if (!mergedSeen) {
                mergedResult = adapted.result;
                mergedSeen = true;
              } else {
                emit(
                  "warn",
                  "duplicate_merged_event_ignored",
                  `[dispatch-task] duplicate merged event ignored (requestId=${requestId}, phaseId=${phaseId})`,
                  { requestId, phaseId },
                );
              }
              // Continue processing events after merged for stream health (malformed/dropped counters)
              break;
          }
          // Unify to read from adapted value for coms_init_error (type-safe, matches adapter contract)
          if (adapted.type === "coms_init_error") comsInitError = adapted.reason;
        },
        onRunFacts: (facts) => {
          runFacts = {
            exitCode: facts.exitCode,
            termSignal: facts.termSignal,
            killOrigin: facts.killOrigin,
          };
          comsInitError = facts.comsInitError ?? comsInitError;
        },
      });

      // Precedence classification (AC3) — the phase owns it; the harness's
      // own exitStatus is not the classifier here.
      // D1: pass killOrigin through per SHARED CONTRACT — map known origins:
      // watchdog/budget/wallClock → overflow; requestedShutdown → logic;
      // foreign strings → unknown → transient (fail-safe).
      // NOTE: userCancel is in the shared contract but runner doesn't emit it yet.
      let normalizedKillOrigin: "watchdog" | "budget" | "wallClock" | "requestedShutdown" | "unknown" | null = runFacts.killOrigin;
      if (normalizedKillOrigin !== null && normalizedKillOrigin !== "watchdog" &&
          normalizedKillOrigin !== "budget" && normalizedKillOrigin !== "wallClock" &&
          normalizedKillOrigin !== "requestedShutdown") {
        // Foreign string → treat as unknown (fail-safe)
        normalizedKillOrigin = "unknown";
      }

      const exitStatus = classifyRun({
        exitCode: runFacts.exitCode,
        termSignal: runFacts.termSignal,
        mergedResult,
        comsInitError: comsInitError !== null,
        killOrigin: normalizedKillOrigin,
      });

      // AC6: the PHASE runs testCommand engine-side — in-box, in this
      // process, outside the team it just supervised. Never derived from the
      // driver stream, worker_output, or the merged envelope.
      // D5: if signal.aborted before the test step, skip the spawn.
      let testResult = ZERO_TEST_RESULTS;
      if (spec.testCommand !== undefined && spec.testCommand.length > 0) {
        if (signal.aborted) {
          // D5: guard — don't spawn when already aborted
          const abortReason = signal.reason instanceof Error ? signal.reason.message : "aborted";
          emit(
            "warn",
            "test_command_skipped_aborted",
            `[dispatch-task] testCommand skipped (phase aborted: ${abortReason})`,
          );
          testResult = { testsExecuted: false, testResults: { passed: 0, failed: 0 }, reason: `aborted: ${abortReason}` };
        } else {
          testResult = coerceTestsExecuted(
            await runTestCommand(spec.testCommand, { cwd: runRoot, signal }),
          );
          // D4: log testCommand failure reason for observability
          if (testResult.reason) {
            emit("warn", "test_command_failed", `[dispatch-task] testCommand failed: ${testResult.reason}`);
            tracer?.trace({
              requestId,
              phaseId,
              type: "test_result",
              name: "testCommand_failure",
              payloadJson: JSON.stringify({ reason: testResult.reason }),
            });
          }
        }
      }

      // INV-1/2: one canonical run root for validation AND reads. changedFiles
      // get the two-stage decode-then-check; artifact paths additionally prove
      // they resolve beneath the root through DF1.1's walk before riding the
      // step output.
      const changedFiles = validateChangedFiles(runResult.changedFiles);
      const artifacts = validateArtifacts(runResult.artifacts ?? [], runRoot, log);

      // Fail-safe: reject non-finite or negative values from malformed merged events
      let durationMs = runResult.durationMs;
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        emit("warn", "invalid_duration_ms", `[dispatch-task] invalid durationMs (${runResult.durationMs}), using 0`);
        durationMs = 0;
      }

      // Uniformity invariants (merger.ts) keyed on OUR classification, not
      // the harness's: success requires error=null/partial=false; non-success
      // requires a populated error; lead_failure forces empty agentOutputs
      // and changedFiles.
      // D3: dispatch must not force success over a non-success runner verdict.
      // D2: when runner settles lead_failure with no exit signal evidence, prefer runResult.exitStatus.
      const health = streamHealth.snapshot();
      const runResultStatus = runResult.exitStatus ?? "lead_failure";

      // S1: Validate runResultStatus before use — garbage from buggy/compromised runner
      // must not flow into finalExitStatus → envelope exitStatus + partialOutput.message
      const validatedRunResultStatus: ExitStatus = isExitStatus(runResultStatus)
        ? runResultStatus
        : (() => {
            const message = `[dispatch-task] invalid runResult.exitStatus (using lead_failure): ${redact(String(runResultStatus))}`;
            emit("warn", "invalid_exit_status", message);
            tracer?.trace({
              requestId,
              phaseId,
              type: "log",
              name: "invalid_exit_status",
              payloadJson: JSON.stringify({ message }),
            });
            return "lead_failure" as const;
          })();
      const finalExitStatus = reconcileExitStatus({
        classified: exitStatus,
        runResultStatus: validatedRunResultStatus,
        runFacts,
      });

      return buildDispatchOutput({
        finalExitStatus,
        runResult,
        runFacts,
        health,
        changedFiles,
        artifacts,
        durationMs,
        testResult,
        redact,
      });
    } finally {
      try {
        rmSync(manifestFile, { force: true });
      } catch (err) {
        // cleanup is best-effort; never masks the typed result
        // NOTE: warn but don't throw — an orphaned manifest file is benign
        // (next run's cleanup or the OS reaps it); throwing here would mask
        // the typed result this `finally` guards.
        emit("error", "manifest_cleanup_failed", `manifest cleanup failed: ${manifestFile}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
}

/**
 * INV-2 two-stage decode-then-check for changedFiles (claims — not read by
 * this phase). Pre-decode rejects percent-encoded traversal and
 * double-encoding evidence; post-decode rejects literal "..", absolute
 * paths, and Unicode-normalized traversals after URL-decode + NFC.
 */
export function validateChangedFiles(paths: string[]): string[] {
  const valid: string[] = [];
  for (const raw of paths) {
    // Empty or whitespace-only paths are rejected (null-byte, whitespace-only checks)
    if (raw.trim().length === 0) {
      continue;
    }
    // Null byte and other C0 control chars (except tab, newline, carriage return) are rejected
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security check
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)) {
      continue;
    }
    // Windows UNC/backslash paths are rejected (any path containing a backslash)
    if (raw.includes("\\")) {
      continue;
    }
    // Pre-decode stage.
    if (
      /%2e%2e/i.test(raw) ||
      /%252e/i.test(raw) ||
      /%25\d{2}/i.test(raw) // percent-encoded percent sign = double-encoding evidence
    ) {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw).normalize("NFC");
    } catch {
      // D8: on URIError, treat the raw string as unencoded and continue validation
      decoded = raw;
    }
    // D11: after decode, re-run the control-character rejection on the decoded value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security check
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) {
      continue;
    }
    const segments = decoded.split(/[/\\]/);
    // Reject UNC paths (\\server\share) as defense-in-depth (POSIX realpath+prefix gate blocks later)
    if (segments.includes("..") || decoded.startsWith("/") || decoded.startsWith("\\\\") || /^[a-zA-Z]:/.test(decoded)) {
      continue;
    }
    valid.push(raw);
  }
  return valid;
}

/**
 * INV-1/2 for artifacts: same two-stage check, then the path must resolve
 * beneath the pinned run root through DF1.1's resolveArtifactBeneathRoot walk
 * (realpath + prefix re-assert + O_NOFOLLOW open + fd-path verification; the
 * body is never read — F060). A path whose walk throws is
 * dropped — including the intermediate-symlink case O_NOFOLLOW alone would
 * miss. Names are preserved.
 *
 * D10: Artifacts larger than MANIFEST_MAX_BYTES are silently dropped — logged
 * via the structured `log` sink for observability (F059).
 * D15: Artifact `name` field must be validated (non-empty, no control chars/newlines, ≤200 chars).
 */
export function validateArtifacts(
  artifacts: Array<{ name: string; path: string }>,
  runRoot: string,
  log: (line: Record<string, unknown>) => void = defaultLog,
): Array<{ name: string; path: string }> {
  const emit = (level: "warn" | "error", event: string, message: string): void =>
    emitLog(log, level, event, message);
  const valid: Array<{ name: string; path: string }> = [];
  // Fail-closed: null/non-object entries are dropped before the claimOk map —
  // `a.path` on a null entry would throw before the loop's own guard runs.
  const objectArtifacts = artifacts.filter(
    (a): a is { name: string; path: string } => a !== null && typeof a === "object",
  );
  const claimOk = new Set(validateChangedFiles(objectArtifacts.map((a) => a.path)));
  for (const artifact of artifacts) {
    // Fail-closed: filter out null/undefined or non-object entries from malformed merged events
    if (artifact === null || typeof artifact !== "object") {
      emit(
        "warn",
        "artifact_dropped_malformed",
        "[dispatch-task] artifact dropped: malformed entry (null or non-object)",
      );
      continue;
    }
    // D15: validate artifact name (with type guard since we filtered objects above)
    if (!artifact || typeof artifact.name !== "string" || artifact.name.trim().length === 0) {
      emit(
        "warn",
        "artifact_dropped_invalid_name",
        "[dispatch-task] artifact dropped: invalid name (empty or non-string)",
      );
      continue;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security check
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(artifact.name) || artifact.name.includes("\n")) {
      // S8: regex excludes \x0a/\x0d; explicit newline check yields a clearer error message
      emit(
        "warn",
        "artifact_dropped_control_chars",
        "[dispatch-task] artifact dropped: name contains control chars or newline",
      );
      continue;
    }
    if (artifact.name.length > 200) {
      emit("warn", "artifact_dropped_name_too_long", "[dispatch-task] artifact dropped: name exceeds 200 chars");
      continue;
    }

    if (!claimOk.has(artifact.path)) continue;
    try {
      // The WALK is the validation — realpath, beneath-root re-assert, the
      // O_NOFOLLOW open, the fd-path verification, fstat and the size ceiling
      // all complete before any byte is read, so the body is never touched
      // (F060: this used to read up to MANIFEST_MAX_BYTES per artifact and
      // discard every byte). Through the one canonical root, via the DF1.1
      // resolver: relative paths resolve against that root (INV-1: one
      // canonical root, never cwd). INV-5 — if the walk cannot be performed,
      // this throws and the artifact is refused, never silently accepted.
      // Defense-in-depth: validateChangedFiles already rejects absolute paths,
      // but we keep this branch for explicitness and in case that check evolves.
      const { fd } = resolveArtifactBeneathRoot(
        isAbsolute(artifact.path) ? artifact.path : join(runRoot, artifact.path),
        runRoot,
      );
      // The resolver hands the caller an OPEN descriptor; validation wants
      // nothing from it but the fact that it opened.
      closeSync(fd);
      valid.push(artifact);
    } catch {
      // D10: log dropped artifacts for observability
      emit(
        "warn",
        "artifact_dropped_validation_failed",
        `[dispatch-task] artifact dropped: ${artifact.name} (${artifact.path}) — validation or read failed`,
      );
    }
  }
  return valid;
}
