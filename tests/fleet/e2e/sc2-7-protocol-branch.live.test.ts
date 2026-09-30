import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { liveTodoOff } from "./live-harness";
import { scryptToken, SCRYPT_PARAMS } from "../../../src/fleet/approvers";
import {
  boxNames,
  killDaemon,
  MANIFEST_PATH,
  pollUntil,
  QDS_ROOT,
  REPO_SHA,
  REPO_URL,
  readEntry,
  readEventsFor,
  readRunRow,
  shOut,
  spawnDaemon,
  SWARM_WORKTREE,
  wrapperJournal,
  wrapperScript,
  writeEvidence,
} from "./sc2-harness";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * SC2.7 — the EXIT TEST (roadmap Stage SC2.7): a live protocol runs
 * factory_run END-TO-END, branches on the verdict, and notifies.
 *
 * Shape (one leg, both halves of the stage gate):
 *   1. KILL HALF — the daemon is killed mid-submit (after the requestId
 *      persist, before the exec; the SC2.6-proven crash window (a)); the
 *      restart replays the SAME id and must still provision EXACTLY ONE box.
 *   2. EXIT HALF — the factory run's in-box pipeline (df53-demo, REAL model
 *      work under the $0.50 group cap) runs to its terminal marker; the test
 *      then drives the host completion chain (`fleet observe`: gate
 *      pre-register → harvest/teardown → reverify → gate promote, #382) which
 *      parks the run at `awaiting-approval` — the DAG never approves. The
 *      daemon stays UP throughout (one poller, end to end) — the live proof
 *      the close→register poller race is closed. A HUMAN step follows,
 *      scripted explicitly per the roadmap: the scrypt-gated
 *      `fleet approve <runId>` (allowlist under the records dir, token on
 *      fd 0). Only then does `fleet result` report `status: "approved"`,
 *      terminal — the swarmclaw poller lands the factory_result artifact,
 *      and the protocol's BRANCH step (artifact_field_equals on
 *      `status` == "approved") takes the approved case into the `complete`
 *      step, ending the run. The notification witness is the durable
 *      `branch_taken` protocol event + the terminal run row.
 *
 * live-mirror: sc2-7 (substrate-touching helpers carry their mirror comments
 * in sc2-harness.ts).
 *
 * Spend protocol: worst case printed in the spend-estimate test below; the
 * box is destroyed by the observe chain's own teardown, the final guard
 * asserts the fleet is empty, and the approve token never touches stdout,
 * stderr, or any evidence payload.
 */

const GROUP_CAP_USD = 0.5;
const APPROVER_ID = "sc27-e2e-approver";
const RECORDS_DIR = process.env.QDS_RUNS_DIR ?? ".sandbox/runs"; // resolveRunsDir's chain: --dir wins, else $QDS_RUNS_DIR — approve must match the store the wrapper's submit used

/** live-mirror: sc2-7 — worst-case spend estimate, printed BEFORE any box exists. */
const WORST_CASE_USD = GROUP_CAP_USD + 3.7; // group cap $0.50 + ≤1h box @ the $3.60/hr ledger rate + headroom

/** Poll `fleet result <runId> --json` until pred(status, terminal) holds. */
async function pollResult(
  runId: string,
  pred: (payload: { status: string; terminal: boolean }) => boolean,
  timeoutMs: number,
): Promise<{ status: string; terminal: boolean; payload: Record<string, unknown> } | null> {
  return pollUntil(() => {
    const out = shOut(`cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts result ${JSON.stringify(runId)} --json`, 120_000);
    const line = out.stdout.split("\n").find((l) => l.trim().startsWith("{"));
    if (!line) return null;
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      const status = String(payload.status ?? "");
      const terminal = payload.terminal === true;
      return pred({ status, terminal }) ? { status, terminal, payload } : null;
    } catch {
      return null;
    }
  }, timeoutMs);
}

/**
 * The daemon driver script: three steps — fj (external_job) → gate (branch
 * on the factory verdict) → done (complete). The restart-path poller tick is
 * what recovers the killed attempt (SC2.6 round 4: no tick, no replay).
 */
