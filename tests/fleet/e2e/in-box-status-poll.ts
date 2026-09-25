/**
 * The AC5 status-poll loop, extracted from tier2-in-box-engine.live.test.ts
 * for its second consumer (T2.8 rig_swarm). The vocabulary and tolerances are
 * the MEASURED ones that file established — do not re-derive them here.
 *
 * The loop polls `fleet status <runId>` to a settled verdict, riding through
 * the documented benign races (marker-write/exit, cold-ssh `unknown` ticks,
 * flaky status-verb exits) and FAST-FAILING only a PROVEN-dead unit (positive
 * failure evidence from `systemctl show`).
 */
import { boxMarkerPath, classifyMarkerRead, DEFAULT_PER_CALL_DEADLINE_MS } from "../../../src/fleet/fanout-primitive.ts";
import type { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import { runUnitName } from "../../../src/fleet/run.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";
import { redactSecrets } from "../../../src/providers/step-log.ts";
import { fleetPartialOutput, lastJsonLine, REPO_ROOT, runFleet, shellQuote } from "./live-harness.ts";

/** AC5's terminal verdicts (tier2-in-box-engine.live.test.ts:183). */
export const SETTLED_STATES: ReadonlySet<string> = new Set(["ok", "not-ok"]);
/**
 * The AC5 states that mean "no marker yet", post-DF1.10 — the ONLY ones the
 * poll keeps riding through (a benign write/exit race, and a death the
 * dead-unit probe diagnoses far better than an early break would).
 */
export const POLLABLE_STATES: ReadonlySet<string> = new Set(["running", "not-running", "engine-failed"]);

export interface InBoxPollOptions {
  recordsDir: string;
  runId: string;
  /** Box path of the engine log; on a dead unit its tail IS the diagnosis. */
  engineLogBoxPath: string;
  evidence: Record<string, unknown>[];
  attempts?: number;
  waitMs?: number;
  verbTimeoutMs?: number;
  exitTolerance?: number;
  unknownTolerance?: number;
}

export interface InBoxPollResult {
  terminal: string;
  seenStates: string[];
  statusExitFailures: number;
}

/**
 * Poll `fleet status` until the in-box run settles (or a bound fires). The
 * caller turns a non-settled `terminal` into its own diagnostic throw.
 */
export async function pollInBoxRun(
  driver: ExeDevDriver,
  vmName: string,
  opts: InBoxPollOptions,
): Promise<InBoxPollResult> {
  const attempts = opts.attempts ?? 30;
  const waitMs = opts.waitMs ?? 20_000;
  const verbTimeoutMs = opts.verbTimeoutMs ?? 120_000;
  const exitTolerance = opts.exitTolerance ?? 3;
  const unknownTolerance = opts.unknownTolerance ?? 3;
  const seenStates: string[] = [];
  let terminal = "";
  let statusExitFailures = 0;
  let consecutiveUnknowns = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let status: Awaited<ReturnType<typeof runFleet>>;
    try {
      status = await runFleet(["status", opts.runId, "--driver", "exedev", "--dir", opts.recordsDir], {
        cwd: REPO_ROOT,
        timeoutMs: verbTimeoutMs,
      });
    } catch (fleetError) {
      const partial = fleetPartialOutput(fleetError);
      statusExitFailures += 1;
      opts.evidence.push({ phase: "status-verb-threw", attempt, error: fleetError instanceof Error ? fleetError.message : String(fleetError), stderrTail: redactSecrets(partial.stderr.trim().slice(-300)) });
      if (statusExitFailures > exitTolerance) break;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (status.exitCode !== 0) {
      statusExitFailures += 1;
      seenStates.push(`(status exit ${String(status.exitCode)})`);
      opts.evidence.push({ phase: "status-verb-failed", attempt, exitCode: status.exitCode, tolerated: statusExitFailures <= exitTolerance, stderrTail: redactSecrets(status.stderr.trim().slice(-300)) });
      if (statusExitFailures > exitTolerance) break;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    let row: { runId?: string; state?: string };
    try {
      row = lastJsonLine<{ runId?: string; state?: string }>(status.stdout);
    } catch (parseError) {
      opts.evidence.push({ phase: "status-parse-failed", attempt, error: parseError instanceof Error ? parseError.message : String(parseError) });
      if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (row.runId !== opts.runId) {
      opts.evidence.push({ phase: "status-wrong-run", attempt, expected: opts.runId, saw: row.runId ?? null });
      break;
    }
    const state = row.state ?? "";
    seenStates.push(state);
    if (SETTLED_STATES.has(state)) {
      terminal = state;
      break;
    }
    if (state === "unknown") {
      consecutiveUnknowns += 1;
      if (consecutiveUnknowns > unknownTolerance) break;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    consecutiveUnknowns = 0;
    if (!POLLABLE_STATES.has(state)) break;
    // Fast-fail a PROVEN-dead unit: only positive failure evidence stops the
    // poll — a clean exit with no marker rides through as the write/exit race
    // (the engine writes the marker BEFORE it exits). Guarded: a probe that
    // cannot answer is no evidence of failure.
    let unitStdout = "";
    try {
      unitStdout = (
        await driver.execTimed(
          vmName,
          ["systemctl", "show", runUnitName(opts.runId), "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus"],
          30_000,
        )
      ).stdout;
    } catch (probeError) {
      opts.evidence.push({ phase: "unit-probe-failed", attempt, error: probeError instanceof Error ? probeError.message : String(probeError) });
    }
    const activeState = /ActiveState=(\S*)/.exec(unitStdout)?.[1] ?? "";
    const result = /Result=(\S*)/.exec(unitStdout)?.[1] ?? "";
    const mainStatus = /ExecMainStatus=(\S*)/.exec(unitStdout)?.[1] ?? "";
    const unitDead =
      activeState === "failed" ||
      (activeState === "inactive" && (result !== "success" || mainStatus !== "0"));
    if (unitDead) {
      // Guarded like the probe above: the unit JUST died, so the box is at its
      // least reliable this exact instant, and a rejected marker read must not
      // prevent the unit-dead evidence from landing or the engine-log tail
      // (the actual diagnosis) from being collected. "read-failed" is the
      // retained status wherever a classified kind would be recorded.
      let markerKind = "read-failed";
      try {
        markerKind = classifyMarkerRead(
          await readBoxFile(driver, vmName, boxMarkerPath(opts.runId), DEFAULT_PER_CALL_DEADLINE_MS),
          opts.runId,
        ).kind;
      } catch (markerError) {
        opts.evidence.push({ phase: "marker-read-failed", attempt, error: markerError instanceof Error ? markerError.message : String(markerError) });
      }
      // The engine-log tail is the whole diagnosis for a Restart=no unit that
      // refused; guarded like the probe, and redacted before it reaches the
      // error message AND the evidence file.
      let tailText = "";
      try {
        tailText = (await driver.execTimed(vmName, ["sh", "-c", `tail -c 2000 ${shellQuote(opts.engineLogBoxPath)} 2>&1`], 30_000)).stdout;
      } catch (tailError) {
        tailText = `(engine-log read failed: ${tailError instanceof Error ? tailError.message : String(tailError)})`;
      }
      opts.evidence.push({ phase: "unit-dead", attempt, activeState, result, mainStatus, markerKind, engineLogTail: redactSecrets(tailText).slice(-2000) });
      throw new Error(
        `${runUnitName(opts.runId)} terminated after ${attempt} poll(s): ActiveState=${activeState} Result=${result} ExecMainStatus=${mainStatus} marker=${markerKind}. ` +
          `Engine log tail: ${redactSecrets(tailText).slice(-1200) || "(empty — the engine produced no log)"}`,
      );
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs));
  }
  return { terminal, seenStates, statusExitFailures };
}
