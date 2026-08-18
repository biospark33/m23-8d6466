/**
 * End-to-end slice for `scripts/pipeline-run.ts` (Story DF1.1).
 *
 * The mandatory demo: a versioned manifest on disk drives an ordered, journaled
 * phase walk whose statuses were earned, using only code this story merges.
 * The runner is spawned for real, because the thing under test is the wiring
 * between the manifest, the walk and the process exit code.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readJournal } from "./journal-test-util.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "pipeline-run.ts");
const FIXTURE = path.join(import.meta.dir, "fixtures", "pipeline.qds-factory.json");

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df1-1-e2e-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
function workspace(): { dir: string; journal: string; markerRoot: string } {
  const dir = path.join(tmpRoot, `ws-${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    journal: path.join(dir, "out.json"),
    markerRoot: path.join(dir, "marker"),
  };
}

function spawnRunner(args: string[], markerRoot: string, cwd = REPO_ROOT) {
  return Bun.spawn({
    // `process.execPath`, not "bun": `bun test` runs every file in one process,
    // so a sibling suite that rewrites PATH must not decide which runtime this
    // spawns.
    cmd: [process.execPath, RUNNER, ...args],
    cwd,
    env: { ...process.env, QDS_RUN_ROOT: markerRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Polls rather than sleeping a fixed interval: a SIGKILLed process lingers as a
 * zombie until its new parent reaps it, and `kill(pid, 0)` still succeeds then.
 */
async function isGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

