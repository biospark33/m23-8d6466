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
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import type { ExecResult } from "../../../src/providers/driver.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  liveAuditLinksFor,
  liveAuditStorePath,
  recordLiveAuditLink,
  revokeQuietly,
  setEffectiveImage,
  settleRun,
  teardownQuietly,
  writeEvidenceQuietly,
} from "./live-harness.ts";

// The evidence dir, redirected to tmp for the whole file: this is a UNIT test
// in the fast suite and must not create or dirty the repo's
// `_bmad-output/evidence/df3-e2e` as a side effect of exercising the write path.
const UNIT_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), "qds-harness-evidence-"));
process.env.QDS_E2E_EVIDENCE_DIR = UNIT_EVIDENCE_DIR;
afterAll(() => {
  rmSync(UNIT_EVIDENCE_DIR, { recursive: true, force: true });
});

// A real `bun scripts/fleet.ts` spawn that the CLI refuses — no fakes, but the
// ceiling is sized for a process that exits in ~1 s, not the 60 s a live
// teardown gets. A 60 s ceiling in the fast suite is 60 s of nothing on the one
// run where the spawn does hang.
const REFUSAL_SPAWN_CEILING_MS = 15_000;

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

/** An `ls --json` body naming `names`, in the shape `ExeDevDriver.list` parses. */
const lsBody = (names: readonly string[]): string => JSON.stringify({ vms: names.map((n) => ({ vm_name: n })) });

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
  const refused = await teardownQuietly(["no-such-verb-df210"], { timeoutMs: REFUSAL_SPAWN_CEILING_MS }, evidence, { id: "r1" });
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
  await teardownQuietly(["no-such-verb-df210"], { timeoutMs: REFUSAL_SPAWN_CEILING_MS }, evidence, { phase: "something-else", at: "labelled" });
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
  // Stamped, so the failure under test is the SERIALIZATION one and not the
  // P125 provenance refusal (which has its own test below).
  setEffectiveImage(null, { note: "unit test" });
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

// ── settleRun: the contract seven costly live tests now rest on ──────────────

test("settleRun: the three-way contract — a body error always wins, a cleanup problem is never silent, all-clean returns", () => {
  // Every tier-3–5 test deleted its `throw e` and depends ENTIRELY on this
  // helper to re-throw. If it ever returned without throwing for some input
  // shape, seven real-money tests would report green on a real regression.
  const err = new Error("body regression");
  expect(() => settleRun(err, [])).toThrow(err); // failure, no problems → the original
  expect(() => settleRun(undefined, ["x"])).toThrow("x"); // green body, dirty cleanup → still red
  const both = ((): unknown => {
    try {
      settleRun(new Error("body regression"), ["boxes still listed after cleanup: e2e-z"]);
      return undefined;
    } catch (e) {
      return e;
    }
  })();
  expect((both as Error).message).toContain("body regression");
  expect((both as Error).message).toContain("e2e-z");
  expect(() => settleRun(undefined, [])).not.toThrow(); // the ONLY returning case
});

test("settleRun: a NON-Error body failure still carries the cleanup problems in the thrown value", () => {
  // stderr alone is not assertable and scrolls away; the docstring's promise
  // ("both facts survive") did not hold on this arm.
  const threw = ((): unknown => {
    try {
      settleRun("a string was thrown", ["boxes still listed after cleanup: e2e-q"]);
      return undefined;
    } catch (e) {
      return e;
    }
  })();
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toContain("a string was thrown");
  expect((threw as Error).message).toContain("e2e-q");
  expect((threw as Error).cause).toBe("a string was thrown");
});

