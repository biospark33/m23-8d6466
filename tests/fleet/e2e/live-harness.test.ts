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
import {
  destroyQuietly,
  fleetCleanupProblems,
  keyLeakProblems,
  revokeQuietly,
  settleRun,
  teardownQuietly,
  writeEvidenceQuietly,
} from "./live-harness.ts";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

// async-safe: `await fn(...)` keeps the finally from rmSync-ing the store dir
// while an async body is still mid-flight (a sync return + async fn deleted
// the directory under the very store the test was exercising).
async function withStore<T>(fn: (store: RunRecordStore, dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "qds-harness-unit-"));
  try {
    return await fn(new RunRecordStore({ dir }), dir);
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
  const calls: string[][] = [];
  const driver = new ExeDevDriver({
    run: (argv) => {
      calls.push([...argv]);
      if (argv.includes("rm")) return Promise.resolve(ok());
      if (argv.includes("ls")) return Promise.resolve(ok(JSON.stringify({ vms: [] })));
      return Promise.reject(new Error(`unexpected control command: ${argv.join(" ")}`));
    },
  });
  const evidence: Record<string, unknown>[] = [];
  const res = await destroyQuietly(driver, vm, evidence);
  expect(res.ok).toBe(true);
  expect(evidence).toEqual([{ phase: "finally-destroy", vm, ok: true }]);
  // The title's claim, ASSERTED: the driver's F7 contract is rm-then-VERIFY
  // (rm exit 0 is the substrate's claim, not the state), so a destroy that
  // regressed to rm-without-ls must fail here, not on the bill.
  const rmAt = calls.findIndex((argv) => argv.includes("rm"));
  const lsAt = calls.findIndex((argv) => argv.includes("ls"));
  expect(rmAt).toBeGreaterThanOrEqual(0);
  expect(lsAt).toBeGreaterThan(rmAt);
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

test("settleRun: a cleanup problem is ATTACHED to the body's error, never thrown over the top of it", () => {
  // The shape this replaces — `expect(destroyFailures).toEqual([]); …; if
  // (failure !== undefined) throw failure;` — was correct on a green run and
  // wrong on a red one: the first `expect` threw its own AssertionError about
  // the leak and DISCARDED the held body error. The operator then reads
  // "boxes still listed" where the engine regression was, and pays for another
  // live round to rediscover it.
  const body = new Error("AC6 regression: /run/steering came back 755");
  const threw = ((): unknown => {
    try {
      settleRun(body, fleetCleanupProblems(["e2e-a: rm failed"], ["e2e-a"]));
      return undefined;
    } catch (e) {
      return e;
    }
  })();
  expect(threw).toBe(body); // the ORIGINAL error object, identity-equal
  expect((threw as Error).message).toContain("AC6 regression");
  expect((threw as Error).message).toContain("e2e-a: rm failed");
  expect((threw as Error).message).toContain("boxes still listed");
});

test("settleRun: on a body that PASSED, a cleanup problem is still the failure", () => {
  expect(() => settleRun(undefined, fleetCleanupProblems(["e2e-b: rm failed"], []))).toThrow("e2e-b: rm failed");
  // An UNMEASURED fleet is never a clean one (D6): `undefined` is the listing
  // itself having failed, and it must not read as zero boxes.
  expect(() => settleRun(undefined, fleetCleanupProblems([], undefined))).toThrow("final fleet listing FAILED");
  // The all-clean case is the only one that returns.
  expect(() => settleRun(undefined, fleetCleanupProblems([], []))).not.toThrow();
});

test("teardownQuietly: a THROWN teardown is a verdict, not an escape from the caller's finally", async () => {
  // An unguarded `await runFleet(["teardown", …])` in a `finally` let the
  // 180 s ceiling throw straight out, skipping every later cleanup step — the
  // box destroy, the leftover sweep, the evidence write — and replacing the
  // held body error. A non-zero exit was recorded and never asserted.
  const evidence: Record<string, unknown>[] = [];
  // An argv the fleet CLI refuses: a real subprocess, no fakes, non-zero exit.
  const refused = await teardownQuietly(["no-such-verb-df210"], { timeoutMs: 60_000 }, evidence, { id: "r1" });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toContain("fleet teardown exited");
  const entry = evidence.find((p) => p.phase === "finally-teardown");
  expect(entry?.id).toBe("r1");
  expect(entry?.exitCode).not.toBe(0);
  // F10: the entry must carry `ok`. Post-hoc evidence auditing here reads
  // `phase === X && ok === false`, so an entry with only a non-zero exitCode
  // read as CLEAN in the very filter written to find failures.
  expect(entry?.ok).toBe(false);
});

test("teardownQuietly: a caller's label can NEVER rewrite the entry's own phase (F15)", async () => {
  const evidence: Record<string, unknown>[] = [];
  // The seam that will get used wrongly: tier3-reaper already passes a label
  // because it cannot set `phase` — a label that COULD would silently remove
  // the entry from every `phase === "finally-teardown"` audit.
  await teardownQuietly(["no-such-verb-df210"], { timeoutMs: 60_000 }, evidence, { phase: "something-else", at: "labelled" });
  expect(evidence.length).toBe(1);
  expect(evidence[0]?.phase).toBe("finally-teardown");
  expect(evidence[0]?.at).toBe("labelled");
  expect(evidence[0]?.ok).toBe(false);
});

// ── writeEvidenceQuietly ─────────────────────────────────────────────────────

test("writeEvidenceQuietly: a FAILED write is a cleanup problem, not an escape from the caller's finally (F11)", () => {
  const problems: string[] = [];
  // A payload that cannot serialize: the same class of failure as ENOSPC or the
  // secret-scrub refusal, all of which `writeEvidence` THROWS. Unguarded, that
  // throw propagated out of the outer `finally` and made `settleRun` — the
  // whole verdict machinery this PR builds — unreachable.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const path = writeEvidenceQuietly("UNIT", "harness-unit-should-not-be-written", cyclic, problems);
  expect(path).toBe("");
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("evidence write FAILED");
  // …and it still renders through the normal verdict, alongside everything else.
  expect(() => settleRun(undefined, problems)).toThrow("evidence write FAILED");
});

// ── keyLeakProblems (F17) ────────────────────────────────────────────────────

const noDriver = (): ExeDevDriver =>
  new ExeDevDriver({ run: () => Promise.reject(new Error("the fallback must not reach the substrate in this case")) });

test("keyLeakProblems: an all-revoked population is CLEAN and reports nothing", async () => {
  const evidence: Record<string, unknown>[] = [];
  const before = new Set(["h-pre"]);
  const problems = await keyLeakProblems(before, { driver: noDriver(), runIds: [], list: () => Promise.resolve(new Set(["h-pre"])) }, evidence);
  expect(problems).toEqual([]);
  expect(evidence.find((p) => p.phase === "key-hash-delta")?.ok).toBe(true);
});

test("keyLeakProblems: a SURVIVING hash is a problem — revoked first, then reported (F17)", async () => {
  await withStore(async (store) => {
    const evidence: Record<string, unknown>[] = [];
    const before = new Set(["h-pre"]);
    const runId = "e2e-survivor-abc123";
    store.create(runId); // no keyHash → revokeQuietly is a silent no-op, no network
    // The teardown "succeeded" and left a key behind: present on the first
    // listing, gone on the re-list after the fallback revoke.
    let call = 0;
    const list = (): Promise<Set<string>> => {
      call += 1;
      return Promise.resolve(call === 1 ? new Set(["h-pre", "h-survivor"]) : new Set(["h-pre"]));
    };
    const problems = await keyLeakProblems(before, { driver: noDriver(), store, runIds: [runId], list }, evidence);
    // A problem ENTRY, not a log line: a round that needed the fallback is not clean.
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("h-survivor");
    expect(evidence.find((p) => p.phase === "key-hash-delta")?.ok).toBe(false);
    expect(evidence.find((p) => p.phase === "key-hash-delta-recheck")?.ok).toBe(true);
    // And it fails the run through the same verdict the box leak uses.
    expect(() => settleRun(undefined, problems)).toThrow("h-survivor");
  });
});

test("keyLeakProblems: a hash the fallback could NOT kill is louder still, and 'could not look' is never clean", async () => {
  const evidence: Record<string, unknown>[] = [];
  const stillLive = await keyLeakProblems(
    new Set<string>(),
    { driver: noDriver(), runIds: [], list: () => Promise.resolve(new Set(["h-stuck"])) },
    evidence,
  );
  expect(stillLive.length).toBe(1);
  expect(stillLive[0]).toContain("STILL LIVE");
  // The D6 rule, for keys as for boxes: an unmeasured population is a problem.
  const unmeasured = await keyLeakProblems(
    new Set<string>(),
    { driver: noDriver(), runIds: [], list: () => Promise.reject(new Error("key-list-truncated")) },
    evidence,
  );
  expect(unmeasured.length).toBe(1);
  expect(unmeasured[0]).toContain("never a clean one");
});
