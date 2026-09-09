/**
 * DF2.11 e2e — the teardown race, cross-process (story slice).
 *
 * Demonstrable: an open record, a live fake-driver box and THREE commits on
 * `sbx/<run-id>`; a teardown harvests while a SECOND teardown races it from
 * another PROCESS. The winner holds `<runsDir>/<run-id>.lock`, so the loser's
 * `withRunLock` refuses with RunLockedError code "run-locked" BEFORE
 * `teardownSandbox` runs — the link(2) claim proven across a real process
 * boundary. Exactly one harvest: rev-list count 3 at refs/sandbox, one bundle
 * that passes `git bundle verify`, one destroy, one close.
 *
 * Plus, in the same file, the DF2.11 read-only ledger proof: a seeded
 * CostLedger read through `openReadOnly` + `readRunCost` leaves the
 * [db, dir, -wal] trio byte-identical (AC6 pattern from cost-ledger.test.ts,
 * snapshot helper re-owned here rather than imported).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SBX_KEY_PREFIX } from "../../src/providers/credentials.ts";
import { VIZ_PIDFILE, createRun, type ExecResult, type ProviderDriver } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { CostLedger, type RunCostRecord } from "../../src/providers/cost-ledger.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { teardownSandbox, type TeardownDeps } from "../../src/providers/teardown.ts";
import { acquireRunLock, releaseRunLock, type RunLockHandle } from "../../scripts/lib/run-lock.ts";
import { FakeKeyApi } from "./fixtures/fake-key-api.ts";
import { RecordingDriver } from "./fixtures/recording-driver.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const RUN_ID = "df2-11-lockrace"; // valid per RUN_ID_RE: [a-z0-9] start AND end, hyphens inside

let root: string;
let runsDir: string;
let repoDir: string;
let boxesRoot: string;
let boxRunRootDir: string;
let boxHomeDir: string;
let store: RunRecordStore;
let api: FakeKeyApi;
let recording: RecordingDriver;
let ledgerRoot: string;
let ledgerWriter: CostLedger | undefined;
let logs: LogEntry[];
let restoreLog: (() => void) | undefined;
const heldLocks: RunLockHandle[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qds-df211-race-"));
  runsDir = join(root, "runs");
  store = new RunRecordStore(runsDir);
  repoDir = join(root, "host-repo");
  boxesRoot = join(root, "boxes");
  boxRunRootDir = join(root, "box-run");
  boxHomeDir = join(root, "box-home");
  mkdirSync(boxRunRootDir, { recursive: true });
  mkdirSync(boxHomeDir, { recursive: true });
  api = new FakeKeyApi({ usageOnCreateUsd: 0.0081 });
  recording = new RecordingDriver(guardVizPidfile(new FakeDriver(boxesRoot)));
  ledgerRoot = mkdtempSync(join(tmpdir(), "qds-df211-ledger-"));
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
});

afterEach(() => {
  for (const lock of heldLocks.splice(0)) releaseRunLock(lock);
  for (const child of children.splice(0)) {
    try {
      child.kill(9);
    } catch {
      // already exited
    }
  }
  ledgerWriter?.close();
  ledgerWriter = undefined;
  restoreLog?.();
  for (const dir of [root, ledgerRoot]) rmSync(dir, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Same guard teardown.test.ts runs: the viz-stop script hard-codes the shared
 * host pidfile, and FakeDriver.exec spawns argv for real on this machine —
 * without the guard any teardown here could kill a developer's recorded
 * visualizer pid. Intercepted one layer under RecordingDriver so execCalls
 * stay populated while the script sees its routine "no pidfile" outcome.
 */
function guardVizPidfile(inner: ProviderDriver): ProviderDriver {
  const guarded = Object.create(inner) as ProviderDriver;
  guarded.exec = (vm: string, argv: string[], stdin?: string): Promise<ExecResult> => {
    if (argv.some((a) => a.includes(VIZ_PIDFILE))) {
      return Promise.resolve({ stdout: "NONE\n", stderr: "", exitCode: 0 });
    }
    return inner.exec(vm, argv, stdin);
  };
  return guarded;
}

/** Host git, sync; nonzero exit throws with stderr. */
function git(args: readonly string[], cwd?: string): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} exited ${res.status}: ${res.stderr}`);
  return (res.stdout ?? "").trim();
}

/** Real throwaway repo: main at a 3-commit base. baseSha is the pinned prerequisite. */
function seedHostRepo(): string {
  git(["init", "-q", "-b", "main", repoDir]);
  for (let i = 1; i <= 3; i++) {
    git([
      "-C",
      repoDir,
      "-c",
      "user.email=host@qds",
      "-c",
      "user.name=host",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `base-${i}`,
    ]);
  }
  return git(["-C", repoDir, "rev-parse", "refs/heads/main"]);
}

/** Clone the host repo into the box as `app`, branch `sbx/<runId>`, THREE commits on it. */
async function fillBox(vmName: string, runId: string): Promise<void> {
  const clone = await recording.exec(vmName, ["git", "clone", "-q", `file://${repoDir}`, "app"]);
  if (clone.exitCode !== 0) throw new Error(`box clone failed: ${clone.stderr}`);
  const branch = await recording.exec(vmName, ["git", "-C", "app", "checkout", "-q", "-b", `sbx/${runId}`]);
  if (branch.exitCode !== 0) throw new Error(`box branch failed: ${branch.stderr}`);
  for (let i = 1; i <= 3; i++) {
    const r = await recording.exec(vmName, [
      "sh",
      "-c",
      `git -C app -c user.email=run@box -c user.name=run -c commit.gpgsign=false commit -q --allow-empty -m box-${i}`,
    ]);
    if (r.exitCode !== 0) throw new Error(`box commit ${i} failed: ${r.stderr}`);
  }
}