test("settleRun: cleanup problems are SCRUBBED before they reach the thrown message (P126)", () => {
  // `teardownQuietly` splices up to 200 chars of RAW subprocess stderr into a
  // problem line. Unscrubbed, a `fleet teardown` dying while echoing a minted
  // key put a live credential into a CI log and a PR comment.
  const leaky = "cleanup failures: fleet teardown exited 1: auth failed for sk-or-v1-deadbeefcafebabe0123456789";
  const onGreen = ((): unknown => {
    try {
      settleRun(undefined, [leaky]);
      return undefined;
    } catch (e) {
      return e;
    }
  })();
  expect((onGreen as Error).message).not.toContain("sk-or-v1-deadbeef");
  expect((onGreen as Error).message).toContain("[REDACTED-KEY]");
  const body = new Error("body regression");
  expect(() => settleRun(body, [leaky])).toThrow();
  expect(body.message).not.toContain("sk-or-v1-deadbeef");
  expect(body.message).toContain("[REDACTED-KEY]");
  // …and a second settle on the same object does not double-append the block.
  const once = body.message;
  expect(() => settleRun(body, [leaky])).toThrow();
  expect(body.message).toBe(once);
});

test("fleetCleanupProblems: a finally-revoke ok:false in the evidence is a PROBLEM, not just prose", () => {
  // T5.1 was the only tier that folded this in by hand; every other tier's
  // revoke failure was an evidence entry nothing asserted.
  const evidence = [{ phase: "finally-revoke", runId: "e2e-r-abc123", ok: false, error: "provider 500" }];
  expect(fleetCleanupProblems([], [], evidence).join(" ")).toContain("e2e-r-abc123");
  expect(fleetCleanupProblems([], [], evidence).join(" ")).toContain("provider 500");
  // A SUCCESSFUL revoke is not a problem, and the 2-arg form is unchanged.
  expect(fleetCleanupProblems([], [], [{ phase: "finally-revoke", runId: "e2e-r-abc123", ok: true }])).toEqual([]);
  expect(fleetCleanupProblems([], [])).toEqual([]);
});

// ── writeEvidence provenance stamp (P125 / P129) ─────────────────────────────

test("writeEvidence: an UNSTAMPED write is REFUSED — no evidence file may inherit another test's boot image (P125)", () => {
  const problems: string[] = [];
  const before = readdirSync(UNIT_EVIDENCE_DIR).length;
  const path = writeEvidenceQuietly("UNIT", "harness-unit-unstamped", { test: "unstamped" }, problems);
  expect(path).toBe("");
  expect(problems[0]).toContain("NO boot-image provenance");
  expect(readdirSync(UNIT_EVIDENCE_DIR).length).toBe(before); // nothing written
});

test("writeEvidence: the stamp is per-test (set, consumed by the write) and a payload key named `image` cannot erase it (P129)", () => {
  setEffectiveImage({ image: "ghcr.io/x/y@sha256:aa", imageBuildId: "build-42" });
  const problems: string[] = [];
  const path = writeEvidenceQuietly("UNIT", "harness-unit-stamped", { test: "stamped", image: "a payload key that must NOT win" }, problems);
  expect(problems).toEqual([]);
  const written = JSON.parse(readFileSync(path, "utf8")) as { image: { ref: string; buildId: string; isRepoPin: boolean }; test: string };
  expect(written.image.ref).toBe("ghcr.io/x/y@sha256:aa");
  expect(written.image.buildId).toBe("build-42");
  expect(written.image.isRepoPin).toBe(false);
  expect(written.test).toBe("stamped");
  // CONSUMED: the next write in the same process must stamp its own, so a file
  // that forgets fails closed regardless of which files ran before it.
  const after: string[] = [];
  expect(writeEvidenceQuietly("UNIT", "harness-unit-second", { test: "second" }, after)).toBe("");
  expect(after[0]).toContain("NO boot-image provenance");
});

// ── fleetLeftovers (P127 / P128 / R4) ────────────────────────────────────────

/** A driver whose `ls` answers from a mutable set, and whose `rm` removes from it. */
const fleetDriver = (boxes: Set<string>, opts: { rmFails?: boolean } = {}): ExeDevDriver =>
  new ExeDevDriver({
    run: (argv) => {
      const args = [...argv];
      const rmAt = args.indexOf("rm");
      if (rmAt >= 0) {
        if (opts.rmFails === true) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "substrate said no" });
        boxes.delete(String(args[rmAt + 1]));
        return Promise.resolve(ok());
      }
      const lsAt = args.indexOf("ls");
      if (lsAt >= 0) {
        const name = args[lsAt + 1] === "--json" ? undefined : args[lsAt + 1];
        const all = [...boxes];
        return Promise.resolve(ok(lsBody(name === undefined ? all : all.filter((n) => n === name))));
      }
      return Promise.reject(new Error(`unexpected control command: ${args.join(" ")}`));
    },
  });

