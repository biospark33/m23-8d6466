/**
 * DF3.1 Agent C: verbs + status unit tests.
 *
 * MODULE 1 (verbs.ts):
 * - listVerbs() returns exactly 4 entries with exact flag/exit-code shapes
 * - renderHelp() renders from the registry it is HANDED (proved with a
 *   synthetic registry — the real verb names must not leak through)
 * - the declared exitCodes are bound to the codes the CLI can actually return
 *
 * MODULE 2 (status.ts):
 * - join logic across every state (live, boxMissing, boxUnknown, closed,
 *   orphan), including mixed fleets, ownership tags and the INV-1 crash window
 * - the list timeout: default, refusal of a non-positive one, timer cleanup
 * - statusRun validation (canonical RUN_ID_RE/RUN_ID_MAX) and ENOENT handling
 *
 * Fixtures provision through `provisionAdmittedRun` — the production sequence
 * that names the box after the run id and writes `vmName` back — so no test
 * recomputes a box-naming formula the factory does not use.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listVerbs, renderHelp, type VerbEntry, type VerbFlag } from "../../src/fleet/verbs.ts";
import { FleetError, statusAll, statusRun, type StatusDeps, type StatusRow } from "../../src/fleet/status.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { provisionAdmittedRun, SBX_OWNERSHIP_TAG, type ProviderVm } from "../../src/providers/driver.ts";
import { RUN_ID_MAX, RunRecordStore, type RunRecord, type RunRecordPatch } from "../../src/providers/run-record.ts";
import { run, type FleetDeps } from "../../scripts/fleet.ts";

/** Await a refusal and hand back the typed error — never a bare "something threw". */
async function refusal(
  work: Promise<unknown>,
  exitCode: FleetError["exitCode"],
  code: string,
): Promise<FleetError> {
  let caught: unknown;
  let settled = false;
  try {
    await work;
    settled = true;
  } catch (e) {
    caught = e;
  }
  expect(settled).toBe(false);
  expect(caught).toBeInstanceOf(FleetError);
  const err = caught as FleetError;
  expect(err.exitCode).toBe(exitCode);
  expect(err.code).toBe(code);
  return err;
}

/**
 * A driver whose `list` reports the boxes `driver` really has, under a tag of
 * the test's choosing (`null` = untagged, as exedev's `ls --json` reports).
 * The provisioning stays real; only the ownership evidence is varied.
 */
function retagged(driver: FakeDriver, tag: string | null): StatusDeps["driver"] {
  return {
    list: async (name?: string): Promise<ProviderVm[]> =>
      (await driver.list(name)).map(({ tag: _drop, ...vm }) => (tag === null ? vm : { ...vm, tag })),
  };
}

