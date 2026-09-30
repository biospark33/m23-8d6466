/**
 * Shared harness for the SC2 live rounds (SC2.6 lease/kill, SC2.7 protocol
 * branch). NOT a tier file: the box under test is created BY the QDS fleet
 * CLI on behalf of a REAL swarmclaw daemon subprocess, so these helpers carry
 * the pieces every SC2 leg needs — the fleet-CLI wrapper (the deployed-shim
 * stand-in), sqlite run-state reads, the kill handshake, and the fleet
 * listing — with the live-mirror comments marking the substrate-touching
 * lines for the #210 static sweep.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const QDS_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
export const SWARM_WORKTREE = process.env.SC2_SWARM_WORKTREE ?? "/Users/steve/swarmclaw-worktrees/sc2-live";
export const REPO_URL = process.env.QDS_EXEDEV_REPO_URL ?? "https://github.com/Quantum-Digital-Solutions/QDS-Factory.git";
export const REPO_SHA = process.env.QDS_EXEDEV_SHA ?? "";
export const MANIFEST_PATH = process.env.SC2_MANIFEST_PATH ?? "config/rosters/df53-demo.pipeline.json";

export function shOut(
  cmd: string,
  timeoutMs = 60_000,
): { stdout: string; stderr: string; exitCode: number | null } {
  // live-mirror: sc2 — every ssh/CLI call here drives the real substrate
  const proc = Bun.spawnSync(["/bin/bash", "-c", cmd], { timeout: timeoutMs, stdout: "pipe", stderr: "pipe" });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
}

export function sh(cmd: string, timeoutMs = 60_000): string {
  return shOut(cmd, timeoutMs).stdout;
}

/** live-mirror: sc2 — the real box listing (count + names). */
export function fleetBoxes(): Array<{ name: string }> {
  const out = sh("ssh exe.dev ls --json");
  const parsed = JSON.parse(out) as { vms?: Array<{ name?: string; vm_name?: string }> };
  // the ls schema carries vm_name, not name (SC2.6 round 6: the count assert
  // held but evidence recorded null names)
  return (parsed.vms ?? []).map((v) => ({ name: v.vm_name ?? v.name ?? "" }));
}

export function boxNames(): string[] {
  return fleetBoxes().map((v) => v.name);
}

export interface WrapperLine {
  verb: string;
  requestId: string | null;
  /** launch = the wrapper started; exec = the inner CLI actually ran; killed-preexec = a hold released by the kill marker. */
  phase?: string;
  rc?: number;
}