test("fleetLeftovers: a clean fleet reports nothing and does NOT pay for the lag poll", async () => {
  const evidence: Record<string, unknown>[] = [];
  const res = await fleetLeftovers(fleetDriver(new Set()), ["e2e-mine-abc123"], evidence, { retryDelayMs: 0 });
  expect(res.owned).toEqual([]);
  expect(res.strays).toEqual([]);
  expect(evidence.filter((p) => p.phase === "final-ls-retry")).toEqual([]); // broke on attempt 1
  expect(fleetCleanupProblems([], res.owned)).toEqual([]);
});

test("fleetLeftovers: a box still listed inside the 25 s+ destroy lag is POLLED, not reported as a leak (P127)", async () => {
  // r7-T-h1: `rm` exits 0 while the box stays listed 25+ seconds. Single-shot,
  // every one of these sites turned a clean cleanup into a failed paid round.
  const boxes = new Set(["e2e-lag-abc123"]);
  const evidence: Record<string, unknown>[] = [];
  const driver = new ExeDevDriver({
    run: (argv) => {
      const args = [...argv];
      if (args.includes("ls")) {
        const body = lsBody([...boxes]);
        boxes.clear(); // the listing catches up after the first attempt
        return Promise.resolve(ok(body));
      }
      return Promise.reject(new Error("nothing should need destroying — the box is already gone"));
    },
  });
  const res = await fleetLeftovers(driver, ["e2e-lag-abc123"], evidence, { retryDelayMs: 0 });
  expect(res.owned).toEqual([]);
  expect(evidence.filter((p) => p.phase === "final-ls-retry").length).toBe(1);
  expect(fleetCleanupProblems([], res.owned)).toEqual([]);
});

test("fleetLeftovers: a stray this run does NOT own is a WARNING, never a failure, and is never destroyed (R4)", async () => {
  // Account-wide, one box stranded by a previous round or a concurrent operator
  // failed EVERY test in the round — which trains the operator to ignore the
  // leak verdict entirely.
  const boxes = new Set(["e2e-someone-else-abc123", "qds-prior-round-def456"]);
  const evidence: Record<string, unknown>[] = [];
  const res = await fleetLeftovers(fleetDriver(boxes), ["e2e-mine-abc123"], evidence, { retryDelayMs: 0 });
  expect(res.owned).toEqual([]);
  expect(res.strays.sort()).toEqual(["e2e-someone-else-abc123", "qds-prior-round-def456"]);
  expect(fleetCleanupProblems([], res.owned)).toEqual([]); // the round is NOT red
  expect(boxes.size).toBe(2); // and nobody else's live box was killed
  expect(evidence.find((p) => p.phase === "final-ls")?.strays).toEqual(res.strays);
});

test("fleetLeftovers: an owned survivor is DESTROYED before the verdict is rendered (P128)", async () => {
  // A backstop that only observes is a bill: this is the box the run created
  // under a name it never learned (`create-shape-unresolved`).
  const boxes = new Set(["e2e-unnamed-abc123", "qds-stranger-def456"]);
  const evidence: Record<string, unknown>[] = [];
  const res = await fleetLeftovers(fleetDriver(boxes), (n) => n.startsWith("e2e-unnamed"), evidence, {
    maxAttempts: 2,
    retryDelayMs: 0,
  });
  expect(res.owned).toEqual([]); // destroyed, then re-listed clean
  expect([...boxes]).toEqual(["qds-stranger-def456"]);
  expect(evidence.some((p) => p.phase === "finally-destroy" && p.vm === "e2e-unnamed-abc123" && p.ok === true)).toBe(true);
  expect(fleetCleanupProblems([], res.owned)).toEqual([]);
});

