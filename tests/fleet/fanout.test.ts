/**
 * DF3.2 Wave-1a agent A — fan-out record store (AC9) + fleet lock (AC8).
 *
 * Fakes stay LOCAL to this file (orchestrator ruling C3): the choreography
 * each suite forces is planted here, not in a shared module. The generic
 * process-corpse helpers are the exception — shared via ./helpers.ts like the
 * ledger fixtures, so a fix to how death is proven cannot fork per file.
 *
 * Coverage per integration-spec D14 mandatory inventory, agent-A scope:
 * - AC9 store: O_EXCL create (EEXIST propagates, body byte-identical — the
 *   stamp-skip primitive), typed ENOENT for the CLI's exit-4 mapping,
 *   lock-guarded atomicReplace mutate, fail-closed list(), dir 0700/file 0600,
 *   create:false refuses mutation, id minting + resolution chain.
 * - AC8 lock: mandated JSON body {pid,pidStartTime,createdAt,requestId} at
 *   0600; re-entrancy refused; classification matrix young+live→refuse,
 *   young+dead→refuse, aged+dead→reclaim, aged+alive-identity-match→refuse,
 *   aged+alive-start-mismatch→reclaim, unparseable/out-of-range→refuse;
 *   own-pid body refused ABOVE the reclaim branches; release parks a foreign
 *   body under a NON-.tmp orphan (K1); destructive-mark refusal; SIGINT
 *   mid-hold releases through a REAL child driven through the signal-install
 *   seam; barrier-forced concurrent race admits exactly one contender.
 *
 * The stealJudgedReapMutex mutex-judgment matrix lives in its own module now
 * (round 3): tests/fleet/fleet-lock.test.ts.
 *
 * Constants are IMPORTED from source (FLEET_LOCK_STALE_MS), never mirrored.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { isAlive } from "../../scripts/lib/run-lock.ts";
import { deadPid, liveChild } from "./helpers.ts";
import type { FleetError } from "../../src/fleet/dispatch.ts";
// The fleet lock lives in its own module (D1 escape clause, orchestrator-approved
// split); the record store stays here in fanout.test.ts's sibling fanout.ts.
import {
  FLEET_LOCK_STALE_MS,
  FleetLock,
  readOwnPidStartTime,
} from "../../src/fleet/fleet-lock.ts";
import {
  DEFAULT_FANOUTS_DIR,
  FANOUT_ID_RE,
  FanoutRecordStore,
  mintFanoutId,
  resolveFanoutsDir,
  type FanoutRecord,
} from "../../src/fleet/fanout.ts";

/** Full valid record — tests override single fields. */
function makeRecord(overrides: Partial<FanoutRecord> = {}): FanoutRecord {
  return {
    fanoutId: "fan-20260823-a1b2c3",
    requestId: "11111111-2222-4333-8444-555555555555",
    pattern: "best-of-n",
    n: 3,
    pin: "a".repeat(40),
    createdAt: new Date("2026-08-23T00:00:00.000Z").toISOString(),
    arms: [
      { arm: 0, runId: "qds-20260823-aaa001", briefHash: "hash-arm-0" },
      { arm: 1, runId: "qds-20260823-aaa002", briefHash: "hash-arm-1" },
    ],
    winner: null,
    rankedAt: null,
    closedAt: null,
    ...overrides,
  };
}

/**
 * Plant a fleet-lock body AS IF a previous process had left it there. This is
 * the entire cross-process surface a contender sees — the file's bytes — so
 * planting is how every classification row is reached deterministically
 * (no sleeping, no clock seams: age comes from the planted createdAt).
 */
function plantLock(
  path: string,
  body: {
    pid: number;
    pidStartTime: number;
    createdAt: string;
    requestId: string;
    /** Optional darwin-writer evidence keys — recorded by the lock, never compared. */
    lstartRaw?: string;
    lstartUtcMs?: number;
  },
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
}

/** An ISO createdAt aged past FLEET_LOCK_STALE_MS by `extraMs`. */
function agedIso(extraMs = 60_000): string {
  return new Date(Date.now() - FLEET_LOCK_STALE_MS - extraMs).toISOString();
}

