/**
 * Unit tests for live-harness.ts's TEARDOWN semantics (#189) — the two
 * `finally`-block primitives every live test leans on. These are plain unit
 * tests, not live tests: the harness's NO-FAKES rule binds the *.live.test.ts
 * files and the harness's own imports, not tests OF the harness. The driver
 * here is the real ExeDevDriver with a command injected at its own seam
 * (`ExeDevDriverOptions.run`), and the store is a real RunRecordStore on a
 * tmp dir — no substrate, no network, no spend.
 *
 * What is pinned, and why it is load-bearing (#189):
 *  1. `revokeQuietly` must NEVER throw — a missing/half-written run record
 *     used to escape the caller's `finally` and skip the box destroy, the
 *     evidence write and the workspace cleanup. The failure is recorded as a
 *     `finally-revoke ok:false` evidence entry instead (fail-closed verdict:
 *     the post-finally assertions in the live tests read those entries).
 *  2. `destroyQuietly` must REPORT failure to its caller — before #189 it
 *     could only record into `evidence`, which nothing read, so a leaked
 *     billing box shipped a green test.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import type { ExecResult } from "../../../src/providers/driver.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { destroyQuietly, revokeQuietly } from "./live-harness.ts";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

function withStore<T>(fn: (store: RunRecordStore, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "qds-harness-unit-"));
  try {
    return fn(new RunRecordStore({ dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── revokeQuietly ────────────────────────────────────────────────────────────

test("revokeQuietly: a MISSING run record resolves (never throws) and records a finally-revoke ok:false verdict", async () => {
  await withStore(async (store) => {
    const driver = new ExeDevDriver({
      run: () => Promise.reject(new Error("driver must not be reached when the record is unreadable")),
    });
    const evidence: Record<string, unknown>[] = [];
    // The record was never created — the exact half-written-teardown shape
    // that used to throw out of the caller's `finally` (#189 item 1).
    await revokeQuietly(driver, store, "e2e-missing-abc123", evidence);
    const entries = evidence.filter((p) => p.phase === "finally-revoke");
    expect(entries.length).toBe(1);
    expect(entries[0]?.ok).toBe(false);
    expect(String(entries[0]?.error)).toContain("e2e-missing-abc123");
  });
});

test("revokeQuietly: a record with NO keyHash is a silent no-op (nothing minted, nothing to revoke, no API call)", async () => {
  await withStore(async (store) => {
    const runId = "e2e-nokey-abc123";
    store.create(runId);
    const driver = new ExeDevDriver({
      run: () => Promise.reject(new Error("no key was minted — the provider must not be called")),
    });
    const evidence: Record<string, unknown>[] = [];
    await revokeQuietly(driver, store, runId, evidence);
    expect(evidence).toEqual([]);
  });
});

// ── destroyQuietly ───────────────────────────────────────────────────────────

test("destroyQuietly: a destroy CONFIRMED by ls returns ok:true and records it", async () => {
  const vm = "e2e-gone-abc123";
  const driver = new ExeDevDriver({
    run: (argv) => {
      if (argv.includes("rm")) return Promise.resolve(ok());
      if (argv.includes("ls")) return Promise.resolve(ok(JSON.stringify({ vms: [] })));
      return Promise.reject(new Error(`unexpected control command: ${argv.join(" ")}`));
    },
  });
  const evidence: Record<string, unknown>[] = [];
  const res = await destroyQuietly(driver, vm, evidence);
  expect(res.ok).toBe(true);
  expect(evidence).toEqual([{ phase: "finally-destroy", vm, ok: true }]);
});

test("destroyQuietly: a FAILED destroy returns ok:false WITH the error — a leaked box must be reportable, not only recordable (#189 item 2)", async () => {
  const vm = "e2e-leak-abc123";
  const driver = new ExeDevDriver({
    run: () => Promise.reject(new Error("substrate unreachable")),
  });
  const evidence: Record<string, unknown>[] = [];
  const res = await destroyQuietly(driver, vm, evidence);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("substrate unreachable");
  const entries = evidence.filter((p) => p.phase === "finally-destroy");
  expect(entries.length).toBe(1);
  expect(entries[0]?.ok).toBe(false);
});
