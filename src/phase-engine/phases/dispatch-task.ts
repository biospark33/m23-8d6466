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
import { readArtifactBeneathRoot } from "../manifest.ts";
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
  makeStreamHealth,
} from "./team-event-adapter.ts";
import { buildMergedOutput } from "../../../cli-anything/src/merger.ts";
import { redactSecrets } from "../../../cli-anything/src/redact.ts";
import { runTeamManifest } from "../../../cli-anything/src/runner.ts";
import type { MergedOutput } from "../../../cli-anything/src/types.ts";
import type { PhaseBody, PhaseBodyContext } from "../phase.ts";
import type { PhaseSpec, PhaseSubTimings } from "../types.ts";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

/** What the dispatch_task body returns: the step output plus the
 * stream-health counters and sub-timings Run.phase merges onto the record. */
export type DispatchTaskValue = MergedOutput & {
  malformedLines: number;
  droppedOversizeLines: number;
  dispatchSubTimings: Partial<PhaseSubTimings>;
};

/** Factory deps: the pipeline runner passes its tracer + requestId so prompt
 * events and adapted team events land in the run's trace store. Tests pass
 * offline roster probes (the real dual-gate spawns pi for the catalog probe). */
export interface DispatchTaskDeps {
  tracer?: Tracer;
  requestId?: string;
  rosterValidateDeps?: ValidateDeps;
}

// ponytail: minimal runner injection seam for tests — default is real runTeamManifest
let _runTeamManifest = runTeamManifest;
export function _injectRunner(fn: typeof runTeamManifest): void {
  _runTeamManifest = fn;
}