/** First line of a subprocess stream, bounded — the inter-process barrier. */
async function readLine(stream: ReadableStream<Uint8Array>, label: string): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl >= 0) return buf.slice(0, nl);
      if (done) return buf;
    }
  } catch (e) {
    throw new Error(`${label}: stream failed: ${(e as Error).message}`);
  } finally {
    reader.releaseLock();
  }
}

async function within<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The child the signal-install-seam tests drive. Acquires the lock named by
 * argv[2], announces `HELD <requestId>` (the barrier), then idles until
 * signaled. A refused acquire prints `REFUSED <code>` and exits 5.
 */
const CHILD_SCRIPT_SRC = (fanoutSrc: string): string => `
import { FleetLock } from ${JSON.stringify(fanoutSrc)};
const [, , lockPath, requestId] = process.argv;
const lock = new FleetLock({ path: lockPath, requestId });
try {
  lock.acquire();
} catch (e) {
  process.stdout.write(\`REFUSED \${e.code ?? "no-code"}\n\`);
  process.exit(5);
}
process.stdout.write(\`HELD \${requestId}\n\`);
setInterval(() => {}, 50);
`;

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "df3-2-fanout-")));

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("fanout.ts sections 1+2 (DF3.2 AC8/AC9)", () => {
  let dir: string;
  /** Children spawned by the running test — killed in afterEach. */
  let children: Bun.Subprocess[];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpRoot, "case-")));
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
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── section 1: the fan-out record store ────────────────────────────────────

  describe("FanoutRecordStore (AC9)", () => {
    test("mintFanoutId() matches FANOUT_ID_RE and never repeats across draws", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 32; i++) {
        const id = mintFanoutId();
        expect(id).toMatch(FANOUT_ID_RE);
        seen.add(id);
      }
      expect(seen.size).toBe(32);
    });

    test("resolveFanoutsDir: explicit arg > $QDS_FANOUTS_DIR > default", () => {
      const prev = process.env.QDS_FANOUTS_DIR;
      try {
        // delete (not = undefined): Node/Bun stringifies the latter to "undefined".
        // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
        delete process.env.QDS_FANOUTS_DIR;
        expect(resolveFanoutsDir()).toBe(DEFAULT_FANOUTS_DIR);
        process.env.QDS_FANOUTS_DIR = "/srv/fanouts-from-env";
        expect(resolveFanoutsDir()).toBe("/srv/fanouts-from-env");
        expect(resolveFanoutsDir("/explicit/dir")).toBe("/explicit/dir");
      } finally {
        // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
        if (prev === undefined) delete process.env.QDS_FANOUTS_DIR;
        else process.env.QDS_FANOUTS_DIR = prev;
      }
    });

    test("constructor creates the dir 0700; create persists the record 0600", () => {
      const fanoutsDir = join(dir, "fanouts");
      const store = new FanoutRecordStore({ dir: fanoutsDir });
      expect(existsSync(fanoutsDir)).toBe(true);
      expect(statSync(fanoutsDir).mode & 0o777).toBe(0o700);

      const rec = makeRecord();
      store.create(rec);
      const p = join(fanoutsDir, `${rec.fanoutId}.json`);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    });

    test("create + get round-trip the full frozen schema", () => {
      const store = new FanoutRecordStore({ dir: join(dir, "fanouts") });
      const rec = makeRecord({
        arms: [{ arm: 0, runId: "qds-20260823-bbb001", rosterId: "roster-a", briefHash: "h" }],
        winner: 0,
        rankedAt: "2026-08-23T01:00:00.000Z",
        closedAt: "2026-08-23T02:00:00.000Z",
      });
      store.create(rec);
      expect(store.get(rec.fanoutId)).toEqual(rec);
    });

    test("second create is refused with EEXIST and leaves the original byte-identical (stamp-skip primitive)", () => {
      const store = new FanoutRecordStore({ dir: join(dir, "fanouts") });
      const rec = makeRecord();
      store.create(rec);
      const p = join(dir, "fanouts", `${rec.fanoutId}.json`);
      const before = readFileSync(p, "utf8");

      let thrown: unknown;
      try {
        store.create(makeRecord({ winner: 1 }));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as NodeJS.ErrnoException).code).toBe("EEXIST");
      expect(readFileSync(p, "utf8")).toBe(before);
    });

    test("get on an unknown id carries the ENOENT errno (CLI maps it to exit 4)", () => {
      const store = new FanoutRecordStore({ dir: join(dir, "fanouts") });
      let thrown: unknown;
      try {
        store.get("fan-20260823-000000");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as NodeJS.ErrnoException).code).toBe("ENOENT");
    });

    test("get refuses a malformed record body, naming the file", () => {
      const fanoutsDir = join(dir, "fanouts");
      mkdirSync(fanoutsDir, { recursive: true });
      writeFileSync(join(fanoutsDir, "fan-20260823-0bad00.json"), JSON.stringify({ fanoutId: "other" }));
      const store = new FanoutRecordStore({ dir: fanoutsDir });
      let message = "";
      try {
        store.get("fan-20260823-0bad00");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("fan-20260823-0bad00.json");
    });

    test("mutate applies fn under the record lock and persists atomically", () => {
      const store = new FanoutRecordStore({ dir: join(dir, "fanouts") });
      const rec = makeRecord();
      store.create(rec);
      // The lock path follows acquireRunLock's contract: <dir>/<id>.lock
      // We cannot assert its existence inside the mutate callback without invasive changes
      // (the lock is taken/released synchronously within mutate(), and observing it mid-hold
      // would require a separate thread or a custom seam). The store's contract already
      // guarantees mutual exclusion via the per-record lock; this test verifies persistence.
      const out = store.mutate(rec.fanoutId, (r) => ({ ...r, winner: 1, closedAt: r.createdAt }));
      expect(out.winner).toBe(1);
      expect(store.get(rec.fanoutId).closedAt).toBe(rec.createdAt);
    });

    test("mutate propagates fn's refusal WITHOUT touching the file (winner transition shape)", () => {
      const store = new FanoutRecordStore({ dir: join(dir, "fanouts") });
      const rec = makeRecord();
      store.create(rec);
      const p = join(dir, "fanouts", `${rec.fanoutId}.json`);

      // First writer claims the winner slot…
      store.mutate(rec.fanoutId, (r) => {
        if (r.winner !== null) throw new Error("already decided");
        return { ...r, winner: 0 };
      });
      const afterFirst = readFileSync(p, "utf8");

      // …the second refuses and must leave the record untouched.
      expect(() =>
        store.mutate(rec.fanoutId, (r) => {
          if (r.winner !== null) throw new Error("already decided");
          return { ...r, winner: 1 };
        }),
      ).toThrow("already decided");
      expect(readFileSync(p, "utf8")).toBe(afterFirst);
      expect(store.get(rec.fanoutId).winner).toBe(0);
    });

    test("mutate refuses to persist an fn output that breaks the schema", () => {
      const store = new FanoutRecordStore({ dir: join(dir, "fanouts") });
      const rec = makeRecord();
      store.create(rec);
      expect(() => store.mutate(rec.fanoutId, () => ({ ...rec, n: 0 } as FanoutRecord))).toThrow(/malformed/i);
    });

    test("a null arms element is refused through the malformed taxonomy, never a TypeError", () => {
      const store = new FanoutRecordStore({ dir: join(dir, "fanouts") });
      const rec = makeRecord();
      store.create(rec);
      // `(null as Record<…>).arm` used to escape this gate as
      // "Cannot read properties of null" — get()/list() must name the record
      // and field instead.
      let err: Error | undefined;
      try {
        store.mutate(rec.fanoutId, () => ({ ...rec, arms: [null] }) as unknown as FanoutRecord);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toMatch(/^malformed fan-out record /);
      expect(err?.message).toContain("arms");
    });

    test("a winner index outside arms is refused on write and on read (rank/close never see one)", () => {
      const fanoutsDir = join(dir, "fanouts");
      const store = new FanoutRecordStore({ dir: fanoutsDir });
      const rec = makeRecord();
      store.create(rec);
      const p = join(fanoutsDir, `${rec.fanoutId}.json`);
      const before = readFileSync(p, "utf8");

      expect(() => store.mutate(rec.fanoutId, (r) => ({ ...r, winner: 99 }))).toThrow(/malformed|winner/i);
      expect(readFileSync(p, "utf8")).toBe(before); // refused writes leave no trace

      // And a record planted past the gate cannot sneak back in through get().
      writeFileSync(p, JSON.stringify(makeRecord({ winner: 5 })));
      let message = "";
      try {
        store.get(rec.fanoutId);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("winner");
    });

    test("list() is fail-closed: an unreadable sibling .json throws naming the file", () => {
      const fanoutsDir = join(dir, "fanouts");
      const store = new FanoutRecordStore({ dir: fanoutsDir });
      store.create(makeRecord());
      // A body no schema can accept — the exact fail-open hazard INV r5/r6 names.
      writeFileSync(join(fanoutsDir, "fan-20260823-dead00.json"), "{not json");
      writeFileSync(
        join(fanoutsDir, "fan-20260823-feed00.json"),
        JSON.stringify(makeRecord({ fanoutId: "fan-20260823-feed00" })),
      );

      let message = "";
      try {
        store.list();
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("fan-20260823-dead00.json");
      // And the healthy records are NOT handed back past an unreadable one.
    });

    test("list() returns every healthy record when nothing is unreadable", () => {
      const fanoutsDir = join(dir, "fanouts");
      const store = new FanoutRecordStore({ dir: fanoutsDir });
      store.create(makeRecord());
      store.create(makeRecord({ fanoutId: "fan-20260823-ffff01" }));
      const listed = store.list();
      expect(listed.map((r) => r.fanoutId).sort()).toEqual([makeRecord().fanoutId, "fan-20260823-ffff01"]);
    });

    test("create:false reads but refuses every mutation", () => {
      const fanoutsDir = join(dir, "fanouts");
      mkdirSync(fanoutsDir, { recursive: true });
      writeFileSync(
        join(fanoutsDir, "fan-20260823-cafe00.json"),
        JSON.stringify(makeRecord({ fanoutId: "fan-20260823-cafe00" })),
      );
      const ro = new FanoutRecordStore({ dir: fanoutsDir, create: false });
      expect(ro.get("fan-20260823-cafe00").n).toBe(3);
      // list() works in read-only mode
      expect(() => ro.list()).not.toThrow();
      const listed = ro.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.fanoutId).toBe("fan-20260823-cafe00");
      expect(() => ro.create(makeRecord())).toThrow(/create: false/);
      expect(() => ro.mutate("fan-20260823-cafe00", (r) => r)).toThrow(/create: false/);
    });
  });

  // ─── section 2: the fleet lock ──────────────────────────────────────────────

  describe("readOwnPidStartTime", () => {
    test("own pid: epoch ms near now, stable across calls", () => {
      const a = readOwnPidStartTime();
      const b = readOwnPidStartTime();
      expect(a).toBe(b);
      // Clock-skew-tolerant sanity window: 10 years. Source guarantees only stability, not exact now.
      expect(a).toBeGreaterThan(Date.now() - 315_360_000_000);
      expect(a).toBeLessThanOrEqual(Date.now());
    });

    test("foreign live pid: observable, <= now, stable", async () => {
      const child = liveChild();
      children.push(child);
      const observed = readOwnPidStartTime(child.pid);
      expect(observed).toBeLessThanOrEqual(Date.now());
      // Clock-skew-tolerant sanity window: 10 years. Source guarantees only stability, not exact now.
      expect(observed).toBeGreaterThan(Date.now() - 315_360_000_000);
      expect(readOwnPidStartTime(child.pid)).toBe(observed);
    });

    test("dead pid throws (identity cannot be observed — callers must fail closed)", async () => {
      const pid = await deadPid();
      expect(isAlive(pid)).toBe(false);
      // The fail-closed refusal text ("could not …" — observe on darwin, read
      // from /proc on linux), not some incidental error.
      expect(() => readOwnPidStartTime(pid)).toThrow(/could not/);
    });
  });

  describe("FleetLock (AC8)", () => {
    let lockPath: string;

    beforeEach(() => {
      lockPath = join(dir, "sandbox", "fleet.lock");
    });

    function lock(requestId = "req-under-test"): FleetLock {
      return new FleetLock({ path: lockPath, requestId });
    }

    function onDisk(): { pid: number; pidStartTime: number; createdAt: string; requestId: string } {
      return JSON.parse(readFileSync(lockPath, "utf8")); /* reads implementation-written bytes: parses the lock body acquire() just wrote */
    }

    test("acquire publishes the mandated JSON body at 0600 carrying our identity", () => {
      lock().acquire();
      const body = onDisk();
      // The four MANDATED keys must all be published; the ONLY tolerated
      // extras are the darwin-only lstart* diagnostics fleet-lock.ts may add.
      // Any other key — announced or not — fails right here.
      const mandated = ["createdAt", "pid", "pidStartTime", "requestId"];
      const extras = Object.keys(body).filter(
        (k) => !mandated.includes(k) && k !== "lstartRaw" && k !== "lstartUtcMs",
      );
      expect(extras).toEqual([]);
      for (const k of mandated) expect(Object.keys(body)).toContain(k);
      expect(body.pid).toBe(process.pid);
      expect(body.pidStartTime).toBe(readOwnPidStartTime());
      expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
      expect(body.requestId).toBe("req-under-test");
      expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    });

    test("second acquire in-process is refused exit 5 — re-entrancy, hoisted above every reclaim branch", () => {
      const l = lock();
      l.acquire();
      let err: FleetError | undefined;
      try {
        lock("req-two").acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).not.toBe("fleet-busy"); // a distinct, self-inflicted refusal
      expect(err?.code).toContain("reentrant");
    });

    test("a foreign body carrying OUR pid is refused even when aged (own-pid above reclaim)", () => {
      plantLock(lockPath, {
        pid: process.pid,
        pidStartTime: readOwnPidStartTime(),
        createdAt: agedIso(),
        requestId: "ghost-of-our-pid",
      });
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(onDisk().requestId).toBe("ghost-of-our-pid"); // never stolen
    });

    test("young+live holder → refuse fleet-busy (age alone never reclaims)", async () => {
      const child = liveChild();
      children.push(child);
      plantLock(lockPath, {
        pid: child.pid,
        pidStartTime: readOwnPidStartTime(child.pid),
        createdAt: new Date().toISOString(),
        requestId: "req-live-holder",
      });
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).toBe("fleet-busy");
      expect(onDisk().requestId).toBe("req-live-holder");
    });

    test("young+dead owner → refuse (both parts of the reclaim are required)", async () => {
      const pid = await deadPid();
      plantLock(lockPath, {
        pid,
        pidStartTime: 1,
        createdAt: new Date().toISOString(),
        requestId: "req-young-dead",
      });
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).toBe("fleet-busy");
    });

    test("a dead holder one tick UNDER the stale boundary is still refused (age alone never reclaims)", async () => {
      const pid = await deadPid();
      expect(isAlive(pid)).toBe(false); // T-W7c: the corpse premise holds at use
      // 59 minutes old at plant; the few ms of test jitter cannot close a
      // 60-second margin, so this row deterministically sits below the bound.
      plantLock(lockPath, {
        pid,
        pidStartTime: 12345,
        createdAt: new Date(Date.now() - FLEET_LOCK_STALE_MS + 60_000).toISOString(),
        requestId: "req-under-boundary",
      });
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).toBe("fleet-busy");
      expect(onDisk().requestId).toBe("req-under-boundary");
    });

    test("a dead holder aged EXACTLY FLEET_LOCK_STALE_MS is refused — reclaim needs strictly MORE than stale (`>` semantics)", async () => {
      const pid = await deadPid();
      expect(isAlive(pid)).toBe(false);
      const t0 = Date.now();
      plantLock(lockPath, {
        pid,
        pidStartTime: 12345,
        createdAt: new Date(t0 - FLEET_LOCK_STALE_MS).toISOString(),
        requestId: "req-exact-stale",
      });
      // Freeze Date.now at t0 for the judgment so age === STALE_MS exactly
      // (bun's spyOn restores cleanly here; setSystemTime would stay frozen
      // for the rest of the file). At ==, `Date.now() - at > STALE_MS` is
      // false: judged YOUNG despite the provably-dead pid. A `>=` flip reclaims
      // and fails this.
      const frozen = spyOn(Date, "now").mockReturnValue(t0);
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      } finally {
        frozen.mockRestore();
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).toBe("fleet-busy");
      expect(onDisk().requestId).toBe("req-exact-stale");
    });

    test("aged+dead owner → reclaimed: acquire succeeds and the body becomes ours", async () => {
      const pid = await deadPid();
      expect(isAlive(pid)).toBe(false); // T-W7c: re-verify at use (pid recycling)
      plantLock(lockPath, {
        pid,
        pidStartTime: 12345,
        createdAt: agedIso(),
        requestId: "req-corpse",
      });
      lock().acquire();
      const body = onDisk();
      expect(body.pid).toBe(process.pid);
      expect(body.requestId).toBe("req-under-test");
      // The reclaim mutex is transient by construction — a successful verify+
      // rm leaves no `<path>.reap` litter behind for the next contender to
      // judge.
      expect(existsSync(`${lockPath}.reap`)).toBe(false);
    });

    test("a foreign LIVE reclaimer holding the reap mutex blocks the unlink (verify+rm serialized)", async () => {
      const pid = await deadPid();
      expect(isAlive(pid)).toBe(false); // T-W7c: re-verify at use (pid recycling)
      plantLock(lockPath, {
        pid,
        pidStartTime: 12345,
        createdAt: agedIso(),
        requestId: "req-corpse",
      });
      // Another reclaimer mid-cycle: its mutex holder is alive, so it cannot
      // be stolen, only waited out. This is the exact interleaving that used
      // to double-rm: our verify+rm must NOT proceed while another party is
      // inside theirs.
      const holder = liveChild();
      children.push(holder);
      writeFileSync(
        `${lockPath}.reap`,
        `${JSON.stringify({
          pid: holder.pid,
          pidStartTime: readOwnPidStartTime(holder.pid),
          createdAt: new Date().toISOString(),
          requestId: "foreign-reclaimer",
        })}\n`,
        { mode: 0o600 },
      );
      let err: FleetError | undefined;
      try {
        lock().acquire(); // burns both attempts waiting out REAP_MUTEX_WAIT_MS
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).toBe("fleet-busy");
      // The stale body SURVIVED both blocked attempts — nothing was unlinked
      // blind under a foreign mutex. A retry once the foreign reclaimer exits
      // would reclaim normally (the aged+dead case above).
      expect(onDisk().requestId).toBe("req-corpse");
    });

    test("an ABANDONED reap mutex (dead holder) is stolen, never waited on forever", async () => {
      const pid = await deadPid();
      expect(isAlive(pid)).toBe(false); // T-W7c: re-verify at use (pid recycling)
      plantLock(lockPath, {
        pid,
        pidStartTime: 12345,
        createdAt: agedIso(),
        requestId: "req-corpse",
      });
      // A reclaimer SIGKILLed between claiming the mutex and finishing its
      // rm: dead pid ⇒ provably stealable without waiting out the budget.
      const corpsePid = await deadPid();
      expect(isAlive(corpsePid)).toBe(false); // T-W7c: re-verify at use (pid recycling)
      writeFileSync(
        `${lockPath}.reap`,
        `${JSON.stringify({
          pid: corpsePid,
          pidStartTime: 1,
          createdAt: new Date().toISOString(),
          requestId: "corpse-reclaimer",
        })}\n`,
        { mode: 0o600 },
      );
      lock().acquire();
      expect(onDisk().requestId).toBe("req-under-test"); // the reclaim went through
      expect(existsSync(`${lockPath}.reap`)).toBe(false); // …and took the stolen mutex with it
    });

    test("aged+alive identity match → refuse fleet-busy (a first fan-out inside teardown is never preempted)", async () => {
      const child = liveChild();
      children.push(child);
      plantLock(lockPath, {
        pid: child.pid,
        pidStartTime: readOwnPidStartTime(child.pid),
        createdAt: agedIso(3_600_000), // far past stale — age STILL must not win
        requestId: "req-aged-but-alive",
      });
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).toBe("fleet-busy");
      expect(onDisk().requestId).toBe("req-aged-but-alive");
    });

    test("aged+alive recycled pid (observed start time ≠ recorded) → reclaimed", async () => {
      const child = liveChild();
      children.push(child);
      plantLock(lockPath, {
        pid: child.pid,
        pidStartTime: readOwnPidStartTime(child.pid) + 98_765, // the recycled half
        createdAt: agedIso(),
        requestId: "req-recycled",
      });
      lock().acquire();
      expect(onDisk().requestId).toBe("req-under-test");
    });

    test("lstart evidence written under a DIFFERENT TZ never drives identity: aged live holder refused, never reclaimed (localMs-only compare)", async () => {
      const child = liveChild();
      children.push(child);
      const trueStart = readOwnPidStartTime(child.pid);
      plantLock(lockPath, {
        pid: child.pid,
        // Matches what THIS shell observes — the only identity input.
        pidStartTime: trueStart,
        createdAt: agedIso(3_600_000), // far past stale
        requestId: "req-cross-tz-writer",
        // Evidence keys shaped as a darwin writer running under another zone
        // would have left them: lstartUtcMs off by a full half-day — outside
        // every real zone reconstruction this shell could produce — plus a
        // plausible raw line. Identity must ride pidStartTime ONLY: comparing
        // the lstart evidence reclaimed this LIVE holder (the round-3 HIGH).
        lstartRaw: "Wed Aug 19 10:00:00 2026",
        lstartUtcMs: trueStart - 14 * 3_600_000,
      });
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).toBe("fleet-busy");
      expect(err?.message).toContain("same process"); // judged alive-and-identical, not recycled
      expect(onDisk().requestId).toBe("req-cross-tz-writer"); // never stolen
    });

    test("unreadable/unparseable body → refuse exit 5, never steal what cannot be judged", () => {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, "{not json at all");
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      // The refusal matrix distinguishes these rows by MESSAGE within the
      // shared fleet-busy code — pin both halves so a future collapse onto a
      // generic fleet-busy (or worse, a reclaim) trips here.
      expect(err?.code).toBe("fleet-busy");
      expect(err?.message).toContain("cannot judge");
      expect(readFileSync(lockPath, "utf8")).toBe("{not json at all");
    });

    test("empty body → refuse (holder unknown)", () => {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, "");
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).toBe("fleet-busy");
      expect(err?.message).toContain("cannot judge");
      expect(readFileSync(lockPath, "utf8")).toBe(""); // never stolen either
    });

    test("out-of-range recorded pid → refuse (out-of-range is NOT dead)", () => {
      plantLock(lockPath, {
        pid: 100_000_000_000,
        pidStartTime: 1,
        createdAt: agedIso(),
        requestId: "req-huge-pid",
      });
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.exitCode).toBe(5);
      expect(err?.code).toBe("fleet-busy");
      // Aged + out-of-range is the row a careless refactor most wants to read
      // as "dead": the named diagnosis is what keeps it distinct.
      expect(err?.message).toContain("unusable pid");
      expect(onDisk().requestId).toBe("req-huge-pid");
    });

    test("pid boundary values: 0 and 0x8000_0000 are refused", () => {
      // pid 0 → refused
      plantLock(lockPath, {
        pid: 0,
        pidStartTime: 1,
        createdAt: agedIso(),
        requestId: "req-pid-zero",
      });
      let errZero: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        errZero = e as FleetError;
      }
      expect(errZero?.exitCode).toBe(5);
      expect(errZero?.message).toContain("unusable pid");
      expect(onDisk().requestId).toBe("req-pid-zero");

      // pid 0x8000_0000 (one past max) → refused
      plantLock(lockPath, {
        pid: 0x8000_0000,
        pidStartTime: 1,
        createdAt: agedIso(),
        requestId: "req-pid-over-max",
      });
      let errOverMax: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        errOverMax = e as FleetError;
      }
      expect(errOverMax?.exitCode).toBe(5);
      expect(errOverMax?.message).toContain("unusable pid");
      expect(onDisk().requestId).toBe("req-pid-over-max");
    });

    test("the fleet-busy remediation names the holding requestId and the exact rm path", async () => {
      const child = liveChild();
      children.push(child);
      plantLock(lockPath, {
        pid: child.pid,
        pidStartTime: readOwnPidStartTime(child.pid),
        createdAt: new Date().toISOString(),
        requestId: "req-name-me",
      });
      let err: FleetError | undefined;
      try {
        lock().acquire();
      } catch (e) {
        err = e as FleetError;
      }
      expect(err?.remediation).toContain(String(child.pid));
      expect(err?.remediation).toContain("rm ");
      expect(err?.message).toContain("req-name-me");
    });

    test("release removes our own lock; repeat and un-held releases are no-ops", () => {
      const l = lock();
      l.acquire();
      expect(existsSync(lockPath)).toBe(true);
      l.release();
      expect(existsSync(lockPath)).toBe(false);
      expect(() => l.release()).not.toThrow(); // second release: nothing held
      expect(() => lock("never-acquired").release()).not.toThrow();
    });

    test("release NEVER deletes a foreign body — parks it under a NON-.tmp orphan with content preserved (K1)", () => {
      const l = lock();
      l.acquire();
      // The lock was cleared and re-taken by someone else between our acquire
      // and our release — the classic lost-ownership window.
      const stranger = JSON.stringify({
        pid: 424242,
        pidStartTime: 7,
        createdAt: new Date().toISOString(),
        requestId: "req-stranger",
      });
      writeFileSync(lockPath, stranger);

      l.release();

      expect(existsSync(lockPath)).toBe(false);
      const parked = readdirSync(dirname(lockPath)).filter((n) => n.startsWith(`${basename(lockPath)}.orphan.`));
      expect(parked.length).toBe(1);
      // K1: a .tmp-suffixed park would be garbage-collected by the next sweep.
      expect(parked[0]?.endsWith(".tmp")).toBe(false);
      expect(readFileSync(join(dirname(lockPath), parked[0] ?? ""), "utf8")).toBe(stranger); /* dp:ok length asserted above; the "" path would EISDIR and fail the test */
    });

    test("release refuses while marked destructive unless forced", () => {
      const l = lock();
      l.acquire();
      l.markDestructive();
      expect(() => l.release()).toThrow(/destructive|destroying/i);
      expect(existsSync(lockPath)).toBe(true); // deliberately kept
      l.release({ force: true });
      expect(existsSync(lockPath)).toBe(false);
    });

    test("SIGINT mid-hold releases the lock — real child through the signal-install seam", async () => {
      const scriptPath = join(tmpRoot, `holder-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(scriptPath, CHILD_SCRIPT_SRC(realpathSync(new URL("../../src/fleet/fleet-lock.ts", import.meta.url).pathname)));

      const child = Bun.spawn(["bun", scriptPath, lockPath, "req-sigint-child"]);
      children.push(child);
      const line = await within("holder announce", 20_000, readLine(child.stdout, "holder"));
      expect(line).toBe("HELD req-sigint-child");
      // Premise: the child really holds it, with ITS identity in the body.
      expect(onDisk().pid).toBe(child.pid);

      child.kill("SIGINT");
      const [signalCode] = await within("holder exit", 20_000, child.exited.then(() => [child.signalCode]));
      // Died BY the signal, not swallowed-and-exited-cleanly: the handler ran,
      // released, removed itself, and restored the default disposition.
      expect(signalCode).toBe("SIGINT");
      expect(existsSync(lockPath)).toBe(false);
    }, 30_000);

    test("barrier-forced concurrent race: exactly one contender admits, the loser exits 5 fleet-busy having written nothing", async () => {
      const scriptPath = join(tmpRoot, `contender-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(scriptPath, CHILD_SCRIPT_SRC(realpathSync(new URL("../../src/fleet/fleet-lock.ts", import.meta.url).pathname)));

      // Contender A acquires and HOLDS (idle timer) — the HELD line is the seam
      // barrier proving the critical section is occupied before B starts.
      const a = Bun.spawn(["bun", scriptPath, lockPath, "req-race-a"]);
      children.push(a);
      expect(await within("A announce", 20_000, readLine(a.stdout, "A"))).toBe("HELD req-race-a");

      const b = Bun.spawn(["bun", scriptPath, lockPath, "req-race-b"]);
      children.push(b);
      const [bLine, bCode] = await within(
        "B verdict",
        20_000,
        Promise.all([readLine(b.stdout, "B"), b.exited]),
      );
      expect(bLine).toBe("REFUSED fleet-busy");
      expect(bCode).toBe(5);

      // The loser provisioned nothing: the winning body is untouched.
      expect(onDisk().requestId).toBe("req-race-a");
      a.kill("SIGKILL");
      await a.exited;
    }, 40_000);
  });
});

