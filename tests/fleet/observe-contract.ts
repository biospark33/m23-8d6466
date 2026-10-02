/**
 * The observe consumption surface (factory_observe) — the ONE shared
 * assertion over the two read-only verbs the fork's observe step may call.
 * q1-contract.test.ts pins the surface through this helper; Z2's consumer
 * harness imports the same helper, so both sides assert the surface once.
 *
 * GRAMMAR BOUNDARY (AC8, carried as contract prose): $SWARMCLAW_FACTORY_FLEET_CLI
 * is the only fork→factory route. `--driver exedev` lives only in the deployed
 * wrapper — including for `status`, whose registry row REQUIRES the flag the
 * wrapper, never the fork, supplies (DD-28.5). Nothing here teaches the fork
 * QDS's driver grammar: the helper drives run() with an INJECTED driver,
 * exactly the way a DAG adapter consumes the surface — argv in, JSON lines out.
 *
 * READ-ONLY CLOSURE (AC3): the allowed verb set for the observe surface is
 * exactly `["status", "result"]`, pinned as a literal and asserted against
 * listVerbs() membership. Every other verb — provisioning, spend-creating,
 * approval — is outside this contract (INV-Z1-2): a consumer honoring it
 * provably cannot provision, spend, or approve. `result` is driver-free,
 * box-free and lock-free BY CONSTRUCTION, asserted from registry facts: its
 * row carries no `--driver` flag, and `buildResult` is a pure record read
 * (src/fleet/result.ts — no box probe, no ledger, no run lock; that purity is
 * what makes the verb poller-safe).
 *
 * EXIT DOCTRINE: `fleet result` exit 0 covers a RUNNING run — the payload's
 * `terminal` field is what a poller branches on, so a running run is a
 * SUCCESSFUL poll. Exit 4 is the missing-record answer (`run-not-found`).
 *
 * STATE-VOCABULARY DEBT (the second recorded schema debt, riding the same
 * deliberate-grammar-bump track as the schema-version debt, DD-28.5
 * pattern): STATUS_VOCABULARY below pins the closed enumeration from
 * src/fleet/status.ts's own docblock ("THE WHOLE VOCABULARY"), but the WIRE
 * does not close it — that module types `state` as `(string & {})`, a
 * deliberate fail-visible passthrough: an unknown approval state renders
 * as-is rather than being swallowed into a placeholder word. Contract
 * consumers must therefore TOLERATE unknown state words — branch on the
 * known ones, pass the rest through visibly. This suite pins the docblock
 * enumeration as a COPY: the pin enforces wire→vocabulary containment
 * (a new word on the wire fails here by name) plus the list's length — but
 * the list-vs-src-docblock direction (a word renamed or retired in src/
 * while this copy stays) is REVIEW-enforced, not CI-enforced: src/ is
 * outside this suite's write scope. The passthrough debt itself is a
 * grammar bump landing in src/ and here together.
 *
 * What is deliberately NOT pinned here: anything but the JSON contract. No
 * source file is read — every absence (status rows carry no schema-version
 * marker) is asserted on the WIRE, where a consumer would trip over it.
 */
import { expect } from "bun:test";

import type { FleetDeps } from "../../scripts/fleet.ts";
import type { RunRecordStore } from "../../src/providers/run-record.ts";
import {
  RESULT_SCHEMA_VERSION,
  RESULT_STATUS_VALUES,
  type ResultPayload,
} from "../../src/fleet/result.ts";
import { FLEET_ROW_ID, type StatusRow } from "../../src/fleet/status.ts";
import { listVerbs } from "../../src/fleet/verbs.ts";

/**
 * The closed state vocabulary, EXACTLY as src/fleet/status.ts's own docblock
 * ("THE WHOLE VOCABULARY") and the `StatusRow["state"]` union enumerate it:
 * the two decisive in-box words, the marker-corroborated/in-box words, the
 * box words, the fleet-level words, and the approval words. A new word — or a
 * renamed one — is a contract change and lands here first.
 *
 * PIN DIRECTION (honest): the length pin (16) plus wire→vocabulary containment
 * is all this copy enforces in CI — list-vs-src-docblock rot is review-enforced,
 * since src/ sits outside this suite's write scope.
 */
const STATUS_VOCABULARY: readonly string[] = [
  "ok",
  "not-ok",
  "running",
  "engine-failed",
  "not-running",
  "unknown",
  "live",
  "boxMissing",
  "boxUnknown",
  "closed",
  "orphan",
  "listUnavailable",
  "recordsSkipped",
  "awaiting-approval",
  "timed-out",
  "pausing",
];

