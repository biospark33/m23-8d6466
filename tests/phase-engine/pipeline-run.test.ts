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
import { runContextFrom } from "../../scripts/pipeline-run.ts";

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

function spawnRunner(
  args: string[],
  markerRoot: string,
  cwd = REPO_ROOT,
  extraEnv: Record<string, string | undefined> = {},
) {
  // #219 / INV-RES-3: startResident refuses an arming whose child env
  // carries no non-blank OPENROUTER_API_KEY, so every runner spawn that
  // arms the resident needs the key deterministically — never whatever a
  // dev shell happens to export (which would decide which tests pass).
  // extraEnv can still override with a case-specific value, or SCRUB a
  // variable entirely by passing it as undefined (an explicit deletion is
  // the only honest "unset": Bun would hand a `{ KEY: undefined }` entry to
  // the child as the literal string "undefined", which the key gate would
  // read as a present key).
  const env: Record<string, string | undefined> = {
    ...process.env,
    QDS_RUN_ROOT: markerRoot,
    OPENROUTER_API_KEY: "sk-or-v1-df33-fixture-key-000000111111",
    ...extraEnv,
  };
  for (const key of Object.keys(extraEnv)) {
    if (extraEnv[key] === undefined) delete env[key];
  }
  return Bun.spawn({
    // `process.execPath`, not "bun": `bun test` runs every file in one process,
    // so a sibling suite that rewrites PATH must not decide which runtime this
    // spawns.
    cmd: [process.execPath, RUNNER, ...args],
    cwd,
    env,
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
  // DF1.10 C19: phase 2 used to be `kind: "engineer"` and failed because
  // nothing implemented that kind. The kind is gone, but the rule it was
  // demonstrating — a body that THROWS is never promoted, as opposed to a
  // command that merely exits non-zero, which is data — is not, so phase 2 is
  // now a `code` phase whose executable cannot be spawned. Same throw, same
  // rule, same assertions; the isolated version is in
  // `in-box-engine.test.ts`'s synthetic-body case.
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

    const marker = JSON.parse(fs.readFileSync(path.join(runTree(ws.markerRoot, "e2e-run"), "journal", "final.json"), "utf8"));
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
    expect(fs.existsSync(path.join(runTree(ws.markerRoot, "e2e-run"), "journal", "final.json"))).toBe(false);
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
    const marker = JSON.parse(fs.readFileSync(path.join(runTree(ws.markerRoot, "sig-run"), "journal", "final.json"), "utf8"));
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

  test("a --run-id over the 128-char grammar bound is refused before anything is spent", async () => {
    // PR #216 round 4 (PM2): the length half of IN_BOX_RUN_ID_RE (1 + 127) is
    // the pre-spend guard that keeps the terminal marker under
    // MARKER_MAX_BYTES — without this row it could be dropped and the
    // regression would surface only as permanently-unmirrorable
    // ENGINE_MARKER_UNUSABLE replays. 129 chars, ALL inside the safe charset:
    // only the length bound rejects it. The refusal is argv-parse-time, so it
    // precedes the claim, the journal and the marker.
    const ws = workspace();
    const proc = spawnRunner(
      [
        "--manifest", FIXTURE, "--budget-ms", "120000", "--journal", ws.journal,
        "--run-root", ws.dir, "--run-id", `a${"b".repeat(128)}`,
      ],
      ws.markerRoot,
    );
    expect(await proc.exited).toBe(2);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("--run-id must be a safe identifier");
    expect(stderr).toContain("1..128 chars");
    expect(fs.existsSync(ws.journal)).toBe(false);
    expect(fs.existsSync(path.join(runTree(ws.markerRoot, "loud-run"), "journal", "final.json"))).toBe(false);
  }, 60_000);

  test("a --run-id at EXACTLY the 128-char bound is ACCEPTED — the id itself passes; the missing manifest is what refuses", async () => {
    // PR #216 round 5: the acceptance half of the row above. `a` + 127 `b`s is
    // the regex's own maximum (1 + 127); an off-by-one in EITHER direction is
    // caught by the pair — 129 refused above, 128 admitted here. The manifest
    // deliberately does not exist, so the run still refuses cheaply (exit 2,
    // argv-parse and replay guard behind it), and the refusal TEXT is what
    // proves the id cleared the grammar: it names the manifest, never --run-id.
    const ws = workspace();
    const proc = spawnRunner(
      [
        "--manifest", path.join(ws.dir, "no-such-manifest.json"), "--budget-ms", "120000",
        "--journal", ws.journal, "--run-root", ws.dir, "--run-id", `a${"b".repeat(127)}`,
      ],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).not.toContain("--run-id must be a safe identifier");
    expect(stderr).toContain("manifest is not resolvable");
    expect(fs.existsSync(ws.journal)).toBe(false);
  }, 60_000);

  test("journal reclaim: a present NON-EMPTY unparseable journal REFUSES (ENGINE_JOURNAL_UNUSABLE) without truncating it; an empty one proceeds", async () => {
    // PR #216 round 5 / DF1.10 AC6 durable half — behavior-change-driven pin:
    // `journalReclaimRefusal` used to proceed on an unparseable journal
    // (fail-open in the double-spend direction the guard exists for); the
    // fail-closed arm now refuses exists && non-empty && unparseable as
    // ENGINE_JOURNAL_UNUSABLE, while ENOENT and the empty file (the
    // header-only flush a run that died before its first phase leaves) still
    // proceed. Both legs through the spawned runner, because the guard and its
    // exit code live in main().
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    fs.writeFileSync(ws.journal, "debris from a run that never parsed\n");
    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);
    const refused = jsonLines(stderr).find((l) => l.event === "engine_refused_replay");
    expect(refused).toBeDefined();
    const err = (refused?.error ?? {}) as { code?: unknown; message?: unknown };
    expect(err.code).toBe("ENGINE_JOURNAL_UNUSABLE");
    expect(String(err.message)).toContain("could not be parsed as JSON");
    // The refusal is the whole point of the guard: `new FileJournal` flushes
    // over its path in the constructor, so proceeding would have DESTROYED the
    // only copy of whatever the debris replaced. Byte-identical on disk.
    expect(fs.readFileSync(ws.journal, "utf8")).toBe("debris from a run that never parsed\n");
    expect(fs.existsSync(path.join(runTree(ws.markerRoot, "loud-run"), "journal", "final.json"))).toBe(false);

    // The proceed half, both arms: empty file and absent file alike let the
    // run walk — re-walking either re-spends nothing.
    for (const leg of ["empty", "absent"] as const) {
      const ws2 = workspace();
      const manifest2 = writeCodeManifest(ws2.dir);
      if (leg === "empty") fs.writeFileSync(ws2.journal, "");
      const proc2 = spawnRunner(
        ["--manifest", manifest2, "--budget-ms", "120000", "--journal", ws2.journal, "--run-root", ws2.dir],
        ws2.markerRoot,
      );
      const [, exit2] = await Promise.all([new Response(proc2.stderr).text(), proc2.exited]);
      expect(exit2, leg).toBe(0);
      expect(readJournal(ws2.journal).ok, leg).toBe(true);
    }
  }, 120_000);
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

/** `writeCodeManifest` at an EXACT path — the resolved-path witness test needs
 * a stable name to symlink against. Same body, no seq suffix. */
function writeCodeManifestIn(dir: string): string {
  const manifest = path.join(dir, "pipeline-linked.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: "1.0.0",
      pipelineId: "resolved-anchor-demo",
      runBudgetMs: 100_000,
      limitMicroUsd: 250_000,
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

function runTree(markerRoot: string, id: string): string {
  // #217 F-D1: the per-run tree the engine derives — keyed the way the engine
  // keys it (--run-id, else --request-id, else the legacy shared root).
  return path.join(markerRoot, "qds-run", id);
}

function traceDb(markerRoot: string, id?: string): string {
  // #217 F-D1: id names the invocation identity (explicit --request-id or
  // --run-id); its absence is the legacy shared root of an UNNAMED invocation.
  return path.join(id === undefined ? markerRoot : runTree(markerRoot, id), "trace", "trace.db");
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
  const db = new Database(traceDb(markerRoot, requestId), { readonly: true });
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

    const db = new Database(traceDb(ws.markerRoot, requestId), { readonly: true });
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

    // DF1.10 AC6 pre-empts this ladder, and deliberately so: an engine invoked
    // against a run whose TERMINAL MARKER exists refuses before the correlation
    // ladder even runs. That refusal is strictly stronger than the guard under
    // test here — it stops earlier (before the trace store opens at all) and it
    // covers bare invocations, which is what `qds-engine run <runId>` is.
    //
    // The two guards answer different questions, so this suite still has to be
    // able to reach the session-keyed one. Removing the first run's marker puts
    // the workspace into exactly the state DF1.8's guard was designed for and
    // which IS production-reachable: a session row exists but nothing settled
    // terminally — a run killed mid-walk.
    //
    // Two invocations can only collide on a marker at all because this fixture
    // shares ONE marker root in order to share ONE trace store, which is the
    // only thing it actually needs shared. After DF1.10 the engine runs only
    // in-box, one box per run, each with its own tmpfs `/run`; the one
    // host-side engine path where marker-sharing could have happened in
    // production was the remote runner AC7 deleted. So nothing in production
    // shares a marker root any more — only this fixture does, deliberately.
    //
    // Asserted to EXIST first, and deleted without `force`. With `force: true`
    // the delete swallowed ENOENT, so the day the marker path moves this line
    // would silently no-op, AC6 would refuse the second invocation with exit 0
    // and no `out-2.json` — which is precisely what this test asserts below.
    // The DF1.8 guard could have been deleted outright and this stayed green.
    const firstMarker = path.join(runTree(ws.markerRoot, requestId), "journal", "final.json");
    expect(fs.existsSync(firstMarker)).toBe(true);
    fs.rmSync(firstMarker);

    const second = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", path.join(ws.dir, "out-2.json"), "--run-root", ws.dir, ...correlation],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(second.stderr).text(), second.exited]);
    expect(exitCode).toBe(0);
    // The DF1.8 session guard answered, not AC6's marker guard. Both refuse
    // with exit 0 here, so the exit code alone cannot tell them apart — the
    // event can, and it is the only thing that can.
    expect(jsonLines(stderr).map((l) => l.event)).not.toContain("engine_refused_replay");

    const db = new Database(traceDb(ws.markerRoot, requestId), { readonly: true });
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

    // DF1.10 AC6 pre-empts this ladder, and deliberately so: an engine invoked
    // against a run whose TERMINAL MARKER exists refuses before the correlation
    // ladder even runs. That refusal is strictly stronger than the guard under
    // test here — it stops earlier (before the trace store opens at all) and it
    // covers bare invocations, which is what `qds-engine run <runId>` is.
    //
    // The two guards answer different questions, so this suite still has to be
    // able to reach the session-keyed one. Removing the first run's marker puts
    // the workspace into exactly the state DF1.8's guard was designed for and
    // which IS production-reachable: a session row exists but nothing settled
    // terminally — a run killed mid-walk.
    //
    // Two invocations can only collide on a marker at all because this fixture
    // shares ONE marker root in order to share ONE trace store, which is the
    // only thing it actually needs shared. After DF1.10 the engine runs only
    // in-box, one box per run, each with its own tmpfs `/run`; the one
    // host-side engine path where marker-sharing could have happened in
    // production was the remote runner AC7 deleted. So nothing in production
    // shares a marker root any more — only this fixture does, deliberately.
    //
    // Asserted to EXIST first, and deleted without `force` — see the same
    // block in the replay test above: a silently no-op'ing delete would let
    // AC6's marker guard answer instead, and the DF1.8 guard under test here
    // would never run.
    const firstMarker = path.join(runTree(ws.markerRoot, requestId), "journal", "final.json");
    expect(fs.existsSync(firstMarker)).toBe(true);
    fs.rmSync(firstMarker);

    const second = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000", "--journal", path.join(ws.dir, "out-2.json"), "--run-root", ws.dir,
        "--repo-slug", "qds/other", "--issue", "42", "--request-id", requestId,
      ],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(second.stderr).text(), second.exited]);
    expect(exitCode).toBe(2);
    // Exit 2 is also what an unusable marker returns, so the event is again the
    // only thing that says WHICH guard refused. It must be the correlation one.
    expect(jsonLines(stderr).map((l) => l.event)).not.toContain("engine_refused_replay");

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
    const db = new Database(traceDb(ws.markerRoot, requestId), { readonly: true });
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
    const cases: { name: string; args: string[]; code?: string; stderrEvent?: boolean; issueId?: number | null }[] = [
      { name: "--issue without --repo-slug (pair required, never defaulted)", args: ["--issue", "42"], code: "CORRELATION_PAIR_REQUIRED" },
      { name: "--repo-slug without --issue (pair required)", args: ["--repo-slug", "qds/demo"], code: "CORRELATION_PAIR_REQUIRED" },
      { name: "repo slug with a space", args: ["--repo-slug=bad slug", "--issue", "42"], code: "INVALID_REPO_SLUG", stderrEvent: true },
      // 0, a non-numeric value, and an out-of-bounds value alike must log
      // issueId: null — never a fabricated id (INV-RUN-4): digits alone are
      // not a settled issue id, and neither is a value past MAX_ISSUE_ID.
      { name: "--issue 0", args: ["--repo-slug", "qds/demo", "--issue", "0"], code: "INVALID_ISSUE_ID", stderrEvent: true, issueId: null },
      { name: "--issue abc", args: ["--repo-slug", "qds/demo", "--issue", "abc"], code: "INVALID_ISSUE_ID", stderrEvent: true, issueId: null },
      { name: "--issue MAX_ISSUE_ID + 1", args: ["--repo-slug", "qds/demo", "--issue", "2147483648"], code: "INVALID_ISSUE_ID", stderrEvent: true, issueId: null },
      { name: "--request-id not a uuid v4", args: ["--repo-slug", "qds/demo", "--issue", "42", "--request-id", "not-uuid"], code: "INVALID_REQUEST_ID", stderrEvent: true },
      { name: "--run-id together with --repo-slug (no second identifier)", args: ["--repo-slug", "qds/demo", "--issue", "42", "--run-id", crypto.randomUUID()], code: "RUN_ID_CONFLICT" },
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
      if (c.issueId !== undefined) expect(entry.issueId, c.name).toBe(c.issueId);
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
    fs.mkdirSync(path.dirname(path.join(runTree(ws.markerRoot, requestId), "trace")), { recursive: true });
    fs.writeFileSync(path.join(runTree(ws.markerRoot, requestId), "trace"), "not a dir");

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
    expect(fs.existsSync(traceDb(ws.markerRoot, requestId))).toBe(false);
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

describe("pipeline-run DF3.1 AC9b: the admitted ceiling reaches the run context", () => {
  // The chain is dispatch → stamped `pipeline.yaml` → this entrypoint's
  // RunContext → `dispatch-task.ts` → `_runTeamManifest` → DF1.6's spawn cap.
  // It was broken at this link: the context was built from three fields, so
  // `effectiveCeilingMicros` was `undefined` on every real run and every run
  // spawned at the $0.50 harness default. Dispatch's own coverage stopped at the
  // bytes of `run-context.json`, a file with no consumer anywhere in the repo,
  // so nothing failed. Asserted on the CONTEXT, which is the thing consumed.

  /**
   * The pair dispatch leaves on disk: the stamped `pipeline.yaml` and the
   * `run-context.json` it wrote beside it carrying the SAME admitted ceiling.
   * `runContextFrom` only takes the manifest's dirname, so the manifest file
   * itself is never read here — it is written anyway so the fixture is the
   * shape dispatch actually produces. Omit `witnessBody` for a directory with
   * no witness at all.
   */
  function admitted(witnessBody?: string): { manifestPath: string; runRoot: string } {
    const runRoot = path.join(tmpRoot, `ac9b-${seq++}`);
    fs.mkdirSync(runRoot, { recursive: true });
    const manifestPath = path.join(runRoot, "pipeline.yaml");
    fs.writeFileSync(manifestPath, "{}\n");
    if (witnessBody !== undefined) {
      fs.writeFileSync(path.join(runRoot, "run-context.json"), witnessBody);
    }
    return { manifestPath, runRoot };
  }

  test("a stamped manifest puts its limitMicroUsd on the context as effectiveCeilingMicros", () => {
    const ctx = runContextFrom(
      "run-1",
      "req-1",
      { pipelineId: "capped", limitMicroUsd: 250_000 },
      admitted(JSON.stringify({ effectiveCeilingMicros: 250_000 })),
    );
    expect(ctx.effectiveCeilingMicros).toBe(250_000);
  });

  test("an unstamped manifest leaves the field ABSENT, never defaulted to a number", () => {
    // `"x" in ctx`, not `ctx.x === undefined`: present-and-undefined is a
    // different shape from absent, and the engine's own contract
    // (tests/phase-engine/phase-lifecycle.test.ts) is written against absence.
    // Handed a witness-less directory on purpose: no declared cap means nothing
    // to reconcile, so the no-limit path must return before it looks.
    const ctx = runContextFrom("run-2", "req-2", { pipelineId: "uncapped" }, admitted());
    expect("effectiveCeilingMicros" in ctx).toBe(false);
  });

  // A DECLARED cap is reconciled against dispatch's own record, never taken on
  // the manifest's word. `stampManifestLimit`'s stamp and a hand-authored
  // `limitMicroUsd` are byte-identical in the file — `loadManifest` cannot tell
  // them apart — so `run-context.json` is the only thing that distinguishes a
  // ceiling dispatch admitted from one somebody typed into the yaml to raise
  // DF1.6's harness cap. Every way of failing to produce that witness refuses.

  test("a declared cap with NO dispatch witness beside the manifest is refused", () => {
    expect(() =>
      runContextFrom(
        "run-3",
        "req-3",
        { pipelineId: "authored", limitMicroUsd: 250_000 },
        admitted(),
      ),
    ).toThrow(/run-context\.json is unreadable/);
  });

  test("a witness that admitted a DIFFERENT ceiling is refused", () => {
    // The whole attack in one case: the yaml names $50, dispatch admitted $0.25.
    expect(() =>
      runContextFrom(
        "run-4",
        "req-4",
        { pipelineId: "authored", limitMicroUsd: 50_000_000 },
        admitted(JSON.stringify({ effectiveCeilingMicros: 250_000 })),
      ),
    ).toThrow("manifest declares limitMicroUsd 50000000 but dispatch admitted 250000");
  });

  test("a witness carrying no positive-integer effectiveCeilingMicros is refused", () => {
    // Each of these is a witness that exists and parses but vouches for
    // nothing spendable. None may fall through to trusting the manifest.
    const bodies: Record<string, string> = {
      absent: "{}",
      zero: JSON.stringify({ effectiveCeilingMicros: 0 }),
      float: JSON.stringify({ effectiveCeilingMicros: 250_000.5 }),
      negative: JSON.stringify({ effectiveCeilingMicros: -250_000 }),
      stringy: JSON.stringify({ effectiveCeilingMicros: "250000" }),
      unsafe: JSON.stringify({ effectiveCeilingMicros: 2 ** 53 }),
      null: "null",
    };
    for (const [name, body] of Object.entries(bodies)) {
      expect(() =>
        runContextFrom(
          "run-5",
          "req-5",
          { pipelineId: name, limitMicroUsd: 250_000 },
          admitted(body),
        ),
      ).toThrow(/carries no positive integer effectiveCeilingMicros/);
    }
  });

  test("a witness that is not JSON is refused, never read as an absent cap", () => {
    expect(() =>
      runContextFrom(
        "run-6",
        "req-6",
        { pipelineId: "authored", limitMicroUsd: 250_000 },
        admitted("{ truncated"),
      ),
    ).toThrow(/run-context\.json is unreadable/);
  });

  test("a witness WITHOUT a stamped manifest still puts the admitted ceiling on the context", () => {
    // Was a CHARACTERIZATION of the fail-open direction; the direction is now
    // reversed, deliberately. A present witness is dispatch's statement about
    // this run and reaches the context whether or not the manifest declares a
    // limit — otherwise a regressed `stampManifestLimit` (or `stripAuthoredLimit`
    // applied runner-side) silently discards the admitted ceiling and the run
    // spawns at DF1.6's $0.50 default, i.e. TWICE what the ledger reserved.
    const ctx = runContextFrom(
      "run-8",
      "req-8",
      { pipelineId: "witness-without-stamp" },
      admitted(JSON.stringify({ effectiveCeilingMicros: 250_000 })),
    );
    expect(ctx.effectiveCeilingMicros).toBe(250_000);
  });

  test("a BROKEN witness with no declared limit refuses — present-but-unreadable is never 'uncapped'", () => {
    // `witnessPresent` only decides whether to LOOK; everything it finds goes to
    // the hardened reader, which refuses what it cannot verify. The tempting
    // shortcut is to treat an unparseable witness on the no-declared-cap path as
    // "nothing to reconcile" and fall through to an absent field — which turns a
    // corrupt witness into an uncapped run at the harness default, the same
    // money direction the fix just closed.
    expect(() =>
      runContextFrom(
        "run-9",
        "req-9",
        { pipelineId: "broken-witness-no-stamp" },
        admitted("{ truncated"),
      ),
    ).toThrow(/run-context\.json is unreadable/);
  });

  test("a DANGLING run-context.json symlink is PRESENT, not absent — this is why lstat, not existsSync", () => {
    // `existsSync` follows symlinks and reports a dangling one as absent, so the
    // no-declared-cap path would skip the witness entirely and leave the run
    // uncapped. That hands an author a way to hide a ceiling-LOWERING witness:
    // plant a broken link named `run-context.json` beside the manifest and the
    // ceiling dispatch admitted is never consulted. `lstat` sees the LINK, so
    // the read happens and refuses. Nothing else in the suite pins this choice,
    // which is exactly how it would get "simplified" back to `existsSync`.
    const runRoot = path.join(tmpRoot, `ac9b-${seq++}`);
    fs.mkdirSync(runRoot, { recursive: true });
    const manifestPath = path.join(runRoot, "pipeline.yaml");
    fs.writeFileSync(manifestPath, "{}\n");
    fs.symlinkSync(path.join(runRoot, "no-such-target.json"), path.join(runRoot, "run-context.json"));
    // The fixture really is the discriminating one: the two calls DISAGREE here.
    // Without this the link could quietly be replaced by a real file and the
    // case would keep passing while testing nothing.
    expect(fs.existsSync(path.join(runRoot, "run-context.json"))).toBe(false);

    // Refused, NOT silently uncapped: reaching the reader at all is the property
    // under test, and the reader is what turns a link into a refusal.
    expect(() =>
      runContextFrom("run-10", "req-10", { pipelineId: "dangling-witness" }, { manifestPath, runRoot }),
    ).toThrow(/run-context\.json is unreadable/);
  });

  test("a symlinked manifest path cannot aim the check at another directory's witness", () => {
    // The call site hands the VERIFIED resolvedPath from `loadManifest`, but
    // the witness read re-asserts beneath-root on its own: reached through a
    // symlink, the sibling `run-context.json` realpaths outside the pinned run
    // root and `readArtifactBeneathRoot` refuses it. Without that step this
    // witness would have agreed with the manifest and admitted $50.
    const runRoot = path.join(tmpRoot, `ac9b-${seq++}`);
    fs.mkdirSync(runRoot, { recursive: true });
    const elsewhere = path.join(tmpRoot, `ac9b-elsewhere-${seq++}`);
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(
      path.join(elsewhere, "run-context.json"),
      JSON.stringify({ effectiveCeilingMicros: 50_000_000 }),
    );
    fs.symlinkSync(elsewhere, path.join(runRoot, "link"));

    expect(() =>
      runContextFrom(
        "run-7",
        "req-7",
        { pipelineId: "aimed-elsewhere", limitMicroUsd: 50_000_000 },
        { manifestPath: path.join(runRoot, "link", "pipeline.yaml"), runRoot },
      ),
      // The REASON, not just the refusal: matching "unreadable" alone would
      // pass just as well if the witness were simply missing.
    ).toThrow(/resolves outside the run root/);
  });

  test("the runner anchors the cap witness on the VERIFIED path, never the argv string", async () => {
    // The runtime half of the guard at main's witness anchor. `resolvedPath` is
    // optional on `LoadedManifest` (the deriving helpers drop it because their
    // bytes match no file), so a `?? manifestPath` fallback was live type
    // surface there: it aimed the witness check at whatever directory the argv
    // path sits in instead of the directory the manifest BYTES were read from.
    //
    // No caller today can hand main an unresolved derived manifest, but the two
    // directories ARE constructibly distinct through a symlink: loadManifest
    // reads the REALPATH's sibling and refuses an out-of-root witness, while a
    // restored fallback would consult the SYMLINK's sibling — so planting a
    // fresh agreeing pair in each proves which one the run anchored on. The
    // symlink arm above ("cannot aim the check at another directory") already
    // refuses this shape via readArtifactBeneathRoot; the discriminating case
    // here is DECLARED-LIMIT + no witness beside the link target: under the
    // guard the ceiling matches against the realpath's fresh witness and exits
    // 0; under a `?? argv` regression the reconciliation looks beside the LINK,
    // finds nothing, and the ceiling-mismatch refusal fires instead.
    const ws = workspace();
    const realDir = path.join(ws.dir, "real");
    fs.mkdirSync(realDir, { recursive: true });
    const manifest = writeCodeManifestIn(realDir);
    fs.writeFileSync(
      path.join(realDir, "run-context.json"),
      JSON.stringify({ effectiveCeilingMicros: 250_000 }),
    );
    const linkDir = path.join(ws.dir, "linkdir");
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(manifest, path.join(linkDir, "pipeline-linked.json"));

    const correlation = ["--repo-slug", "qds/demo", "--issue", "42", "--request-id", crypto.randomUUID()];
    const proc = spawnRunner(
      [
        "--manifest", path.join(linkDir, "pipeline-linked.json"),
        "--budget-ms", "120000",
        "--journal", ws.journal,
        "--run-root", ws.dir,
        ...correlation,
      ],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(0);
    // And it really did agree with the FRESH witness beside the resolved bytes
    // (not exit-0-by-luck): naming a different admitted ceiling must refuse.
    expect(stderr).not.toContain("declares limitMicroUsd");
    expect(stderr).not.toContain("is stale");
  }, 60_000);

  test("layout change-detector: no argv-string fallback at the witness anchor", () => {
    // SECONDARY pin, kept only as an early tripwire for the anchor's SHAPE — a
    // rename of `resolvedPath` or a reformatted guard fails here before any
    // behaviour test does. It cannot prove the guard runs (see the runtime test
    // above for that), and the two `expect(source)` probes below are what keep
    // ITS OWN matches honest: without them a rename makes both regexes vacuously
    // pass, which is exactly the false-pass the runtime arm exists to close.
    const source = fs.readFileSync(path.join(REPO_ROOT, "scripts", "pipeline-run.ts"), "utf8");
    // The identifier must still exist at all: without this probe, a rename of
    // `resolvedPath` turns BOTH matches below into vacuous passes instead of a
    // loud failure at the moment the guarantee loses its subject.
    expect(source).toContain("resolvedPath");
    // No `?? manifestPath` anywhere near the witness anchor…
    expect(source).not.toMatch(/resolvedPath\s*\?\?\s*manifestPath/);
    // …and the undefined case is a throw, not a default. Whitespace-tolerant,
    // because the only thing being pinned is control flow, not layout: a
    // reformatted `if(` or re-indented body must not false-fail a correct file.
    expect(source).toMatch(/if\s*\(\s*resolvedPath\s*===\s*undefined\s*\)\s*\{[\s\S]{0,80}?throw new Error\(/);
  });

  test("the cap refusal closes the tracer — the session it opened does not wedge the requestId", async () => {
    // `main` opens the Tracer and initiates the session BEFORE it builds the
    // RunContext, so a refusal out of `runContextFrom` escapes with a live
    // handle. It used to run straight to the top-level catch, which writes
    // stderr and exits — leaking an open SQLite/WAL handle and, worse, an
    // UNFINISHED session row. That row is the damage that outlives the process:
    // a later `initiateSession` for the same requestId throws
    // RequestIdRepoMismatch, so one mistyped manifest wedged that correlation id
    // for good. Driven through the spawned runner, because the guarded region is
    // in `main` and nothing about it is visible from `runContextFrom` alone.
    const ws = workspace();
    const requestId = crypto.randomUUID();
    // A manifest that DECLARES a cap with no `run-context.json` beside it — the
    // "authored limit, no dispatch witness" refusal, which is the cheapest way
    // to make `runContextFrom` throw at exactly that point in `main`.
    const capped = path.join(ws.dir, `pipeline-capped-${seq++}.json`);
    fs.writeFileSync(
      capped,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "capped-demo",
        runBudgetMs: 100_000,
        limitMicroUsd: 250_000,
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
    const correlation = ["--repo-slug", "qds/demo", "--issue", "42", "--request-id", requestId];
    const refused = spawnRunner(
      ["--manifest", capped, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir, ...correlation],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(refused.stderr).text(), refused.exited]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("run-context.json");

    // `Tracer.close()` runs `PRAGMA wal_checkpoint(TRUNCATE)` before it closes
    // the handle, which leaves the sidecar at ZERO bytes. A handle abandoned to
    // process exit is never checkpointed — the kernel just closes the fd — so
    // the WAL keeps the session upsert's frames. SIZE, not existence:
    // bun:sqlite leaves the `-wal` file on disk after a clean close too, so
    // `existsSync` proves nothing either way.
    expect(fs.statSync(`${traceDb(ws.markerRoot, requestId)}-wal`).size).toBe(0);

    // And the SAME requestId still works.
    // A wedged session row makes this second run die on initiateSession instead.
    const manifest = writeCodeManifest(ws.dir);
    const after = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000",
        "--journal", path.join(ws.dir, "out-after.json"), "--run-root", ws.dir,
        ...correlation,
      ],
      ws.markerRoot,
    );
    const [afterErr, afterCode] = await Promise.all([new Response(after.stderr).text(), after.exited]);
    expect(afterErr).not.toContain("RequestIdRepoMismatch");
    expect(afterCode).toBe(0);
  }, 60_000);
});

describe("pipeline-run DF3.1 S28: the witness is fresh-bound to THIS run (±30 min)", () => {
  // `runContextFrom`'s temporal binding: a witness only vouches for a ceiling
  // while its mtime sits inside ±WITNESS_FRESH_WINDOW_MS of now. The two ways a
  // wrong ceiling got in — a leftover run-context.json from an earlier, larger
  // dispatch sharing the directory, and one committed beside the manifest — are
  // both OLD; dispatch's own handoff writes the witness moments before the box
  // reads it and stays inside the window. Every arm here backdates (or
  // future-dates) the mtime past the window via utimesSync and holds the
  // witness BYTES identical to a case that is honoured elsewhere in this file,
  // so staleness is the only variable that can move the verdict.

  /** AC9b's fixture pair, plus the witness path itself — freshness is judged on the file's own lstat mtime. */
  function witnessed(witnessBody: string): { manifestPath: string; runRoot: string; witnessPath: string } {
    const runRoot = path.join(tmpRoot, `s28-${seq++}`);
    fs.mkdirSync(runRoot, { recursive: true });
    const manifestPath = path.join(runRoot, "pipeline.yaml");
    fs.writeFileSync(manifestPath, "{}\n");
    const witnessPath = path.join(runRoot, "run-context.json");
    fs.writeFileSync(witnessPath, witnessBody);
    return { manifestPath, runRoot, witnessPath };
  }

  const HOUR_AGO = new Date(Date.now() - 60 * 60_000); // 2× the window
  const HOUR_AHEAD = new Date(Date.now() + 60 * 60_000);

  test("a STALE witness on an unstamped manifest REFUSES — round 11 removed the downgrade", () => {
    // Same bytes as the honoured fresh case above ("a witness WITHOUT a stamped
    // manifest still puts the admitted ceiling on the context"); only the mtime
    // differs. This used to warn and downgrade to DF1.6's $0.50 harness
    // default on the theory that the default is "never higher than what was
    // reserved" — false for any admission BELOW $0.50, so a witnessed 250_000
    // µ$ ran at TWICE its ceiling (the exact spawn the reconciliation was built
    // to stop). An undeclared limit has nothing of its own to fall back to, so
    // the undeclared path now takes the same refusing staleness verdict the
    // declared path always did.
    const f = witnessed(JSON.stringify({ effectiveCeilingMicros: 250_000 }));
    fs.utimesSync(f.witnessPath, HOUR_AGO, HOUR_AGO);

    expect(() =>
      runContextFrom("run-s28-1", "req-s28-1", { pipelineId: "stale-witness" }, f),
    ).toThrow(/is stale/);
  });

  test("a FUTURE-dated witness refuses too — Math.abs is the whole point of the window", () => {
    // A clock-skewed or forged mtime an hour ahead is exactly as untrustworthy
    // as one an hour old; a signed age check would honour it. Refusal, not the
    // old downgrade: see the stale-witness arm above.
    const f = witnessed(JSON.stringify({ effectiveCeilingMicros: 250_000 }));
    fs.utimesSync(f.witnessPath, HOUR_AHEAD, HOUR_AHEAD);

    expect(() =>
      runContextFrom("run-s28-2", "req-s28-2", { pipelineId: "future-witness" }, f),
    ).toThrow(/is stale/);
  });

  test("a witness at the INNER edge of the window is still honoured", () => {
    // The boundary arm: `Math.abs(ageMs) <= WITNESS_FRESH_WINDOW_MS` (30 min,
    // module-private in scripts/pipeline-run.ts) is INCLUSIVE, so a witness
    // seconds inside the window vouches for its ceiling. The exact-equality
    // instant is not pinnable here — `Date.now()` inside the reader has already
    // advanced past this fixture's by the time lstat runs — so this backdates
    // by just under the window (2 s of slack against that drift) and pins that
    // the window's width really is ±30 min: any accidental tightening to a
    // smaller constant flips this to absent.
    const f = witnessed(JSON.stringify({ effectiveCeilingMicros: 250_000 }));
    const innerEdge = new Date(Date.now() - 30 * 60_000 + 2_000);
    fs.utimesSync(f.witnessPath, innerEdge, innerEdge);

    const ctx = runContextFrom("run-s28-2b", "req-s28-2b", { pipelineId: "inner-edge-witness" }, f);
    expect(ctx.effectiveCeilingMicros).toBe(250_000);
  });

  test("a witness ONE MINUTE past the outer edge REFUSES — the window is ±30 min, not 'recent enough'", () => {
    // The outer half of the boundary pair with the honoured inner-edge arm
    // above: window + 60 s is outside by construction even against lstat/now
    // drift far larger than the pair's 2 s slack. Together the two arms pin the
    // WIDTH of WITNESS_FRESH_WINDOW_MS (not merely "(0, 60 min)" as both ends
    // at ±1 h did) — shrinking the constant toward CI-flake territory or
    // growing it toward "last week's committed pair accepted" now fails one of
    // them.
    const f = witnessed(JSON.stringify({ effectiveCeilingMicros: 250_000 }));
    const outerEdge = new Date(Date.now() - 31 * 60_000);
    fs.utimesSync(f.witnessPath, outerEdge, outerEdge);

    expect(() =>
      runContextFrom("run-s28-2c", "req-s28-2c", { pipelineId: "outer-edge-witness" }, f),
    ).toThrow(/is stale/);
  });

  test("a DECLARED cap reconciles only against a CURRENT witness — a stale agreeing pair REFUSES", () => {
    // The committed pipeline.yaml + run-context.json pair that agreed before
    // S28 reconciled cleanly and raised the harness cap by naming a number
    // twice. Agreement is not enough when it is old. There is nothing to fall
    // back to on this path — the manifest asserts a ceiling nothing current
    // vouches for — so this refuses instead of downgrading.
    const f = witnessed(JSON.stringify({ effectiveCeilingMicros: 250_000 }));
    fs.utimesSync(f.witnessPath, HOUR_AGO, HOUR_AGO);

    expect(() =>
      runContextFrom(
        "run-s28-3",
        "req-s28-3",
        { pipelineId: "stale-agreeing-pair", limitMicroUsd: 250_000 },
        f,
      ),
    ).toThrow(/is stale/);
  });

  test("a stale witness on an unstamped manifest refuses the RUN (exit 2), not just the cap", async () => {
    // Round 11: the undeclared path's stale downgrade became a refusal. Driven
    // through the spawned runner because that is where the EXIT CODE lives —
    // the direct `runContextFrom` arms above prove the throw; this proves the
    // runner turns it into "the run could not be settled at all" rather than a
    // silently-uncapped spawn. The message must name the constant, so an
    // operator staring at a CI log can find the window without reading source.
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const witness = path.join(ws.dir, "run-context.json");
    fs.writeFileSync(witness, JSON.stringify({ effectiveCeilingMicros: 250_000 }));
    fs.utimesSync(witness, HOUR_AGO, HOUR_AGO);

    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("is stale");
    expect(stderr).toContain("WITNESS_FRESH_WINDOW_MS");
  });

  test("an UNREADABLE witness directory refuses on the unstamped path — never 'uncapped' or mislabelled", () => {
    // Round 11 / E2: an EACCES'd manifest directory used to flow presence
    // (true, fails closed) into a staleness check whose bare catch labelled
    // EVERY errno "it vanished between the presence check and this read" — a
    // factually wrong diagnosis, and after the old downgrade a permissions
    // fault read as an uncapped-at-default run. Now the hardened reader's
    // refusal lands first and the message says unreadable, not vanished.
    // Driven end to end (presence → read → verdict); mode bits are skipped
    // under root, where the read simply succeeds and there is nothing to pin.
    if (process.getuid?.() === 0) return;
    const runRoot = path.join(tmpRoot, `s28-eacces-${seq++}`);
    const manifestDir = path.join(runRoot, "locked");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "pipeline.yaml");
    fs.writeFileSync(manifestPath, "{}\n");
    fs.writeFileSync(
      path.join(manifestDir, "run-context.json"),
      JSON.stringify({ effectiveCeilingMicros: 250_000 }),
    );
    fs.chmodSync(manifestDir, 0o000);
    let threw: unknown;
    try {
      runContextFrom("run-s28-4", "req-s28-4", { pipelineId: "unreadable-witness" }, { manifestPath, runRoot });
    } catch (e) {
      threw = e;
    }
    fs.chmodSync(manifestDir, 0o755);
    expect(threw).toBeDefined();
    const message = String((threw as Error).message);
    expect(message).toContain("run-context.json");
    expect(message).not.toContain("vanished");
    expect(message).not.toContain("left unset");
  });
});

// ---------------------------------------------------------------------------
// PR135 round-2 cluster C: the runner's resident arming policy and the
// gated-retry contract, driven through the spawned runner because the load-
// bearing surfaces (exit code, stderr line, journal resident block) are all
// main()'s.
// ---------------------------------------------------------------------------

/** A green two-code-phase manifest plus a witness brief that ARMS the resident
 * (identity field present), written into one workspace. */
function armedWorkspace(): {
  dir: string;
  journal: string;
  markerRoot: string;
  manifest: string;
  requestId: string;
} {
  const ws = workspace();
  const manifest = writeCodeManifest(ws.dir);
  // One requestId per run: the same UUID is written into the witness brief
  // and returned for --request-id (the sibling e2e suite matches the two).
  const requestId = crypto.randomUUID();
  // The brief IS the cap witness (one file, two readers): it must satisfy the
  // ceiling reconciliation too, or the run refuses before the resident arms.
  fs.writeFileSync(
    path.join(ws.dir, "run-context.json"),
    JSON.stringify({
      requestId,
      repoSlug: "qds/demo",
      issueId: 42,
      effectiveCeilingMicros: 250_000,
    }),
  );
  return { ...ws, manifest, requestId };
}

describe("pipeline-run DF3.3 arming policy (PR135 C)", () => {
  test("C5: an unresolvable resident rate disables the RESIDENT and the run still settles ok (exit 0)", async () => {
    // Pin the rate registry at a path that does not exist: loadRateSources
    // throws RateError inside startResident. The old behaviour refused the
    // whole run (exit 2, nothing settled); the spec's rule is that a slug
    // with no resolvable rate refuses the RESIDENT, never the deterministic
    // run (INV-RES-5).
    const ws = armedWorkspace();
    const proc = spawnRunner(
      [
        "--manifest", ws.manifest, "--budget-ms", "120000", "--journal", ws.journal,
        "--run-root", ws.dir, "--request-id", ws.requestId,
      ],
      ws.markerRoot,
      REPO_ROOT,
      // Force the rate seam: an override dir that does not exist makes
      // loadRateSources throw RateError inside startResident.
      { QDS_PI_CATALOG_DIR: path.join(ws.dir, "no-such-catalog") },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("resident_disabled");
    expect(stderr).toContain("rate_unresolved");
    const journal = readJournal(ws.journal);
    expect(journal.ok).toBe(true);
    expect(journal.resident?.status).toBe("disabled");
    expect(journal.resident?.spendMicros).toBe(0);
  }, 60_000);

  test("INV-RES-3: an armed resident with NO OPENROUTER_API_KEY in the env it would hand pi REFUSES the run — unset and blank alike, never a degrade", async () => {
    // PR #216 round 5: the consumer-policy counterpart of C5's degrade row.
    // An absent key is a credential-CHANNEL fault (same class as DF1.1 INV-4),
    // not an agent-reachability fault on INV-RES-5's degrade list — so the
    // runner must exit non-zero with ResidentKeyAbsentError's message and
    // never take the resident_disabled warn-degrade shape. Blank counts as
    // absent (a whitespace key only ever produces provider auth failures one
    // call at a time), and the refusal fires at startResident's LAST pre-arm
    // gate, before any pi spawn — which is why no fake pi binary is needed.
    // The catalog fixtures keep resolveRate (an EARLIER gate) green, so the
    // verdict really is the key gate's.
    const cases: { name: string; extraEnv: Record<string, string | undefined> }[] = [
      { name: "key unset", extraEnv: { OPENROUTER_API_KEY: undefined } },
      { name: "key blank", extraEnv: { OPENROUTER_API_KEY: "" } },
    ];
    for (const c of cases) {
      const ws = armedWorkspace();
      const proc = spawnRunner(
        [
          "--manifest", ws.manifest, "--budget-ms", "120000", "--journal", ws.journal,
          "--run-root", ws.dir, "--request-id", ws.requestId,
        ],
        ws.markerRoot,
        REPO_ROOT,
        {
          QDS_PI_CATALOG_DIR: path.join(import.meta.dir, "fixtures", "pi-catalog"),
          QDS_PI_MODELS_JSON: path.join(ws.dir, "no-such-models.json"),
          ...c.extraEnv,
        },
      );
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // The top-level catch's exit: the throw escapes main before any settle.
      expect(exitCode, c.name).toBe(2);
      expect(stderr, c.name).toContain(
        "resident refused: OPENROUTER_API_KEY is absent, blank, or carries invisible characters",
      );
      // NOT the warn-degrade shape: no resident_disabled line anywhere.
      expect(stderr, c.name).not.toContain("resident_disabled");
      // And no resident block on the journal: FileJournal's header-only flush
      // is on disk (the constructor ran before arming), but the runner never
      // seeded the block — `resident` is absent, not "disabled".
      const journal = readJournal(ws.journal);
      expect(journal.resident, c.name).toBeUndefined();
      expect(journal.phases, c.name).toEqual([]);
      expect(journal.ok, c.name).toBe(false);
      expect(fs.existsSync(path.join(ws.markerRoot, "journal", "final.json")), c.name).toBe(false);
    }
  }, 120_000);

  test("C6: a credential-shaped brief value refuses the run, naming the field and never the value", async () => {
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const secret = "sk-abcdef1234567890abcdef";
    fs.writeFileSync(
      path.join(ws.dir, "run-context.json"),
      JSON.stringify({ requestId: crypto.randomUUID(), note: secret, effectiveCeilingMicros: 250_000 }),
    );
    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("credential-shaped value at brief.note");
    // The value itself is never echoed.
    expect(stderr).not.toContain(secret);
    // The arming refusal closes the trace store before the throw (the
    // cap-reconciliation pattern): a checkpointed WAL (absent or truncated to
    // zero) is the on-disk proof — an unclosed tracer leaves its frames behind.
    const wal = `${traceDb(ws.markerRoot)}-wal`;
    expect(fs.existsSync(wal) ? fs.statSync(wal).size : 0).toBe(0);
  }, 60_000);

  test("C6: a credential-NAMED brief field refuses the run, naming the field", async () => {
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    fs.writeFileSync(
      path.join(ws.dir, "run-context.json"),
      JSON.stringify({
        requestId: crypto.randomUUID(),
        github_token: "x".repeat(10),
        effectiveCeilingMicros: 250_000,
      }),
    );
    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("credential-named field 'github_token'");
  }, 60_000);

  test("C6: a credential-shaped value inside an ARRAY refuses the run, naming the element path", async () => {
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const secret = "sk-abcdef1234567890abcdef";
    fs.writeFileSync(
      path.join(ws.dir, "run-context.json"),
      JSON.stringify({
        requestId: crypto.randomUUID(),
        // The scan walks array elements — a credential-shaped string must not
        // slip past a properties-only walk on the array's parent object.
        notes: ["clean note", secret],
        effectiveCeilingMicros: 250_000,
      }),
    );
    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("credential-shaped value at brief.notes[1]");
    expect(stderr).not.toContain(secret);
  }, 60_000);

  test("C6: a credential-named field on an OBJECT inside an array refuses the run", async () => {
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    fs.writeFileSync(
      path.join(ws.dir, "run-context.json"),
      JSON.stringify({
        requestId: crypto.randomUUID(),
        targets: [{ name: "ok" }, { api_key: "x".repeat(10) }],
        effectiveCeilingMicros: 250_000,
      }),
    );
    const proc = spawnRunner(
      ["--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal, "--run-root", ws.dir],
      ws.markerRoot,
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("credential-named field 'api_key' in brief.targets[1]");
  }, 60_000);

  test("an IN-SET select_roster at run_start is accepted, consumed by the named dispatch_task phase, and traced applied:true", async () => {
    // The accepted-pick half of the roster wiring (the out-of-set rejection is
    // pinned in resident-e2e.test.ts). Wave-1 semantics pinned here: rosterIds
    // are advertised ONLY at run_start; directive.phase must name a manifest
    // phase; the pick is consumed by the dispatch_task phase whose name
    // matches, leaving a residentRosterChoice trace row (applied:true).
    //
    // The roster must live INSIDE the repo root (loadRoster's INV-2
    // confinement), so the manifest points at the DF1.6 fixture roster
    // (roles: lead, worker). The dispatch itself is refused cheaply and
    // deterministically: QDS_TEAM_RUNNER is not "local", so dispatchTask's AC5
    // refusal fires FIRST — no pi catalog probe, no team spawn, no network.
    const ws = workspace();
    const roster = path.join(import.meta.dir, "fixtures", "dispatch-roster.yaml");
    const manifest = path.join(ws.dir, "pipeline.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "roster-accept",
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
            name: "ship",
            kind: "dispatch_task",
            description: "Dispatch the roster-picked role to do the work",
            maxDurationMs: 15_000,
            retries: 0,
            roster,
            task: "fix the seeded failing test",
          },
        ],
      }),
    );
    // One requestId per run: the witness brief and --request-id agree.
    const requestId = crypto.randomUUID();
    fs.writeFileSync(
      path.join(ws.dir, "run-context.json"),
      JSON.stringify({
        requestId,
        repoSlug: "qds/demo",
        issueId: 42,
        effectiveCeilingMicros: 250_000,
      }),
    );
    const proc = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal,
        "--run-root", ws.dir, "--request-id", requestId,
      ],
      ws.markerRoot,
      REPO_ROOT,
      {
        // The env-scripted fake resident, same seam as resident-e2e.test.ts;
        // the S2-4 child-env allowlist strips FAKE_RESIDENT_REPLIES unless the
        // passthrough names it.
        QDS_PI_BIN: path.join(import.meta.dir, "fixtures", "fake-resident.ts"),
        QDS_PI_CATALOG_DIR: path.join(import.meta.dir, "fixtures", "pi-catalog"),
        QDS_PI_MODELS_JSON: path.join(ws.dir, "no-such-models.json"),
        QDS_RESIDENT_ENV_PASSTHROUGH: "FAKE_RESIDENT_REPLIES",
        FAKE_RESIDENT_REPLIES: JSON.stringify([
          JSON.stringify({ action: "select_roster", phase: "ship", rosterId: "lead" }),
          JSON.stringify({ action: "proceed" }),
        ]),
        // AC5 refusal before any spawn: deterministic on every host.
        QDS_TEAM_RUNNER: "refused-for-test",
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    // The dispatch refusal is a VALUE carrying exitStatus:"logic" (DF1.6:
    // refusals are data on the merged output), and the engine now honors the
    // declared verdict (DF6.2, PR #136): the phase records FAIL with the
    // refusal reason and the run settles not-ok, exit 1.
    expect(exitCode).toBe(1);
    const journal = readJournal(ws.journal);
    expect(journal.ok).toBe(false);
    expect(journal.phases.map((p) => [p.name, p.status])).toEqual([
      ["plan", "success"],
      ["ship", "fail"],
    ]);
    expect(journal.phases[1]?.error?.message).toContain("QDS_TEAM_RUNNER");

    // In-set acceptance at run_start: the closed roster id set was advertised
    // there and "lead" is in it — accepted, not tripwire-rejected.
    const solicits = jsonLines(stderr).filter((l) => l.event === "resident_solicit");
    expect(solicits.map((l) => l.point)).toEqual(["run_start", "run_end"]);
    expect(solicits[0]?.directiveAction).toBe("select_roster");
    expect(solicits[0]?.accepted).toBe(true);
    expect(solicits[1]?.directiveAction).toBe("proceed");
    // Round 7 / S1-1: run_end accepts proceed ONLY — this pin locks the one
    // allowed run_end action into the accepted path (anything else would now
    // be a counted rejection with a gate_bypass_attempt tripwire).
    expect(solicits[1]?.accepted).toBe(true);
    expect(journal.resident?.status).toBe("active");
    expect(journal.resident?.directives).toBe(2);
    expect(journal.resident?.directivesRejected).toBe(0);
    expect(journal.resident?.tripwires).toEqual([]);

    const rows = fs
      .readFileSync(path.join(runTree(ws.markerRoot, requestId), "trace", "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type?: string; name?: string; payload_json?: string | null });
    // The accepted run_start directive's own record (S3-15).
    const directives = rows.filter((r) => r.type === "log" && r.name === "resident_directive");
    expect(directives).toHaveLength(1);
    const directive = JSON.parse(directives[0]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(directive.point).toBe("run_start");
    expect(directive.action).toBe("select_roster");
    expect(directive.phase).toBe("ship");
    expect(directive.rosterId).toBe("lead");
    // rosterChoice.pending CONSUMED by the named phase: exactly one
    // residentRosterChoice row, applied:true — and none of the
    // applied:false rows (phase mismatch, or the run-end "never consumed").
    const choices = rows
      .filter((r) => r.type === "log" && r.name === "residentRosterChoice")
      .map((r) => JSON.parse(r.payload_json ?? "{}") as Record<string, unknown>);
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ rosterId: "lead", phase: "ship", applied: true });
  }, 60_000);

  test("duplicate dispatch_task phase names tripwire the S3-7 fail-safe: steering disabled, every pick rejected, run still settles", async () => {
    // PR #216 round 4 (PM1). The manifest schema deliberately has NO
    // name-uniqueness check, and duplicate dispatch_task names make roster-pick
    // routing first-match ambiguous — so pipeline-run refuses to arm ROSTER
    // steering (S3-7): the advertised rosterIds/phaseIds sets go EMPTY, every
    // select_roster hits steering.ts's fail-closed rejection, and the resident
    // still arms for retry/abort guidance. The exact event name is
    // `resident_roster_steering_disabled` (pipeline-run.ts). Same manifest/
    // witness/env shape as the in-set case above; only the phase list and the
    // expected verdict differ, so the contrast between the two cases is the
    // pin: identical arming inputs, one duplicated name apart.
    const ws = workspace();
    const roster = path.join(import.meta.dir, "fixtures", "dispatch-roster.yaml");
    const manifest = path.join(ws.dir, "pipeline.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "roster-dup-name",
        runBudgetMs: 150_000,
        phases: [
          {
            name: "plan",
            kind: "code",
            description: "Emit the plan artifact for the requested change",
            maxDurationMs: 15_000,
            retries: 0,
            command: ["echo", "planned"],
          },
          // Two dispatch_task phases with the SAME name: schema-admitted (the
          // gap S3-7 exists to cover). The first is refused by the cheap AC5
          // arm below — no probe, no spawn, no network — and the fail-fast
          // walk never reaches the second.
          {
            name: "ship",
            kind: "dispatch_task",
            description: "Dispatch the roster-picked role to do the work",
            maxDurationMs: 15_000,
            retries: 0,
            roster,
            task: "fix the seeded failing test",
          },
          {
            name: "ship",
            kind: "dispatch_task",
            description: "Dispatch the second identically-named phase",
            maxDurationMs: 15_000,
            retries: 0,
            roster,
            task: "fix the seeded failing test again",
          },
        ],
      }),
    );
    const requestId = crypto.randomUUID();
    fs.writeFileSync(
      path.join(ws.dir, "run-context.json"),
      JSON.stringify({
        requestId,
        repoSlug: "qds/demo",
        issueId: 42,
        effectiveCeilingMicros: 250_000,
      }),
    );
    const proc = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "150000", "--journal", ws.journal,
        "--run-root", ws.dir, "--request-id", requestId,
      ],
      ws.markerRoot,
      REPO_ROOT,
      {
        QDS_PI_BIN: path.join(import.meta.dir, "fixtures", "fake-resident.ts"),
        QDS_PI_CATALOG_DIR: path.join(import.meta.dir, "fixtures", "pi-catalog"),
        QDS_PI_MODELS_JSON: path.join(ws.dir, "no-such-models.json"),
        QDS_RESIDENT_ENV_PASSTHROUGH: "FAKE_RESIDENT_REPLIES",
        FAKE_RESIDENT_REPLIES: JSON.stringify([
          // An in-roster pick that WOULD be legal on the manifest above — the
          // duplicated name alone must make it unlawful.
          JSON.stringify({ action: "select_roster", phase: "ship", rosterId: "lead" }),
          JSON.stringify({ action: "proceed" }),
        ]),
        QDS_TEAM_RUNNER: "refused-for-test",
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    // The run proceeds deterministically for everything except roster picks.
    // The walk is fail-fast (DF1.1): the FIRST ship's AC5 refusal halts it, so
    // the second identically-named phase never runs — the S3-7 trigger is the
    // manifest's duplicated names at arming time, not the second execution.
    expect(exitCode).toBe(1);
    const journal = readJournal(ws.journal);
    expect(journal.ok).toBe(false);
    expect(journal.phases.map((p) => [p.name, p.status])).toEqual([
      ["plan", "success"],
      ["ship", "fail"],
    ]);

    // The S3-7 refusal is visible, not silent: the stderr event names the
    // duplicated dispatch name(s) — never roster content.
    const disabled = jsonLines(stderr).find((l) => l.event === "resident_roster_steering_disabled");
    expect(disabled).toBeDefined();
    expect(disabled?.reason).toBe("duplicate_dispatch_phase_names");
    expect(String(disabled?.detail)).toContain("ship");
    expect(jsonLines(stderr).filter((l) => l.event === "resident_roster_steering_disabled")).toHaveLength(1);

    // The pick was REJECTED against the emptied closed set, not applied: the
    // fold resolves to the deterministic default, accepted:false, with the
    // gate_bypass_attempt tripwire carrying the out-of-set rosterId.
    const solicits = jsonLines(stderr).filter((l) => l.event === "resident_solicit");
    expect(solicits.map((l) => l.point)).toEqual(["run_start", "run_end"]);
    expect(solicits[0]?.directiveAction).toBe("proceed");
    expect(solicits[0]?.accepted).toBe(false);
    expect(solicits[1]?.directiveAction).toBe("proceed");
    expect(solicits[1]?.accepted).toBe(true);
    expect(journal.resident?.status).toBe("active");
    expect(journal.resident?.directives).toBe(1);
    expect(journal.resident?.directivesRejected).toBe(1);
    expect(journal.resident?.tripwires).toHaveLength(1);
    const tripwire = (journal.resident?.tripwires ?? [])[0] as { cause?: string; detail?: string } | undefined;
    expect(tripwire?.cause).toBe("gate_bypass_attempt");
    expect(tripwire?.detail).toContain("lead");

    // NOT APPLIED, end to end: no residentRosterChoice row exists at all — no
    // pending was banked (so no applied:true pick and no run-end
    // never-consumed row either), and no resident_directive row (both folded
    // directives resolved to proceed, which stays quiet by design). The pick's
    // rejection IS observed though: exactly one residentTripwire row.
    const rows = fs
      .readFileSync(path.join(runTree(ws.markerRoot, requestId), "trace", "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type?: string; name?: string });
    expect(rows.filter((r) => r.type === "log" && r.name === "residentRosterChoice")).toHaveLength(0);
    expect(rows.filter((r) => r.type === "log" && r.name === "resident_directive")).toHaveLength(0);
    const tripwireRows = rows.filter((r) => r.type === "log" && r.name === "residentTripwire");
    expect(tripwireRows).toHaveLength(1);
  }, 60_000);

  test("a broken steering inbox lands a steeringInboxError trace row whose payload CARRIES THE FAULT (F5.33/F5.34)", async () => {
    // The runner's onInboxError used to stringify the observer's whole
    // argument: `JSON.stringify(error)` renders `{}` (message/stack are
    // non-enumearable own properties), so the one trace row the wiring added
    // for exactly the fault its comment says "the operator has to be able to
    // see" recorded THAT something happened and nothing about what. The
    // payload is now the fault's own fields — detail, runId, requestId.
    const ws = workspace();
    // Code-only phases, so the run itself is deterministically GREEN: the only
    // fault in play is the inbox one, and the exit code below is pinned to 0
    // (round-10 S3) rather than tolerated as "0 or 1". A dispatch_task phase
    // here used to fail the run for its own unrelated reasons (no team runner),
    // which is exactly the slack the old `toContain([0, 1])` was absorbing.
    const manifest = writeCodeManifest(ws.dir);
    const requestId = crypto.randomUUID();
    fs.writeFileSync(
      path.join(ws.dir, "run-context.json"),
      JSON.stringify({ requestId, repoSlug: "qds/demo", issueId: 42, effectiveCeilingMicros: 250_000 }),
    );
    // EISDIR on every drain: a DIRECTORY at the inbox path is a non-ENOENT
    // read failure — the broken-channel arm steering's `drain` rethrows.
    const steeringRoot = path.join(ws.dir, "steering-root");
    fs.mkdirSync(path.join(steeringRoot, "inbox.ndjson"), { recursive: true });
    const proc = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal,
        "--run-root", ws.dir, "--request-id", requestId,
      ],
      ws.markerRoot,
      REPO_ROOT,
      {
        QDS_PI_BIN: path.join(import.meta.dir, "fixtures", "fake-resident.ts"),
        QDS_PI_CATALOG_DIR: path.join(import.meta.dir, "fixtures", "pi-catalog"),
        QDS_PI_MODELS_JSON: path.join(ws.dir, "no-such-models.json"),
        QDS_RESIDENT_ENV_PASSTHROUGH: "FAKE_RESIDENT_REPLIES",
        FAKE_RESIDENT_REPLIES: JSON.stringify([JSON.stringify({ action: "proceed" })]),
        QDS_STEERING_ROOT: steeringRoot,
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    // The sidecar rule, pinned (round-10 S3): a broken steering channel must
    // not fail an otherwise green run — the inbox is a sidecar and an inbox
    // fault is not a resident fault — but the fault must be visible, which is
    // the row the assertions below read. "0 or 1" absorbed an unrelated
    // dispatch failure; the manifest above is code-only, so 0 is the only
    // honest value and anything else is a regression in its own right.
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("unhandled");

    const rows = fs
      .readFileSync(path.join(runTree(ws.markerRoot, requestId), "trace", "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type?: string; name?: string; payload_json?: string | null });
    const errors = rows
      .filter((r) => r.type === "log" && r.name === "steeringInboxError")
      .map((r) => JSON.parse(r.payload_json ?? "{}") as Record<string, unknown>);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // THE assertion: the fault is legible — not the `{}` of a stringified
    // Error. `detail` is steering's own sanitized fault text (it names the
    // channel), and the join keys ride along.
    expect(String(errors[0]?.detail)).toContain("steering inbox");
    expect(errors[0]?.runId).toBeTypeOf("string");
    expect((errors[0]?.requestId as string | undefined)?.length).toBeGreaterThan(0);
  }, 60_000);

  test("S1/S2: a bare-uuid run id folds ONLY its own inbox lines — foreign lines are skipped, never acked — and an acked line never re-folds", async () => {
    // Round-10 S1: the own-run filter used to be DISABLED whenever `runId` was
    // not in the minted fleet shape — which is the DEFAULT configuration, since
    // the runner's default `--run-id` is `crypto.randomUUID()`. With the filter
    // off, every line queued for OTHER runs on this shared host inbox folded
    // into THIS run's prompt AND was acked: consumed, so the run it was
    // addressed to never saw it. The filter now never turns off — the cost of a
    // non-fleet id lands on a warn whose event was renamed to
    // `steering_ownrun_id_space_mismatch`.
    //
    // S2 rides the same run: the queue is persistent, so every drain re-offers
    // own-1 in full; the runner hands the engine its ack log (`ackedIds`), so
    // after run_start's fold+ack the later drains must treat it as SETTLED —
    // folded once, acked once, for the whole run.
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const requestId = crypto.randomUUID();
    fs.writeFileSync(
      path.join(ws.dir, "run-context.json"),
      JSON.stringify({ requestId, repoSlug: "qds/demo", issueId: 42, effectiveCeilingMicros: 250_000 }),
    );
    // The default `--run-id` shape, spelled out: a bare uuid never matches
    // MINTED_FLEET_RUN_ID_RE, so this run takes the warn arm — without paying
    // for a second spawn to read the minted uuid back out of the journal.
    const ownRunId = "12345678-1234-4567-8901-234567890123";
    const steeringRoot = path.join(ws.dir, "steering-root");
    fs.mkdirSync(steeringRoot, { recursive: true });
    const line = (messageId: string, runId: string | undefined, message: string): string =>
      `${JSON.stringify({ messageId, ...(runId === undefined ? {} : { runId }), message, sentAt: "2026-08-31T00:00:00.000Z" })}\n`;
    // Three lines: this run's own guidance, another run's, and an
    // unattributable one (no runId at all — the transport cannot prove it is
    // this run's guidance, so it is foreign too).
    fs.writeFileSync(
      path.join(steeringRoot, "inbox.ndjson"),
      line("own-1", ownRunId, "raise the retry budget to five") +
        line("foreign-1", "qds-20260831-ab12cd", "another run's guidance") +
        line("unattributed-1", undefined, "guidance with no run id"),
    );
    const proc = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal,
        "--run-root", ws.dir, "--request-id", requestId, "--run-id", ownRunId,
      ],
      ws.markerRoot,
      REPO_ROOT,
      {
        QDS_PI_BIN: path.join(import.meta.dir, "fixtures", "fake-resident.ts"),
        QDS_PI_CATALOG_DIR: path.join(import.meta.dir, "fixtures", "pi-catalog"),
        QDS_PI_MODELS_JSON: path.join(ws.dir, "no-such-models.json"),
        QDS_RESIDENT_ENV_PASSTHROUGH: "FAKE_RESIDENT_REPLIES",
        FAKE_RESIDENT_REPLIES: JSON.stringify([JSON.stringify({ action: "proceed" })]),
        QDS_STEERING_ROOT: steeringRoot,
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("unhandled");
    // The renamed warn — the id-space mismatch is the operator's fact to fix,
    // and the event name is what an operator greps for.
    expect(stderr).toContain("steering_ownrun_id_space_mismatch");
    expect(stderr).toContain("id_space_mismatch");
    // ...and the transport counted the two foreign lines out loud, once per
    // drain, in its own capped diagnostic.
    expect(stderr).toContain("skipped 2 message(s) addressed to other runs");

    // Every prompt the resident saw: own guidance in, nobody else's in.
    const promptFiles = fs
      .readdirSync(ws.dir)
      .filter((f) => f.endsWith("-prompt.txt"))
      .map((f) => [f, fs.readFileSync(path.join(ws.dir, f), "utf8")] as const);
    const prompts = promptFiles.map(([, t]) => t).join("\n");
    expect(promptFiles.length).toBeGreaterThanOrEqual(2); // run_start AND run_end drained
    expect(prompts).toContain("raise the retry budget to five");
    expect(prompts).not.toContain("another run's guidance");
    expect(prompts).not.toContain("guidance with no run id");
    // S2, in-run half: run_start and run_end both drain the SAME persistent
    // queue, and the runner's promptContext is CUMULATIVE — run_end's prompt
    // legitimately carries run_start's fold. What S2 forbids is a SECOND fold
    // of the same message into that later prompt, so each artifact carries the
    // folded line exactly once; a re-fold would append a second one.
    for (const [, text] of promptFiles) {
      expect(text.split("operator attach own-1:").length - 1).toBe(1);
    }

    // Only the own line was ever consumed — the ack would have told the OTHER
    // run's `fleet attach` its message landed when this resident swallowed it.
    const acks = fs
      .readFileSync(path.join(steeringRoot, "acks.ndjson"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { messageId?: unknown });
    expect(acks.map((a) => a.messageId)).toEqual(["own-1"]);
    // S2, durable half: the settled id came back SETTLED from the ack log the
    // runner tails, so the second drain neither re-folded (asserted above) nor
    // re-acked it.
    expect(acks.filter((a) => a.messageId === "own-1")).toHaveLength(1);
  }, 60_000);

  test("C12: a brief source that never existed stays QUIET (AC4), and the unreadable branch warns", async () => {
    // Reachability note: the brief source IS the cap witness, and
    // `runContextFrom` refuses a present-but-unreadable witness first — so the
    // warning branch is only reachable through a between-reads swap (TOCTOU),
    // which no deterministic e2e can drive. The e2e arm pins AC4's quiet path;
    // the source arm pins that the catch DISTINGUISHES absent from unreadable
    // rather than swallowing both (this file's layout-detector precedent).
    const quiet = workspace();
    const manifest2 = writeCodeManifest(quiet.dir);
    const proc2 = spawnRunner(
      ["--manifest", manifest2, "--budget-ms", "120000", "--journal", quiet.journal, "--run-root", quiet.dir],
      quiet.markerRoot,
    );
    const [silent, code2] = await Promise.all([new Response(proc2.stderr).text(), proc2.exited]);
    expect(code2).toBe(0);
    expect(silent).not.toContain("resident brief source");
    expect(readJournal(quiet.journal).resident?.status).toBe("disabled");

    const source = fs.readFileSync(path.join(REPO_ROOT, "scripts", "pipeline-run.ts"), "utf8");
    expect(source).toContain("resident brief source");
    expect(source).toMatch(/code\s*!==\s*"ENOENT"/);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// DF1.11 AC3/AC4b (leaf-4b): the ownrun mismatch warn on the HARVESTED trace
// sidecar, and the boot anchor row on a reboot-surviving surface. Driven
// through the spawned runner for the same reason as every block above: the
// load-bearing surfaces are main()'s (the sidecar row, the engine log tee).
// ---------------------------------------------------------------------------

describe("pipeline-run DF1.11 AC3/AC4b", () => {
  test("ownrun-sidecar: a bare-uuid --run-id puts steering_ownrun_id_space_mismatch on the TRACER SIDECAR and every foreign attach line drains to nothing", async () => {
    // INV-IBOX-11: a non-minted run id rejects every attach line while the run
    // reports healthy — invisible from the host and indistinguishable from an
    // idle operator — so the mismatch warn must reach a HARVESTED surface.
    // In-box stderr is journald's, and journald is where nobody is looking
    // (AC3); the trace sidecar rides DF2.5's harvest tar. Same fixture shape
    // as the S1/S2 row above — what is NEW here is where the warn is read
    // from (events.jsonl, not stderr) and that the inbox holds ONLY foreign
    // lines, so the filter's verdict is "everything rejected", not "own line
    // folded beside skipped ones".
    const ws = workspace();
    const manifest = writeCodeManifest(ws.dir);
    const requestId = crypto.randomUUID();
    fs.writeFileSync(
      path.join(ws.dir, "run-context.json"),
      JSON.stringify({ requestId, repoSlug: "qds/demo", issueId: 42, effectiveCeilingMicros: 250_000 }),
    );
    // The default `--run-id` shape: a bare uuid never matches
    // MINTED_FLEET_RUN_ID_RE, so this run takes the warn arm.
    const ownRunId = "12345678-1234-4567-8901-234567890123";
    const steeringRoot = path.join(ws.dir, "steering-root");
    fs.mkdirSync(steeringRoot, { recursive: true });
    // FOREIGN lines only: two fleet ids addressed to other runs, and an
    // unattributed line. Every attach line this run can see belongs to
    // someone else; the ownRunId filter must reject ALL of them.
    const line = (messageId: string, runId: string | undefined, message: string): string =>
      `${JSON.stringify({ messageId, ...(runId === undefined ? {} : { runId }), message, sentAt: "2026-08-31T00:00:00.000Z" })}\n`;
    fs.writeFileSync(
      path.join(steeringRoot, "inbox.ndjson"),
      line("foreign-1", "qds-20260831-ab12cd", "another run's guidance") +
        line("foreign-2", "qds-20260831-cd34ef", "a third run's guidance") +
        line("unattributed-1", undefined, "guidance with no run id"),
    );
    const proc = spawnRunner(
      [
        "--manifest", manifest, "--budget-ms", "120000", "--journal", ws.journal,
        "--run-root", ws.dir, "--request-id", requestId, "--run-id", ownRunId,
      ],
      ws.markerRoot,
      REPO_ROOT,
      {
        QDS_PI_BIN: path.join(import.meta.dir, "fixtures", "fake-resident.ts"),
        QDS_PI_CATALOG_DIR: path.join(import.meta.dir, "fixtures", "pi-catalog"),
        QDS_PI_MODELS_JSON: path.join(ws.dir, "no-such-models.json"),
        QDS_RESIDENT_ENV_PASSTHROUGH: "FAKE_RESIDENT_REPLIES",
        FAKE_RESIDENT_REPLIES: JSON.stringify([JSON.stringify({ action: "proceed" })]),
        QDS_STEERING_ROOT: steeringRoot,
      },
    );
    // Drain stdout concurrently with stderr/exit (the idiom driver.test.ts
    // grew for its own spawns): the runner is spawned stdout:"pipe", and
    // nothing reading it means a child writing >64KB there fills the pipe,
    // blocks on write, and surfaces as a test TIMEOUT instead of the arm's
    // own assertion.
    const stdoutDrained = new Response(proc.stdout).text();
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited, stdoutDrained]);
    expect(exitCode).toBe(0);
    // The stderr warn stays (it also feeds the engine log)…
    expect(stderr).toContain("steering_ownrun_id_space_mismatch");
    // …and the transport counted all three foreign lines out loud.
    expect(stderr).toContain("skipped 3 message(s) addressed to other runs");

    // THE assertion: the warn row is on the harvested trace sidecar, not
    // stderr-only. Exactly one row — the warn is emitted once per engine
    // STARTUP (hoisted to main(), right after the boot anchor; the steering
    // arming no longer emits it), so an armed run like this one still carries
    // exactly one. The trace tree is keyed by the invocation's IDENTITY
    // (#217 F-D1), which for a `--run-id` run is the runId — the bare uuid
    // above, not the requestId.
    const rows = jsonLines(
      fs.readFileSync(path.join(runTree(ws.markerRoot, ownRunId), "trace", "events.jsonl"), "utf8"),
    ) as unknown as { type?: string; name?: string; payload_json?: string | null }[];
    const warns = rows
      .filter((r) => r.type === "log" && r.name === "steeringOwnrunIdSpaceMismatch")
      .map((r) => JSON.parse(r.payload_json ?? "{}") as Record<string, unknown>); // dp:ok payload_json is nullable by the tracer's own schema; "{}" then fails the toMatchObject below
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ runId: ownRunId, requestId, reason: "id_space_mismatch" });
    expect(String(warns[0]?.detail)).toContain("fleet attach");

    // And the filter's silent work: every drain ran (both solicitations left a
    // prompt artifact) yet NO prompt ever carried a foreign message, and no
    // ack was ever written — the queue drains to nothing for this run.
    const promptFiles = fs
      .readdirSync(ws.dir)
      .filter((f) => f.endsWith("-prompt.txt"));
    expect(promptFiles.length).toBeGreaterThanOrEqual(2); // run_start AND run_end drained
    const prompts = promptFiles.map((f) => fs.readFileSync(path.join(ws.dir, f), "utf8")).join("\n");
    expect(prompts).not.toContain("another run's guidance");
    expect(prompts).not.toContain("a third run's guidance");
    expect(prompts).not.toContain("guidance with no run id");
    const acksFile = path.join(steeringRoot, "acks.ndjson");
    expect(fs.existsSync(acksFile) ? fs.readFileSync(acksFile, "utf8").trim() : "").toBe("");
  }, 60_000);

  test("engine startup writes EXACTLY ONE engine_boot_anchor row (boot_id + uptime_s) into the engine log — one per startup, never the trace sidecar", async () => {
    // AC4b: the row anchors the run to a boot so a reboot under it is
    // attributable at harvest (the anchored boot_id against the box's live
    // one). The SURFACE is half the contract: it must survive the event it
    // records, so it is the ext4 engine log (`--engine-log`, tee'd fd 2),
    // never the tmpfs trace sidecar a reboot wipes — the negative control
    // names exactly that. Adds no key to ResidentTelemetry, the journal
    // `resident` block or DF2.1's run record; the boot_id is the whole
    // signal (no counter, no poller).
    const ws = workspace();
    const engineLog = path.join(ws.dir, "engine.log");
    const bootRows = (): Record<string, unknown>[] =>
      jsonLines(fs.readFileSync(engineLog, "utf8")).filter((l) => l.event === "engine_boot_anchor");
    // /proc/uptime read per RUN (review round 2, F11): each anchor row is
    // bounded by the read taken right after its OWN runner exited — the old
    // single read after both runs charged row 1 for all of run 2's lifetime,
    // which is exactly what the 15 s slack existed to absorb. Same
    // read-degrade shape as writeBootAnchorRow itself: null (never a throw)
    // when /proc is absent, so the darwin null-arm below keeps covering it.
    const readLiveUptime = (): number | null => {
      try {
        const v = Number.parseFloat(fs.readFileSync("/proc/uptime", "utf8"));
        return Number.isFinite(v) ? v : null;
      } catch {
        return null;
      }
    };

    const first = spawnRunner(
      [
        "--manifest", writeCodeManifest(ws.dir), "--budget-ms", "120000",
        "--journal", path.join(ws.dir, "out-1.json"), "--run-root", ws.dir,
        "--run-id", "boot-a", "--engine-log", engineLog,
      ],
      ws.markerRoot,
    );
    // Drain both pipes concurrently with exit (the idiom driver.test.ts grew
    // for its own spawns): fd 2 carries the tee'd engine event stream and the
    // spawn is stdout:"pipe" — either left unread fills at 64KB, blocks the
    // child on write, and surfaces as an opaque test TIMEOUT instead of this
    // arm's own assertion.
    const firstDrained = Promise.all([
      new Response(first.stderr).text(),
      new Response(first.stdout).text(),
    ]);
    expect(await first.exited).toBe(0);
    const uptimeAfterFirst = readLiveUptime();
    await firstDrained;
    expect(bootRows()).toHaveLength(1);

    // A second startup appending to the SAME engine log: one row each —
    // never two for one startup, never a swallowed first row. This one runs
    // under a MINTED fleet run id, so it doubles as the complement arm below:
    // a minted id must produce ZERO steeringOwnrunIdSpaceMismatch rows.
    const mintedRunId = "qds-20260831-cd34ef";
    const second = spawnRunner(
      [
        "--manifest", writeCodeManifest(ws.dir), "--budget-ms", "120000",
        "--journal", path.join(ws.dir, "out-2.json"), "--run-root", ws.dir,
        "--run-id", mintedRunId, "--engine-log", engineLog,
      ],
      ws.markerRoot,
    );
    // Same drain as `first` above: both fds read concurrently with exit.
    const secondDrained = Promise.all([
      new Response(second.stderr).text(),
      new Response(second.stdout).text(),
    ]);
    expect(await second.exited).toBe(0);
    const uptimeAfterSecond = readLiveUptime();
    await secondDrained;
    const afterSecond = bootRows();
    expect(afterSecond).toHaveLength(2);
    // The identity keys ride every engine-log line (emitEngineEvent's
    // discipline, pinned end-to-end by in-box-engine.test.ts's full-event-set
    // walk) — without them the row joins to no run at harvest.
    expect(afterSecond.map((r) => r.runId)).toEqual(["boot-a", mintedRunId]);
    for (const row of afterSecond) {
      // No --request-id is passed on either spawn, so this is the DEFAULT
      // generation path: pipeline-run.ts mints crypto.randomUUID() — assert
      // that actual shape, not just "some string" ("" and "undefined" passed).
      expect(row.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }

    // Field names are contract (`boot_id`, `uptime_s`). Values: this suite
    // also runs on darwin, where /proc does not exist — there the honest
    // row carries nulls (the read-degrade contract), never fabricated
    // values; on Linux the live /proc values must actually be there, with
    // uptime compared as a number (no decimal-precision pin). Each row is
    // bounded by the /proc/uptime read taken right after its OWN run exited
    // (F11), not one read after both.
    const boundedRows = afterSecond.map((row, i) => ({
      row,
      liveUptime: [uptimeAfterFirst, uptimeAfterSecond][i] ?? null,
    }));
    for (const { row, liveUptime } of boundedRows) {
      // The anchor is run-scoped: phaseId rides as the every-line EXPLICIT
      // NULL (emitEngineEvent's "never omitted" discipline) on every
      // platform, unlike the /proc-derived fields below.
      expect(row.phaseId).toBeNull();
      if (liveUptime === null) {
        expect(row.boot_id).toBeNull();
        expect(row.uptime_s).toBeNull();
        continue;
      }
      expect(row.boot_id).toBe(fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
      expect(typeof row.uptime_s).toBe("number");
      // Monotonic ceiling, no slack: the row was recorded at that run's
      // STARTUP and liveUptime was read right after that SAME run exited —
      // /proc/uptime only ever grows, so a row above the live read means a
      // wrong column or an inflated value, exactly what the one-sided floor
      // below used to let through.
      expect(row.uptime_s as number).toBeLessThanOrEqual(liveUptime);
      // 8 s slack, per run (review round 2 F11, narrowed from the 15 s that
      // had to span BOTH runs): liveUptime is now the read taken after THIS
      // row's own runner exited, so the window covers one run's
      // startup-to-exit, not the remainder of run 1 plus all of run 2. 8 s
      // per row keeps the combined headroom (16 s) at/above the old
      // effective 15 s margin — the 1→5 history proves single-digit slack
      // under the WIDER window did not hold, so per-row slack stays generous
      // rather than shrinking to it.
      expect(row.uptime_s as number).toBeGreaterThanOrEqual(liveUptime - 8);
    }

    // The negative control, pinned: the row never rides the tmpfs trace
    // sidecar — /run/trace dies on the very reboot this row exists to
    // witness. Both runs' sidecars checked — and the file must EXIST first:
    // mapping an absent file to "" made not.toContain pass vacuously.
    for (const id of ["boot-a", mintedRunId]) {
      const events = path.join(runTree(ws.markerRoot, id), "trace", "events.jsonl");
      expect(fs.existsSync(events)).toBe(true);
      expect(fs.readFileSync(events, "utf8")).not.toContain("engine_boot_anchor");
    }

    // The hoisted mismatch warn, both arms. Neither spawn arms a resident (no
    // run-context.json brief), so only the STARTUP emission can account for
    // these rows — the unarmed blind spot the hoist exists to close: boot-a
    // (non-minted id) carries EXACTLY ONE steeringOwnrunIdSpaceMismatch row,
    // and the minted id carries ZERO (the warn is the non-minted id's cost,
    // not a per-startup constant).
    const mismatchRows = (id: string): Record<string, unknown>[] =>
      jsonLines(fs.readFileSync(path.join(runTree(ws.markerRoot, id), "trace", "events.jsonl"), "utf8"))
        .filter((r) => r.type === "log" && r.name === "steeringOwnrunIdSpaceMismatch");
    expect(mismatchRows("boot-a")).toHaveLength(1);
    expect(mismatchRows(mintedRunId)).toHaveLength(0);
  }, 120_000);
});
