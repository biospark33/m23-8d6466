/**
 * A2 leaf-2.0.1 — the live-round leg drivers.
 *
 * Each QA hunter-pack leg's evidence JSON is written by ITS OWN driver (the
 * Z3 rule: post-hoc hand-copied evidence MUST fail — "each leg JSON is written
 * by the leg's own driver script"). Every leg JSON carries `swarmclawForkRev`
 * so Z1's drift alarm arms on the round's fork rev; `live-harness.ts` stays
 * un-stamping per Z1 AC7, so the stamp lives HERE.
 *
 * Also the story's D6 emitters: `qa-protocol-start` / `qa-leg-submitted` /
 * `qa-leg-terminal` are emitted by these drivers (factory side emits the other
 * two tokens host-side — see src/qa/index.ts).
 *
 * Tier-2 no-fakes round: real box (standard fleet dispatch), real QA hunter
 * legs, real bank retain + issue filing. GO-gated (charter §5.6): worst-case
 * spend printed before fire, operator GO recorded, keys/boxes cleaned in
 * `finally`, evidence scrubbed.
 */
import { log } from "../../src/lib/log.ts";
import { QA_LOG, QA_LENS, MAX_QA_LEGS } from "../../src/qa/findings.ts";
import { writeLegEvidence, type LegEvidence } from "../p0-9/leg-lib.ts";

/** The fork rev the round runs against — set per round; drift alarm arms on it. */
export const SWARMCLAW_FORK_REV = process.env.SWARMCLAW_FORK_REV?.trim() || "UNSET";

/** Worst-case per-leg spend ceiling the operator approves (USD). */
export const WORST_CASE_SPEND_USD = Number(process.env.QA_WORST_CASE_USD ?? "6");

/** Worst-case spend line, printed BEFORE any fire (charter §5.6). */
export function printWorstCaseSpend(legCount: number = QA_LENS.length): void {
  const legs = Math.min(legCount, MAX_QA_LEGS);
  // eslint-disable-next-line no-console
  console.log(
    `A2 LIVE ROUND — worst-case spend: $${WORST_CASE_SPEND_USD}/leg x ${legs} legs = $${(WORST_CASE_SPEND_USD * legs).toFixed(2)} max, plus gateway bot-turn spend for 1 recorded operator-initiated QA bot turn.`,
  );
}

export interface LegDriverDeps {
  /** Submits the leg via the fork-side protocol (external_job with the w:qa-* workId). */
  submitLeg: (lens: string) => Promise<{ workId: string; runId: string }>;
  /** Waits for the leg's terminal via the fleet result seam (driver-agnostic verbs only). */
  awaitTerminal: (runId: string) => Promise<{ exitCode: number; outcome: string }>;
  /** Resolves the fork rev the round runs against (drift-alarm stamp). */
  forkRev: () => string;
  /** Evidence dir (QDS_E2E_EVIDENCE_DIR — pinned to _bmad-output/evidence/v6-a2/ per the story). */
  outDir: string;
}

/** One log line with the house LogEntry shape (no duration math at the call site). */
function qaLog(operation: string, extra: Record<string, unknown>): void {
  log({
    requestId: `qa-live-${operation}`,
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: 0,
    status: "ok",
    ...extra,
    operation,
  });
}

/** Runs one leg end-to-end: submit → await terminal → write the leg's OWN evidence JSON. */
export async function runLeg(deps: LegDriverDeps, lens: string): Promise<LegEvidence & { swarmclawForkRev: string }> {
  qaLog(QA_LOG.legSubmitted, { status: "ok", lens });
  const started = Date.now();
  const { workId, runId } = await deps.submitLeg(lens);
  const terminal = await deps.awaitTerminal(runId);
  log({
    requestId: `qa-live-${lens}`,
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: Date.now() - started,
    status: "ok",
    runId,
    workId,
    exitCode: terminal.exitCode,
    operation: QA_LOG.legTerminal,
  });
  const evidence = {
    leg: `qa-${lens}`,
    mode: "live" as const,
    ok: terminal.exitCode === 0,
    outcome: terminal.outcome,
    steps: [],
    origin: `scripts/qa/leg-drivers.ts runLeg(${lens})`,
    exitCode: terminal.exitCode,
    stdoutTail: "",
    stderrTail: "",
    writtenAt: new Date().toISOString(),
    swarmclawForkRev: deps.forkRev(),
  };
  writeLegEvidence({ mode: "live", outDir: deps.outDir }, `qa-${lens}`, evidence);
  return evidence;
}