describe("pipeline-run e2e", () => {
  test("the fixture run exits 1 with plan=success, build=fail (E2E slice)", async () => {
    const ws = workspace();
    const proc = spawnRunner(
      ["--manifest", FIXTURE, "--budget-ms", "120000", "--journal", ws.journal, "--run-id", "e2e-run"],
      ws.markerRoot,
    );
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const journal = readJournal(ws.journal);
    expect(journal.version).toBe("1.0.0");
    expect(journal.ok).toBe(false);
    expect(journal.phases.map((p) => [p.name, p.status])).toEqual([
      ["plan", "success"],
      ["build", "fail"],
    ]);
    expect(journal.phases[1]?.exitStatus).toBe("logic");

    const marker = JSON.parse(fs.readFileSync(path.join(ws.markerRoot, "journal", "final.json"), "utf8"));
    expect(marker.runId).toBe("e2e-run");
    expect(marker.ok).toBe(false);
    expect(typeof marker.completedAt).toBe("string");
  }, 60_000);

  test("the default 600 s ceiling would refuse the same budget — the fixture's numbers are load-bearing", async () => {
    const ws = workspace();
    const noCeilings = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as {
      phases: Record<string, unknown>[];
    };
    for (const p of noCeilings.phases) {
      p.maxDurationMs = undefined;
    }
    const manifest = path.join(ws.dir, "pipeline.json");
    fs.writeFileSync(manifest, JSON.stringify(noCeilings));

    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("3610000 ms of phase budget");
    // Nothing was constructed, so nothing was journalled and the marker is absent.
    expect(fs.existsSync(ws.journal)).toBe(false);
    expect(fs.existsSync(path.join(ws.markerRoot, "journal", "final.json"))).toBe(false);
  }, 60_000);

  test("a green all-code pipeline exits 0 and a non-zero command exit is data, not a phase failure", async () => {
    const ws = workspace();
    const manifest = path.join(ws.dir, "pipeline.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "all-code",
        runBudgetMs: 100_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Emit the plan artifact for the requested change",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "planned"],
          },
          {
            name: "test",
            kind: "code",
            description: "Run the suite and report what it found",
            maxDurationMs: 15_000,
            retries: 0,
            // Exits non-zero: the suite came back red, but the phase did its job.
            command: ["sh", "-c", "exit 3"],
          },
        ],
      }),
    );

    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    expect(await proc.exited).toBe(0);
    const journal = readJournal(ws.journal);
    expect(journal.ok).toBe(true);
    expect(journal.phases.map((p) => p.status)).toEqual(["success", "success"]);
  }, 60_000);

  test("SIGTERM mid-phase closes the run: ok=false, the open phase reads fail, nothing in flight", async () => {
    const ws = workspace();
    const manifest = path.join(ws.dir, "pipeline.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "slow-pipeline",
        runBudgetMs: 100_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Wait long enough to be interrupted on purpose",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["sleep", "12"],
          },
          {
            name: "build",
            kind: "code",
            description: "Apply the reviewed change to the worktree",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "never reached"],
          },
        ],
      }),
    );

    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir, "--run-id", "sig-run"],
      ws.markerRoot,
    );

    // Wait until the first row is durable, i.e. the phase is genuinely in flight.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(ws.journal) && readJournal(ws.journal).phases.length === 1) break;
      await Bun.sleep(50);
    }
    expect(readJournal(ws.journal).phases).toHaveLength(1);
    expect(readJournal(ws.journal).phases[0]?.status).toBe("fail");

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(1);

    const journal = readJournal(ws.journal);
    expect(journal.ok).toBe(false);
    expect(journal.phases).toHaveLength(1);
    expect(journal.phases[0]?.status).toBe("fail");
    expect(journal.phases[0]?.exitStatus).toBe("transient");
    expect(journal.completedAt).toBeDefined();
    const marker = JSON.parse(fs.readFileSync(path.join(ws.markerRoot, "journal", "final.json"), "utf8"));
    expect(marker).toEqual({ runId: "sig-run", ok: false, completedAt: journal.completedAt });
  }, 60_000);

  test("overflow kills the owned subprocess tree, not just the direct child", async () => {
    const ws = workspace();
    const pidFile = path.join(ws.dir, "grandchild.pid");
    const manifest = path.join(ws.dir, "pipeline.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "overflow-pipeline",
        runBudgetMs: 100_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Fork a grandchild and outlive the phase ceiling on purpose",
            // 2 s ceiling; the command would otherwise run for 60 s. Generous enough
            // that a loaded CI runner still gets the pid file written before the kill.
            maxDurationMs: 2_000,
            retries: 0,
            command: ["sh", "-c", `sleep 60 & echo $! > "${pidFile}"; wait`],
          },
          {
            name: "build",
            kind: "code",
            description: "Apply the reviewed change to the worktree",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "never reached"],
          },
        ],
      }),
    );

    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    expect(await proc.exited).toBe(1);

    const journal = readJournal(ws.journal);
    expect(journal.phases).toHaveLength(1);
    expect(journal.phases[0]?.status).toBe("fail");
    expect(journal.phases[0]?.exitStatus).toBe("overflow");

    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(pid)).toBe(true);
    // The grandchild `sleep 60` must be gone: killing only the direct `sh` would
    // leave it running and writing past the run's own terminal marker.
    expect(await isGone(pid)).toBe(true);
  }, 60_000);

  test("a command that backgrounds work and returns does not leak the tree either", async () => {
    const ws = workspace();
    const pidFile = path.join(ws.dir, "grandchild.pid");
    const manifest = path.join(ws.dir, "pipeline.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "leaky-pipeline",
        runBudgetMs: 100_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Background a long sleep and return straight away",
            maxDurationMs: 15_000,
            retries: 0,
            // Note: no `wait`. The phase succeeds in well under a second while
            // the grandchild would happily outlive the whole run.
            command: ["sh", "-c", `sleep 60 & echo $! > "${pidFile}"`],
          },
          {
            name: "build",
            kind: "code",
            description: "Apply the reviewed change to the worktree",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "done"],
          },
        ],
      }),
    );

    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    expect(await proc.exited).toBe(0);
    expect(readJournal(ws.journal).ok).toBe(true);

    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(await isGone(pid)).toBe(true);
  }, 60_000);

  test("a manifest outside the run root is refused before anything is journalled", async () => {
    const ws = workspace();
    const outside = path.join(tmpRoot, `outside-${seq++}`);
    fs.mkdirSync(outside, { recursive: true });
    const manifest = path.join(outside, "pipeline.json");
    fs.copyFileSync(FIXTURE, manifest);
    const runRoot = path.join(ws.dir, "root");
    fs.mkdirSync(runRoot);

    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", runRoot],
      ws.markerRoot,
    );
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("resolves outside the run root");
    expect(fs.existsSync(ws.journal)).toBe(false);
  }, 60_000);

  test("a code phase whose binary does not exist fails the phase", async () => {
    const ws = workspace();
    const manifest = path.join(ws.dir, "pipeline.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "missing-binary",
        runBudgetMs: 100_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Invoke a tool that is not installed in this box",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["qds-definitely-not-installed", "--version"],
          },
          {
            name: "build",
            kind: "code",
            description: "Apply the reviewed change to the worktree",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "never reached"],
          },
        ],
      }),
    );

    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    expect(await proc.exited).toBe(1);
    const journal = readJournal(ws.journal);
    // A command that never ran produced no exit code, so there is no "the exit
    // code is data" reading available — the phase could not do its job.
    expect(journal.phases).toHaveLength(1);
    expect(journal.phases[0]?.status).toBe("fail");
    expect(journal.phases[0]?.exitStatus).toBe("logic");
    expect(journal.ok).toBe(false);
  }, 60_000);

  test("a command cannot forge the banner: child output is relayed to stderr", async () => {
    const ws = workspace();
    const manifest = path.join(ws.dir, "pipeline.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "loud-pipeline",
        runBudgetMs: 100_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Print a convincing forgery of the run banner",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "RUN forged pipeline=loud-pipeline ok=true accepted=true"],
          },
          {
            name: "build",
            kind: "code",
            description: "Apply the reviewed change to the worktree",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "done"],
          },
        ],
      }),
    );

    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir, "--run-id", "loud-run"],
      ws.markerRoot,
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    // fd 1 carries exactly one line, and it is the engine's.
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stdout).toContain("RUN loud-run");
    expect(stdout).not.toContain("RUN forged");
    expect(stderr).toContain("RUN forged");
  }, 60_000);

  test("missing required flags fail loudly and journal nothing", async () => {
    const ws = workspace();
    const proc = spawnRunner(["--manifest", FIXTURE, "--journal", ws.journal], ws.markerRoot);
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("--budget-ms is required");
    expect(fs.existsSync(ws.journal)).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// DF1.8: issue-correlation wiring in pipeline-run.ts (tests written first;
// implementation pending). Contract: _bmad-output/workflow-state/qds-dev/df1-8/contract.md.
// ---------------------------------------------------------------------------

/** Parsed JSON-object stderr lines; relayed child output is skipped. */
function jsonLines(stderr: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of stderr.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      parsed.push(JSON.parse(t) as Record<string, unknown>); // dp:ok guarded — the catch below skips relayed child noise that starts with "{"

    } catch {
      /* relayed child noise that merely starts with "{" */
    }
  }
  return parsed;
}

