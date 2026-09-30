import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { liveTodoOff } from "./live-harness";
import {
  boxNames,
  killDaemon,
  MANIFEST_PATH,
  pollUntil,
  QDS_ROOT,
  REPO_SHA,
  REPO_URL,
  readEntry,
  shOut,
  spawnDaemon,
  SWARM_WORKTREE,
  wrapperJournal,
  wrapperScript,
  writeEvidence,
} from "./sc2-harness";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * SC2.6 — the lease/kill live round (roadmap Stage SC2.6; SC1.6's live proof).
 *
 * NOT a harness tier: the box under test is created BY the QDS fleet CLI on
 * behalf of a REAL swarmclaw daemon (code ⊇ PR #644, worktree checkout at the
 * merged dev eafe5dc9), whose external_job step shells out to
 * $SWARMCLAW_FACTORY_FLEET_CLI. The round kills the daemon inside BOTH crash
 * windows and proves the replay yields EXACTLY ONE box + one key:
 *
 *   window (a): SIGKILL after the requestId persist, BEFORE the fleet-submit
 *               exec fires (the wrapper holds the exec). Restart → the engine
 *               replays the SAME --request-id → Q1's O_EXCL intent maps the
 *               replay onto one fresh run → exactly one box.
 *   window (b): SIGKILL after the fleet submit COMPLETED (box exists, the
 *               wrapper holds the exit) but BEFORE the ack persist. Restart →
 *               the replay re-asks with the SAME id → Q1 returns the EXISTING
 *               run → still exactly one box.
 *
 * live-mirror: sc2-6 (the whole file is the SC2.6 live round; the substrate-
 * touching helpers carry their mirror comments in sc2-harness.ts).
 *
 * Spend protocol: worst case printed in the spend-estimate test below; every
 * artifact is torn down in `finally`-shaped guards (fleet cancel → box
 * destroyed + key revoked → `ssh exe.dev ls --json` empty, zero sbx- keys).
 */

const GROUP_CAP_USD = 0.5;

/** live-mirror: sc2-6 — worst-case spend estimate, printed BEFORE any box exists. */
const WORST_CASE_USD = GROUP_CAP_USD + 0.1; // group cap bounds model spend; box-hours for ≤1h alive

/**
 * The daemon driver script, written into the swarmclaw worktree at runtime.
 * Gotcha #18: imports are explicit and counted; the test smoke-runs it
 * (`--self-check`) before any live leg.
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
    title: "SC2.6 self-check", templateId: "custom",
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
    title: "SC2.6 lease-kill",
    templateId: "custom",
    steps: [
      {
        id: "fj",
        kind: "external_job",
        label: "Factory run",
        externalJobConfig: {
          repoSlug: "Quantum-Digital-Solutions/QDS-Factory",
          repoUrl: ${JSON.stringify(REPO_URL)},
          commitSha: ${JSON.stringify(REPO_SHA)},
          manifestPath: ${JSON.stringify(MANIFEST_PATH)},
          // workId, per #380 landed: the ledger's sanctioned work-key namespace
          // (w:<id>, correlation-minted) books headless spend, so the round
          // runs the shape it exists to prove — issueless macro work. The old
          // numeric-issueId: 380 workaround is retired.
          workId: "sc26-lease-kill",
          groupCapUsd: ${GROUP_CAP_USD},
        },
      },
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

// Production runs pollFactoryRuns on the heartbeat-service tick, and BOTH
// crash windows own their recovery to that tick: an orphaned 'submitting'
// entry replays through pollFactoryRunsInner (F-016). The daemon under test
// ticks it ONLY on the restart path (run-id.txt pre-existed): attempt 1's
// submit is driven by requestProtocolRunExecution, and a tick during that
// in-flight exec would replay-race it (no guard exists between the direct
// call and the poller — measured round 4: no tick anywhere, so the restart
// sat 'submitting' until the poll ceiling).
const HEARTBEAT = ${JSON.stringify(path.join(dir, "daemon-heartbeat.jsonl"))};
// P11a: the poll timer is hoisted so every exit path below can clear it, and a
// rejected pollFactoryRuns is WITNESSED in the heartbeat file, not swallowed —
// the heartbeat jsonl is the daemon's only observable log channel.
let pollTimer = null;
if (restarting) {
  const factory = unwrap(await import(${JSON.stringify(SWARM_WORKTREE)} + "/src/lib/server/protocols/protocol-factory"));
  pollTimer = setInterval(() => {
    factory.pollFactoryRuns().catch((err) => {
      fs.appendFileSync(HEARTBEAT, JSON.stringify({ t: Date.now(), pollError: String(err && err.message ? err.message : err) }) + "\\n");
    });
  }, 2000);
}

// Heartbeat: print the factory entry state until killed or externally done.
const loadRun = (id) => normU.loadProtocolRunById(id);
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  // P11a: one thrown sqlite read must not kill the daemon mid-provision —
  // both crash windows own their recovery to this heartbeat staying alive.
  try {
    const current = loadRun(runId);
    const entry = current?.factoryState?.fj ?? null;
    const line = JSON.stringify({ t: Date.now(), runStatus: current?.status ?? null, entryStatus: entry?.status ?? null, runId: entry?.runId ?? null });
    fs.appendFileSync(HEARTBEAT, line + "\\n");
    if (entry && (entry.status === "completed" || entry.status === "failed" || entry.status === "cancelled")) {
      console.log("ENTRY-TERMINAL " + entry.status);
      if (pollTimer) clearInterval(pollTimer);
      process.exit(0);
    }
  } catch (e) {
    fs.appendFileSync(HEARTBEAT, JSON.stringify({ t: Date.now(), heartbeatError: String(e && e.message ? e.message : e) }) + "\\n");
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("DAEMON-DEADLINE");
if (pollTimer) clearInterval(pollTimer);
process.exit(3);
`;
}

describe("SC2.6 lease/kill live round (swarmclaw daemon × QDS fleet)", () => {
  test.todoIf(!process.env.QDS_E2E_LIVE)("spend estimate printed before any box exists", () => {
    console.log(
      `SC2.6 worst-case spend: 1 box (≤1h alive, canceled within minutes) + group cap $${GROUP_CAP_USD.toFixed(2)} model ceiling + headroom = ≤ $${WORST_CASE_USD.toFixed(2)}; realistic < $0.10. One sbx- key minted, revoked by the fleet cancel.`,
    );
    assert.equal(typeof REPO_SHA, "string");
    assert.ok(REPO_SHA.length === 40, `QDS_EXEDEV_SHA must be a full sha (got ${REPO_SHA.length} chars)`);
  });

  test.todoIf(liveTodoOff())("daemon driver self-check (offline, no box)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc26-selfcheck-"));
    fs.writeFileSync(path.join(dir, "sc2-daemon.mts"), daemonScript(dir));
    // The wrapper is a generated bash script — lint its syntax before any leg
    // trusts it (live-harness gotcha #18's shape, for the non-TS arm).
    fs.writeFileSync(path.join(dir, "fleet-wrapper.sh"), wrapperScript(dir), { mode: 0o755 });
    const bashn = Bun.spawnSync(["/bin/bash", "-n", path.join(dir, "fleet-wrapper.sh")]);
    assert.equal(bashn.exitCode, 0, `wrapper template failed bash -n: ${bashn.stderr.toString().slice(0, 400)}`);
    const rendered = fs.readFileSync(path.join(dir, "fleet-wrapper.sh"), "utf8");
    assert.ok(
      rendered.includes("--driver exedev"),
      "wrapper template lost the --driver seam (the daemon's contract deliberately omits it)",
    );
    assert.ok(!rendered.includes("undefined"), "wrapper template has an uninterpolated placeholder");
    const errFile = path.join(dir, "self-check.stderr");
    const errFd = fs.openSync(errFile, "w");
    const out = Bun.spawnSync(["./node_modules/.bin/tsx", path.join(dir, "sc2-daemon.mts"), "--self-check"], {
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
  }, 60_000); // tsx cold-start of the swarmclaw graph measured ~10s

  test.todoIf(liveTodoOff())(
    "window (a): kill after persist, before exec — restart replays the SAME id, exactly one box",
    async () => {
      const before = boxNames();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc26-winA-"));
      fs.writeFileSync(path.join(dir, "sc2-daemon.mts"), daemonScript(dir));
      fs.writeFileSync(path.join(dir, "fleet-wrapper.sh"), wrapperScript(dir), { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "wrapper-mode"), "a");

      // P1: any assert below can throw mid-leg — the daemon and the billable
      // box are torn down in finally, never left to the happy path.
      let fleetRunId = "";
      let liveDaemon: Bun.Subprocess | undefined;
      try {
        assert.match(REPO_SHA, /^[0-9a-f]{40}$/, "QDS_EXEDEV_SHA must be a full 40-hex sha before any live leg runs");

        // ── attempt 1: persist, then killed mid-wrapper-sleep ──
        liveDaemon = spawnDaemon(dir);
        const persisted = await pollUntil(() => {
          const runId = fs.existsSync(path.join(dir, "run-id.txt"))
            ? fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim()
            : null;
          if (!runId) return null;
          const entry = readEntry(dir, runId);
          return entry.status === "submitting" && entry.requestId ? { runId, requestId: entry.requestId } : null;
        }, 60_000);
        assert.ok(persisted, "window (a): the requestId never persisted before the kill window closed");
        await killDaemon(dir, liveDaemon);
        liveDaemon = undefined;
        // exec-phase lines only: the wrapper journals "launch" the moment it
        // starts (before its hold), so a launch line is EXPECTED here — the
        // assert is that the inner CLI never ran.
        const journalAfterKill = wrapperJournal(dir).filter((l) => l.verb === "submit" && l.phase === "exec");
        assert.equal(
          journalAfterKill.length,
          0,
          "window (a): the fleet-submit exec must NOT have fired before the kill (the wrapper holds it)",
        );

        // ── restart: replay with the SAME id; the wrapper's sleep is done (mode flipped) ──
        fs.writeFileSync(path.join(dir, "wrapper-mode"), "normal");
        liveDaemon = spawnDaemon(dir);
        const submitted = await pollUntil(() => {
          const runId = fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim();
          const entry = readEntry(dir, runId);
          return entry.status === "submitted" && entry.runId ? entry : null;
        }, 480_000); // a real provision (box + key + engine start + ack) measured > 60s and up to minutes
        fleetRunId = submitted?.runId ?? ""; // arm ownership BEFORE any assert can throw
        assert.ok(submitted, "window (a): the replay never reached 'submitted'");
        await killDaemon(dir, liveDaemon);
        liveDaemon = undefined;

        const submits = wrapperJournal(dir).filter((l) => l.verb === "submit" && l.phase === "exec");
        assert.equal(submits.length, 1, "exactly one fleet submit exec across both attempts");
        assert.equal(submits[0]?.requestId, persisted?.requestId, "the replay carried the SAME --request-id");

        // ── exactly ONE box ──
        const after = boxNames();
        const fresh = after.filter((n) => !before.includes(n));
        assert.equal(fresh.length, 1, `exactly one box must exist after the crash-replay; saw ${fresh.length}: ${fresh.join(", ")}`);

        writeEvidence("sc2-6", "window-a", {
          window: "a",
          requestId: submitted?.requestId,
          fleetRunId: submitted?.runId,
          submitExecs: submits.length,
          replaySameId: submits[0]?.requestId === persisted?.requestId,
          boxesBefore: before,
          boxesAfter: after,
          freshBoxes: fresh,
          fjLastError: readEntry(dir, fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim()).lastError,
        });

        // ── teardown: window (a) cancels ITS OWN box — the final guard can only
        // hold if every window cleans up after itself (round 3 exposed the gap:
        // only (b) canceled, so (a)'s box would have leaked into the guard). ──
        const cancelOutA = shOut(
          `cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts cancel --driver exedev ${JSON.stringify(submitted?.runId ?? "")}`,
          300_000,
        );
        assert.equal(
          cancelOutA.exitCode,
          0,
          `window (a) teardown: fleet cancel failed (exit ${cancelOutA.exitCode}): ${cancelOutA.stderr.slice(-400)}`,
        );
        const emptiedA = await pollUntil(() => (boxNames().filter((n) => !before.includes(n)).length === 0 ? true : null), 180_000);
        assert.ok(emptiedA, `window (a) teardown: boxes still alive after fleet cancel: ${boxNames().join(", ")}`);
        writeEvidence("sc2-6", "window-a-teardown", { cancelStdout: cancelOutA.stdout.slice(0, 400), boxesAfterCancel: boxNames() });
      } finally {
        if (liveDaemon) await killDaemon(dir, liveDaemon);
        // SC2.4 idempotent cancel: a harmless no-op when the in-body teardown
        // already canceled; the backstop when anything above threw.
        if (fleetRunId) {
          const c = shOut(
            `cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts cancel --driver exedev ${JSON.stringify(fleetRunId)}`,
            300_000,
          );
          if (c.exitCode !== 0) {
            // biome-ignore lint/correctness/noUnsafeFinally: a failed cleanup cancel means a live box is still billing — it must supersede the body's error, not be lost to it
            throw new Error(`window (a) cleanup: fleet cancel failed (exit ${c.exitCode}): ${c.stderr.slice(-400)}`);
          }
        }
        // P26: the tmpdir holds an UNSCRUBBED submit-stdout tail — it must not
        // outlive the leg in either outcome.
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    20 * 60_000,
  );

  test.todoIf(liveTodoOff())(
    "window (b): kill after the exec, before the ack persist — restart re-asks the SAME id, still one box",
    async () => {
      const before = boxNames();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc26-winB-"));
      fs.writeFileSync(path.join(dir, "sc2-daemon.mts"), daemonScript(dir));
      fs.writeFileSync(path.join(dir, "fleet-wrapper.sh"), wrapperScript(dir), { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "wrapper-mode"), "b");

      // P1: any assert below can throw mid-leg — the daemon and the billable
      // box are torn down in finally, never left to the happy path.
      let fleetRunId = "";
      let liveDaemon: Bun.Subprocess | undefined;
      try {
        assert.match(REPO_SHA, /^[0-9a-f]{40}$/, "QDS_EXEDEV_SHA must be a full 40-hex sha before any live leg runs");

        // ── attempt 1: real submit completes (box exists), killed holding the exit ──
        liveDaemon = spawnDaemon(dir);
        const boxAppeared = await pollUntil(() => {
          const marker = fs.existsSync(path.join(dir, "wrapper-exited.marker"));
          if (!marker) return null;
          const now = boxNames();
          return now.length > before.length ? now : null;
        }, 480_000); // the submit exec may run to the 300s adapter ceiling before its marker
        assert.ok(boxAppeared, "window (b): the real fleet submit never produced a box before the kill window closed");
        const runId = fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim();
        // P8: short retry poll, not a one-shot read — a transient sqlite-busy
        // read surfaces as nulls, which must not fail the leg after the box
        // already exists. 5s is far inside the mode-b hold, so a GENUINE ack
        // landing still fails the assert.
        const entryAtKill = await pollUntil(() => {
          const e = readEntry(dir, runId);
          return e.status === "submitting" && e.requestId ? e : null;
        }, 5_000);
        assert.ok(entryAtKill, "window (b): the ack persist must NOT have landed before the kill (or the entry read kept failing)");
        const requestId = entryAtKill?.requestId ?? "";
        await killDaemon(dir, liveDaemon);
        liveDaemon = undefined;
        await new Promise((r) => setTimeout(r, 500));

        // ── restart: replay the SAME id; Q1 returns the EXISTING run ──
        fs.writeFileSync(path.join(dir, "wrapper-mode"), "normal");
        liveDaemon = spawnDaemon(dir);
        const submitted = await pollUntil(() => {
          const entry = readEntry(dir, runId);
          return entry.status === "submitted" && entry.runId ? entry : null;
        }, 180_000);
        fleetRunId = submitted?.runId ?? ""; // arm ownership BEFORE any assert can throw
        assert.ok(submitted, "window (b): the replay never reached 'submitted'");
        await killDaemon(dir, liveDaemon);
        liveDaemon = undefined;

        const submits = wrapperJournal(dir).filter((l) => l.verb === "submit" && l.phase === "exec");
        assert.equal(submits.length, 2, "window (b): two submit execs (original + replay) expected");
        assert.equal(submits[0]?.requestId, requestId, "window (b): original carried the --request-id");
        assert.equal(submits[1]?.requestId, requestId, "window (b): replay carried the SAME --request-id");

        // ── STILL exactly one box (the replay mapped onto the EXISTING run) ──
        const after = boxNames();
        const fresh = after.filter((n) => !before.includes(n));
        assert.equal(fresh.length, 1, `exactly one box must survive the (b) crash-replay; saw ${fresh.length}: ${fresh.join(", ")}`);

        writeEvidence("sc2-6", "window-b", {
          window: "b",
          requestId,
          fleetRunId: submitted?.runId,
          submitExecs: submits.length,
          boxesBefore: before,
          boxesAfter: after,
          freshBoxes: fresh,
          fjLastError: readEntry(dir, runId).lastError,
        });

        // ── teardown: fleet cancel destroys the box + revokes the key ──
        const cancelOut = shOut(
          // --driver exedev: `fleet cancel` refuses without it (measured 2026-09-29,
          // exit 2 "cancel requires --driver") — same seam rule as the wrapper.
          `cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts cancel --driver exedev ${JSON.stringify(submitted?.runId ?? "")}`,
          300_000,
        );
        assert.equal(
          cancelOut.exitCode,
          0,
          `teardown: fleet cancel failed (exit ${cancelOut.exitCode}): ${cancelOut.stderr.slice(-400)}`,
        );
        const emptied = await pollUntil(() => (boxNames().filter((n) => !before.includes(n)).length === 0 ? true : null), 180_000);
        assert.ok(emptied, `teardown: boxes still alive after fleet cancel: ${boxNames().join(", ")}`);
        writeEvidence("sc2-6", "window-b-teardown", { cancelStdout: cancelOut.stdout.slice(0, 400), boxesAfterCancel: boxNames() });
      } finally {
        if (liveDaemon) await killDaemon(dir, liveDaemon);
        // SC2.4 idempotent cancel: a harmless no-op when the in-body teardown
        // already canceled; the backstop when anything above threw.
        if (fleetRunId) {
          const c = shOut(
            `cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts cancel --driver exedev ${JSON.stringify(fleetRunId)}`,
            300_000,
          );
          if (c.exitCode !== 0) {
            // biome-ignore lint/correctness/noUnsafeFinally: a failed cleanup cancel means a live box is still billing — it must supersede the body's error, not be lost to it
            throw new Error(`window (b) cleanup: fleet cancel failed (exit ${c.exitCode}): ${c.stderr.slice(-400)}`);
          }
        }
        // P26: the tmpdir holds an UNSCRUBBED submit-stdout tail — it must not
        // outlive the leg in either outcome.
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    25 * 60_000,
  );

  test.todoIf(liveTodoOff())("final guard: the fleet is empty of this round's boxes", () => {
    // live-mirror: sc2-6 — the round's final guard: the fleet must be empty.
    const names = boxNames();
    assert.equal(names.length, 0, `SC2.6 LEAK: boxes still alive after the round: ${names.join(", ")}`);
  });
});
