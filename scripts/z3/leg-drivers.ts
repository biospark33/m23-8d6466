/**
 * Z3 — the live exit round's leg drivers: one driver per leg, each writing its
 * OWN leg JSON through `writeZ3Evidence` (the story's AC1 house rule: "each
 * leg JSON is written by the leg's own driver script"), plus the round
 * sequence, its crash-window watcher, and its unconditional cleanup.
 *
 * Every substrate touch is an INJECTED dep (`Z3Deps`), mirroring
 * scripts/qa/leg-drivers.ts: the fixture tier drives these exact functions
 * with in-memory fakes; the live round wires the concrete seams from
 * scripts/z3/live-round-wiring.ts (the committed fork CLI
 * `scripts/solstice/z3-exit-round.ts` state/disarm/cancel, `fleet result`, box inventory, run
 * records, ledger, memgate ledger, approve exec).
 *
 * Driver posture (sc2-7 round-1 lesson): evidence is written BEFORE a leg's
 * own check throws, so a red round still carries what landed. The checks a
 * driver makes are the leg's local invariant; the round-level verdict is
 * re-derived from the files on disk by scripts/z3/assertions.ts.
 *
 * The fork chains every step by itself (nextStepId) and never waits for this
 * driver, so (a) observe deltas are ATTRIBUTED — a box/key belonging to
 * another fleet run of the bound protocol run is that run's, not the
 * observe's — and (b) the crash-window watcher is armed at round start,
 * concurrent with the QA legs, not after them. A driver-side failure cancels
 * the fork PROTOCOL run first, so the fork stops submitting before the sweep.
 */
import { log } from "../../src/lib/log.ts";
import type { CrashGate } from "./crash-gate.ts";
import { type EvidenceSink, scrubText, writeZ3Evidence } from "./evidence.ts";
import {
  type OperatorGo,
  type RoundRun,
  type Z3EvidenceLeg,
  Z3_APPROVED_CASE,
  Z3_STEP,
  Z3_TEMPLATE_ID,
} from "./round-plan.ts";

/** What a fleet run record looks like to the drivers (RunRecordStore subset). */
export interface RecordView {
  runId: string;
  createdAt: string;
  requestId?: string;
  vmName?: string;
  /** The provider key minted for the run (sha256 hash — never the key). */
  keyHash?: string;
}

/** One memgate issuance row (the ledger is append-only: revocations live elsewhere). */
export interface MemoryKeyRow {
  tokenId: string;
  kind: "per-run" | "agent";
  runId: string | null;
  verbs: string[];
}

/** The round's pre-leg substrate snapshot (what an observe leg must not grow). */
export interface Z3Baseline {
  boxes: string[];
  providerKeys: string[];
  memoryKeys: string[];
}

export interface Z3Trigger {
  protocolRunId: string;
  scheduleId: string;
  templateId: string;
  firedAt: string;
  /** Every external_job step's fork-side groupCapUsd — what the fire may actually spend. */
  stepCaps: Array<{ stepId: string; groupCapUsd: number }>;
  /**
   * Each fired QA leg's wire-config review set (scope-derivation amendment),
   * by stepId — null where the fork carried none (an A2-shaped leg is the
   * round-18 failure mode by construction and the trigger leg refuses it).
   */
  qaLegReviewSets: Array<{ stepId: string; reviewSet: readonly string[] | null }>;
  /** The fork image's revision label, when the image carries one (it has no .git); null otherwise. */
  forkRev: string | null;
}

export interface Z3Deps {
  sink: EvidenceSink;
  /** Binds THIS round's schedule-fired protocol run (by the armed scheduleId; never another run). */
  awaitTrigger: () => Promise<Z3Trigger>;
  /**
   * The step's factory entry is `submitting` with its persisted requestId
   * (the crash window is open), read from a FRESH fork state. `stopped()`
   * aborts the watch (the round already failed).
   */
  awaitStepSubmitting: (stepId: string, stopped: () => boolean) => Promise<{ requestId: string }>;
  /** The step's factory entry carries a fleet runId (a recoverable lastError is recorded, not fatal). */
  awaitStepSubmitted: (stepId: string) => Promise<{ runId: string; workId: string; requestId: string; lastError: string | null }>;
  /** A `factory_observe` step finished; the run it was configured to read (`fromStepOutput`). */
  awaitObserveStep: (stepId: string) => Promise<{ kind: string; status: string; observedRunId: string | null }>;
  /**
   * The bound protocol run's fleet footprint from a fresh read: every runId its
   * factoryState names, every requestId (including entries still `submitting`,
   * whose run exists before the fork learns its id), and the steps in flight.
   */
  protocolFleet: () => Promise<{ runIds: string[]; requestIds: string[]; submitting: string[] }>;
  /**
   * Fork-side disarm of the armed schedule (idempotent): it never fires (again);
   * names every run carrying its id and the schedule's status after the re-read.
   */
  disarmSchedule: () => Promise<{ disarmed: boolean; firedRunIds: string[]; scheduleStatus: string | null }>;
  /** Fork-side cancel of a protocol run this round's schedule fired (it fleet-cancels its outstanding steps). */
  cancelProtocolRun: (
    protocolRunId: string,
  ) => Promise<{ cancelled: boolean; fleetCancelled: string[]; inFlightRequestIds?: string[] }>;
  /** The fork's fleet-CLI wrapper gate (scripts/z3/fleet-gate.sh): holds the z3 code submit open. */
  crashGate: CrashGate;
  /** SIGKILL the fork daemon mid-submit / bring it back (the re-drive). */
  killFork: () => Promise<void>;
  restartFork: () => Promise<void>;
  /** Polls the driver-agnostic `fleet result` seam until the wanted state. */
  awaitResult: (runId: string, want: "terminal" | "awaiting-approval") => Promise<{ status: string; terminal: boolean }>;
  /**
   * The A2 cadence pair (`fleet status` engine-settle → `fleet teardown`):
   * the teardown CLOSES the fleet record, the only transition the fork's leg
   * poller can observe (`fleet result` is a pure record read — #913's live
   * mechanism, three rounds red'd on the missing closure). Without it the
   * record never reads terminal and the leg can only time out.
   */
  settleAndTeardown: (runId: string) => Promise<{ state: string; teardownExit: number; teardownTail: string; teardownExitHealed?: boolean }>;
  /** The provider's box listing (names). */
  inventory: () => Promise<string[]>;
  readRecord: (runId: string) => RecordView | null;
  recordsForRequestId: (requestId: string) => RecordView[];
  /** Ledger rows booking spend for the request: gate admissions + group reservations, both by requestId. */
  ledgerBookings: (requestId: string) => { gateAdmissions: number; groupReservations: number };
  providerKeyHashes: () => Promise<string[]>;
  memoryKeys: () => MemoryKeyRow[];
  /** A2's host-side retain of the leg's harvested findings; traces are the host client's own journaled calls. */
  retainFindings: (
    lens: string,
    runId: string,
    codeWorkId?: string,
  ) => Promise<{ bank: string; documentIds: string[]; traces: Array<{ side: "host" | "box"; documentId: string }> }>;
  /** The step's budget-group work id from the fork state (externalJobConfig), or undefined when the state does not carry it yet. */
  readStepWorkId: (stepId: string) => Promise<string | undefined>;
  /** A round-side gateway call authenticated by an M2.1 agent token — origin + token ID, never the token. */
  gatewayAssert: (bank: string) => Promise<{ origin: string; agentTokenId: string }>
  /**
   * THE PARK ACTOR (attempt 14, live: the round polled for awaiting-approval
   * for ~2 h while nobody performed it — the record read settled-ok forever).
   * `fleet observe` is the completion chain's actor (SC2.7's proven shape):
   * pre-register → harvest/teardown → reverify → gate; a green verdict parks
   * the run at awaiting-approval and the chain's own teardown reaps the box.
   */
  parkForApproval: (runId: string) => Promise<{ exitCode: number; tail: string }>;
  /**
   * THE RELEASE WAITS FOR THE LAST RETAIN TO BE RECALLABLE (round-19
   * attempt-5 finding, 2026-11-02): hindsight's recall surfaced only
   * pre-round documents when the code run dispatched 189 ms after the last
   * retain — the fresh findings were still mid-ingestion (directive
   * kg_context, 7,985 chars, zero overlap: all nine recalled ids predate the
   * round). Polls a dispatch-shaped recall until ≥1 round doc id surfaces
   * (bounded), returning whether it ever did; the caller refuses to release
   * the code submit into an unprimed bank.
   */
  waitFindingsRecallable: (input: { bank: string; docIds: readonly string[]; codeWorkId?: string }) => Promise<boolean>;
  /** The dispatch recall row (`_bmad-output/memory/recall/<requestId>.json`). */
  readRecall: (requestId: string) => { directive: string; recalledDocumentIds: string[] } | null;
  /** `fleet approve` with the token on stdin; returns what the CLI said. */
  approve: (
    runId: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string; approverId: string; tokenChannel: "stdin" }>;
  awaitProtocolComplete: (protocolRunId: string) => Promise<{
    runStatus: string;
    artifacts: Array<{ kind: string; content: string }>;
    events: Array<{ type: string; stepId?: string; summary?: string; data?: { caseId?: string } }>;
  }>;
  /** Provider-key revoke-verify for the round's runs (receipts + problems; never throws on a leak). */
  revokeVerify: (runIds: readonly string[]) => Promise<{ receipts: Record<string, unknown>[]; problems: string[] }>;
  /** `fleet cancel` per run (idempotent) — box destroy receipts. */
  destroyBoxes: (runIds: readonly string[]) => Promise<{ receipts: Record<string, unknown>[]; problems: string[] }>;
  /** Restores-or-deletes the approver allowlist the approve leg wrote. */
  restoreApprovers: () => string[];
  sleep: (ms: number) => Promise<void>;
  /**
   * INV-Z3-2 probe: the ADR-2 auto-merge policy state as the read-only loader
   * the run-completion consult uses sees it (src/fleet/auto-merge-policy.ts
   * readAutoMergePolicy). ON must be unreachable for this round.
   */
  autoMergePolicy: () => { state: "absent" | "off" | "on"; stateReason?: string };
}