/** AC3: the ONLY verbs the fork's observe step may invoke. */
const OBSERVE_VERBS: readonly string[] = ["status", "result"];

const RESULT_REQUIRED = ["schemaVersion", "runId", "requestId", "status", "terminal", "artifacts"];
const RESULT_OPTIONAL = ["vmName", "spendMicroUsd"];
const STATUS_REQUIRED = ["runId", "state"];
const STATUS_OPTIONAL = [
  "requestId",
  "vmName",
  "httpsUrl",
  "boxAlive",
  "reportId",
  "expiresInMs",
  "resumeHint",
  "createdAt",
  "closedAt",
  "spendMicroUsd",
  "limitMicroUsd",
  "artifactsLost",
  "skippedRecords",
];

/**
 * The exact field-set pin: missing AND extra fields both fail, naming them.
 * THE canonical copy — q1-contract.test.ts imports this one (its former
 * local duplicate is gone); the refusal mechanism itself is demonstrated by
 * a meta-test there.
 */
export function expectExactFields(obj: object, required: string[], optional: string[] = []): void {
  const keys = new Set(Object.keys(obj));
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((k) => !keys.has(k));
  const unexpected = [...keys].filter((k) => !allowed.has(k));
  expect({
    missing,
    unexpected,
    hint: `the observe contract changed: required=${JSON.stringify(required)} optional=${JSON.stringify(optional)} got=${JSON.stringify([...keys].sort())}`,
  }).toEqual({ missing: [], unexpected: [], hint: expect.any(String) });
}

/**
 * Assert the whole observe surface for ONE verb, the way the DAG adapter
 * consumes it: `run()` argv in, JSON lines out.
 *
 * `run`/`out`/`err`/`deps` are exactly what q1-contract's `runCli` builds —
 * deps carries the injected driver/store, `out`/`err` are the captured
 * streams, and only the lines THIS helper's probes emit are read back.
 */