test("fleetLeftovers: a survivor the destroy could NOT kill is the failing verdict", async () => {
  const boxes = new Set(["e2e-stuck-abc123"]);
  const evidence: Record<string, unknown>[] = [];
  const res = await fleetLeftovers(fleetDriver(boxes, { rmFails: true }), ["e2e-stuck-abc123"], evidence, {
    maxAttempts: 2,
    retryDelayMs: 0,
  });
  expect(res.owned).toEqual(["e2e-stuck-abc123"]);
  expect(fleetCleanupProblems([], res.owned).join(" ")).toContain("boxes still listed after cleanup: e2e-stuck-abc123");
});

test("fleetLeftovers: a FAILED listing is `undefined` — an unmeasured fleet is never a clean one, and it never throws", async () => {
  const evidence: Record<string, unknown>[] = [];
  const driver = new ExeDevDriver({ run: () => Promise.reject(new Error("substrate unreachable")) });
  const res = await fleetLeftovers(driver, ["e2e-mine-abc123"], evidence, { maxAttempts: 2, retryDelayMs: 0 });
  expect(res.owned).toBeUndefined();
  expect(fleetCleanupProblems([], res.owned).join(" ")).toContain("final fleet listing FAILED");
});

// ── keyLeakProblems totality (P138) ──────────────────────────────────────────

test("keyLeakProblems: a THROWN listing is a verdict, not an escape from the caller's finally (P138)", async () => {
  // It is `await`ed bare inside seven tier-3–5 `finally` blocks, AHEAD of the
  // evidence write — a rejection there discarded the held body error and made
  // `settleRun` unreachable.
  const evidence: Record<string, unknown>[] = [];
  const problems = await keyLeakProblems(
    new Set<string>(),
    {
      driver: noDriver(),
      runIds: [],
      list: () => {
        throw new Error("a SYNCHRONOUS throw, not a rejection");
      },
    },
    evidence,
  );
  expect(problems.length).toBe(1);
  expect(problems[0]).toContain("never a clean one");
});

test("keyLeakProblems: with no runIds it does NOT claim a fallback revoke was attempted (P132)", async () => {
  const evidence: Record<string, unknown>[] = [];
  const problems = await keyLeakProblems(
    new Set<string>(),
    { driver: noDriver(), runIds: [], list: () => Promise.resolve(new Set(["h-stuck"])) },
    evidence,
  );
  expect(problems[0]).toContain("NO record-backed fallback revoke was available");
  expect(problems[0]).not.toContain("after the harness fallback revoke");
  expect(evidence.find((p) => p.phase === "key-hash-delta-recheck")?.attemptedRevoke).toBe(false);
});

/**
 * DF5.3 safety: the harness's audit seam is REAL under a live round and inert
 * otherwise. Every caller already sits inside a `test.todoIf(liveTodoOff())`
 * body; this is the second lock, and the one that keeps a future caller added
 * outside such a body from opening a store (or dirtying the evidence tree) in
 * the fast suite.
 */