/** The decision channel ADR-1 §3 allows — the only `decisionSource` an approve may carry. */
export const FLEET_APPROVE_STDIN = "fleet-approve-stdin";

/** The one-box invariant must HOLD, not appear — re-read after this window (sc2-7). */
export const BOX_STABILITY_MS = 10_000;

/** The only memory verb that reads; every other verb (retain/reflect/consolidate) writes the bank. */
export const READ_ONLY_MEMORY_VERBS: readonly string[] = ["recall"];

/** Boxes attributable to one run: exe.dev names the VM after the runId; the record's vmName wins. Exact, never substring. */
export function boxesFor(names: readonly string[], runId: string, vmName?: string): string[] {
  return names.filter((n) => n === runId || (vmName !== undefined && n === vmName));
}

/** One observability line, house LogEntry shape, returned so the leg JSON carries it verbatim. */
function legLine(leg: Z3EvidenceLeg, fields: Record<string, unknown>): string {
  const entry = {
    requestId: `z3-${leg}`,
    operation: `z3-${leg}`,
    agentId: null,
    timestamp: new Date().toISOString(),
    duration: 0,
    status: "ok" as const,
    event: "z3-leg",
    leg,
    ...fields,
  };
  log(entry);
  return JSON.stringify(entry);
}

/**
 * Scrub BEFORE truncating (a cut through a secret would leave an unrecognizable
 * live key body), and AGAIN after (a cut can mint a new `\b`-anchored shape,
 * e.g. `task-…` → `sk-…`, which would refuse the whole write).
 */
function tail(d: Z3Deps, s: string, n: number): string {
  return scrubText(scrubText(s, d.sink.knownSecrets).slice(-n), d.sink.knownSecrets);
}

/** Writes a leg JSON; a refused write still carries the leg's own problems in the thrown error. */
function write(d: Z3Deps, leg: Z3EvidenceLeg, problems: readonly string[], fields: Record<string, unknown>): void {
  try {
    writeZ3Evidence(d.sink, leg, fields);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`z3 ${leg}: evidence write refused (${why})${problems.length > 0 ? `; leg problems: ${problems.join("; ")}` : ""}`);
  }
}

/** Write the leg, then fail it — evidence first, so a red leg still records what landed. */
function settle(d: Z3Deps, leg: Z3EvidenceLeg, problems: string[], body: Record<string, unknown>): void {
  const ok = problems.length === 0;
  // Body FIRST: a dep-returned field named exitCode/stdoutTail must never turn a red leg green.
  write(d, leg, problems, {
    ...body,
    exitCode: ok ? 0 : 1,
    stdoutTail: "",
    stderrTail: tail(d, problems.join("\n"), 2000),
    observability: [legLine(leg, { outcome: ok ? "ok" : "failed", ...pickIds(body) })],
  });
  if (!ok) throw new Error(`z3 ${leg}: ${problems.join("; ")}`);
}

function pickIds(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["runId", "stepId", "lens", "protocolRunId"]) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

const fresh = (after: readonly string[], before: readonly string[]) => after.filter((x) => !before.includes(x));
const cents = (usd: number) => Math.round(usd * 100);

export async function snapshot(d: Z3Deps): Promise<Z3Baseline> {
  return {
    boxes: await d.inventory(),
    providerKeys: await d.providerKeyHashes(),
    memoryKeys: d.memoryKeys().map((k) => k.tokenId),
  };
}

// ─── the 11 legs ─────────────────────────────────────────────────────────────

/**
 * Binds the fired run and proves the GO covered what the FORK will spend: the
 * fired steps' own groupCapUsd sum must equal the printed worst case (the
 * composition the schedule was armed from) and fit the GO.
 */