/** A green two-code-phase manifest — the minimal walk for a correlated run. */
function writeCodeManifest(dir: string): string {
  const manifest = path.join(dir, `pipeline-${seq++}.json`);
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: "1.0.0",
      pipelineId: "correlated-demo",
      runBudgetMs: 100_000,
      phases: [
        {
          name: "plan",
          kind: "code",
          description: "Emit the plan artifact for the requested change",
          maxDurationMs: 15_000,
          retries: 0,
          command: ["echo", "planned"],
        },
        {
          name: "build",
          kind: "code",
          description: "Apply the reviewed change to the worktree",
          maxDurationMs: 15_000,
          retries: 0,
          command: ["echo", "built"],
        },
      ],
    }),
  );
  return manifest;
}

function traceDb(markerRoot: string): string {
  return path.join(markerRoot, "trace", "trace.db");
}

/**
 * The INV-RUN-1 first-close-wins snapshot: everything a replayed dispatch
 * must leave untouched — the phase rows, the phase_state events, and the
 * closed session's status/ended_at.
 */
function runHistorySnapshot(
  markerRoot: string,
  requestId: string,
): { phases: number; phaseStateEvents: number; status: string | null; endedAt: string | null } {
  const db = new Database(traceDb(markerRoot), { readonly: true });
  try {
    const phases = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM phases WHERE request_id = ?")
      .get(requestId);
    const phaseStateEvents = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM events WHERE type = 'log' AND name = 'phase_state' AND request_id = ?",
      )
      .get(requestId);
    const session = db
      .query<{ status: string | null; ended_at: string | null }, [string]>(
        "SELECT status, ended_at FROM sessions WHERE request_id = ?",
      )
      .get(requestId);
    return {
      phases: phases?.n ?? 0,
      phaseStateEvents: phaseStateEvents?.n ?? 0,
      status: session?.status ?? null,
      endedAt: session?.ended_at ?? null,
    };
  } finally {
    db.close();
  }
}

