/**
 * DF2.11 e2e — the teardown race, cross-process (story slice).
 *
 * Two race shapes live here, and they prove different properties:
 *
 * 1. SERIALIZED refusal — the winner acquires `<runsDir>/<run-id>.lock`
 *    BEFORE the loser child is ever spawned, so the loser's `withRunLock`
 *    refuses with RunLockedError code "run-locked" by construction. What this
 *    proves is the refusal path itself: the code/message/remediation surface,
 *    that the loser's acquire throws before `teardownSandbox` runs, and that
 *    the winner still harvests exactly once across a real process boundary.
 * 2. TRUE contention — child racer and in-process racer hit the link(2) claim
 *    off overlapping pre-lock timers, so ordering is genuinely undetermined.
 *    Exactly one wins, and the assertions hold for either winner. (The
 *    lock-claim semantics themselves are owned by tests/scripts/run-lock.test.ts;
 *    nothing there races two acquirers, which is why the simultaneous shape
 *    lives here where the full teardown is already wired.)
 *
 * Plus, in the same file, the DF2.11 read-only ledger proof: a seeded
 * CostLedger read through `openReadOnly` + `readRunCost` leaves the
 * [db, dir, -wal] trio byte-identical (AC6 pattern from cost-ledger.test.ts,
 * snapshot helper re-owned here rather than imported).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SBX_KEY_PREFIX } from "../../src/providers/credentials.ts";
import { VIZ_PIDFILE, createRun, type ExecResult, type ProviderAuditLink, type ProviderDriver } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { CostLedger, type RunCostRecord } from "../../src/providers/cost-ledger.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { teardownSandbox, type TeardownDeps } from "../../src/providers/teardown.ts";
import { acquireRunLock, releaseRunLock, withRunLock, type RunLockHandle } from "../../scripts/lib/run-lock.ts";
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
/**
 * DF5.3: the IN-PROCESS racer's audit links. The child racers' emits used to be
 * invisible here by construction (a no-op sink in another process), which left
 * the arrangement MOST likely to produce a duplicate `run-box.teardown` — two
 * processes racing the same lock, child winning — covered by nothing. The child
 * scripts now append each link as a JSON line to `childLinkLog`, and the
 * contention test asserts over the UNION of both sides.
 */
let auditLinks: ProviderAuditLink[] = [];
/** Where the child racers append their emitted links, one JSON object per line. */
let childLinkLog: string;
/** The child-side links, read back after a race. */
function readChildLinks(): ProviderAuditLink[] {
  if (!existsSync(childLinkLog)) return [];
  return readFileSync(childLinkLog, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ProviderAuditLink);
}