/** The wrapper journal: one line per fleet-CLI invocation the daemon made. */
export function wrapperJournal(dir: string): WrapperLine[] {
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
export async function pollUntil<T>(pred: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // transient substrate errors (ssh blip, torn journal line) must retry,
    // not abort a 20-minute leg
    let v: T | null = null;
    try {
      v = pred();
    } catch {
      /* treat as "not yet" */
    }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
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
 * completed its work after the kill), so the test writes the marker first.
 * On the marker the hold does NOT exit promptly — an exit hands the daemon's
 * execFile callback a refusal (99) and it marks the step FAILED — terminal,
 * so a restart never replays (measured SC2.6 round 2). It holds 5s past the
 * marker instead: the daemon dies at +400ms (group kill), and this orphan
 * exits 99 to nobody, having exec'd nothing.
 */
export function wrapperScript(dir: string): string {
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
  for i in $(seq 250); do
    if [ -f "$KILL_MARKER" ]; then
      printf '{"verb":"submit","requestId":"%s","phase":"killed-preexec"}\\n' "$jid" >> "$J"
      sleep 5
      exit 99
    fi
    sleep 0.1
  done
  # Hold exhausted = the test died before delivering the kill marker; exit 99
  # marks the step FAILED so a restart never replays into an unwatched submit.
  printf '{"verb":"submit","requestId":"%s","phase":"hold-expired"}\\n' "$jid" >> "$J"
  exit 99
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
  # daemon is killed after the exec, before the ack persist.
  printf 'cli-exited\\n' >> ${JSON.stringify(path.join(dir, "wrapper-exited.marker"))}
  for i in $(seq 250); do
    if [ -f "$KILL_MARKER" ]; then sleep 5; exit 99; fi
    sleep 0.1
  done
  # Test dead before the kill marker → refusing the ack stops unsupervised
  # model spend; the already-provisioned box is bounded by its TTL and the
  # round's cancel-on-failure cleanup.
  printf '{"verb":"submit","requestId":"%s","phase":"hold-expired"}\\n' "$jid" >> "$J"
  exit 99
fi
printf '%s\\n' "$out"
exit $rc
`;
}

/**
 * Read the swarmclaw run record's factory entry straight out of its storage.
 * swarmclaw persists protocol runs in SQLITE (<leg>/swarm-data/swarmclaw.db,
 * table protocol_runs, cols id + data-JSON) — NOT json files (measured
 * 2026-09-29: a file-based read never saw the persist and window (a) red'd
 * on it). Readonly open is safe against a live writer; after a SIGKILL the
 * readonly read is still the right shape (live-harness gotcha #20: never
 * WRITE-open a killed writer's db in this process). A busy/mid-checkpoint
 * read surfaces as nulls so the poller treats it as "not yet".
 */
export function readEntry(
  dir: string,
  runId: string,
): { status: string | null; runId: string | null; requestId: string | null; lastError: string | null } {
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

/** Read the swarmclaw run row wholesale (status, artifacts, events need the raw record). */
export function readRunRow<T>(dir: string, runId: string): T | null {
  const dbPath = path.join(dir, "swarm-data", "swarmclaw.db");
  if (!fs.existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT data FROM protocol_runs WHERE id = ?").get(runId) as { data: string } | null;
    return row ? (JSON.parse(row.data) as T) : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

/** Read one protocol event row (protocol_run_events, cols id + data-JSON). */
export function readEvent<T>(dir: string, eventId: string): T | null {
  const dbPath = path.join(dir, "swarm-data", "swarmclaw.db");
  if (!fs.existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT data FROM protocol_run_events WHERE id = ?").get(eventId) as { data: string } | null;
    return row ? (JSON.parse(row.data) as T) : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

/** List a leg's protocol events for one run (newest last). */
export function readEventsFor<T>(dir: string, runId: string): T[] {
  const dbPath = path.join(dir, "swarm-data", "swarmclaw.db");
  if (!fs.existsSync(dbPath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query("SELECT data FROM protocol_run_events ORDER BY rowid ASC")
      .all() as Array<{ data: string }>;
    return rows
      .map((r) => JSON.parse(r.data) as T & { runId?: string })
      .filter((e) => e.runId === runId);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

export function spawnDaemon(dir: string, worktree = SWARM_WORKTREE): Bun.Subprocess {
  const script = path.join(dir, "sc2-daemon.mts");
  // detached: tsx is a bootstrap that SPAWNS the real daemon node process —
  // without detached+group-kill, proc.kill(9) takes the tsx wrapper only and
  // the daemon survives as an orphan (measured SC2.6 round 3). As a group
  // leader, the whole tree (tsx → daemon → wrapper) dies on one negative-pid
  // kill.
  return Bun.spawn(["./node_modules/.bin/tsx", script], {
    cwd: worktree,
    // the daemon journals to files; nobody drains these pipes — a full pipe
    // blocks the child silently mid-leg
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    detached: true,
  });
}

/**
 * Kill handshake: the wrapper's hold is a KILL-MARKER poll (100ms cadence),
 * so the marker goes down FIRST, the wrapper gets 400ms to see it, and the
 * GROUP kill then takes the whole tree (tsx → daemon → wrapper) at once —
 * nothing survives to process an exit code.
 */
export async function killDaemon(dir: string, proc: Bun.Subprocess): Promise<void> {
  try {
    fs.writeFileSync(path.join(dir, "wrapper-kill.marker"), "kill\n");
  } catch {
    /* noop */
  }
  await new Promise((r) => setTimeout(r, 400)); // > the wrapper's 100ms poll cadence
  let killed = false;
  // only a positive pid is a real group leader — a falsy pid would signal the
  // caller's own process group (-0)
  if (typeof proc.pid === "number" && proc.pid > 0) {
    try {
      process.kill(-proc.pid, "SIGKILL");
      killed = true;
    } catch {
      /* not a group leader / already gone */
    }
  }
  if (!killed) {
    try {
      proc.kill(9);
    } catch {
      /* already gone */
    }
  }
  // killDaemon runs in finally blocks: report a surviving tree, never throw —
  // throwing would mask the original failure.
  let timedOut = false;
  try {
    await Promise.race([
      proc.exited,
      new Promise<void>((r) => setTimeout(() => { timedOut = true; r(); }, 2000)),
    ]);
  } catch {
    /* noop */
  }
  if (timedOut) {
    console.error(`killDaemon: daemon tree still alive after SIGKILL (pid ${proc.pid})`);
  }
  try {
    proc.unref();
  } catch {
    /* noop */
  }
}

/** Scrub check: the evidence write self-fails if key material survives. */
function assertNoSecrets(obj: unknown): void {
  const s = JSON.stringify(obj) ?? "";
  if (s.includes("sk-or-")) throw new Error("evidence scrub: sk-or- survived");
  if (s.includes("sc27tok-")) throw new Error("evidence scrub: sc27tok- (approver token) survived");
}

export function writeEvidence(tag: string, name: string, payload: unknown): void {
  assertNoSecrets(payload);
  const dir = path.join(QDS_ROOT, "_bmad-output", "evidence", "openrig-sc2");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(dir, `${stamp}-${tag}-${name}.json`), JSON.stringify(payload, null, 2));
}