export async function driveTrigger(
  d: Z3Deps,
  plan: { runs: readonly RoundRun[]; worstCaseUsd: number; go: OperatorGo; reviewSet: readonly string[] },
  bind: (protocolRunId: string) => void = () => {},
) {
  const t = await d.awaitTrigger();
  // Bound BEFORE any check: a refused fire is still a fired run the cleanup must cancel.
  bind(t.protocolRunId);
  const forkCapsUsd = t.stepCaps.reduce((s, c) => s + cents(c.groupCapUsd), 0) / 100;
  const problems: string[] = [];
  if (t.templateId !== Z3_TEMPLATE_ID) problems.push(`fired template ${t.templateId}, not ${Z3_TEMPLATE_ID}`);
  if (t.stepCaps.length !== plan.runs.length) problems.push(`the fired run carries ${t.stepCaps.length} fleet steps, the plan ${plan.runs.length}`);
  if (cents(forkCapsUsd) !== cents(plan.worstCaseUsd)) {
    problems.push(`the fired run's caps sum to $${forkCapsUsd.toFixed(2)}, the GO-gated worst case is $${plan.worstCaseUsd.toFixed(2)}`);
  }
  if (cents(forkCapsUsd) > cents(plan.go.spendApproved.worstCaseUsd)) problems.push(`the fired caps exceed the GO's $${plan.go.spendApproved.worstCaseUsd}`);
  // Scope-derivation amendment (2026-10-27): every fired QA leg must carry
  // EXACTLY the pinned set — a leg hunting the A2 static scopes at this pin
  // audits nothing (round 18) and the round must refuse, not red at priming.
  for (const leg of t.qaLegReviewSets) {
    if (leg.reviewSet == null || [...leg.reviewSet].sort().join("\n") !== [...plan.reviewSet].sort().join("\n")) {
      problems.push(`the fired ${leg.stepId} carries reviewSet ${JSON.stringify(leg.reviewSet)}, the pinned ${JSON.stringify(plan.reviewSet)}`);
    }
  }
  // Short vs full sha: one must prefix the other (the image label may be the full rev).
  const sameRev = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  if (t.forkRev !== null && !sameRev(t.forkRev, d.sink.forkRev)) problems.push(`the running fork reports rev ${t.forkRev}, the round stamps ${d.sink.forkRev}`);
  // INV-Z3-2: the round asserts park → human decision; an ADR-2 policy that can arm would bypass it.
  const policy = d.autoMergePolicy();
  if (policy.state === "on") problems.push("the ADR-2 auto-merge policy reads ON — this round asserts park → human decision, never a policy merge");
  settle(d, "trigger", problems, {
    protocolRunId: t.protocolRunId,
    scheduleId: t.scheduleId,
    templateId: t.templateId,
    firedAt: t.firedAt,
    stepCaps: t.stepCaps,
    reviewSet: plan.reviewSet,
    forkCapsUsd,
    forkRevObserved: t.forkRev,
    // The image carries no .git: without a revision label the stamped rev is the operator's word, said so.
    forkRevVerification: t.forkRev === null ? "unverifiable-from-image" : "image-label",
    autoMergePolicy: policy,
    worstCaseSpendUsd: plan.worstCaseUsd,
    operatorGo: { who: plan.go.who, when: plan.go.when, approvedUsd: plan.go.spendApproved.worstCaseUsd },
  });
  return t;
}

export async function driveKillAndProvision(
  d: Z3Deps,
  input: { stepId: string; inventoryBefore: string[]; track: (runId: string) => void },
) {
  const sub = await d.awaitStepSubmitted(input.stepId);
  // Hoisted BEFORE any check (sc2-7): the run exists, so the cleanup must be
  // able to cancel it even when this leg fails.
  input.track(sub.runId);
  const vmName = d.readRecord(sub.runId)?.vmName;
  const first = boxesFor(await d.inventory(), sub.runId, vmName);
  await d.sleep(BOX_STABILITY_MS);
  const second = boxesFor(await d.inventory(), sub.runId, vmName);
  const liveBoxesForRun = [...new Set([...first, ...second])];
  const problems: string[] = [];
  // HOLD, not appear: one box in BOTH samples, the same one.
  if (first.length !== 1 || second.length !== 1 || first[0] !== second[0]) {
    problems.push(`expected the same single box for ${sub.runId} in both samples, saw [${first.join(",")}] then [${second.join(",")}]`);
  }
  if (vmName === undefined || liveBoxesForRun[0] !== vmName) problems.push(`the record's vmName ${vmName} is not the live box`);
  settle(d, "kill-and-provision", problems, {
    stepId: input.stepId,
    runId: sub.runId,
    workId: sub.workId,
    requestId: sub.requestId,
    lastErrorSeen: sub.lastError,
    vmName: vmName ?? null,
    inventoryBefore: input.inventoryBefore,
    boxCountSamples: [first.length, second.length],
    liveBoxesForRun,
  });
  return { ...sub, liveBoxesForRun, boxCountSamples: [first.length, second.length] };
}

/** After teardown: re-reads the record + inventory; equality with the live box, none left (re-read once if teardown lags). */
export async function driveBoxForensics(
  d: Z3Deps,
  input: { runId: string; liveBoxesForRun: string[]; settle?: { state: string; teardownExit: number; teardownTail: string } },
) {
  const rec = d.readRecord(input.runId);
  let after = boxesFor(await d.inventory(), input.runId, rec?.vmName);
  if (after.length > 0) {
    await d.sleep(BOX_STABILITY_MS);
    after = boxesFor(await d.inventory(), input.runId, rec?.vmName);
  }
  const problems: string[] = [];
  if (rec === null) problems.push(`no run record for ${input.runId}`);
  if (input.liveBoxesForRun.length !== 1 || input.liveBoxesForRun[0] !== rec?.vmName) {
    problems.push(`live boxes ${JSON.stringify(input.liveBoxesForRun)} ≠ record vmName ${rec?.vmName}`);
  }
  if (after.length !== 0) problems.push(`box(es) outlived teardown: ${after.join(", ")}`);
  if (input.settle && input.settle.teardownExit !== 0) problems.push(`teardown exit ${input.settle.teardownExit}: ${input.settle.teardownTail}`);
  settle(d, "box-forensics", problems, {
    runId: input.runId,
    recordRunId: rec?.runId ?? null,
    recordVmName: rec?.vmName ?? null,
    liveBoxesForRun: input.liveBoxesForRun,
    afterTeardownBoxesForRun: after,
    // The QA legs' settle receipts (undefined on the code run: the approval
    // gate settles that record, not a teardown).
    ...(input.settle ? { recordSettle: input.settle } : {}),
  });
}

/** Every fleet runId attributable to the bound protocol run: named runIds ∪ records of its requestIds. */
export async function protocolRunIds(d: Z3Deps): Promise<{ runIds: string[]; submitting: string[] }> {
  const fleet = await d.protocolFleet();
  const viaRequest = fleet.requestIds.flatMap((req) => d.recordsForRequestId(req).map((r) => r.runId));
  return { runIds: [...new Set([...fleet.runIds, ...viaRequest])], submitting: fleet.submitting };
}

/** How long an observe leg waits for an in-flight sibling submit to ack before charging what it cannot attribute. */
export const SUBMIT_SETTLE_POLLS = 30;

/**
 * The fresh resources an observe leg is charged with: everything new since
 * the pre-provision baseline EXCEPT what is attributable to a fleet run of
 * the bound protocol run — by runId OR by the requestId the fork persisted at
 * `submitting` (the next leg's box/key exist before the fork learns its
 * runId). While anything is unattributed AND a sibling step is still
 * `submitting`, re-sample after it acks (bounded); what is still
 * unattributable is charged (fail-closed).
 */
async function observeDeltas(d: Z3Deps, baseline: Z3Baseline) {
  const measure = async () => {
    const after = await snapshot(d);
    const { runIds, submitting } = await protocolRunIds(d);
    const records = runIds.map((id) => d.readRecord(id));
    const ownedBoxes = new Set(runIds.flatMap((id, i) => boxesFor(after.boxes, id, records[i]?.vmName)));
    const ownedKeys = new Set(records.map((r) => r?.keyHash).filter((h): h is string => typeof h === "string"));
    const ownedMemory = new Set(d.memoryKeys().filter((k) => k.kind === "per-run" && k.runId !== null && runIds.includes(k.runId)).map((k) => k.tokenId));
    return {
      submitting,
      attributedToRuns: runIds,
      boxesProvisioned: fresh(after.boxes, baseline.boxes).filter((b) => !ownedBoxes.has(b)),
      providerKeysMinted: fresh(after.providerKeys, baseline.providerKeys).filter((h) => !ownedKeys.has(h)),
      memoryKeysMinted: fresh(after.memoryKeys, baseline.memoryKeys).filter((t) => !ownedMemory.has(t)),
    };
  };
  let m = await measure();
  let settlePolls = 0;
  const unattributed = () => m.boxesProvisioned.length + m.providerKeysMinted.length + m.memoryKeysMinted.length > 0;
  // The gated code submit is held BEFORE its exec (it provisions nothing) and its
  // fork is killed at once — waiting on it would never ack, so it is not a sibling.
  const inFlight = () => m.submitting.filter((stepId) => stepId !== Z3_STEP.codeRun);
  while (unattributed() && inFlight().length > 0 && settlePolls < SUBMIT_SETTLE_POLLS) {
    await d.sleep(BOX_STABILITY_MS);
    settlePolls++;
    m = await measure();
  }
  const { submitting: _inFlight, ...deltas } = m;
  return { ...deltas, settlePolls };
}

