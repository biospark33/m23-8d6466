/**
 * Z3 — the v6 cross-repo live exit round (Tier 2, the SC2.7 analog).
 *
 * GATING: `QDS_E2E_LIVE=1` + `QDS_E2E_TIER=2` + the substrate env names —
 * `liveGate("2")` throws otherwise, and the test is `todoIf(liveTodoOff())`
 * so factory CI sees a todo, never a live fire. `QDS_E2E_EVIDENCE_DIR` is
 * pinned by the STORY to `_bmad-output/evidence/v6-z3/`; this file asserts the
 * pin and the round's fork rev (`SWARMCLAW_FORK_REV`) before anything.
 *
 * THE GO GATES THE SPEND ITSELF: the worst case is printed and the operator
 * GO checked (scripts/z3/round-plan.ts gateFire) BEFORE the fork schedule is
 * armed; the schedule is then armed by THIS test through the committed fork
 * CLI (`arm`), with the caps of the same composition the spend line priced,
 * and the persisted read-back must carry exactly those caps — or the test
 * refuses (and cancels nothing it did not arm). The trigger leg re-checks the
 * fired run's own per-step caps against the same number.
 *
 * The round driver never submits spend: the protocol's external_job steps
 * do; the drivers observe, kill the fork mid-submit once (the crash window,
 * watched from round start), retain host-side, approve (scripted, labeled
 * `scripted: true`, token on stdin) and clean up in `finally` — fork protocol
 * cancel, a fresh sweep of every fleet run it named, box destroy, revoke-verify
 * receipts, all recorded on every path. One round deadline bounds every poll,
 * below this test's timeout minus a cleanup budget, so the `finally` runs.
 *
 * Extends live-harness.ts UNMODIFIED (liveGate, liveTodoOff, listedKeyHashes,
 * keyLeakProblems, settleRun). No fakes: every dep is the concrete wiring
 * (scripts/z3/live-round-wiring.ts). The verdict is re-derived from this
 * round's leg files on disk by scripts/z3/assertions.ts — the same functions
 * the fixture tier proves fail on bad evidence (tests/z3/).
 *
 * CRASH WINDOW (SC2.6 window (a), deterministic): the fork container's
 * SWARMCLAW_FACTORY_FLEET_CLI is the committed gate wrapper
 * /factory/scripts/z3/fleet-gate.sh. The gate is armed BEFORE the schedule
 * is, and `preflightFork()` refuses a misconfigured fork before the GO gate.
 * The fork image has no .git: the rev is SWARMCLAW_FORK_REV (required),
 * cross-checked against the image's revision label when it carries one.
 *
 * OPERATOR RUNBOOK: docs/planning/v6-crossrepo-contract.md "Z3 round record"
 * (prerequisites, image rebuild + container recreate, mount, real-cli, agent
 * token, participants, the parking manifest, env, GO, run, evidence commit).
 *
 * UPSTREAM BLOCKERS (round-plan.ts Z3_UPSTREAM_BLOCKERS): #467 (the findings
 * sidecar is merged but in-box — the image re-publish + pin adoption is owed).
 * While the list is non-empty this test refuses FIRST, by name, before the GO
 * gate, arming, or any spend; unblocking is the code change that deletes the
 * entry. #465 (findings-only runs stranding in `pausing`) is fixed host-side;
 * a QA leg reading `pausing` past PAUSING_BOUND_MS is still red with #465
 * named, as the regression alarm. `readHarvest` takes its default — the
 * harvested sidecar under RUNS_DIR.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { assertZ3Round, filesSince, readLegFiles } from "../../../scripts/z3/assertions.ts";
import { crashGate } from "../../../scripts/z3/crash-gate.ts";
import { dashStamp, type EvidenceSink } from "../../../scripts/z3/evidence.ts";
import { runZ3Round } from "../../../scripts/z3/leg-drivers.ts";
import {
  ARM_LEAD_MS,
  armedCapsProblems,
  armZ3Schedule,
  cancelForkRun,
  disarmZ3Schedule,
  preflightFork,
  preflightGateway,
  RUNS_DIR,
  Z3_FORK_STEPS_BUDGET_MS,
  Z3_LIVE_BUDGET,
  z3LiveDeps,
  z3ScheduleIds,
} from "../../../scripts/z3/live-round-wiring.ts";
import {
  codePollTimeoutFor,
  composeRound,
  consumeOperatorGo,
  deriveReviewSet,
  gateFire,
  upstreamBlockerRefusal,
  Z3_EVIDENCE_DIR,
  Z3_OPERATOR_GO_FILE,
  Z3_TEMPLATE_ID,
} from "../../../scripts/z3/round-plan.ts";
import { exeDevDriverFromEnv } from "../../../src/providers/exedev/driver.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { keyLeakProblems, listedKeyHashes, liveGate, liveTodoOff, REPO_ROOT, settleRun } from "./live-harness.ts";

// The budget arithmetic lives in live-round-wiring.ts Z3_LIVE_BUDGET (written down there and
// asserted by tests/z3/wiring.test.ts): pre-round + round + cleanup + margin = the test timeout.
const ROUND_BUDGET_MS = Z3_LIVE_BUDGET.roundMs;
const TEST_TIMEOUT_MS = Z3_LIVE_BUDGET.testTimeoutMs;

function need(name: string): string {
  const v = process.env[name]?.trim() ?? "";
  if (v === "") throw new Error(`${name} unset — the round cannot be armed without it`);
  return v;
}

describe("Z3 live Tier-2 cross-repo exit round (scheduled fire; operator GO-gated)", () => {
  test.todoIf(liveTodoOff())(
    "schedule → QA legs → observe → findings→bank→priming → kill/re-drive → park → approve → branch_taken",
    async () => {
      // The open upstream blockers refuse FIRST — before the GO gate, arming, or any spend.
      const blocked = upstreamBlockerRefusal();
      if (blocked !== "") throw new Error(blocked);
      liveGate("2");
      expect(process.env.QDS_E2E_EVIDENCE_DIR?.trim()).toBe(Z3_EVIDENCE_DIR);
      const forkRev = process.env.SWARMCLAW_FORK_REV?.trim() ?? "";
      if (!/^[0-9a-f]{7,40}$/.test(forkRev)) {
        throw new Error("SWARMCLAW_FORK_REV unset/not a rev — the round must name its fork rev (Z1 drift alarm)");
      }
      const testStart = Date.now();
      const setup = [...preflightFork(), ...(await preflightGateway(need("QDS_REPO_SLUG")))];
      if (setup.length > 0) throw new Error(`fork setup preflight failed (runbook: docs/planning/v6-crossrepo-contract.md "Z3 round record"): ${setup.join("; ")}`);
      const caps = { qaGroupCapUsd: Number(need("Z3_QA_GROUP_CAP_USD")), codeGroupCapUsd: Number(need("Z3_CODE_GROUP_CAP_USD")) };
      const runs = composeRound(caps);
      // The code run's fork deadline (z3-code-run + z3-code-observe) = the round budget minus the QA legs.
      const codePollTimeoutMs = codePollTimeoutFor(Z3_FORK_STEPS_BUDGET_MS, runs);
      // Scope-derivation amendment (2026-10-27): the review set derives from
      // the pinned sha's own diff BEFORE the GO gate — an empty set refuses
      // here, never as a red round (round 18), and the GO must name it.
      const reviewSet = deriveReviewSet(need("QDS_EXEDEV_SHA"), { cwd: REPO_ROOT });
      // Worst case printed FIRST, then the GO gate (absent/malformed/short/stale/other-rev/wrong-set refused) — all BEFORE arming.
      const goFile = path.join(REPO_ROOT, Z3_OPERATOR_GO_FILE);
      const { go, worstCaseUsd } = gateFire({ runs, goFile, forkRev, reviewSet });

      // The key population before anything this round could mint — the
      // finally's revoke-verify diffs against it (sc2-7 KEY-COUNT leg).
      const keyBaseline = await listedKeyHashes();
      const roundStart = new Date();
      // Setup checks FIRST, so a setup refusal never burns the GO:
      crashGate().arm(); // refuses an unconfigured gate BEFORE any schedule exists
      const preArmIds = z3ScheduleIds(); // an arm failure sweeps every z3 schedule not in this snapshot
      // One GO per round: it is CONSUMED here (moved to <stamp>-operator-GO.consumed.json) — a re-run finds none.
      consumeOperatorGo(goFile, dashStamp(roundStart));
      let armed: { scheduleId: string; protocolConfig: Record<string, unknown> } | undefined;
      // Longer than the arm's own timeout: a timed-out arm is swept before its schedule can fire.
      const runAt = Date.now() + ARM_LEAD_MS;
      let roundOwnsCleanup = false;
      try {
        armed = armZ3Schedule({
          config: {
            templateId: Z3_TEMPLATE_ID,
            repoSlug: need("QDS_REPO_SLUG"),
            commitSha: need("QDS_EXEDEV_SHA"),
            ...caps,
            codePollTimeoutMs,
            codeManifestPath: need("Z3_CODE_MANIFEST_PATH"),
            codeInstructions: need("Z3_CODE_INSTRUCTIONS"),
            reviewSet,
          },
          participants: need("Z3_PARTICIPANTS"),
          sessionId: process.env.Z3_SESSION_ID?.trim() || undefined,
          runAt,
        }, preArmIds);
        const capProblems = armedCapsProblems(armed.protocolConfig, { ...caps, codePollTimeoutMs, reviewSet });
        if (capProblems.length > 0) {
          throw new Error(`the armed schedule ${armed.scheduleId} does not carry the GO-gated config (${capProblems.join("; ")}) — refused; the finally disarms it`);
        }

        const sink: EvidenceSink = {
          outDir: path.join(REPO_ROOT, Z3_EVIDENCE_DIR),
          forkRev,
          registry: new Map(),
          knownSecrets: ["OPENROUTER_PROVISIONING_KEY", "Z3_MEMGATE_AGENT_TOKEN", "HINDSIGHT_BEARER_TOKEN", "HINDSIGHT_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"]
            .map((n) => process.env[n] ?? "")
            .filter((v) => v.length >= 8),
        };
        const deps = z3LiveDeps({
          sink,
          scheduleId: armed.scheduleId,
          // from TEST START: pre-round time is spent out of the same wall clock
          deadline: testStart + Z3_LIVE_BUDGET.preRoundMs + ROUND_BUDGET_MS,
          runAt,
          providerKeyHashes: async () => [...(await listedKeyHashes())],
          revokeVerify: async (runIds) => {
            const receipts: Record<string, unknown>[] = [];
            const problems = await keyLeakProblems(
              keyBaseline,
              {
                driver: exeDevDriverFromEnv(),
                store: runIds.length === 0 ? undefined : new RunRecordStore({ dir: RUNS_DIR, create: false }),
                runIds,
              },
              receipts,
            );
            return { receipts, problems };
          },
        });

        roundOwnsCleanup = true; // from here runZ3Round's finally disarms, cancels, sweeps
        const outcome = await runZ3Round(deps, { runs, worstCaseUsd, go, reviewSet });

        // This round's window of the (accumulating) dir — unregistered files in it are REPORTED, never filtered out.
        const files = filesSince(readLegFiles(sink.outDir), roundStart);
        const problems = assertZ3Round(files, {
          forkRev,
          registry: sink.registry,
          roundFailed: outcome.failure !== undefined,
          knownSecrets: sink.knownSecrets,
        });
        // A held leg failure is re-thrown WITH the cleanup + verdict problems attached (never masked by them).
        settleRun(outcome.failure, [...outcome.cleanupProblems, ...problems]);
      } catch (original) {
        if (roundOwnsCleanup) throw original;
        // Every path after arming disarms: abort the gate, disarm the schedule, cancel EVERY run it
        // fired — each step guarded, none skipped, the original error kept as the cause.
        const errors: unknown[] = [];
        const guard = (fn: () => void) => {
          try {
            fn();
          } catch (e) {
            errors.push(e);
          }
        };
        guard(() => crashGate().abort());
        if (armed !== undefined) {
          const id = armed.scheduleId;
          let fired: string[] = [];
          guard(() => {
            fired = disarmZ3Schedule(id).firedRunIds;
          });
          for (const run of fired) guard(() => cancelForkRun(run));
        }
        if (errors.length === 0) throw original;
        throw new AggregateError([original, ...errors], `round refused before it began, and ${errors.length} cleanup step(s) failed`, { cause: original });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
