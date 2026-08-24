/**
 * DF3.2 — fleet-lock unit tests: the reclaim-mutex steal judgments
 * (`stealJudgedReapMutex`). The stale-observation-vs-replacement interleaving
 * is pinned by calling the exported function directly with pre-planted bytes,
 * not by choreographing real processes.
 *
 * Moved out of fanout.test.ts (PR 128 review round 3): that file keeps the
 * fleet-lock behavior tests that go through FleetLock.acquire()/subprocesses;
 * this one owns the mutex-judgment matrix. Helpers stay LOCAL to their file
 * (orchestrator ruling C3) — no shared test module.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readOwnPidStartTime, stealJudgedReapMutex } from "../../src/fleet/fleet-lock.ts";

/** Spawn a short-lived child and resolve once its pid is provably dead. */
async function deadPid(): Promise<number> { /* dp:ok proc.exited resolves with the exit code, never rejects */
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

/** A live child the test kills on teardown — for identity-match rows. */
function liveChild(): Bun.Subprocess {
  return Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "df3-2-fleet-lock-")));

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("stealJudgedReapMutex (reclaim-mutex steal judgments)", () => {
  let lockPath: string;
  /** Children spawned by the running test — killed in afterEach. */
  let children: Bun.Subprocess[];

  beforeEach(() => {
    lockPath = join(realpathSync(mkdtempSync(join(tmpRoot, "case-"))), "sandbox", "fleet.lock");
    children = [];
  });

  afterEach(() => {
    for (const c of children) {
      try {
        c.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    children = [];
    rmSync(dirname(lockPath), { recursive: true, force: true });
  });

  test("a STALE observation never removes a mutex that was REPLACED after it (two-reclaimer race)", async () => {
    // The reported interleaving, pinned deterministically: reclaimer B reads
    // a dead holder's mutex body and pauses; reclaimer A clears the path and
    // contender C claims fresh bytes; B resumes holding a pending unlink.
    // The conditional removal must refuse — only the EXACT judged bytes are
    // ever deleted, so C's live mutex (and its verify+rm serialization)
    // survives B's stale judgment.
    mkdirSync(dirname(lockPath), { recursive: true });
    const reap = `${lockPath}.reap`;
    const corpsePid = await deadPid();
    const judgedBytes = `${JSON.stringify({
      pid: corpsePid,
      pidStartTime: 1,
      createdAt: new Date().toISOString(),
      requestId: "corpse-reclaimer",
    })}\n`;
    writeFileSync(reap, judgedBytes, { mode: 0o600 });
    // While our observation is in flight: another reclaimer cleared the
    // corpse and a third contender claimed fresh LIVE bytes at the path.
    const fresh = liveChild();
    children.push(fresh);
    const freshBytes = `${JSON.stringify({
      pid: fresh.pid,
      pidStartTime: readOwnPidStartTime(fresh.pid),
      createdAt: new Date().toISOString(),
      requestId: "fresh-reclaimer",
    })}\n`;
    writeFileSync(reap, freshBytes, { mode: 0o600 });
    expect(stealJudgedReapMutex(reap, judgedBytes)).toBe(false); // stale ⇒ refuse
    expect(readFileSync(reap, "utf8")).toBe(freshBytes); // the live mutex survived
    // Control: when the path still holds the judged bytes, the steal lands.
    writeFileSync(reap, judgedBytes, { mode: 0o600 });
    expect(stealJudgedReapMutex(reap, judgedBytes)).toBe(true); // unchanged ⇒ removed
    expect(existsSync(reap)).toBe(false);
  });

  test("a genuinely LIVE reap-mutex holder is NEVER stolen on mtime alone (identity match)", async () => {
    // A SIGSTOPped or descheduled holder can sit inside its microsecond
    // section far longer than any mtime bound. Age must not judge a body
    // whose holder identity still matches — only death or recycling may.
    mkdirSync(dirname(lockPath), { recursive: true });
    const reap = `${lockPath}.reap`;
    const holder = liveChild();
    children.push(holder);
    const bytes = `${JSON.stringify({
      pid: holder.pid,
      pidStartTime: readOwnPidStartTime(holder.pid),
      createdAt: new Date().toISOString(),
      requestId: "foreign-reclaimer",
    })}\n`;
    writeFileSync(reap, bytes, { mode: 0o600 });
    // Backdate the mtime past REAP_MUTEX_ABANDON_MS: the pre-identity code
    // would have robbed this holder outright.
    utimesSync(reap, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(stealJudgedReapMutex(reap, bytes)).toBe(false);
    expect(readFileSync(reap, "utf8")).toBe(bytes);
  });

  test("a recycled-pid reap-mutex holder is stolen AT ONCE (identity mismatch beats any age)", async () => {
    // Alive pid, but wearing a stranger's start time: the RECORDED owner is
    // provably a corpse. The recycle proof clears it without waiting out any
    // mtime bound — fresh mtime on purpose, so only the identity path can
    // have removed it.
    mkdirSync(dirname(lockPath), { recursive: true });
    const reap = `${lockPath}.reap`;
    const impostor = liveChild();
    children.push(impostor);
    const bytes = `${JSON.stringify({
      pid: impostor.pid,
      pidStartTime: readOwnPidStartTime(impostor.pid) + 98_765, // the recycled half
      createdAt: new Date().toISOString(),
      requestId: "corpse-reclaimer",
    })}\n`;
    writeFileSync(reap, bytes, { mode: 0o600 });
    expect(stealJudgedReapMutex(reap, bytes)).toBe(true);
    expect(existsSync(reap)).toBe(false);
  });
});