async function observeLeg(
  d: Z3Deps,
  leg: "qa-run-observe" | "observe-read-only",
  input: { stepId: string; runId: string; baseline: Z3Baseline; lens?: string },
) {
  const step = await d.awaitObserveStep(input.stepId);
  const deltas = await observeDeltas(d, input.baseline);
  const body = {
    ...(input.lens === undefined ? {} : { lens: input.lens }),
    stepId: input.stepId,
    stepKind: step.kind,
    stepStatus: step.status,
    // The fork persists no per-observe read id: this is the step's configured
    // target (`fromStepOutput`), and the step's completed status (onFailure:
    // 'fail') is the fork-side witness that the read landed.
    observedRunId: step.observedRunId,
    observedRunIdSource: "fromStepOutput",
    ...deltas,
  };
  const problems: string[] = [];
  if (step.kind !== "factory_observe") problems.push(`step kind ${step.kind}, not factory_observe`);
  if (step.status !== "completed") problems.push(`observe step ended ${step.status}`);
  if (step.observedRunId !== input.runId) problems.push(`observe targets ${step.observedRunId}, not ${input.runId}`);
  if (deltas.boxesProvisioned.length > 0) problems.push(`observe provisioned box(es): ${deltas.boxesProvisioned.join(", ")}`);
  if (deltas.providerKeysMinted.length > 0) problems.push("observe minted a provider key");
  if (deltas.memoryKeysMinted.length > 0) problems.push("observe minted a memory key");
  settle(d, leg, problems, body);
}

export function driveQaRunObserve(d: Z3Deps, input: { lens: string; runId: string; baseline: Z3Baseline }) {
  return observeLeg(d, "qa-run-observe", { ...input, stepId: Z3_STEP.qaObserve(input.lens) });
}

export function driveObserveReadOnly(d: Z3Deps, input: { runId: string; baseline: Z3Baseline }) {
  return observeLeg(d, "observe-read-only", { ...input, stepId: Z3_STEP.codeObserve });
}

/** Memory keys a box could WRITE the bank with: per-run issuances for this run carrying any non-recall verb. */
export function writeCredentialsFor(keys: readonly MemoryKeyRow[], runId: string): MemoryKeyRow[] {
  return keys.filter((k) => k.runId === runId && k.verbs.some((v) => !READ_ONLY_MEMORY_VERBS.includes(v)));
}

export async function driveFindingsRetain(d: Z3Deps, input: { lens: string; runId: string; codeWorkId?: string }) {
  let r: Awaited<ReturnType<typeof d.retainFindings>>;
  try {
    r = await d.retainFindings(input.lens, input.runId, input.codeWorkId);
  } catch (e) {
    // ONE retry on a fetch timeout (attempt 13, live: leg 2's retain POST
    // crossed the client's 30 s RETAIN_TIMEOUT_MS while hindsight's inline
    // extraction ran past it — a whole round died on one slow read). The
    // retain is an idempotent upsert (fixed documentIds, replace mode) and
    // the forensics traces dedupe through a Set, so the retry cannot
    // double-count anything.
    const name = (e as { name?: string })?.name ?? "";
    if (name !== "TimeoutError") throw e;
    await d.sleep(10_000);
    r = await d.retainFindings(input.lens, input.runId, input.codeWorkId);
  }
  const gatewayAssertion = await d.gatewayAssert(r.bank);
  const runKeys = d.memoryKeys().filter((k) => k.runId === input.runId);
  const boxWriteCredentials = writeCredentialsFor(runKeys, input.runId);
  const retainSide = r.traces.every((t) => t.side === "host") ? "host" : "box";
  const traced = [...new Set(r.traces.map((t) => t.documentId))].sort();
  const problems: string[] = [];
  if (retainSide !== "host") problems.push("a finding was retained from inside a box");
  if (JSON.stringify(traced) !== JSON.stringify([...r.documentIds].sort())) {
    problems.push("the host retain traces do not cover exactly the retained documents — the retain side is unproven");
  }
  if (boxWriteCredentials.length > 0) problems.push(`memory WRITE credential(s) issued to the run: ${boxWriteCredentials.map((k) => k.tokenId).join(", ")}`);
  settle(d, "findings-retain", problems, {
    lens: input.lens,
    runId: input.runId,
    bank: r.bank,
    documentIds: r.documentIds,
    retainSide,
    retainTraces: r.traces,
    gatewayAssertion,
    // recall-only per-run keys are expected (dispatch's priming lane) and recorded, not charged
    runMemoryKeys: runKeys.map((k) => ({ tokenId: k.tokenId, verbs: k.verbs })),
    boxWriteCredentials: boxWriteCredentials.map((k) => k.tokenId),
  });
  return r;
}

/**
 * The priming-recall leg's problem assembly, with the HONEST-EMPTY ARM
 * (round-19 attempt 7, 2026-11-02): the release-wait diff was clean, the
 * hunters honestly found nothing, the round retained ZERO findings — and
 * "cites ≥1 retained finding" is UNSATISFIABLE then, the same structural
 * shape as round 18's empty review set that the scope-derivation amendment
 * fixed for the SET but not for the FINDINGS. The round trip is then proven
 * by the dispatch recall RUNNING (directive kg_context) and the bank
 * surfacing ≥1 document (the memory lane alive end to end), not by citing a
 * finding that cannot exist. With findings retained, the original two checks
 * stand unchanged.
 */
export function primingRecallProblems(input: {
  directive: string | null;
  citedRetained: readonly string[];
  recalledCount: number;
  retainedCount: number;
}): string[] {
  const problems: string[] = [];
  if (input.directive !== "kg_context") {
    problems.push(`dispatch recall directive ${input.directive ?? "absent"}, not kg_context`);
    return problems;
  }
  if (input.retainedCount === 0) {
    if (input.recalledCount === 0) {
      problems.push(
        "the round retained zero findings (a clean pin diff — the hunters honestly found nothing) and the bank surfaced nothing at all: the memory lane is unhealthy, not merely unprimed",
      );
    }
    return problems;
  }
  if (input.citedRetained.length === 0) {
    problems.push("the code run's <kg_context> cites no finding this round retained");
  }
  return problems;
}