/** Build a refusal-shaped value. Never spawns anything; counters are
 * truthfully zero (nothing was parsed) and sub-timings all 0 (never ran). */
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
    dispatchSubTimings: {
      mulch_prime_ms: 0,
      box_setup_ms: 0,
      team_execution_ms: 0,
      gate_validation_ms: 0,
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
  return async (ctx: PhaseBodyContext): Promise<DispatchTaskValue> => {
    const { signal, phaseId, ctx: runCtx } = ctx;
    const { runId, pipelineId } = runCtx;
    const requestId = deps.requestId ?? runCtx.requestId;

    // INV-4 boundary redaction: real provider key values, name-only logging.
    const secretEnv: Record<string, string> = {};
    for (const key of ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) {
      const v = process.env[key];
      if (v !== undefined) secretEnv[key] = v;
    }
    const redact = (s: string): string => redactSecrets(s, secretEnv);

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
      return refuse(
        `phase '${spec.name}': dispatch_task requires roster and task`,
        redact,
      );
    }

    // Resolve + dual-gate the roster (DF1.5). An unverified gate refuses the
    // dispatch rather than spawning.
    let roster: ResolvedRoster;
    try {
      roster = loadRoster(rosterPath);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err), redact);
    }
    const gate = await validateRoster(roster, deps.rosterValidateDeps);
    if (gate.exitCode !== 0) {
      const first = gate.problems[0];
      return refuse(
        `roster gate failed (exit ${gate.exitCode})${first !== undefined ? `: ${first}` : ""}`,
        redact,
      );
    }

    const roles = roster.roles;
    if (roles.length === 0 || roles.length < 2) {
      return refuse("roster must declare a lead role and at least one worker", redact);
    }
    const leadRole = roles[0]!;
    const workerRoles = roles.slice(1);
    const prompts: Record<string, string> = {};
    for (const role of roles) {
      prompts[role.name] = taskBrief;
    }

    const manifest = rosterToTeamManifest(roster, {
      name: `${pipelineId}-${phaseId}`,
      // ponytail: the local driver branch ignores `project` (TeamManifestSchema
      // still requires it); pipelineId keeps the trace line honest.
      project: pipelineId,
      leadRoleName: leadRole.name,
      workerRoleNames: workerRoles.map((r) => r.name),
      prompts,
    });

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
    const runRoot = process.env.QDS_RUN_ROOT ?? process.cwd();
    const manifestDir = join(runRoot, ".qds-manifests");
    mkdirSync(manifestDir, { recursive: true });
    const manifestFile = join(
      manifestDir,
      `manifest-${runId}-${phaseId}-${randomBytes(8).toString("hex")}.json`,
    );
    writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });

    // AC2 stream health: malformed (parser rejections) and droppedOversize
    // (cap drops that never reach the parser) are distinct counters.
    const streamHealth = makeStreamHealth();
    // Precedence inputs collected from the run (story Technical Notes):
    // how the process died > envelope presence > exit code.
    let mergedResult: Record<string, unknown> | null = null;
    let comsInitError: string | null = null;
    let runFacts: {
      exitCode: number | null;
      termSignal: string | null;
      killOrigin: "watchdog" | null;
    } = { exitCode: null, termSignal: null, killOrigin: null };

    try {
      const runResult = await _runTeamManifest(manifestFile, {
        forceLocalRunner: true,
        effectiveCeilingMicros: runCtx.effectiveCeilingMicros,
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
            case "coms_init_error":
              tracer?.trace({
                requestId,
                phaseId,
                type: adapted.type,
                name: adapted.name,
                payloadJson:
                  "payloadJson" in adapted ? adapted.payloadJson : JSON.stringify(adapted),
              });
              break;
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
              mergedResult = adapted.result;
              break;
          }
          if (event.kind === "coms_init_error") comsInitError = event.reason;
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
      const exitStatus = classifyRun({
        exitCode: runFacts.exitCode,
        termSignal: runFacts.termSignal,
        mergedResult,
        comsInitError: comsInitError !== null,
        killOrigin:
          runFacts.killOrigin === "watchdog"
            ? "watchdog"
            : runFacts.termSignal !== null
              ? "unknown"
              : null,
      });

      // AC6: the PHASE runs testCommand engine-side — in-box, in this
      // process, outside the team it just supervised. Never derived from the
      // driver stream, worker_output, or the merged envelope.
      let testResult = ZERO_TEST_RESULTS;
      if (spec.testCommand !== undefined && spec.testCommand.length > 0) {
        try {
          testResult = coerceTestsExecuted(
            await runTestCommand(spec.testCommand, { cwd: runRoot, signal }),
          );
        } catch {
          testResult = ZERO_TEST_RESULTS; // fail-closed, never fabricated
        }
      }

      // INV-1/2: one canonical run root for validation AND reads. changedFiles
      // get the two-stage decode-then-check; artifact paths additionally prove
      // they resolve beneath the root through DF1.1's walk before riding the
      // step output.
      const changedFiles = validateChangedFiles(runResult.changedFiles);
      const artifacts = validateArtifacts(runResult.artifacts ?? [], runRoot);

      const durationMs = runResult.durationMs;

      // Uniformity invariants (merger.ts) keyed on OUR classification, not
      // the harness's: success requires error=null/partial=false; non-success
      // requires a populated error; lead_failure forces empty agentOutputs
      // and changedFiles.
      const health = streamHealth.snapshot();
      const error =
        exitStatus === "success"
          ? null
          : (runResult.error ?? {
              reason: exitStatus === "lead_failure" ? "lead_failure" : exitStatus,
              message: `run classified ${exitStatus} (exit=${runFacts.exitCode ?? "null"} signal=${runFacts.termSignal ?? "none"} malformed=${health.malformedLines} dropped=${health.droppedOversizeLines})`,
            });
      const partialOutput =
        runResult.partialOutput ??
        (exitStatus === "success"
          ? null
          : `run ended ${exitStatus}: exit=${runFacts.exitCode ?? "null"} signal=${runFacts.termSignal ?? "none"}`);

      const merged = buildMergedOutput({
        exitStatus,
        partial: exitStatus === "success" ? false : runResult.partial,
        result: runResult.result,
        agentOutputs: exitStatus === "lead_failure" ? {} : runResult.agentOutputs,
        changedFiles: exitStatus === "lead_failure" ? [] : changedFiles,
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
          mulch_prime_ms: 0,
          box_setup_ms: 0,
          team_execution_ms: durationMs,
          gate_validation_ms: 0,
        },
      };
    } finally {
      try {
        unlinkSync(manifestFile);
      } catch {
        // cleanup is best-effort; never masks the typed result
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
      continue; // invalid encoding — reject
    }
    const segments = decoded.split(/[/\\]/);
    if (segments.includes("..") || decoded.startsWith("/") || /^[a-zA-Z]:/.test(decoded)) {
      continue;
    }
    valid.push(raw);
  }
  return valid;
}

/**
 * INV-1/2 for artifacts: same two-stage check, then the path must resolve
 * beneath the pinned run root through DF1.1's readArtifactBeneathRoot walk
 * (realpath + prefix re-assert + fd read). A path whose walk throws is
 * dropped — including the intermediate-symlink case O_NOFOLLOW alone would
 * miss. Names are preserved.
 */
export function validateArtifacts(
  artifacts: Array<{ name: string; path: string }>,
  runRoot: string,
): Array<{ name: string; path: string }> {
  const valid: Array<{ name: string; path: string }> = [];
  const claimOk = new Set(validateChangedFiles(artifacts.map((a) => a.path)));
  for (const artifact of artifacts) {
    if (!claimOk.has(artifact.path)) continue;
    try {
      // The read IS the validation: through the one canonical root, via the
      // DF1.1 resolver. Relative paths resolve against that root — the same
      // root validation used (INV-1: one canonical root, never cwd). INV-5 —
      // if the walk cannot be performed, this throws and the artifact is
      // refused, never silently accepted.
      readArtifactBeneathRoot(isAbsolute(artifact.path) ? artifact.path : join(runRoot, artifact.path), runRoot);
      valid.push(artifact);
    } catch {
      // walk refusal (escape, unresolvable, INV-5) — artifact dropped
    }
  }
  return valid;
}
