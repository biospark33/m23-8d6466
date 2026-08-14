/**
 * End-to-end slice for `scripts/pipeline-run.ts` (Story DF1.1).
 *
 * The mandatory demo: a versioned manifest on disk drives an ordered, journaled
 * phase walk whose statuses were earned, using only code this story merges.
 * The runner is spawned for real, because the thing under test is the wiring
 * between the manifest, the walk and the process exit code.
 */
import { afterAll, describe, expect, test } from "bun:test";
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