test("recordLiveAuditLink is INERT unless QDS_E2E_LIVE=1 — the fast suite opens no store", () => {
  // The inert path is PINNED here, never inherited. `expect(QDS_E2E_LIVE).not.toBe("1")`
  // as the first assertion made the ambient shell the test's fixture: an
  // operator running the fast suite from a terminal where the live-e2e round
  // had exported QDS_E2E_LIVE=1 failed on that line instead of exercising the
  // inert path — and worse, had the assertion been removed, this very call
  // would have gone LIVE and written a real store into the evidence tree.
  // QDS_E2E_EVIDENCE_DIR rides along because `liveAuditStorePath()` reads it:
  // a stale export would otherwise aim `existsSync` at a directory the
  // operator's last real round had already filled, and the assertion below
  // would fail on somebody else's evidence.
  const saved: Array<[string, string | undefined]> = [
    ["QDS_E2E_LIVE", process.env.QDS_E2E_LIVE],
    ["QDS_E2E_EVIDENCE_DIR", process.env.QDS_E2E_EVIDENCE_DIR],
  ];
  const evidenceDir = mkdtempSync(join(tmpdir(), "qds-harness-gate-"));
  try {
    // Explicitly NOT "1" — the one value the seam treats as live.
    process.env.QDS_E2E_LIVE = "0";
    process.env.QDS_E2E_EVIDENCE_DIR = evidenceDir;

    recordLiveAuditLink({
      runId: "harness-gate",
      repoSlug: "acme/widgets",
      requestId: "req-gate",
      hop: "run-credential",
      event: "mint",
      subjectId: "k",
      subjectKind: "credential-key",
      evidenceDigest: "0".repeat(64),
      occurredAt: "2026-09-17T00:00:00.000Z",
      recordedAt: "2026-09-17T00:00:00.000Z",
    });
    // ONE assertion, and it is the whole claim: no store file was created.
    // `liveAuditLinksFor(...) === []` used to sit beside it and pinned the same
    // fact twice — the reader early-returns `[]` off this very `existsSync` —
    // while reading as coverage of the reader. The reader's body is exercised
    // by the live-path test below, which is where it belongs.
    expect(existsSync(liveAuditStorePath())).toBeFalse();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

/**
 * DF5.3: the LIVE branch of the same seam — the write path and the read path,
 * executed.
 *
 * Without this the only test of either sets `QDS_E2E_LIVE="0"` and asserts
 * absence, so `mkdirSync` → `openAuditStore` → `record` and
 * `openAuditStoreForWalk` → `linksForRun` → `close` were dead code as far as
 * the suite was concerned: a bad link shape, a wrong path, or a `record()` that
 * throws on the round's first link would surface for the first time DURING a
 * paid round, mid-flight, after real boxes and real keys exist.
 *
 * This costs nothing. Opening a temp SQLite file is not a spendy path — only
 * the seam's CALLERS are, and none of them is reached here. `QDS_E2E_TIER` and
 * the substrate variables are never consulted by this seam (`liveTodoOff()` is
 * its whole gate), so nothing in this test can provision anything.
 */
test("recordLiveAuditLink under QDS_E2E_LIVE=1 writes the link, and liveAuditLinksFor reads it back", () => {
  const saved: Array<[string, string | undefined]> = [
    ["QDS_E2E_LIVE", process.env.QDS_E2E_LIVE],
    ["QDS_E2E_EVIDENCE_DIR", process.env.QDS_E2E_EVIDENCE_DIR],
  ];
  const evidenceDir = mkdtempSync(join(tmpdir(), "qds-harness-live-link-"));
  try {
    process.env.QDS_E2E_LIVE = "1";
    process.env.QDS_E2E_EVIDENCE_DIR = evidenceDir;

    const link = {
      runId: "harness-live-run",
      repoSlug: "acme/widgets",
      requestId: "req-live",
      hop: "run-credential" as const,
      event: "mint" as const,
      subjectId: "deadbeef",
      subjectKind: "credential-key" as const,
      evidenceDigest: "a".repeat(64),
      occurredAt: "2026-09-17T00:00:00.000Z",
      recordedAt: "2026-09-17T00:00:01.000Z",
    };
    recordLiveAuditLink(link);

    // It landed where the path function says it does — beside the round's
    // evidence, under QDS_E2E_EVIDENCE_DIR, never `.sandbox/audit.db`.
    expect(liveAuditStorePath()).toBe(join(evidenceDir, "audit-links.db"));
    expect(existsSync(liveAuditStorePath())).toBeTrue();

    // …and the READ path returns it, through the same production reader
    // `scripts/qds-audit.ts` walks with. Every field the chain joins on is
    // pinned: a link written under the wrong runId reads as `[]` here, which is
    // exactly how a live round's hop reports `unlinked` while the emit "worked".
    const rows = liveAuditLinksFor("harness-live-run");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "harness-live-run",
      repoSlug: "acme/widgets",
      requestId: "req-live",
      hop: "run-credential",
      event: "mint",
      subjectId: "deadbeef",
      subjectKind: "credential-key",
      evidenceDigest: "a".repeat(64),
      occurredAt: "2026-09-17T00:00:00.000Z",
    });
    // A runId the round never emitted for is `[]`, not "whatever is in the
    // store" — the scoping every tier assertion depends on.
    expect(liveAuditLinksFor("harness-live-run-other")).toEqual([]);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});
