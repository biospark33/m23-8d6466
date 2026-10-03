/**
 * Z-Z2 AC8: the fork's observe-consumer role, played against the REAL fleet
 * verbs in the factory repo (fake driver) — no fork checkout, no stubbed
 * fleet output.
 *
 * Every pinned assertion routes through tests/fleet/observe-contract.ts (the
 * ONE helper q1-contract pins the surface through) — this file asserts the
 * Z1 surface by importing it, never by hand, and adds only what the sweeps
 * cannot say: the consumer's actual flow (a run is created by a producer,
 * then polled by id, then seen in the fleet listing) and the read-only
 * closure (the two observe verbs create no records — a consumer honoring the
 * surface provably cannot spend).
 *
 * Deliberately absent: hand-written pinned JSON literals. A harness that
 * hand-asserts the shape drifts silently when the surface moves; the helper
 * is the one copy a deliberate contract bump updates.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../scripts/fleet.ts";
import type { FleetDeps } from "../../scripts/fleet.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { goodLedger } from "./helpers.ts";
import { assertObserveSurface } from "./observe-contract.ts";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "z2-consumer-")));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

let dir: string;
let store: RunRecordStore;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpRoot, "c-")));
  store = new RunRecordStore(join(dir, "runs"));
  // The cost config the CLI loads beside the store (the same fixture q1 plants).
  mkdirSync(join(dir, ".sandbox"), { recursive: true });
  writeFileSync(join(dir, ".sandbox", "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
  writeFileSync(join(dir, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
});

/** The injected fleet deps a consumer probes with — q1's runCli fixture. */
function observeDeps(): Partial<FleetDeps> & { store: RunRecordStore } {
  return {
    driver: new FakeDriver(join(dir, "boxes")),
    keyApi: new FakeKeyApi(),
    store,
    ledgerFactory: () => goodLedger(),
    repoRoot: dir,
  };
}

/** One argv-in probe: `run()` returns the exit code, the arrays keep the lines. */
function probe(
  argv: readonly string[],
  deps: Partial<FleetDeps> & { store: RunRecordStore },
  out: string[],
  err: string[],
): Promise<number> {
  return run(argv, (s) => void out.push(s), deps, (s) => void err.push(s));
}

describe("Z-Z2 AC8: the fork-observe-consumer role on real fleet verbs", () => {
  test("result: the full pinned surface, asserted only by the shared Z1 helper", async () => {
    await assertObserveSurface(run, [], [], observeDeps(), { verb: "result" });
  });

  test("status: the full pinned surface, asserted only by the shared Z1 helper", async () => {
    await assertObserveSurface(run, [], [], observeDeps(), { verb: "status" });
  });

  test("consumer flow: a run is polled by id, then seen in the fleet listing", async () => {
    // ONE shared deps object — the store/driver state carries across verbs,
    // exactly the producer-then-observe sequence the fork processor runs.
    const deps = observeDeps();
    const out: string[] = [];
    const err: string[] = [];
    deps.store.create("qds-z2-consumer1");

    expect(await probe(["result", "qds-z2-consumer1", "--json"], deps, out, err)).toBe(0);
    expect(out.join("\n")).toContain("qds-z2-consumer1");

    const mark = out.length;
    expect(await probe(["status", "--driver", "fake"], deps, out, err)).toBe(0);
    expect(out.slice(mark).join("\n")).toContain("qds-z2-consumer1");
  });

  test("read-only closure: both observe verbs create no records", async () => {
    const deps = observeDeps();
    const out: string[] = [];
    const err: string[] = [];
    deps.store.create("qds-z2-closure1");

    expect(await probe(["result", "qds-z2-closure1", "--json"], deps, out, err)).toBe(0);
    expect(await probe(["status", "--driver", "fake"], deps, out, err)).toBe(0);

    // The store's OWN listing, not mocks: exactly what was seeded exists —
    // no observe probe minted a record, so no spend was ever reachable.
    expect(deps.store.list().map((r) => r.runId)).toEqual(["qds-z2-closure1"]);
  });
});
