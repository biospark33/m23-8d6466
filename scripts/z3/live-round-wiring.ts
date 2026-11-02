/**
 * Z3 live wiring — the concrete substrate behind `Z3Deps` for the live round
 * (tests/fleet/e2e/z3-exit-round.live.test.ts). Mirrors
 * scripts/qa/live-round-wiring.ts, but every fork read goes through the
 * COMMITTED fork CLI `scripts/solstice/z3-exit-round.ts` (fork counterpart), run
 * with `docker exec -w /app <Z3_FORK_CONTAINER> npx tsx <Z3_FORK_CLI> …`. Each
 * subcommand prints ONE JSON line on stdout (exit 1 + stderr on error):
 *
 *   arm --config '<json>' --participants <ids> [--session <id>] [--run-at <ms>]
 *        → {scheduleId, protocolConfig}  (persisted read-back; unknown participants refused)
 *   state → {schedules, runs:[{id, templateId, scheduleId, createdAt:<epoch ms>,
 *            status, steps, factoryState, events:[{type, stepId?, data?, at:<epoch ms>}]}],
 *            writtenAt}  (z3_exit_round runs only, events joined in)
 *   cancel <protocolRunId> → {cancelled, fleetCancelled, inFlightRequestIds}
 *            (exit-checked `fleet cancel` of the outstanding external_job runIds;
 *            in-flight submits named by requestId; observe entries untouched)
 *   disarm <scheduleId> → {disarmed, firedRunId|null}  (archive + 3 s recheck;
 *            a run already fired is reported, never cancelled — cancel it)
 * `state` runs carry exactly: artifacts, createdAt, events (with `summary`),
 * factoryState, id, scheduleId, status, steps, templateId.
 *
 * The crash window is the factory-side fleet-CLI gate (scripts/z3/fleet-gate.sh
 * as the container's SWARMCLAW_FACTORY_FLEET_CLI; setup in crash-gate.ts).
 * The fork image carries no .git, so the fork rev is the operator's
 * SWARMCLAW_FORK_REV, cross-checked against the image's
 * `org.opencontainers.image.revision` label when the image carries one.
 *
 * Every `state` read is a FRESH exec (no dump file to go stale), zod-parsed so
 * a shape drift fails loudly instead of waiting out a deadline. The round
 * binds the ONE run its own armed schedule fired, by scheduleId, and every
 * later read filters on that protocolRunId — never "the newest z3 run".
 *
 * One round deadline bounds every poll (the live test keeps it under its own
 * timeout minus a cleanup budget, so the `finally` always runs).
 *
 * Fleet: `bun scripts/fleet.ts result|approve|cancel` from the repo root against
 * ONE resolved runs dir. The fork's fleet child runs with NO cwd of its own
 * (execFile in /app) and an env allowlist that strips QDS_RUNS_DIR, so the
 * real-cli shim the gate wrapper execs must `cd` into the /factory clone and
 * use this same runs dir — the runbook (docs/planning/v6-crossrepo-contract.md
 * "Z3 round record") says so; otherwise records/ledger/recall read as absent.
 * Boxes: `ssh exe.dev ls --json`. Memory: A2's host-side
 * `retainFindings` over a journaling factory-host HindsightClient (its own
 * calls ARE the host-side traces); the bank resolves exactly as dispatch's
 * recall does. Provider-key listing / revoke-verify ride live-harness.ts and
 * are passed in by the live test — scripts never import the test harness.
 */
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { log } from "../../src/lib/log.ts";

import { scryptToken, SCRYPT_PARAMS } from "../../src/fleet/approvers.ts";
import type { ResultPayload } from "../../src/fleet/result.ts";
import { extractExistingBankIds, resolveProvisionedRepoBankId } from "../../src/hindsight/bank-provisioner.ts";
import { HindsightClient } from "../../src/hindsight/client.ts";
import { DEFAULT_RECALL_DIR } from "../../src/hindsight/kg-context.ts";
import { resolveBankId } from "../../src/hindsight/schemas.ts";
import { DEFAULT_MEMGATE_LEDGER } from "../../src/memgate/schemas.ts";
import { readAutoMergePolicy } from "../../src/fleet/auto-merge-policy.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { normalizeHarvest } from "../../src/qa/findings.ts";
import { harvestForLens } from "../../src/qa/harvested-findings.ts";
import { retainFindings } from "../../src/qa/retain.ts";
import { costLedgerOpts } from "../lib/cost-ledger-opts.ts";
import { crashGate } from "./crash-gate.ts";
import type { EvidenceSink } from "./evidence.ts";
import type { MemoryKeyRow, RecordView, Z3Deps } from "./leg-drivers.ts";
import { Z3_TEMPLATE_ID } from "./round-plan.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
/** ONE runs dir, absolute, for the store, the ledger, the allowlist and every `--dir`. */
export const RUNS_DIR = path.resolve(REPO_ROOT, process.env.QDS_RUNS_DIR ?? ".sandbox/runs");
const FORK_CONTAINER = process.env.Z3_FORK_CONTAINER ?? "swarmclaw-swarmclaw-1";
/** The fork CLI's path INSIDE the container (fork counterpart `scripts/solstice/z3-exit-round.ts`). */
const FORK_CLI = process.env.Z3_FORK_CLI ?? "scripts/solstice/z3-exit-round.ts";
const FORK_WORKDIR = process.env.Z3_FORK_WORKDIR ?? "/app";
const APPROVER_ID = "z3-e2e-approver";
const GATE_WRAPPER_IN_CONTAINER = "/factory/scripts/z3/fleet-gate.sh";
const POLL_MS = 10_000;
/** A fork that answers no `state` for this long is down, not slow (the crash-window restart takes seconds). */
const STATE_OUTAGE_MS = 180_000;

// ─── the fork CLI contract (zod — a shape drift fails loudly) ───────────────

const FactoryEntrySchema = z
  .object({
    status: z.string().optional(),
    runId: z.string().nullish(),
    requestId: z.string().nullish(),
    lastError: z.string().nullish(),
  })
  .passthrough();