describe("verbs.ts (registry)", () => {
  test("listVerbs returns exactly 4 entries", () => {
    const verbs: VerbEntry[] = listVerbs();
    expect(verbs).toHaveLength(4);
    const verbNames = verbs.map((v) => v.verb);
    expect(verbNames).toContain("dispatch");
    expect(verbNames).toContain("status");
    expect(verbNames).toContain("harvest");
    expect(verbNames).toContain("teardown");
  });

  test("each verb has exact shape with no extra keys", () => {
    for (const v of listVerbs()) {
      // Exact keys: verb, summary, flags, exitCodes
      const keys = Object.keys(v).sort();
      expect(keys).toEqual(["exitCodes", "flags", "summary", "verb"]);

      // Verb is a non-empty string
      expect(typeof v.verb).toBe("string");
      expect(v.verb.length).toBeGreaterThan(0);

      // Summary is a non-empty string
      expect(typeof v.summary).toBe("string");
      expect(v.summary.length).toBeGreaterThan(0);

      // Flags is an array
      expect(Array.isArray(v.flags)).toBe(true);

      // Each flag has exact shape: {name, required, valueType}
      for (const flag of v.flags) {
        const flagKeys = Object.keys(flag).sort();
        expect(flagKeys).toEqual(["name", "required", "valueType"]);
        expect(typeof flag.name).toBe("string");
        expect(typeof flag.required).toBe("boolean");
        expect(["string", "path", "boolean"]).toContain(flag.valueType);
      }

      // Exit codes is an array of numbers
      expect(Array.isArray(v.exitCodes)).toBe(true);
      for (const code of v.exitCodes) {
        expect(typeof code).toBe("number");
        // Every exitCode within 0-5
        expect(code).toBeGreaterThanOrEqual(0);
        expect(code).toBeLessThanOrEqual(5);
      }
      // Every verb takes --help; the CLI advertises `fleet <verb> --help`.
      expect(v.flags.some((f) => f.name === "--help" && f.valueType === "boolean")).toBe(true);
    }
  });

  /**
   * The WHOLE flag table per verb, not a length plus a name probe: `--dir`
   * declared as `{required: true}` or `{valueType: "boolean"}` is a different
   * grammar, and the CLI validates argv against exactly these entries.
   */
  const EXPECTED_FLAGS: Record<string, VerbFlag[]> = {
    dispatch: [
      { name: "--brief", required: false, valueType: "path" },
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: false, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--port", required: false, valueType: "string" },
    ],
    status: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: false, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
    ],
    harvest: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: false, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
    ],
    teardown: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: false, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--no-harvest", required: false, valueType: "boolean" },
    ],
  };

  const EXPECTED_EXIT_CODES: Record<string, number[]> = {
    // 3 = setup gate, 5 = refused before provisioning; dispatch alone can reach them.
    dispatch: [0, 1, 2, 3, 5],
    // 2 is real for all three: a malformed id, an extra positional and a flag
    // the verb does not take are all refused as usage.
    status: [0, 1, 2, 4],
    harvest: [0, 1, 2, 4],
    teardown: [0, 1, 2, 4],
  };

  for (const verb of ["dispatch", "status", "harvest", "teardown"]) {
    test(`${verb} verb declares its exact flag table and exit codes`, () => {
      const entry = listVerbs().find((v) => v.verb === verb);
      expect(entry).toBeDefined();
      const flags: VerbFlag[] = [...entry!.flags].sort((a, b) => a.name.localeCompare(b.name));
      expect(flags).toEqual(EXPECTED_FLAGS[verb]!);
      expect(entry!.exitCodes).toEqual(EXPECTED_EXIT_CODES[verb]!);
    });
  }

  test("verbs are unique", () => {
    const verbNames = listVerbs().map((v) => v.verb);
    expect(new Set(verbNames).size).toBe(verbNames.length);
  });

  test("renderHelp renders the registry it is HANDED, not a hard-coded list", () => {
    // The doc contract is "the ONLY place --help content lives". A body that
    // ignores `registry` and prints the four real verbs passes any assertion
    // made against the real registry — so assert against a synthetic one.
    const synthetic: VerbEntry[] = [
      {
        verb: "syntheticverb",
        summary: "a verb that exists only in this test",
        flags: [{ name: "--synthetic", required: true, valueType: "path" }],
        exitCodes: [7],
      },
    ];
    const help = renderHelp(synthetic);
    expect(help).toContain("syntheticverb");
    expect(help).toContain("a verb that exists only in this test");
    expect(help).toContain("--synthetic");
    expect(help).toContain("path");
    expect(help).toContain("required");
    expect(help).toContain("7");
    for (const real of ["dispatch", "status", "harvest", "teardown"]) {
      expect(help).not.toContain(real);
    }
  });

  test("renderHelp generates usage from the real registry", () => {
    const registry: VerbEntry[] = listVerbs();
    const help = renderHelp(registry);
    expect(typeof help).toBe("string");
    expect(help.length).toBeGreaterThan(0);

    for (const entry of registry) {
      expect(help).toContain(entry.verb);
      expect(help).toContain(entry.summary);
      for (const flag of entry.flags) expect(help).toContain(flag.name);
      expect(help).toContain(entry.exitCodes.join(", "));
    }
    expect(help).toMatch(/Usage:|usage:|FLAGS/i);
  });
});

