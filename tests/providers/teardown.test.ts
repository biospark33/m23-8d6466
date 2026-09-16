/**
 * DF2.5 — the teardown half: six-step ordering, fail-closed aborts (AC3/AC6),
 * the harvest waiver, idempotent re-run, keyless runs, the CLI trigger
 * surface, and the MANDATORY e2e demo (DoD).
 *
 * Ordering assertions are SUBSEQUENCE checks over a recorded call-order array,
 * never equality against a fixed array — teardown.ts has four claimants
 * (DF2.5/DF4.2/DF2.8/DF5.3), each allowed to insert a step, so only the
 * relative order of the six fixed steps is the contract (story Technical
 * Notes). `close` is additionally asserted to be the LAST label overall.
 *
 * The reference implementation shipped teardown/reap unrun (R4 §3, §3.6), so
 * these tests are the blocking evidence, not inherited behaviour.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createRun, neverPublicDriver, startVisualizer, stopVisualizer, VIZ_PIDFILE } from "../../src/providers/driver.ts";
import type { ExecResult, ProviderAuditLink, ProviderDriver } from "../../src/providers/driver.ts";
import { HarvestError } from "../../src/providers/harvest.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { SBX_KEY_PREFIX } from "../../src/providers/credentials.ts";
import { bunGitRunner, type GitRunner } from "../../src/providers/harvest.ts";
import { teardownSandbox, TeardownError, type CostLedgerHook, type TeardownDeps } from "../../src/providers/teardown.ts";
// DF2.11: the handle factory, not path-joining — teardown's head check compares
// against the SAME resolution acquireRunLock performs, so a re-joined string
// would only pass by luck of an absolute runs dir.
import { acquireRunLock, releaseRunLock, type RunLockHandle } from "../../scripts/lib/run-lock.ts";
import { FakeKeyApi } from "./fixtures/fake-key-api.ts";
import { RecordingDriver } from "./fixtures/recording-driver.ts";
import { hostGit, makeOriginRepo, runLocal, cloneIntoBox, type OriginRepo } from "./fixtures/git-fixture.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "sandbox-teardown.ts");

let dir: string;
let store: RunRecordStore;
let api: FakeKeyApi;
let recording: RecordingDriver;
let driver: FakeDriver;
let logs: LogEntry[];
let restoreLog: (() => void) | undefined;
/**
 * DF1.10 AC4: the artifacts script now also probes the box's tmpfs `/run` and
 * the box user's `$HOME`. On the fake substrate it execs on the HOST, so
 * without these overrides the suite would read whatever happens to sit in the
 * real `/run` and the developer's real home. Empty per-test dirs — nothing in
 * this file exercises the AC4 sources; harvest.test.ts owns that.
 */
let boxRunRoot: string;
let boxHome: string;
/** mkdtemp roots owned by git-fixture helpers — cleaned in afterEach. */
const fixtureRoots: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df25-td-"));
  store = new RunRecordStore(join(dir, "runs"));
  api = new FakeKeyApi({ usageOnCreateUsd: 0.0081 });
  driver = new FakeDriver(join(dir, "boxes"));
  recording = new RecordingDriver(guardVizPidfile(driver));
  boxRunRoot = join(dir, "run");
  boxHome = join(dir, "home");
  mkdirSync(boxRunRoot, { recursive: true });
  mkdirSync(boxHome, { recursive: true });
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
});

afterEach(() => {
  // Release BEFORE the dir is swept: releaseRunLock reads back the body it
  // wrote, and rmSync-ing a claimed lock out from under the release would make
  // the failure look like a teardown bug rather than a fixture leak.
  for (const lock of locks.values()) releaseRunLock(lock);
  locks.clear();
  auditLinks = [];
  restoreLog?.();
  rmSync(dir, { recursive: true, force: true });
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * DF5.3: every deps() construction captures its audit links here; suites that
 * assert lifecycle behavior read `auditLinks` after the call. Reset per test
 * in beforeEach like the recording driver.
 */
let auditLinks: ProviderAuditLink[] = [];

function deps(overrides: Partial<TeardownDeps> = {}): TeardownDeps {
  // workdir "app": the fake box's clone target (impl default is the HOME-relative "src")
  return {
    driver: recording,
    store,
    keyApi: api,
    runsDir: store.dir,
    workdir: "app",
    boxRunRoot,
    boxHome,
    recordAuditLink: (link) => {
      auditLinks.push(link);
    },
    ...overrides,
  };
}

/**
 * DF2.11 AC1: the run lock is now teardownSandbox's third parameter, and the
 * handle is READ-ONLY to it (resolved and compared, never released) — so every
 * test mints a real handle with acquireRunLock and this file releases them all
 * in afterEach. Memoized per runId because acquire is not re-entrant in-process
 * and several tests tear the same run down twice (idempotent re-run, the
 * crash-window and F032 recoveries): a second lockFor(runId) must hand back the
 * same claim, not refuse as re-entrancy.
 */
const locks = new Map<string, RunLockHandle>();

function lockFor(runId: string): RunLockHandle {
  let lock = locks.get(runId);
  if (lock === undefined) {
    lock = acquireRunLock(store.dir, runId, "teardown-test");
    locks.set(runId, lock);
  }
  return lock;
}

function boxDir(vm: string): string {
  return join(dir, "boxes", vm);
}

/**
 * Guards the shared HOST pidfile before FakeDriver ever spawns a real
 * process for it. FakeDriver.exec (src/providers/fake-driver.ts) runs argv
 * as a REAL child process on this machine, and driver.ts's stopVisualizer
 * script hard-codes the absolute path VIZ_PIDFILE ("/tmp/qds-viz.pid"),
 * killing whatever pid is recorded there with NO identity check (unlike
 * visualizer/test/deploy.test.ts's isVizProcess, which verifies the pid's
 * command line before signalling — that file's tests deliberately spawn and
 * stop a real visualizer; nothing here does). Every teardownSandbox call in
 * this file that reaches a real box runs the prepended stopVisualizer step
 * unconditionally, so without this guard ANY of them — not just the two
 * DF4.2 ordering tests — would run the real kill script against a
 * developer's actual /tmp/qds-viz.pid if one happened to exist. Intercepting
 * here, between RecordingDriver and FakeDriver, keeps `recording.execCalls`
 * populated (existing leak-scan/argv assertions are unaffected) while
 * substituting the script's own routine "no pidfile" outcome instead of
 * ever letting FakeDriver spawn it for real. Tests that need a specific
 * stopVisualizer outcome still get one via orderDepsWithViz's
 * execArgvOverride seam, which is checked before this guard ever runs.
 */
function guardVizPidfile(inner: ProviderDriver): ProviderDriver {
  const guarded = Object.create(inner) as ProviderDriver;
  guarded.exec = (vm: string, argv: string[], stdin?: string): Promise<ExecResult> => {
    if (argv.some((a) => a.includes(VIZ_PIDFILE))) {
      return Promise.resolve({ stdout: "NONE\n", stderr: "", exitCode: 0 });
    }
    return inner.exec(vm, argv, stdin);
  };
  return guarded;
}

/** Any >=8-char substring of the secret found in any corpus, else null. */
function leakScan(secret: string, ...corpora: string[]): string | null {
  for (let i = 0; i + 8 <= secret.length; i++) {
    const frag = secret.slice(i, i + 8);
    for (const corpus of corpora) {
      if (corpus.includes(frag)) return frag;
    }
  }
  return null;
}

/** Mint `sbx-<runId>` and record its hash — the DF2.3 mint, minus the lifecycle. */
async function mintFor(runId: string): Promise<string> {
  const res = await api.createKey(`${SBX_KEY_PREFIX}${runId}`, 50);
  store.set(runId, { keyHash: res.hash, limitMicroUsd: 50_000_000 });
  return res.hash;
}

/** A bare host git repo — enough for harvest's `rev-parse --show-toplevel` gate. */
async function makeHostRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "qds-df25-host-"));
  fixtureRoots.push(root);
  const repo = join(root, "host");
  await runLocal(["git", "init", "-q", "-b", "main", repo]);
  return repo;
}

async function makeOrigin(commits = 3): Promise<OriginRepo> {
  const origin = await makeOriginRepo({ commits });
  fixtureRoots.push(origin.root);
  return origin;
}

/**
 * Clone `file://<originDir>` into the box as `app`, branch `sbx/<runId>` at
 * the pinned base, commit `commits` times, and optionally lay down the
 * artifacts tree (specs/ + run.log) the artifacts step tars back out.
 */
async function fillBox(
  vm: string,
  runId: string,
  originDir: string,
  commits: number,
  artifacts = false,
): Promise<void> {
  await cloneIntoBox(recording, vm, originDir, "app");
  const branch = await recording.exec(vm, ["git", "-C", "app", "checkout", "-q", "-b", `sbx/${runId}`]);
  if (branch.exitCode !== 0) throw new Error(`box branch failed: ${branch.stderr}`);
  for (let i = 1; i <= commits; i++) {
    const r = await recording.exec(vm, [
      "sh",
      "-c",
      `git -C app -c user.email=run@box -c user.name=run commit -q --allow-empty -m "box-${i}"`,
    ]);
    if (r.exitCode !== 0) throw new Error(`box commit ${i} failed: ${r.stderr}`);
  }
  if (artifacts) {
    const r = await recording.exec(vm, [
      "sh",
      "-c",
      "cd app && mkdir -p specs app_docs && echo '# spec' > specs/notes.md" +
        " && echo 'docs' > app_docs/readme.md && printf 'line1\\nline2\\n' > run.log",
    ]);
    if (r.exitCode !== 0) throw new Error(`artifacts setup failed: ${r.stderr}`);
  }
}

/**
 * Call-order harness: wraps keyApi (spend=retrieve-entry, revoke=DELETE,
 * verify=list), driver (destroy) and store (close), pushing one label per
 * wrapped call. The unwrapped originals still receive every call, so the
 * FakeKeyApi/RecordingDriver state stays authoritative.
 */
function orderDeps(base: Partial<TeardownDeps> = {}): { calls: string[]; links: ProviderAuditLink[]; deps: TeardownDeps } {
  const calls: string[] = [];
  const keyW = Object.create(api) as FakeKeyApi;
  keyW.getKeyEntry = (hash: string, maxPages?: number) => {
    calls.push("spend");
    return api.getKeyEntry(hash, maxPages);
  };
  keyW.deleteKey = (hash: string) => {
    calls.push("revoke");
    return api.deleteKey(hash);
  };
  keyW.listAllKeys = (maxPages: number) => {
    calls.push("verify");
    return api.listAllKeys(maxPages);
  };
  const driverW = Object.create(recording) as RecordingDriver;
  driverW.destroy = (vm: string) => {
    calls.push("destroy");
    return recording.destroy(vm);
  };
  const storeW = Object.create(store) as RunRecordStore;
  storeW.close = (runId: string, now?: Date) => {
    calls.push("close");
    return store.close(runId, now);
  };
  // DF5.3: the wrap captures the teardown link alongside the step labels.
  const links: ProviderAuditLink[] = [];
  return {
    calls,
    links,
    deps: {
      driver: driverW,
      store: storeW,
      keyApi: keyW,
      runsDir: store.dir,
      workdir: "app",
      boxRunRoot,
      boxHome,
      recordAuditLink: (link) => {
        links.push(link);
      },
      ...base,
    },
  };
}

/**
 * DF4.2: `orderDeps` above wraps only the four claimants it already knows
 * about (spend/revoke/destroy/close) — it cannot see the prepended
 * `stopVisualizer` step because that step never touches keyApi/destroy/close,
 * it goes through `driver.exec` alone. This variant additionally wraps `exec`
 * to recognize DF4.2's fixed pidfile path (`VIZ_PIDFILE`, imported from
 * src/providers/driver.ts rather than duplicated here, so a future path
 * change can't silently desync this wrapper) and push
 * "stopVisualizer" onto the SAME `calls` array before delegating — giving one
 * combined, correctly-ordered timeline instead of two separate ones that
 * would need cross-referencing by timestamp. `execArgvOverride`, when given,
 * runs first and can substitute a rejection for the real exec (AC6's failure
 * demonstration) — the label is still pushed either way, matching the fact
 * that teardown calls the step regardless of its outcome.
 */
function orderDepsWithViz(
  base: Partial<TeardownDeps> = {},
  execArgvOverride?: (vm: string, argv: string[], stdin: string | undefined) => Promise<ExecResult> | undefined,
): { calls: string[]; deps: TeardownDeps } {
  const { calls, deps: d } = orderDeps(base);
  const inner = d.driver as RecordingDriver;
  const driverW = Object.create(inner) as RecordingDriver;
  driverW.exec = (vm: string, argv: string[], stdin?: string) => {
    if (argv.some((a) => a.includes(VIZ_PIDFILE))) {
      calls.push("stopVisualizer");
      const overridden = execArgvOverride?.(vm, argv, stdin);
      if (overridden !== undefined) return overridden;
    }
    return inner.exec(vm, argv, stdin);
  };
  return { calls, deps: { ...d, driver: driverW } };
}

/**
 * SUBSEQUENCE assertion (the four-claimant contract): spend before revoke
 * before destroy before close, and close is the very last label recorded —
 * never equality against a fixed array.
 */
function assertTeardownOrder(calls: string[]): void {
  const spend = calls.indexOf("spend");
  const revoke = calls.indexOf("revoke");
  const destroy = calls.indexOf("destroy");
  const close = calls.indexOf("close");
  expect(spend).toBeGreaterThanOrEqual(0);
  expect(revoke).toBeGreaterThan(spend);
  expect(destroy).toBeGreaterThan(revoke);
  expect(close).toBeGreaterThan(destroy);
  expect(calls[calls.length - 1]).toBe("close");
}

async function makeRun(runId: string): Promise<void> {
  await createRun(recording, store, { runId, recordAuditLink: (l) => auditLinks.push(l) });
}

// ─── DF2.11: the teardown lock — AC1 required branded handle, AC2 mismatch ────