const StepSchema = z
  .object({
    id: z.string(),
    kind: z.string().optional(),
    externalJobConfig: z
      .object({
        workId: z.string().optional(),
        groupCapUsd: z.number().optional(),
        commitSha: z.string().optional(),
        repoSlug: z.string().optional(),
        // The scope-derivation amendment's pinned set, read back off the fired run.
        reviewSet: z.array(z.string()).nullish(),
      })
      .passthrough()
      .optional(),
    factoryObserveConfig: z.object({ fromStepOutput: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
const EventSchema = z
  .object({
    type: z.string(),
    stepId: z.string().nullish(),
    summary: z.string().nullish(),
    data: z.object({ caseId: z.string().optional() }).passthrough().nullish(),
    at: z.number().optional(),
  })
  .passthrough();
const RunSchema = z
  .object({
    id: z.string(),
    templateId: z.string().nullish(),
    scheduleId: z.string().nullish(),
    createdAt: z.number(),
    status: z.string(),
    // REQUIRED, no defaults: a fork that drops a contract field is an error, never an empty list.
    steps: z.array(StepSchema),
    factoryState: z.record(FactoryEntrySchema),
    events: z.array(EventSchema),
    artifacts: z.array(z.object({ kind: z.string(), content: z.string() }).passthrough()),
  })
  .passthrough();
export const ForkStateSchema = z
  .object({
    schedules: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
    runs: z.array(RunSchema),
    writtenAt: z.union([z.number(), z.string()]),
  })
  .passthrough();
export type ForkState = z.infer<typeof ForkStateSchema>;
type Run = ForkState["runs"][number];

const ArmSchema = z.object({ scheduleId: z.string().min(1), protocolConfig: z.record(z.unknown()) }).passthrough();
const CancelSchema = z
  .object({ cancelled: z.boolean(), fleetCancelled: z.array(z.string()), inFlightRequestIds: z.array(z.string()) })
  .passthrough();
const DisarmSchema = z.object({ disarmed: z.boolean(), firedRunId: z.string().nullable() }).passthrough();

/**
 * The fork's reported worst case for `cancel` (scripts/solstice/z3-exit-round.ts
 * header): ≤ 1 outstanding submit × 300 s + one 300 s parallel verify = 660 s,
 * plus tsx boot — 13 min leaves the boot margin (fork floor: ≥ 660_000).
 */
export const FORK_CANCEL_TIMEOUT_MS = 2 * 300_000 + 180_000;

/**
 * A QA leg reading `pausing` this long is stranded, not slow: since #465 a
 * GREEN findings-only leg settles `completed`, so a lingering pause is a
 * vetoed leg (failed hunt, lost harvest, a commit) or a #465 regression.
 */
export const PAUSING_BOUND_MS = 20 * 60_000;

/** Every other fork CLI call (`state`, a `disarm` — archive + 3 s recheck + tsx boot). */
export const FORK_CLI_TIMEOUT_MS = 120_000;
export const FORK_DISARM_TIMEOUT_MS = 180_000;
/** `arm` gets its own ceiling, and the schedule's runAt lead is LONGER, so a timed-out arm can be swept before it fires. */
export const FORK_ARM_TIMEOUT_MS = 240_000;
/** Covers: the arm's timeout, the first sweep, the kill margin, the second sweep (state + disarm + a cancel). */
export const ARM_LEAD_MS = FORK_ARM_TIMEOUT_MS + 15_000 + 300_000;
/** Each `bun scripts/fleet.ts` call (destroys run in parallel, so one ceiling covers a whole destroy pass). */
export const FLEET_CLI_TIMEOUT_MS = 300_000;
/**
 * The pre-round work before the round's own polls start: preflight (≈8 calls
 * at 60 s + one state read), key list, gateway probe, the arm, and the
 * ARM_LEAD_MS wait until the schedule fires (the arm's own timeout is inside it).
 */
const PRE_ROUND_MS = 8 * 60_000 + FORK_CLI_TIMEOUT_MS + 2 * 60_000 + 60_000 + ARM_LEAD_MS;

/**
 * The cleanup's worst case, step by step, from the timeouts actually configured
 * above (runCleanup's order). Cancels: ≤ 2 protocol runs (bound + one the
 * disarm race let through); destroys run in PARALLEL (one fleet ceiling per pass).
 */
export const Z3_CLEANUP_STEPS_MS = {
  disarm: FORK_DISARM_TIMEOUT_MS + FORK_CLI_TIMEOUT_MS, // disarm + its state re-read
  protocolCancels: 2 * FORK_CANCEL_TIMEOUT_MS,
  sweep: STATE_OUTAGE_MS + FORK_CLI_TIMEOUT_MS, // state() retries + one read
  destroy: FLEET_CLI_TIMEOUT_MS,
  revokeVerify: 5 * 60_000, // two provider key listings + the fallback revokes
  finalInventory: 60_000 + STATE_OUTAGE_MS + FORK_CLI_TIMEOUT_MS, // ssh ls + re-sweep
  leftoverDestroy: FLEET_CLI_TIMEOUT_MS,
  finalInventoryAgain: 60_000 + STATE_OUTAGE_MS + FORK_CLI_TIMEOUT_MS,
  residueRecheck: FORK_DISARM_TIMEOUT_MS + FORK_CLI_TIMEOUT_MS,
  lateCancel: FORK_CANCEL_TIMEOUT_MS,
  // the crash watcher standing down before cleanup: one state() outage, or a `docker start`
  watcherStandDown: STATE_OUTAGE_MS + FORK_CLI_TIMEOUT_MS,
} as const;

/** The fork's own step deadlines for one round (3 QA legs × 1 h + the 2 h code run) — what codePollTimeoutFor divides. */
export const Z3_FORK_STEPS_BUDGET_MS = 300 * 60_000;
/** Fork heartbeat latency between chained steps (≈ 60 s × 10 steps) — round slack beyond the fork deadlines. */
export const Z3_ROUND_SLACK_MS = 10 * 60_000;

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

/**
 * The live round's budget, written down (E-4):
 *   round   = 300 min fork step deadlines (3 QA legs × 1 h + the 2 h code run,
 *             codePollTimeoutFor) + 10 min fork-heartbeat slack
 *   cleanup = ⌈Σ Z3_CLEANUP_STEPS_MS⌉ to the minute (≈ 86 min, watcher stand-down included)
 *   pre     = preflight + key list + gateway probe + arm lead (≈ 21 min)
 *   test    = pre + round + cleanup + 10 min margin
 * The cleanup runs on its OWN deadline (round deadline + cleanup), so a round
 * that overran still gets the whole cleanup budget.
 */
export const Z3_LIVE_BUDGET = (() => {
  const roundMs = Z3_FORK_STEPS_BUDGET_MS + Z3_ROUND_SLACK_MS;
  const cleanupMs = Math.ceil(sum(Z3_CLEANUP_STEPS_MS) / 60_000) * 60_000;
  const marginMs = 10 * 60_000;
  return { preRoundMs: PRE_ROUND_MS, roundMs, cleanupMs, marginMs, testTimeoutMs: PRE_ROUND_MS + roundMs + cleanupMs + marginMs };
})();

/** The fork CLI call shape (injectable so the arm-sweep logic is testable without docker). */
export type ForkCli = (args: string[], timeoutMs?: number) => unknown;

/** The in-container process is KILLed this long before the host gives up on `docker exec`. */
export const IN_CONTAINER_KILL_MARGIN_MS = 15_000;

/**
 * Runs the fork CLI; returns its ONE JSON stdout line. Throws on a non-zero exit or no JSON.
 * Killing the host-side `docker exec` client does NOT kill the in-container
 * process, so the command itself runs under coreutils `timeout -s KILL`,
 * bounded IN_CONTAINER_KILL_MARGIN_MS below the host timeout: when the host
 * times out, the in-container CLI is already dead (preflight refuses an
 * image without `timeout`).
 */
function forkCli(args: string[], timeoutMs = FORK_CLI_TIMEOUT_MS): unknown {
  const inner = String(Math.max(5, Math.floor((timeoutMs - IN_CONTAINER_KILL_MARGIN_MS) / 1000)));
  const proc = Bun.spawnSync(["docker", "exec", "-w", FORK_WORKDIR, FORK_CONTAINER, "timeout", "-s", "KILL", inner, "npx", "tsx", FORK_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const out = proc.stdout.toString();
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (proc.exitCode !== 0 || line === undefined) {
    throw new Error(`fork CLI ${args[0]} failed (exit ${proc.exitCode}): ${proc.stderr.toString().slice(-400)}`);
  }
  return JSON.parse(line);
}

/** The z3 schedule ids the fork holds right now — the pre-arm snapshot an arm failure is swept against. */
export function z3ScheduleIds(cli: ForkCli = forkCli): string[] {
  return ForkStateSchema.parse(cli(["state"])).schedules.map((x) => x.id);
}

/**
 * After ANY arm failure: every z3 schedule NOT in the pre-arm snapshot is this
 * arm's (persisted before the failure) — disarm it and cancel every run it
 * fired. Every step runs; the errors are returned, never thrown midway.
 */
export function sweepNewZ3Schedules(preArmIds: readonly string[], cli: ForkCli = forkCli): { swept: string[]; errors: unknown[] } {
  const errors: unknown[] = [];
  const swept: string[] = [];
  let fresh: string[] = [];
  try {
    fresh = z3ScheduleIds(cli).filter((id) => !preArmIds.includes(id));
  } catch (e) {
    return { swept, errors: [e] };
  }
  for (const id of fresh) {
    try {
      for (const run of disarmZ3Schedule(id, cli).firedRunIds) {
        try {
          cancelForkRun(run, cli);
        } catch (e) {
          errors.push(e);
        }
      }
      swept.push(id);
    } catch (e) {
      errors.push(e);
    }
  }
  return { swept, errors };
}

/**
 * Arms the round's fork schedule — called by the live test only AFTER gateFire
 * passed, with the pre-arm snapshot. On ANY failure (non-zero exit, timeout,
 * unparseable or drifted output) every new z3 schedule is swept, and the
 * failure is thrown as an AggregateError whose cause is the original error.
 */
export function armZ3Schedule(
  input: { config: Record<string, unknown>; participants: string; sessionId?: string; runAt?: number },
  preArmIds: readonly string[],
  cli: ForkCli = forkCli,
  sleepSync: (ms: number) => void = (ms) => Bun.sleepSync(ms),
): { scheduleId: string; protocolConfig: Record<string, unknown> } {
  const args = ["arm", "--config", JSON.stringify(input.config), "--participants", input.participants];
  if (input.sessionId !== undefined) args.push("--session", input.sessionId);
  if (input.runAt !== undefined) args.push("--run-at", String(input.runAt));
  try {
    return ArmSchema.parse(cli(args, FORK_ARM_TIMEOUT_MS));
  } catch (original) {
    // Sweep once now, then AGAIN once the in-container arm is dead by construction
    // (its `timeout -s KILL` fired IN_CONTAINER_KILL_MARGIN_MS before the host's,
    // so a beat past the margin it cannot still persist) — both before runAt.
    const first = sweepNewZ3Schedules(preArmIds, cli);
    sleepSync(IN_CONTAINER_KILL_MARGIN_MS);
    const second = sweepNewZ3Schedules(preArmIds, cli);
    const swept = [...new Set([...first.swept, ...second.swept])];
    const errors = [...first.errors, ...second.errors];
    throw new AggregateError(
      [original, ...errors],
      `fork arm failed (${original instanceof Error ? original.message.slice(0, 200) : String(original)}) — swept new z3 schedule(s) [${swept.join(", ")}]${errors.length > 0 ? `; ${errors.length} sweep error(s)` : ""}`,
      { cause: original },
    );
  }
}

/** Cancels a protocol run a schedule this test armed already fired (the pre-round cleanup path). */
export function cancelForkRun(protocolRunId: string, cli: ForkCli = forkCli): z.infer<typeof CancelSchema> {
  return CancelSchema.parse(cli(["cancel", protocolRunId], FORK_CANCEL_TIMEOUT_MS));
}

/**
 * The mid-flight-teardown heal (attempts 3 + 10, live): the engine settled
 * green, the harvest bundle landed, then the fleet CLI exited 6 having taken
 * the run lock and destroyed nothing — box billing, record unclosed. The
 * operator's hand-clean (rm the dead-pid lock, one --no-harvest teardown),
 * scripted at the arm that needs it: returns the heal result, or null when a
 * LIVE holder owns the lock (never touched — the leg fails on evidence) or
 * the deadline is gone.
 */
export function healMidFlightTeardown(input: {
  runId: string;
  runsDir: string;
  fleet: (args: string[], stdinFile: string | undefined, timeoutMs: number) => { exitCode: number; stdout: string; stderr: string };
  deadline: number;
  pastDeadline: (what: string) => void;
}): { exitCode: number; tail: string } | null {
  const lockFile = `${input.runsDir}/${input.runId}.lock`;
  let holderAlive = false;
  try {
    const pid = Number(readFileSync(lockFile, "utf8").trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        holderAlive = true;
      } catch {
        // ESRCH: the holder is dead — the lock is stale
      }
    }
  } catch {
    // ENOENT: no lock file — the retry below has nothing to clear
  }
  if (holderAlive) return null;
  if (existsSync(lockFile)) rmSync(lockFile);
  const left = input.deadline - Date.now();
  if (left <= 0) {
    input.pastDeadline(`run ${input.runId} teardown heal`);
    return null;
  }
  const t = input.fleet(["teardown", input.runId, "--driver", "exedev", "--dir", input.runsDir, "--no-harvest"], undefined, Math.max(1_000, Math.min(FLEET_CLI_TIMEOUT_MS, left)));
  const tail = `${t.stdout}\n${t.stderr}`.trim().split("\n").pop() ?? "";
  return { exitCode: t.exitCode, tail };
}

/**
 * Disarms a schedule this test armed (also usable before any round deps exist).
 * The fork's disarm has no cross-process lock (a tick can slip past its 3 s
 * recheck), so the fresh `state` is re-read afterwards: every run carrying the
 * scheduleId — the reported `firedRunId` included — is returned for cancel.
 */
export function disarmZ3Schedule(
  scheduleId: string,
  cli: ForkCli = forkCli,
): { disarmed: boolean; firedRunIds: string[]; scheduleStatus: string | null } {
  const d = DisarmSchema.parse(cli(["disarm", scheduleId], FORK_DISARM_TIMEOUT_MS));
  const st = ForkStateSchema.parse(cli(["state"]));
  const after = st.runs.filter((r) => r.scheduleId === scheduleId).map((r) => r.id);
  return {
    disarmed: d.disarmed,
    firedRunIds: [...new Set([...(d.firedRunId === null ? [] : [d.firedRunId]), ...after])],
    scheduleStatus: st.schedules.find((x) => x.id === scheduleId)?.status ?? null,
  };
}

/**
 * Operator-setup preflight, run BEFORE the GO gate: every problem the runbook
 * guards against that would otherwise surface mid-round. Empty = ready.
 */
export function preflightFork(): string[] {
  const problems: string[] = [];
  const sh = (args: string[]) => Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const env = sh(["docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", FORK_CONTAINER]);
  if (env.exitCode !== 0) return [`docker inspect ${FORK_CONTAINER} failed — is the fork container up?`];
  const cli = env.stdout.toString().split("\n").find((l) => l.startsWith("SWARMCLAW_FACTORY_FLEET_CLI="))?.split("=")[1];
  if (cli !== GATE_WRAPPER_IN_CONTAINER) problems.push(`the fork's SWARMCLAW_FACTORY_FLEET_CLI is ${String(cli)}, not ${GATE_WRAPPER_IN_CONTAINER} (recreate the container with the override)`);
  if (sh(["docker", "exec", FORK_CONTAINER, "test", "-x", GATE_WRAPPER_IN_CONTAINER]).exitCode !== 0) problems.push(`${GATE_WRAPPER_IN_CONTAINER} is not executable inside the container (exec bit, or the /factory mount)`);
  const realCli = sh(["docker", "exec", FORK_CONTAINER, "sh", "-c", 'test -x "$(head -n 1 /factory/.sandbox/z3-gate/real-cli)"']);
  if (realCli.exitCode !== 0) problems.push("the gate's real-cli is missing or not executable inside the container");
  // Read-write mount probe: a nonce written container-side must read back host-side.
  const nonce = randomBytes(8).toString("hex");
  const probe = path.join(REPO_ROOT, ".sandbox", "z3-gate", "probe");
  sh(["docker", "exec", FORK_CONTAINER, "sh", "-c", `echo ${nonce} > /factory/.sandbox/z3-gate/probe`]);
  if (!existsSync(probe) || readFileSync(probe, "utf8").trim() !== nonce) problems.push("the container cannot write /factory/.sandbox/z3-gate (the clone must be mounted read-write at /factory)");
  rmSync(probe, { force: true });
  // The wrapper must RUN, not just carry +x (bash present, a fractional sleep, a writable mktemp).
  const run = sh(["docker", "exec", FORK_CONTAINER, GATE_WRAPPER_IN_CONTAINER, "help"]);
  if (run.exitCode === 98 || run.exitCode === 126 || run.exitCode === 127 || run.exitCode === null) {
    problems.push(`the gate wrapper does not run inside the container (exit ${run.exitCode}): ${run.stderr.toString().slice(0, 200)}`);
  }
  if (sh(["docker", "exec", FORK_CONTAINER, "timeout", "-s", "KILL", "5", "true"]).exitCode !== 0) {
    problems.push("the container lacks coreutils `timeout` — an in-container fork CLI call could outlive its host timeout");
  }
  if (sh(["docker", "exec", FORK_CONTAINER, "sh", "-c", 'sleep 0.1 && t="$(mktemp)" && rm -f "$t"']).exitCode !== 0) {
    problems.push("the container lacks a fractional `sleep` or a writable mktemp — the gate's hold loop cannot run");
  }
  // One malformed record anywhere in the runs dir makes RunRecordStore.list() throw (listing-partial).
  try {
    new RunRecordStore({ dir: RUNS_DIR, create: false }).list();
  } catch (e) {
    problems.push(`the runs dir ${RUNS_DIR} does not list cleanly: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  try {
    ForkStateSchema.parse(forkCli(["state"]));
  } catch (e) {
    problems.push(`the fork CLI state does not answer the contract: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  return problems;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The fork image's revision label, or null when the image carries none (it has no .git to ask). */
function forkImageRev(): string | null {
  const proc = Bun.spawnSync(
    ["docker", "inspect", "-f", '{{index .Config.Labels "org.opencontainers.image.revision"}}', FORK_CONTAINER],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  const rev = proc.stdout.toString().trim();
  return proc.exitCode === 0 && /^[0-9a-f]{7,40}$/.test(rev) ? rev : null;
}

function fleet(args: string[], stdinFile?: string, timeoutMs = FLEET_CLI_TIMEOUT_MS): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "scripts/fleet.ts", ...args], {
    cwd: REPO_ROOT,
    stdin: stdinFile === undefined ? "ignore" : Bun.file(stdinFile),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Exit 4 = no such run (the one non-transient answer, as the fork's poller treats it). */
const FLEET_RESULT_NOT_FOUND = 4;

function resultOnce(runId: string): { payload: ResultPayload } | { transient: string } {
  const out = fleet(["result", runId, "--json", "--dir", RUNS_DIR]);
  if (out.exitCode === FLEET_RESULT_NOT_FOUND) throw new Error(`fleet result ${runId}: no such run (exit 4)`);
  const line = out.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (out.exitCode !== 0 || line === undefined) return { transient: `exit ${out.exitCode}` };
  return { payload: JSON.parse(line) as ResultPayload };
}

function view(r: { runId: string; createdAt: string; requestId?: string; vmName?: string; keyHash?: string }): RecordView {
  return { runId: r.runId, createdAt: r.createdAt, requestId: r.requestId, vmName: r.vmName, keyHash: r.keyHash };
}

/** Readonly sqlite query; throws when the db is absent (an unread ledger is not an empty one). */
function readonlyRows<T>(dbPath: string, sql: string, ...params: string[]): T[] {
  if (!existsSync(dbPath)) throw new Error(`${dbPath} is absent — the leg cannot be measured`);
  // A readonly open that lands while the last WRITER's -shm needs recovery
  // (the crash window SIGKILLs the fork mid-ledger-write) fails CANTOPEN —
  // the same-process poison family of gotcha #20, reader side. A readonly
  // connection can NEVER run the recovery, so a retry alone just spins until
  // some writer happens by (round 13: it never did — 4 attempts, still
  // CANTOPEN). The heal is one short READ-WRITE open: SQLite recovers the WAL
  // on the first connection able to write; no rows are touched. At the
  // redrive's call sites the fork is SIGKILLed and no other writer exists.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        return db.query(sql).all(...params) as T[];
      } finally {
        db.close();
      }
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/unable to open database file|database is locked|SQLITE_BUSY|SQLITE_CANTOPEN/i.test(msg)) throw e;
      try {
        // The recovery runs on the first WAL READ (prepare), never on open —
        // so the heal is a real CHECKPOINT: it processes the WAL, truncates
        // it, and leaves the db readable by plain readonly connections.
        const heal = new Database(dbPath);
        try {
          heal.run("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          heal.close();
        }
      } catch (healErr) {
        log({
          requestId: `z3-ledger-heal-${dbPath}`,
          operation: "z3.ledger_heal_failed",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "error",
          runId: null,
          error: { code: "ledger-heal-failed", message: String(healErr instanceof Error ? healErr.message : healErr).slice(0, 160) },
        });
      }
      // The sleep only buys the NEXT attempt a fresher window — after the
      // last one it would be dead time before the throw.
      if (attempt < 3) Bun.spawnSync(["sleep", "2"]); // sync context: block this read, not the event loop
    }
  }
  throw lastErr;
}

/** `mgat.<b64url claims>.<sig>` → claims.tokenId (the token itself never leaves this function). */
function agentTokenId(token: string): string {
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { tokenId?: unknown };
  if (typeof claims.tokenId !== "string") throw new Error("Z3_MEMGATE_AGENT_TOKEN carries no tokenId claim");
  return claims.tokenId;
}

/** The factory host client, journaling every retain it makes — those calls ARE the host-side traces. */
function journalingClient(journal: string[]): HindsightClient {
  const client = new HindsightClient(); // host env token (INV-HM1) — this process IS the factory host
  const retain = client.retain.bind(client);
  client.retain = (async (...args: Parameters<HindsightClient["retain"]>) => {
    const res = await retain(...args);
    const documentId = (args[2] as { documentId?: string } | undefined)?.documentId;
    if (documentId !== undefined) journal.push(documentId);
    return res;
  }) as HindsightClient["retain"];
  return client;
}

/**
 * The round-side gateway assertion: one `reflect` through the M2.1 gateway with
 * the agent token — origin + token ID recorded, never the token. `reflect`, not
 * `recall`: agent tokens carry only their grant class's verbs (host =
 * {reflect, retain}, bot = {consolidate}; memgate AGENT_GRANT_CLASSES), so no
 * agent token may recall. EXEMPT from the round's read-only memory-verb rule
 * (READ_ONLY_MEMORY_VERBS) by design: that rule classifies BOX credentials;
 * this call is host-side, and its LLM cost is budgeted (Z3_REFLECT_CALL_USD).
 */
export async function gatewayReflect(bank: string, deadline: number): Promise<{ origin: string; agentTokenId: string }> {
  const gateway = process.env.QDS_KG_GATEWAY_URL ?? "";
  const token = process.env.Z3_MEMGATE_AGENT_TOKEN ?? "";
  if (gateway === "" || token === "") throw new Error("QDS_KG_GATEWAY_URL / Z3_MEMGATE_AGENT_TOKEN unset — the gateway assertion cannot authenticate");
  const res = await fetch(`${gateway.replace(/\/+$/, "")}/v1/default/banks/${encodeURIComponent(bank)}/reflect`, {
    // bounded: a hung gateway must not outlive the deadline (the finally must still run)
    signal: AbortSignal.timeout(Math.max(1_000, Math.min(60_000, deadline - Date.now()))),
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: "z3 exit round gateway assertion" }),
  });
  if (!res.ok) throw new Error(`gateway reflect through ${new URL(gateway).origin} refused: HTTP ${res.status}`);
  return { origin: new URL(gateway).origin, agentTokenId: agentTokenId(token) };
}

/**
 * The recallability probe the release waits on (round-19 attempt-5 finding):
 * a dispatch-shaped recall against the bank, repeated until ≥1 of the round's
 * retained doc ids surfaces in the response's documentId fields (the client's
 * camelCase view — the raw wire is snake_case document_id, and the naive
 * `document_id ?? id` read misses every hit; measured live), or until the
 * bound. Returns whether a hit ever landed.
 */
export async function waitFindingsRecallable(
  input: { bank: string; docIds: readonly string[] },
  probe: {
    recall: (bank: string, query: string, limit: number) => Promise<unknown>;
    sleep: (ms: number) => Promise<void>;
    deadlineMs: number;
    cadenceMs?: number;
  },
): Promise<boolean> {
  const want = new Set<string>(input.docIds);
  if (want.size === 0) return true; // nothing retained this round: no wait owed
  const cadence = probe.cadenceMs ?? 20_000;
  for (let attempt = 0; ; attempt++) {
    const res = (await probe.recall(input.bank, "z3 exit round", 30).catch(() => undefined)) as
      | { results?: Array<{ documentId?: unknown }> }
      | undefined;
    const ids = (res?.results ?? []).map((r) => String(r?.documentId ?? ""));
    if (ids.some((id) => want.has(id))) return true;
    if (Date.now() + cadence > probe.deadlineMs) return false;
    await probe.sleep(cadence);
  }
}

/** The bank dispatch's recall reads for this repo (dispatch.ts memory lane), never a hand-named one. */
export async function resolveRoundBank(repoSlug: string, client: HindsightClient = new HindsightClient()): Promise<string> {
  const bank = resolveProvisionedRepoBankId(resolveBankId(repoSlug), extractExistingBankIds(await client.listBanks()));
  if (bank === null) throw new Error(`no provisioned repo bank for ${repoSlug} — dispatch's recall would read none either`);
  return bank;
}

/** Pre-GO probe: the agent token authenticates at the gateway for the bank the round will use. */
export async function preflightGateway(repoSlug: string): Promise<string[]> {
  try {
    await gatewayReflect(await resolveRoundBank(repoSlug), Date.now() + 60_000);
    return [];
  } catch (e) {
    return [`the gateway assertion fails before any spend: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`];
  }
}

export function z3LiveDeps(opts: {
  sink: EvidenceSink;
  /** The schedule THIS round armed — the only run the round ever binds. */
  scheduleId: string;
  /** Epoch ms every round poll gives up at; the cleanup's own reads get `Z3_LIVE_BUDGET.cleanupMs` beyond it. */
  deadline: number;
  /** The armed schedule's runAt — a schedule still unfired well past it is red (hibernation, a stalled tick). */
  runAt: number;
  providerKeyHashes: Z3Deps["providerKeyHashes"];
  revokeVerify: Z3Deps["revokeVerify"];
  /** The QA leg's harvest for `normalizeHarvest`; defaults to the #467 findings sidecar under RUNS_DIR. */
  readHarvest?: (runId: string, lens: string) => unknown;
}): Z3Deps {
  const store = () => new RunRecordStore({ dir: RUNS_DIR, create: false });
  const allowlistPath = path.join(RUNS_DIR, ".factory", "approvers.json");
  const allowlistPrior = existsSync(allowlistPath) ? readFileSync(allowlistPath) : null;
  const memgateLedger = path.resolve(REPO_ROOT, process.env.QDS_MEMGATE_LEDGER ?? DEFAULT_MEMGATE_LEDGER);
  let approveDir: string | null = null;
  let bound: string | null = null;
  /** Every protocol run this round's schedule fired (the cleanup cancels all of them). */
  const ownRuns = new Set<string>();
  /**
   * While the crash window holds the fork DOWN, reads are served from the last
   * state seen before the kill: a dead fork cannot change, and the QA tail
   * (last observe, attribution, retain) runs host-side meanwhile.
   */
  let lastState: ForkState | null = null;
  let frozen: ForkState | null = null;

  const pastDeadline = (what: string) => {
    if (Date.now() > opts.deadline) throw new Error(`${what} did not happen before the round deadline`);
  };

  /** One fresh fork state read; tolerates a short outage (the crash-window restart), never a long one. */
  async function state(): Promise<ForkState> {
    // The outage budget runs from THIS failure streak's start, not the last success
    // (a long `fleet result` stretch must not make the first blip fatal).
    if (frozen !== null) return frozen;
    let firstFail: number | null = null;
    for (;;) {
      try {
        lastState = ForkStateSchema.parse(forkCli(["state"]));
        return lastState;
      } catch (e) {
        if (e instanceof z.ZodError) throw new Error(`fork state output drifted from the contract: ${e.issues[0]?.path.join(".")} ${e.issues[0]?.message}`);
        firstFail ??= Date.now();
        if (Date.now() - firstFail > STATE_OUTAGE_MS) throw new Error(`fork state unreadable for ${STATE_OUTAGE_MS / 1000}s: ${String(e)}`);
        // the cleanup's reads run on their own deadline, beyond the round's
        if (Date.now() > opts.deadline + Z3_LIVE_BUDGET.cleanupMs) throw new Error("a fork state read did not happen before the cleanup deadline");
        await sleep(1_000);
      }
    }
  }

  async function boundRun(): Promise<Run> {
    if (bound === null) throw new Error("no protocol run bound yet — awaitTrigger first");
    const run = (await state()).runs.find((r) => r.id === bound);
    if (run === undefined) throw new Error(`the bound protocol run ${bound} vanished from the fork state`);
    return run;
  }

  /** Polls the bound run until `pick` yields; `pick` may throw to fail fast; `stopped` stands the poll down. */
  async function poll<T>(what: string, pick: (run: Run) => T | undefined, opts2: { stopped?: () => boolean } = {}): Promise<T> {
    for (;;) {
      if (opts2.stopped?.()) throw new Error(`${what}: watch stood down`);
      const got = pick(await boundRun());
      if (got !== undefined) return got;
      pastDeadline(what);
      await sleep(POLL_MS);
    }
  }

  const qaStep = (run: Run) => run.steps.find((s) => s.id.startsWith("qa-leg-"))?.externalJobConfig;

  return {
    sink: opts.sink,
    sleep,
    // INV-Z3-2 probe, read-only: the ADR-2 policy loader the run-completion consult uses, host cwd.
    autoMergePolicy: () => readAutoMergePolicy({ cwd: REPO_ROOT }),
    crashGate: crashGate(),
    awaitTrigger: async () => {
      for (;;) {
        const st = await state();
        const runs = st.runs.filter((r) => r.scheduleId === opts.scheduleId);
        for (const r of runs) ownRuns.add(r.id);
        // Several runs: none is bound, but every one is cancelled by the cleanup (ownRuns → disarm).
        if (runs.length > 1) throw new Error(`schedule ${opts.scheduleId} fired ${runs.length} runs — refusing to guess which is this round's`);
        const run = runs[0];
        if (run !== undefined) {
          bound = run.id;
          return {
            protocolRunId: run.id,
            scheduleId: opts.scheduleId,
            templateId: run.templateId ?? "",
            firedAt: new Date(run.createdAt).toISOString(),
            stepCaps: run.steps
              .filter((st2) => st2.kind === "external_job")
              .map((st2) => ({ stepId: st2.id, groupCapUsd: st2.externalJobConfig?.groupCapUsd ?? Number.NaN })),
            qaLegReviewSets: run.steps
              .filter((st2) => st2.kind === "external_job" && st2.id.startsWith("qa-leg-"))
              .map((st2) => ({ stepId: st2.id, reviewSet: st2.externalJobConfig?.reviewSet ?? null })),
            forkRev: forkImageRev(),
          };
        }
        // A refused fire (z3_fire_refused) marks the schedule failed and creates no run: fail now, not at the deadline.
        const schedule = st.schedules.find((x) => x.id === opts.scheduleId);
        if (schedule === undefined) throw new Error(`the armed schedule ${opts.scheduleId} is gone from the fork state`);
        if (schedule.status === "failed" || schedule.status === "completed" || schedule.status === "cancelled") {
          throw new Error(`the armed schedule ${opts.scheduleId} is ${schedule.status} with no run — the fork refused the fire`);
        }
        // Still unfired well past its runAt: the fork is hibernating (SOLSTICE_HIBERNATION) or its tick stalled.
        if (Date.now() > opts.runAt + 4 * 60_000) {
          throw new Error(`schedule ${opts.scheduleId} is still ${schedule.status} 4 min past its runAt — the fork never fired it (hibernation?)`);
        }
        pastDeadline(`the schedule ${opts.scheduleId} fire`);
        await sleep(POLL_MS);
      }
    },
    // The crash-window watch: the fleet-gate wrapper HOLDS the code submit, so
    // the window stays open — an ordinary-cadence poll cannot miss it.
    awaitStepSubmitting: (stepId, stopped) =>
      poll(
        `${stepId} submitting`,
        (run) => {
          const e = run.factoryState[stepId];
          if (e?.status === "submitting" && e.requestId) return { requestId: e.requestId };
          if (e?.status !== undefined && ["submitted", "completed", "failed", "cancelled"].includes(e.status)) {
            throw new Error(`${stepId} reached ${e.status} before the kill — the crash window was missed; re-run the round`);
          }
          return undefined;
        },
        { stopped },
      ),
    awaitStepSubmitted: (stepId) =>
      poll(`${stepId} submitted`, (run) => {
        const e = run.factoryState[stepId];
        // A recoverable lastError (replay exit, ack unreadable, poll blip) is recorded, never fatal.
        if (e?.status === "failed" || e?.status === "cancelled") throw new Error(`${stepId} ${e.status} fork-side: ${e.lastError ?? "no error recorded"}`);
        const workId = run.steps.find((s) => s.id === stepId)?.externalJobConfig?.workId;
        return e?.runId && e.requestId && workId ? { runId: e.runId, workId, requestId: e.requestId, lastError: e.lastError ?? null } : undefined;
      }),
    // A factory_observe step mints nothing: its OWN factoryState entry carries
    // the target runId the fork resolved (from `fromStepOutput`) and its status.
    awaitObserveStep: (stepId) =>
      poll(`${stepId} done`, (run) => {
        const e = run.factoryState[stepId];
        if (e?.status !== "completed" && e?.status !== "failed") return undefined;
        return { kind: run.steps.find((s) => s.id === stepId)?.kind ?? "unknown", status: e.status, observedRunId: e.runId ?? null };
      }),
    protocolFleet: async () => {
      const entries = Object.entries((await boundRun()).factoryState);
      const ids = (pick: (e: (typeof entries)[number][1]) => string | null | undefined) =>
        entries.map(([, e]) => pick(e)).filter((x): x is string => typeof x === "string" && x !== "");
      return {
        runIds: ids((e) => e.runId),
        // requestIds persist at `submitting`, BEFORE the exec: an in-flight submit's run is attributable by it
        // factory_observe entries carry `observe-<uuid>` requestIds — not fleet submits
        requestIds: ids((e) => e.requestId).filter((r) => !r.startsWith("observe-")),
        submitting: entries.filter(([, e]) => e.status === "submitting").map(([stepId]) => stepId),
      };
    },
    disarmSchedule: async () => {
      const d = disarmZ3Schedule(opts.scheduleId); // disarm + re-read: runs by scheduleId + its status
      for (const id of d.firedRunIds) ownRuns.add(id);
      return { disarmed: d.disarmed, firedRunIds: [...ownRuns], scheduleStatus: d.scheduleStatus };
    },
    cancelProtocolRun: async (protocolRunId) => {
      // Never another round's run: only runs THIS round's schedule fired are ever cancelled.
      if (protocolRunId !== bound && !ownRuns.has(protocolRunId)) throw new Error(`refusing to cancel ${protocolRunId}: not fired by schedule ${opts.scheduleId}`);
      return CancelSchema.parse(forkCli(["cancel", protocolRunId], FORK_CANCEL_TIMEOUT_MS));
    },
    awaitProtocolComplete: (protocolRunId) =>
      poll(`protocol run ${protocolRunId} terminal`, (run) =>
        run.status === "completed" || run.status === "failed" || run.status === "cancelled"
          ? {
              runStatus: run.status,
              artifacts: run.artifacts,
              events: run.events.map((e) => ({
                type: e.type,
                stepId: e.stepId ?? undefined,
                summary: e.summary ?? undefined,
                data: e.data ?? undefined,
              })),
            }
          : undefined,
      ),
    killFork: async () => {
      const snapshot = lastState ?? (await state());
      execFileSync("docker", ["kill", "--signal", "KILL", FORK_CONTAINER], { timeout: 60_000, stdio: "pipe" });
      frozen = snapshot; // only once the kill SUCCEEDED: a failed kill leaves a live fork, read live
    },
    restartFork: async () => {
      frozen = null;
      execFileSync("docker", ["start", FORK_CONTAINER], { timeout: 120_000, stdio: "pipe" });
    },
    awaitResult: async (runId, want) => {
      let pausingSince: number | null = null;
      for (;;) {
        const r = resultOnce(runId);
        if ("payload" in r && (r.payload.terminal || (want === "awaiting-approval" && r.payload.status === "awaiting-approval"))) {
          return { status: r.payload.status, terminal: r.payload.terminal };
        }
        // A QA leg stranded in `pausing` is red by name, not at the deadline (see PAUSING_BOUND_MS).
        if ("payload" in r && want === "terminal" && r.payload.status === "pausing") {
          pausingSince ??= Date.now();
          if (Date.now() - pausingSince > PAUSING_BOUND_MS) {
            throw new Error(`run ${runId} has read \`pausing\` for ${PAUSING_BOUND_MS / 60_000} min — a vetoed QA leg (read its reverify report: failed hunt, lost harvest, or a commit) or a #465 regression`);
          }
        } else if ("payload" in r) {
          // only a REAL non-pausing read resets the #465 clock — a transient failure must not
          pausingSince = null;
        }
        pastDeadline(`run ${runId} reaching ${want}`);
        await sleep(POLL_MS);
      }
    },
    settleAndTeardown: async (runId) => {
      // The A2 cadence pair (cadence10.sh): `fleet status` until the in-box
      // engine settles (marker verdict ok/not-ok/engine-failed), then
      // `fleet teardown` — the teardown is what CLOSES the record, the only
      // transition the fork's leg poller can observe (`fleet result` is a pure
      // record read; #913). Never `fleet observe`: its reverify/gate arms are
      // approval surface, not a QA leg's job. Every exec is bounded by the
      // REMAINING round deadline, not the bare 300s default — a call that
      // outlives the deadline would steal the cleanup's budget.
      for (;;) {
        const remaining = opts.deadline - Date.now();
        if (remaining <= 0) pastDeadline(`run ${runId} reaching engine settle`);
        const bound = Math.max(1_000, Math.min(FLEET_CLI_TIMEOUT_MS, remaining));
        const out = fleet(["status", runId, "--driver", "exedev", "--dir", RUNS_DIR], undefined, bound);
        const state = /"state":"([a-z-]+)"/.exec(out.stdout)?.[1] ?? "unreadable";
        if (state === "ok" || state === "not-ok" || state === "engine-failed") {
          // Settle → teardown grace (round 15, live): the settle marker can
          // beat the in-box findings sidecar flush, and the teardown's harvest
          // then pulls a bundle WITHOUT journal/findings.json — leg 2's did.
          // A2's cadence never raced this only by its 45s poll granularity.
          // The grace is a fixed 15s: findings land at the same phase boundary
          // as the marker, so the flush tail is short.
          Bun.spawnSync(["sleep", "15"]);
          // Deadline re-checked BEFORE the teardown starts (the settle wait may have eaten it).
          const left = opts.deadline - Date.now();
          if (left <= 0) pastDeadline(`run ${runId} teardown`);
          const t = fleet(["teardown", runId, "--driver", "exedev", "--dir", RUNS_DIR], undefined, Math.max(1_000, Math.min(FLEET_CLI_TIMEOUT_MS, left)));
          if (t.exitCode !== 0) {
            const heal = healMidFlightTeardown({ runId, runsDir: RUNS_DIR, fleet, deadline: opts.deadline, pastDeadline });
            if (heal) return { state, teardownExit: heal.exitCode, teardownExitHealed: true, teardownTail: `heal(--no-harvest): ${heal.tail.slice(0, 340)}` };
          }
          const tail = `${t.stdout}\n${t.stderr}`.trim().split("\n").pop() ?? "";
          return { state, teardownExit: t.exitCode, teardownTail: tail.slice(0, 400) };
        }
        pastDeadline(`run ${runId} reaching engine settle (last state ${state})`);
        await sleep(POLL_MS);
      }
    },
    inventory: async () => {
      // ONE retry on the transport only (attempt 9, 2026-11-02: a transient ssh
      // failure mid-provision killed the whole round from a single unguarded
      // probe — same flake family as the create-137 and steering-255 retries,
      // which live in the driver). Parse/shape errors throw straight through:
      // a fleet list that reads but is malformed is deterministic, not flaky.
      let out: string;
      try {
        out = execFileSync("ssh", ["exe.dev", "ls", "--json"], { timeout: 60_000, encoding: "utf8" });
      } catch (first) {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        try {
          out = execFileSync("ssh", ["exe.dev", "ls", "--json"], { timeout: 60_000, encoding: "utf8" });
        } catch (second) {
          throw new Error(`exe.dev ls --json failed twice (inventory transport): ${second instanceof Error ? second.message : String(second)}`, { cause: first });
        }
      }
      const vms = (JSON.parse(out) as { vms?: Array<{ vm_name?: string; name?: string }> }).vms;
      if (!Array.isArray(vms)) throw new Error("exe.dev ls --json carried no vms array — an unread fleet is never an empty one");
      return vms.map((v) => v.vm_name ?? v.name ?? "");
    },
    readRecord: (runId) => {
      try {
        return view(store().get(runId));
      } catch {
        return null;
      }
    },
    recordsForRequestId: (requestId) =>
      store()
        .list()
        .filter((r) => r.requestId === requestId)
        .map(view),
    // Both by request_id: gate_admissions' PK is (request_id, run_id), so two
    // runs booked against one request is exactly what a by-run count misses.
    ledgerBookings: (requestId) => {
      const ledger = costLedgerOpts(RUNS_DIR).path;
      const count = (sql: string) => readonlyRows<{ n: number }>(ledger, sql, requestId)[0]?.n ?? 0;
      return {
        gateAdmissions: count("SELECT COUNT(*) AS n FROM gate_admissions WHERE request_id = ?"),
        groupReservations: count("SELECT COUNT(*) AS n FROM budget_group_admissions WHERE request_id = ?"),
      };
    },
    providerKeyHashes: opts.providerKeyHashes,
    memoryKeys: () =>
      readonlyRows<{ token_id: string; kind: string; run_id: string | null; claims_json: string }>(
        memgateLedger,
        "SELECT token_id, kind, run_id, claims_json FROM memgate_issuance",
      ).map((r): MemoryKeyRow => {
        let verbs: string[] = ["unknown"]; // an unparseable scope is treated as write-capable (fail-closed)
        try {
          const c = JSON.parse(r.claims_json) as { verbs?: unknown };
          if (Array.isArray(c.verbs) && c.verbs.every((v) => typeof v === "string")) verbs = c.verbs;
        } catch {
          /* keep the fail-closed default */
        }
        return { tokenId: r.token_id, kind: r.kind === "agent" ? "agent" : "per-run", runId: r.run_id, verbs };
      }),
    retainFindings: async (lens, runId) => {
      const run = await boundRun();
      const cfg = qaStep(run);
      const commitSha = cfg?.commitSha ?? "";
      const repoSlug = cfg?.repoSlug ?? "";
      if (!/^[0-9a-f]{40}$/.test(commitSha) || repoSlug === "") throw new Error("the bound run's QA steps carry no commitSha/repoSlug");
      const result = resultOnce(runId);
      if (!("payload" in result)) throw new Error(`fleet result ${runId} unreadable (${result.transient})`);
      const readHarvest = opts.readHarvest ?? ((id: string, l: string) => harvestForLens(RUNS_DIR, id, l));
      const norm = normalizeHarvest(lens, result.payload, readHarvest(runId, lens));
      const journal: string[] = [];
      const client = journalingClient(journal);
      const bank = await resolveRoundBank(repoSlug, client);
      const res = await retainFindings(
        { client },
        {
          repoBankId: bank,
          runId,
          lens,
          commitSha,
          repoSlug,
          requestId: store().get(runId).requestId ?? "",
          legRan: norm.legRan,
          findings: norm.legRan ? norm.findings : [],
        },
      );
      return { bank: res.bank, documentIds: res.documentIds, traces: journal.map((documentId) => ({ side: "host" as const, documentId })) };
    },
    gatewayAssert: (bank) => gatewayReflect(bank, opts.deadline),
    waitFindingsRecallable: (input) =>
      waitFindingsRecallable(input, {
        recall: (bank, query, limit) => new HindsightClient().recall(bank, query, limit),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        deadlineMs: Math.min(opts.deadline, Date.now() + 15 * 60_000),
      }),
    readRecall: (requestId) => {
      const file = path.join(REPO_ROOT, DEFAULT_RECALL_DIR, `${requestId}.json`);
      if (!existsSync(file)) return null;
      const row = JSON.parse(readFileSync(file, "utf8")) as { directive?: string; recalledDocumentIds?: string[] };
      return { directive: row.directive ?? "", recalledDocumentIds: row.recalledDocumentIds ?? [] };
    },
    approve: async (runId) => {
      // The human step, scripted per ADR-1 §3: allowlisted approver MERGED into
      // the existing allowlist (never replacing it), scrypt hash written 0600
      // from the first byte, token on fd 0 from a 0600 file. The `.factory`
      // dir is created 0700 when absent and never re-moded when it exists.
      const factoryDir = path.dirname(allowlistPath);
      if (!existsSync(factoryDir)) mkdirSync(factoryDir, { recursive: true, mode: 0o700 });
      const salt = randomBytes(16).toString("hex");
      const token = `z3tok-${randomBytes(24).toString("hex")}`;
      const prior = allowlistPrior === null ? { version: 1, approvers: {} } : (JSON.parse(allowlistPrior.toString("utf8")) as { version?: number; approvers?: Record<string, unknown> });
      const merged = {
        ...prior,
        version: prior.version ?? 1,
        approvers: { ...(prior.approvers ?? {}), [APPROVER_ID]: { v: 2, salt, hash: scryptToken(salt, token), ...SCRYPT_PARAMS } },
      };
      rmSync(allowlistPath, { force: true }); // 'mode' applies only on create
      writeFileSync(allowlistPath, JSON.stringify(merged), { mode: 0o600 });
      approveDir = mkdtempSync(path.join(tmpdir(), "z3-approve-"));
      const tokenPath = path.join(approveDir, "approver.token");
      writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
      const out = fleet(["approve", runId, "--approver", APPROVER_ID, "--reason", "z3-exit-round", "--dir", RUNS_DIR], tokenPath);
      rmSync(approveDir, { recursive: true, force: true });
      approveDir = null;
      if (`${out.stdout}${out.stderr}`.includes(token)) throw new Error("the approver token leaked into the approve output");
      return { ...out, approverId: APPROVER_ID, tokenChannel: "stdin" };
    },
    // PARALLEL: one fleet ceiling per destroy pass (the cleanup budget counts it once, Z3_CLEANUP_STEPS_MS.destroy).
    destroyBoxes: async (runIds) => {
      const outs = await Promise.all(
        runIds.map(async (runId) => {
          const proc = Bun.spawn(["bun", "scripts/fleet.ts", "cancel", "--driver", "exedev", runId, "--dir", RUNS_DIR], {
            cwd: REPO_ROOT,
            stdout: "pipe",
            stderr: "pipe",
            timeout: FLEET_CLI_TIMEOUT_MS,
          });
          const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
          return { runId, exitCode, stderrTail: stderr.slice(-600) };
        }),
      );
      return { receipts: outs, problems: outs.filter((o) => o.exitCode !== 0).map((o) => `fleet cancel ${o.runId} failed (exit ${o.exitCode})`) };
    },
    revokeVerify: opts.revokeVerify,
    restoreApprovers: () => {
      try {
        if (approveDir !== null) rmSync(approveDir, { recursive: true, force: true });
        if (allowlistPrior === null) rmSync(allowlistPath, { force: true });
        else writeFileSync(allowlistPath, allowlistPrior, { mode: 0o600 });
        return [];
      } catch (e) {
        return [`approver allowlist restore FAILED: ${e instanceof Error ? e.message : String(e)}`];
      }
    },
  };
}

/** The persisted protocolConfig caps must be the composition the GO gated — or the round refuses. */
export function armedCapsProblems(
  protocolConfig: Record<string, unknown>,
  want: { qaGroupCapUsd: number; codeGroupCapUsd: number; codePollTimeoutMs?: number; reviewSet?: readonly string[] },
): string[] {
  const problems: string[] = [];
  if (protocolConfig.templateId !== Z3_TEMPLATE_ID) problems.push(`armed template ${String(protocolConfig.templateId)}, not ${Z3_TEMPLATE_ID}`);
  if (protocolConfig.qaGroupCapUsd !== want.qaGroupCapUsd) problems.push(`armed qaGroupCapUsd ${String(protocolConfig.qaGroupCapUsd)} ≠ GO-gated ${want.qaGroupCapUsd}`);
  if (protocolConfig.codeGroupCapUsd !== want.codeGroupCapUsd) problems.push(`armed codeGroupCapUsd ${String(protocolConfig.codeGroupCapUsd)} ≠ GO-gated ${want.codeGroupCapUsd}`);
  if (want.codePollTimeoutMs !== undefined && protocolConfig.codePollTimeoutMs !== want.codePollTimeoutMs) {
    problems.push(`armed codePollTimeoutMs ${String(protocolConfig.codePollTimeoutMs)} ≠ the round's ${want.codePollTimeoutMs}`);
  }
  if (want.reviewSet !== undefined) {
    const armed = protocolConfig.reviewSet;
    const same =
      Array.isArray(armed) &&
      armed.length === want.reviewSet.length &&
      [...armed].sort().join("\n") === [...want.reviewSet].sort().join("\n");
    if (!same) problems.push(`armed reviewSet ${JSON.stringify(armed)} ≠ the round's pinned ${JSON.stringify(want.reviewSet)}`);
  }
  return problems;
}