function daemonScript(dir: string): string {
  return `import * as fs from "node:fs";
import * as path from "node:path";

const DATA_DIR = ${JSON.stringify(path.join(dir, "swarm-data"))};
process.env.DATA_DIR = DATA_DIR;
const wrapper = ${JSON.stringify(path.join(dir, "fleet-wrapper.sh"))};
process.env.SWARMCLAW_FACTORY_FLEET_CLI = wrapper;

const lifecycle = await import(${JSON.stringify(SWARM_WORKTREE)} + "/src/lib/server/protocols/protocol-run-lifecycle");
const normalization = await import(${JSON.stringify(SWARM_WORKTREE)} + "/src/lib/server/protocols/protocol-normalization");
const unwrap = (m) => (m && typeof m === "object" && "default" in m ? m.default : m);
const lifecycleU = unwrap(lifecycle);
const normU = unwrap(normalization);
const storage = unwrap(await import(${JSON.stringify(SWARM_WORKTREE)} + "/src/lib/server/storage"));
const storageU = storage;

function makeAgent() {
  storageU.upsertStoredItem("agents", "agentA", {
    id: "agentA", name: "Agent A", provider: "ollama", model: "test-model", systemPrompt: "test", createdAt: 1, updatedAt: 1,
  });
}

if (process.argv[2] === "--self-check") {
  makeAgent();
  const probe = lifecycleU.createProtocolRun({
    title: "SC2.7 self-check", templateId: "custom",
    steps: [{ id: "probe", kind: "present", label: "Probe", instructions: "noop", turnLimit: 1 }],
    entryStepId: "probe", participantAgentIds: ["agentA"], facilitatorAgentId: "agentA", autoStart: false,
  });
  console.log("SELF-CHECK-OK " + probe.id);
  process.exit(0);
}

const runIdFile = ${JSON.stringify(path.join(dir, "run-id.txt"))};
let runId = fs.existsSync(runIdFile) ? fs.readFileSync(runIdFile, "utf8").trim() : "";
const restarting = runId !== "";

makeAgent();
if (!runId) {
  const run = lifecycleU.createProtocolRun({
    title: "SC2.7 protocol branch",
    templateId: "custom",
    steps: [
      {
        id: "fj",
        kind: "external_job",
        label: "Factory run",
        nextStepId: "gate",
        externalJobConfig: {
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          repoUrl: ${JSON.stringify(REPO_URL)},
          commitSha: ${JSON.stringify(REPO_SHA)},
          manifestPath: ${JSON.stringify(MANIFEST_PATH)},
          // workId, per #380 landed: headless spend books under the sanctioned
          // w: namespace, so the exit test runs the shape ADR-1 names — a
          // truly issueless macro process. The numeric-issueId workaround is
          // retired.
          workId: "sc27-protocol-branch",
          groupCapUsd: ${GROUP_CAP_USD},
        },
      },
      {
        id: "gate",
        kind: "branch",
        label: "Verdict gate",
        branchCases: [
          {
            id: "approved-case",
            nextStepId: "done",
            when: { type: "artifact_field_equals", field: "status", value: "approved" },
          },
        ],
      },
      { id: "done", kind: "complete", label: "Complete" },
    ],
    entryStepId: "fj",
    participantAgentIds: ["agentA"],
    facilitatorAgentId: "agentA",
    autoStart: false,
  });
  runId = run.id;
  fs.writeFileSync(runIdFile, runId);
}

lifecycleU.requestProtocolRunExecution(runId);

let pollTimer;
if (restarting) {
  const factory = unwrap(await import(${JSON.stringify(SWARM_WORKTREE)} + "/src/lib/server/protocols/protocol-factory"));
  pollTimer = setInterval(() => {
    factory.pollFactoryRuns().catch((e) => {
      fs.appendFileSync(${JSON.stringify(path.join(dir, "daemon-heartbeat.jsonl"))}, JSON.stringify({ t: Date.now(), pollerError: String((e && e.stack) || e) }) + "\\n");
    });
  }, 2000);
}

// Heartbeat: run status + every step's state, until killed or terminal.
const loadRun = (id) => normU.loadProtocolRunById(id);
const deadline = Date.now() + 30 * 60 * 1000;
while (Date.now() < deadline) {
  const current = loadRun(runId);
  const entry = current?.factoryState?.fj ?? null;
  const line = JSON.stringify({
    t: Date.now(),
    runStatus: current?.status ?? null,
    entryStatus: entry?.status ?? null,
    runId: entry?.runId ?? null,
    steps: current?.steps?.map((s) => s.id + ":" + (current.stepState?.[s.id]?.status ?? "?")).join(",") ?? null,
  });
  fs.appendFileSync(${JSON.stringify(path.join(dir, "daemon-heartbeat.jsonl"))}, line + "\\n");
  if (current && (current.status === "completed" || current.status === "failed" || current.status === "cancelled")) {
    console.log("RUN-TERMINAL " + current.status);
    if (pollTimer) clearInterval(pollTimer);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (pollTimer) clearInterval(pollTimer);
console.log("DAEMON-DEADLINE");
process.exit(3);
`;
}