describe("DF2.11 teardown lock (AC1/AC2)", () => {
  /** Destroy counter over the shared recording driver — the zero-mutation proof. */
  function countingDriver(): { driver: ProviderDriver; destroys(): number } {
    let destroys = 0;
    const driverW = Object.create(recording) as RecordingDriver;
    driverW.destroy = (vm: string) => {
      destroys++;
      return recording.destroy(vm);
    };
    return { driver: driverW, destroys: () => destroys };
  }

  test("AC1 pin: the two-argument call does not compile — and at runtime refuses as teardown-lock-mismatch, zero mutations", async () => {
    const h = countingDriver();
    // bun does not typecheck, so the pinned call below EXECUTES — and that is
    // the point: the head check must refuse an ABSENT handle as the contract
    // error before ctx, before getRecord. The record here does not even exist,
    // so a teardown that got PAST the head check would surface as no-record,
    // never as the mismatch this test demands.
    // @ts-expect-error — DF2.11 AC1: the two-argument call must not compile; if the lock param ever becomes optional this directive goes unused and tsc reds the gate
    const missing = teardownSandbox(deps({ driver: h.driver }), "df211-arity-pin");
    // The refusal is captured OUTSIDE the try: expect.unreachable inside the
    // try whose catch it distinguishes from gets swallowed by that very catch,
    // and the regression surfaces as an object-dump from the instance check
    // instead of the named refusal. A resolved (non-refusing) teardown leaves
    // `refused` undefined and fails on the named line below.
    let refused: unknown;
    try {
      await missing;
    } catch (e) {
      refused = e;
    }
    expect(refused, "teardown without a lock must refuse").toBeInstanceOf(TeardownError);
    expect((refused as TeardownError).code).toBe("teardown-lock-mismatch");
    expect(h.destroys()).toBe(0);
  });

  test("AC1 pin: a bare string in the lock position does not compile (the brand, not just the arity) — and refuses at runtime too", async () => {
    const h = countingDriver();
    const runId = "df211-brand-pin";
    store.create(runId);
    // A DIFFERENT filename on purpose: `join(store.dir, `${runId}.lock`)` would
    // resolve-match the expected path (this runs dir is absolute) and the
    // runtime twin below would tear the run down FOR REAL. "forged.lock" is
    // what a type-weakening escape hatch lets through, and the head check must
    // still refuse it: mismatch, zero mutations, record open.
    // @ts-expect-error — DF2.11 AC1: a forged bare string must not compile; the brand (not merely the arity) is pinned, so a `string`-typed hole makes this directive go unused and tsc reds the gate
    const forged = teardownSandbox(deps({ driver: h.driver }), runId, join(store.dir, "forged.lock"));
    // Same shape as the arity pin above: the catch must not swallow the
    // named-unreachable diagnostic it exists to produce.
    let refused: unknown;
    try {
      await forged;
    } catch (e) {
      refused = e;
    }
    expect(refused, "teardown with a forged lock path must refuse").toBeInstanceOf(TeardownError);
    expect((refused as TeardownError).code).toBe("teardown-lock-mismatch");
    expect(h.destroys()).toBe(0);
    expect(store.get(runId).closedAt).toBeUndefined();
  });

  test("AC2: a handle minted for ANOTHER run aborts teardown-lock-mismatch before any mutation", async () => {
    const h = countingDriver();
    store.create("df211-mismatch-b"); // the record teardown is pointed at
    let err: unknown;
    try {
      await teardownSandbox(deps({ driver: h.driver }), "df211-mismatch-b", lockFor("df211-mismatch-a"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TeardownError);
    expect((err as TeardownError).code).toBe("teardown-lock-mismatch");
    expect((err as TeardownError).remediation).toContain("acquireRunLock");
    // Nothing ran: no destroy, no close — the reaper still finds the record open.
    expect(h.destroys()).toBe(0);
    expect(store.get("df211-mismatch-b").closedAt).toBeUndefined();
  });
});

// ─── 1. DoD ordering ─────────────────────────────────────────────────────────

describe("DF2.5 teardownSandbox", () => {
  test("DoD order: spend → revoke → destroy, close LAST (subsequence, not equality)", async () => {
    const runId = "df25-order";
    const host = await makeHostRepo();
    await makeRun(runId);
    await mintFor(runId);
    // DF5.3: the emit needs the DF2.8 attribution — the ONLY repoSlug source.
    store.set(runId, { extensions: { budget: { repoSlug: "qds/demo", issueId: "7" } } });
    const h = orderDeps({ gitCwd: host });
    const lock = lockFor(runId);

    await teardownSandbox(h.deps, runId, lock);

    assertTeardownOrder(h.calls);
    expect(store.get(runId).closedAt).toBeString();
    // DF5.3: the revoke+verify-revoked links ride the forwarded credential
    // deps (steps 4–5), and exactly one teardown link lands AFTER close — the
    // event completed, and the detail carries the closedAt it stamped.
    expect(h.links.map((l) => `${l.hop}.${l.event}`)).toEqual([
      "run-credential.revoke",
      "run-credential.verify-revoked",
      "run-box.teardown",
    ]);
    expect(h.links[2]?.detail).toMatchObject({ closedAt: store.get(runId).closedAt });
    // destroy really ran: the fake box directory is gone
    expect(existsSync(boxDir(runId))).toBeFalse();
    // DF2.11 AC1's read-only half, on disk rather than through the memoized
    // fixture: the handle is resolved-and-compared, never released, so the
    // caller's lock file must still exist after a SUCCESSFUL teardown. (A
    // lockFor()-based re-acquire here could not prove it — the memoization
    // would hand back the same handle even if teardown had unlinked the file.)
    expect(existsSync(lock)).toBeTrue();
  }, 30_000);

  /**
   * DF1.10 AC4. `orderDeps` wraps the four claimants that touch keyApi/destroy/
   * close; the artifacts pull touches none of them — it is a `driver.exec` —
   * so nothing here had ever pinned its POSITION, only that it happened.
   * AC4 makes the position load-bearing: the tar now carries the tmpfs marker
   * and trace sidecar, which `destroy` annihilates, and the resident/engine
   * audit evidence, which `revoke` makes unre-fetchable. Both must already be
   * on the host before either step runs. Subsequence, per the file header —
   * a later story may still prepend steps.
   */
  test("DF1.10 AC4: the artifacts pull stays STEP 2, ahead of revoke and destroy", async () => {
    const runId = "df25-order-artifacts";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);

    // The ORIGIN is the host repo here (as in the artifact-pipeline test
    // below): harvest must reach its artifacts step, and a bare `git init`
    // host lacks the pinned base, so bundle verify would abort at step 3
    // before the ordering this test exists to pin could be observed.
    const h = orderDeps({ gitCwd: origin.originDir });
    const inner = h.deps.driver;
    const driverW = Object.create(inner) as typeof inner;
    driverW.exec = (vm: string, argv: string[], stdin?: string) => {
      // Same detector the artifact-pipeline test below uses: the Step E script
      // is the one that names the staging tar.
      if (stdin?.includes("harvest-artifacts.tgz")) h.calls.push("artifacts");
      return inner.exec(vm, argv, stdin);
    };

    await teardownSandbox({ ...h.deps, driver: driverW }, runId, lockFor(runId));

    const artifacts = h.calls.indexOf("artifacts");
    expect(artifacts).toBeGreaterThanOrEqual(0);
    // `indexOf` returns -1 for an ABSENT step and `artifacts` is >= 0, so the
    // comparison below is satisfied by a teardown that skipped the spend claim
    // entirely. Prove the step ran before ordering against it. (The revoke and
    // destroy comparisons are safe: `artifacts < -1` is impossible.)
    expect(h.calls).toContain("spend");
    expect(artifacts).toBeGreaterThan(h.calls.indexOf("spend"));
    expect(artifacts).toBeLessThan(h.calls.indexOf("revoke"));
    expect(artifacts).toBeLessThan(h.calls.indexOf("destroy"));
    // Exactly one pull: artifactsOwnedByCaller still suppresses harvestRun's
    // own Step E, so widening the tar did not double the box-side work.
    expect(h.calls.filter((c) => c === "artifacts")).toHaveLength(1);
    assertTeardownOrder(h.calls);
    expect(existsSync(join(store.dir, `${runId}-artifacts`, "run.log"))).toBeTrue();
    // Round 4, P43: the success arm's clear is GATED on a stale loss — a
    // first-time success must not grow a teardown extension it never needed.
    expect(store.get(runId).extensions?.teardown).toBeUndefined();
  }, 30_000);

  test("DF1.10 AC4: TeardownDeps.boxRunRoot/boxHome really reach the artifacts script's argv", async () => {
    // The two seams are documented as "forwarded verbatim to the artifacts
    // step's HarvestDeps", and nothing asserted it. If teardown ever built its
    // HarvestDeps from an explicit field list, the fields would be accepted and
    // silently DROPPED, and every fake-substrate suite here would go back to
    // probing the host's real `/run` and `$HOME` while staying green.
    const runId = "df110-seam-forward";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);

    let seen: string[] = [];
    const inner = recording;
    const driverW = Object.create(inner) as typeof inner;
    driverW.exec = (vm: string, argv: string[], stdin?: string) => {
      if (stdin?.includes("harvest-artifacts.tgz")) seen = argv;
      return inner.exec(vm, argv, stdin);
    };

    await teardownSandbox({ ...deps({ gitCwd: origin.originDir }), driver: driverW }, runId, lockFor(runId));

    // Positional 5 is the run root and 6 the home — this test's dirs, not the
    // host's `/run` and `$HOME`.
    expect(seen).toEqual(["bash", "-s", "--", runId, boxRunRoot, boxHome]);
  }, 30_000);

  test("DF1.10: an artifacts FAILURE is loud and NON-FATAL — revoke and destroy still run", async () => {
    // A box that cannot be destroyed bills forever, and the artifacts tar reads
    // a name space the WORKLOAD controls: one `ln -s /etc/passwd
    // ~/<runId>-solicit-9-reply.txt` used to make the host validator refuse the
    // whole archive, which aborted teardown at step 2 — before `destroy`. The
    // aged-record reaper then tore down through this same path and re-aborted on
    // every sweep, so the box was stuck alive permanently. The pull keeps its
    // AC4 position; only the failure arm continues.
    const runId = "df110-artifacts-nonfatal";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);

    const h = orderDeps({ gitCwd: origin.originDir });
    const inner = h.deps.driver;
    const driverW = Object.create(inner) as typeof inner;
    driverW.exec = async (vm: string, argv: string[], stdin?: string): Promise<ExecResult> => {
      if (stdin?.includes("harvest-artifacts.tgz")) {
        h.calls.push("artifacts");
        // A real in-box failure shape, and pointedly NOT a gone box: this is the
        // arm that used to re-throw out of `runBoxStep`.
        return { stdout: "", stderr: "tar: cannot stat: No such file or directory", exitCode: 2 };
      }
      return inner.exec(vm, argv, stdin);
    };

    await teardownSandbox({ ...h.deps, driver: driverW }, runId, lockFor(runId));

    // The box came DOWN and the record closed — the whole point.
    expect(h.calls).toContain("destroy");
    expect(existsSync(boxDir(runId))).toBeFalse();
    expect(store.get(runId).closedAt).toBeString();
    assertTeardownOrder(h.calls);
    // And the FAILURE kept the position the success path pins (above):
    // `assertTeardownOrder` reasons only about spend/revoke/destroy/close and
    // IGNORES the injected "artifacts" marker, so without these comparisons a
    // retry of the pull AFTER revoke — or after destroy, when the evidence is
    // ash — would pass this test while the success path looks fully pinned.
    const artifacts = h.calls.indexOf("artifacts");
    expect(artifacts).toBeGreaterThanOrEqual(0);
    expect(h.calls.filter((c) => c === "artifacts")).toHaveLength(1); // no re-pull later
    expect(artifacts).toBeGreaterThan(h.calls.indexOf("spend"));
    expect(artifacts).toBeLessThan(h.calls.indexOf("revoke"));
    expect(artifacts).toBeLessThan(h.calls.indexOf("destroy"));
    // And it was LOUD: its own error-status line, carrying the typed code and
    // saying in as many words that teardown continued on purpose.
    const line = logs.find((l) => l.operation === "teardown.artifacts_failed");
    expect(line).toBeDefined();
    expect((line as { status?: string }).status).toBe("error");
    expect((line as { outcome?: string }).outcome).toBe("continued");
    expect((line as { error?: { code?: string } }).error?.code).toBe("artifacts-failed");
    expect(String((line as { reason?: string }).reason)).toContain("bills forever");
    // No artifacts landed — nothing pretended the pull half-succeeded.
    expect(existsSync(join(store.dir, `${runId}-artifacts`))).toBeFalse();
    // #221: the loss is also ON THE RECORD — `fleet status` reads
    // `extensions.teardown` instead of grepping the log stream. The write is
    // best-effort but this store is healthy, so it must have landed.
    const rec = store.get(runId);
    const ext = rec.extensions?.teardown as { artifactsCode?: string; artifactsFailedAt?: string } | undefined;
    expect(ext?.artifactsCode).toBe("artifacts-failed");
    expect(ext?.artifactsFailedAt).toBeString();
    // Round 5 (FX-K item 8): `Date.parse(...)` of a garbage string is NaN,
    // and NaN IS a number — `toBeNumber()` could not fail for any string
    // value. The honest claim is the negative one: the timestamp parses.
    expect(Number.isNaN(Date.parse(ext?.artifactsFailedAt ?? ""))).toBeFalse();
  }, 30_000);

  test("round 4 P42: an artifacts rejection carrying a NON-STRING message cannot resurrect the pre-destroy gate", async () => {
    // `(err.message ?? String(e)).slice(...)` threw on a rejection shaped
    // {message: 42} — the message is non-nullish so `??` keeps it, and
    // `.slice` on a number is a TypeError raised INSIDE the catch. That
    // aborted teardown before revoke/destroy, and the reaper re-aborted
    // through the same path on every sweep: the exact immortal-box outcome
    // runArtifactsStep exists to make impossible. `String()` coercion is the
    // fix (step-log.ts normalizes the same shape for the same reason).
    const runId = "r4-p42-nonstring-message";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);

    const h = orderDeps({ gitCwd: origin.originDir });
    const inner = h.deps.driver;
    const driverW = Object.create(inner) as typeof inner;
    driverW.exec = async (vm: string, argv: string[], stdin?: string): Promise<ExecResult> => {
      if (stdin?.includes("harvest-artifacts.tgz")) {
        // Not a gone box and not an exit code: the exec itself REJECTS with a
        // non-Error whose message is non-nullish and non-string — the one
        // shape that survived `??` and then broke `.slice`.
        return Promise.reject({ message: 42 });
      }
      return inner.exec(vm, argv, stdin);
    };

    await teardownSandbox({ ...h.deps, driver: driverW }, runId, lockFor(runId));

    // The gate stayed removed: the box came down and the record closed.
    expect(existsSync(boxDir(runId))).toBeFalse();
    expect(store.get(runId).closedAt).toBeString();
    // The loss entry carries the COERCED message, not a crash — and the
    // loud line was still emitted (the failure is reported, only ungated).
    expect(logs.find((l) => l.operation === "teardown.artifacts_failed")).toBeDefined();
    const ext = store.get(runId).extensions?.teardown as { artifactsCode?: string; artifactsMessage?: string };
    expect(ext?.artifactsCode).toBe("artifacts-failed");
    expect(ext?.artifactsMessage).toBe("42");
  }, 30_000);

  test("round 4 P43: a later SUCCESSFUL pull clears a stale artifacts-loss entry — #221's record half cuts both ways", async () => {
    // The store's per-namespace merge RETAINS omitted fields, so attempt 1's
    // loss survived attempt 2's success and `fleet status` kept reporting
    // "torn down, artifacts lost" for a run whose bundle sits on disk. The
    // success arm now writes the three fields EMPTY — the value status's
    // renderer (`artifactsLostFields`) already reads as "no loss".
    const runId = "r4-p43-stale-loss";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);

    // Attempt 1's loss, exactly as the failure arm writes it (#221) — this
    // teardown is the RETRY that pulls successfully and closes.
    store.set(runId, {
      extensions: {
        teardown: {
          schemaVersion: 1,
          artifactsCode: "artifacts-failed",
          artifactsMessage: "boom",
          artifactsFailedAt: new Date().toISOString(),
        },
      },
    });

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId, lockFor(runId));

    // Superseded, not retained…
    const ext = store.get(runId).extensions?.teardown as {
      artifactsCode?: string;
      artifactsMessage?: string;
      artifactsFailedAt?: string;
    };
    expect(ext?.artifactsCode).toBe("");
    expect(ext?.artifactsMessage).toBe("");
    expect(ext?.artifactsFailedAt).toBe("");
    // …and the clear describes a REAL pull: the bundle landed.
    expect(existsSync(join(store.dir, `${runId}-artifacts`, "run.log"))).toBeTrue();
  }, 30_000);

  test("round 4 H4: a RELATIVE boxRunRoot is a non-fatal artifacts loss carrying box-root-invalid — the box still comes down", async () => {
    // The non-fatal arm had exactly ONE exercised error shape (an `exitCode: 2`
    // stub wrapped as artifacts-failed). This one throws BEFORE any box exec —
    // `assertBoxRootSeam` refuses a relative root for tar's `-C` reason — and a
    // plausible "tightening" refactor that narrowed the catch to "only
    // artifacts-failed codes continue" would re-gate teardown before destroy
    // on exactly this shape: the immortal-box bug this PR is the post-mortem
    // of, back through a different door.
    const runId = "r4-h4-relative-root";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);

    await teardownSandbox(deps({ gitCwd: origin.originDir, boxRunRoot: "run" }), runId, lockFor(runId));

    // Teardown COMPLETED: box destroyed, record closed — the catch stayed broad.
    expect(existsSync(boxDir(runId))).toBeFalse();
    expect(store.get(runId).closedAt).toBeString();
    // And the loss was loud, carrying the NON-artifacts-failed code: the
    // `teardown.artifacts_failed` line names box-root-invalid…
    const line = logs.find((l) => l.operation === "teardown.artifacts_failed");
    expect(line).toBeDefined();
    expect((line as { error?: { code?: string } }).error?.code).toBe("box-root-invalid");
    // …and the record extension (#221) passes it through for `fleet status`.
    const ext = store.get(runId).extensions?.teardown as { artifactsCode?: string };
    expect(ext?.artifactsCode).toBe("box-root-invalid");
    // Nothing pretended the pull half-succeeded.
    expect(existsSync(join(store.dir, `${runId}-artifacts`))).toBeFalse();
  }, 30_000);

  test("round 4 H4: a workdir-invalid throw gets the same non-fatal artifacts arm — then the AC3 harvest gate is what aborts", async () => {
    // The second error shape, and it lands DIFFERENTLY on purpose: a bad
    // `workdir` is refused inside pullArtifacts' step (non-fatal, loss
    // recorded) but ALSO inside harvestRun's Step A build — and that one is
    // the AC3 harvest gate, which aborts fail-closed before revoke/destroy.
    // Pinning both halves keeps a future reader from "fixing" the artifacts
    // step into an abort by pointing at this test.
    const runId = "r4-h4-workdir-invalid";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);

    let err: unknown;
    try {
      await teardownSandbox(deps({ gitCwd: origin.originDir, workdir: "app; rm" }), runId, lockFor(runId));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TeardownError);
    expect((err as TeardownError).code).toBe("workdir-invalid"); // asTeardownError preserved it

    // The artifacts step itself stayed NON-FATAL: loud line + record loss,
    // both carrying workdir-invalid.
    const line = logs.find((l) => l.operation === "teardown.artifacts_failed");
    expect(line).toBeDefined();
    expect((line as { error?: { code?: string } }).error?.code).toBe("workdir-invalid");
    const ext = store.get(runId).extensions?.teardown as { artifactsCode?: string };
    expect(ext?.artifactsCode).toBe("workdir-invalid");
    // …but the HARVEST gate aborted fail-closed (AC3, correct): box alive,
    // record open — the reaper retries, it never destroys blind.
    expect(existsSync(boxDir(runId))).toBeTrue();
    expect(store.get(runId).closedAt).toBeUndefined();
  }, 30_000);

  // ─── 2. AC3 — harvest failure aborts before revoke/destroy ────────────────

  test("AC3: bundle verify failure aborts teardown before revoke/destroy — box alive, key live, record open", async () => {
    const runId = "df25-ac3";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);
    const hash = store.get(runId).keyHash as string;

    // Fail ONLY the run bundle's `git bundle verify` — the preflight probe's
    // verify (a probe.bundle in its own mkdtemp, argv never containing the
    // run id) must still pass, or the failure would be misclassified as
    // bundle-verify-unavailable instead of a harvest failure.
    const argvs: string[][] = [];
    const failRunVerify: GitRunner = async (argv: readonly string[], cwd: string) => {
      argvs.push([...argv]);
      if (argv.includes("verify") && argv.some((a) => a.includes(runId))) {
        return { stdout: "", stderr: "error: Repository lacks these prerequisite commits", exitCode: 1 };
      }
      return bunGitRunner(argv, cwd);
    };

    let err: unknown;
    try {
      await teardownSandbox(deps({ gitCwd: origin.originDir, gitRunner: failRunVerify }), runId, lockFor(runId));
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();

    // box alive
    expect(existsSync(boxDir(runId))).toBeTrue();
    // key still live at the provider
    const list = await api.listAllKeys(20);
    expect(list.entries.some((k) => k.hash === hash)).toBeTrue();
    expect(list.truncated).toBeFalse();
    // record open
    expect(store.get(runId).closedAt).toBeUndefined();
    // the failed verify never reached a fetch: no refs/sandbox/, no fetch argv
    expect(argvs.some((a) => a.includes("fetch"))).toBeFalse();
    // verify ran but failed (the run bundle verify aborted before fetch)
    expect(argvs.some((a) => a.includes("verify") && a.some((x) => x.includes(runId)))).toBeTrue();
    expect(await hostGit(origin.originDir, ["for-each-ref", "--format=%(refname)", "refs/sandbox/"])).toBe("");
  }, 30_000);

  // ─── 3. AC4 — zero-commit branch is a no-op, teardown proceeds ────────────

  test("AC4: branch at base (zero commits) — harvested: none, no bundle file, teardown completes, record closed", async () => {
    const runId = "df25-ac4";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 0, true);

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId, lockFor(runId));

    expect(store.get(runId).closedAt).toBeString();
    // the empty-bundle refusal is a successful no-op: no ref, no bundle file
    expect(await hostGit(origin.originDir, ["for-each-ref", "--format=%(refname)", "refs/sandbox/"])).toBe("");
    expect(existsSync(join(store.dir, `${runId}.bundle`))).toBeFalse();
    // and it is logged as none, not silently swallowed — parsed off the
    // harvest summary line, never substring-matched against the whole stream
    const summary = logs.filter((l) => "harvested" in l);
    expect(summary.length).toBeGreaterThan(0);
    expect(String(summary[0]?.harvested)).toBe("none");
  }, 30_000);

  // ─── 4. AC6 — preflight: bundle verify unavailable ────────────────────────

  test("AC6 preflight: git bundle verify unavailable — bundle-verify-unavailable, ZERO mutations, box alive, record open", async () => {
    const runId = "df25-ac6-preflight";
    const host = await makeHostRepo();
    await makeRun(runId);
    await mintFor(runId);
    const hash = store.get(runId).keyHash as string;

    let destroys = 0;
    const driverW = Object.create(recording) as RecordingDriver;
    driverW.destroy = (vm: string) => {
      destroys++;
      return recording.destroy(vm);
    };

    const brokenRunner: GitRunner = async () => ({
      stdout: "",
      stderr: "sh: git: command not found",
      exitCode: 127,
    });

    let err: unknown;
    try {
      await teardownSandbox(deps({ gitCwd: host, gitRunner: brokenRunner, driver: driverW }), runId, lockFor(runId));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TeardownError);
    expect((err as TeardownError).code).toBe("bundle-verify-unavailable");
    // preflight runs before ANY mutation: no destroy, no DELETE, no spend write
    expect(destroys).toBe(0);
    expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    expect(store.get(runId).spendMicroUsd).toBeUndefined();
    // box alive, key still live, record open
    expect(existsSync(boxDir(runId))).toBeTrue();
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeTrue();
    expect(store.get(runId).closedAt).toBeUndefined();
  }, 30_000);

  // ─── 5. AC6 — unconfirmed destroy ─────────────────────────────────────────

  test("AC6: driver cannot confirm destroy — record open, key already revoked+verified, failure logged", async () => {
    const runId = "df25-ac6-destroy";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);
    const hash = store.get(runId).keyHash as string;

    // destroy throws BEFORE reaching the inner rmSync — an unconfirmed destroy
    const driverW = Object.create(recording) as RecordingDriver;
    driverW.destroy = () => Promise.reject(new Error("substrate could not confirm destroy: box still listed"));

    let err: unknown;
    try {
      await teardownSandbox(deps({ gitCwd: origin.originDir, driver: driverW }), runId, lockFor(runId));
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // a run is never marked torn down on an unconfirmed destroy
    expect(store.get(runId).closedAt).toBeUndefined();
    // the wrapper never called through: the box is physically alive
    expect(existsSync(boxDir(runId))).toBeTrue();
    // revoke+verify DID run before destroy was attempted (allowed — destroy
    // follows them in the fixed order): the key is gone from the list
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeFalse();
    // the failure is recorded in the log stream, not silently swallowed
    expect(logs.some((l) => l.status === "error")).toBeTrue();
  }, 30_000);

  // ─── 6. INV-4 — spend before revoke; no host key file ─────────────────────

  test("INV-4: spend read before revoke (zeroing double), spendMicroUsd in closed record, no host key file", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.0081, zeroUsageOnDelete: true });
    const runId = "df25-inv4";
    const host = await makeHostRepo();
    await makeRun(runId);
    await mintFor(runId);
    const h = orderDeps({ gitCwd: host });

    await teardownSandbox(h.deps, runId, lockFor(runId));

    assertTeardownOrder(h.calls);
    const rec = store.get(runId);
    expect(rec.closedAt).toBeString();
    // 0.0081 USD read BEFORE the DELETE zeroed usage — a post-revoke read
    // would see 0 and an implementation that skipped spend leaves undefined
    expect(rec.spendMicroUsd).toBe(8100);
    // DEVIATION (recorded): DF2.3 delivers the key via exec stdin; there is no
    // host-side key file to shred — destroy IS the shred. Assert no `.key`
    // file was ever created under runsDir.
    expect(readdirSync(store.dir).filter((f) => f.endsWith(".key"))).toHaveLength(0);
  }, 30_000);

  // ─── 7. --no-harvest waiver ───────────────────────────────────────────────

  test("--no-harvest: waiver logged, record key set unchanged, no refs/sandbox despite box commits, teardown completes", async () => {
    const runId = "df25-waive";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);
    const beforeKeys = Object.keys(JSON.parse(readFileSync(store.path(runId), "utf8")) as object).sort();

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId, lockFor(runId), { noHarvest: true });

    // record closed; the only new keys are the sanctioned spend write + close
    expect(store.get(runId).closedAt).toBeString();
    const afterKeys = Object.keys(JSON.parse(readFileSync(store.path(runId), "utf8")) as object).sort();
    const added = afterKeys.filter((k) => !beforeKeys.includes(k));
    expect(added).toEqual(["closedAt", "spendMicroUsd"]);
    // the waiver went to the RUN LOG, never the record
    expect(JSON.stringify(logs)).toContain("teardown.harvest_waived");
    // harvest was NOT called: the box HAD commits, yet no sandbox ref exists
    expect(await hostGit(origin.originDir, ["for-each-ref", "--format=%(refname)", "refs/sandbox/"])).toBe("");
    expect(existsSync(join(store.dir, `${runId}.bundle`))).toBeFalse();
  }, 30_000);

  // ─── 7b. Artifact-pipeline ownership — exactly one pull per teardown ──────

  test("teardown owns the artifact pipeline: exactly one artifacts exec per successful teardown", async () => {
    const runId = "df25-onepull";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);

    // Count in-box artifacts-tar execs by their script content (the recording
    // fixture keeps only argv + hadStdin, so wrap exec to see stdin).
    let artifactsPulls = 0;
    const driverW = Object.create(recording) as RecordingDriver;
    const innerExec = recording.exec.bind(recording);
    driverW.exec = (vm: string, argv: string[], stdin?: string) => {
      if (stdin?.includes("harvest-artifacts.tgz")) artifactsPulls++;
      return innerExec(vm, argv, stdin);
    };

    await teardownSandbox(deps({ gitCwd: origin.originDir, driver: driverW }), runId, lockFor(runId));

    // Step 2 (teardown.artifacts) pulled once; harvestRun skipped its Step E
    // via artifactsOwnedByCaller — a second pull here is the regression.
    expect(artifactsPulls).toBe(1);
    expect(store.get(runId).closedAt).toBeString();
    expect(existsSync(join(store.dir, `${runId}-artifacts`, "run.log"))).toBeTrue();
  }, 30_000);

  // ─── 8. Idempotent re-run ─────────────────────────────────────────────────

  test("idempotent re-run: second teardown is all-skipped, exit ok, closedAt unchanged (first-close-wins)", async () => {
    const runId = "df25-idem";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId, lockFor(runId));
    const firstClosedAt = store.get(runId).closedAt;
    expect(firstClosedAt).toBeString();

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId, lockFor(runId));

    expect(store.get(runId).closedAt).toBe(firstClosedAt);
    // the re-harvest of an already-fetched ref is --force in place: still 3
    expect(await hostGit(origin.originDir, ["rev-parse", "--verify", `refs/sandbox/${runId}`])).toBeString();
  }, 30_000);

  // ─── 9. No-key run ────────────────────────────────────────────────────────

  test("no-key run: spend/revoke/verify skipped, keyApi omitted from deps entirely, completes", async () => {
    const runId = "df25-nokey";
    const host = await makeHostRepo();
    await makeRun(runId);
    store.set(runId, { commitSha: "0123456789abcdef0123456789abcdef01234567" });
    // no keyHash, and deps carries NO keyApi field at all — works offline
    const keyless: TeardownDeps = { driver: recording, store, runsDir: store.dir, gitCwd: host, workdir: "app", boxRunRoot, boxHome, recordAuditLink: (l) => auditLinks.push(l) };

    await teardownSandbox(keyless, runId, lockFor(runId));

    expect(store.get(runId).closedAt).toBeString();
    expect(existsSync(boxDir(runId))).toBeFalse();
  }, 30_000);

  test("no-key run call order: spend/revoke/verify absent from harness, artifacts/harvest/destroy/close ran (logs + harness)", async () => {
    const runId = "df25-nokey-order";
    const host = await makeHostRepo();
    await makeRun(runId);
    store.set(runId, { commitSha: "0123456789abcdef0123456789abcdef01234567" });
    // orderDeps provides wrapped driver/store; we omit keyApi entirely (no key = no spend/revoke/verify)
    const h = orderDeps({ gitCwd: host });
    // keyApi is optional in TeardownDeps; unsetting it simulates a keyless run
    h.deps.keyApi = undefined;

    await teardownSandbox(h.deps, runId, lockFor(runId));

    // harness records destroy/close, not artifacts/harvest (those are git ops)
    expect(h.calls).toContain("destroy");
    expect(h.calls).toContain("close");
    // spend/revoke/verify NEVER appear — no keyApi, so these steps skip
    expect(h.calls).not.toContain("spend");
    expect(h.calls).not.toContain("revoke");
    expect(h.calls).not.toContain("verify");
    // artifacts + harvest steps ran (logged, not in harness)
    expect(logs.some((l) => l.operation === "teardown.artifacts")).toBeTrue();
    expect(logs.some((l) => l.operation === "teardown.harvest")).toBeTrue();
  }, 30_000);

  // ─── 9a. No-VM guard ───────────────────────────────────────────────────────

  test("no-VM record: teardown completes, destroy attempted via the runId fallback (idempotent no-op), record closes", async () => {
    const runId = "df25-novm";
    store.create(runId); // a record that never got a VM — but it DID get a key
    const hash = await mintFor(runId);

    await teardownSandbox(deps(), runId, lockFor(runId));

    expect(store.get(runId).closedAt).toBeString();
    // the key lifecycle still ran end to end on the way past (spend → revoke → verify)
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeFalse();
    // F6: destroy no longer SKIPS on a vmName-less record — it runs against
    // the runId-named box (idempotent no-op when none exists).
    const destroy = logs.find((l) => l.operation === "teardown.destroy");
    expect(destroy?.outcome).toBe("ran");
  }, 30_000);

  test("no-VM record call order: destroy present (runId fallback), close last, key lifecycle runs", async () => {
    const runId = "df25-novm-order";
    store.create(runId); // no vmName — destroy falls back to the run id
    const hash = await mintFor(runId);
    const h = orderDeps();

    await teardownSandbox(h.deps, runId, lockFor(runId));

    // F6: destroy RUNS (fallback handle), before close
    expect(h.calls).toContain("destroy");
    expect(h.calls.indexOf("destroy")).toBeLessThan(h.calls.indexOf("close"));
    // close still runs (last)
    expect(h.calls[h.calls.length - 1]).toBe("close");
    // key lifecycle still ran
    expect(h.calls).toContain("spend");
    expect(h.calls).toContain("revoke");
    expect(h.calls).toContain("verify");
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeFalse();
  }, 30_000);

  test("F6 (2026-08-24): vmName-less OPEN record destroys the runId-named live box — the INV-1 crash window cannot leak", async () => {
    // Port of live repro e2e-repro6d: `store.create` → `driver.create` →
    // crash before `store.set(vmName)` leaves a live box named after the run
    // id. The old code skipped destroy on vmName-less records and exited
    // reporting "torn down" — the box kept billing. teardownRun (driver.ts)
    // has always fallen back to the run id; teardownSandbox must too.
    const runId = "df25-f6-fallback";
    store.create(runId); // record open, vmName never written
    await driver.create(runId); // the box IS live, named after the run id
    expect((await driver.list(runId)).length).toBe(1);

    await teardownSandbox(deps(), runId, lockFor(runId));

    // THE pin: the box is GONE and the record closed — no leak at exit 0.
    expect((await driver.list(runId)).length).toBe(0);
    expect(store.get(runId).closedAt).toBeString();
    const destroy = logs.find((l) => l.operation === "teardown.destroy");
    expect(destroy?.outcome).toBe("ran");
  }, 30_000);

  test("F6 arm 2: destroy failure on the runId fallback aborts fail-closed — no close, record stays open", async () => {
    const runId = "df25-f6-fallback-fail";
    store.create(runId);
    await driver.create(runId);
    const failing = Object.create(recording) as RecordingDriver;
    failing.destroy = (vm: string) => {
      if (vm === runId) return Promise.reject(new Error("rm exploded"));
      return recording.destroy(vm);
    };

    await expect(teardownSandbox(deps({ driver: failing as unknown as TeardownDeps["driver"] }), runId, lockFor(runId))).rejects.toThrow(
      /destroy-unconfirmed|rm exploded/,
    );
    expect((await driver.list(runId)).length).toBe(1); // box untouched — fail-closed
    expect(store.get(runId).closedAt).toBeUndefined();
  }, 30_000);

  // ─── DF2.8: box-hours hook at close step ──────────────────────────────────────

  describe("DF2.8 box-hours hook (ingestBoxHours at close)", () => {
    // Mock CostLedgerHook for spying on ingestBoxHours calls
    interface IngestCall {
      runId: string;
      repoSlug: string;
      issueId: string;
      requestId: string;
    }

    class MockCostLedgerHook implements CostLedgerHook {
      readonly calls: IngestCall[] = [];
      ingestCount = 0;
      /** DF2.12: token rows the bridge drove through ingestCostEvent, in call order. */
      readonly tokenCalls: { event: Record<string, unknown>; ctx: Record<string, unknown> }[] = [];
      /** When set, throws on the next ingest call — box hours AND tokens — with code/remediation */
      error?: { code: string; message: string; remediation: string };

      ingestCostEvent(
        event: Parameters<NonNullable<CostLedgerHook["ingestCostEvent"]>>[0],
        ctx: Parameters<NonNullable<CostLedgerHook["ingestCostEvent"]>>[1],
      ): { eventId: string; inserted: boolean; unpriced: boolean } {
        this.tokenCalls.push({ event: { ...event }, ctx: { ...ctx } });
        // PR #253 review (W2-3): the documented `error` field was honored by
        // ingestBoxHours alone — a suite wiring THIS mock could not express
        // "token ingest refused" and silently kept inserted:true. Same shape,
        // same throw, both halves; the default (no error) return is unchanged.
        if (this.error) {
          const { code, message, remediation } = this.error;
          const err = new Error(message) as Error & { code: string; remediation: string };
          err.code = code;
          err.remediation = remediation;
          throw err;
        }
        return { eventId: `token-${ctx.invocationSeq}`, inserted: true, unpriced: false };
      }

      ingestBoxHours(ctx: IngestCall): { eventId: string; inserted: boolean; unpriced: boolean } {
        this.ingestCount++;
        this.calls.push({ ...ctx });
        if (this.error) {
          const { code, message, remediation } = this.error;
          const err = new Error(message) as Error & { code: string; remediation: string };
          err.code = code;
          err.remediation = remediation;
          throw err;
        }
        return { eventId: `event-${ctx.runId}`, inserted: true, unpriced: false };
      }
    }

    // Test 1: close step calls ingestBoxHours exactly once AFTER store.close, with budget attribution
    test("close step calls ingestBoxHours exactly once AFTER store.close, with budget attribution and requestId", async () => {
      const runId = "df28-close-hook";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      const hook = new MockCostLedgerHook();
      const requestId = "req-close-hook-test";

      const deps_ = deps({
        gitCwd: host,
        costLedger: hook,
        requestId,
      });

      // Budget extension: the DF2.8 namespace is registered — a failure here
      // must fail the test, not silently skip it.
      store.set(runId, {
        extensions: {
          budget: {
            schemaVersion: 1,
            repoSlug: "qds/demo",
            issueId: "42",
            capMicroUsd: 5_000_000,
            spentMicroUsd: 0,
            reservedMicroUsd: 0,
            admittedCeilingMicroUsd: 5_000_000,
          },
        },
      });

      await teardownSandbox(deps_, runId, lockFor(runId));

      // ingestBoxHours called exactly once
      expect(hook.ingestCount).toBe(1);
      expect(hook.calls).toHaveLength(1);

      const call = hook.calls[0]!;
      expect(call.runId).toBe(runId);
      expect(call.repoSlug).toBe("qds/demo");
      expect(call.issueId).toBe("42");
      expect(call.requestId).toBe(requestId);

      // Record was closed
      expect(store.get(runId).closedAt).toBeString();
    }, 30_000);

    // Test 2: teardown aborted at harvest → ingestBoxHours NEVER called
    test("teardown aborted at harvest (gitRunner failing bundle verify) → ingestBoxHours NEVER called, record stays open", async () => {
      const runId = "df28-abort-harvest";
      const origin = await makeOrigin();
      await makeRun(runId);
      await mintFor(runId);
      store.set(runId, { commitSha: origin.baseSha });
      await fillBox(runId, runId, origin.originDir, 3, true);

      const hook = new MockCostLedgerHook();
      store.set(runId, {
        extensions: {
          budget: {
            schemaVersion: 1,
            repoSlug: "qds/demo",
            issueId: "42",
            capMicroUsd: 5_000_000,
            spentMicroUsd: 0,
            reservedMicroUsd: 0,
            admittedCeilingMicroUsd: 5_000_000,
          },
        },
      });

      // Fail bundle verify at harvest (same pattern as existing AC3 test)
      const failRunVerify: GitRunner = async (argv: readonly string[], cwd: string) => {
        if (argv.includes("verify") && argv.some((a) => a.includes(runId))) {
          return { stdout: "", stderr: "error: Repository lacks these prerequisite commits", exitCode: 1 };
        }
        return bunGitRunner(argv, cwd);
      };

      let err: unknown;
      try {
        await teardownSandbox(
          deps({
            gitCwd: origin.originDir,
            gitRunner: failRunVerify,
            costLedger: hook,
          }),
          runId,
          lockFor(runId),
        );
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      // ingestBoxHours NEVER called - zero calls
      expect(hook.ingestCount).toBe(0);
      expect(hook.calls).toHaveLength(0);

      // Record stays open
      expect(store.get(runId).closedAt).toBeUndefined();
    }, 30_000);

    // Test 3: re-running teardown → hook fires on early path but real CostLedger writes exactly ONE row
    test("re-running teardown to completion: hook fires again on early path, but real CostLedger writes exactly ONE box_hours row (idempotent)", async () => {
      const runId = "df28-retry-idempotent";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      store.set(runId, {
        extensions: {
          budget: {
            schemaVersion: 1,
            repoSlug: "qds/demo",
            issueId: "42",
            capMicroUsd: 5_000_000,
            spentMicroUsd: 0,
            reservedMicroUsd: 0,
            admittedCeilingMicroUsd: 5_000_000,
          },
        },
      });

      // Fixed clock: 30 minutes of VM lifetime. `createdAt` is immutable through
      // set() and close() owns `closedAt`, so close with an explicit date and let
      // the ledger's readRunRecord supply the matching backdated createdAt.
      const fixedCreated = "2026-08-20T10:00:00.000Z";
      const fixedClosed = "2026-08-20T10:30:00.000Z";
      store.close(runId, new Date(fixedClosed));

      // Use real CostLedger with config
      const costLedger = new (await import("../../src/providers/cost-ledger.ts")).CostLedger({
        path: join(dir, "cost-ledger.db"),
        readRunRecord: (id) => {
          try {
            const rec = store.get(id);
            return { createdAt: fixedCreated, closedAt: rec.closedAt, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd };
          } catch {
            return undefined;
          }
        },
        config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 1_000_000 }, // 1M µ$/h = $1/h
      });
      const rawDb = new (await import("bun:sqlite")).Database(join(dir, "cost-ledger.db"));
      const boxRows = (): { n: number } =>
        rawDb.query("SELECT COUNT(*) AS n FROM cost_events WHERE kind = 'box_hours'").get() as { n: number };

      const deps_ = deps({
        gitCwd: host,
        costLedger: costLedger,
      });

      // First run (already-closed early path)
      await teardownSandbox(deps_, runId, lockFor(runId));
      expect(boxRows().n).toBe(1);

      // D10: verify eventId is deterministic across re-runs
      const firstRow = rawDb.query("SELECT event_id FROM cost_events WHERE kind = 'box_hours' AND run_id = ?").get(runId) as { event_id: string };
      const firstEventId = firstRow.event_id;

      // Second run (already-closed early path again)
      await teardownSandbox(deps_, runId, lockFor(runId));
      // Exactly ONE row across both runs — idempotent by eventId
      expect(boxRows().n).toBe(1);

      // D10: strengthen to assert deterministic eventId across re-runs
      const secondRow = rawDb.query("SELECT event_id FROM cost_events WHERE kind = 'box_hours' AND run_id = ?").get(runId) as { event_id: string };
      expect(secondRow.event_id).toBe(firstEventId);

      // Verify cost = 30min × 1M µ$/h = 500,000 µ$ fractional (F8), attributed to the run's issue
      const row = rawDb.query("SELECT cost_micro_usd, repo_slug, issue_id FROM cost_events WHERE kind = 'box_hours' AND run_id = ?").get(runId) as { cost_micro_usd: number; repo_slug: string; issue_id: string };
      expect(row.cost_micro_usd).toBe(500_000);
      expect(row.repo_slug).toBe("qds/demo");
      expect(row.issue_id).toBe("42");
      rawDb.close();
      costLedger.close();
    }, 30_000);

    // Test 4: deps.costLedger absent → everything behaves exactly as before (74 existing tests prove this)
    test("deps.costLedger absent → teardown completes normally, no hook call, record closes", async () => {
      const runId = "df28-no-ledger";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);

      // No costLedger in deps at all
      await teardownSandbox(deps({ gitCwd: host }), runId, lockFor(runId));

      // Record closes normally
      expect(store.get(runId).closedAt).toBeString();
      // No crash, no error
    }, 30_000);

    // Test 5: hook throwing CostLedgerError → teardownSandbox rejects with TeardownError preserving code+remediation
    test("hook throwing CostLedgerError(box-hour-rate-unconfigured) → TeardownError preserves code and remediation", async () => {
      const runId = "df28-hook-error";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      store.set(runId, {
        extensions: {
          budget: {
            schemaVersion: 1,
            repoSlug: "qds/demo",
            issueId: "42",
            capMicroUsd: 5_000_000,
            spentMicroUsd: 0,
            reservedMicroUsd: 0,
            admittedCeilingMicroUsd: 5_000_000,
          },
        },
      });

      const hook = new MockCostLedgerHook();
      hook.error = {
        code: "box-hour-rate-unconfigured",
        message: "boxHourRateMicroUsd is not configured",
        remediation: "write boxHourRateMicroUsd to .sandbox/cost-config.json",
      };

      let err: unknown;
      try {
        await teardownSandbox(
          deps({
            gitCwd: host,
            costLedger: hook,
          }),
          runId,
          lockFor(runId),
        );
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(TeardownError);
      const te = err as TeardownError;
      expect(te.code).toBe("box-hour-rate-unconfigured");
      expect(te.remediation).toContain("boxHourRateMicroUsd");
    }, 30_000);

    // Test 5b (PR #253 review, W2-3): the mock's documented `error` field now
    // fires on ingestCostEvent too — before this, a suite wired to THIS mock
    // could not express "token ingest refused" and silently kept
    // inserted:true. The field is sticky by design, so the box-hours leg that
    // FOLLOWS the contained token refusal throws through Test 5's own
    // TeardownError contract; the assertions below separate the two legs.
    test("mock error honored on ingestCostEvent: the token half is asked and refused, its refusal contained, the box-hours leg surfaces the same error", async () => {
      const runId = "df212-mock-token-refusal";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      // One dispatch-shaped cost_attribution line on the box's $HOME — the
      // DF2.12 describe's attributionLine fixture is scoped there, so it is
      // spelled out once here.
      writeFileSync(
        join(boxHome, `${runId}.engine.log`),
        `${JSON.stringify({
          type: "cost_attribution",
          requestId: "req-box",
          runId,
          phaseId: "implement",
          agentId: "lead-1",
          role: "lead",
          invocationSeq: 0,
          model: "cheap/model",
          costMicroUsd: 1,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          turnCount: 1,
          unpricedTurns: 0,
          timestamp: "2026-09-10T12:01:00.000Z",
        })}\n`,
      );

      const hook = new MockCostLedgerHook();
      hook.error = {
        code: "key-hash-missing",
        message: "no resolvable keyHash",
        remediation: "re-run the ingest after mintRunKey records the run's key",
      };

      let err: unknown;
      try {
        await teardownSandbox(deps({ gitCwd: host, costLedger: hook }), runId, lockFor(runId));
      } catch (e) {
        err = e;
      }

      // The TOKEN half was asked (the bridge drove it) and the mock refused…
      expect(hook.tokenCalls).toHaveLength(1);
      // …through teardown's own reporter, i.e. the refusal was CONTAINED, not
      // what aborted the step —
      const refusal = logs.find((l) => l.operation === "teardown.token_ingest");
      expect(refusal?.status).toBe("error");
      expect(refusal?.outcome).toBe("refused");
      expect(String(refusal?.code)).toBe("key-hash-missing");
      // — the abort came from the box-hours leg that runs after it, carrying
      // the same typed error the mock was told to raise (Test 5's contract).
      // ingestCount counts ATTEMPTS (the mock increments before throwing), so
      // 1 here is the refused box-hours call, not a landed row.
      expect(err).toBeInstanceOf(TeardownError);
      expect((err as TeardownError).code).toBe("key-hash-missing");
      expect(hook.ingestCount).toBe(1);
    }, 30_000);

    // Test 6: record without budget extension + hook present → no hook call, no error, teardown completes
    test("record without budget extension + hook present → no hook call, no error, teardown completes", async () => {
      const runId = "df28-no-budget-ext";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      // NO budget extension written - run record has no extensions.budget at all

      const hook = new MockCostLedgerHook();

      await teardownSandbox(
        deps({
          gitCwd: host,
          costLedger: hook,
        }),
        runId,
        lockFor(runId),
      );

      // No hook call
      expect(hook.ingestCount).toBe(0);
      expect(hook.calls).toHaveLength(0);

      // Teardown completes
      expect(store.get(runId).closedAt).toBeString();
    }, 30_000);

    // Test 7: crash window - first close succeeded, process died before box-hours ingest
    test("crash window: record already closed but box-hours not yet ingested → early path still runs ingestBoxHours", async () => {
      const runId = "df28-crash-window";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      store.set(runId, {
        extensions: {
          budget: {
            schemaVersion: 1,
            repoSlug: "qds/demo",
            issueId: "42",
            capMicroUsd: 5_000_000,
            spentMicroUsd: 0,
            reservedMicroUsd: 0,
            admittedCeilingMicroUsd: 5_000_000,
          },
        },
      });

      const hook = new MockCostLedgerHook();

      // First run: close normally without costLedger to simulate crash before ingest
      await teardownSandbox(deps({ gitCwd: host }), runId, lockFor(runId));
      expect(store.get(runId).closedAt).toBeString();
      expect(hook.ingestCount).toBe(0); // No hook first run

      // Second run: record is already closed, early path should still fire ingestBoxHours
      await teardownSandbox(
        deps({
          gitCwd: host,
          costLedger: hook,
        }),
        runId,
        lockFor(runId),
      );

      // Early path fired ingestBoxHours even though record was already closed
      expect(hook.ingestCount).toBe(1);
      expect(hook.calls[0]?.runId).toBe(runId);
    }, 30_000);

    // Test 8: non-primitive budget values (object/array) → treated as no attribution, ingest never called
    test("non-primitive budget values (object) → treated as unattributed, ingestBoxHours never called, teardown succeeds", async () => {
      const runId = "df28-nonprimitive";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      const hook = new MockCostLedgerHook();

      // Simulate a hand-edited record by writing directly to JSON (bypasses validation)
      const recPath = store.path(runId);
      const rec = JSON.parse(readFileSync(recPath, "utf8")) as Record<string, unknown>;
      (rec as { extensions: Record<string, unknown> }).extensions = {
        budget: {
          schemaVersion: 1,
          repoSlug: { evil: true }, // Non-primitive value that bypasses type guard
          issueId: "42",
          capMicroUsd: 5_000_000,
          spentMicroUsd: 0,
          reservedMicroUsd: 0,
          admittedCeilingMicroUsd: 5_000_000,
        },
      };
      writeFileSync(recPath, JSON.stringify(rec));

      await teardownSandbox(
        deps({
          gitCwd: host,
          costLedger: hook,
        }),
        runId,
        lockFor(runId),
      );

      // ingestBoxHours NEVER called - non-primitive values count as no attribution
      expect(hook.ingestCount).toBe(0);
      expect(hook.calls).toHaveLength(0);

      // Teardown still completes successfully
      expect(store.get(runId).closedAt).toBeString();
    }, 30_000);
  });

  // ─── 8c. F032: the two spend figures, compared ───────────────────

  /**
   * A REAL CostLedger, shared by the F032 and DF2.12 suites (review-round
   * hoist — the two nested suites carried identical copies). Both need the
   * box-hours/token rows genuinely in the ledger's view: a fixed-total stub
   * cannot catch the like-for-like divergence bug (comparing token spend
   * against tokens + box hours), and DF2.12's token rows must survive the
   * REAL artifacts pull and ingest path. `readRunRecord` backdates createdAt
   * half an hour off the close so the box-hours row is deterministic.
   */
  async function realLedger(runId: string): Promise<CostLedgerHook & { close(): void }> {
    const { CostLedger } = await import("../../src/providers/cost-ledger.ts");
    return new CostLedger({
      path: join(dir, `ledger-${runId}.db`),
      readRunRecord: (id) => {
        try {
          const rec = store.get(id);
          const createdAt =
            rec.closedAt === undefined
              ? rec.createdAt
              : new Date(Date.parse(rec.closedAt) - 30 * 60_000).toISOString();
          return { createdAt, closedAt: rec.closedAt, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd };
        } catch {
          return undefined;
        }
      },
      config: { defaultCapMicroUsd: 50_000_000, boxHourRateMicroUsd: 1_000_000 },
    });
  }

  /** The budget attribution the close step's box-hours ingest needs. */
  function attribute(runId: string): void {
    store.set(runId, {
      extensions: {
        budget: {
          schemaVersion: 1,
          repoSlug: "qds/demo",
          issueId: "42",
          capMicroUsd: 50_000_000,
          spentMicroUsd: 0,
          reservedMicroUsd: 0,
          admittedCeilingMicroUsd: 50_000_000,
        },
      },
    });
  }

  describe("F032 spend divergence at the close step", () => {
    /** 30 min of box time at 1M µ$/h — the row the close step ingests itself. */
    const BOX_HOURS_MICRO_USD = 500_000;
    /** What FakeKeyApi's usageOnCreateUsd (0.0081) becomes on the record. */
    const RECORDED_MICRO_USD = 8_100;

    /** One priced token row for this run — the DF2.7 bridge, simulated. */
    function ingestTokens(ledger: CostLedgerHook, runId: string, costUsd: number): void {
      (ledger as unknown as { ingestCostEvent: (e: unknown, c: unknown) => unknown }).ingestCostEvent( // dp:ok reaches a module-private ledger method the test drives directly
        {
          agentId: "lead-1",
          model: "cheap/model",
          inputTokens: 1_000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd,
          turnCount: 1,
          unpricedTurns: 0,
          durationMs: 1_000,
          timestamp: "2026-08-20T12:01:00.000Z",
        },
        { runId, repoSlug: "qds/demo", issueId: "42", requestId: "req-f032", role: "lead", invocationSeq: 0 },
      );
    }

    async function tornDownWith(runId: string, tokensUsd?: number): Promise<void> {
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      const ledger = await realLedger(runId);
      try {
        if (tokensUsd !== undefined) ingestTokens(ledger, runId, tokensUsd);
        await teardownSandbox(deps({ gitCwd: host, costLedger: ledger }), runId, lockFor(runId));
      } finally {
        ledger.close();
      }
    }

    test("token spend that AGREES → no line, even though the ledger also holds this run's box hours", async () => {
      // The regression this exists for: `totalMicroUsd` here is 508_100
      // (8_100 tokens + 500_000 box hours), so a raw comparison against the
      // record's 8_100 would fire on every priced teardown, forever.
      const runId = "df25-spend-agrees";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      const ledger = await realLedger(runId);
      let view: { totalMicroUsd: number; perRole: Record<string, number> };
      try {
        ingestTokens(ledger, runId, 0.0081);
        await teardownSandbox(deps({ gitCwd: host, costLedger: ledger }), runId, lockFor(runId));
        // Read BEFORE close: absence of a "skipped" log doesn't prove the
        // box-hours row actually landed — read the ledger back to prove it.
        view = ledger.readRunCost!(runId);
      } finally {
        ledger.close();
      }

      expect(store.get(runId).spendMicroUsd).toBe(RECORDED_MICRO_USD);
      expect(view.totalMicroUsd).toBe(RECORDED_MICRO_USD + BOX_HOURS_MICRO_USD);
      const boxHours = logs.find((l) => l.operation === "teardown.box_hours" && l.outcome === "skipped");
      expect(boxHours).toBeUndefined();
      expect(logs.filter((l) => l.code === "spend-divergence")).toHaveLength(0);
    }, 30_000);

    test("no token row at all → outcome 'unwired' (the DF2.12 fault shape: tokens never harvested or all refused), box hours excluded from derived", async () => {
      const runId = "df25-spend-unwired";
      await tornDownWith(runId);

      const lines = logs.filter((l) => l.code === "spend-divergence");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.outcome).toBe("unwired");
      expect(lines[0]!.recordedMicroUsd).toBe(RECORDED_MICRO_USD);
      // 0, NOT the 500_000 box-hours row the close step just wrote
      expect(lines[0]!.derivedMicroUsd).toBe(0);
      expect(String(lines[0]!.message)).toContain("tokens-ledger-unwired");
      expect(store.get(runId).closedAt).toBeString();
    }, 30_000);

    test("token event delivered but UNPRICED → outcome 'divergent', not 'unwired'", async () => {
      // The bridge DID deliver a row for this run — it just priced at 0 µ$ and
      // is excluded from `derived`, same shape as no row at all. Only
      // hasTokenRows tells the two apart; without it this misreports a live
      // bridge as never having delivered anything (CodeRabbit round-11 finding).
      const runId = "df32-unpriced-not-unwired";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      const ledger = await realLedger(runId);
      try {
        (ledger as unknown as { ingestCostEvent: (e: unknown, c: unknown) => unknown }).ingestCostEvent(
          {
            agentId: "lead-1",
            model: "cheap/model",
            inputTokens: 1_000,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            turnCount: 1,
            unpricedTurns: 1,
            durationMs: 1_000,
            timestamp: "2026-08-20T12:01:00.000Z",
          },
          { runId, repoSlug: "qds/demo", issueId: "42", requestId: "req-f032", role: "lead", invocationSeq: 0 },
        );
        await teardownSandbox(deps({ gitCwd: host, costLedger: ledger }), runId, lockFor(runId));
      } finally {
        ledger.close();
      }

      const lines = logs.filter((l) => l.code === "spend-divergence");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.outcome).toBe("divergent");
      expect(lines[0]!.derivedMicroUsd).toBe(0);
    }, 30_000);

    test("token event delivered, legitimately PRICED at zero → outcome 'divergent', not 'unwired'", async () => {
      // A fully-cached turn prices at 0 µ$ with `unpriced` FALSE — it moves
      // neither `totalMicroUsd` (derived stays 0) nor `unpricedRows` (it isn't
      // unpriced). unpricedRows alone can't tell this apart from no row at
      // all; only presence (hasTokenRows) does (team-lead round-2 finding).
      const runId = "df32-zero-priced-not-unwired";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      const ledger = await realLedger(runId);
      try {
        (ledger as unknown as { ingestCostEvent: (e: unknown, c: unknown) => unknown }).ingestCostEvent(
          {
            agentId: "lead-1",
            model: "cheap/model",
            inputTokens: 1_000,
            outputTokens: 500,
            cacheReadTokens: 1_500,
            cacheWriteTokens: 0,
            costUsd: 0,
            turnCount: 1,
            unpricedTurns: 0,
            durationMs: 1_000,
            timestamp: "2026-08-20T12:01:00.000Z",
          },
          { runId, repoSlug: "qds/demo", issueId: "42", requestId: "req-f032", role: "lead", invocationSeq: 0 },
        );
        await teardownSandbox(deps({ gitCwd: host, costLedger: ledger }), runId, lockFor(runId));
      } finally {
        ledger.close();
      }

      const lines = logs.filter((l) => l.code === "spend-divergence");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.outcome).toBe("divergent");
      expect(lines[0]!.derivedMicroUsd).toBe(0);
    }, 30_000);

    test("token spend on both sides that disagrees → outcome 'divergent'", async () => {
      const runId = "df25-spend-divergent";
      await tornDownWith(runId, 0.0001); // 100 µ$ of tokens vs the provider's 8_100

      const lines = logs.filter((l) => l.code === "spend-divergence");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.outcome).toBe("divergent");
      expect(lines[0]!.derivedMicroUsd).toBe(100);
      expect(lines[0]!.deltaMicroUsd).toBe(RECORDED_MICRO_USD - 100);
      expect(String(lines[0]!.message)).not.toContain("tokens-ledger-unwired");
    }, 30_000);

    test("crash-window recovery ALSO reports spend divergence (F032), not just box hours", async () => {
      // The regression this exists for: the early (already-closed) path
      // ran ingestBoxHoursIfAttributed but never reportSpendDivergence, so a
      // process that died between store.close and the divergence report
      // left that run's token-ledger gap unreported forever, even on retry.
      const runId = "df32-recovery-divergence";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);

      // First run: close WITHOUT a costLedger — simulates a crash before
      // ingest+divergence would have run.
      await teardownSandbox(deps({ gitCwd: host }), runId, lockFor(runId));
      expect(store.get(runId).closedAt).toBeString();
      expect(logs.filter((l) => l.code === "spend-divergence")).toHaveLength(0);

      // Second run: record is already closed; the recovery path must ingest
      // box hours AND report divergence, same as a fresh close would.
      const ledger = await realLedger(runId);
      try {
        await teardownSandbox(deps({ gitCwd: host, costLedger: ledger }), runId, lockFor(runId));
      } finally {
        ledger.close();
      }

      const lines = logs.filter((l) => l.code === "spend-divergence");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.outcome).toBe("unwired");
      expect(lines[0]!.recordedMicroUsd).toBe(RECORDED_MICRO_USD);
    }, 30_000);

    test("a hook with no readRunCost (DF2.8's box-hours-only shape) is left alone", async () => {
      const runId = "df25-spend-nohook";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);

      await teardownSandbox(
        deps({
          gitCwd: host,
          costLedger: {
            ingestBoxHours: () => ({ eventId: "x", inserted: true, unpriced: false }),
            ingestCostEvent: () => ({ eventId: "x", inserted: true, unpriced: false }),
          },
        }),
        runId,
        lockFor(runId),
      );

      expect(logs.filter((l) => l.code === "spend-divergence")).toHaveLength(0);
      expect(store.get(runId).closedAt).toBeString();
    }, 30_000);
  });

  // ─── 8d. DF2.12: the token ingest at BOTH teardown ingest points ──────────
  //
  // The engine log fixture is hand-authored on the fake box's $HOME (a
  // BOX_HOME_SOURCES entry), so it reaches
  // `<runsDir>/<runId>-artifacts/<runId>.engine.log` through the REAL artifacts
  // pull — the bridge reads exactly the surface production reads.

  describe("DF2.12 token ingest at the teardown ingest points", () => {
    const RUN = "df212-token-run";
    const TOKENS_MICRO_USD = 8_100; // agrees with FakeKeyApi's 0.0081 usage

    /** One in-box `cost_attribution` line, dispatch-task's wire shape. */
    function attributionLine(over: Record<string, unknown> = {}): string {
      return JSON.stringify({
        type: "cost_attribution",
        requestId: "req-box",
        runId: RUN,
        phaseId: "implement",
        agentId: "lead-1",
        role: "lead",
        invocationSeq: 0,
        model: "cheap/model",
        costMicroUsd: TOKENS_MICRO_USD,
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turnCount: 1,
        unpricedTurns: 0,
        timestamp: "2026-09-10T12:01:00.000Z",
        ...over,
      });
    }

    function tokenRowCount(ledgerPath: string): number {
      const db = new Database(ledgerPath);
      try {
        return (db.prepare("SELECT COUNT(*) AS n FROM cost_events WHERE kind = 'tokens'").get() as { n: number }).n;
      } finally {
        db.close();
      }
    }

    test("close step: three cost_attribution lines → three token rows + exactly one box_hours row, no divergence line", async () => {
      const runId = RUN;
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      // The fixture goes on the fake box's $HOME so the REAL artifacts pull
      // delivers it to the artifacts directory the bridge reads at close.
      writeFileSync(join(boxHome, `${runId}.engine.log`), `${[
        attributionLine(),
        attributionLine({ agentId: "worker-1", role: "worker", costMicroUsd: 0, inputTokens: 10, timestamp: "2026-09-10T12:02:00.000Z" }),
        attributionLine({ agentId: "resident", role: "resident", invocationSeq: 0, model: null, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: 0, timestamp: "2026-09-10T12:03:00.000Z" }),
      ].join("\n")}\n`);

      const ledger = await realLedger(runId);
      try {
        await teardownSandbox(deps({ gitCwd: host, costLedger: ledger }), runId, lockFor(runId));

        const view = ledger.readRunCost!(runId);
        // lead + worker + resident rows, split by role — the multi-role split
        // the per-issue views now carry. AC1: role is the line's, never the
        // model's; the resident row exists (AC3's falsifiable core).
        expect(view.hasTokenRows).toBe(true);
        expect(view.perRole.lead).toBe(TOKENS_MICRO_USD);
        expect(Object.keys(view.perRole)).toEqual(expect.arrayContaining(["lead", "worker", "resident", "box-hours"]));
        expect(tokenRowCount(join(dir, `ledger-${runId}.db`))).toBe(3);
        const summary = logs.find((l) => l.operation === "cost-ledger.token-ingest-summary");
        expect(summary?.outcome).toBe("ingested");
        expect(summary?.rowsRead).toBe(3);
        expect(summary?.rowsInserted).toBe(3);
        // The provider figure (8,100) and the derived token figure now agree —
        // reportSpendDivergence compares like for like, so it is silent.
        expect(logs.filter((l) => l.code === "spend-divergence")).toHaveLength(0);
      } finally {
        ledger.close();
      }
    }, 30_000);

    test("already-closed early path: a crash-recovery re-run heals the token rows too", async () => {
      const runId = "df212-early-path";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      writeFileSync(join(boxHome, `${runId}.engine.log`), `${attributionLine({ runId, costMicroUsd: 5_000 })}\n`);

      // First teardown closes the record with NO ledger wired — the crash
      // window DF2.8's fix exists for, now healing both halves.
      await teardownSandbox(deps({ gitCwd: host }), runId, lockFor(runId));
      expect(store.get(runId).closedAt).toBeString();

      const ledger = await realLedger(runId);
      try {
        await teardownSandbox(deps({ gitCwd: host, costLedger: ledger }), runId, lockFor(runId));
        const view = ledger.readRunCost!(runId);
        expect(view.hasTokenRows).toBe(true);
        expect(view.perRole.lead).toBe(5_000);
        expect(view.perRole["box-hours"]).toBeGreaterThan(0);
      } finally {
        ledger.close();
      }
    }, 30_000);

    test("no harvested log → summary tokens-not-harvested naming the path, box hours still land", async () => {
      const runId = "df212-not-harvested";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);

      const ledger = await realLedger(runId);
      try {
        await teardownSandbox(deps({ gitCwd: host, costLedger: ledger }), runId, lockFor(runId));
        const summary = logs.find((l) => l.operation === "cost-ledger.token-ingest-summary");
        expect(summary?.outcome).toBe("tokens-not-harvested");
        expect(String(summary?.logPath)).toContain(`${runId}.engine.log`);
        expect(String(summary?.reason)).toContain("artifacts");
        const view = ledger.readRunCost!(runId);
        expect(view.hasTokenRows).toBe(false);
        expect(view.perRole["box-hours"]).toBeGreaterThan(0);
      } finally {
        ledger.close();
      }
    }, 30_000);

    test("readable log with zero cost_attribution lines → summary no-token-spend", async () => {
      const runId = "df212-no-spend";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      writeFileSync(join(boxHome, `${runId}.engine.log`), `${JSON.stringify({ type: "step", name: "implement" })}\n`);

      const ledger = await realLedger(runId);
      try {
        await teardownSandbox(deps({ gitCwd: host, costLedger: ledger }), runId, lockFor(runId));
        expect(logs.find((l) => l.operation === "cost-ledger.token-ingest-summary")?.outcome).toBe("no-token-spend");
      } finally {
        ledger.close();
      }
    }, 30_000);

    test("the token ingest runs immediately BEFORE the box-hours ingest at each point", async () => {
      const runId = "df212-order";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      writeFileSync(join(boxHome, `${runId}.engine.log`), `${attributionLine({ runId, costMicroUsd: 1 })}\n`);

      const order: string[] = [];
      const hook: CostLedgerHook = {
        ingestCostEvent: () => {
          order.push("tokens");
          return { eventId: "t", inserted: true, unpriced: false };
        },
        ingestBoxHours: () => {
          order.push("box-hours");
          return { eventId: "b", inserted: true, unpriced: false };
        },
      };
      await teardownSandbox(deps({ gitCwd: host, costLedger: hook }), runId, lockFor(runId));
      expect(order).toEqual(["tokens", "box-hours"]);
    }, 30_000);

    test("a token-ingest refusal is reported and does NOT block the box-hours ingest (PR #253 review)", async () => {
      const runId = "df212-token-refusal";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      writeFileSync(join(boxHome, `${runId}.engine.log`), `${attributionLine({ runId, costMicroUsd: 1 })}\n`);

      const order: string[] = [];
      const hook: CostLedgerHook = {
        ingestCostEvent: () => {
          order.push("tokens");
          // key-hash-missing is DETERMINISTIC — a record without the hash
          // stays hash-less, so aborting the step could never be healed by a
          // re-run; the box-hours row would stay unpriced forever.
          const err = new Error(
            `run ${runId} has no resolvable keyHash — token spend is unattributable, refusing to persist under a guessed key`,
          ) as Error & { code: string; remediation: string };
          err.code = "key-hash-missing";
          err.remediation = "re-run the ingest after mintRunKey records the run's key";
          throw err;
        },
        ingestBoxHours: () => {
          order.push("box-hours");
          return { eventId: "b", inserted: true, unpriced: false };
        },
      };
      // The close step must COMPLETE: the refusal is reported, not propagated.
      await teardownSandbox(deps({ gitCwd: host, costLedger: hook }), runId, lockFor(runId));
      expect(order).toEqual(["tokens", "box-hours"]);
      expect(store.get(runId).closedAt).toBeString();
      // Teardown's own record of the continuation names the refusal class.
      const refusal = logs.find((l) => l.operation === "teardown.token_ingest");
      expect(refusal?.status).toBe("error");
      expect(refusal?.outcome).toBe("refused");
      expect(String(refusal?.code)).toBe("key-hash-missing");
      // BRG-9: the fresh close step reports its real phase…
      expect(refusal?.step).toBe("close");
      // BRG-10: …and the typed refusal's literal next command rides the line.
      expect(String(refusal?.remediation)).toBe("re-run the ingest after mintRunKey records the run's key");

      // BRG-9: the crash-RECOVERY re-run (record already closed) heals through
      // its own ingest point — its refusal must not misreport itself as the
      // fresh close that already succeeded.
      const refusalCountBefore = logs.filter((l) => l.operation === "teardown.token_ingest").length;
      await teardownSandbox(deps({ gitCwd: host, costLedger: hook }), runId, lockFor(runId));
      const recoveryRefusals = logs
        .filter((l) => l.operation === "teardown.token_ingest")
        .slice(refusalCountBefore);
      expect(recoveryRefusals.length).toBeGreaterThan(0);
      for (const r of recoveryRefusals) expect(r.step).toBe("close-recovery");
    }, 30_000);

    test("loser-arm lazy seam: a hook with no handle opens on the FIRST ingest, forwards BOTH ingests, close drops the handle (PR #253 review)", async () => {
      const runId = "df212-loser-lazy";
      const host = await makeHostRepo();
      await makeRun(runId);
      await mintFor(runId);
      attribute(runId);
      writeFileSync(join(boxHome, `${runId}.engine.log`), `${attributionLine({ runId })}\n`);

      // fleet.ts's makeLoserLedgerHook, mirrored at library level without
      // importing the CLI: the seam exposes BOTH methods from the start (so
      // ingestHarvestedTokensIfWired's is-it-wired guard passes), holds NO
      // handle until the first ingest call, and each open mints a FRESH
      // ledger the way fleet's factory does — never a reused closed one.
      let opens = 0;
      let handle: (CostLedgerHook & { close(): void }) | undefined;
      const { CostLedger } = await import("../../src/providers/cost-ledger.ts");
      const openLedger = (): CostLedgerHook & { close(): void } => {
        opens++;
        return new CostLedger({
          path: join(dir, `ledger-${runId}.db`),
          readRunRecord: (id) => {
            try {
              const rec = store.get(id);
              // Same 30-min backdating realLedger uses: a deterministic
              // box-hours figure, not a race on how long teardown took.
              const createdAt =
                rec.closedAt === undefined
                  ? rec.createdAt
                  : new Date(Date.parse(rec.closedAt) - 30 * 60_000).toISOString();
              return { createdAt, closedAt: rec.closedAt, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd };
            } catch {
              return undefined;
            }
          },
          config: { defaultCapMicroUsd: 50_000_000, boxHourRateMicroUsd: 1_000_000 },
        });
      };
      const lazy: CostLedgerHook & { close(): void } = {
        ingestBoxHours: (ctx) => {
          if (handle === undefined) handle = openLedger();
          return handle.ingestBoxHours(ctx);
        },
        ingestCostEvent: (event, ctx) => {
          if (handle === undefined) handle = openLedger();
          const ingest = handle.ingestCostEvent;
          if (ingest === undefined) {
            throw new Error("loser-ledger handle exposes no ingestCostEvent — token rows cannot be ingested");
          }
          return ingest.call(handle, event, ctx);
        },
        close(): void {
          try {
            handle?.close();
          } finally {
            handle = undefined;
          }
        },
      };

      try {
        await teardownSandbox(deps({ gitCwd: host, costLedger: lazy }), runId, lockFor(runId));

        // Opened EXACTLY once across both ingests — the token ingest runs
        // first and opens the handle, box hours reuse it.
        expect(opens).toBe(1);
        const opened = handle;
        expect(opened).toBeDefined();
        // The token ingest was FORWARDED through the lazy seam: the row is in
        // the ledger the seam opened, attributed by role.
        const view = opened!.readRunCost!(runId);
        expect(view.hasTokenRows).toBe(true);
        expect(view.perRole.lead).toBe(TOKENS_MICRO_USD);
        // …and box hours still landed behind it.
        expect(view.perRole["box-hours"]).toBeGreaterThan(0);

        // close drops the handle: the NEXT ingest re-opens through the
        // factory instead of reusing the closed one.
        lazy.close();
        expect(handle).toBeUndefined();
        lazy.ingestBoxHours({ runId, repoSlug: "qds/demo", issueId: "42", requestId: "req-after-close" });
        expect(opens).toBe(2);
        expect(handle).toBeDefined();
      } finally {
        lazy.close();
      }
    }, 30_000);
  });

  // ─── 9b. Crash between destroy and close — dead box, open record ──────────

  test("box already destroyed before the re-run: artifacts+harvest skip 'box already gone', run still closes", async () => {
    const runId = "df25-deadbox";
    const origin = await makeOrigin();
    await makeRun(runId);
    const hash = await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);
    // the crash: destroy landed, close never did — the re-run execs a dead box
    rmSync(boxDir(runId), { recursive: true, force: true });

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId, lockFor(runId));

    // the run CLOSES — no permanent abort loop on a box that cannot exist
    expect(store.get(runId).closedAt).toBeString();
    for (const step of ["artifacts", "harvest"]) {
      const skip = logs.find((l) => l.operation === `teardown.${step}` && l.outcome === "skipped");
      expect(skip).toBeDefined();
      expect(String(skip?.reason)).toContain("box already gone");
    }
    // the key lifecycle still completed on the way past
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeFalse();
    // nothing was fetched from a dead box
    expect(await hostGit(origin.originDir, ["for-each-ref", "--format=%(refname)", "refs/sandbox/"])).toBe("");
  }, 30_000);

  // ─── 9b2. Shared record classifier — corrupt ≠ absent ────────────────────

  test("corrupt record: teardownSandbox aborts record-read-failed (never no-record), record untouched", async () => {
    const runId = "df25-corrupt";
    await makeRun(runId);
    writeFileSync(store.path(runId), "{ not json\n");

    let err: unknown;
    try {
      await teardownSandbox(deps(), runId, lockFor(runId));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TeardownError);
    const te = err as TeardownError;
    // a live box + live key may sit behind a record that will not parse:
    // inspect-first guidance, never "create the run first"
    expect(te.code).toBe("record-read-failed");
    expect(te.remediation).toContain("inspect");
    expect(te.remediation).not.toContain("create the run first");
    expect(readFileSync(store.path(runId), "utf8")).toBe("{ not json\n");
  });

  // ─── 9b3. Typed dead-box signal survives sanitizer truncation ─────────────

  test("dead box whose no-such-box stderr lands past the sanitizer's 200-char cap still skips (typed flag)", async () => {
    const runId = "df25-deadbox-typed";
    const origin = await makeOrigin();
    await makeRun(runId);
    await mintFor(runId);
    store.set(runId, { commitSha: origin.baseSha });
    await fillBox(runId, runId, origin.originDir, 3, true);
    // The box directory deliberately stays ALIVE: teardown has no
    // directory-existence gate, and keeping the physical box present means the
    // fake driver's raw-throw no-such-box path can never fire here — the skip
    // below is reachable ONLY through the exedev-shaped exec return.
    const noise = "x".repeat(220);
    const exedevShape = Object.create(recording) as RecordingDriver;
    exedevShape.exec = () =>
      Promise.resolve({ stdout: "", stderr: `${noise} no such box: ${runId}\n`, exitCode: 255 });

    await teardownSandbox(deps({ gitCwd: origin.originDir, driver: exedevShape }), runId, lockFor(runId));

    expect(store.get(runId).closedAt).toBeString();
    for (const step of ["artifacts", "harvest"]) {
      const skip = logs.find((l) => l.operation === `teardown.${step}` && l.outcome === "skipped");
      expect(skip).toBeDefined();
      expect(String(skip?.reason)).toContain("box already gone");
    }
  }, 30_000);

  // ─── 9c. Probe argv — host git config must not decide availability ────────

  test("probe commit argv neutralizes host git config: -c commit.gpgsign=false -c core.hooksPath=", async () => {
    const runId = "df25-probe-argv";
    await makeRun(runId); // vmName present → the probe runs
    const argvs: string[][] = [];
    const spy: GitRunner = async (argv, cwd) => {
      argvs.push([...argv]);
      return bunGitRunner(argv, cwd);
    };

    await teardownSandbox(deps({ gitRunner: spy }), runId, lockFor(runId));

    const commit = argvs.find((a) => a.includes("commit"));
    expect(commit).toBeDefined();
    expect(commit).toContain("commit.gpgsign=false");
    expect(commit).toContain("core.hooksPath=");
    expect(store.get(runId).closedAt).toBeString();
  }, 30_000);

  // ─── 9d. Box-less + key-less — the probe guards paths that cannot run ─────

  test("box-less + key-less record: broken host git cannot block close — the probe never runs", async () => {
    const runId = "df25-nothing-to-do";
    store.create(runId); // no vmName, no keyHash — every step skips

    let gitCalls = 0;
    const broken: GitRunner = async () => {
      gitCalls++;
      return { stdout: "", stderr: "sh: git: command not found", exitCode: 127 };
    };

    await teardownSandbox(deps({ gitRunner: broken }), runId, lockFor(runId));

    expect(store.get(runId).closedAt).toBeString();
    expect(gitCalls).toBe(0); // the probe was skipped, not survived
  }, 30_000);

  // ─── 10. SCRIPT e2e — the trigger surface ─────────────────────────────────

  describe("scripts/sandbox-teardown.ts (trigger surface)", () => {
    interface CliResult {
      stdout: string;
      stderr: string;
      exitCode: number;
    }

    /**
     * Run the CLI as a subprocess. `envOverrides` merges last; a value of
     * `undefined` STRIPS the variable (how a test simulates a missing
     * $OPENROUTER_PROVISIONING_KEY even when the host shell exports one).
     */
    async function cli(
      args: string[],
      cwd: string,
      envOverrides: Record<string, string | undefined> = {},
    ): Promise<CliResult> {
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      for (const [k, v] of Object.entries(envOverrides)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
      env.QDS_RUNS_DIR = store.dir;
      env.QDS_FAKE_BOXES_DIR = join(dir, "boxes");
      env.QDS_PROVIDER_DRIVER = "fake";
      env.PATH = process.env.PATH ?? "";
      const proc = Bun.spawn({
        cmd: ["bun", SCRIPT, ...args],
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    }

    test("teardown <run-id> exits 0 and closes the record (keyless, offline)", async () => {
      const runId = "df25-script-td";
      const origin = await makeOrigin();
      await makeRun(runId);
      store.set(runId, { commitSha: origin.baseSha });
      await fillBox(runId, runId, origin.originDir, 3, true);

      const res = await cli([runId], origin.originDir);

      expect(res.exitCode).toBe(0);
      const rec = store.get(runId);
      expect(rec.closedAt).toBeString();
      // the harvest inside the subprocess really landed in the cwd repo
      expect(await hostGit(origin.originDir, ["rev-parse", "--verify", `refs/sandbox/${runId}`])).toBeString();
      expect(existsSync(join(store.dir, `${runId}.bundle`))).toBeTrue();
    }, 60_000);

    test("harvest <run-id> subcommand exits 0 and reports harvested:", async () => {
      const runId = "df25-script-hv";
      const origin = await makeOrigin();
      await makeRun(runId);
      store.set(runId, { commitSha: origin.baseSha });
      await fillBox(runId, runId, origin.originDir, 2, true);

      const res = await cli(["harvest", runId], origin.originDir);

      expect(res.exitCode).toBe(0);
      expect(`${res.stdout}${res.stderr}`).toContain("harvested");
      // harvest-only: the record stays open — closure is teardown's last step
      expect(store.get(runId).closedAt).toBeUndefined();
    }, 60_000);

    test("unknown run id → structured no-record on stdout, exit 1", async () => {
      const host = await makeHostRepo();
      const res = await cli(["no-such-run"], host);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain("!! no-record:");
      expect(res.stdout).toContain("next:");
    }, 60_000);

    test("harvest <id> --no-harvest → rejected with exit 1 (the gate waiver is teardown-only)", async () => {
      const host = await makeHostRepo();
      const res = await cli(["harvest", "some-run", "--no-harvest"], host);
      expect(res.exitCode).toBe(1);
      expect(`${res.stdout}${res.stderr}`).toContain("--no-harvest is a teardown flag");
    }, 60_000);

    test("--dir overrides $QDS_RUNS_DIR for record storage AND bundle/artifact output", async () => {
      const runId = "df25-script-dir";
      const origin = await makeOrigin();
      // The record lives in a SECOND store the env var does not point at:
      // without --dir the CLI would fail no-record against $QDS_RUNS_DIR.
      const altDir = join(dir, "alt-runs");
      const altStore = new RunRecordStore(altDir);
      await createRun(recording, altStore, { runId, recordAuditLink: (l) => auditLinks.push(l) });
      altStore.set(runId, { commitSha: origin.baseSha });
      await fillBox(runId, runId, origin.originDir, 3, true);

      const res = await cli([runId, "--dir", altDir], origin.originDir);

      expect(res.exitCode).toBe(0);
      expect(altStore.get(runId).closedAt).toBeString();
      // both output surfaces landed under --dir, not under $QDS_RUNS_DIR
      expect(existsSync(join(altDir, `${runId}.bundle`))).toBeTrue();
      expect(existsSync(join(altDir, `${runId}-artifacts`, "run.log"))).toBeTrue();
      expect(existsSync(join(store.dir, `${runId}.bundle`))).toBeFalse();
    }, 60_000);

    test("harvest mode stays credential-free: keyed record, no $OPENROUTER_PROVISIONING_KEY → exit 0", async () => {
      const runId = "df25-script-keyed-hv";
      const origin = await makeOrigin();
      await makeRun(runId);
      await mintFor(runId); // the record now carries keyHash
      store.set(runId, { commitSha: origin.baseSha });
      await fillBox(runId, runId, origin.originDir, 2, true);

      // If the CLI ever built openRouterKeyApi() in harvest mode, the missing
      // env var would abort with provisioning-key-missing before any work.
      const res = await cli(["harvest", runId], origin.originDir, { OPENROUTER_PROVISIONING_KEY: undefined });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("harvested");
      expect(store.get(runId).closedAt).toBeUndefined();
    }, 60_000);
  });

  // ─── 11. E2E DEMO — mandatory DoD evidence ────────────────────────────────

  test("E2E DEMO (DoD, MANDATORY): three-commit run harvested and torn down end to end", async () => {
    const evidence = await runE2eDemo();
    console.log(`DF2.5 teardown e2e demo evidence:\n${JSON.stringify(evidence, null, 2)}`);

    expect(evidence.revListRangedCount).toBe(3);
    expect(evidence.revListTotalCount).toBe(6); // 3 origin + 3 in-box: the ref's full ancestry
    expect(evidence.porcelainEmpty).toBeTrue();
    expect(evidence.branchListUnchanged).toBeTrue();
    expect(evidence.spendMicroUsd).toBe(8100);
    expect(evidence.keyRevoked).toBeTrue();
    expect(evidence.boxDirGone).toBeTrue();
    expect(evidence.bundlePresent).toBeTrue();
    expect(evidence.artifactsDir).toBeString();
    expect(evidence.artifactEntries).toContain("run.log");
    expect(evidence.closedAt).toBeString();
    expect(evidence.leak).toBeNull();
  }, 60_000);
});

// ─── the demo — its evidence bundle is printed by the test for the Dev Agent Record ──

interface TeardownDemoEvidence {
  runId: string;
  baseSha: string;
  originCommits: number;
  boxCommits: number;
  /** `git rev-list --count <baseSha>..refs/sandbox/<runId>` — the harvested range. */
  revListRangedCount: number;
  /** `git rev-list --count refs/sandbox/<runId>` — the ref's full ancestry. */
  revListTotalCount: number;
  porcelainEmpty: boolean;
  branchListUnchanged: boolean;
  sandboxRef: string;
  spendMicroUsd: number | undefined;
  keyRevoked: boolean;
  boxDirGone: boolean;
  bundlePresent: boolean;
  artifactsDir: string | null;
  artifactEntries: string[];
  closedAt: string | undefined;
  leak: string | null;
}

/**
 * The story's demonstrable behavior, at library level, against a real
 * throwaway repo and the fake driver: origin repo → box clone at the pinned
 * base → sbx branch + 3 in-box commits → minted key → artifacts tree → full
 * teardownSandbox. Returns the evidence bundle for the Dev Agent Record.
 */
async function runE2eDemo(): Promise<TeardownDemoEvidence> {
  const runId = "df25-demo";
  const origin = await makeOrigin(3);
  await makeRun(runId);
  const hash = await mintFor(runId);
  store.set(runId, { commitSha: origin.baseSha });
  await fillBox(runId, runId, origin.originDir, 3, true);

  const branchBefore = await hostGit(origin.originDir, ["branch", "-a"]);

  await teardownSandbox(deps({ gitCwd: origin.originDir }), runId, lockFor(runId));

  const rec = store.get(runId);
  const secret = api.plaintexts.get(hash) as string;
  const argvCorpus = recording.execCalls.map((c) => c.argv.join(" ")).join("\n");
  const artifactDir = join(store.dir, `${runId}-artifacts`);
  return {
    runId,
    baseSha: origin.baseSha,
    originCommits: 3,
    boxCommits: 3,
    revListRangedCount: Number(
      await hostGit(origin.originDir, ["rev-list", "--count", `${origin.baseSha}..refs/sandbox/${runId}`]),
    ),
    // origin seeded 3 commits (all ancestors of baseSha); the box adds 3 more.
    // revListTotalCount=6 includes base ancestry, while the RANGED count is the story's literal 3.
    revListTotalCount: Number(
      await hostGit(origin.originDir, ["rev-list", "--count", `refs/sandbox/${runId}`]),
    ),
    porcelainEmpty: (await hostGit(origin.originDir, ["status", "--porcelain"])) === "",
    branchListUnchanged: (await hostGit(origin.originDir, ["branch", "-a"])) === branchBefore,
    sandboxRef: await hostGit(origin.originDir, ["rev-parse", "--verify", `refs/sandbox/${runId}`]),
    spendMicroUsd: rec.spendMicroUsd,
    keyRevoked: !(await api.listAllKeys(20)).entries.some((k) => k.hash === hash),
    boxDirGone: !existsSync(boxDir(runId)),
    bundlePresent: existsSync(join(store.dir, `${runId}.bundle`)),
    artifactsDir: existsSync(artifactDir) ? artifactDir : null,
    artifactEntries: existsSync(artifactDir) ? readdirSync(artifactDir).sort() : [],
    closedAt: rec.closedAt,
    leak: leakScan(secret, readFileSync(store.path(runId), "utf8"), JSON.stringify(logs), argvCorpus),
  };
}

// ─── DF4.2: stopVisualizer prepend (AC6) ──────────────────────────────────────

describe("DF4.2 stopVisualizer prepend (AC6)", () => {
  test("(a) stopVisualizer runs FIRST, ahead of spend", async () => {
    const runId = "df42-viz-first";
    const host = await makeHostRepo();
    await makeRun(runId);
    await mintFor(runId);
    const { calls, deps: d } = orderDepsWithViz({ gitCwd: host });
    await teardownSandbox(d, runId, lockFor(runId));
    expect(calls[0]).toBe("stopVisualizer");
    expect(calls.indexOf("stopVisualizer")).toBe(0);
    expect(calls.indexOf("stopVisualizer")).toBeLessThan(calls.indexOf("spend"));
  });

  test("(b) the prepend keeps DF2.5's six-step relative order intact (subsequence, not equality)", async () => {
    const runId = "df42-viz-subseq";
    const host = await makeHostRepo();
    await makeRun(runId);
    await mintFor(runId);
    const { calls, deps: d } = orderDepsWithViz({ gitCwd: host });
    await teardownSandbox(d, runId, lockFor(runId));
    // assertTeardownOrder only reasons about spend/revoke/destroy/close — it
    // is unmodified from DF2.5 and still passes with "stopVisualizer" as an
    // extra label ahead of everything it checks, proving the prepend is
    // additive rather than a reorder of the existing six.
    assertTeardownOrder(calls);
    // orderDeps only wraps the claimants it already tracks (spend/revoke/
    // verify/destroy/close) — artifacts/harvest run too but aren't pushed here
    // (asserted separately via logs, as the pre-existing tests already do).
    // "stopVisualizer" leads every one of them.
    expect(calls[0]).toBe("stopVisualizer");
    for (const label of ["spend", "revoke", "verify", "destroy", "close"]) {
      expect(calls.indexOf(label)).toBeGreaterThan(0);
    }
  });

  test("(c) a count-only check is blind to a reordering that the subsequence check catches", () => {
    const good = ["stopVisualizer", "spend", "revoke", "destroy", "close"];
    // Same five labels, same count, but revoke/destroy swapped ahead of spend.
    const reordered = ["revoke", "destroy", "spend", "stopVisualizer", "close"];

    const countOnly = (calls: string[]) => calls.length === 5;
    // The gate this test exists to demonstrate: a bare count assertion passes
    // on BOTH the correctly-ordered and the reordered call list — it is not a
    // gate against reordering at all, only against steps going missing.
    expect(countOnly(good)).toBe(true);
    expect(countOnly(reordered)).toBe(true);

    // The subsequence check this file actually uses is not blind the same
    // way: it throws on the reordered list and passes on the correct one.
    expect(() => assertTeardownOrder(good)).not.toThrow();
    expect(() => assertTeardownOrder(reordered)).toThrow();
    expect(reordered.indexOf("stopVisualizer")).toBeGreaterThan(reordered.indexOf("spend")); // the reorder this catches
  });

  test("(d) a failing stopVisualizer is logged with its cause and does NOT abort teardown", async () => {
    const runId = "df42-viz-fail";
    const host = await makeHostRepo();
    await makeRun(runId);
    await mintFor(runId);
    const { deps: d } = orderDepsWithViz({ gitCwd: host }, () => Promise.reject(new Error("box unreachable")));
    // Must not throw — AC6's whole point is that this completes normally.
    await teardownSandbox(d, runId, lockFor(runId));
    const rec = store.get(runId);
    expect(rec.closedAt).toBeString();
    expect(existsSync(boxDir(runId))).toBeFalse();
    const vizLog = logs.find(
      (l) => l.operation === "teardown.stopVisualizer" && l.status === "error",
    ) as (LogEntry & { error?: { code: string; message: string } }) | undefined;
    expect(vizLog).toBeDefined();
    expect(vizLog?.error?.message).toContain("box unreachable");
  });

  test("no box ever created: stopVisualizer is skipped, not run", async () => {
    const runId = "df42-viz-no-box";
    store.create(runId); // a record that never got a VM
    await teardownSandbox(deps({ keyApi: undefined }), runId, lockFor(runId));
    const skip = logs.find((l) => l.operation === "teardown.stopVisualizer");
    expect(skip?.outcome).toBe("skipped");
  });

  test("a driver rejecting with null still lets teardown complete and bring the box down", async () => {
    // Regression: `err.code` on a null/undefined rejection throws TypeError,
    // which escapes runVizStopStep and aborts the whole teardown sequence —
    // box left alive, record left open — exactly what AC6 exists to prevent.
    const runId = "df42-viz-null-reject";
    const host = await makeHostRepo();
    await makeRun(runId);
    await mintFor(runId);
    const { deps: d } = orderDepsWithViz({ gitCwd: host }, () => Promise.reject(null));
    await teardownSandbox(d, runId, lockFor(runId)); // must not throw
    const rec = store.get(runId);
    expect(rec.closedAt).toBeString();
    expect(existsSync(boxDir(runId))).toBeFalse();
  });

  test("an already-destroyed box logs a skip, not status:\"error\", on the stopVisualizer step", async () => {
    // Every other pre-destroy step that execs the box routes "box is gone"
    // through isNoSuchBox and records a skip (see teardown.ts:125-133);
    // runVizStopStep must do the same instead of alerting on a routine
    // crash-between-destroy-and-close / reaper-race condition.
    const runId = "df42-viz-no-such-box";
    const host = await makeHostRepo();
    await makeRun(runId);
    await mintFor(runId);
    const noSuchBox = new HarvestError("exec-failed", "no such box", "n/a", { noSuchBox: true });
    const { deps: d } = orderDepsWithViz({ gitCwd: host }, () => Promise.reject(noSuchBox));
    await teardownSandbox(d, runId, lockFor(runId));
    const vizLog = logs.find((l) => l.operation === "teardown.stopVisualizer");
    expect(vizLog?.status).toBe("ok");
    expect(vizLog?.outcome).toBe("skipped");
  });

  test("a process that survives SIGTERM and SIGKILL is reported ALIVE, pidfile kept, stopped:false", async () => {
    // Stub the exec transport directly rather than spawning a real
    // unkillable process — asserts driver.ts's stopVisualizer maps the
    // script's own "ALIVE <pid>" line (emitted when the wait loop finds the
    // pid still alive after both signals) to stopped:false with a reason
    // naming it, instead of falling through to the default stopped:true.
    const stub = {
      exec: (_vm: string, _argv: string[], _stdin?: string): Promise<ExecResult> =>
        Promise.resolve({ stdout: "ALIVE 4242\n", stderr: "", exitCode: 0 }),
    } as unknown as Parameters<typeof stopVisualizer>[0];
    const result = await stopVisualizer(stub, "df42-viz-alive");
    expect(result.stopped).toBeFalse();
    expect(result.reason).toContain("ALIVE 4242");
    expect(result.reason).toContain("SIGKILL");
  });
});

// ─── startVisualizer: shell-injection guard (driver.ts) ───────────────────────

describe("startVisualizer shell-injection guard", () => {
  const baseOpts = { port: 4173, dbPath: "/tmp/viz.db" };

  test("a dbPath carrying a shell metacharacter is refused before any exec is issued", async () => {
    const vm = await driver.create("viz-inject-dbpath");
    const before = recording.execCalls.length;
    await expect(
      startVisualizer(recording, vm.name, { ...baseOpts, dbPath: "/tmp/x'; touch /tmp/PWNED #" }),
    ).rejects.toThrow(/not a plain path/);
    expect(recording.execCalls.length).toBe(before); // zero exec calls emitted
  });

  test("a cwd carrying a shell metacharacter is refused before any exec is issued", async () => {
    const vm = await driver.create("viz-inject-cwd");
    const before = recording.execCalls.length;
    await expect(
      startVisualizer(recording, vm.name, { ...baseOpts, cwd: "visualizer'; touch /tmp/PWNED #" }),
    ).rejects.toThrow(/not a plain path/);
    expect(recording.execCalls.length).toBe(before);
  });

  test("an envFile carrying a shell metacharacter is refused before any exec is issued", async () => {
    const vm = await driver.create("viz-inject-envfile");
    const before = recording.execCalls.length;
    await expect(
      startVisualizer(recording, vm.name, { ...baseOpts, envFile: "/tmp/x'; touch /tmp/PWNED #" }),
    ).rejects.toThrow(/not a plain path/);
    expect(recording.execCalls.length).toBe(before);
  });

  test("an envFile with a '..' segment is refused before any exec is issued", async () => {
    const vm = await driver.create("viz-inject-traversal");
    const before = recording.execCalls.length;
    await expect(
      startVisualizer(recording, vm.name, { ...baseOpts, envFile: "/tmp/../etc/passwd" }),
    ).rejects.toThrow(/not a plain path/);
    expect(recording.execCalls.length).toBe(before);
  });

  test("a non-integer port is refused before any exec is issued", async () => {
    const vm = await driver.create("viz-inject-port-float");
    const before = recording.execCalls.length;
    await expect(startVisualizer(recording, vm.name, { ...baseOpts, port: 1.5 })).rejects.toThrow(
      /integer in 1\.\.65535/,
    );
    expect(recording.execCalls.length).toBe(before);
  });

  test("a port outside 1..65535 is refused before any exec is issued", async () => {
    const vm = await driver.create("viz-inject-port-range");
    const before = recording.execCalls.length;
    await expect(startVisualizer(recording, vm.name, { ...baseOpts, port: 70000 })).rejects.toThrow(
      /integer in 1\.\.65535/,
    );
    expect(recording.execCalls.length).toBe(before);
  });
});

// ─── neverPublicDriver: setPublic guard (driver.ts, INV-2) ────────────────────

describe("neverPublicDriver setPublic guard", () => {
  test("the guarded driver's setPublic refuses unconditionally", async () => {
    const vm = await driver.create("viz-never-public");
    const guarded = neverPublicDriver(recording, 4173);
    // assertNeverPublic throws synchronously (it is typed `never`, not async).
    expect(() => guarded.setPublic(vm.name)).toThrow();
  });

  test("the raw driver's own setPublic is untouched — still callable directly", async () => {
    const vm = await driver.create("viz-raw-public");
    await expect(driver.setPublic(vm.name)).resolves.toBeUndefined();
  });

  // ─── expose branch (gated on the port operand, unlike setPublic) ──────────

  test("the guarded driver's expose refuses exactly the viz port", async () => {
    const vm = await driver.create("viz-expose-viz-port");
    const guarded = neverPublicDriver(recording, 4173);
    expect(() => guarded.expose(vm.name, 4173)).toThrow();
  });

  test("the guarded driver's expose delegates to the raw driver for any other port", async () => {
    const vm = await driver.create("viz-expose-other-port");
    const guarded = neverPublicDriver(recording, 4173);
    const exposeSpy = spyOn(recording, "expose");
    const result = await guarded.expose(vm.name, 8080);
    expect(exposeSpy).toHaveBeenCalledTimes(1);
    expect(exposeSpy).toHaveBeenCalledWith(vm.name, 8080);
    await expect(exposeSpy.mock.results[0]!.value).resolves.toBe(result);
  });
});
