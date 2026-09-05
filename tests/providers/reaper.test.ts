/**
 * DF2.6 — the reaper half: the three-way join's classification (AC1's table,
 * exact), dry-run default + --yes effects, foreign negative controls, the two
 * hold-off classes (AC7), the two in-flight protections (AC6), hard exits on
 * malformed records (AC3) and unenumerable lists (AC4), the empty fleet (AC5),
 * reap-blocked escalation, keyHash mismatch, the 25-action cap, per-run action
 * collapse, the closed-record leaked key, dry-run-predicts-apply, the
 * observability contract, and the MANDATORY script e2e demo (DoD).
 *
 * Every sweep gets explicit reapDir/limits/now pointing at tmpdirs and a fixed
 * clock — the repo's real `.sandbox/` is never read or written. Sweeps whose
 * teardowns must SUCCEED chdir into a throwaway `git init` repo first
 * (teardown's harvest fetch needs a host repo); the cwd is restored in
 * afterEach either way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkHeadroom, type LoadedQuotaLimits } from "../../src/providers/quota.ts";
import { run as runReap } from "../../scripts/sandbox-reap.ts";
import {
  sweep,
  SweepError,
  REAP_HISTORY_MAX_REPORTS,
  RUN_ID_SHAPE,
  type SweepDeps,
  type SweepReport,
  type SweepRow,
} from "../../src/providers/reaper.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import type { FakeDriver } from "../../src/providers/fake-driver.ts";
import { SBX_OWNERSHIP_TAG, type ExecResult } from "../../src/providers/driver.ts";
import type { FakeKeyApi } from "./fixtures/fake-key-api.ts";
import { seedFleet, type FleetState, type SeededFleet } from "./fixtures/fleet-state.ts";
import { runLocal } from "./fixtures/git-fixture.ts";

// ─── fixed population ids (all match the generated run-id shape where owned) ──

const STALE_MS = 14_400_000; // the default staleAfterMs — ages keep hour-scale margins
const HOUR = 3_600_000;
const YOUNG = HOUR; // under staleAfterMs
const OLD = 5 * HOUR; // at/over staleAfterMs
const NOW = new Date("2026-08-20T12:00:00.000Z");

const RUN_A = "df26a-20260820-aaaa01"; // open, young — paired, in flight
const RUN_B = "df26b-20260820-bbbb02"; // open, aged — its teardown died
const VM_ORPHAN = "df26v-20260820-cccc03"; // owned VM, no record
const RUN_ORPHAN_KEY = "df26k-20260820-dddd04"; // record-less sbx- key, aged
const RUN_CUSTOM_PREFIX = "df26p-20260820-1a2b07"; // custom-prefix key + record (fixture join)
const RUN_MINT = "df26m-20260820-eeee05"; // record-less sbx- key, young (AC7)
const RUN_NOAGE = "df26n-20260820-ffff06"; // record-less sbx- key, no createdAt (AC7)
const RUN_WINDOW = "df26w-20260820-0e0f10"; // record + VM young, key absent (AC6 mint window)
const OPERATOR_VM = "steve-devbox"; // fails the shape test
const OPERATOR_VM_SHAPED = "steve-devbox-20260812-a1b2c3"; // shape-match, NO tag
const OPERATOR_KEY = "steve-personal-key"; // unprefixed
const MISMATCH_HASH = `${"ab".repeat(32)}`; // ≠ every hash FakeKeyApi mints

const LIMITS: LoadedQuotaLimits = {
  limits: { maxVms: 50, maxPooledDiskGiB: 100, perVmDiskReservationGiB: 2, maxTransferGiB: 200, staleAfterMs: STALE_MS },
  source: "default",
};

let dir: string;
let prevCwd: string;
let prevQuotaEnv: string | undefined;
let logs: LogEntry[];
let restoreLog: (() => void) | undefined;
/** mkdtemp roots to clean in afterEach (the test dir + any host/demo repos). */
const roots: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df26-reap-"));
  roots.push(dir);
  prevCwd = process.cwd();
  // The default quota path (and createRun's loadQuotaLimits()) resolves
  // against cwd — pin it to this test's tmpdir for the whole test. The env
  // override tier is cleared for the same reason: a developer's exported
  // $QDS_QUOTA_LIMITS_FILE must never leak into the implicit-path tests.
  prevQuotaEnv = process.env.QDS_QUOTA_LIMITS_FILE;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevQuotaEnv !== undefined) delete process.env.QDS_QUOTA_LIMITS_FILE;
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
});

afterEach(() => {
  restoreLog?.();
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevQuotaEnv === undefined) delete process.env.QDS_QUOTA_LIMITS_FILE;
  else process.env.QDS_QUOTA_LIMITS_FILE = prevQuotaEnv;
  process.chdir(prevCwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString();
const keyName = (runId: string): string => `sbx-${runId}`;

function deps(fleet: SeededFleet, overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    driver: fleet.driver,
    store: fleet.store,
    keyApi: fleet.keyApi,
    limits: LIMITS,
    reapDir: join(dir, "reap"),
    requestId: "req-df26-test",
    now: () => NOW,
    ...overrides,
  };
}

/** The story's E2E slice: 3 VMs / 4 keys / 2 records. */
function e2eState(keyApiOpts: FleetState["keyApiOpts"] = undefined): FleetState {
  return {
    vms: [{ name: RUN_A }, { name: RUN_B }, { name: VM_ORPHAN }],
    keys: [
      { runId: RUN_A, createdAt: iso(NOW.getTime() - YOUNG) },
      { runId: RUN_B, createdAt: iso(NOW.getTime() - OLD) },
      { runId: RUN_ORPHAN_KEY, createdAt: iso(NOW.getTime() - OLD) },
      { name: OPERATOR_KEY },
    ],
    records: [{ runId: RUN_A, ageMs: YOUNG }, { runId: RUN_B, ageMs: OLD }],
    ...(keyApiOpts === undefined ? {} : { keyApiOpts }),
  };
}

function hashOf(fleet: SeededFleet, name: string): string {
  const entry = fleet.keyApi.keys.find((k) => k.name === name);
  if (!entry) throw new Error(`no key named ${name} in the seeded fleet`);
  return entry.hash;
}

async function keyLive(fleet: SeededFleet, hash: string): Promise<boolean> {
  return (await fleet.keyApi.listAllKeys(20)).entries.some((k) => k.hash === hash);
}

/** `kind:id:class:action` — the classification signature a row must justify. */
const rowSig = (r: SweepRow): string => `${r.kind}:${r.id}:${r.class}:${r.action}`;

/** A throwaway host git repo, entered as cwd — teardown's harvest fetch target. */
async function enterHostRepo(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "qds-df26-host-"));
  roots.push(root);
  await runLocal(["git", "init", "-q", "-b", "main", root]);
  process.chdir(root);
}

// ─── 1. E2E slice — dry run ─────────────────────────────────────────────────