/** Open record + live fake box + minted key + pinned base — the pre-teardown world. */
async function seedRun(runId: string): Promise<{ baseSha: string; vmName: string }> {
  const baseSha = seedHostRepo();
  await createRun(recording, store, { runId });
  const vmName = store.get(runId).vmName as string;
  await fillBox(vmName, runId);
  const mint = await api.createKey(`${SBX_KEY_PREFIX}${runId}`, 50);
  store.set(runId, { keyHash: mint.hash, limitMicroUsd: 50_000_000 });
  store.set(runId, { commitSha: baseSha });
  return { baseSha, vmName };
}

function deps(driver: ProviderDriver, gitCwd: string): TeardownDeps {
  return {
    driver,
    store,
    keyApi: api,
    runsDir: store.dir,
    gitCwd,
    workdir: "app",
    boxRunRoot: boxRunRootDir,
    boxHome: boxHomeDir,
  };
}

/** destroy is the one call RecordingDriver does not record — wrap and count it. */
function countingRecording(): { driver: ProviderDriver; destroys(): number } {
  let destroys = 0;
  const wrapper = Object.create(recording) as RecordingDriver;
  wrapper.destroy = (vm: string) => {
    destroys++;
    return recording.destroy(vm);
  };
  return { driver: wrapper, destroys: () => destroys };
}

/** Bounded poll (≤ budget) so the loser only ever spawns after the claim is on disk. */
async function waitForLockFile(path: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`run-lock file never appeared within ${budgetMs}ms: ${path}`);
    await Bun.sleep(10);
  }
}

/**
 * The cross-process loser: real modules, real store/driver, `withRunLock` →
 * `teardownSandbox`. The winner holds the claim, so acquire refuses BEFORE
 * teardown runs; the child prints the refusal's code/message/remediation and
 * exits 1. Reaching the success line means the race was LOST.
 */
function loserScript(runsDirPath: string, runId: string, gitCwd: string): string {
  return `(async () => {
  try {
    const { withRunLock } = await import(${JSON.stringify(join(REPO_ROOT, "scripts", "lib", "run-lock.ts"))});
    const { teardownSandbox } = await import(${JSON.stringify(join(REPO_ROOT, "src", "providers", "teardown.ts"))});
    const { RunRecordStore } = await import(${JSON.stringify(join(REPO_ROOT, "src", "providers", "run-record.ts"))});
    const { FakeDriver } = await import(${JSON.stringify(join(REPO_ROOT, "src", "providers", "fake-driver.ts"))});
    const loserStore = new RunRecordStore(${JSON.stringify(runsDirPath)});
    const loserDriver = new FakeDriver(${JSON.stringify(boxesRoot)});
    await withRunLock(${JSON.stringify(runsDirPath)}, ${JSON.stringify(runId)}, "df2-11-race-loser", () =>
      teardownSandbox(
        { driver: loserDriver, store: loserStore, runsDir: ${JSON.stringify(runsDirPath)}, gitCwd: ${JSON.stringify(gitCwd)}, workdir: "app", boxRunRoot: ${JSON.stringify(boxRunRootDir)}, boxHome: ${JSON.stringify(boxHomeDir)} },
        ${JSON.stringify(runId)},
      ),
    );
    console.log("LOSER ACQUIRED THE LOCK — the race was lost");
  } catch (e) {
    console.error("code=" + e.code);
    console.error("message=" + e.message);
    console.error("remediation=" + e.remediation);
    process.exit(1);
  }
})();`;
}

/** Identity snapshot of the files a read-only open must not disturb (own copy of the AC6 pattern). */
function snapshotFiles(paths: readonly string[]): { name: string; mode: number; mtimeMs: number; size: number }[] {
  return paths.map((p) => {
    const st = statSync(p);
    return { name: p, mode: st.mode & 0o777, mtimeMs: st.mtimeMs, size: st.size };
  });
}

// ─── the race ────────────────────────────────────────────────────────────────