export async function drivePrimingRecall(
  d: Z3Deps,
  input: { runId: string; requestId: string; bank: string; retainedByLens: Record<string, string[]> },
) {
  const row = d.readRecall(input.requestId);
  const gatewayAssertion = await d.gatewayAssert(input.bank);
  const recalled = row?.recalledDocumentIds ?? [];
  const retainedDocumentIds = Object.values(input.retainedByLens).flat();
  const citedRetained = recalled.filter((id) => retainedDocumentIds.includes(id));
  // Which lenses' findings the priming actually carried (the release waits for the LAST retain).
  const citedLenses = Object.entries(input.retainedByLens)
    .filter(([, ids]) => ids.some((id) => citedRetained.includes(id)))
    .map(([lens]) => lens);
  const problems = primingRecallProblems({
    directive: row?.directive ?? null,
    citedRetained,
    recalledCount: recalled.length,
    retainedCount: retainedDocumentIds.length,
  });
  settle(d, "priming-recall", problems, {
    runId: input.runId,
    requestId: input.requestId,
    directive: row?.directive ?? null,
    recalledDocumentIds: recalled,
    retainedDocumentIds,
    citedRetained,
    citedLenses,
    gatewayAssertion,
  });
}

export async function driveApprovalPark(d: Z3Deps, input: { runId: string }) {
  const observe = await d.parkForApproval(input.runId);
  if (observe.exitCode !== 0 && observe.exitCode !== 6) {
    // ONE retry, and only on TRANSIENT-class refusals: a red REVERIFY VERDICT
    // (observe exit 6, exitStatus "logic" — attempts 19-24 all exited 6) is a
    // terminal answer about the tree, not a transport flap; re-running the
    // chain doubles the flake exposure and burns ~22 min to reach the same
    // answer. The gate itself RESUMES a pausing window on the next request
    // (AC1(c)), so a retry on the transient classes cannot strand state.
    await d.sleep(10_000);
    const second = await d.parkForApproval(input.runId);
    if (second.exitCode !== 0) {
      settle(d, "approval-park", [`fleet observe failed twice: ${observe.tail.slice(0, 1200)} / ${second.tail.slice(0, 1200)}`], {
        runId: input.runId,
        status: "observe-failed",
        terminal: false,
        observeTails: [observe.tail, second.tail],
      });
    }
  }
  const r = await d.awaitResult(input.runId, "awaiting-approval");
  const problems = r.status === "awaiting-approval" && !r.terminal ? [] : [`not parked: ${r.status} terminal=${r.terminal}`];
  settle(d, "approval-park", problems, { runId: input.runId, status: r.status, terminal: r.terminal });
}

/** The CLI's last JSON stdout line (`{outcome, state, approverId, …}`), or {} when none parses. */
export function lastJson(stdout: string): Record<string, unknown> {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const v = JSON.parse(line);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* not a JSON line */
    }
  }
  return {};
}

/**
 * The human step, scripted and LABELED (DD-28.26(8)): the driver executes the
 * scrypt-gated `fleet approve` with the token on stdin; the CLI's own decided
 * answer naming the allowlisted approver is the scrypt verification witness.
 */
export async function driveApprove(d: Z3Deps, input: { runId: string }) {
  const out = await d.approve(input.runId);
  const said = lastJson(out.stdout);
  const scryptVerified = out.exitCode === 0 && said.outcome === "decided" && said.approverId === out.approverId;
  const problems: string[] = [];
  if (!scryptVerified) problems.push(`approve not verified (exit ${out.exitCode}, outcome ${String(said.outcome)})`);
  if (said.state !== "approved") problems.push(`decided state ${String(said.state)}, not approved`);
  write(d, "approve", problems, {
    runId: input.runId,
    cliExitCode: out.exitCode,
    approverId: out.approverId,
    scryptVerified,
    tokenChannel: out.tokenChannel,
    decisionSource: FLEET_APPROVE_STDIN,
    executedBy: "driver",
    scripted: true,
    decidedState: said.state ?? null,
    // the leg verdict, not the CLI's code (a 0-exit `rejected` is a red leg)
    exitCode: problems.length === 0 ? 0 : 1,
    stdoutTail: tail(d, out.stdout, 400),
    stderrTail: tail(d, out.stderr, 600),
    observability: [legLine("approve", { runId: input.runId, outcome: problems.length === 0 ? "ok" : "failed" })],
  });
  if (problems.length > 0) throw new Error(`z3 approve: ${problems.join("; ")}`);
}

export async function driveBranchAndComplete(
  d: Z3Deps,
  input: { protocolRunId: string; runId: string; fleetRunIds: readonly string[] },
) {
  const done = await d.awaitProtocolComplete(input.protocolRunId);
  const factoryResults = done.artifacts
    .filter((a) => a.kind === "factory_result")
    .map((a) => {
      try {
        const v = JSON.parse(a.content) as { runId?: unknown; status?: unknown };
        return { runId: String(v.runId ?? ""), status: String(v.status ?? "") };
      } catch {
        return { runId: "", status: "unparseable" };
      }
    });
  const branch = done.events.find((e) => e.type === "branch_taken" && e.stepId === Z3_STEP.branch);
  const verdictStatus = factoryResults.filter((r) => r.runId === input.runId).at(-1)?.status ?? null;
  const resultRunIds = factoryResults.map((r) => r.runId);
  // The witness is the case id: `approved` = a human decided at the gate;
  // `completed` would mean the code run never parked (no decision to witness).
  const caseId = branch?.data?.caseId ?? null;
  const completeStepRan = done.events.some((e) => e.type === "step_completed" && e.stepId === Z3_STEP.complete);
  const problems: string[] = [];
  if (done.runStatus !== "completed") problems.push(`protocol run ended ${done.runStatus}`);
  for (const id of input.fleetRunIds) if (!resultRunIds.includes(id)) problems.push(`no factory_result for ${id} (F-011)`);
  if (verdictStatus !== "approved") problems.push(`code run verdict ${verdictStatus}, not approved`);
  if (branch === undefined) problems.push(`no branch_taken witness on ${Z3_STEP.branch}`);
  else if (caseId !== Z3_APPROVED_CASE) problems.push(`the branch took case ${caseId}, not ${Z3_APPROVED_CASE}`);
  if (!completeStepRan) problems.push(`the ${Z3_STEP.complete} step never completed`);
  settle(d, "branch-and-complete", problems, {
    protocolRunId: input.protocolRunId,
    runId: input.runId,
    runStatus: done.runStatus,
    factoryResults,
    verdictStatus,
    branchTaken: branch === undefined ? null : { stepId: branch.stepId ?? null, caseId, summary: branch.summary ?? null },
    completeStepRan,
    eventTypes: done.events.map((e) => e.type),
    // INV-Z3-2: nothing merges in this round — a merge-shaped event is the witness it did.
    autoMerge: done.events.some((e) => /merge/i.test(e.type)),
  });
}

/** What the crash-window watcher did, with the instants that let the witness be OBSERVED (never asserted). */
export interface CrashWindowKill {
  stepId: string;
  requestId: string;
  /** Always `submitting`: the kill fires only on a fresh read showing the open window. */
  stepStatusAtKill: "submitting";
  /** Explicit witness, never a vacuous null: was the fleet run record already written when the kill landed? */
  recordAtKill: { state: "absent" } | { state: "present"; runId: string; createdAt: string };
  killedAt: string;
  /** When the round's last host retain resolved, and when the gate was released (epoch ms). */
  retainDoneAt: number;
  releasedAt: number;
  killErrors: string[];
}

/** The gate journal's verdict on one request: still-open hold, or how it ended. */
function holdState(lines: readonly { phase: string }[]): "open" | "none" | "ended" {
  if (!lines.some((l) => l.phase === "held")) return "none";
  return lines.some((l) => l.phase === "expired" || l.phase === "aborted" || l.phase === "exec") ? "ended" : "open";
}