describe("DF2.6 sweep", () => {
  test("E2E dry-run: exact class/action per item, deletes nothing, executed lists predictions", async () => {
    const fleet = await seedFleet(dir, e2eState(), NOW);

    const report = await sweep(deps(fleet));

    expect(report.mode).toBe("dry-run");
    expect(report.liveVms).toBe(3);
    expect(report.liveKeys).toBe(4);
    expect(report.records).toBe(2);
    expect(report.nothingToReap).toBeFalse();
    expect(report.rows.map(rowSig).sort()).toEqual(
      [
        `key:${keyName(RUN_A)}:paired:report`,
        `key:${keyName(RUN_B)}:stale-record:teardown`,
        `key:${keyName(RUN_ORPHAN_KEY)}:leaked-key:revoke`,
        `key:${OPERATOR_KEY}:foreign:report`,
        `record:${RUN_A}:paired:report`,
        `record:${RUN_B}:stale-record:teardown`,
        `vm:${RUN_A}:paired:report`,
        `vm:${RUN_B}:stale-record:teardown`,
        `vm:${VM_ORPHAN}:leaked-vm:destroy`,
      ].sort(),
    );
    // B's three rows collapse onto ONE shared per-run action
    for (const row of report.rows.filter((r) => r.runId === RUN_B)) {
      expect(row.sharedActionRunId).toBe(RUN_B);
    }
    // key rows carry a 12-hex prefix, never the full hash
    const keyRow = report.rows.find((r) => r.kind === "key" && r.id === keyName(RUN_ORPHAN_KEY));
    expect(keyRow?.keyHashPrefix).toBe(hashOf(fleet, keyName(RUN_ORPHAN_KEY)).slice(0, 12));
    // executed lists the PREDICTION in dry-run — nothing has happened yet
    expect(report.executed.teardown).toEqual([RUN_B]);
    expect(report.executed.destroy).toEqual([VM_ORPHAN]);
    expect(report.executed.revoke).toEqual([hashOf(fleet, keyName(RUN_ORPHAN_KEY)).slice(0, 12)]);
    // nothing deleted: identical populations, every record still open
    expect(await fleet.driver.list()).toHaveLength(3);
    expect((await fleet.keyApi.listAllKeys(20)).entries).toHaveLength(4);
    for (const id of [RUN_A, RUN_B]) expect(fleet.store.get(id).closedAt).toBeUndefined();
    // the report file is written in BOTH modes
    expect(existsSync(report.reportFile)).toBeTrue();
  });

  // ─── 2. E2E slice — --yes ──────────────────────────────────────────────────

  test("E2E --yes: 1 teardown + 1 destroy + 1 revoke; A and the operator key untouched; headroom recovers", async () => {
    await enterHostRepo();
    const fleet = await seedFleet(dir, e2eState(), NOW);
    const orphanHash = hashOf(fleet, keyName(RUN_ORPHAN_KEY));

    const report = await sweep(deps(fleet), { yes: true });

    expect(report.mode).toBe("apply");
    expect(report.executed.teardown).toEqual([RUN_B]);
    expect(report.executed.destroy).toEqual([VM_ORPHAN]);
    expect(report.executed.revoke).toEqual([orphanHash.slice(0, 12)]);
    expect(report.failures).toHaveLength(0);
    // B went through DF2.5 teardown: spend captured, key revoked, box gone, record closed
    expect(fleet.store.get(RUN_B).closedAt).toBeString();
    expect(fleet.store.get(RUN_B).spendMicroUsd).toBe(0);
    expect(existsSync(join(fleet.boxesDir, RUN_B))).toBeFalse();
    expect(await keyLive(fleet, hashOf(fleet, keyName(RUN_B)))).toBeFalse();
    expect(await keyLive(fleet, orphanHash)).toBeFalse();
    // A is untouched: box alive, key live, record open (age is the only discriminator)
    expect(existsSync(join(fleet.boxesDir, RUN_A))).toBeTrue();
    expect(await keyLive(fleet, hashOf(fleet, keyName(RUN_A)))).toBeTrue();
    expect(fleet.store.get(RUN_A).closedAt).toBeUndefined();
    // the operator's unprefixed key is never a candidate
    expect(await keyLive(fleet, hashOf(fleet, OPERATOR_KEY))).toBeTrue();
    // fleet state afterwards: exactly A's VM, and 2 more VMs are admissible
    expect((await fleet.driver.list()).map((v) => v.name)).toEqual([RUN_A]);
    const hr = await checkHeadroom(fleet.driver, 2, LIMITS);
    expect(hr.allowed).toBeTrue();
    expect(hr.liveVms).toBe(1);
    // 20 s here and at the seven other budgets in this file, for the tests that
    // seed a real git repo and spawn real processes: bun's 5 s default is a
    // load-average failure on those, not a defect signal. The cost of the
    // choice, recorded rather than discovered later: a genuinely WEDGED spawn
    // now burns 20 s instead of 5 (≈160 s across the eight), and nothing here
    // tells "slow under load" from "hung" — both arrive as the same timeout.
    // If these get slower, the remedy is to bound the child (explicit env, an
    // owned temp HOME, a killed spawn) rather than to raise the ceiling again;
    // a ceiling raised twice is a suite that reports wedges as slowness.
  }, 20_000);

  // ─── 3. AC1 foreign negative controls ──────────────────────────────────────

  test("foreign controls: permissive-grammar VM and shape-match-no-tag VM survive --yes", async () => {
    const fleet = await seedFleet(dir, {
      // Both are UNTAGGED: the sweep's ownership proof is our tag plus a name
      // the factory could have generated. A permissive name WITHOUT the tag is
      // an operator's box; the seeder's default tag would make it
      // indistinguishable from a factory box, which is precisely the claim the
      // widened legacy-shape arm no longer pretends to doubt.
      vms: [{ name: OPERATOR_VM, tag: null }, { name: OPERATOR_VM_SHAPED, tag: null }, { name: VM_ORPHAN }],
    }, NOW);
    // the ownership grammar itself: shaped matches, permissive-only does not
    expect(RUN_ID_SHAPE.test(OPERATOR_VM_SHAPED)).toBeTrue();
    expect(RUN_ID_SHAPE.test(OPERATOR_VM)).toBeFalse();

    const report = await sweep(deps(fleet), { yes: true });

    const foreign = report.rows.filter((r) => r.class === "foreign");
    expect(foreign.map((r) => r.id).sort()).toEqual([OPERATOR_VM, OPERATOR_VM_SHAPED].sort());
    expect(foreign.every((r) => r.action === "report")).toBeTrue();
    // the ONE destroy is the tagged record-less VM; both operator VMs survive
    expect(report.executed.destroy).toEqual([VM_ORPHAN]);
    expect((await fleet.driver.list()).map((v) => v.name).sort()).toEqual([OPERATOR_VM, OPERATOR_VM_SHAPED].sort());
  });

  // ─── 3b'. legacy-id ownership: the tag is INV-1's proof, not the strict shape ──

  const LEGACY_VM = "legacy-trailing-"; // matches LEGACY_RUN_ID_RE only (trailing hyphen)

  /**
   * Hand-seed the box a PRE-TIGHTENING build would have left behind:
   * FakeDriver.create is strict today, but its listing and destroy still honour
   * the legacy grammar (as every record path does), and the metadata file is
   * exactly what an earlier build's create wrote.
   */
  async function seedLegacyBox(fleet: SeededFleet, tag: string | null): Promise<void> {
    mkdirSync(join(fleet.boxesDir, LEGACY_VM), { recursive: true });
    writeFileSync(
      join(fleet.boxesDir, LEGACY_VM, ".box.json"),
      `${JSON.stringify(
        { name: LEGACY_VM, ...(tag === null ? {} : { tag }), public: false, ports: [], createdAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  test("a TAGGED box with a legacy-shape id and NO record stays report-only (K4: tag alone cannot corroborate a non-generated name)", async () => {
    // K4 narrowing of the round-10 widening: `LEGACY_RUN_ID_RE` matches any
    // lowercase co-tenant name and the ownership tag is a shared constant, so
    // tag + legacy-name alone is ONE factor — a sibling deployment's manually
    // tagged box would classify owned and be DESTROYED unrecoverably. The
    // legacy arm now demands a record reference in THIS deployment's store
    // before it votes destroy; without one the box reports for manual
    // remediation (the pre-widening verdict for non-generated names).
    expect(RUN_ID_SHAPE.test(LEGACY_VM)).toBeFalse();

    const fleet = await seedFleet(dir, {}, NOW);
    await seedLegacyBox(fleet, SBX_OWNERSHIP_TAG);

    const dry = await sweep(deps(fleet));
    expect(dry.rows.map(rowSig)).toContain(`vm:${LEGACY_VM}:foreign:report`);
    expect(dry.executed.destroy).toEqual([]);

    const report = await sweep(deps(fleet), { yes: true });
    expect(report.failures).toHaveLength(0);
    expect(report.executed.destroy).toHaveLength(0);
    expect((await fleet.driver.list()).map((v) => v.name)).toEqual([LEGACY_VM]);
  });

  test("a TAGGED box with a legacy-shape id AND a matching record IS owned: corroboration completes the widened arm", async () => {
    // The anti-stranding intent the widening existed for still holds when the
    // evidence is two-factor: record (this store) + tag. A pre-tightening
    // build wrote the record before the box (INV-1), so every genuine factory
    // box named under the legacy grammar has one here — the corroboration arm
    // costs it nothing while refusing everything no local record vouches for.
    const fleet = await seedFleet(dir, {}, NOW);
    await seedLegacyBox(fleet, SBX_OWNERSHIP_TAG);
    // The record must CLAIM the box but not keep it alive through another arm:
    // a CLOSED record is exactly the leaked-box state INV-4 defines. Seeded by
    // hand — `store.create` applies the STRICT grammar and refuses the
    // trailing-hyphen name (that strictness is why pre-tightening records had
    // to keep being readable under the legacy rule).
    writeFileSync(
      join(fleet.runsDir, `${LEGACY_VM}.json`),
      `${JSON.stringify({ runId: LEGACY_VM, createdAt: new Date().toISOString(), closedAt: NOW.toISOString() })}\n`,
      { mode: 0o600 },
    );

    const dry = await sweep(deps(fleet));
    expect(dry.rows.map(rowSig)).toContain(`vm:${LEGACY_VM}:leaked-vm:destroy`);
    expect(dry.executed.destroy).toEqual([LEGACY_VM]);

    const report = await sweep(deps(fleet), { yes: true });
    expect(report.failures).toHaveLength(0);
    expect(report.executed.destroy).toEqual([LEGACY_VM]);
    expect(await fleet.driver.list()).toHaveLength(0);
  });

  test("an UNTAGGED legacy-shape box stays foreign — widening never relaxes the tag", async () => {
    const fleet = await seedFleet(dir, {}, NOW);
    await seedLegacyBox(fleet, null);

    const report = await sweep(deps(fleet), { yes: true });
    expect(report.rows.filter((r) => r.class === "foreign").map((r) => r.id)).toEqual([LEGACY_VM]);
    expect(report.executed.destroy).toHaveLength(0);
    expect((await fleet.driver.list()).map((v) => v.name)).toEqual([LEGACY_VM]);
  });

  // ─── 3b. fixture contract: prefix-aware key→record join ────────────────────

  test("seedFleet links a custom-prefix key into its record's keyHash; the sweep still calls it foreign", async () => {
    const fleet = await seedFleet(dir, {
      keys: [{ runId: RUN_CUSTOM_PREFIX, prefix: "mine-" }],
      records: [{ runId: RUN_CUSTOM_PREFIX, ageMs: YOUNG }],
    }, NOW);

    // the join the fixture promises: the record carries the custom-prefix key's hash
    expect(fleet.store.get(RUN_CUSTOM_PREFIX).keyHash).toBe(hashOf(fleet, `mine-${RUN_CUSTOM_PREFIX}`));

    // while the sweep itself never joins it — a non-sbx- name is foreign,
    // never a revoke candidate (the prefix defense, reap.just:7-9)
    const report = await sweep(deps(fleet));
    expect(report.rows).toContainEqual({
      kind: "key",
      id: `mine-${RUN_CUSTOM_PREFIX}`,
      class: "foreign",
      action: "report",
      keyHashPrefix: hashOf(fleet, `mine-${RUN_CUSTOM_PREFIX}`).slice(0, 12),
    });
  });

  // ─── 4. AC6 — in-flight + mint-to-record window ────────────────────────────

  test("AC6: paired run and mint-window run (record+VM young, key absent) untouched by --yes", async () => {
    await enterHostRepo();
    const fleet = await seedFleet(dir, {
      vms: [{ name: RUN_A }, { name: RUN_WINDOW }],
      keys: [{ runId: RUN_A, createdAt: iso(NOW.getTime() - YOUNG) }],
      records: [{ runId: RUN_A, ageMs: YOUNG }, { runId: RUN_WINDOW, ageMs: YOUNG }],
    }, NOW);

    const report = await sweep(deps(fleet), { yes: true });

    for (const id of [RUN_A, RUN_WINDOW]) {
      expect(report.rows.filter((r) => r.runId === id).every((r) => r.action === "report")).toBeTrue();
      expect(fleet.store.get(id).closedAt).toBeUndefined();
      expect(existsSync(join(fleet.boxesDir, id))).toBeTrue();
    }
    expect(report.executed).toEqual({ teardown: [], destroy: [], revoke: [] });
  }, 20_000);

  // ─── 5. AC7 — both hold-off classes ────────────────────────────────────────

  test("AC7: young record-less key ⇒ paired-pending; no-createdAt key ⇒ key-age-unavailable; zero revokes under --yes", async () => {
    const fleet = await seedFleet(dir, {
      keyApiOpts: { omitCreatedAt: true }, // the provider reports no age at all
      keys: [
        { runId: RUN_MINT, createdAt: iso(NOW.getTime() - YOUNG) }, // back-dated: young and KNOWN
        { runId: RUN_NOAGE }, // no creation time, ever
      ],
    }, NOW);

    const report = await sweep(deps(fleet), { yes: true });

    const mint = report.rows.find((r) => r.id === keyName(RUN_MINT));
    expect(mint?.class).toBe("paired-pending");
    expect(mint?.action).toBe("report");
    const noage = report.rows.find((r) => r.id === keyName(RUN_NOAGE));
    expect(noage?.class).toBe("key-age-unavailable");
    expect(noage?.action).toBe("report");
    // an age-blind implementation revokes a live run's key and MUST fail here
    expect(report.executed.revoke).toEqual([]);
    expect(await keyLive(fleet, hashOf(fleet, keyName(RUN_MINT)))).toBeTrue();
    expect(await keyLive(fleet, hashOf(fleet, keyName(RUN_NOAGE)))).toBeTrue();
    expect(report.nothingToReap).toBeTrue();
  });

  // ─── 6. AC3 — malformed record is a hard exit ──────────────────────────────

  test("AC3: one malformed record ⇒ SweepError record-unreadable, zero deletions anywhere", async () => {
    const fleet = await seedFleet(dir, e2eState(), NOW);
    writeFileSync(join(fleet.runsDir, "df26bad-20260820-badbad.json"), "{ not json\n");

    let err: unknown;
    try {
      await sweep(deps(fleet), { yes: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SweepError);
    const se = err as SweepError;
    expect(se.code).toBe("record-unreadable");
    expect(se.message).toContain("df26bad-20260820-badbad");
    expect(se.remediation).toBeString();
    // nothing deleted anywhere in that sweep: populations byte-identical
    expect(await fleet.driver.list()).toHaveLength(3);
    expect((await fleet.keyApi.listAllKeys(20)).entries).toHaveLength(4);
    expect(fleet.store.get(RUN_A).closedAt).toBeUndefined();
    expect(fleet.store.get(RUN_B).closedAt).toBeUndefined();
    // the malformed file itself is intact — loud, not quietly dropped or fixed
    expect(readdirSync(fleet.runsDir).filter((f) => f.endsWith(".json"))).toHaveLength(3);
  });

  // ─── 7. AC4 — unenumerable lists ───────────────────────────────────────────

  test("AC4: truncated key page ⇒ SweepError list-unverified; a throwing driver.list() ⇒ same + zero reaping + checkHeadroom refuses", async () => {
    // truncated pagination envelope: the enumerator never reaches an empty page
    const truncated = await seedFleet(dir, { keyApiOpts: { listTruncated: true } }, NOW);
    let err: unknown;
    try {
      await sweep(deps(truncated), { yes: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SweepError);
    expect((err as SweepError).code).toBe("list-unverified");

    // transport failure on the VM list: same fail-closed shape, zero reaping
    const fleet = await seedFleet(dir, e2eState(), NOW);
    const brokenList = Object.create(fleet.driver) as FakeDriver;
    brokenList.list = () => Promise.reject(new Error("ssh: connection reset by peer"));
    // BOTH entry points, or the injection does not reach the sweep: `sweep()`
    // enumerates through `listWithAnomalies` now, and `Object.create` overrides
    // only the property it is given — the prototype's working `listWithAnomalies`
    // would keep serving the sweep and this test would pass on a driver that is
    // not actually broken. The dual-entry hazard is inherent to the
    // `list()`/`listWithAnomalies()` split; a transport failure hits both.
    brokenList.listWithAnomalies = () => Promise.reject(new Error("ssh: connection reset by peer"));
    let err2: unknown;
    try {
      await sweep(deps(fleet, { driver: brokenList }), { yes: true });
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeInstanceOf(SweepError);
    expect((err2 as SweepError).code).toBe("list-unverified");
    expect(await fleet.driver.list()).toHaveLength(3);
    expect((await fleet.keyApi.listAllKeys(20)).entries).toHaveLength(4);
    for (const id of [RUN_A, RUN_B]) expect(fleet.store.get(id).closedAt).toBeUndefined();
    // unknown population means zero headroom, never full headroom
    const hr = await checkHeadroom(brokenList, 1, LIMITS);
    expect(hr.allowed).toBeFalse();
    expect(hr.reason).toBe("list-unverified");
    expect(hr.headroom).toBe(0);
  });

  // ─── 8. AC5 — empty fleet ──────────────────────────────────────────────────

  test("AC5: empty fleet ⇒ nothingToReap, zero rows, report still written", async () => {
    const fleet = await seedFleet(dir, {}, NOW);

    const report = await sweep(deps(fleet));

    expect(report.rows).toEqual([]);
    expect(report.nothingToReap).toBeTrue();
    expect(report.liveVms).toBe(0);
    expect(report.liveKeys).toBe(0);
    expect(report.records).toBe(0);
    expect(existsSync(report.reportFile)).toBeTrue();
  });

  // ─── 9. reap-blocked escalation ────────────────────────────────────────────

  test("reap-blocked: three failed teardowns ⇒ the fourth sweep issues ZERO teardown calls, item still in liveVms", async () => {
    await enterHostRepo();
    const fleet = await seedFleet(dir, {
      keyApiOpts: { deleteStatus: 500 }, // revoke always 500s ⇒ teardown aborts at step 4, record stays open
      vms: [{ name: RUN_B }],
      keys: [{ runId: RUN_B, createdAt: iso(NOW.getTime() - OLD) }],
      records: [{ runId: RUN_B, ageMs: OLD }],
    }, NOW);
    // count teardown INVOCATIONS via the key-list reads every teardown's
    // spend+revoke pair makes — sweep 4 must not add a single one.
    let keyReads = 0;
    const counting = Object.create(fleet.keyApi) as FakeKeyApi;
    counting.getKeyEntry = (hash: string, maxPages?: number) => {
      keyReads++;
      return fleet.keyApi.getKeyEntry(hash, maxPages);
    };

    const d = deps(fleet, { keyApi: counting });
    for (let i = 1; i <= 3; i++) {
      const r = await sweep(d, { yes: true });
      expect(r.failures.length).toBeGreaterThan(0); // each failed attempt was recorded
      expect(r.executed.teardown).toEqual([RUN_B]);
    }
    const readsAfterThree = keyReads;
    expect(readsAfterThree).toBeGreaterThan(0);

    const fourth = await sweep(d, { yes: true });

    expect(keyReads).toBe(readsAfterThree); // ZERO further teardown calls
    expect(fourth.executed.teardown).toEqual([]);
    const rows = fourth.rows.filter((r) => r.runId === RUN_B);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.action === "reap-blocked")).toBeTrue();
    expect(rows[0]?.failure?.code).toBeString(); // carries the LAST failure's payload
    expect(rows[0]?.failure?.remediation).toBeString();
    // still live population: counted in liveVms, box alive, record open
    expect(fourth.liveVms).toBe(1);
    expect(existsSync(join(fleet.boxesDir, RUN_B))).toBeTrue();
    expect(fleet.store.get(RUN_B).closedAt).toBeUndefined();
  }, 20_000);

  // ─── 10. keyHash mismatch — never reaped ───────────────────────────────────

  test("keyHash mismatch: two credentials claiming one run ⇒ every row report, zero calls", async () => {
    await enterHostRepo();
    const fleet = await seedFleet(dir, {
      vms: [{ name: RUN_B }],
      keys: [{ runId: RUN_B, createdAt: iso(NOW.getTime() - OLD) }],
      records: [{ runId: RUN_B, ageMs: OLD, keyHash: MISMATCH_HASH }],
    }, NOW);

    const report = await sweep(deps(fleet), { yes: true });

    const rows = report.rows.filter((r) => r.runId === RUN_B);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.keyHashMismatch === true)).toBeTrue();
    expect(rows.every((r) => r.action === "report")).toBeTrue();
    expect(report.executed).toEqual({ teardown: [], destroy: [], revoke: [] });
    expect(await keyLive(fleet, hashOf(fleet, keyName(RUN_B)))).toBeTrue();
    expect(existsSync(join(fleet.boxesDir, RUN_B))).toBeTrue();
    expect(fleet.store.get(RUN_B).closedAt).toBeUndefined();
  }, 20_000);

  // ─── 11. the 25-action cap ─────────────────────────────────────────────────

  test("25-cap: 30 leaked owned VMs ⇒ 25 destroyed, 5 rows skipped and reported", async () => {
    const fleet = await seedFleet(dir, {
      vms: Array.from({ length: 30 }, (_, i) => ({ name: `cap25-20260820-${String(i + 1).padStart(6, "0")}` })),
    }, NOW);

    const report = await sweep(deps(fleet), { yes: true });

    const leaked = report.rows.filter((r) => r.class === "leaked-vm");
    expect(leaked).toHaveLength(30);
    expect(leaked.filter((r) => r.action === "destroy")).toHaveLength(25);
    expect(leaked.filter((r) => r.action === "skipped")).toHaveLength(5);
    expect(report.executed.destroy).toHaveLength(25);
    expect(await fleet.driver.list()).toHaveLength(5); // the reported remainder
  });

  // ─── 12. three rows, one action ────────────────────────────────────────────

  test("three rows, one action: stale record with live VM + key ⇒ exactly one teardown(runId)", async () => {
    await enterHostRepo();
    const fleet = await seedFleet(dir, {
      vms: [{ name: RUN_B }],
      keys: [{ runId: RUN_B, createdAt: iso(NOW.getTime() - OLD) }],
      records: [{ runId: RUN_B, ageMs: OLD }],
    }, NOW);

    const report = await sweep(deps(fleet), { yes: true });

    const rows = report.rows.filter((r) => r.runId === RUN_B);
    expect(rows).toHaveLength(3); // vm + key + record, never counted twice
    expect(rows.every((r) => r.class === "stale-record")).toBeTrue();
    expect(rows.every((r) => r.action === "teardown")).toBeTrue();
    expect(report.executed.teardown).toEqual([RUN_B]); // exactly ONE call
    expect(fleet.store.get(RUN_B).closedAt).toBeString();
  }, 20_000);

  // ─── 13. closed-record leaked key (D3) ─────────────────────────────────────

  test("closed-record leaked key: teardown routed, failure recorded teardown-skipped-closed-record, no reaper-owned revoke", async () => {
    const fleet = await seedFleet(dir, {
      keys: [{ runId: RUN_B, createdAt: iso(NOW.getTime() - OLD) }],
      records: [{ runId: RUN_B, ageMs: OLD, closed: true }],
    }, NOW);

    const report = await sweep(deps(fleet), { yes: true });

    const keyRow = report.rows.find((r) => r.kind === "key");
    expect(keyRow?.class).toBe("leaked-key");
    expect(keyRow?.action).toBe("teardown"); // routed through DF2.5, per the AC1 table
    expect(report.executed.teardown).toEqual([RUN_B]);
    // teardown on a closed record skips ALL steps ⇒ the sweep records the
    // failed attempt with operator remediation instead of revoking itself
    const failure = report.failures.find((f) => f.runId === RUN_B);
    expect(failure?.code).toBe("teardown-skipped-closed-record");
    expect(failure?.remediation).toBeString();
    expect(await keyLive(fleet, hashOf(fleet, keyName(RUN_B)))).toBeTrue();
    expect(report.executed.revoke).toEqual([]);
  });

  // ─── 14. dry-run predicts apply ────────────────────────────────────────────

  test("dry-run rows and executed predictions equal the apply sweep's, on the same fleet", async () => {
    await enterHostRepo();
    const fleet = await seedFleet(dir, e2eState(), NOW);

    const dry = await sweep(deps(fleet));
    const apply = await sweep(deps(fleet), { yes: true });

    const sig = (r: SweepRow): string => `${r.kind}:${r.id}:${r.class}:${r.action}:${r.runId ?? ""}`;
    expect(dry.rows.map(sig).sort()).toEqual(apply.rows.map(sig).sort());
    expect(dry.executed).toEqual(apply.executed);
  }, 20_000);

  // ─── 15. observability contract ────────────────────────────────────────────

  test("observability: header + one line per row; keyHashPrefix present, full hash never logged", async () => {
    const fleet = await seedFleet(dir, e2eState(), NOW);

    await sweep(deps(fleet));

    const header = logs.find((l) => "liveVms" in l && "liveKeys" in l && "records" in l);
    expect(header).toBeDefined();
    expect(header?.limitsSource).toBe("default");
    expect(header?.ceilings).toBeObject();
    const rowLines = logs.filter((l) => "class" in l && "action" in l);
    expect(rowLines.length).toBeGreaterThanOrEqual(9); // one per classified row
    expect(rowLines.every((l) => typeof l.durationMs === "number")).toBeTrue();
    const keyLine = rowLines.find((l) => l.keyHashPrefix !== undefined);
    expect(String(keyLine?.keyHashPrefix)).toHaveLength(12);
    // no key value and no FULL hash ever reaches a log line
    const stream = JSON.stringify(logs);
    expect(stream).not.toContain(hashOf(fleet, keyName(RUN_ORPHAN_KEY)));
    expect(stream).not.toContain(hashOf(fleet, keyName(RUN_A)));
  });

  // ─── 16. report file hygiene ───────────────────────────────────────────────

  test("report file: under reapDir in BOTH modes, dir 0700, file 0600, mode recorded in the body", async () => {
    const fleet = await seedFleet(dir, {}, NOW);

    const dry = await sweep(deps(fleet));

    expect(dry.reportFile.startsWith(join(dir, "reap"))).toBeTrue();
    expect(statSync(dry.reportFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "reap")).mode & 0o777).toBe(0o700);
    const body = JSON.parse(readFileSync(dry.reportFile, "utf8")) as SweepReport;
    expect(body.mode).toBe("dry-run");
    expect(body.requestId).toBe(dry.requestId);
    expect(body.timings).toBeObject();
  });

  // ─── 17. fixture self-validation ───────────────────────────────────────────

  test("fixture: invalid seeds throw with the offending item named", async () => {
    await expect(seedFleet(dir, { keys: [{}] }, NOW)).rejects.toThrow(/runId or a name/);
    await expect(seedFleet(dir, { records: [{ runId: "" }] }, NOW)).rejects.toThrow(/FleetRecord needs a runId/);
    await expect(seedFleet(dir, { vms: [{ name: RUN_A }, { name: RUN_A }] }, NOW)).rejects.toThrow(/duplicate/);
  });

  // ─── 18. self-review round — regression tests for the five findings ────────

  test("review 1: a failed revoke never persists the FULL key hash in the report file", async () => {
    const fleet = await seedFleet(dir, {
      keyApiOpts: { deleteStatus: 500 }, // DELETE 5xx ⇒ CredentialLifecycleError embeds the full hash
      keys: [{ runId: RUN_ORPHAN_KEY, createdAt: iso(NOW.getTime() - OLD) }],
    }, NOW);
    const full = hashOf(fleet, keyName(RUN_ORPHAN_KEY));

    const report = await sweep(deps(fleet), { yes: true });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.code).toBe("revoke-failed");
    expect(report.failures[0]?.keyHashPrefix).toBe(full.slice(0, 12)); // counter identity
    // the report FILE (message, remediation, failures, rows — everything)
    // carries the 12-hex prefix, never the 64-hex hash
    const text = readFileSync(report.reportFile, "utf8");
    expect(text).not.toContain(full);
    expect(text).toContain(full.slice(0, 12));
    expect(await keyLive(fleet, full)).toBeTrue(); // the failed revoke left it live
  });

  test("review 2: after 3 failed applies, a DRY-RUN also reports reap-blocked — no lying prediction", async () => {
    await enterHostRepo();
    const fleet = await seedFleet(dir, {
      keyApiOpts: { deleteStatus: 500 },
      vms: [{ name: RUN_B }],
      keys: [{ runId: RUN_B, createdAt: iso(NOW.getTime() - OLD) }],
      records: [{ runId: RUN_B, ageMs: OLD }],
    }, NOW);
    for (let i = 0; i < 3; i++) await sweep(deps(fleet), { yes: true });

    const dry = await sweep(deps(fleet));

    expect(dry.executed.teardown).toEqual([]); // --yes would issue ZERO calls
    const rows = dry.rows.filter((r) => r.runId === RUN_B);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.action === "reap-blocked")).toBeTrue();
    expect(dry.rows.some((r) => r.action === "teardown")).toBeFalse();
    expect(existsSync(join(fleet.boxesDir, RUN_B))).toBeTrue(); // dry-run deleted nothing
  }, 20_000);

  test("review 3: 3 failed destroys ⇒ the 4th sweep issues ZERO destroy calls, row reap-blocked, still in liveVms", async () => {
    const fleet = await seedFleet(dir, { vms: [{ name: VM_ORPHAN }] }, NOW);
    let destroyCalls = 0;
    const flaky = Object.create(fleet.driver) as FakeDriver;
    flaky.destroy = (_vm: string) => {
      destroyCalls++;
      return Promise.reject(new Error("rm: drive busy"));
    };
    const d = deps(fleet, { driver: flaky });
    for (let i = 1; i <= 3; i++) {
      const r = await sweep(d, { yes: true });
      expect(r.executed.destroy).toEqual([VM_ORPHAN]); // the call was issued…
      expect(r.failures[0]?.vm).toBe(VM_ORPHAN); // …and its failure carries the vm identity
    }
    expect(destroyCalls).toBe(3);

    const fourth = await sweep(d, { yes: true });

    expect(destroyCalls).toBe(3); // ZERO further destroy calls
    expect(fourth.executed.destroy).toEqual([]);
    const row = fourth.rows.find((r) => r.id === VM_ORPHAN);
    expect(row?.action).toBe("reap-blocked");
    expect(row?.failure?.code).toBe("destroy-failed");
    expect(fourth.liveVms).toBe(1); // escalated, not silently dropped
    expect(existsSync(join(fleet.boxesDir, VM_ORPHAN))).toBeTrue();
  });

  test("review 4 (INV-1): a box flipped to untagged between classification and destroy is NOT destroyed", async () => {
    const fleet = await seedFleet(dir, { vms: [{ name: VM_ORPHAN }] }, NOW);
    // The wrapper serves the TAGGED fleet list to the sweep's classification
    // pass (list() with no name) and an UNTAGGED single-box answer to the
    // pre-destroy ownership re-check (list(name)) — provenance changed in between.
    const flipped = Object.create(fleet.driver) as FakeDriver;
    flipped.list = (name?: string) =>
      name === undefined
        ? fleet.driver.list()
        : fleet.driver.list(name).then((found) => (found[0] === undefined ? [] : [{ ...found[0], tag: undefined }]));

    const report = await sweep(deps(fleet, { driver: flipped }), { yes: true });

    expect(report.executed.destroy).toEqual([]);
    const failure = report.failures.find((f) => f.code === "ownership-recheck-refused");
    expect(failure?.vm).toBe(VM_ORPHAN);
    expect(failure?.remediation).toBeString();
    expect(existsSync(join(fleet.boxesDir, VM_ORPHAN))).toBeTrue();
    expect((await fleet.driver.list()).map((v) => v.name)).toEqual([VM_ORPHAN]);
  });

  test("review 5: two record-less keys sharing a 12-hex prefix are EACH revoked exactly once", async () => {
    const shared = "abcdef012345";
    const hash1 = `${shared}${"1".repeat(52)}`;
    const hash2 = `${shared}${"2".repeat(52)}`;
    const fleet = await seedFleet(dir, {
      keys: [
        { runId: RUN_ORPHAN_KEY, hash: hash1, createdAt: iso(NOW.getTime() - OLD) },
        { runId: RUN_MINT, hash: hash2, createdAt: iso(NOW.getTime() - OLD) },
      ],
    }, NOW);

    const report = await sweep(deps(fleet), { yes: true });

    expect(report.rows.filter((r) => r.class === "leaked-key")).toHaveLength(2);
    expect(report.executed.revoke).toEqual([shared, shared]); // two units, prefix-level identity
    expect(await keyLive(fleet, hash1)).toBeFalse();
    expect(await keyLive(fleet, hash2)).toBeFalse();
    const deletes = fleet.keyApi.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(2); // exactly once each — no collapsed double-revoke
    expect(new Set(deletes.map((r) => r.path)).size).toBe(2);
  });

  // ─── 19. E2E DEMO — scripts/sandbox-reap.ts (MANDATORY DoD) ────────────────

  test("E2E DEMO (DoD, MANDATORY): dry-run then --yes — report files, final fleet, checkHeadroom(2) allowed", async () => {
    // The demo runs the SCRIPT entry (run) in-process against the seeded
    // fleet: cwd is a throwaway git repo (teardown's host side) whose
    // .sandbox/ holds the reap reports. deps are injected as run()'s optional
    // third argument — FakeKeyApi state cannot cross a process boundary, and
    // the E2E slice mandates 4 seeded keys (contract note: design §6 lists
    // run(argv, out); the optional deps param is the test seam).
    const sandbox = mkdtempSync(join(tmpdir(), "qds-df26-demo-"));
    roots.push(sandbox);
    await runLocal(["git", "init", "-q", "-b", "main", sandbox]);
    const fleet = await seedFleet(join(sandbox, "fleet"), e2eState(), NOW);
    process.chdir(sandbox);
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    const demoDeps: Partial<SweepDeps> = {
      driver: fleet.driver,
      store: fleet.store,
      keyApi: fleet.keyApi,
      limits: LIMITS,
      reapDir: join(sandbox, ".sandbox", "reap"),
      // The fleet is dated relative to the fixed NOW above; without the
      // injected clock the script would sweep it with the wall clock, and any
      // run after 15:00Z would re-classify every "young" seed as stale (D6).
      now: () => NOW,
    };

    try {
      const dryExit = await runReap([], out, demoDeps);
      expect(dryExit).toBe(0); // dry-run always exits 0
      expect(readdirSync(join(sandbox, ".sandbox", "reap"))).toHaveLength(1);
      // the default mode deletes nothing
      expect(await fleet.driver.list()).toHaveLength(3);
      for (const id of [RUN_A, RUN_B]) expect(fleet.store.get(id).closedAt).toBeUndefined();

      const yesExit = await runReap(["--yes"], out, demoDeps);
      expect(yesExit).toBe(0); // apply with zero failures

      // final fleet: only in-flight run A's VM and the operator's key remain
      expect((await fleet.driver.list()).map((v) => v.name)).toEqual([RUN_A]);
      const liveNames = (await fleet.keyApi.listAllKeys(20)).entries.map((k) => k.name).sort();
      expect(liveNames).toEqual([keyName(RUN_A), OPERATOR_KEY].sort());

      // the --yes report shows one teardown, one destroy, one revoke
      const reports = readdirSync(join(sandbox, ".sandbox", "reap")).map((f) =>
        JSON.parse(readFileSync(join(sandbox, ".sandbox", "reap", f), "utf8")) as SweepReport,
      );
      expect(reports).toHaveLength(2);
      const applied = reports.find((r) => r.mode === "apply");
      expect(applied?.executed.teardown).toEqual([RUN_B]);
      expect(applied?.executed.destroy).toEqual([VM_ORPHAN]);
      expect(applied?.executed.revoke).toHaveLength(1);

      const hr = await checkHeadroom(fleet.driver, 2, LIMITS);
      expect(hr.allowed).toBeTrue();
      expect(hr.liveVms).toBe(1);
      // the summary and report-file lines reached stdout — exact counts and
      // mode prefixes, not just any digit (a bare "1" matches nearly
      // anything); dry-run lists the same PREDICTIONS --yes executes
      const stdout = lines.join("");
      expect(stdout).toContain("dry-run: teardown 1, destroy 1, revoke 1");
      expect(stdout).toContain("apply: teardown 1, destroy 1, revoke 1");
      expect(stdout).toContain("report: ");
    } finally {
      process.chdir(prevCwd);
    }
  }, 20_000);

  // ─── 20. review round 2 — wedged providers, budget, late record claim ──────

  test("review 6: a wedged pre-destroy recheck times out — failure recorded with the unit's identity, box alive", async () => {
    const fleet = await seedFleet(dir, { vms: [{ name: VM_ORPHAN }] }, NOW);
    // classification list() answers; the single-box recheck never settles
    const wedged = Object.create(fleet.driver) as FakeDriver;
    wedged.list = (name?: string) => (name === undefined ? fleet.driver.list() : new Promise(() => {}));

    const report = await sweep(deps(fleet, { driver: wedged, actionTimeoutMs: 25 }), { yes: true });

    expect(report.executed.destroy).toEqual([]);
    const failure = report.failures.find((f) => f.vm === VM_ORPHAN);
    expect(failure?.code).toBe("destroy-failed");
    expect(failure?.message).toContain("timed out");
    expect(failure?.message).toContain(VM_ORPHAN);
    expect(existsSync(join(fleet.boxesDir, VM_ORPHAN))).toBeTrue(); // never destroyed
  });

  test("review 7: reap-phase budget expiry stops starting units — rows skipped, not failed", async () => {
    const fleet = await seedFleet(dir, {
      vms: [
        { name: "bud25-20260820-000001" },
        { name: "bud25-20260820-000002" },
      ],
    }, NOW);
    let destroys = 0;
    const slow = Object.create(fleet.driver) as FakeDriver;
    slow.destroy = (_vm: string) => {
      destroys++;
      return new Promise<void>(() => {}); // wedged: runs to the action timeout
    };

    const report = await sweep(deps(fleet, { driver: slow, actionTimeoutMs: 30, reapBudgetMs: 5 }), { yes: true });

    // unit 1 started (its destroy was issued and timed out — a failure with
    // identity); unit 2 was never started — skipped like a cap-overflow row
    expect(destroys).toBe(1);
    expect(report.failures.find((f) => f.vm === "bud25-20260820-000001")?.message).toContain("timed out");
    const row2 = report.rows.find((r) => r.id === "bud25-20260820-000002");
    expect(row2?.action).toBe("skipped");
    expect(report.failures.some((f) => f.vm === "bud25-20260820-000002")).toBeFalse();
    expect(await fleet.driver.list()).toHaveLength(2); // both boxes survive
  });

  test("review 8 (AC6): a record landing between classification and destroy refuses the destroy", async () => {
    const fleet = await seedFleet(dir, { vms: [{ name: VM_ORPHAN }] }, NOW);
    // classification sees the plain fleet; the single-box recheck first LANDS
    // an open record (the createRun race window), then answers
    const claimed = Object.create(fleet.driver) as FakeDriver;
    claimed.list = async (name?: string) => {
      if (name === undefined) return fleet.driver.list();
      fleet.store.create(name); // an open record now claims the box
      return fleet.driver.list(name);
    };

    const report = await sweep(deps(fleet, { driver: claimed }), { yes: true });

    expect(report.executed.destroy).toEqual([]);
    const failure = report.failures.find((f) => f.code === "record-claim-refused");
    expect(failure?.vm).toBe(VM_ORPHAN);
    expect(failure?.remediation).toBeString();
    expect(existsSync(join(fleet.boxesDir, VM_ORPHAN))).toBeTrue();
    expect(fleet.store.get(VM_ORPHAN).closedAt).toBeUndefined(); // the claim survives
  });

  test("review 9: a record going UNREADABLE between classification and destroy refuses the destroy", async () => {
    const fleet = await seedFleet(dir, { vms: [{ name: VM_ORPHAN }] }, NOW);
    // classification sees the plain fleet (record-less owned VM ⇒ destroy);
    // the single-box recheck first LANDS a record claiming the box, then
    // truncates it mid-write — malformed JSON, so readRecord throws with NO
    // errno. The recheck must refuse: an unreadable record is not an absent
    // one, and the fallback to the classification-time verdict would destroy
    // a live run's VM out from under a record the sweep merely failed to read.
    const corrupted = Object.create(fleet.driver) as FakeDriver;
    corrupted.list = async (name?: string) => {
      if (name === undefined) return fleet.driver.list();
      fleet.store.create(name); // the claim lands…
      writeFileSync(join(fleet.runsDir, `${name}.json`), "{ not json"); // …then corrupts
      return fleet.driver.list(name);
    };

    const report = await sweep(deps(fleet, { driver: corrupted }), { yes: true });

    expect(report.executed.destroy).toEqual([]);
    const failure = report.failures.find((f) => f.code === "record-recheck-failed");
    expect(failure?.vm).toBe(VM_ORPHAN);
    expect(failure?.message).toContain(VM_ORPHAN);
    expect(failure?.message).toContain("not destroyed");
    expect(failure?.remediation).toBeString();
    expect(existsSync(join(fleet.boxesDir, VM_ORPHAN))).toBeTrue(); // the box survives
  });

  test("quota-limits load failure ⇒ SweepError quota-limits-error, before any enumeration or deletion", async () => {
    const fleet = await seedFleet(dir, e2eState(), NOW);
    // cwd pins the default .sandbox/quota-limits.json the sweep falls back to
    // when deps.limits is absent; the malformed body must refuse the sweep
    const sandbox = mkdtempSync(join(tmpdir(), "qds-df26-qlim-"));
    roots.push(sandbox);
    process.chdir(sandbox);
    mkdirSync(join(sandbox, ".sandbox"), { recursive: true });
    writeFileSync(join(sandbox, ".sandbox", "quota-limits.json"), "{ not json\n");

    let listCalls = 0;
    const counting = Object.create(fleet.driver) as FakeDriver;
    counting.list = (name?: string) => {
      listCalls++;
      return fleet.driver.list(name);
    };

    let err: unknown;
    try {
      await sweep(deps(fleet, { driver: counting, limits: undefined }), { yes: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SweepError);
    const se = err as SweepError;
    expect(se.code).toBe("quota-limits-error");
    expect(se.message).toContain("quota-limits.json");
    expect(se.remediation).toContain("maxVms"); // the copy-pasteable limits body
    // the refusal precedes enumeration — driver.list() MUST NOT be called
    expect(listCalls).toBe(0);
    // the fleet is untouched — the refusal precedes enumeration and reaping
    expect(await fleet.driver.list()).toHaveLength(3);
    expect((await fleet.keyApi.listAllKeys(20)).entries).toHaveLength(4);
  });

  test("review 10: unparseable key createdAt (malformed ISO timestamp) ⇒ key-age-unavailable, reported, key stays live under --yes", async () => {
    const fleet = await seedFleet(dir, {
      keys: [{ runId: RUN_ORPHAN_KEY, createdAt: iso(NOW.getTime() - OLD) }],
    }, NOW);
    // Corrupt the age directly — the fixture's backdateKey rightly rejects garbage,
    // so mutate the entry after seeding.
    fleet.keyApi.keys.find((k) => k.name === keyName(RUN_ORPHAN_KEY))!.createdAt = "not-a-timestamp";
    const orphanHash = hashOf(fleet, keyName(RUN_ORPHAN_KEY));

    const report = await sweep(deps(fleet), { yes: true });

    const row = report.rows.find((r) => r.id === keyName(RUN_ORPHAN_KEY));
    expect(row?.class).toBe("key-age-unavailable");
    expect(row?.action).toBe("report");
    // revoke executed list is empty — the key was never revoked
    expect(report.executed.revoke).toEqual([]);
    expect(await keyLive(fleet, orphanHash)).toBeTrue(); // key still live
  });

  test("review 11: a teardown slower than the ACTION budget still completes — the teardown unit has its own ceiling", async () => {
    await enterHostRepo();
    const fleet = await seedFleet(dir, {
      vms: [{ name: RUN_B }],
      keys: [{ runId: RUN_B, createdAt: iso(NOW.getTime() - OLD) }],
      records: [{ runId: RUN_B, ageMs: OLD }],
    }, NOW);
    // The artifacts leg is SLOW, not wedged: 150 ms of in-box tar work before
    // the real result. With one shared budget this is the immortal-box bug —
    // the whole teardown was abandoned at the (25 ms here, 60 s in production)
    // single-op ceiling BEFORE destroy, and every later sweep re-abandoned it.
    // The teardown unit's separate budget must let it run to completion.
    const slow = Object.create(fleet.driver) as FakeDriver;
    slow.exec = async (vm: string, argv: string[], stdin?: string) => {
      if (stdin?.includes("harvest-artifacts.tgz")) await new Promise((r) => setTimeout(r, 150));
      return fleet.driver.exec(vm, argv, stdin);
    };

    const report = await sweep(deps(fleet, { driver: slow, actionTimeoutMs: 25 }), { yes: true });

    expect(report.executed.teardown).toEqual([RUN_B]);
    expect(report.failures).toHaveLength(0); // under a shared budget this is the abandonment failure
    expect(fleet.store.get(RUN_B).closedAt).toBeString();
    expect(existsSync(join(fleet.boxesDir, RUN_B))).toBeFalse();
  }, 20_000);

  test("review 12: a WEDGED teardown leg times out on its OWN budget — failure recorded, box alive, destroy ops unaffected", async () => {
    await enterHostRepo();
    const fleet = await seedFleet(dir, {
      vms: [{ name: RUN_B }, { name: VM_ORPHAN }],
      keys: [{ runId: RUN_B, createdAt: iso(NOW.getTime() - OLD) }],
      records: [{ runId: RUN_B, ageMs: OLD }],
    }, NOW);
    // The artifacts exec never settles (a stalled box ssh session): the
    // teardown unit must land in `failures` with its runId identity and a
    // named timeout, leaving the box alive and the record open for the next
    // sweep — while the destroy unit in the SAME sweep still runs under the
    // single-op budget, proving the two ceilings are actually separate.
    const wedged = Object.create(fleet.driver) as FakeDriver;
    wedged.exec = (vm: string, _argv: string[], stdin?: string) =>
      stdin?.includes("harvest-artifacts.tgz")
        ? new Promise<ExecResult>(() => {}) // never settles; no spawn, so nothing leaks
        : fleet.driver.exec(vm, _argv, stdin);

    const report = await sweep(deps(fleet, { driver: wedged, teardownTimeoutMs: 25 }), { yes: true });

    expect(report.executed.teardown).toEqual([RUN_B]); // the attempt was issued…
    const failure = report.failures.find((f) => f.runId === RUN_B);
    expect(failure?.code).toBe("teardown-failed");
    expect(failure?.message).toContain("timed out");
    expect(failure?.message).toContain(RUN_B);
    // …and abandoned BEFORE destroy: the box survives, record stays open.
    expect(existsSync(join(fleet.boxesDir, RUN_B))).toBeTrue();
    expect(fleet.store.get(RUN_B).closedAt).toBeUndefined();
    // The destroy unit was neither skipped nor starved by the wedged teardown.
    expect(report.executed.destroy).toEqual([VM_ORPHAN]);
    expect(existsSync(join(fleet.boxesDir, VM_ORPHAN))).toBeFalse();
    expect(report.failures.some((f) => f.vm === VM_ORPHAN)).toBeFalse();
  }, 20_000);

  // F043: every sweep writes one report and nothing ever deleted one, so an
  // operator who sweeps hourly grows the reap dir forever while only the newest
  // REAP_HISTORY_MAX_REPORTS are ever READ — countReapBlocked pays a readdir +
  // statSync over the whole history for 200 files of evidence.
  test("F043: a successful report write prunes the reap dir to REAP_HISTORY_MAX_REPORTS", async () => {
    const fleet = await seedFleet(dir, e2eState(), NOW);
    const reapDir = join(dir, "reap");
    mkdirSync(reapDir, { recursive: true, mode: 0o700 });
    // Pre-seed one over the ceiling with parseable dry-run reports, aged so the
    // mtime ordering is unambiguous (the newest survivors are deterministic).
    const seeded = REAP_HISTORY_MAX_REPORTS + 5;
    for (let i = 0; i < seeded; i++) {
      const f = join(reapDir, `seed-${String(i).padStart(4, "0")}.json`);
      writeFileSync(f, `${JSON.stringify({ mode: "dry-run", failures: [], executed: {} })}\n`, { mode: 0o600 });
      utimesSync(f, new Date(NOW.getTime() - (seeded - i) * 60_000), new Date(NOW.getTime() - (seeded - i) * 60_000));
    }
    expect(readdirSync(reapDir)).toHaveLength(seeded);

    const report = await sweep(deps(fleet));

    const after = readdirSync(reapDir);
    expect(after).toHaveLength(REAP_HISTORY_MAX_REPORTS);
    // The report this sweep just wrote is never the one pruned.
    expect(existsSync(report.reportFile)).toBeTrue();
    // The OLDEST seeds went, not an arbitrary slice.
    expect(after).not.toContain("seed-0000.json");
    expect(after).toContain(`seed-${String(seeded - 1).padStart(4, "0")}.json`);
  });
});