describe("DF2.11 e2e teardown race", () => {
  test(
    "e2e race: the lock winner harvests the 3-commit box exactly once; the cross-process loser refuses run-locked",
    async () => {
      const { baseSha, vmName } = await seedRun(RUN_ID);

      // WINNER first: the claim exists before the loser is ever spawned.
      const lock = acquireRunLock(runsDir, RUN_ID, "df2-11-race-winner");
      heldLocks.push(lock);
      const lockPath = join(runsDir, `${RUN_ID}.lock`);
      await waitForLockFile(lockPath, 5_000);

      const counting = countingRecording();
      const winner = teardownSandbox(deps(counting.driver, repoDir), RUN_ID, lock);
      const child = Bun.spawn(["bun", "-e", loserScript(runsDir, RUN_ID, repoDir)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);

      let loserStderr = "";
      let loserStdout = "";
      let loserExit = -1;
      try {
        await winner;
        loserStderr = await new Response(child.stderr).text();
        loserStdout = await new Response(child.stdout).text();
        loserExit = await child.exited;
      } finally {
        // Release only after both racers settled, and never leave the child behind.
        releaseRunLock(lock);
        try {
          child.kill(9);
        } catch {
          // already exited
        }
      }

      // Loser: refused BEFORE teardown ran, with the machine-readable code + the rm advice.
      expect(loserExit).toBe(1);
      expect(loserStdout.trim()).toBe("");
      expect(loserStderr).toContain("code=run-locked");
      expect(loserStderr).toContain("wait for that invocation to finish");
      expect(loserStderr).toContain(lockPath);

      // Winner: exactly one harvest — 3 commits at the quarantine ref.
      const rev = spawnSync("git", ["rev-list", "--count", `${baseSha}..refs/sandbox/${RUN_ID}`], {
        cwd: repoDir,
        encoding: "utf8",
      });
      expect(rev.status).toBe(0);
      const revCount = (rev.stdout ?? "").trim();
      expect(revCount).toBe("3");

      // One bundle, and it verifies against the pinned prerequisite.
      expect(readdirSync(runsDir).filter((n) => n === `${RUN_ID}.bundle`)).toEqual([`${RUN_ID}.bundle`]);
      const verify = spawnSync("git", ["bundle", "verify", join(runsDir, `${RUN_ID}.bundle`)], {
        cwd: repoDir,
        encoding: "utf8",
      });
      expect(verify.status).toBe(0);

      // Exactly one destroy, one close — the loser touched nothing.
      expect(counting.destroys()).toBe(1);
      expect(store.get(RUN_ID).closedAt).toBeString();
      expect(existsSync(join(boxesRoot, vmName))).toBeFalse();
      expect(existsSync(lockPath)).toBeFalse();
      const summaries = logs.filter((l) => l.operation === "harvest.summary");
      expect(summaries).toHaveLength(1);
      expect(String(summaries[0]?.harvested)).toBe("3");
      expect(logs.filter((l) => l.operation === "teardown.destroy" && l.outcome === "ran")).toHaveLength(1);
      expect(logs.filter((l) => l.operation === "teardown.close" && l.outcome === "ran")).toHaveLength(1);

      console.log(
        `DF2.11 lockrace evidence: revCount=${revCount} destroyCount=${counting.destroys()} ` +
          `bundleVerifyExit=${verify.status} loserExit=${loserExit} ` +
          `loserPayload=${JSON.stringify(loserStderr.slice(0, 240))}`,
      );
    },
    60_000,
  );

  test("e2e no-write proof: CostLedger.openReadOnly + readRunCost leaves [db, dir, -wal] byte-identical", () => {
    const ledgerPath = join(ledgerRoot, "cost-ledger.db");
    const readRunRecord = (runId: string): RunCostRecord | undefined =>
      runId === RUN_ID
        ? {
            createdAt: "2026-08-20T10:00:00.000Z",
            closedAt: "2026-08-20T10:30:00.000Z",
            keyHash: "a".repeat(64),
            limitMicroUsd: 50_000_000,
          }
        : undefined;
    const config = { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 1_000_000 };

    // A real ledger, seeded with one priced box-hours row; the writer stays
    // open so live WAL state is on disk and must survive a reader beside it.
    ledgerWriter = new CostLedger({ path: ledgerPath, readRunRecord, config });
    const seeded = ledgerWriter.ingestBoxHours({
      runId: RUN_ID,
      repoSlug: "qds/demo",
      issueId: "42",
      requestId: "req-df2-11-lockrace",
    });
    expect(seeded.inserted).toBe(true);
    const wal = `${ledgerPath}-wal`;
    expect(statSync(wal).size).toBeGreaterThan(0);

    const watched = [ledgerPath, ledgerRoot, wal];
    const before = snapshotFiles(watched);

    const ro = CostLedger.openReadOnly({ path: ledgerPath, readRunRecord, config });
    try {
      const view = ro.readRunCost(RUN_ID);
      expect(view.eventCount).toBe(1);
      expect(view.totalMicroUsd).toBe(500_000); // 30 min at 1M µ$/h
      expect(view).toEqual(ledgerWriter.readRunCost(RUN_ID));
      expect(snapshotFiles(watched)).toEqual(before);
      console.log(
        `DF2.11 lockrace ledger evidence: openReadOnly wrote nothing — eventCount=${view.eventCount} totalMicroUsd=${view.totalMicroUsd} snapshot=[db,dir,-wal] identical`,
      );
    } finally {
      ro.close();
    }
  });
});
