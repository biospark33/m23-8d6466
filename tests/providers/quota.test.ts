/**
 * DF2.6 — the quota half: checkHeadroom's boundary semantics (AC2), config
 * file override + limitsSource, malformed/invalid limits failing closed,
 * createRun's refusal BEFORE any box or record exists, the default ownership
 * tag, list-unverified (AC4's headroom half) and the empty fleet (AC5's).
 *
 * Every test chdirs into its own tmpdir FIRST so the default
 * `.sandbox/quota-limits.json` path can never resolve at the repo root — the
 * real `.sandbox/` is never read or written. checkHeadroom calls that are not
 * about the file path pass limits explicitly for the same reason.
 *
 * checkHeadroom is a read, not a lock (story Technical Notes): nothing here
 * asserts reservation because nothing may be reserved.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRun, SBX_OWNERSHIP_TAG, type ProviderAuditLink } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { type LogEntry, setLogSink } from "../../src/lib/log.ts";
import {
  checkHeadroom,
  loadQuotaLimits,
  DEFAULT_QUOTA_LIMITS,
  HeadroomRefusedError,
  QuotaLimitsError,
  type HeadroomInput,
  type LoadedQuotaLimits,
} from "../../src/providers/quota.ts";

let dir: string;
/**
 * DF5.3: the quota gate's arms are "refused ⇒ no link" and "admitted but
 * unattributed ⇒ no link" — absences a blind `() => {}` sink cannot observe.
 * Reset per test below.
 */
let auditLinks: ProviderAuditLink[] = [];
let prevCwd: string;
let prevQuotaEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df26-quota-"));
  auditLinks = [];
  prevCwd = process.cwd();
  // The default quota path (and createRun's loadQuotaLimits()) resolves
  // against cwd — pin it to this test's tmpdir for the whole test. The env
  // override tier is cleared for the same reason: a developer's exported
  // $QDS_QUOTA_LIMITS_FILE must never leak into the implicit-path tests.
  prevQuotaEnv = process.env.QDS_QUOTA_LIMITS_FILE;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevQuotaEnv !== undefined) delete process.env.QDS_QUOTA_LIMITS_FILE;
  process.chdir(dir);
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevQuotaEnv === undefined) delete process.env.QDS_QUOTA_LIMITS_FILE;
  else process.env.QDS_QUOTA_LIMITS_FILE = prevQuotaEnv;
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Structural driver over a counted population — no substrate, per design D4. */
function fleetOf(n: number): HeadroomInput {
  return { list: async () => Array.from({ length: n }, (_, i) => ({ name: `vm-${i}` })) };
}

const throwingList: HeadroomInput = {
  list: () => Promise.reject(new Error("ssh: connection reset by peer")),
};

/** Defaults as a LoadedQuotaLimits with per-test overrides — never touches disk. */
function loaded(over: Partial<typeof DEFAULT_QUOTA_LIMITS> = {}): LoadedQuotaLimits {
  return { limits: { ...DEFAULT_QUOTA_LIMITS, ...over }, source: "default" };
}

/** A quota-limits.json body in the tmpdir; returns the explicit path to it. */
function limitsFile(body: string): string {
  const p = join(dir, "quota-limits.json");
  writeFileSync(p, body);
  return p;
}

// ─── defaults + config file ──────────────────────────────────────────────────