function dispatchFailureLog(markerRoot: string): string {
  return path.join(markerRoot, "dispatch-failures.log");
}

/** The dispatch-failures.log entry under test: its last JSON line, parsed. */
function lastFailureEntry(markerRoot: string): Record<string, unknown> {
  const lines = fs.readFileSync(dispatchFailureLog(markerRoot), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>; // dp:ok test helper — malformed log line must fail loudly, not be skipped

}

describe("pipeline-run DF1.8 issue correlation", () => {
  test("a correlated run exits 0 and lands repo_slug/issue_id/request_id in the sessions row", async () => {
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const requestId = crypto.randomUUID();

    const proc = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir,
        "--repo-slug", "qds/demo", "--issue", "42", "--request-id", requestId,
      ],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(0);

    const db = new Database(traceDb(ws.markerRoot), { readonly: true });
    try {
      const sessions = db
        .query("SELECT repo_slug, issue_id, issue_url FROM sessions WHERE request_id = ?")
        .all(requestId) as { repo_slug: string | null; issue_id: number | null; issue_url: string | null }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.repo_slug).toBe("qds/demo");
      expect(sessions[0]?.issue_id).toBe(42);
      expect(sessions[0]?.issue_url).toBeNull();

      const events = db
        .query("SELECT payload_json FROM events WHERE request_id = ? AND type = 'log' AND name = 'phase_state'")
        .all(requestId) as { payload_json: string | null }[];
      // Two code phases, one start + one end each, no retries.
      expect(events).toHaveLength(4);
      const statuses: unknown[] = [];
      for (const row of events) {
        const p = JSON.parse(row.payload_json as string) as Record<string, unknown>;
        statuses.push(p.status);
        expect(p.runId).toBe(requestId);
        expect(p.requestId).toBe(requestId);
        expect(p.repoSlug).toBe("qds/demo");
        expect(p.issueId).toBe(42);
        expect(["plan", "build"]).toContain(p.phase as string);
        expect(typeof p.timestamp).toBe("string");
        expect(typeof p.durationMs).toBe("number");
        expect(p.exitStatus === null || typeof p.exitStatus === "string").toBe(true);
      }
      expect(statuses.filter((s) => s === "start")).toHaveLength(2);
      expect(statuses.filter((s) => s === "end")).toHaveLength(2);
    } finally {
      db.close();
    }

    const initiated = jsonLines(stderr).find((l) => l.event === "run_initiated");
    expect(initiated).toBeDefined();
    expect(initiated?.runId).toBe(requestId);
    expect(initiated?.requestId).toBe(requestId);
    expect(initiated?.repoSlug).toBe("qds/demo");
    expect(initiated?.issueId).toBe(42);
    expect(initiated?.replayed).toBe(false);
    expect(typeof initiated?.correlation_resolve_ms).toBe("number");
    expect(typeof initiated?.session_upsert_ms).toBe("number");
  }, 60_000);

  test("an identical correlated replay acks replayed:true and never re-walks the run (INV-RUN-1 first-close-wins)", async () => {
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const requestId = crypto.randomUUID();
    const correlation = ["--repo-slug", "qds/demo", "--issue", "42", "--request-id", requestId];

    const first = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", path.join(ws.dir, "out-1.json"), "--run-root", ws.dir, ...correlation],
      ws.markerRoot,
    );
    expect(await first.exited).toBe(0);

    // Snapshot after run 1: a replay acks the existing run and must not touch
    // any of it — upsertPhase would update the same rows in place, so the
    // strong no-op signals are the phase_state event count and the closed
    // session's status/ended_at.
    const before = runHistorySnapshot(ws.markerRoot, requestId);
    expect(before.phases).toBe(2);
    expect(before.phaseStateEvents).toBe(4);
    expect(before.status).not.toBeNull();
    expect(before.endedAt).not.toBeNull();

    const second = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", path.join(ws.dir, "out-2.json"), "--run-root", ws.dir, ...correlation],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(second.stderr).text(), second.exited]);
    expect(exitCode).toBe(0);

    const db = new Database(traceDb(ws.markerRoot), { readonly: true });
    try {
      const sessions = db
        .query("SELECT repo_slug, issue_id FROM sessions WHERE request_id = ?")
        .all(requestId) as { repo_slug: string | null; issue_id: number | null }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.repo_slug).toBe("qds/demo");
      expect(sessions[0]?.issue_id).toBe(42);
    } finally {
      db.close();
    }

    // The run's history is byte-for-byte what run 1 closed.
    const after = runHistorySnapshot(ws.markerRoot, requestId);
    expect(after).toEqual(before);
    // And the replay never started a walk: no journal was even written.
    expect(fs.existsSync(path.join(ws.dir, "out-2.json"))).toBe(false);

    const initiated = jsonLines(stderr).find((l) => l.event === "run_initiated");
    expect(initiated).toBeDefined();
    expect(initiated?.runId).toBe(requestId);
    expect(initiated?.replayed).toBe(true);
  }, 60_000);

  test("a request_id reused with a different repo_slug is refused with REQUEST_ID_REPO_MISMATCH", async () => {
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const requestId = crypto.randomUUID();

    const first = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000", "--journal", path.join(ws.dir, "out-1.json"), "--run-root", ws.dir,
        "--repo-slug", "qds/demo", "--issue", "42", "--request-id", requestId,
      ],
      ws.markerRoot,
    );
    expect(await first.exited).toBe(0);

    const second = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000", "--journal", path.join(ws.dir, "out-2.json"), "--run-root", ws.dir,
        "--repo-slug", "qds/other", "--issue", "42", "--request-id", requestId,
      ],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(second.stderr).text(), second.exited]);
    expect(exitCode).toBe(2);

    const failed = jsonLines(stderr).find((l) => l.event === "dispatch_failed");
    expect(failed).toBeDefined();
    expect(failed?.runId).toBeNull();
    expect(failed?.requestId).toBe(requestId);
    expect(failed?.repoSlug).toBe("qds/other");
    expect(failed?.issueId).toBe(42);
    const err = (failed?.error ?? {}) as { code?: unknown; message?: unknown };
    expect(err.code).toBe("REQUEST_ID_REPO_MISMATCH");
    expect(String(err.message)).toContain("qds/demo");
    expect(String(err.message)).toContain("qds/other");

    // The existing row is untouched: no second row, no repo_slug rewrite.
    const db = new Database(traceDb(ws.markerRoot), { readonly: true });
    try {
      const sessions = db
        .query("SELECT repo_slug FROM sessions WHERE request_id = ?")
        .all(requestId) as { repo_slug: string | null }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.repo_slug).toBe("qds/demo");
    } finally {
      db.close();
    }

    expect(fs.existsSync(dispatchFailureLog(ws.markerRoot))).toBe(true);
    expect(fs.statSync(dispatchFailureLog(ws.markerRoot)).mode & 0o777).toBe(0o600);
    const entry = lastFailureEntry(ws.markerRoot);
    expect(entry.code).toBe("REQUEST_ID_REPO_MISMATCH");
    expect(entry.requestId).toBe(requestId);
    expect(entry.repoSlug).toBe("qds/other");
    expect(entry.issueId).toBe(42);
    // Never a fabricated runId: absent or null, never a minted identifier.
    expect(entry.runId ?? null).toBeNull();
    expect(String(entry.message)).toContain("qds/demo");
    expect(String(entry.message)).toContain("qds/other");
  }, 60_000);

  test("half-pair, malformed and duplicate-identifier correlation flags are refused before any session row", async () => {
    const cases: { name: string; args: string[]; code?: string; stderrEvent?: boolean }[] = [
      { name: "--issue without --repo-slug (pair required, never defaulted)", args: ["--issue", "42"] },
      { name: "--repo-slug without --issue (pair required)", args: ["--repo-slug", "qds/demo"] },
      { name: "repo slug with a space", args: ["--repo-slug=bad slug", "--issue", "42"], code: "INVALID_REPO_SLUG", stderrEvent: true },
      { name: "--issue 0", args: ["--repo-slug", "qds/demo", "--issue", "0"], code: "INVALID_ISSUE_ID", stderrEvent: true },
      { name: "--issue abc", args: ["--repo-slug", "qds/demo", "--issue", "abc"], code: "INVALID_ISSUE_ID", stderrEvent: true },
      { name: "--request-id not a uuid v4", args: ["--repo-slug", "qds/demo", "--issue", "42", "--request-id", "not-uuid"], code: "INVALID_REQUEST_ID", stderrEvent: true },
      { name: "--run-id together with --repo-slug (no second identifier)", args: ["--repo-slug", "qds/demo", "--issue", "42", "--run-id", crypto.randomUUID()] },
    ];
    for (const c of cases) {
      const ws = workspace();
      const manifest = writeCodeManifest(ws.dir);
      const proc = spawnRunner(
        ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir, ...c.args],
        ws.markerRoot,
      );
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode, c.name).toBe(2);
      if (c.stderrEvent) expect(stderr.includes("dispatch_failed"), c.name).toBe(true);
      // Refused before the trace dir was claimed, so no store was ever opened.
      expect(fs.existsSync(traceDb(ws.markerRoot)), c.name).toBe(false);
      expect(fs.existsSync(dispatchFailureLog(ws.markerRoot)), c.name).toBe(true);
      const entry = lastFailureEntry(ws.markerRoot);
      expect(typeof entry.code === "string" && entry.code.length > 0, c.name).toBe(true);
      if (c.code) expect(entry.code, c.name).toBe(c.code);
      expect(typeof entry.message === "string" && entry.message.length > 0, c.name).toBe(true);
      expect(entry.runId ?? null, c.name).toBeNull();
    }
  }, 120_000);

  test("a correlated run whose trace dir cannot be claimed fails through the dispatch-failure ladder", async () => {
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const requestId = crypto.randomUUID();
    // A regular file at <root>/trace: the 0700 claim cannot succeed, while the
    // marker root itself stays writable so dispatch-failures.log survives (AC4 —
    // the log must outlive a trace store that could not even open).
    fs.mkdirSync(ws.markerRoot, { recursive: true });
    fs.writeFileSync(path.join(ws.markerRoot, "trace"), "not a dir");

    const proc = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir,
        "--repo-slug", "qds/demo", "--issue", "42", "--request-id", requestId,
      ],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);

    const failed = jsonLines(stderr).find((l) => l.event === "dispatch_failed");
    expect(failed).toBeDefined();
    expect(failed?.runId).toBeNull();
    expect(failed?.requestId).toBe(requestId);
    expect(failed?.repoSlug).toBe("qds/demo");
    expect(failed?.issueId).toBe(42);

    const entry = lastFailureEntry(ws.markerRoot);
    expect(entry.requestId).toBe(requestId);
    expect(entry.runId ?? null).toBeNull();
    expect(typeof entry.code === "string" && entry.code.length > 0).toBe(true);
    expect(typeof entry.message === "string" && entry.message.length > 0).toBe(true);
    expect(fs.existsSync(traceDb(ws.markerRoot))).toBe(false);
  }, 60_000);

  test("a bare run (no correlation flags) is unchanged: no repo_slug, no phase_state events, no failure log", async () => {
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    expect(await proc.exited).toBe(0);

    const db = new Database(traceDb(ws.markerRoot), { readonly: true });
    try {
      const sessions = db
        .query("SELECT repo_slug, issue_id FROM sessions")
        .all() as { repo_slug: string | null; issue_id: number | null }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.repo_slug).toBeNull();
      expect(sessions[0]?.issue_id).toBeNull();
      const counted = db
        .query("SELECT COUNT(*) AS n FROM events WHERE type = 'log' AND name = 'phase_state'")
        .get() as { n: number };
      expect(counted.n).toBe(0);
    } finally {
      db.close();
    }
    expect(fs.existsSync(dispatchFailureLog(ws.markerRoot))).toBe(false);
  }, 60_000);
});
