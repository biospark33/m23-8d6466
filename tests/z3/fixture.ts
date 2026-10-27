/**
 * Z3 fixture world — an in-memory substrate the REAL leg drivers run against
 * (no network, no spend, no fork). A green round here is the positive
 * control for every AC; each negative control either overrides one dep (the
 * substrate misbehaves) or edits one landed file (the evidence lies).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLegFiles, type LegFile } from "../../scripts/z3/assertions.ts";
import type { CrashGate, GateLine } from "../../scripts/z3/crash-gate.ts";
import { type MemoryKeyRow, runZ3Round, type RecordView, type Z3Deps, type Z3RoundOutcome } from "../../scripts/z3/leg-drivers.ts";
import { composeRound, type OperatorGo, worstCaseSpendUsd, Z3_STEP, Z3_WORK_ID } from "../../scripts/z3/round-plan.ts";
import { QA_LENS } from "../../src/qa/findings.ts";

export const REV = "0123456789abcdef0123456789abcdef01234567";
export const AGENT_TOKEN_ID = `mgat-${"ab".repeat(12)}`;
export const APPROVER_ID = "z3-e2e-approver";
export const CODE_RUN_ID = "qds-20261019-c0de01";
/** One protocol fire's workId stamp (fork: `w:qa-<stamp>-<lens>` / `w:z3-<stamp>-code`). */
export const STAMP = "20261019T120000Z";
export const qaRunId = (i: number) => `qds-20261019-a0000${i + 1}`;
export const docId = (i: number) => `qds-20261019-d0c00${i + 1}`;

export const GO: OperatorGo = {
  who: "operator (fixture)",
  when: "2026-10-19T12:00:00Z",
  spendApproved: { worstCaseUsd: 100 },
  swarmclawForkRev: REV,
};

/** The fixture round's pinned review set (the amendment's derived round input). */
export const REVIEW_SET = ["scripts/z3/round-plan.ts", "tests/z3/fixture.ts"];

/** Lens → roster index (exported for test overrides that rebuild retained ids). */
export const lensIndex = (lens: string) => QA_LENS.indexOf(lens as (typeof QA_LENS)[number]);

export interface FixtureWorld {
  deps: Z3Deps;
  calls: {
    killed: number;
    restarted: number;
    destroyed: string[][];
    revoked: string[][];
    cancelled: string[];
    disarmed: number;
    order: string[];
  };
  boxes: Set<string>;
  gate: { armed: boolean; released: boolean; aborted: boolean; journal: GateLine[] };
}

/**
 * A coherent, green substrate that behaves like the real fork: it chains
 * steps WITHOUT waiting for the driver — when a QA observe completes, the
 * next leg is already provisioned (box + provider key + per-run recall key),
 * and the last observe opens the code run's submit window. `overrides` swaps
 * individual deps.
 */
export interface FixtureOptions {
  /**
   * The fork-ahead leg's record is not written yet when observe reads (box +
   * key already exist, factoryState carries only its requestId): attribution
   * must wait for the in-flight submit to ack (each driver sleep acks it).
   */
  recordLag?: boolean;
  /** The last lens's host retain takes this long (real wall clock) — the kill must not wait for it. */
  slowLastRetainMs?: number;
  /**
   * The observe legs plant a fresh box nothing claims — the fail-closed charge
   * (AC6) must red wherever the observe runs; since #914's reorder that is
   * post-approve, with every sibling submit long settled.
   */
  strayBoxAtObserve?: boolean;
}