describe("SC2.7 exit test: live protocol runs factory_run, branches on the verdict, notifies", () => {
  test.todoIf(!process.env.QDS_E2E_LIVE)("spend estimate printed before any box exists", () => {
    console.log(
      `SC2.7 worst-case spend: 1 box (≤1h alive across provision + pipeline + observe) ≈ $3.60 box-hours + group cap $${GROUP_CAP_USD.toFixed(2)} model ceiling + headroom = ≤ $${WORST_CASE_USD.toFixed(2)}; realistic < $1. One sbx- key minted, revoked by the observe chain's teardown.`,
    );
    assert.equal(typeof REPO_SHA, "string");
    assert.ok(REPO_SHA.length === 40, `QDS_EXEDEV_SHA must be a full sha (got ${REPO_SHA.length} chars)`);
  });

  test.todoIf(liveTodoOff())("daemon driver self-check (offline, no box)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc27-selfcheck-"));
    fs.writeFileSync(path.join(dir, "sc2-daemon.mts"), daemonScript(dir));
    fs.writeFileSync(path.join(dir, "fleet-wrapper.sh"), wrapperScript(dir), { mode: 0o755 });
    const bashn = Bun.spawnSync(["/bin/bash", "-n", path.join(dir, "fleet-wrapper.sh")]);
    assert.equal(bashn.exitCode, 0, `wrapper template failed bash -n: ${bashn.stderr.toString().slice(0, 400)}`);
    const errFile = path.join(dir, "self-check.stderr");
    const errFd = fs.openSync(errFile, "w");
    // ABSOLUTE tsx path (spawnDaemon's named precondition owns the existence
    // check) — the relative form resolved against the spawn's cwd and broke
    // whenever the worktree was missing.
    const out = Bun.spawnSync([path.join(SWARM_WORKTREE, "node_modules", ".bin", "tsx"), path.join(dir, "sc2-daemon.mts"), "--self-check"], {
      cwd: SWARM_WORKTREE,
      stdout: "pipe",
      stderr: errFd,
      stdin: "ignore",
    });
    fs.closeSync(errFd);
    const text = out.stdout.toString();
    assert.match(
      text,
      /SELF-CHECK-OK/,
      `daemon driver failed to boot in the worktree: exit=${out.exitCode} stderr=${fs.readFileSync(errFile, "utf8").slice(0, 800)}`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test.todoIf(liveTodoOff())(
    "kill mid-submit → restart → factory run completes → approve → branch takes the approved case → run completes",
    async () => {
      const before = boxNames();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc27-leg-"));
      fs.writeFileSync(path.join(dir, "sc2-daemon.mts"), daemonScript(dir));
      fs.writeFileSync(path.join(dir, "fleet-wrapper.sh"), wrapperScript(dir), { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "wrapper-mode"), "a"); // kill arm: hold the exec open

      // Cleanup state: every daemon spawn below is inside the try, and the
      // finally owns, in order — daemon kill → allowlist restore → fleet
      // cancel → dir rm (a live box must never outlive this test).
      let fleetRunId = "";
      let liveDaemon: Bun.Subprocess | undefined;
      const allowlistPath = path.join(QDS_ROOT, RECORDS_DIR, ".factory", "approvers.json");
      const allowlistPrior = fs.existsSync(allowlistPath) ? fs.readFileSync(allowlistPath) : null;

      try {
        // ── the kill half: persist → group-killed mid-submit ──
        const daemonA = spawnDaemon(dir);
        liveDaemon = daemonA;
        const persisted = await pollUntil(() => {
          const runId = fs.existsSync(path.join(dir, "run-id.txt"))
            ? fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim()
            : null;
          if (!runId) return null;
          const entry = readEntry(dir, runId);
          return entry?.status === "submitting" && entry?.requestId ? { runId, requestId: entry.requestId } : null;
        }, 60_000);
        assert.ok(persisted, "the requestId never persisted before the kill window closed");
        await killDaemon(dir, daemonA);
        liveDaemon = undefined;
        const execsBeforeRestart = wrapperJournal(dir).filter((l) => l.verb === "submit" && l.phase === "exec");
        assert.equal(execsBeforeRestart.length, 0, "the fleet-submit exec must NOT have fired before the kill");

        // ── restart: replay the SAME id; the REAL factory run provisions ──
        fs.writeFileSync(path.join(dir, "wrapper-mode"), "normal");
        const daemonB = spawnDaemon(dir);
        liveDaemon = daemonB;
        const submitted = await pollUntil(() => {
          const runId = fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim();
          const entry = readEntry(dir, runId);
          return entry?.status === "submitted" && entry?.runId ? entry : null;
        }, 480_000);
        // Hoisted BEFORE any replay assert: a non-null `submitted` means the
        // fleet run exists (a box may provision); the finally must be able to
        // cancel it even if an assert below throws first.
        fleetRunId = submitted?.runId ?? "";
        assert.ok(submitted, "the replay never reached 'submitted'");
        const submits = wrapperJournal(dir).filter((l) => l.verb === "submit" && l.phase === "exec");
        assert.equal(submits.length, 1, "exactly one fleet submit exec across the kill + replay");
        assert.equal(submits[0]?.requestId, persisted?.requestId, "the replay carried the SAME --request-id");
        assert.ok(fleetRunId, "the factory run id must be captured");

        // EXACTLY ONE box (the kill half's proof, continuing live).
        const midRun = await pollUntil(() => {
          const fresh = boxNames().filter((n) => !before.includes(n));
          return fresh.length >= 1 ? fresh : null;
        }, 120_000);
        assert.ok(midRun && midRun.length === 1, `exactly one box must serve the whole protocol; saw ${midRun?.length ?? 0}`);
        // The one-box invariant must HOLD, not merely appear — re-check after a
        // 10s stability window (a late second provision would surface here).
        await new Promise((r) => setTimeout(r, 10_000));
        const stableBoxes = boxNames().filter((n) => !before.includes(n));
        assert.equal(
          stableBoxes.length,
          1,
          `the one-box invariant must hold across the 10s stability window; saw ${stableBoxes.length}: ${stableBoxes.join(", ")}`,
        );
        writeEvidence("sc2-7", "kill-and-provision", {
          requestId: persisted?.requestId,
          fleetRunId,
          submitExecs: submits.length,
          replaySameId: submits[0]?.requestId === persisted?.requestId,
          freshBoxes: stableBoxes,
        });

        // ── box forensics BEFORE the teardown: the harvest verdict rides on the
        // in-box repo state (fill's `sbx/<runId>` branch, commits beyond base).
        // Round 1 harvested NOTHING (no bundle → reverify nothing-to-verify →
        // vetoed → closed, never parked) and the box was gone before anyone
        // could ask why — record the answers while the box is alive. ──
        const box = stableBoxes[0] ?? "";
        // The $( command substitution is escaped (\$ in the rendered string)
        // so the LOCAL /bin/bash -c passes it through to ssh's remote shell —
        // unescaped it expands against the HOST repo, not the box's.
        const probe = shOut(
          `ssh ${JSON.stringify(`${box}.exe.xyz`)} "cd ~/src 2>/dev/null && pwd && git branch --show-current && git log --oneline -3 && echo COUNT=\\$(git rev-list --count ${REPO_SHA}..HEAD 2>/dev/null) || echo NOREPO"`,
          120_000,
        );
        writeEvidence("sc2-7", "box-forensics", {
          box,
          probeStdout: probe.stdout.slice(0, 800),
          probeStderr: probe.stderr.slice(0, 400),
          probeExit: probe.exitCode,
        });

        // The daemon STAYS UP across the completion chain (#382 fixed): the
        // chain pre-registers `pausing` BEFORE its teardown lands `closedAt`,
        // so every poller tick through observe+reverify reads a non-terminal
        // status ("pausing", then "awaiting-approval") and the fj step stays
        // in flight. Pre-fix, a tick in the close→register window read
        // terminal "completed" and completed the step with the WRONG verdict,
        // defeating the approve seam (measured round 5). THIS leg is the
        // live proof the race is closed: one daemon, straight through
        // observe → approve → branch, no park.

        // ── the exit half: drive the completion chain to the approval park ──
        // `fleet observe` = pre-register → harvest/teardown → reverify → gate;
        // a green verdict parks the run at awaiting-approval (the DAG never
        // approves).
        const observe = shOut(
          `cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts observe ${JSON.stringify(fleetRunId)} --driver exedev --window-ms 600000`,
          900_000,
        );
        // Evidence BEFORE the assert: round 1's harvest classification was
        // lost because the exit-code assert threw first.
        writeEvidence("sc2-7", "observe", {
          fleetRunId,
          exitCode: observe.exitCode,
          stdoutTail: observe.stdout.slice(-1500),
          stderrTail: observe.stderr.slice(-2500),
        });
        assert.equal(observe.exitCode, 0, `observe failed (exit ${observe.exitCode}): ${(observe.stderr || observe.stdout).slice(-1200)}`);

        // The park: result is OPEN at awaiting-approval — unapprovable by the DAG.
        const parked = await pollResult(fleetRunId, (r) => r.status === "awaiting-approval" && !r.terminal, 120_000);
        assert.ok(parked, `the run never parked at awaiting-approval (last result payload: ${JSON.stringify(parked)})`);
        // #382 witness: the daemon that provisioned the box is the SAME
        // process polling now — it observed the whole chain and never saw a
        // terminal read before the approve (an early fj completion would have
        // failed the branch asserts below, so reaching here IS the proof).
        writeEvidence("sc2-7", "race-window-closed", {
          fleetRunId,
          daemonAliveThroughChain: true,
          parkedStatus: parked?.status,
          parkedTerminal: parked?.terminal,
        });
        const afterObserve = boxNames().filter((n) => !before.includes(n));
        assert.equal(afterObserve.length, 0, `the observe chain's teardown must destroy the box; still alive: ${afterObserve.join(", ")}`);

        // ── the HUMAN step, scripted per the roadmap: the scrypt-gated approve ──
        const factoryDir = path.join(QDS_ROOT, RECORDS_DIR, ".factory");
        fs.mkdirSync(factoryDir, { recursive: true });
        fs.chmodSync(factoryDir, 0o700);
        const salt = crypto.randomBytes(16).toString("hex");
        // Token prefix `sc27tok-` is deliberately distinct from APPROVER_ID
        // ("sc27-e2e-approver"): the evidence scrub keys on the token prefix,
        // and the approve evidence carries the approver id.
        const token = `sc27tok-${crypto.randomBytes(24).toString("hex")}`;
        // allowlistPath was hoisted above the try so the finally can
        // restore-or-delete the PRIOR allowlist state (this is a production
        // path — never leave the test's approver behind).
        fs.writeFileSync(
          allowlistPath,
          JSON.stringify({
            version: 1,
            approvers: {
              [APPROVER_ID]: { v: 2, salt, hash: scryptToken(salt, token), ...SCRYPT_PARAMS },
            },
          }),
        );
        fs.chmodSync(allowlistPath, 0o600);
        const tokenPath = path.join(dir, "approver.token");
        fs.writeFileSync(tokenPath, `${token}\n`);
        fs.chmodSync(tokenPath, 0o600);
        const approve = shOut(
          `cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts approve ${JSON.stringify(fleetRunId)} --approver ${APPROVER_ID} --reason sc2-7-exit-test --dir ${JSON.stringify(RECORDS_DIR)} < ${JSON.stringify(tokenPath)}`,
          300_000,
        );
        // The token must never survive into stdout/stderr (evidence carries
        // both tails; the scrub is the assert).
        const approveText = approve.stdout + approve.stderr;
        assert.ok(!approveText.includes(token), "the approver token leaked into the approve output");
        assert.equal(approve.exitCode, 0, `approve failed (exit ${approve.exitCode}): ${approveText.slice(-1200)}`);
        writeEvidence("sc2-7", "approve", {
          fleetRunId,
          approver: APPROVER_ID,
          exitCode: approve.exitCode,
          stdoutTail: approve.stdout.slice(-400),
          stderrTail: approve.stderr.slice(-600),
        });

        // The verdict turns terminal `approved` — the SAME live daemon's
        // poller lands it (#382: no park, no respawn; one daemon end to end).
        const approved = await pollResult(fleetRunId, (r) => r.status === "approved" && r.terminal, 180_000);
        assert.ok(approved, `the run never reached terminal 'approved' (last: ${JSON.stringify(approved)})`);

        // ── the branch + the notification witness ──
        const protocolRunId = fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim();
        const completed = await pollUntil(() => {
          const row = readRunRow<{ status: string; artifacts?: Array<{ kind: string; content: string }> }>(dir, protocolRunId);
          return row?.status === "completed" ? row : null;
        }, 300_000);
        assert.ok(completed, "the protocol run never completed after the approval");
        const factoryArtifact = (completed?.artifacts ?? []).filter((a) => a.kind === "factory_result").at(-1);
        assert.ok(factoryArtifact, "no factory_result artifact landed on the protocol run");
        const verdict = JSON.parse(factoryArtifact?.content ?? "{}") as { status?: string; runId?: string };
        assert.equal(verdict.status, "approved", `the factory_result verdict is not 'approved': ${verdict.status}`);
        assert.equal(verdict.runId, fleetRunId, "the factory_result verdict names a different fleet run");
        const events = readEventsFor<{ type: string; stepId?: string; summary?: string }>(dir, protocolRunId);
        const branchTaken = events.find((e) => e.type === "branch_taken" && e.stepId === "gate");
        assert.ok(branchTaken, `no branch_taken event on the gate step; events: ${events.map((e) => e.type).join(",")}`);
        assert.match(branchTaken?.summary ?? "", /approved-case/, `the branch took the wrong case: ${branchTaken?.summary}`);
        writeEvidence("sc2-7", "branch-and-complete", {
          protocolRunId,
          fleetRunId,
          verdictStatus: verdict.status,
          branchSummary: branchTaken?.summary,
          eventTypes: events.map((e) => e.type),
          runStatus: completed?.status,
        });
      } finally {
        // Cleanup, in order: (1) the daemon holds the poller — kill it first so
        // it cannot race the cancel; (2) restore-or-delete the allowlist (P9:
        // approvers.json is a production path); (3) the fleet cancel is
        // idempotent (SC2.4) but its FAILURE throws — cleanup failure must not
        // be silent, even if that masks a prior assert (the conservative
        // choice); (4) the dir rm removes the plaintext approve token, the
        // sqlite db, and the journals. A live box must never outlive this test.
        if (liveDaemon) await killDaemon(dir, liveDaemon);
        if (allowlistPrior === null) {
          fs.rmSync(allowlistPath, { force: true });
        } else {
          fs.writeFileSync(allowlistPath, allowlistPrior);
        }
        if (fleetRunId) {
          const cancel = shOut(
            `cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts cancel --driver exedev ${JSON.stringify(fleetRunId)}`,
            300_000,
          );
          if (cancel.exitCode !== 0) {
            // biome-ignore lint/correctness/noUnsafeFinally: deliberate — a failed cleanup cancel must not pass silently, even if it masks a prior assert
            throw new Error(
              `SC2.7 cleanup: fleet cancel ${fleetRunId} failed (exit ${cancel.exitCode}): ${(cancel.stderr || cancel.stdout).slice(-800)}`,
            );
          }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }

      // ── final guard: the fleet is empty of this round's boxes ──
      const leftover = boxNames().filter((n) => !before.includes(n));
      assert.equal(leftover.length, 0, `SC2.7 LEAK: boxes still alive after the round: ${leftover.join(", ")}`);
    },
    46 * 60_000,
  );
});