beforeEach(() => {
  auditLinks = [];
  root = mkdtempSync(join(tmpdir(), "qds-df211-race-"));
  childLinkLog = join(root, "child-audit-links.jsonl");
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
  await createRun(recording, store, { runId, recordAuditLink: () => {} });
  const vmName = store.get(runId).vmName as string;
  await fillBox(vmName, runId);
  const mint = await api.createKey(`${SBX_KEY_PREFIX}${runId}`, 50);
  store.set(runId, { keyHash: mint.hash, limitMicroUsd: 50_000_000 });
  store.set(runId, { commitSha: baseSha });
  // DF5.3: ATTRIBUTED, so the teardown actually emits. Unattributed (or with no
  // requestId) every emit is skipped and the exactly-once property this file
  // exists to prove would be vacuous for the audit row.
  store.set(runId, { requestId: "req-df211-race", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
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
    recordAuditLink: (link) => {
      auditLinks.push(link);
    },
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

/**
 * The cross-process loser: real modules, real store/driver, `withRunLock` →
 * `teardownSandbox`. The winner holds the claim, so acquire refuses BEFORE
 * teardown runs; the child prints the refusal's code/message/remediation and
 * exits 1. Reaching the success line means the race was LOST.
 *
 * `recordAuditLink` is REQUIRED — the seam is non-optional on `TeardownDeps`,
 * and nothing typechecks inside a template string, so omitting it leaves a
 * child that calls `undefined` the moment `emitTeardownLink` gets past its
 * attribution guard, surfacing as a missing "RACER WON"/"LOSER" line a mile
 * from the cause.
 *
 * It appends to `linkLog` rather than no-opping (round 3): a no-op made the
 * child's emits unobservable BY CONSTRUCTION, so the arrangement most likely
 * to produce a duplicate `run-box.teardown` — two processes racing the same
 * lock, the CHILD winning — was covered by nothing, and the exactly-once
 * property was pinned only where the in-process side always wins. One JSON
 * object per line, read back by `readChildLinks()`.
 */
function loserScript(runsDirPath: string, runId: string, gitCwd: string, linkLog: string): string {
  return `(async () => {
  try {
    const { appendFileSync } = await import("node:fs");
    const { withRunLock } = await import(${JSON.stringify(join(REPO_ROOT, "scripts", "lib", "run-lock.ts"))});
    const { teardownSandbox } = await import(${JSON.stringify(join(REPO_ROOT, "src", "providers", "teardown.ts"))});
    const { RunRecordStore } = await import(${JSON.stringify(join(REPO_ROOT, "src", "providers", "run-record.ts"))});
    const { FakeDriver } = await import(${JSON.stringify(join(REPO_ROOT, "src", "providers", "fake-driver.ts"))});
    const loserStore = new RunRecordStore(${JSON.stringify(runsDirPath)});
    const loserDriver = new FakeDriver(${JSON.stringify(boxesRoot)});
    await withRunLock(${JSON.stringify(runsDirPath)}, ${JSON.stringify(runId)}, "df2-11-race-loser", () =>
      teardownSandbox(
        { driver: loserDriver, store: loserStore, runsDir: ${JSON.stringify(runsDirPath)}, gitCwd: ${JSON.stringify(gitCwd)}, workdir: "app", boxRunRoot: ${JSON.stringify(boxRunRootDir)}, boxHome: ${JSON.stringify(boxHomeDir)}, recordAuditLink: (l) => appendFileSync(${JSON.stringify(linkLog)}, JSON.stringify(l) + "\\n") },
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

/**
 * The CONTENTIOUS racer: identical shape to the loser above, but after its
 * imports land it announces "RACER AT THE DOOR" (cold-start diagnostic), then
 * attempts `withRunLock`. On ACQUIRING the claim it announces "RACER HOLDS THE
 * CLAIM" and parks INSIDE the callback — holding the lock — for a bounded
 * 500 ms before running the teardown. That park is the host's barrier (see the
 * contention test below): the host does not attempt its own claim until it has
 * SEEN this line, so the two attempts cannot be consecutive, which is the
 * failure mode that outlived the door barrier. On a lost race it prints the
 * refusal's code and exits 1; on a won race it runs the FULL teardown and says
 * so on stdout.
 *
 * Carries the same appending `recordAuditLink` as `loserScript`, for the reason
 * given there — and it matters more here, because this child is the one that
 * actually REACHES the teardown when it wins, and is therefore the only side
 * that can emit a SECOND `run-box.teardown` row for one box.
 */
function racerScript(runsDirPath: string, runId: string, gitCwd: string, linkLog: string): string {
  return `(async () => {
  try {
    const { appendFileSync } = await import("node:fs");
    const { withRunLock } = await import(${JSON.stringify(join(REPO_ROOT, "scripts", "lib", "run-lock.ts"))});
    const { teardownSandbox } = await import(${JSON.stringify(join(REPO_ROOT, "src", "providers", "teardown.ts"))});
    const { RunRecordStore } = await import(${JSON.stringify(join(REPO_ROOT, "src", "providers", "run-record.ts"))});
    const { FakeDriver } = await import(${JSON.stringify(join(REPO_ROOT, "src", "providers", "fake-driver.ts"))});
    const racerStore = new RunRecordStore(${JSON.stringify(runsDirPath)});
    const racerDriver = new FakeDriver(${JSON.stringify(boxesRoot)});
    console.log("RACER AT THE DOOR");
    await withRunLock(${JSON.stringify(runsDirPath)}, ${JSON.stringify(runId)}, "df2-11-race-child", async (h) => {
      console.log("RACER HOLDS THE CLAIM");
      await Bun.sleep(500);
      await teardownSandbox(
        { driver: racerDriver, store: racerStore, runsDir: ${JSON.stringify(runsDirPath)}, gitCwd: ${JSON.stringify(gitCwd)}, workdir: "app", boxRunRoot: ${JSON.stringify(boxRunRootDir)}, boxHome: ${JSON.stringify(boxHomeDir)}, recordAuditLink: (l) => appendFileSync(${JSON.stringify(linkLog)}, JSON.stringify(l) + "\\n") },
        ${JSON.stringify(runId)},
        h,
      );
    });
    console.log("RACER WON — the child ran the teardown");
  } catch (e) {
    console.error("code=" + e.code);
    console.error("message=" + e.message);
    console.error("remediation=" + e.remediation);
    process.exit(1);
  }
})();`;
}

/**
 * Identity snapshot of the files a read-only open must not disturb (own copy
 * of the AC6 pattern, ported from cost-ledger.test.ts including its content
 * hash: a same-size rewrite inside one coarse-mtime tick must still fail the
 * comparison, which mode/mtime/size alone cannot see).
 */
function snapshotFiles(paths: readonly string[]): { name: string; mode: number; mtimeMs: number; size: number; sha256: string }[] {
  return paths.map((p) => {
    const st = statSync(p);
    return {
      name: p,
      mode: st.mode & 0o777,
      mtimeMs: st.mtimeMs,
      size: st.size,
      // A directory has no byte content to hash; the marker can never collide
      // with a file's digest.
      sha256: st.isFile() ? createHash("sha256").update(readFileSync(p)).digest("hex") : "",
    };
  });
}

// ─── the race ────────────────────────────────────────────────────────────────

describe("DF2.11 e2e teardown race", () => {
  test(
    "e2e race (SERIALIZED refusal, not contention): the winner holds the lock before the loser is spawned — the cross-process loser refuses run-locked and the winner harvests the 3-commit box exactly once",
    async () => {
      const { baseSha, vmName } = await seedRun(RUN_ID);

      // WINNER first: the claim exists before the loser is ever spawned. The
      // link(2) claim semantics themselves (stale detection, the refusal
      // payload) are owned by tests/scripts/run-lock.test.ts — this test
      // borrows them to prove the cross-process refusal against a REAL
      // teardown, which is why it serializes on purpose.
      const lock = acquireRunLock(runsDir, RUN_ID, "df2-11-race-winner");
      heldLocks.push(lock);
      const lockPath = join(runsDir, `${RUN_ID}.lock`);
      // F15: the old `waitForLockFile` poll here could never fire its wait —
      // `acquireRunLock` returned first and the claim IS a file on disk, so the
      // predicate was true on entry every time. What the spawn ordering below
      // actually relies on is the claim existing NOW; assert that directly, and
      // an acquire that somehow returned without claiming fails loudly instead
      // of hanging a poll it can no longer hide in.
      expect(existsSync(lockPath)).toBeTrue();

      const counting = countingRecording();
      const winner = teardownSandbox(deps(counting.driver, repoDir), RUN_ID, lock);
      const child = Bun.spawn(["bun", "-e", loserScript(runsDir, RUN_ID, repoDir, childLinkLog)], {
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
        // Release only after both racers settled, and never leave the child
        // behind. Drop the handle from the registry FIRST: the afterEach sweep
        // releases whatever is still listed, so leaving it there made this
        // release a double release that only stayed quiet because
        // `releaseRunLock` tolerates an unheld handle.
        const held = heldLocks.indexOf(lock);
        if (held >= 0) heldLocks.splice(held, 1);
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

      // DF5.3 — exactly one `run-box.teardown` link belongs in this list beside
      // "one destroy, one close": a racer that emitted before losing the lock
      // would duplicate an audit row for one box and nothing else here would
      // notice. The loser is refused BEFORE teardownSandbox runs, so one box
      // teardown means one row, named for the box that came down.
      const boxLinks = auditLinks.filter((l) => `${l.hop}.${l.event}` === "run-box.teardown");
      expect(boxLinks).toHaveLength(1);
      expect(boxLinks[0]?.subjectId).toBe(vmName);
      expect(boxLinks[0]?.repoSlug).toBe("qds/demo");
      expect(boxLinks[0]?.requestId).toBe("req-df211-race");
      // The winner's credential half landed too, once each.
      expect(auditLinks.filter((l) => l.hop === "run-credential").map((l) => l.event)).toEqual([
        "revoke",
        "verify-revoked",
      ]);

      console.log(
        `DF2.11 lockrace evidence: revCount=${revCount} destroyCount=${counting.destroys()} ` +
          `bundleVerifyExit=${verify.status} loserExit=${loserExit} ` +
          `loserPayload=${JSON.stringify(loserStderr.slice(0, 240))}`,
      );
    },
    60_000,
  );

  test(
    "e2e TRUE contention: the child racer claims and HOLDS the lock while the in-process racer attempts — the host attempt is refused run-locked mid-hold, and the child harvests the 3-commit box exactly once",
    async () => {
      // Same pre-teardown world as the marquee test, minus the key: the
      // child racer runs in its own process and cannot see this one's
      // FakeKeyApi, so its teardown is the keyless shape (spend/revoke/verify
      // skip; teardown.test.ts's no-key tests pin that path). The properties
      // under test — exactly one lock claim, one harvest, one destroy, one
      // close — do not involve the key lifecycle.
      const baseSha = seedHostRepo();
      await createRun(recording, store, { runId: RUN_ID, recordAuditLink: (l) => auditLinks.push(l) });
      const vmName = store.get(RUN_ID).vmName as string;
      await fillBox(vmName, RUN_ID);
      store.set(RUN_ID, { commitSha: baseSha });
      // DF5.3: ATTRIBUTED, like `seedRun`. Without this every emit on both
      // sides is skipped and the union assertion below would pass by observing
      // zero — the exact vacuousness the child's no-op sink used to guarantee.
      store.set(RUN_ID, { requestId: "req-df211-race", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });

      // Both racers run the full withRunLock → teardownSandbox. F8's door
      // barrier made the ATTEMPT windows overlap, and that was not enough:
      // run 37081488819 (2026-10-03) lost the XOR because the child claimed at
      // door+15 ms, finished its WHOLE teardown, released — and the host's
      // random timer (drawn past 15 ms + a loaded teardown) then claimed the
      // FREED lock and harvested a second time. Consecutive attempts are
      // legitimate lock behavior; the door barrier only guaranteed they
      // overlapped in time, not that the host's claim landed while the child
      // HELD. So the barrier moved to the hold itself: the child announces
      // "RACER HOLDS THE CLAIM" from inside its `withRunLock` callback and
      // parks there for 500 ms, and the HOST does not attempt its claim until
      // it has read that line. The refusal is then a genuine cross-process
      // link(2) contention — the host really attempts, the child really holds
      // — and the direction is deterministic: child wins, host refused.
      // (The host-wins direction is the serialized test above, where the
      // in-process side holds before the child is even spawned.) The XOR below
      // stays as a tripwire: a lock that let the host through mid-hold would
      // fail it here rather than downstream at the count assertions.
      const counting = countingRecording();
      const child = Bun.spawn(["bun", "-e", racerScript(runsDir, RUN_ID, repoDir, childLinkLog)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);

      // Read the child's stream incrementally for the barrier; the SAME reader
      // drains the rest after the race, so nothing is consumed twice.
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let childOut = "";
      let holds = false;
      const holdsDeadline = Date.now() + 10_000;
      // The deadline must bound the READ, not just the loop condition: a child
      // that hangs BEFORE its first byte would otherwise park `reader.read()`
      // forever and the while-condition would never get a turn to expire. The
      // timeout arm RESOLVES (never rejects) so a read that wins the race
      // cannot leave an unhandled rejection behind; the loop throws the named
      // diagnostic instead.
      while (!holds && Date.now() < holdsDeadline) {
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(Math.max(0, holdsDeadline - Date.now())).then(() => null),
        ]);
        if (chunk === null)
          throw new Error("child racer stdout read hung past the 10s barrier deadline — its cold start failed or hung");
        if (chunk.done) break;
        childOut += decoder.decode(chunk.value, { stream: true });
        holds = childOut.includes("RACER HOLDS THE CLAIM");
      }
      // A child that never printed the hold line never acquired the lock — a
      // broken cold start or an unexpected refusal, not a race this test can
      // measure. Attempting the host claim without it would race a lock nobody
      // holds: the vacuous green the barrier exists to prevent.
      if (!holds)
        throw new Error(
          `child racer never printed "RACER HOLDS THE CLAIM" — its cold start failed or its claim was refused: ${childOut.trim() || "(no stdout)"}`,
        );

      // The child holds for a bounded 500 ms (racerScript); the host attempts
      // immediately, so its claim lands mid-hold and is refused run-locked.
      let hostErr: unknown;
      const hostGo = (async () => {
        await withRunLock(runsDir, RUN_ID, "df2-11-race-host", (h) =>
          teardownSandbox(deps(counting.driver, repoDir), RUN_ID, h),
        );
      })().catch((e) => {
        hostErr = e;
      });

      let childStderr = "";
      let childExit = -1;
      try {
        await Promise.all([hostGo, child.exited]);
        childStderr = await new Response(child.stderr).text();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          childOut += decoder.decode(value, { stream: true });
        }
        childExit = await child.exited;
      } finally {
        try {
          child.kill(9);
        } catch {
          // already exited
        }
      }

      // The XOR is the marquee property: exactly one of the two concurrent
      // acquirers held the claim, so exactly one of them completed. Under the
      // hold barrier the direction is deterministic (child won, host refused),
      // but the assertion stays a two-sided tripwire: a lock that let the host
      // through mid-hold — or lost the child's claim entirely — fails HERE,
      // as both-won or both-lost, before the count assertions get a chance to
      // misattribute it.
      const hostWon = hostErr === undefined;
      const childWon = childExit === 0;
      expect(hostWon).not.toBe(childWon);

      // The loser got the run-locked refusal, with the machine-readable code
      // and the rm remediation naming the lock path — from whichever side lost.
      const lockPath = join(runsDir, `${RUN_ID}.lock`);
      if (hostWon) {
        // Unreachable while the hold barrier holds — reached only if the lock
        // regressed and let the host steal a live hold. Asserted anyway so a
        // regression exercises the same payload checks the serialized test
        // pins, from the two-process side.
        // The barrier line legitimately sits in the child's stdout (F8), so
        // "ran nothing" is asserted on the OUTCOME line, not on an empty
        // stream: what must be absent is any completed teardown.
        expect(childOut).not.toContain("RACER WON");
        expect(childStderr).toContain("code=run-locked");
        expect(childStderr).toContain("wait for that invocation to finish");
        expect(childStderr).toContain(lockPath);
        expect(counting.destroys()).toBe(1);
      } else {
        const refusal = hostErr as { code?: string; message?: string; remediation?: string };
        expect(refusal.code).toBe("run-locked");
        expect(refusal.message).toContain(lockPath);
        expect(refusal.remediation).toContain("wait for that invocation to finish");
        expect(childOut).toContain("RACER WON");
      }

      // Exactly one harvest, regardless of who won: 3 commits at the
      // quarantine ref, one bundle that verifies, the box down, the record
      // closed once, the lock file gone (the winner released; the loser never
      // held), and no stray bundle from a double teardown.
      const rev = spawnSync("git", ["rev-list", "--count", `${baseSha}..refs/sandbox/${RUN_ID}`], {
        cwd: repoDir,
        encoding: "utf8",
      });
      expect(rev.status).toBe(0);
      expect((rev.stdout ?? "").trim()).toBe("3");
      expect(readdirSync(runsDir).filter((n) => n === `${RUN_ID}.bundle`)).toEqual([`${RUN_ID}.bundle`]);
      const verify = spawnSync("git", ["bundle", "verify", join(runsDir, `${RUN_ID}.bundle`)], {
        cwd: repoDir,
        encoding: "utf8",
      });
      expect(verify.status).toBe(0);
      expect(store.get(RUN_ID).closedAt).toBeString();
      expect(existsSync(join(boxesRoot, vmName))).toBeFalse();
      expect(existsSync(lockPath)).toBeFalse();
      // harvest.summary is the in-process sink's line: exactly one when the
      // host won, none when the child did (its line went to child stdout).
      expect(logs.filter((l) => l.operation === "harvest.summary")).toHaveLength(hostWon ? 1 : 0);
      // DF5.3, over the UNION of both processes' emits. Whichever side won,
      // exactly ONE `run-box.teardown` row exists for this box: the loser is
      // refused at the lock before `teardownSandbox` runs, so it emits nothing,
      // and the winner's close runs once. This is the arrangement a duplicate
      // would come from — two processes on one lock — and the serialized test
      // above cannot show it, because there the in-process side always wins.
      const childLinks = readChildLinks();
      const allLinks = [...auditLinks, ...childLinks];
      // The winner's teardown emits the whole set once: harvest's two hop-6
      // rows plus the hop-5 close. Exactly one of each, over both processes.
      expect(allLinks.map((l) => `${l.hop}.${l.event}`).sort()).toEqual([
        "run-box.teardown",
        "run-bundle.bundle-fetch",
        "run-bundle.bundle-verify",
      ]);
      const teardownRow = allLinks.find((l) => `${l.hop}.${l.event}` === "run-box.teardown");
      expect(teardownRow?.runId).toBe(RUN_ID);
      expect(teardownRow?.subjectId).toBe(vmName);
      // …and every one of them came from the side that actually won: the loser
      // is refused at the lock claim, before `teardownSandbox` runs.
      expect(childLinks).toHaveLength(hostWon ? 0 : 3);

      console.log(
        `DF2.11 contention evidence: winner=${hostWon ? "host" : "child"} revCount=3 ` +
          `destroyCount=${counting.destroys()} bundleVerifyExit=${verify.status} childExit=${childExit}`,
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