export function fixtureWorld(outDir: string, overrides: Partial<Z3Deps> = {}, opts: FixtureOptions = {}): FixtureWorld {
  let clock = Date.parse("2026-10-19T12:00:00.000Z");
  const boxes = new Set<string>(["unrelated-operator-box"]);
  const liveKeys = new Set<string>(["hash-preexisting"]);
  const memory: MemoryKeyRow[] = [{ tokenId: AGENT_TOKEN_ID, kind: "agent", runId: null, verbs: ["recall", "retain"] }];
  const records = new Map<string, RecordView>();
  /** runIds the fork's factoryState names (set on the submit ACK, not before). */
  const acked = new Set<string>();
  /** records not yet visible (opts.recordLag) — the in-flight window. */
  const hidden = new Set<string>();
  /** runIds whose fleet record settleAndTeardown has closed (the only source of a terminal read). */
  const closed = new Set<string>();
  const retainedSoFar: string[] = [];
  let recallDocs: string[] = [];
  const calls = {
    killed: 0,
    restarted: 0,
    destroyed: [] as string[][],
    revoked: [] as string[][],
    cancelled: [] as string[],
    disarmed: 0,
    /** kill / retain:<lens> / release, in the order they happened */
    order: [] as string[],
  };
  let codeWindowOpen = false;
  /** Flipped by the approve dep: the round-11 ordering pin (observes trail the approval). */
  let approvalSettled = false;
  // The fork container's fleet-gate wrapper, as the driver sees it (journal + arm/release/abort).
  const gateState = { armed: false, released: false, aborted: false, journal: [] as GateLine[] };
  const crashGateFake: CrashGate = {
    arm: () => {
      gateState.armed = true;
    },
    release: () => {
      calls.order.push("release");
      gateState.released = true;
      recallDocs = [...retainedSoFar]; // the replay's dispatch recall sees what was retained BY NOW
    },
    abort: () => {
      gateState.aborted = true;
    },
    journalFor: (requestId) => gateState.journal.filter((l) => l.requestId === requestId),
  };
  // The replay's lines land at least a restart + a poller tick after the kill (live: minutes), so
  // `released`/`exec` are stamped 2 s on; the wrapper's 1 s clock is honoured (floored), as live.
  const gateLine = (phase: GateLine["phase"]) =>
    gateState.journal.push({
      verb: "submit",
      requestId: `req-${Z3_STEP.codeRun}`,
      workId: `w:z3-${STAMP}-code`,
      phase,
      at: Math.floor((Date.now() + (phase === "held" ? 0 : 2000)) / 1000) * 1000,
    });
  const openCodeWindow = () => {
    codeWindowOpen = true;
  };
  const stepRun = (stepId: string): string => {
    if (stepId === Z3_STEP.codeRun || stepId === Z3_STEP.codeObserve) return CODE_RUN_ID;
    const i = QA_LENS.findIndex((l) => stepId === Z3_STEP.qaLeg(l) || stepId === Z3_STEP.qaObserve(l));
    if (i < 0) throw new Error(`fixture: unknown step ${stepId}`);
    return qaRunId(i);
  };
  const provision = (stepId: string, ahead = false) => {
    const runId = stepRun(stepId);
    if (records.has(runId)) return runId;
    if (ahead && opts.recordLag) hidden.add(runId);
    records.set(runId, { runId, createdAt: new Date().toISOString(), requestId: `req-${stepId}`, vmName: runId, keyHash: `key-${runId}` });
    boxes.add(runId);
    liveKeys.add(`key-${runId}`);
    memory.push({ tokenId: `mgrunid-${runId}`, kind: "per-run", runId, verbs: ["recall"] });
    return runId;
  };
  const teardown = (runId: string) => {
    boxes.delete(runId);
    liveKeys.delete(`key-${runId}`);
  };
  const deps: Z3Deps = {
    sink: {
      outDir,
      forkRev: REV,
      registry: new Map(),
      now: () => {
        clock += 1000;
        return new Date(clock);
      },
    },
    awaitTrigger: async () => ({
      protocolRunId: "pr-z3-1",
      scheduleId: "sch-z3",
      templateId: "z3_exit_round",
      firedAt: "2026-10-19T12:00:00.000Z",
      stepCaps: [...QA_LENS.map((l) => ({ stepId: Z3_STEP.qaLeg(l), groupCapUsd: 6 })), { stepId: Z3_STEP.codeRun, groupCapUsd: 8 }],
      qaLegReviewSets: QA_LENS.map((l) => ({ stepId: Z3_STEP.qaLeg(l), reviewSet: REVIEW_SET })),
      forkRev: REV,
    }),
    awaitStepSubmitting: async (stepId, stopped) => {
      // polls like the live watcher: stands down the moment the round stops
      while (!codeWindowOpen) {
        if (stopped()) throw new Error("watcher stopped");
        await new Promise((r) => setTimeout(r, 1));
      }
      if (gateState.armed && !gateState.journal.some((l) => l.phase === "held")) gateLine("held");
      return { requestId: `req-${stepId}` };
    },
    awaitStepSubmitted: async (stepId) => {
      // the replay passes the released gate: exactly one exec for the code request
      if (stepId === Z3_STEP.codeRun && !records.has(CODE_RUN_ID)) {
        if (gateState.armed && (gateState.aborted || !gateState.released)) throw new Error("fixture: code submit still held");
        gateLine("released");
        gateLine("exec");
      }
      const runId = provision(stepId);
      hidden.delete(runId);
      acked.add(runId);
      const workId = stepId === Z3_STEP.codeRun ? `w:z3-${STAMP}-code` : Z3_WORK_ID.qa(STAMP, stepId.replace(/^qa-leg-/, ""));
      return { runId, workId, requestId: `req-${stepId}`, lastError: null };
    },
    awaitObserveStep: async (stepId) => {
      // #914's template: the observes trail the code run, so by the time the
      // driver awaits one (post-approve) its target record is long terminal.
      // The guard pins the ORDER: an observe read before the approval is the
      // round-11 deadlock back, and must fail the fixture loudly.
      if (!approvalSettled) throw new Error(`fixture: QA observe before code approval (${stepId})`);
      if (opts.strayBoxAtObserve) boxes.add("stray-observe-box");
      return { kind: "factory_observe", status: "completed", observedRunId: stepRun(stepId) };
    },
    protocolFleet: async () => ({
      runIds: [...acked],
      requestIds: [...records.values()].map((r) => r.requestId as string),
      submitting: [...records.keys()].filter((id) => !acked.has(id)),
    }),
    disarmSchedule: async () => {
      calls.disarmed++;
      return { disarmed: true, firedRunIds: ["pr-z3-1"], scheduleStatus: "archived" };
    },
    cancelProtocolRun: async (id) => {
      calls.cancelled.push(id);
      return { cancelled: true, fleetCancelled: [] };
    },
    crashGate: crashGateFake,
    killFork: async () => {
      calls.order.push("kill");
      calls.killed++;
    },
    restartFork: async () => {
      calls.restarted++;
    },
    awaitResult: async (runId, want) => {
      if (want === "awaiting-approval") {
        teardown(runId); // preserved: the approval-park read still models the gate chain's reaping
        return { status: "awaiting-approval", terminal: false };
      }
      // Terminal reads true ONLY once settleAndTeardown's teardown has closed
      // the record — a pure record read cannot see terminal on its own (the
      // #913 mechanism the live wiring now closes explicitly).
      if (!closed.has(runId)) throw new Error(`fixture: awaitResult(terminal) before settleAndTeardown closed ${runId}`);
      return { status: "completed", terminal: true };
    },
    settleAndTeardown: async (runId) => {
      // The A2 cadence pair, modeled: the settle-then-teardown CLOSES the
      // leg's record — the transition awaitResult(terminal) then observes —
      // and the moment the record closes the fork chains forward (#914's
      // back-to-back legs): the next leg submits (or, after the last QA leg,
      // the code run's submit window opens).
      teardown(runId);
      closed.add(runId);
      const i = QA_LENS.findIndex((l) => qaRunId(lensIndex(l)) === runId);
      const next = QA_LENS[i + 1];
      if (i >= 0 && next !== undefined) provision(Z3_STEP.qaLeg(next), true);
      if (i === QA_LENS.length - 1) openCodeWindow();
      return { state: "ok", teardownExit: 0, teardownTail: "teardown ok" };
    },
    inventory: async () => [...boxes],
    readRecord: (runId) => (hidden.has(runId) ? null : (records.get(runId) ?? null)),
    recordsForRequestId: (requestId) => [...records.values()].filter((r) => r.requestId === requestId && !hidden.has(r.runId)),
    ledgerBookings: () => ({ gateAdmissions: 1, groupReservations: 1 }),
    providerKeyHashes: async () => [...liveKeys],
    memoryKeys: () => [...memory],
    retainFindings: async (lens) => {
      if (opts.slowLastRetainMs !== undefined && lens === QA_LENS[QA_LENS.length - 1]) {
        await new Promise((r) => setTimeout(r, opts.slowLastRetainMs));
      }
      calls.order.push(`retain:${lens}`);
      retainedSoFar.push(docId(lensIndex(lens)));
      return { bank: "qds-factory", documentIds: [docId(lensIndex(lens))], traces: [{ side: "host", documentId: docId(lensIndex(lens)) }] };
    },
    gatewayAssert: async () => ({ origin: "http://127.0.0.1:18892", agentTokenId: AGENT_TOKEN_ID }),
    readRecall: () => ({ directive: "kg_context", recalledDocumentIds: [...recallDocs, "qds-20261019-ffffff"] }),
    approve: async (runId) => {
      approvalSettled = true; // the ordering pin: the QA observes may only read after this
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ runId, outcome: "decided", state: "approved", approverId: APPROVER_ID })}\n`,
        stderr: "",
        approverId: APPROVER_ID,
        tokenChannel: "stdin",
      };
    },
    awaitProtocolComplete: async () => ({
      runStatus: "completed",
      artifacts: [
        ...QA_LENS.map((_, i) => ({ kind: "factory_result", content: JSON.stringify({ runId: qaRunId(i), status: "completed" }) })),
        { kind: "factory_result", content: JSON.stringify({ runId: CODE_RUN_ID, status: "approved" }) },
      ],
      events: [
        { type: "created" },
        { type: "branch_taken", stepId: Z3_STEP.branch, summary: "Branch selected case approved.", data: { caseId: "approved" } },
        { type: "step_completed", stepId: Z3_STEP.complete },
        { type: "completed" },
      ],
    }),
    revokeVerify: async (runIds) => {
      calls.revoked.push([...runIds]);
      return { receipts: [{ phase: "key-hash-delta", ok: true, leaked: [] }], problems: [] };
    },
    destroyBoxes: async (runIds) => {
      calls.destroyed.push([...runIds]);
      for (const id of runIds) teardown(id);
      return { receipts: runIds.map((runId) => ({ runId, exitCode: 0 })), problems: [] };
    },
    restoreApprovers: () => [],
    // every driver sleep lets an in-flight submit ack (the record becomes visible)
    autoMergePolicy: () => ({ state: "absent" }),
    sleep: async () => {
      hidden.clear();
      await new Promise((r) => setTimeout(r, 0)); // yield a macrotask, as a real sleep does (no microtask spin)
    },
    ...overrides,
  };
  return { deps, calls, boxes, gate: gateState };
}

export interface FixtureRound {
  dir: string;
  outcome: Z3RoundOutcome;
  files: LegFile[];
  registry: Map<string, string>;
  world: FixtureWorld;
}

/** Drives the real round over the fixture world; caller rmSync's `dir`. */
export async function driveFixtureRound(overrides: Partial<Z3Deps> = {}, opts: FixtureOptions = {}): Promise<FixtureRound> {
  const dir = mkdtempSync(join(tmpdir(), "z3-round-"));
  const world = fixtureWorld(dir, overrides, opts);
  const runs = composeRound({ qaGroupCapUsd: 6, codeGroupCapUsd: 8 });
  const outcome = await runZ3Round(world.deps, { runs, worstCaseUsd: worstCaseSpendUsd(runs), go: GO, reviewSet: REVIEW_SET });
  return { dir, outcome, files: readLegFiles(dir), registry: world.deps.sink.registry, world };
}

export function cleanupFixture(r: FixtureRound): void {
  rmSync(r.dir, { recursive: true, force: true });
}

/** Rewrites the n-th file of `leg` with `fn` applied to its JSON (the bytes now differ from the registry). */
export function editLeg(files: LegFile[], leg: string, fn: (j: Record<string, unknown>) => void, n = 0): LegFile[] {
  let seen = 0;
  return files.map((f) => {
    if (!f.name.endsWith(`-z3-${leg}.json`) || seen++ !== n) return f;
    const j = JSON.parse(f.text) as Record<string, unknown>;
    fn(j);
    return { name: f.name, text: `${JSON.stringify(j, null, 2)}\n` };
  });
}

export const dropLeg = (files: LegFile[], leg: string) => files.filter((f) => !f.name.endsWith(`-z3-${leg}.json`));

