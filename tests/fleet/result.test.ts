/**
 * `fleet result` core tests (Q1.3) — TDD RED phase.
 *
 * The poller-facing completion payload (G3): ONE versioned JSON read off the
 * run RECORD — no box probes, no driver, no lock — so a DAG adapter can poll
 * it every few seconds without touching the substrate. `terminal` is the
 * field a poller branches on; `status` is the lifecycle word; artifact refs
 * name the files the factory chain has already written, when they exist.
 *
 * Coverage:
 * - running record: status running, terminal false
 * - closed record: status completed, terminal true
 * - approval states: awaiting-approval/pausing open; approved/rejected terminal
 * - unknown-record refusal (exit 4)
 * - artifact ref: the bundle path WHEN the file exists, absent otherwise
 * - spend passthrough; no key material anywhere in the payload (INV-4)
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RunRecordStore } from "../../src/providers/run-record.ts";

// RED: src/fleet/result.ts does not exist yet — this import is the first failure.
import { buildResult, ResultError } from "../../src/fleet/result.ts";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "q1-result-")));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

let runsDir: string;
let store: RunRecordStore;

beforeEach(() => {
  const dir = realpathSync(mkdtempSync(join(tmpRoot, "r-")));
  runsDir = join(dir, "runs");
  store = new RunRecordStore(runsDir);
});

function seed(runId: string, fields: Record<string, unknown> = {}, extensions: Record<string, Record<string, string>> = {}): string {
  store.create(runId);
  store.set(runId, {
    ...fields,
    ...(Object.keys(extensions).length > 0
      ? { extensions: Object.fromEntries(Object.entries(extensions).map(([ns, v]) => [ns, { ...v }])) }
      : {}),
  } as Parameters<RunRecordStore["set"]>[1]);
  return runId;
}

describe("buildResult (Q1.3 pollable completion payload)", () => {
  test("a running record: status running, terminal false, requestId carried", () => {
    seed("qds-20260928-aaa111", {
      requestId: "5e5a3c8e-1f2b-4c3d-9a8e-70c1f2d3e4f5",
      vmName: "qds-vm",
      spendMicroUsd: 12_345,
    });
    const r = buildResult(store, "qds-20260928-aaa111");
    expect(r).toMatchObject({
      schemaVersion: 1,
      runId: "qds-20260928-aaa111",
      requestId: "5e5a3c8e-1f2b-4c3d-9a8e-70c1f2d3e4f5",
      status: "running",
      terminal: false,
      spendMicroUsd: 12_345,
    });
  });

  test("a closed record: status completed, terminal true", () => {
    // closedAt is close()'s field, not set()'s — close the record the way the
    // observe chain does.
    seed("qds-20260928-bbb222");
    store.close("qds-20260928-bbb222");
    const r = buildResult(store, "qds-20260928-bbb222");
    expect(r.status).toBe("completed");
    expect(r.terminal).toBe(true);
  });

  test("awaiting-approval is OPEN (the DAG never approves); approved and rejected are terminal", () => {
    seed("qds-20260928-ccc333", {}, { approval: { state: "awaiting-approval" } });
    expect(buildResult(store, "qds-20260928-ccc333")).toMatchObject({ status: "awaiting-approval", terminal: false });
    seed("qds-20260928-ccc334", {}, { approval: { state: "approved" } });
    expect(buildResult(store, "qds-20260928-ccc334")).toMatchObject({ status: "approved", terminal: true });
    seed("qds-20260928-ccc335", {}, { approval: { state: "rejected" } });
    expect(buildResult(store, "qds-20260928-ccc335")).toMatchObject({ status: "rejected", terminal: true });
  });

  test("an unknown run refuses exit-4 style — the poller's missing-record answer", () => {
    let err: unknown;
    try {
      buildResult(store, "qds-20260928-zzz999");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResultError);
    expect((err as ResultError).exitCode).toBe(4);
    expect((err as ResultError).code).toBe("run-not-found");
  });

  test("artifact ref: the bundle path WHEN the file exists, absent otherwise", () => {
    seed("qds-20260928-ddd444");
    expect(buildResult(store, "qds-20260928-ddd444").artifacts).toEqual({});
    writeFileSync(join(runsDir, "qds-20260928-ddd444.bundle"), "bundle-bytes");
    const r = buildResult(store, "qds-20260928-ddd444");
    expect(r.artifacts.bundle).toBe(join(runsDir, "qds-20260928-ddd444.bundle"));
  });

  test("no key material anywhere in the payload (INV-4)", () => {
    seed("qds-20260928-eee555", { keyHash: "deadbeef", limitMicroUsd: 500 });
    const text = JSON.stringify(buildResult(store, "qds-20260928-eee555"));
    expect(text).not.toMatch(/keyHash|sk-or|sk-ant|secret/i);
  });
});