/**
 * The crash window (SC2.6 window (a), deterministic — the hold-wrapper, not a
 * race). The round armed the fork's fleet-CLI gate, so the z3 code submit is
 * HELD before its exec while the fork has already persisted `submitting` +
 * the requestId. The watch (started at round start, concurrent with the QA
 * legs):
 *   1. waits for that fresh `submitting` read and a still-OPEN hold in the
 *      journal (held, and no expired/aborted/exec) — otherwise it ABORTS the
 *      gate and never kills;
 *   2. re-checks `stopped()` and the hold, then KILLS AT ONCE — the hold only
 *      has to span poll latency, never the QA tail;
 *   3. waits, fork DOWN, for the round's last host retain (host-side work
 *      needs no fork; the wiring serves the frozen last state meanwhile);
 *   4. releases the gate and restarts — the replay's dispatch recall sees
 *      every finding. A stopped round or a failed kill ABORTS the gate and
 *      never releases or restarts (the held submit then exits 99).
 * `heldAtKill` / `releasedAfterRetain` are derived later from the journal's
 * timestamps against `killedAt` / `retainDoneAt` (driveCrashWindowRedrive).
 */
export async function armCrashWindow(
  d: Z3Deps,
  stepId: string,
  stopped: () => boolean,
  retainDone: () => number | null,
): Promise<CrashWindowKill> {
  const standDown = (why: string): never => {
    d.crashGate.abort();
    throw new Error(`z3 crash window: ${why} — gate aborted, nothing released`);
  };
  const { requestId } = await d.awaitStepSubmitting(stepId, stopped);
  const state = () => holdState(d.crashGate.journalFor(requestId));
  // `submitting` persists BEFORE the exec (SC2.1), so the hold line can trail the state read by a beat.
  for (let i = 0; i < 50 && state() === "none" && !stopped(); i++) await d.sleep(100);
  if (stopped()) standDown("the round stopped before the kill");
  const before = state();
  if (before === "none") standDown("the wrapper journal shows no held submit (gate not in the fork's path)");
  if (before === "ended") {
    const how = d.crashGate.journalFor(requestId).map((l) => l.phase).join("→");
    standDown(`the hold already ended before the kill (${how}) — expired/aborted/exec'd, the window is closed`);
  }
  const rec = d.recordsForRequestId(requestId)[0];
  const recordAtKill: CrashWindowKill["recordAtKill"] =
    rec === undefined ? { state: "absent" } : { state: "present", runId: rec.runId, createdAt: rec.createdAt };
  const killedAt = new Date().toISOString();
  try {
    await d.killFork();
  } catch (e) {
    standDown(`the kill failed (${e instanceof Error ? e.message : String(e)}) — the held submit must not run in a live fork`);
  }
  let retainDoneAt = retainDone();
  while (retainDoneAt === null) {
    if (stopped()) standDown("the round stopped before its last retain (the fork stays down; restart it, then cancel the run)");
    await d.sleep(100);
    retainDoneAt = retainDone();
  }
  if (stopped()) standDown("the round stopped before the release");
  const releasedAt = Date.now();
  d.crashGate.release();
  const killErrors: string[] = [];
  try {
    await d.restartFork();
  } catch (e) {
    killErrors.push(`restart: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { stepId, requestId, stepStatusAtKill: "submitting", recordAtKill, killedAt, retainDoneAt, releasedAt, killErrors };
}

/** Second resolution, the wrapper's clock: an instant `at` is "not after" `t` when floor-seconds agree or precede. */
const sec = (ms: number) => Math.floor(ms / 1000) * 1000;

export async function driveCrashWindowRedrive(
  d: Z3Deps,
  input: { pre: CrashWindowKill; runId: string; requestId: string; boxCountSamples: number[] },
) {
  const records = d.recordsForRequestId(input.pre.requestId);
  const now = boxesFor(await d.inventory(), input.runId, d.readRecord(input.runId)?.vmName).length;
  const boxCountSamples = [...input.boxCountSamples, now];
  const bookings = d.ledgerBookings(input.requestId);
  const view = (r: RecordView) => ({ runId: r.runId, createdAt: r.createdAt });
  const journal = d.crashGate.journalFor(input.pre.requestId);
  const killedAtMs = Date.parse(input.pre.killedAt);
  // OBSERVED, never asserted: a hold line at/before the kill, and nothing that ended it before then.
  const heldAtKill =
    journal.some((l) => l.phase === "held" && l.at <= killedAtMs + 1000) &&
    // fail-closed at 1 s resolution: an end line in the kill's own second counts as BEFORE it
    !journal.some((l) => (l.phase === "expired" || l.phase === "aborted" || l.phase === "exec") && l.at <= killedAtMs);
  const releasedLine = journal.find((l) => l.phase === "released");
  // The replay passed the gate no earlier than the last retain (both on the wrapper's 1 s clock).
  const releasedAfterRetain = releasedLine !== undefined && releasedLine.at >= sec(input.pre.retainDoneAt);
  const holdAgeAtKillMs = (() => {
    const held = journal.find((l) => l.phase === "held");
    return held === undefined ? null : Math.max(0, killedAtMs - held.at);
  })();
  const submitExecs = journal.filter((l) => l.phase === "exec").length;
  const problems: string[] = [...input.pre.killErrors];
  if (!heldAtKill) problems.push("the journal shows no still-open hold at the kill — the kill did not land inside the window");
  if (!releasedAfterRetain) problems.push("the gate was not released after the last retain — the priming witness is a race");
  if (submitExecs !== 1) problems.push(`${submitExecs} fleet-submit execs across the kill + re-drive (exactly one required)`);
  if (input.requestId !== input.pre.requestId) problems.push("the re-drive minted a new requestId (did not reuse surviving state)");
  if (records.length !== 1 || records[0]?.runId !== input.runId) problems.push(`${records.length} run records for the requestId`);
  const at = input.pre.recordAtKill;
  const after = records[0];
  if (at.state === "present" && (after === undefined || after.runId !== at.runId || after.createdAt !== at.createdAt)) {
    problems.push("the re-drive mutated or recreated the run record");
  }
  if (at.state === "absent" && after !== undefined && Date.parse(after.createdAt) < killedAtMs) {
    problems.push("a record predating the kill was not seen at the kill — the window witness is inconsistent");
  }
  if (boxCountSamples.some((n) => n > 1)) problems.push("a second box for the runId");
  if (bookings.gateAdmissions > 1 || bookings.groupReservations > 1) problems.push("double-booked spend");
  if (bookings.gateAdmissions + bookings.groupReservations === 0) problems.push("no ledger booking for the request — spend escaped the ledger");
  settle(d, "crash-window-redrive", problems, {
    stepId: input.pre.stepId,
    runId: input.runId,
    killedAt: input.pre.killedAt,
    retainDoneAt: new Date(input.pre.retainDoneAt).toISOString(),
    releasedAt: new Date(input.pre.releasedAt).toISOString(),
    stepStatusAtKill: input.pre.stepStatusAtKill,
    heldAtKill,
    releasedAfterRetain,
    holdAgeAtKillMs,
    gateJournal: journal.map((l) => ({ phase: l.phase, at: l.at })),
    submitExecs,
    recordAtKill: at,
    requestIdBeforeKill: input.pre.requestId,
    requestIdAfterRedrive: input.requestId,
    recordsForRequestId: records.map(view),
    boxCountSamples,
    gateAdmissionsForRequest: bookings.gateAdmissions,
    groupReservationsForRequest: bookings.groupReservations,
  });
}

// ─── cleanup (INV-Z3-5: unconditional, every exit path) ──────────────────────

/**
 * Never throws: every step's failure becomes a problem, and the record lands
 * even on a failure path. Order:
 *   abort the gate (no code submit, held or later, ever execs) →
 *   disarm the schedule (it never fires again; names what it fired) →
 *   cancel every protocol run it fired (they stop submitting) →
 *   sweep a fresh state: runIds ∪ records of every requestId (in-flight
 *   submits included) → destroy → revoke-verify → allowlist restore →
 *   final inventory → re-sweep (a provision that landed late is still ours)
 *   → a second destroy over attributed leftovers.
 * Any fresh box still unattributed is a PROBLEM (never an excuse).
 */
export async function runCleanup(
  d: Z3Deps,
  input: { protocolRunId: string | null; runIds: readonly string[]; failed: boolean; startBoxes: readonly string[] | null },
): Promise<string[]> {
  const problems: string[] = [];
  const guard = async <T>(what: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      problems.push(`${what} FAILED: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };
  await guard("crash gate abort", () => d.crashGate.abort(), undefined);
  const disarm = await guard(
    "fork schedule disarm",
    () => d.disarmSchedule(),
    null as { disarmed: boolean; firedRunIds: string[]; scheduleStatus: string | null } | null,
  );
  const protocolRuns = [...new Set([...(input.protocolRunId === null ? [] : [input.protocolRunId]), ...(disarm?.firedRunIds ?? [])])];
  const protocolCancel: Array<{ protocolRunId: string; cancelled: boolean; fleetCancelled: string[]; inFlightRequestIds?: string[] }> = [];
  for (const id of protocolRuns) {
    const c = await guard(`fork protocol cancel ${id}`, () => d.cancelProtocolRun(id), null);
    if (c !== null) protocolCancel.push({ protocolRunId: id, ...c });
  }
  // In-flight submits the cancel names by requestId (their ack lands on a cancelled run and is dropped, F-004).
  const inFlight = () => protocolCancel.flatMap((c) => c.inFlightRequestIds ?? []).flatMap((req) => d.recordsForRequestId(req).map((r) => r.runId));
  const sweep = async () => [...(input.protocolRunId === null ? [] : (await protocolRunIds(d)).runIds), ...inFlight()];
  const swept = await guard("fork state sweep", sweep, [] as string[]);
  const runIds = [...new Set([...input.runIds, ...swept, ...protocolCancel.flatMap((c) => c.fleetCancelled)])];
  // Box destroy BEFORE revoke-verify: a cancel's teardown revokes too, so the
  // verify then measures the settled population.
  const destroy = await guard("box destroy", () => d.destroyBoxes(runIds), { receipts: [], problems: [] });
  const revoke = await guard("revoke-verify", () => d.revokeVerify(runIds), { receipts: [], problems: [] });
  problems.push(...destroy.problems, ...revoke.problems);
  problems.push(...(await guard("approver allowlist restore", () => d.restoreApprovers(), [] as string[])));
  const attributed = async () => {
    for (const late of await guard("fork state re-sweep", sweep, [] as string[])) if (!runIds.includes(late)) runIds.push(late);
    const boxes = await d.inventory();
    return { boxes, leftover: runIds.flatMap((id) => boxesFor(boxes, id, d.readRecord(id)?.vmName)) };
  };
  let final = await guard("final inventory", attributed, null as { boxes: string[]; leftover: string[] } | null);
  const redestroy: Record<string, unknown>[] = [];
  if (final !== null && final.leftover.length > 0) {
    const again = await guard("leftover destroy", () => d.destroyBoxes(final?.leftover ?? []), { receipts: [], problems: [] });
    redestroy.push(...again.receipts);
    final = await guard("final inventory (after leftover destroy)", attributed, null);
  }
  if (final === null) problems.push("the final box listing is unmeasured — an unmeasured fleet is never a clean one");
  else if (final.leftover.length > 0) problems.push(`boxes outlived the round: ${final.leftover.join(", ")}`);
  if (revoke.receipts.length === 0) problems.push("revoke-verify produced no receipts — an unmeasured key population is never a clean one");
  // The fork's disarm has no cross-process lock: re-read runs by scheduleId at the END,
  // cancel any fire that landed since, and flag a schedule still able to fire.
  const residue = await guard("final schedule re-check", () => d.disarmSchedule(), null);
  for (const late of (residue?.firedRunIds ?? []).filter((id) => !protocolRuns.includes(id))) {
    protocolRuns.push(late);
    const c = await guard(`late fork protocol cancel ${late}`, () => d.cancelProtocolRun(late), null);
    if (c !== null) protocolCancel.push({ protocolRunId: late, ...c });
    problems.push(`schedule fired ${late} after the first disarm — cancelled late`);
  }
  if (residue !== null && (residue.scheduleStatus === "active" || residue.scheduleStatus === "paused")) {
    problems.push(`the armed schedule is still ${residue.scheduleStatus} after cleanup — it can fire again`);
  }
  const unattributedFreshBoxes =
    final === null || input.startBoxes === null ? null : fresh(final.boxes, input.startBoxes).filter((b) => !final?.leftover.includes(b));
  if (unattributedFreshBoxes !== null && unattributedFreshBoxes.length > 0) {
    problems.push(`fresh box(es) no run of this round claims: ${unattributedFreshBoxes.join(", ")} — an unattributed box is a possible leak (keep the exe.dev account quiet during a round)`);
  }
  // Every receipt string is scrubbed + bounded before the writer sees it (raw
  // subprocess stderr is the likeliest carrier of a bare key prefix).
  const bound = (v: unknown): unknown =>
    typeof v === "string" ? tail(d, v, 600) : Array.isArray(v) ? v.map(bound) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bound(x)])) : v;
  const full = {
    failurePath: input.failed,
    protocolRunId: input.protocolRunId,
    scheduleDisarm: bound(disarm),
    scheduleResidue: bound(residue),
    protocolCancel: bound(protocolCancel),
    runIds,
    boxDestroy: bound(destroy.receipts),
    leftoverDestroy: bound(redestroy),
    revokeVerify: bound(revoke.receipts),
    leftoverBoxes: final?.leftover ?? null,
    unattributedFreshBoxes,
  };
  const legFields = () => ({
    exitCode: problems.length === 0 ? 0 : 1,
    stdoutTail: "",
    stderrTail: tail(d, problems.join("\n"), 2000),
    observability: [legLine("cleanup", { outcome: problems.length === 0 ? "ok" : "failed", failurePath: input.failed })],
  });
  try {
    writeZ3Evidence(d.sink, "cleanup", { ...full, problems: problems.map((p) => tail(d, p, 600)), ...legFields() });
  } catch (e) {
    // The one record INV-Z3-5 needs on every path: fall back to counts, exit codes and verdicts only.
    problems.push(`full cleanup record refused (${e instanceof Error ? e.message.slice(0, 200) : String(e)}) — minimal record written`);
    try {
      writeZ3Evidence(d.sink, "cleanup", {
        failurePath: input.failed,
        protocolRunId: input.protocolRunId,
        runIds,
        boxDestroy: destroy.receipts.map((r) => ({ runId: r.runId, exitCode: r.exitCode })),
        revokeVerify: revoke.receipts.map((r) => ({ phase: r.phase, ok: r.ok })),
        leftoverBoxes: final?.leftover ?? null,
        unattributedFreshBoxes,
        minimal: true,
        problems: [`${problems.length} problem(s); full record refused by the scrub`],
        ...legFields(),
        stderrTail: "",
      });
    } catch (e2) {
      problems.push(`cleanup evidence write FAILED: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }
  return problems;
}

// ─── the round ───────────────────────────────────────────────────────────────

export interface Z3RoundOutcome {
  protocolRunId: string | null;
  runIds: string[];
  failure?: unknown;
  cleanupProblems: string[];
}

/**
 * The sequence: trigger (+ the crash-window watcher, armed now) → per QA leg
 * (provision → terminal → forensics → observe → host retain) → code run
 * (watcher's kill → provision → re-drive proof → priming → park → forensics
 * → approve → observe → branch) — then the round manifest and the cleanup in
 * `finally`, failed or not. Never throws: the caller settles `failure` +
 * `cleanupProblems` together (live-harness settleRun posture).
 */
export async function runZ3Round(
  d: Z3Deps,
  plan: { runs: readonly RoundRun[]; worstCaseUsd: number; go: OperatorGo; reviewSet: readonly string[] },
): Promise<Z3RoundOutcome> {
  const runIds: string[] = [];
  const track = (id: string) => {
    if (!runIds.includes(id)) runIds.push(id);
  };
  let protocolRunId: string | null = null;
  let startBoxes: string[] | null = null;
  let failure: unknown;
  let cleanupProblems: string[] = [];
  let stopped = false;
  let watcher: Promise<CrashWindowKill> | undefined;
  try {
    startBoxes = await d.inventory();
    const code = plan.runs.find((r) => r.kind === "code");
    if (code === undefined) throw new Error("the round plan carries no code-affecting run");
    d.crashGate.arm(); // before the fire: the code submit must find the gate already armed
    const trig = await driveTrigger(d, plan, (id) => {
      protocolRunId = id;
    });
    let retainDoneAt: number | null = null;
    watcher = armCrashWindow(d, code.stepId, () => stopped, () => retainDoneAt);
    // The findings' round correlation (attempt 12, live): the dispatch recall
    // query is `${repoSlug} ${codeWorkId}` — a finding that names neither
    // ranks out of the kg_context window by construction, so every retain
    // carries the code run's own workId (read from the fork state's step
    // config, present at fire time) and the release probe recalls with THE
    // ACTUAL query, not a hand-shaped proxy.
    const codeWorkId = await d.readStepWorkId(code.stepId);
    if (codeWorkId === undefined) {
      throw new Error(`the bound run's ${code.stepId} step carries no workId in the fork state — the findings' round correlation can never match the dispatch recall query`);
    }
    watcher.catch(() => {}); // settled below; never an unhandled rejection while the QA legs run
    const retainedByLens: Record<string, string[]> = {};
    /** Per-lens baseline + runId for the observe legs, which run AFTER the code run (see below). */
    const legObserves: Array<{ lens: string; runId: string; baseline: Z3Baseline }> = [];
    let bank = "";
    for (const run of plan.runs.filter((r) => r.kind === "qa-leg")) {
      const lens = run.lens as string;
      const baseline = await snapshot(d);
      const prov = await driveKillAndProvision(d, { stepId: run.stepId, inventoryBefore: baseline.boxes, track });
      // The closure the fork's poller is waiting on: engine settle → teardown.
      // Must run BEFORE awaitResult — a pure record read cannot see terminal
      // until this closes the record (#913's live mechanism).
      const legSettle = await d.settleAndTeardown(prov.runId);
      if (legSettle.teardownExit !== 0) {
        // Evidence-first on a failed closure: forensics (carrying the settle
        // receipt) fails the leg with the teardown details NOW — a record the
        // teardown did not close may never read terminal, and a 3600s poll
        // timeout would name everything but the cause.
        await driveBoxForensics(d, { runId: prov.runId, liveBoxesForRun: prov.liveBoxesForRun, settle: legSettle });
      }
      await d.awaitResult(prov.runId, "terminal");
      await driveBoxForensics(d, { runId: prov.runId, liveBoxesForRun: prov.liveBoxesForRun, settle: legSettle });
      // NO observe await here: since the fork's #914 reorder the factory_observe
      // steps trail the CODE run, so awaiting this leg's observe before leg N+1
      // would block the closure chain while the next box runs unobserved (round
      // 11's live deadlock). The observe legs run after driveApprove below —
      // their target records are already terminal and their attribution is by
      // runId/requestId, never by wall clock.
      legObserves.push({ lens, runId: prov.runId, baseline });
      const r = await driveFindingsRetain(d, { lens, runId: prov.runId, codeWorkId });
      retainedByLens[lens] = r.documentIds;
      bank = r.bank;
    }
    // THE RELEASE WAITS FOR THE LAST RETAIN TO BE RECALLABLE (the dep's
    // own comment carries the measured evidence). The fork stays down the
    // whole wait (the watcher killed it; the gate stays armed), no spend
    // accrues, and the code submit replays fresh on restart — its dispatch
    // recall then sees the indexed findings. The release order itself is
    // unchanged: set retainDoneAt only once the bank is primed.
    const recallable = await d.waitFindingsRecallable({ bank, docIds: Object.values(retainedByLens).flat(), codeWorkId });
    if (!recallable) {
      throw new Error(
        "z3 round: the retained findings never became recallable before the release — hindsight's extraction lagged the retain API past the whole bound, and releasing would strand the code run unprimed (the priming-recall leg would red on zero citation)",
      );
    }
    retainDoneAt = Date.now(); // the watcher may now release: the replay's recall sees every finding
    const before = await d.inventory();
    const pre = await watcher;
    const prov = await driveKillAndProvision(d, { stepId: code.stepId, inventoryBefore: before, track });
    await driveCrashWindowRedrive(d, { pre, runId: prov.runId, requestId: prov.requestId, boxCountSamples: prov.boxCountSamples });
    await drivePrimingRecall(d, { runId: prov.runId, requestId: prov.requestId, bank, retainedByLens });
    await driveApprovalPark(d, { runId: prov.runId });
    await driveBoxForensics(d, { runId: prov.runId, liveBoxesForRun: prov.liveBoxesForRun });
    const codeBaseline = await snapshot(d);
    await driveApprove(d, { runId: prov.runId });
    // The QA observes now that they can settle: the fork's trailing observe
    // steps became current the moment the approval settled the code record,
    // and every QA leg's record was closed at its own leg time.
    for (const o of legObserves) {
      await driveQaRunObserve(d, { lens: o.lens, runId: o.runId, baseline: o.baseline });
    }
    await driveObserveReadOnly(d, { runId: prov.runId, baseline: codeBaseline });
    await driveBranchAndComplete(d, { protocolRunId: trig.protocolRunId, runId: prov.runId, fleetRunIds: runIds });
  } catch (e) {
    failure = e;
  } finally {
    stopped = true;
    // A still-armed watcher must stand down BEFORE cleanup: a late kill would land mid-sweep.
    if (watcher !== undefined) await watcher.catch(() => undefined);
    cleanupProblems = await runCleanup(d, { protocolRunId, runIds, failed: failure !== undefined, startBoxes });
    try {
      writeRoundManifest(d);
    } catch (e) {
      cleanupProblems.push(`round manifest write FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { protocolRunId, runIds, failure, cleanupProblems };
}

/**
 * The round manifest: every leg file this round's writer put on disk, with
 * its sha256 — committed beside the evidence so a later audit can rebuild the
 * registry (`registryFromManifest`) and refuse hand-copied or edited files.
 */
export function writeRoundManifest(d: Z3Deps): void {
  const files = Object.fromEntries([...d.sink.registry.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeZ3Evidence(d.sink, "round-manifest", {
    files,
    exitCode: 0,
    stdoutTail: "",
    stderrTail: "",
    observability: [legLine("round-manifest", { outcome: "ok", fileCount: Object.keys(files).length })],
  });
}
