import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { liveTodoOff } from "./live-harness";
import { Database } from "bun:sqlite";
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
 *               exec fires (the wrapper holds the exec in a sleep). Restart →
 *               the engine replays the SAME --request-id → Q1's O_EXCL intent
 *               maps the replay onto one fresh run → exactly one box.
 *   window (b): SIGKILL after the fleet submit COMPLETED (box exists, the
 *               wrapper holds the exit) but BEFORE the ack persist. Restart →
 *               the replay re-asks with the SAME id → Q1 returns the EXISTING
 *               run → still exactly one box.
 *
 * live-mirror: sc2-6 (the whole file is the SC2.6 live round; per-line mirror
 * comments below mark the substrate-touching lines for the #210 sweep).
 *
 * Spend protocol: worst case printed in the spend-estimate test below; every
 * artifact is torn down in `finally`-shaped guards (fleet cancel → box
 * destroyed + key revoked → `ssh exe.dev ls --json` empty, zero sbx- keys).
 */

const QDS_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const SWARM_WORKTREE = process.env.SC2_SWARM_WORKTREE ?? "/Users/steve/swarmclaw-worktrees/sc2-live";
const REPO_URL = process.env.QDS_EXEDEV_REPO_URL ?? "https://github.com/Quantum-Digital-Solutions/QDS-Factory.git";
const REPO_SHA = process.env.QDS_EXEDEV_SHA ?? "";
const MANIFEST_PATH = process.env.SC2_MANIFEST_PATH ?? "config/rosters/df53-demo.pipeline.json";
const GROUP_CAP_USD = 0.5;

/** live-mirror: sc2-6 — worst-case spend estimate, printed BEFORE any box exists. */
const WORST_CASE_USD = GROUP_CAP_USD + 0.1; // group cap bounds model spend; box-hours for ≤1h alive

function sh(cmd: string, timeoutMs = 60_000): string {
  // live-mirror: sc2-6 — every ssh/CLI call here drives the real substrate
  return Bun.spawnSync(["/bin/bash", "-c", cmd], { timeout: timeoutMs, stdout: "pipe", stderr: "pipe" }).stdout.toString();
}

/** live-mirror: sc2-6 — the real box listing (count + names). */
function fleetBoxes(): Array<{ name: string }> {
  const out = sh("ssh exe.dev ls --json");
  const parsed = JSON.parse(out) as { vms?: Array<{ name?: string; vm_name?: string }> };
  // the ls schema carries vm_name, not name (round 6: the count assert held
  // but evidence recorded null names)
  return (parsed.vms ?? []).map((v) => ({ name: v.vm_name ?? v.name ?? "" }));
}

function boxNames(): string[] {
  return fleetBoxes().map((v) => v.name);
}

interface WrapperLine {
  verb: string;
  requestId: string | null;
  /** launch = the wrapper started; exec = the inner CLI actually ran; killed-preexec = window (a) hold released by the kill marker. */
  phase?: string;
  rc?: number;
}

/** The wrapper journal: one line per fleet-CLI invocation the daemon made. */
function wrapperJournal(dir: string): WrapperLine[] {
  const p = path.join(dir, "wrapper-journal.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as WrapperLine);
}

/** Poll until pred() or deadline; 100ms cadence. */
async function pollUntil<T>(pred: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

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

const lifecycle = await import(${JSON.stringify(SWARM_WORKTREE) } + "/src/lib/server/protocols/protocol-run-lifecycle");
const normalization = await import(${JSON.stringify(SWARM_WORKTREE)} + "/src/lib/server/protocols/protocol-normalization");
const unwrap = (m) => (m && typeof m === "object" && "default" in m ? m.default : m);
const lifecycleU = unwrap(lifecycle);
const normU = unwrap(normalization);
const storage = unwrap(await import("/Users/steve/swarmclaw-worktrees/sc2-live" + "/src/lib/server/storage"));
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
          // issueId, not workId: the cost ledger's admission refuses non-numeric
          // budget keys (assertCanonicalIdentity) — no headless workId dispatch
          // has ever booked spend (filed as #380; SC2.6 round 3 was the first
          // live headless attempt and it exposed exactly this).
          issueId: 380,
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
if (restarting) {
  const factory = unwrap(await import(${JSON.stringify(SWARM_WORKTREE)} + "/src/lib/server/protocols/protocol-factory"));
  const pollTimer = setInterval(() => { factory.pollFactoryRuns().catch(() => {}); }, 2000);
}

// Heartbeat: print the factory entry state until killed or externally done.
const loadRun = (id) => normU.loadProtocolRunById(id);
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  const current = loadRun(runId);
  const entry = current?.factoryState?.fj ?? null;
  const line = JSON.stringify({ t: Date.now(), runStatus: current?.status ?? null, entryStatus: entry?.status ?? null, runId: entry?.runId ?? null });
  fs.appendFileSync(${JSON.stringify(path.join(dir, "daemon-heartbeat.jsonl"))}, line + "\\n");
  if (entry && (entry.status === "completed" || entry.status === "failed" || entry.status === "cancelled")) {
    console.log("ENTRY-TERMINAL " + entry.status);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("DAEMON-DEADLINE");
process.exit(3);
`;
}

/**
 * The fleet-CLI wrapper: journals every invocation (launch vs exec phases),
 * holds the crash windows open, and supplies the driver the daemon's contract
 * deliberately does not carry (SC2: swarmclaw never learns QDS's driver
 * grammar — the deployed shim is where `--driver exedev` lives; measured
 * 2026-09-29: daemon argv without it is exit-2 "submit requires --driver",
 * and `fleet cancel` needs it too while `fleet result` refuses nothing).
 * Every inner exec runs from QDS_ROOT so bun auto-loads the repo .env
 * (OPENROUTER_PROVISIONING_KEY; live-harness gotcha #1) — the daemon's cwd
 * is the swarmclaw worktree.
 *
 * Crash-window hold is a KILL-MARKER poll, not a fixed sleep: proc.kill(9)
 * on the daemon does NOT kill this execFile child (measured: the orphan
 * completed its work after the kill), so the test writes the marker first
 * and the wrapper exits ≤100ms later, before the daemon dies.
 */
function wrapperScript(dir: string): string {
  const journal = JSON.stringify(path.join(dir, "wrapper-journal.jsonl"));
  return `#!/bin/bash
set -u
verb="$1"; shift
jid=""; a=()
while [ $# -gt 0 ]; do
  if [ "$1" = "--request-id" ]; then jid="$2"; shift 2; else a+=("$1"); shift; fi
done
J=${journal}
KILL_MARKER=${JSON.stringify(path.join(dir, "wrapper-kill.marker"))}
printf '{"verb":"%s","requestId":"%s","phase":"launch"}\\n' "$verb" "$jid" >> "$J"
MODE_FILE=${JSON.stringify(path.join(dir, "wrapper-mode"))}
MODE="$(cat "$MODE_FILE" 2>/dev/null || echo normal)"
if [ "$verb" != "submit" ]; then
  cd ${JSON.stringify(QDS_ROOT)}
  if [ "$verb" = "cancel" ]; then
    exec bun scripts/fleet.ts cancel --driver exedev "\${a[@]}"
  fi
  exec bun scripts/fleet.ts "$verb" "\${a[@]}"
fi
if [ "$MODE" = "a" ]; then
  # window (a): hold BEFORE the exec fires — the daemon gets killed mid-hold.
  # On the marker do NOT exit promptly: an exit hands the daemon's execFile
  # callback a refusal (99) and it marks the step FAILED — terminal, so the
  # restart never replays (measured live 2026-09-29). Hold past the kill
  # instead: the daemon dies at +400ms, this orphan exits 99 to nobody.
  for i in $(seq 250); do
    if [ -f "$KILL_MARKER" ]; then
      printf '{"verb":"submit","requestId":"%s","phase":"killed-preexec"}\\n' "$jid" >> "$J"
      sleep 5
      exit 99
    fi
    sleep 0.1
  done
fi
cd ${JSON.stringify(QDS_ROOT)}
out="$(bun scripts/fleet.ts submit --driver exedev --request-id "$jid" "\${a[@]}")"
rc=$?
printf '{"verb":"submit","requestId":"%s","phase":"exec","rc":%s}\\n' "$jid" "$rc" >> "$J"
# The inner CLI's stdout tail survives every kill for post-hoc triage (the
# daemon never sees wrapper stdout, so this file is the only witness).
printf '%s\\n' "$out" | tail -c 600 > ${JSON.stringify(path.join(dir, "wrapper-submit-last.txt"))}
echo "rc=$rc" >> ${JSON.stringify(path.join(dir, "wrapper-submit-last.txt"))}
if [ "$MODE" = "b" ]; then
  # window (b): the real submit COMPLETED (box exists); hold the exit so the
  # daemon is killed after the exec, before the ack persist. Same rule as (a):
  # never return while the daemon can still process the exit code.
  printf 'cli-exited\\n' >> ${JSON.stringify(path.join(dir, "wrapper-exited.marker"))}
  for i in $(seq 250); do
    if [ -f "$KILL_MARKER" ]; then sleep 5; exit 99; fi
    sleep 0.1
  done
fi
printf '%s\\n' "$out"
exit $rc
`;
}

/**
 * Read the swarmclaw run record's factory entry straight out of its storage.
 * swarmclaw persists protocol runs in SQLITE (<leg>/swarm-data/swarmclaw.db,
 * table protocol_runs, cols id + data-JSON) — NOT json files (measured
 * 2026-09-29: the file-based readEntry never saw the persist and window (a)
 * red'd on it). Readonly open is safe against a live writer; after a SIGKILL
 * the readonly read is still the right shape (live-harness gotcha #20: never
 * WRITE-open a killed writer's db in this process). A busy/mid-checkpoint
 * read surfaces as nulls so the poller treats it as "not yet".
 */
function readEntry(dir: string, runId: string): { status: string | null; runId: string | null; requestId: string | null; lastError: string | null } {
  const nulls = { status: null, runId: null, requestId: null, lastError: null };
  const dbPath = path.join(dir, "swarm-data", "swarmclaw.db");
  if (!fs.existsSync(dbPath)) return nulls;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT data FROM protocol_runs WHERE id = ?").get(runId) as { data: string } | null;
    if (!row) return nulls;
    const run = JSON.parse(row.data) as {
      factoryState?: Record<string, { status?: string; runId?: string | null; requestId?: string; lastError?: string }>;
    };
    const entry = run.factoryState?.fj ?? {};
    return { status: entry.status ?? null, runId: entry.runId ?? null, requestId: entry.requestId ?? null, lastError: entry.lastError ?? null };
  } catch {
    return nulls;
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

function spawnDaemon(dir: string): Bun.Subprocess {
  const script = path.join(dir, "sc2-daemon.mts");
  // detached: tsx is a bootstrap that SPAWNS the real daemon node process —
  // without detached+group-kill, proc.kill(9) takes the tsx wrapper only and
  // the daemon survives as an orphan (measured round 3: it processed the
  // wrapper's exit code at +5s, marked the step FAILED — terminal — and the
  // restart never replayed). As a group leader, the whole tree (tsx → daemon
  // → wrapper) dies on one negative-pid kill.
  return Bun.spawn(["./node_modules/.bin/tsx", script], {
    cwd: SWARM_WORKTREE,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });
}

/**
 * Kill handshake: the wrapper's hold is a KILL-MARKER poll (100ms cadence),
 * so the marker goes down FIRST and the wrapper exits before proc.kill(9)
 * lands on the daemon — the kill alone orphans the execFile child (measured
 * 2026-09-29: the orphaned wrapper completed its work after the kill).
 */
async function killDaemon(dir: string, proc: Bun.Subprocess): Promise<void> {
  try {
    fs.writeFileSync(path.join(dir, "wrapper-kill.marker"), "kill\n");
  } catch {
    /* noop */
  }
  await new Promise((r) => setTimeout(r, 400)); // > the wrapper's 100ms poll cadence
  // Group kill first (the tree: tsx → daemon → wrapper); fall back to the
  // direct kill if the child is not a group leader or is already gone.
  let killed = false;
  try {
    process.kill(-(proc.pid ?? 0), "SIGKILL");
    killed = true;
  } catch {
    /* not a group leader / already gone */
  }
  if (!killed) {
    try {
      proc.kill(9);
    } catch {
      /* already gone */
    }
  }
  try {
    proc.unref();
  } catch {
    /* noop */
  }
}

/** Scrub check: the evidence write self-fails if a key material survives. */
function assertNoSecrets(obj: unknown): void {
  const s = JSON.stringify(obj) ?? "";
  if (s.includes("sk-or-")) throw new Error("evidence scrub: sk-or- survived");
}

function writeEvidence(name: string, payload: unknown): void {
  assertNoSecrets(payload);
  const dir = path.join(QDS_ROOT, "_bmad-output", "evidence", "openrig-sc2");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(dir, `${stamp}-${name}.json`), JSON.stringify(payload, null, 2));
}

describe("SC2.6 lease/kill live round (swarmclaw daemon × QDS fleet)", () => {
  test.todoIf(!process.env.QDS_E2E_LIVE)("spend estimate printed before any box exists", () => {
    console.log(
      `SC2.6 worst-case spend: 1 box (≤1h alive, canceled within minutes) + group cap $${GROUP_CAP_USD.toFixed(2)} model ceiling + headroom = ≤ $${WORST_CASE_USD.toFixed(2)}; realistic < $0.10. One sbx- key minted, revoked by the fleet cancel.`,
    );
    assert.equal(typeof REPO_SHA, "string");
    assert.ok(REPO_SHA.length === 40, `QDS_EXEDEV_SHA must be a full sha (got ${REPO_SHA.length} chars)`);
  });

  test("daemon driver self-check (offline, no box)", () => {
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

      // ── attempt 1: persist, then killed mid-wrapper-sleep ──
      const daemonA = spawnDaemon(dir);
      const persisted = await pollUntil(() => {
        const runId = fs.existsSync(path.join(dir, "run-id.txt"))
          ? fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim()
          : null;
        if (!runId) return null;
        const entry = readEntry(dir, runId);
        return entry.status === "submitting" && entry.requestId ? { runId, requestId: entry.requestId } : null;
      }, 60_000);
      assert.ok(persisted, "window (a): the requestId never persisted before the kill window closed");
      await killDaemon(dir, daemonA);
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
      const daemonB = spawnDaemon(dir);
      const submitted = await pollUntil(() => {
        const runId = fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim();
        const entry = readEntry(dir, runId);
        return entry.status === "submitted" && entry.runId ? entry : null;
      }, 480_000); // a real provision (box + key + engine start + ack) measured > 60s and up to minutes
      assert.ok(submitted, "window (a): the replay never reached 'submitted'");
      await killDaemon(dir, daemonB);

      const submits = wrapperJournal(dir).filter((l) => l.verb === "submit" && l.phase === "exec");
      assert.equal(submits.length, 1, "exactly one fleet submit exec across both attempts");
      assert.equal(submits[0]?.requestId, persisted?.requestId, "the replay carried the SAME --request-id");

      // ── exactly ONE box ──
      const after = boxNames();
      const fresh = after.filter((n) => !before.includes(n));
      assert.equal(fresh.length, 1, `exactly one box must exist after the crash-replay; saw ${fresh.length}: ${fresh.join(", ")}`);

      writeEvidence("sc2-6-window-a", {
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
      const cancelOutA = sh(
        `cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts cancel --driver exedev ${JSON.stringify(submitted?.runId ?? "")}`,
        300_000,
      );
      const emptiedA = await pollUntil(() => (boxNames().filter((n) => !before.includes(n)).length === 0 ? true : null), 180_000);
      assert.ok(emptiedA, `window (a) teardown: boxes still alive after fleet cancel: ${boxNames().join(", ")}`);
      writeEvidence("sc2-6-window-a-teardown", { cancelStdout: cancelOutA.slice(0, 400), boxesAfterCancel: boxNames() });
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

      // ── attempt 1: real submit completes (box exists), killed holding the exit ──
      const daemonA = spawnDaemon(dir);
      const boxAppeared = await pollUntil(() => {
        const marker = fs.existsSync(path.join(dir, "wrapper-exited.marker"));
        if (!marker) return null;
        const now = boxNames();
        return now.length > before.length ? now : null;
      }, 480_000); // the submit exec may run to the 300s adapter ceiling before its marker
      assert.ok(boxAppeared, "window (b): the real fleet submit never produced a box before the kill window closed");
      const runId = fs.readFileSync(path.join(dir, "run-id.txt"), "utf8").trim();
      const entryAtKill = readEntry(dir, runId);
      assert.equal(entryAtKill.status, "submitting", "window (b): the ack persist must NOT have landed before the kill");
      const requestId = entryAtKill.requestId;
      assert.ok(requestId, "window (b): requestId must be durable at the kill");
      await killDaemon(dir, daemonA);
      await new Promise((r) => setTimeout(r, 500));

      // ── restart: replay the SAME id; Q1 returns the EXISTING run ──
      fs.writeFileSync(path.join(dir, "wrapper-mode"), "normal");
      const daemonB = spawnDaemon(dir);
      const submitted = await pollUntil(() => {
        const entry = readEntry(dir, runId);
        return entry.status === "submitted" && entry.runId ? entry : null;
      }, 180_000);
      assert.ok(submitted, "window (b): the replay never reached 'submitted'");
      await killDaemon(dir, daemonB);

      const submits = wrapperJournal(dir).filter((l) => l.verb === "submit" && l.phase === "exec");
      assert.equal(submits.length, 2, "window (b): two submit execs (original + replay) expected");
      assert.equal(submits[0]?.requestId, requestId, "window (b): original carried the --request-id");
      assert.equal(submits[1]?.requestId, requestId, "window (b): replay carried the SAME --request-id");

      // ── STILL exactly one box (the replay mapped onto the EXISTING run) ──
      const after = boxNames();
      const fresh = after.filter((n) => !before.includes(n));
      assert.equal(fresh.length, 1, `exactly one box must survive the (b) crash-replay; saw ${fresh.length}: ${fresh.join(", ")}`);

      writeEvidence("sc2-6-window-b", {
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
      const cancelOut = sh(
        // --driver exedev: `fleet cancel` refuses without it (measured 2026-09-29,
        // exit 2 "cancel requires --driver") — same seam rule as the wrapper.
        `cd ${JSON.stringify(QDS_ROOT)} && bun scripts/fleet.ts cancel --driver exedev ${JSON.stringify(submitted?.runId ?? "")}`,
        300_000,
      );
      const emptied = await pollUntil(() => (boxNames().filter((n) => !before.includes(n)).length === 0 ? true : null), 180_000);
      assert.ok(emptied, `teardown: boxes still alive after fleet cancel: ${boxNames().join(", ")}`);
      writeEvidence("sc2-6-window-b-teardown", { cancelStdout: cancelOut.slice(0, 400), boxesAfterCancel: boxNames() });
    },
    25 * 60_000,
  );

  test("final guard: the fleet is empty of this round's boxes", () => {
    // live-mirror: sc2-6 — the round's final guard: the fleet must be empty.
    const names = boxNames();
    assert.equal(names.length, 0, `SC2.6 LEAK: boxes still alive after the round: ${names.join(", ")}`);
  });
});