/**
 * The registry is a CONTRACT (DF3.5's skill-contract test reads it), so the
 * declared exit codes must be bound to the ones the CLI can actually return —
 * by a test, not by hope. `[0,1,4]` declared against a demonstrable exit 2 is
 * exactly how the last divergence shipped green.
 */
describe("verbs.ts ↔ scripts/fleet.ts exit codes", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  const sink = (): void => {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-verb-exit-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Invocations whose refusal (or success) each verb can really produce. */
  const PROBES: Record<string, string[][]> = {
    dispatch: [
      ["dispatch"], // the injected brief is not JSON
      ["dispatch", "stray-positional"],
      ["dispatch", "--port", "0"],
      ["dispatch", "--no-harvest"], // a flag the registry does not give dispatch
    ],
    status: [
      ["status"], // empty fleet is a state, not an error
      ["status", "no-such-run"],
      ["status", "INVALID_ID"],
      ["status", "one", "two"],
      ["status", "--brief", "somewhere"],
    ],
    harvest: [
      ["harvest"], // missing <run-id>
      ["harvest", "no-such-run"],
      ["harvest", "INVALID_ID"],
      ["harvest", "--no-harvest", "some-run"],
    ],
    teardown: [
      ["teardown"],
      ["teardown", "no-such-run"],
      ["teardown", "INVALID_ID"],
      ["teardown", "one", "two"],
    ],
  };

  /**
   * What each probe above really returns. Pinned exactly, so the ⊆ check below
   * can never be satisfied vacuously by probes that stopped reaching the verb.
   */
  const EXPECTED_CODES: Record<string, number[]> = {
    dispatch: [2, 2, 2, 2],
    status: [0, 4, 2, 2, 2],
    harvest: [2, 4, 2, 2],
    teardown: [2, 4, 2, 2],
  };

  test("every exit code the CLI can return for a verb is declared in that verb's exitCodes", async () => {
    const deps: Partial<FleetDeps> = { driver, store, readBrief: async () => "{not json" };
    for (const entry of listVerbs()) {
      const observed: number[] = [];
      for (const argv of PROBES[entry.verb]!) {
        observed.push(await run(argv, sink, deps, sink));
      }
      expect(observed).toEqual(EXPECTED_CODES[entry.verb]!);
      const undeclared = observed
        .map((code, i) => ({ code, argv: PROBES[entry.verb]![i]!.join(" ") }))
        .filter((o) => !entry.exitCodes.includes(o.code))
        .map((o) => `${o.argv} → exit ${o.code}, not in [${entry.exitCodes.join(",")}]`);
      expect(undeclared).toEqual([]);
    }
  });

  test("status/harvest/teardown demonstrably return 2 and 4", async () => {
    const deps: Partial<FleetDeps> = { driver, store };
    for (const verb of ["status", "harvest", "teardown"]) {
      expect(await run([verb, "INVALID_ID"], sink, deps, sink)).toBe(2);
      expect(await run([verb, "no-such-run"], sink, deps, sink)).toBe(4);
    }
  });
});