describe("DF2.6 quota limits", () => {
  test("DEFAULT_QUOTA_LIMITS: the checked-in defaults (vendor-single-origin [VERIFY], D7)", () => {
    expect(DEFAULT_QUOTA_LIMITS).toEqual({
      maxVms: 50,
      maxPooledDiskGiB: 100,
      perVmDiskReservationGiB: 2,
      maxTransferGiB: 200,
      staleAfterMs: 14_400_000,
    });
  });

  test("absent file ⇒ defaults + limitsSource 'default'", () => {
    const res = loadQuotaLimits(join(dir, "no-such-quota-limits.json"));
    expect(res.source).toBe("default");
    expect(res.limits).toEqual(DEFAULT_QUOTA_LIMITS);
  });

  test("absent file emits an absent-config line naming the path (F045)", () => {
    // The ceilings gate createRun's headroom check, and
    // $QDS_QUOTA_LIMITS_FILE can swap an operator's caps for the built-ins.
    // Falling back is legitimate; falling back SILENTLY is not.
    const lines: LogEntry[] = [];
    const restore = setLogSink((e) => lines.push(e));
    const missing = join(dir, "no-such-quota-limits.json");
    try {
      loadQuotaLimits(missing);
    } finally {
      restore();
    }
    const absent = lines.find((l) => l.code === "quota-limits-absent-using-defaults");
    expect(absent).toBeDefined();
    expect(absent?.limitsFile).toBe(missing);
    expect(absent?.status).toBe("ok");
  });

  test("present file ⇒ PARTIAL per-key override over defaults + limitsSource 'file' + path", async () => {
    const file = limitsFile('{"maxVms": 5, "staleAfterMs": 1000}\n');
    const res = loadQuotaLimits(file);
    expect(res.source).toBe("file");
    expect(res.file).toBe(file);
    expect(res.limits.maxVms).toBe(5);
    expect(res.limits.staleAfterMs).toBe(1000);
    // unspecified keys keep their defaults — partial, not whole-file
    expect(res.limits.maxPooledDiskGiB).toBe(DEFAULT_QUOTA_LIMITS.maxPooledDiskGiB);
    expect(res.limits.perVmDiskReservationGiB).toBe(DEFAULT_QUOTA_LIMITS.perVmDiskReservationGiB);
    expect(res.limits.maxTransferGiB).toBe(DEFAULT_QUOTA_LIMITS.maxTransferGiB);

    // the loaded ceilings are what checkHeadroom refuses against: 4 live, ceiling 5
    const fleet = fleetOf(4);
    expect((await checkHeadroom(fleet, 1, res)).allowed).toBeTrue(); // 4+1 === 5, inclusive
    const refused = await checkHeadroom(fleet, 2, res);
    expect(refused.allowed).toBeFalse();
    expect(refused.ceiling).toBe(5);
    expect(refused.reason).toBe("vm-ceiling");
    expect(refused.limitsSource).toBe("file");
  });

  test("$QDS_QUOTA_LIMITS_FILE re-points the implicit path; an explicit argument still outranks it", () => {
    const file = limitsFile('{"maxVms": 7}\n');
    process.env.QDS_QUOTA_LIMITS_FILE = file;
    try {
      // no argument — the implicit resolution createRun/sweep use
      const res = loadQuotaLimits();
      expect(res.source).toBe("file");
      expect(res.file).toBe(file);
      expect(res.limits.maxVms).toBe(7);
      // explicit argument > env var > cwd-relative default
      expect(loadQuotaLimits(join(dir, "no-such-quota-limits.json")).source).toBe("default");
    } finally {
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.QDS_QUOTA_LIMITS_FILE;
    }
  });

  test("malformed JSON ⇒ QuotaLimitsError quota-limits-unreadable, remediation names the JSON body to write", () => {
    const file = limitsFile("{ not json\n");
    let err: unknown;
    try {
      loadQuotaLimits(file);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QuotaLimitsError);
    const qe = err as QuotaLimitsError;
    expect(qe.code).toBe("quota-limits-unreadable");
    expect(qe.message).toContain(file);
    // the exedev posture pattern: remediation carries the exact body to write
    expect(qe.remediation).toContain("maxVms");
    expect(qe.remediation).toContain("{");
  });

  test("invalid values (0, negative, non-number, unknown key) ⇒ QuotaLimitsError quota-limits-invalid, fail-closed", () => {
    const bodies = [
      '{"maxVms": 0}',
      '{"maxVms": -3}',
      '{"staleAfterMs": -1}',
      '{"maxPooledDiskGiB": "one hundred"}',
      '{"totallyUnknownKey": 5}',
    ];
    for (const body of bodies) {
      let err: unknown;
      try {
        loadQuotaLimits(limitsFile(body));
      } catch (e) {
        err = e;
      }
      expect(err, `body: ${body}`).toBeInstanceOf(QuotaLimitsError);
      expect((err as QuotaLimitsError).code, `body: ${body}`).toBe("quota-limits-invalid");
      expect((err as QuotaLimitsError).remediation).toContain("maxVms");
    }
  });

  // ─── AC2 — the headroom boundary ────────────────────────────────────────────

  test("AC2: 48 live / ceiling 50 — checkHeadroom(3) refused with the exact fields", async () => {
    const r = await checkHeadroom(fleetOf(48), 3, loaded());
    expect(r.allowed).toBeFalse();
    expect(r.liveVms).toBe(48);
    expect(r.ceiling).toBe(50);
    expect(r.requested).toBe(3);
    expect(r.headroom).toBe(2);
    expect(r.reason).toBe("vm-ceiling");
    expect(r.verified).toBeTrue();
    // VM count is authoritative; disk is a labelled estimate, never measured
    expect(r.usedDiskGiB).toBe(96); // 48 × 2 GiB reservation
    expect(r.diskEstimated).toBeTrue();
    expect(r.limitsSource).toBe("default");
  });

  test("AC2 boundary inclusive: checkHeadroom(2) at 48/50 is allowed", async () => {
    const r = await checkHeadroom(fleetOf(48), 2, loaded());
    expect(r.allowed).toBeTrue();
    expect(r.headroom).toBe(2);
    expect(r.reason).toBeUndefined();
  });

  test("pooled-disk ceiling refuses independently of the VM ceiling", async () => {
    // 3 live × 2 GiB = 6 of 8 GiB pooled: n=1 lands exactly on 8 (inclusive,
    // allowed), n=2 crosses it while staying far under maxVms — the disk
    // ceiling must refuse on its own.
    const small = loaded({ maxPooledDiskGiB: 8 });
    expect((await checkHeadroom(fleetOf(3), 1, small)).allowed).toBeTrue();
    const r = await checkHeadroom(fleetOf(3), 2, small);
    expect(r.allowed).toBeFalse();
    expect(r.reason).toBe("pooled-disk");
    expect(r.usedDiskGiB).toBe(6);
    expect(r.ceiling).toBe(50); // the VM ceiling was never the constraint
  });

  // ─── AC4 / AC5 — the two degenerate populations ────────────────────────────

  test("AC4: list() throws ⇒ allowed:false reason list-unverified — never headroom from an uncounted population", async () => {
    const r = await checkHeadroom(throwingList, 1, loaded(), 25_000, undefined, 1);
    expect(r.allowed).toBeFalse();
    expect(r.reason).toBe("list-unverified");
    expect(r.liveVms).toBe(0);
    expect(r.verified).toBeFalse();
    expect(r.headroom).toBe(0);
  });

  test("AC4: a list() that never settles times out to the same list-unverified refusal", async () => {
    // The enumeration is bounded by the same withTimeout/LIST_TIMEOUT_MS the
    // reaper's sweep uses — a wedged driver must refuse here, not hang
    // createRun. Tiny injected budget so the test doesn't park on 15s.
    const hung: HeadroomInput = { list: () => new Promise(() => {}) };
    const r = await checkHeadroom(hung, 1, loaded(), 25, undefined, 1);
    expect(r.allowed).toBeFalse();
    expect(r.reason).toBe("list-unverified");
    expect(r.liveVms).toBe(0);
    expect(r.verified).toBeFalse();
    expect(r.headroom).toBe(0);
  });

  test("AC4: a list() that resolves a non-array (undefined/null/garbage) returns list-unverified, never a TypeError crash", async () => {
    // AC4's fail-closed posture: an unenumerable list is a refusal, not a
    // crash. The same shape as the catch path — allowed:false, verified:false,
    // headroom:0, reason:list-unverified.
    const nonArray: HeadroomInput = { list: async () => undefined as never };
    const r = await checkHeadroom(nonArray, 1, loaded(), 25_000, undefined, 1);
    expect(r.allowed).toBeFalse();
    expect(r.reason).toBe("list-unverified");
    expect(r.verified).toBeFalse();
    expect(r.liveVms).toBe(0);
    expect(r.headroom).toBe(0);
  });

  test("AC5: empty fleet ⇒ full configured ceiling as headroom — a normal state", async () => {
    const r = await checkHeadroom(fleetOf(0), 3, loaded());
    expect(r.allowed).toBeTrue();
    expect(r.liveVms).toBe(0);
    expect(r.headroom).toBe(r.ceiling);
    expect(r.ceiling).toBe(50);
  });

  test("requested < 1 or non-integer or non-finite throws", async () => {
    const bad = [0, -1, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const n of bad) {
      let err: unknown;
      try {
        await checkHeadroom(fleetOf(0), n, loaded());
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("requested");
      expect((err as Error).message).toContain(String(n));
    }
  });

  // ─── the create path ────────────────────────────────────────────────────────

  test("createRun refuses at the ceiling BEFORE store.create — zero boxes, zero records, HeadroomRefusedError", async () => {
    // a small overridden ceiling via the default config file path (cwd is dir)
    mkdirSync(join(dir, ".sandbox"), { recursive: true });
    writeFileSync(join(dir, ".sandbox", "quota-limits.json"), '{"maxVms": 2}\n');
    const driver = new FakeDriver(join(dir, "boxes"));
    await driver.create("seed1-20260820-000001");
    await driver.create("seed2-20260820-000002");
    const store = new RunRecordStore(join(dir, "runs"));

    let err: unknown;
    try {
      await createRun(driver, store, { runId: "df26ref-20260820-000003", recordAuditLink: (l) => auditLinks.push(l) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HeadroomRefusedError);
    const he = err as HeadroomRefusedError;
    expect(he.code).toBe("headroom-refused");
    expect(he.message).toContain("vm-ceiling");
    expect(he.result.allowed).toBeFalse();
    expect(he.result.reason).toBe("vm-ceiling");
    expect(he.result.ceiling).toBe(2);
    // refused BEFORE store.create and driver.create (design §2): zero records,
    // and the live population is byte-identical
    expect(store.list()).toHaveLength(0);
    expect((await driver.list()).map((v) => v.name).sort()).toEqual(["seed1-20260820-000001", "seed2-20260820-000002"]);
    // …and no `run-box.create` link vouches for the box that was never made.
    // The refusal fires before `driver.create`, so this is structurally safe
    // today — the point is that nothing PROVED it while the sink was blind.
    expect(auditLinks).toEqual([]);
  });

  test("createRun under the ceiling proceeds; every box carries the canonical SBX_OWNERSHIP_TAG", async () => {
    expect(SBX_OWNERSHIP_TAG).toBe("qds-sbx");
    const driver = new FakeDriver(join(dir, "boxes"));
    const store = new RunRecordStore(join(dir, "runs"));

    await createRun(driver, store, { runId: "df26tag-20260820-000001", recordAuditLink: (l) => auditLinks.push(l) });
    await createRun(driver, store, { runId: "df26tag-20260820-000002", recordAuditLink: (l) => auditLinks.push(l) });

    const vms = await driver.list();
    // The ownership marker is canonical and non-displaceable: a factory box
    // tagged anything else would classify `foreign` in the reaper (reported,
    // never destroyed) — an unreapable leak by construction.
    expect(vms.map((v) => v.tag)).toEqual([SBX_OWNERSHIP_TAG, SBX_OWNERSHIP_TAG]);
    expect(store.get("df26tag-20260820-000001").vmName).toBe("df26tag-20260820-000001");
    // Both runs are UNATTRIBUTED (no DF2.8 budget on the record), so hop 5
    // stays unlinked: an emitter that manufactured a repoSlug to fill the
    // NOT NULL columns is exactly what INV-AUDIT-4 forbids.
    expect(auditLinks).toEqual([]);
  });
});

// ─── the verified-list retry (round 19 attempt 11, live) ────────────────────

describe("checkHeadroom verified-list retry", () => {
  test("first read throws, second is clean ⇒ allowed — one flaky read never refuses a dispatch", async () => {
    let calls = 0;
    const flaky: HeadroomInput = {
      list: async () => {
        calls++;
        if (calls === 1) throw new Error("ssh transport blip");
        return [{ name: "qds-a" }];
      },
    };
    const r = await checkHeadroom(flaky, 1, loaded(), 25, undefined, 1);
    expect(calls).toBe(2);
    expect(r.allowed).toBeTrue();
    expect(r.verified).toBeTrue();
  });

  test("both reads fail ⇒ the list-unverified refusal is unchanged", async () => {
    const dead: HeadroomInput = { list: async () => { throw new Error("down"); } };
    const r = await checkHeadroom(dead, 1, loaded(), 25, undefined, 1);
    expect(r.allowed).toBeFalse();
    expect(r.reason).toBe("list-unverified");
  });

  test("first read carries a non-empty skipped channel, second is clean ⇒ allowed", async () => {
    let calls = 0;
    const partial: HeadroomInput & { listWithAnomalies: () => Promise<{ vms: { name: string }[]; skipped: string[] }> } = {
      list: async () => [{ name: "qds-a" }],
      listWithAnomalies: async () => {
        calls++;
        return calls === 1
          ? { vms: [], skipped: ["qds-ghost"] }
          : { vms: [{ name: "qds-a" }], skipped: [] };
      },
    };
    const r = await checkHeadroom(partial, 1, loaded(), 25, undefined, 1);
    expect(calls).toBe(2);
    expect(r.allowed).toBeTrue();
  });
});
