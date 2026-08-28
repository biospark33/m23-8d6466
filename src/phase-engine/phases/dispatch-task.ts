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
  isExitStatus,
} from "./team-event-adapter.ts";
import { buildMergedOutput } from "../../../cli-anything/src/merger.ts";
import { redactSecrets } from "../../../cli-anything/src/redact.ts";
import { runTeamManifest } from "../../../cli-anything/src/runner.ts";
import type { MergedOutput, TeamManifest } from "../../../cli-anything/src/types.ts";
import type { PhaseBody, PhaseBodyContext } from "../phase.ts";
import type { PhaseSpec, PhaseSubTimings, ExitStatus } from "../types.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  /**
   * Canonical run root for artifact reads (INV-1/2). The pipeline runner
   * passes its --run-root; falls back to QDS_RUN_ROOT then cwd. Without
   * this, a --run-root invocation would validate artifacts against the
   * process cwd — a different canonical root.
   */
  rootDir?: string;
}

// ponytail: minimal runner injection seam for tests — default is real runTeamManifest
let _runTeamManifest = runTeamManifest;
export function _injectRunner(fn: typeof runTeamManifest | null): void {
  _runTeamManifest = fn ?? runTeamManifest;
}
export function _resetRunner(): void {
  _runTeamManifest = runTeamManifest;
}

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
      console.warn(`[dispatch-task] refused: phase '${spec.name}' — dispatch_task requires roster and task`);
      return refuse(
        `phase '${spec.name}': dispatch_task requires roster and task`,
        redact,
      );
    }

    // D6: cardinality checks BEFORE dual-gate (pi spawn ~180s) — local checks first
    // D9: anchor roster path at runRoot, not process.cwd()
    const rosterRunRoot = deps.rootDir ?? process.env.QDS_RUN_ROOT ?? process.cwd();
    // S2: hoist empty/whitespace check before expensive loadRoster + dual-gate (~180s)
    if (rosterRunRoot.trim() === "") {
      return refuse("QDS_RUN_ROOT is empty (use unset or a non-empty path)", redact);
    }
    let roster: ResolvedRoster;
    try {
      roster = loadRoster(rosterPath, { cwd: rosterRunRoot });
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err), redact);
    }
    const roles = roster.roles;
    if (roles.length < 2) {
      return refuse("roster must declare a lead role and at least one worker", redact);
    }

    // Resolve + dual-gate the roster (DF1.5). An unverified gate refuses the
    // dispatch rather than spawning.
    const gate = await validateRoster(roster, deps.rosterValidateDeps);
    if (gate.exitCode !== 0) {
      const first = gate.problems[0];
      return refuse(
        `roster gate failed (exit ${gate.exitCode})${first !== undefined ? `: ${first}` : ""}`,
        redact,
      );
    }

    const leadRole = roles[0]!;
    const workerRoles = roles.slice(1);
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
        // still requires it); pipelineId keeps the trace line honest.
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
    const runRoot = deps.rootDir ?? process.env.QDS_RUN_ROOT ?? process.cwd();
    // D14: treat empty/whitespace string as unset for QDS_RUN_ROOT
    if (runRoot.trim() === "") {
      return refuse("QDS_RUN_ROOT is empty (use unset or a non-empty path)", redact);
    }
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
    let runFacts: {
      exitCode: number | null;
      termSignal: string | null;
      killOrigin: "watchdog" | "budget" | "wallClock" | "requestedShutdown" | null;
    } = { exitCode: null, termSignal: null, killOrigin: null };

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
              if (!mergedSeen) {
                mergedResult = adapted.result;
                mergedSeen = true;
              } else {
                console.warn(`[dispatch-task] duplicate merged event ignored (requestId=${requestId}, phaseId=${phaseId})`);
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
          console.warn(`[dispatch-task] testCommand skipped (phase aborted: ${abortReason})`);
          testResult = { testsExecuted: false, testResults: { passed: 0, failed: 0 }, reason: `aborted: ${abortReason}` };
        } else {
          testResult = coerceTestsExecuted(
            await runTestCommand(spec.testCommand, { cwd: runRoot, signal }),
          );
          // D4: log testCommand failure reason for observability
          if (testResult.reason) {
            console.warn(`[dispatch-task] testCommand failed: ${testResult.reason}`);
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
      const artifacts = validateArtifacts(runResult.artifacts ?? [], runRoot);

      // Fail-safe: reject non-finite or negative values from malformed merged events
      let durationMs = runResult.durationMs;
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        console.warn(`[dispatch-task] invalid durationMs (${runResult.durationMs}), using 0`);
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

      // D2: Spawn/stream failure → runner settles transient, but dispatch classifies lead_failure
      // when there's no exit signal evidence. Prefer runResult.exitStatus when it exists.
      let finalExitStatus = exitStatus;
      // S1: Validate runResultStatus before use — garbage from buggy/compromised runner
      // must not flow into finalExitStatus → envelope exitStatus + partialOutput.message
      const validatedRunResultStatus: ExitStatus = isExitStatus(runResultStatus)
        ? runResultStatus
        : (() => {
            console.warn(`[dispatch-task] invalid runResult.exitStatus (using lead_failure): ${redact(String(runResultStatus))}`);
            return "lead_failure" as const;
          })();
      if (runFacts.exitCode === null && runFacts.termSignal === null && runFacts.killOrigin === null &&
          validatedRunResultStatus !== "success" && validatedRunResultStatus !== "lead_failure") {
        finalExitStatus = validatedRunResultStatus;
      }

      // D3: When classification would return success but runResult.exitStatus is non-success,
      // take runResult.exitStatus and keep its error + partial.
      if (finalExitStatus === "success" && validatedRunResultStatus !== "success") {
        finalExitStatus = validatedRunResultStatus;
      }

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
    } finally {
      try {
        rmSync(manifestFile, { force: true });
      } catch (err) {
        // cleanup is best-effort; never masks the typed result
        // ponytail: warn but don't throw — orphaned manifests are benign
        console.error(`manifest cleanup failed: ${manifestFile}`, err instanceof Error ? err.message : String(err));
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
 * beneath the pinned run root through DF1.1's readArtifactBeneathRoot walk
 * (realpath + prefix re-assert + fd read). A path whose walk throws is
 * dropped — including the intermediate-symlink case O_NOFOLLOW alone would
 * miss. Names are preserved.
 *
 * D10: Artifacts larger than MANIFEST_MAX_BYTES are silently dropped — add
 * console.warn + trace record for observability.
 * D15: Artifact `name` field must be validated (non-empty, no control chars/newlines, ≤200 chars).
 */
export function validateArtifacts(
  artifacts: Array<{ name: string; path: string }>,
  runRoot: string,
): Array<{ name: string; path: string }> {
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
      console.warn("[dispatch-task] artifact dropped: malformed entry (null or non-object)");
      continue;
    }
    // D15: validate artifact name (with type guard since we filtered objects above)
    if (!artifact || typeof artifact.name !== "string" || artifact.name.trim().length === 0) {
      console.warn("[dispatch-task] artifact dropped: invalid name (empty or non-string)");
      continue;
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security check
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(artifact.name) || artifact.name.includes("\n")) {
      // S8: regex excludes \x0a/\x0d; explicit newline check yields a clearer error message
      console.warn("[dispatch-task] artifact dropped: name contains control chars or newline");
      continue;
    }
    if (artifact.name.length > 200) {
      console.warn("[dispatch-task] artifact dropped: name exceeds 200 chars");
      continue;
    }

    if (!claimOk.has(artifact.path)) continue;
    try {
      // The read IS the validation: through the one canonical root, via the
      // DF1.1 resolver. Relative paths resolve against that root — the same
      // root validation used (INV-1: one canonical root, never cwd). INV-5 —
      // if the walk cannot be performed, this throws and the artifact is
      // refused, never silently accepted.
      // Defense-in-depth: validateChangedFiles already rejects absolute paths,
      // but we keep this branch for explicitness and in case that check evolves.
      readArtifactBeneathRoot(isAbsolute(artifact.path) ? artifact.path : join(runRoot, artifact.path), runRoot);
      valid.push(artifact);
    } catch {
      // D10: log dropped artifacts for observability
      console.warn(`[dispatch-task] artifact dropped: ${artifact.name} (${artifact.path}) — validation or read failed`);
    }
  }
  return valid;
}
