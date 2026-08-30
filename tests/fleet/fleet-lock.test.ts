/**
 * DF3.2 — fleet-lock unit tests: the reclaim-mutex steal judgments
 * (`stealJudgedReapMutex`). The stale-observation-vs-replacement interleaving
 * is pinned by calling the exported function directly with pre-planted bytes,
 * not by choreographing real processes.
 *
 * Moved out of fanout.test.ts (PR 128 review round 3): that file keeps the
 * fleet-lock behavior tests that go through FleetLock.acquire()/subprocesses;
 * this one owns the mutex-judgment matrix. The choreography fakes stay local
 * (ruling C3); the generic process-corpse helpers are shared via ./helpers.ts,
 * like the ledger fixtures, so a fix to how death is proven lands everywhere
 * at once.
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

import { deadPid, liveChild } from "./helpers.ts";
import { FleetLock, probeCount, readOwnPidStartTime, stealJudgedReapMutex } from "../../src/fleet/fleet-lock.ts";
import { isAlive } from "../../scripts/lib/run-lock.ts";
import type { FleetError } from "../../src/fleet/dispatch.ts";

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

describe("FleetLock construction refuses an unattributable body (round-6 follow-up)", () => {
  test("empty requestId throws a typed refusal and mints nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "df32-lock-emptyreq-"));
    const path = join(dir, "fleet.lock");
    expect(() => new FleetLock({ path, requestId: "" })).toThrow(
      /requestId must be a non-empty string/,
    );
    // No directory side effects either: validation happens before any fs op.
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dir)).toBe(true); // constructor never even mkdirs
    try {
      const thrown = (() => {
        try {
          new FleetLock({ path, requestId: "" });
        } catch (e) {
          return e;
        }
      })();
      expect((thrown as { code?: string }).code).toBe("fleet-lock-invalid-request");
      expect((thrown as { exitCode?: number }).exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round-7 S1 timestamp validation", () => {
  let lockPath: string;
  let children: Bun.Subprocess[];

  beforeEach(() => {
    lockPath = join(realpathSync(mkdtempSync(join(tmpdir(), "case-"))), "sandbox", "fleet.lock");
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

  test("r7-S1a: negative createdAt is unjudgeable — refuse, never reclaim", async () => {
    const pid = await deadPid();
    expect(isAlive(pid)).toBe(false);
    mkdirSync(dirname(lockPath), { recursive: true });
    const negativeTs = "1969-12-31T23:59:59.999Z"; // Date.parse returns -1 ms
    expect(Date.parse(negativeTs)).toBe(-1);
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid,
        pidStartTime: 1,
        createdAt: negativeTs,
        requestId: "req-negative-created",
      })}\n`,
      { mode: 0o600 },
    );
    let err: unknown;
    try {
      new FleetLock({ path: lockPath, requestId: "contender" }).acquire();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const fe = err as FleetError;
    expect(fe.exitCode).toBe(5);
    expect(fe.code).toBe("fleet-busy");
    expect(fe.message).toContain("malformed createdAt");
    expect(readFileSync(lockPath, "utf8")).toContain(negativeTs); // never stolen
  });

  test("r7-S1c: far-future createdAt is unjudgeable — refuse, never reclaim", async () => {
    const pid = await deadPid();
    expect(isAlive(pid)).toBe(false);
    mkdirSync(dirname(lockPath), { recursive: true });
    const futureTime = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour ahead
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid,
        pidStartTime: 1,
        createdAt: futureTime,
        requestId: "req-future-created",
      })}\n`,
      { mode: 0o600 },
    );
    let err: unknown;
    try {
      new FleetLock({ path: lockPath, requestId: "contender" }).acquire();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const fe = err as FleetError;
    expect(fe.exitCode).toBe(5);
    expect(fe.code).toBe("fleet-busy");
    expect(fe.message).toContain("malformed createdAt");
    expect(readFileSync(lockPath, "utf8")).toContain(futureTime); // never stolen
  });

  test("r7-S1b: negative pidStartTime is unjudgeable — refuse, never reclaim", async () => {
    const pid = await deadPid();
    expect(isAlive(pid)).toBe(false);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid,
        pidStartTime: -1, // negative start-time
        createdAt: new Date(Date.now() - 4_000_000).toISOString(),
        requestId: "req-negative-start",
      })}\n`,
      { mode: 0o600 },
    );
    let err: unknown;
    try {
      new FleetLock({ path: lockPath, requestId: "contender" }).acquire();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const fe = err as FleetError;
    expect(fe.exitCode).toBe(5);
    expect(fe.code).toBe("fleet-busy");
    expect(fe.message).toContain("cannot judge");
    expect(readFileSync(lockPath, "utf8")).toContain("pidStartTime\":-1"); // never stolen
  });
});

/**
 * F047 — the contended reclaim-mutex path used to run TWO blocking identity
 * probes per 10 ms tick for the whole 250 ms budget (~25 `execFileSync("ps",
 * …)` on darwin) plus one for our own body. The probes are now memoized: our
 * own identity process-wide (our start time is immutable and our pid cannot be
 * recycled while we run), a foreign holder's per `(pid, judged bytes)` for the
 * duration of ONE `acquireReapMutex` call.
 *
 * Counted through `probeCount` — the probes themselves, not the `ps` spawns —
 * so the guard runs on linux CI too, where the same probes read /proc and
 * spawn nothing.
 */