export async function assertObserveSurface(
  run: typeof import("../../scripts/fleet.ts").run,
  out: string[],
  err: string[],
  deps: Partial<FleetDeps> & { store: RunRecordStore },
  opts: { verb: "result" | "status" },
): Promise<void> {
  let markOut = 0;
  let markErr = 0;
  const probe = async (
    argv: string[],
    overrides: Partial<FleetDeps> = {},
  ): Promise<{ code: number; lines: string[]; errText: string }> => {
    markOut = out.length;
    markErr = err.length;
    const code = await run(
      argv,
      (s: string) => void out.push(s),
      { ...deps, ...overrides },
      (s: string) => void err.push(s),
    );
    return { code, lines: out.slice(markOut), errText: err.slice(markErr).join("") };
  };

  // ── registry facts, both verbs ────────────────────────────────────────────
  // The closed 16-verb registry must contain BOTH observe verbs — the closure
  // is the literal array, not a grep: a verb renamed off the surface fails
  // here by name.
  const verbs = listVerbs();
  const byVerb = (name: string) => verbs.find((v) => v.verb === name);
  expect(
    verbs
      .filter((v) => OBSERVE_VERBS.includes(v.verb))
      .map((v) => v.verb)
      .sort(),
  ).toEqual(["result", "status"]);

  if (opts.verb === "result") {
    // Registry: exit row pinned LITERALLY, and NO --driver flag — the row's
    // flag absence plus buildResult's pure-record-read are the whole
    // driver-free/box-free/lock-free argument (see the docblock above).
    const row = byVerb("result");
    expect(row).toBeDefined();
    expect(row?.exitCodes).toEqual([0, 2, 4, 6]);
    expect(row?.flags.map((f) => f.name)).not.toContain("--driver");

    // The version is the LITERAL 1 the module exports; the status enum is
    // closed and named — a new status, or a renamed one, is a contract change.
    expect(RESULT_SCHEMA_VERSION).toBe(1);
    expect([...RESULT_STATUS_VALUES].sort()).toEqual([
      "approved",
      "awaiting-approval",
      "cancelled",
      "completed",
      "pausing",
      "rejected",
      "running",
    ]);

    // Exit 0 on a RUNNING record: `store.create` leaves no completion markers,
    // so buildResult says running. A running run is a SUCCESSFUL poll —
    // `terminal` is the field a poller branches on, never the exit code.
    const runId = "qds-20260928-obsv01";
    deps.store.create(runId);
    const poll = await probe(["result", runId, "--json"]);
    expect(poll.code).toBe(0);
    expect(poll.lines).toHaveLength(1);
    const payload = JSON.parse(poll.lines[0] as string) as ResultPayload;
    expectExactFields(payload, RESULT_REQUIRED, RESULT_OPTIONAL);
    expect(payload.schemaVersion).toBe(1);
    expect(RESULT_STATUS_VALUES.has(payload.status)).toBe(true);
    expect(payload.terminal).toBe(false);
    expect(payload.artifacts).toEqual({});
    // requestId is null-never-absent: PRESENT on every payload, null when the
    // run carries no correlation id — the adapter's join key reads the SAME
    // field on every payload.
    expect("requestId" in payload).toBe(true);
    expect(payload.requestId).toBeNull();

    // Exit 4 is the missing-record answer, named on stderr.
    const missing = await probe(["result", "qds-20260928-none99"]);
    expect(missing.code).toBe(4);
    expect(missing.errText).toContain("run-not-found");

    // AC3 purity, NEGATIVE control: the registry row's missing --driver flag
    // and buildResult's pure-record-read claim the verb is driver-free and
    // ledger-free — poison BOTH and the same poll must still succeed. The
    // driver becomes a proxy whose every property access throws; the
    // ledgerFactory itself throws. `fleet result --json` on the SAME record
    // must exit 0 with the IDENTICAL payload — proof by construction that a
    // future driver or ledger touch in this path turns green red.
    const poisoned = await probe(["result", runId, "--json"], {
      driver: new Proxy(
        {},
        {
          get: (_t, prop) => {
            if (prop === "then") return undefined; // never let a stray await mistake the proxy for a thenable
            throw new Error(`poisoned driver (probe): ${String(prop)}`);
          },
        },
      ),
      ledgerFactory: () => {
        throw new Error("poisoned ledgerFactory (probe)");
      },
    } as unknown as Partial<FleetDeps>);
    expect(poisoned.code).toBe(0);
    expect(poisoned.lines).toHaveLength(1);
    expect(JSON.parse(poisoned.lines[0] as string)).toEqual(payload);
    return;
  }

  // ── fleet status ──────────────────────────────────────────────────────────
  // Registry: exit row pinned LITERALLY. The row REQUIRES --driver — that is
  // the AC8 boundary: the deployed wrapper supplies the flag, the fork never
  // does.
  const row = byVerb("status");
  expect(row).toBeDefined();
  expect(row?.exitCodes).toEqual([0, 1, 2, 4, 5, 6]);
  expect(row?.flags.find((f) => f.name === "--driver")?.required).toBe(true);

  // Empty fleet: a state, not an error — exit 0 and NOTHING on stdout.
  // Emptiness is its own claim: a verb that printed nothing by crashing must
  // not pass as quiet-by-design.
  const empty = await probe(["status", "--driver", "fake"]);
  expect(empty.code).toBe(0);
  expect(empty.lines).toHaveLength(0);

  // Substrate outage: the fleet-level row is the WHOLE output, its runId is
  // FLEET_ROW_ID, and the exit is 1 — no output must never read as a clean
  // fleet while every box keeps billing.
  const outage = await probe(["status", "--driver", "fake"], {
    driver: {
      list: async () => {
        throw new Error("provider outage (probe)");
      },
    } as unknown as Partial<FleetDeps>,
  });
  expect(outage.code).toBe(1);
  const fleetRows = outage.lines
    .map((l) => JSON.parse(l) as StatusRow)
    .filter((r) => r.state === "listUnavailable");
  expect(fleetRows).toHaveLength(1);
  expect(fleetRows[0]?.runId).toBe(FLEET_ROW_ID);

  // One open record over no box: exactly the StatusRow field set (missing AND
  // extra fail by name — so a schema-version marker added to the wire fails
  // here as an extra field, and the explicit absence below names the debt),
  // every state word drawn from the closed vocabulary, runId the record's.
  deps.store.create("qds-20260928-obsv02");
  const listed = await probe(["status", "--driver", "fake"]);
  expect(listed.code).toBe(0);
  expect(listed.lines.length).toBeGreaterThan(0);
  // The copy's own length pin: an added word shifts the count and fails here,
  // forcing the deliberate-landing ritual — containment alone (below) would
  // let the list rot silently while src moves.
  expect(STATUS_VOCABULARY).toHaveLength(16);
  for (const line of listed.lines) {
    const rowOut = JSON.parse(line) as StatusRow;
    expectExactFields(rowOut, STATUS_REQUIRED, STATUS_OPTIONAL);
    expect(STATUS_VOCABULARY).toContain(rowOut.state);
    expect("schemaVersion" in rowOut).toBe(false);
  }
}