describe("status.ts (statusAll join logic)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    // Store and driver get their OWN directories: sharing one passes today
    // only because record filenames end in `.json` and box names do not.
    dir = mkdtempSync(join(tmpdir(), "qds-status-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The REAL provisioning sequence: record → box named after the run id →
   * `vmName` written back. Nothing here re-derives a box name.
   */
  async function provision(runId: string, patch?: RunRecordPatch, port?: number): Promise<RunRecord> {
    const { record } = await provisionAdmittedRun(driver, store, {
      runId,
      ...(port === undefined ? {} : { port }),
    });
    return patch === undefined ? record : store.set(runId, patch);
  }

  test("closedAt → state 'closed', and the driver is still consulted", async () => {
    const runId = "test-closed-run";
    const rec = await provision(runId);
    store.close(runId);

    const listSpy = mock((name?: string) => driver.list(name));
    const rows: StatusRow[] = await statusAll({ driver: { list: listSpy }, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("closed");
    expect(rows[0]!.runId).toBe(runId);
    expect(rows[0]!.closedAt).toBeDefined();
    // A closed record over a live box is a box that is still billing.
    expect(rows[0]!.boxAlive).toBe(true);
    expect(rows[0]!.vmName).toBe(rec.vmName);
    expect(listSpy).toHaveBeenCalled();
  });

  test("closed + destroyed box → 'closed' with no boxAlive", async () => {
    const runId = "test-closed-gone";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("closed");
    expect(rows[0]!).not.toHaveProperty("boxAlive");
  });

  test("open + vmName unset + no box → boxMissing", async () => {
    const runId = "test-no-vm";
    store.create(runId); // record only: no box was ever created
    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxMissing");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("open + listOk + vm in set → live", async () => {
    const runId = "test-live-run";
    const rec = await provision(runId);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    expect(rows[0]!.runId).toBe(runId);
    expect(rows[0]!.vmName).toBe(rec.vmName);
  });

  test("open + listOk + vm NOT in set → boxMissing", async () => {
    const runId = "test-missing-box";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxMissing");
    expect(rows[0]!.runId).toBe(runId);
    expect(rows[0]!.vmName).toBe(rec.vmName);
  });

  test("open + list hangs past listTimeoutMs → boxUnknown", async () => {
    const runId = "test-unknown";
    await provision(runId);

    // A promise that never settles — no test-owned timer to leak.
    const hangingDriver = { list: () => new Promise<ProviderVm[]>(() => {}) };
    const rows = await statusAll({ driver: hangingDriver, store, listTimeoutMs: 5 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxUnknown");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("open + list throws → boxUnknown", async () => {
    const runId = "test-throw";
    await provision(runId);

    const throwingDriver = {
      list: async (): Promise<ProviderVm[]> => {
        throw new Error("driver list failed");
      },
    };
    const rows = await statusAll({ driver: throwingDriver, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxUnknown");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("non-array driver reply degrades to boxUnknown, never a TypeError", async () => {
    const runId = "test-nonarray";
    await provision(runId);

    const nonArrayDriver = { list: async (): Promise<ProviderVm[]> => ({}) as unknown as ProviderVm[] };
    const rows = await statusAll({ driver: nonArrayDriver, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxUnknown");
  });

  test("store.list() failure surfaces as a typed FleetError, not a bare throw", async () => {
    const brokenStore = {
      list: (): RunRecord[] => {
        throw new Error("malformed run record beta.json: unknown key: nope");
      },
    } as unknown as RunRecordStore;

    const err = await refusal(
      statusAll({ driver, store: brokenStore, listTimeoutMs: 1000 }),
      1,
      "record-store-unreadable",
    );
    expect(err.message).toContain("malformed run record beta.json");
    expect(err.remediation).toContain("fleet status");
  });

  test("newest-first by createdAt, numeric across mixed ISO shapes, runId breaking ties", async () => {
    // Fed in an order `store.list()` never produces, so deleting the sort fails.
    // Neither lexicographic order nor runId order is the expected answer:
    //   "…T01:00:00+01:00" sorts LAST lexicographically-desc but ties at t=0,
    //   "…T00:00:00.500Z" sorts BEFORE "…T00:00:00Z" as text yet is 500ms later.
    const rows2: RunRecord[] = [
      { runId: "b-oldest", createdAt: "2026-01-01T00:00:00Z" },
      { runId: "a-tied", createdAt: "2026-01-01T01:00:00+01:00" },
      { runId: "c-newest", createdAt: "2026-01-01T00:00:00.500Z" },
    ];
    const stubStore = { list: () => rows2 } as unknown as RunRecordStore;

    const rows = await statusAll({ driver, store: stubStore, listTimeoutMs: 1000 });
    expect(rows.map((r) => r.runId)).toEqual(["c-newest", "a-tied", "b-oldest"]);
  });

  test("empty fleet → empty array", async () => {
    expect(await statusAll({ driver, store, listTimeoutMs: 1000 })).toHaveLength(0);
  });

  test("row carries the record's optional fields", async () => {
    const runId = "test-optional";
    // The real expose path writes httpsUrl onto the record.
    const rec = await provision(runId, undefined, 8080);
    expect(rec.httpsUrl).toBeDefined();

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vmName).toBe(rec.vmName);
    expect(rows[0]!.httpsUrl).toBe(rec.httpsUrl);
  });

  test("spend/limit/requestId ride EVERY record-backed state, not just live", async () => {
    const costs: RunRecordPatch = {
      spendMicroUsd: 123456,
      limitMicroUsd: 500000,
      requestId: "req-costs",
    };
    // live
    await provision("cost-live", costs);
    // boxMissing
    const missing = await provision("cost-missing", costs);
    await driver.destroy(missing.vmName!);
    // closed (core fields must be written before close)
    await provision("cost-closed", costs);
    store.close("cost-closed");

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    const byId = new Map(rows.map((r) => [r.runId, r]));
    expect(byId.get("cost-live")!.state).toBe("live");
    expect(byId.get("cost-missing")!.state).toBe("boxMissing");
    expect(byId.get("cost-closed")!.state).toBe("closed");
    for (const id of ["cost-live", "cost-missing", "cost-closed"]) {
      const row = byId.get(id)!;
      expect(row.spendMicroUsd).toBe(123456);
      expect(row.limitMicroUsd).toBe(500000);
      expect(row.requestId).toBe("req-costs");
    }

    // boxUnknown builds its own row literal too. (A closed record still reads
    // `closed` with no list — closedAt is decided before the box evidence is.)
    const unknownRows = await statusAll({
      driver: {
        list: async (): Promise<ProviderVm[]> => {
          throw new Error("list down");
        },
      },
      store,
      listTimeoutMs: 1000,
    });
    expect(unknownRows).toHaveLength(3);
    for (const row of unknownRows) {
      expect(row.state).toBe(row.runId === "cost-closed" ? "closed" : "boxUnknown");
      expect(row.spendMicroUsd).toBe(123456);
      expect(row.limitMicroUsd).toBe(500000);
      expect(row.requestId).toBe("req-costs");
    }
  });

  test("mixed fleet: closed + live + boxMissing + orphan in ONE call", async () => {
    // Every other test asserts toHaveLength(1), which a per-record branch that
    // leaks across iterations satisfies perfectly.
    await provision("mix-live", { requestId: "req-live" });
    const missing = await provision("mix-missing", { requestId: "req-missing" });
    await driver.destroy(missing.vmName!);
    await provision("mix-closed", { requestId: "req-closed" }); // box left alive
    store.close("mix-closed");
    // An owned box no record claims: unattributed spend.
    await driver.create("mix-orphan", SBX_OWNERSHIP_TAG);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(4);
    const byId = new Map(rows.map((r) => [r.runId, r]));
    expect(byId.get("mix-live")!.state).toBe("live");
    expect(byId.get("mix-missing")!.state).toBe("boxMissing");
    expect(byId.get("mix-closed")!.state).toBe("closed");
    expect(byId.get("mix-closed")!.boxAlive).toBe(true);
    expect(byId.get("mix-orphan")!.state).toBe("orphan");
    // requestId on every state that HAS a record, and only there.
    expect(byId.get("mix-live")!.requestId).toBe("req-live");
    expect(byId.get("mix-missing")!.requestId).toBe("req-missing");
    expect(byId.get("mix-closed")!.requestId).toBe("req-closed");
    expect(byId.get("mix-orphan")!).not.toHaveProperty("requestId");
    // The closed record's live box is reported on its own row — never twice.
    expect(rows.filter((r) => r.state === "orphan")).toHaveLength(1);
  });

  test("orphan rows: no record, no requestId, sorted first and deterministically", async () => {
    await provision("claimed-run");
    await driver.create("orphan-b", SBX_OWNERSHIP_TAG);
    await driver.create("orphan-a", SBX_OWNERSHIP_TAG);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows.map((r) => r.runId)).toEqual(["orphan-a", "orphan-b", "claimed-run"]);
    for (const name of ["orphan-a", "orphan-b"]) {
      const row = rows.find((r) => r.runId === name)!;
      expect(row.state).toBe("orphan");
      expect(row.vmName).toBe(name);
      expect(row.createdAt).toBe("");
      expect(row).not.toHaveProperty("requestId");
    }
  });

  test("a box carrying a FOREIGN tag never makes a run report live", async () => {
    const runId = "tagged-foreign";
    await provision(runId);

    const rows = await statusAll({ driver: retagged(driver, "someone-elses-fleet"), store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1); // filtered out entirely — not even an orphan
    expect(rows[0]!.state).toBe("boxMissing");
  });

  test("an UNTAGGED box is still ours (exedev ls reports no tag)", async () => {
    const runId = "tagged-absent";
    await provision(runId);

    const rows = await statusAll({ driver: retagged(driver, null), store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
  });

  test("crash window: open record with no vmName but a live box under the run id → live", async () => {
    // INV-1's window: `driver.create` returned, the `set({vmName})` never landed.
    const runId = "crash-window-run";
    store.create(runId);
    await driver.create(runId, SBX_OWNERSHIP_TAG);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    // The box name teardown would target, taken from the box itself.
    expect(rows[0]!.vmName).toBe(runId);
    expect(rows.filter((r) => r.state === "orphan")).toHaveLength(0);
  });
});

describe("provisionAdmittedRun (INV-1) — failure leaves the run reclaimable", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  const budget = {
    repoSlug: "acme/widgets",
    issueId: "42",
    capMicroUsd: 50_000_000,
    spentMicroUsd: 0,
    reservedMicroUsd: 0,
    admittedCeilingMicroUsd: 20_000_000,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-provision-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed driver.create leaves the record OPEN with its budget attribution", async () => {
    // Closing it here looked tidy and was wrong twice over: the ledger retires
    // a reservation only when a PRICED cost_event lands, which only teardown
    // writes from `extensions.budget` — and the reaper routes an aged OPEN
    // record through teardownSandbox while skipping a closed one outright
    // (`closed ⇒ nothing to claim`). A closed record therefore pinned the
    // issue's cap forever, and stranded any box the failing create did stand up.
    const runId = "create-fails-run";
    const failing = Object.assign(Object.create(driver) as FakeDriver, {
      create: async () => {
        throw new Error("substrate refused the create");
      },
    });

    await expect(provisionAdmittedRun(failing, store, { runId, budget })).rejects.toThrow(
      "substrate refused the create",
    );

    const rec = store.get(runId);
    expect(rec.closedAt).toBeUndefined();
    expect(rec.extensions?.budget?.admittedCeilingMicroUsd).toBe(budget.admittedCeilingMicroUsd);
    expect(rec.extensions?.budget?.repoSlug).toBe(budget.repoSlug);
    // No box name to claim, which is exactly what makes the record the handle.
    expect(rec.vmName).toBeUndefined();
  });

  test("a failed budget-extension write leaves the record OPEN and no box behind", async () => {
    // Same reasoning one step earlier. Nothing billable exists yet, so the only
    // thing at stake is whether the record survives to be swept.
    const runId = "budget-write-fails";
    const failing = Object.assign(Object.create(driver) as FakeDriver, {
      create: async (): Promise<ProviderVm> => {
        throw new Error("driver.create must never be reached");
      },
    });
    const realSet = store.set.bind(store);
    let calls = 0;
    store.set = ((id: string, patch: Parameters<typeof realSet>[1]) => {
      calls += 1;
      if (calls === 1) throw new Error("record write failed");
      return realSet(id, patch);
    }) as typeof store.set;

    await expect(provisionAdmittedRun(failing, store, { runId, budget })).rejects.toThrow("record write failed");

    store.set = realSet;
    const rec = store.get(runId);
    expect(rec.closedAt).toBeUndefined();
    expect(rec.vmName).toBeUndefined();
    expect(await driver.list(runId)).toEqual([]);
  });
});

describe("status.ts (list timeout)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-status-timeout-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omitted listTimeoutMs arms the 30s default and the timer is always cleared", async () => {
    // Every other test injects a timeout, so `?? 30_000` → `?? 0` (or `?? 1`)
    // stays green while production reports boxUnknown for every run. Observe
    // the delay the race actually arms, and that the losing timer is cleared.
    // Provision BEFORE the patch: the store's lock retry and the driver both
    // arm timers of their own, and any one of them landing in `armed` would
    // make the single-30s-timer assertion below pass or fail for reasons that
    // have nothing to do with the status timeout under test.
    await provisionAdmittedRun(driver, store, { runId: "default-timeout-run" });

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed: { ms: unknown; handle: unknown }[] = [];
    const cleared: unknown[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      armed.push({ ms, handle });
      return handle;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle: unknown) => {
      cleared.push(handle);
      (realClearTimeout as (...a: unknown[]) => void)(handle);
    }) as unknown as typeof globalThis.clearTimeout;

    let rows: StatusRow[];
    try {
      rows = await statusAll({ driver, store });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    expect(armed.map((a) => a.ms)).toEqual([30_000]);
    expect(cleared).toEqual(armed.map((a) => a.handle));
  });

  test("a non-positive or non-finite listTimeoutMs is refused, never handed to setTimeout", async () => {
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await refusal(
        statusAll({ driver, store, listTimeoutMs: ms }),
        2,
        "invalid-list-timeout",
      );
      expect(err.message).toContain("positive finite number");
      await refusal(
        statusRun({ driver, store, listTimeoutMs: ms }, "some-run"),
        2,
        "invalid-list-timeout",
      );
    }
  });
});

describe("status.ts (statusRun)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-status-run-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function provision(runId: string, patch?: RunRecordPatch): Promise<RunRecord> {
    const { record } = await provisionAdmittedRun(driver, store, { runId });
    return patch === undefined ? record : store.set(runId, patch);
  }

  test("valid runId returns a single live row carrying the record's join key", async () => {
    const runId = "test-single-run";
    const rec = await provision(runId, { requestId: "req-single" });

    const row: StatusRow = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.runId).toBe(runId);
    expect(row.state).toBe("live");
    expect(row.vmName).toBe(rec.vmName);
    expect(row.requestId).toBe("req-single");
  });

  test("a hyphenated id at the 63-char cap is accepted", async () => {
    const runId = `max-${"a".repeat(RUN_ID_MAX - 4)}`;
    expect(runId).toHaveLength(RUN_ID_MAX);
    await provision(runId);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.runId).toBe(runId);
    expect(row.state).toBe("live");
  });

  test("runId validation refuses as typed exit 2, on the canonical grammar and cap", async () => {
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    // Grammar: uppercase, whitespace, path traversal, a leading hyphen, empty.
    for (const bad of ["INVALID_ID", "with spaces", "../escape", "-leading", "", "under_score"]) {
      await refusal(statusRun(deps, bad), 2, "invalid-run-id");
    }
    // The cap now comes from run-record.ts, not a private copy that allowed
    // any length: 63 passes (above), 64 must refuse as usage, not as a store error.
    const err = await refusal(statusRun(deps, "a".repeat(RUN_ID_MAX + 1)), 2, "invalid-run-id");
    expect(err.message).toContain(String(RUN_ID_MAX));
  });

  test("a non-string runId is refused by the typeof guard, not by the regex", async () => {
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    // Every one of these COERCES to a string the grammar accepts ("null",
    // "undefined", "123"), so only the typeof guard can refuse them.
    for (const bad of [null, undefined, 123]) {
      await refusal(statusRun(deps, bad as unknown as string), 2, "invalid-run-id");
    }
  });

  test("an id that ends in a hyphen is refused as usage, never passed to the store", async () => {
    // RUN_ID_RE is `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` — an RFC 1123 label, since
    // the id becomes the box name and the box name becomes a public hostname.
    // A stale private copy (`^[a-z0-9][a-z0-9-]*$`) accepts all of these and
    // reaches the store as run-not-found (4); the canonical grammar refuses at 2.
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    for (const bad of ["trailing-", "a--", "-", "--"]) {
      await refusal(statusRun(deps, bad), 2, "invalid-run-id");
    }
  });

  test("interior hyphens stay legal — the minted id shape still resolves", async () => {
    // The tightening must not over-reject: `qds-<YYYYMMDD>-<6 hex>` is what
    // mintRunId() produces for every real run.
    const runId = "qds-20260821-a1b2c3";
    await provision(runId);
    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("live");
  });

  test("ENOENT → exit 4 with operator-facing content, mutating nothing", async () => {
    await provision("bystander-run");
    const before = store.list();
    const listSpy = mock((name?: string) => driver.list(name));

    const err = await refusal(
      statusRun({ driver: { list: listSpy }, store, listTimeoutMs: 1000 }, "nonexistent-run"),
      4,
      "run-not-found",
    );
    // Content, not key presence: toHaveProperty("message") passes for "".
    expect(err.message).toContain("nonexistent-run");
    expect(err.remediation).toContain("run ID");
    // Mutates NOTHING when not found: no record touched, no driver consulted.
    expect(store.list()).toEqual(before);
    expect(listSpy).not.toHaveBeenCalled();
  });

  test("found record uses the same join logic (no vmName, no box → boxMissing)", async () => {
    const runId = "test-join-logic";
    store.create(runId);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.runId).toBe(runId);
    expect(row.state).toBe("boxMissing");
  });

  test("vmName set but the box is gone → boxMissing", async () => {
    const runId = "single-missing-box";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("boxMissing");
    expect(row.vmName).toBe(rec.vmName);
  });

  test("list throws → boxUnknown for the single run too", async () => {
    const runId = "single-unknown-throw";
    await provision(runId);

    const row = await statusRun(
      {
        driver: {
          list: async (): Promise<ProviderVm[]> => {
            throw new Error("list unavailable");
          },
        },
        store,
        listTimeoutMs: 1000,
      },
      runId,
    );
    expect(row.state).toBe("boxUnknown");
  });

  test("list hangs past the timeout → boxUnknown for the single run too", async () => {
    const runId = "single-unknown-timeout";
    await provision(runId);

    const row = await statusRun(
      { driver: { list: () => new Promise<ProviderVm[]>(() => {}) }, store, listTimeoutMs: 5 },
      runId,
    );
    expect(row.state).toBe("boxUnknown");
  });

  test("crash window: no vmName but a live box under the run id → live", async () => {
    const runId = "single-crash-window";
    store.create(runId);
    await driver.create(runId, SBX_OWNERSHIP_TAG);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("live");
    expect(row.vmName).toBe(runId);
  });

  test("closed record over a LIVE box → closed + boxAlive, driver consulted", async () => {
    // A closed record no longer short-circuits the driver: teardown destroys
    // before it closes, so a live box here is one that never got destroyed.
    const runId = "test-closed-single";
    await provision(runId);
    store.close(runId);

    const listSpy = mock((name?: string) => driver.list(name));
    const row = await statusRun({ driver: { list: listSpy }, store, listTimeoutMs: 1000 }, runId);

    expect(row.state).toBe("closed");
    expect(row.runId).toBe(runId);
    expect(row.boxAlive).toBe(true);
    expect(listSpy).toHaveBeenCalled();
  });

  test("closed record whose box is gone → closed with boxAlive absent", async () => {
    const runId = "test-closed-destroyed";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("closed");
    expect(row).not.toHaveProperty("boxAlive");
  });
});