describe("F047: pid-identity probes are memoized within one acquireReapMutex call", () => {
  let lockPath: string;
  let children: Bun.Subprocess[];

  const body = (pid: number, requestId: string): string =>
    `${JSON.stringify({
      pid,
      pidStartTime: readOwnPidStartTime(pid),
      createdAt: new Date().toISOString(),
      requestId,
    })}\n`;

  /** Take the mutex under a LIVE holder that is never stealable, counting probes. */
  const contendedProbeCount = (): { probes: number; got: boolean } => {
    const lock = new FleetLock({ path: lockPath, requestId: "contender" });
    // acquire() always mints its own body — and so probes our own start time —
    // before it can reach acquireReapMutex, so the self probe is warm on every
    // real contended path. Warm it here too.
    readOwnPidStartTime();
    probeCount.n = 0;
    const got = (lock as unknown as { acquireReapMutex(): boolean }).acquireReapMutex();
    return { probes: probeCount.n, got };
  };

  beforeEach(() => {
    lockPath = join(realpathSync(mkdtempSync(join(tmpRoot, "f047-"))), "sandbox", "fleet.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
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

  test("a fully contended acquireReapMutex probes at most twice", () => {
    // A genuinely LIVE mutex holder whose identity matches: never stolen, so
    // acquireReapMutex ticks out its whole budget — the worst case.
    const holder = liveChild();
    children.push(holder);
    const bytes = body(holder.pid, "live-reclaimer");
    writeFileSync(`${lockPath}.reap`, bytes, { mode: 0o600 });
    const { probes, got } = contendedProbeCount();
    expect(got).toBe(false); // a live holder is waited out, never robbed
    expect(probes).toBeLessThanOrEqual(2);
    expect(readFileSync(`${lockPath}.reap`, "utf8")).toBe(bytes); // untouched
  });

  test("r1 CRITICAL: bytes REWRITTEN mid-call are judged on a FRESH probe, never the memo", async () => {
    // The memo is keyed on (pid, judged bytes), not on the pid alone. A pid
    // can be recycled inside the 250 ms budget and the replacement can claim
    // the mutex with its own recorded start time; a pid-only memo would judge
    // those fresh bytes against the DEAD predecessor's observation, read the
    // mismatch as "recycled pid" and steal a LIVE holder's mutex.
    //
    // Pid recycling cannot be forced, so the guard is the mechanism that makes
    // that window safe: rewrite the bytes mid-call and assert the probes were
    // re-taken. Both bodies carry the holder's TRUE start time and differ only
    // in requestId, so a correct judgment refuses both — a memo hit would show
    // up as the probe count staying at 2.
    const holder = liveChild();
    children.push(holder);
    const reap = `${lockPath}.reap`;
    writeFileSync(reap, body(holder.pid, "first-reclaimer"), { mode: 0o600 });
    const replacement = body(holder.pid, "second-reclaimer");
    // Only another process can rewrite the path mid-call: acquireReapMutex
    // blocks this thread end to end. Rename, so no tick can read a half-write.
    children.push(
      Bun.spawn(["sh", "-c", `sleep 0.05; printf %s "$1" > "$2.tmp"; mv "$2.tmp" "$2"`, "sh", replacement, reap]),
    );
    const { probes, got } = contendedProbeCount();
    expect(got).toBe(false); // still a live holder, under either body
    expect(probes).toBeGreaterThan(2); // the second body was re-probed, not memo-judged
    expect(readFileSync(reap, "utf8")).toBe(replacement); // and never stolen
  });
});
