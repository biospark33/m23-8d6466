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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createRun, neverPublicDriver, startVisualizer, stopVisualizer, VIZ_PIDFILE } from "../../src/providers/driver.ts";
import type { ExecResult, ProviderDriver } from "../../src/providers/driver.ts";
import { HarvestError } from "../../src/providers/harvest.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { SBX_KEY_PREFIX } from "../../src/providers/credentials.ts";
import { bunGitRunner, type GitRunner } from "../../src/providers/harvest.ts";
import { teardownSandbox, TeardownError, type CostLedgerHook, type TeardownDeps } from "../../src/providers/teardown.ts";
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
/** mkdtemp roots owned by git-fixture helpers — cleaned in afterEach. */
const fixtureRoots: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df25-td-"));
  store = new RunRecordStore(join(dir, "runs"));
  api = new FakeKeyApi({ usageOnCreateUsd: 0.0081 });
  driver = new FakeDriver(join(dir, "boxes"));
  recording = new RecordingDriver(guardVizPidfile(driver));
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
});

afterEach(() => {
  restoreLog?.();
  rmSync(dir, { recursive: true, force: true });
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function deps(overrides: Partial<TeardownDeps> = {}): TeardownDeps {
  // workdir "app": the fake box's clone target (impl default is the HOME-relative "src")
  return { driver: recording, store, keyApi: api, runsDir: store.dir, workdir: "app", ...overrides };
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
function orderDeps(base: Partial<TeardownDeps> = {}): { calls: string[]; deps: TeardownDeps } {
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
  return { calls, deps: { driver: driverW, store: storeW, keyApi: keyW, runsDir: store.dir, workdir: "app", ...base } };
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
  await createRun(recording, store, { runId });
}

// ─── 1. DoD ordering ─────────────────────────────────────────────────────────

describe("DF2.5 teardownSandbox", () => {
  test("DoD order: spend → revoke → destroy, close LAST (subsequence, not equality)", async () => {
    const runId = "df25-order";
    const host = await makeHostRepo();
    await makeRun(runId);
    await mintFor(runId);
    const h = orderDeps({ gitCwd: host });

    await teardownSandbox(h.deps, runId);

    assertTeardownOrder(h.calls);
    expect(store.get(runId).closedAt).toBeString();
    // destroy really ran: the fake box directory is gone
    expect(existsSync(boxDir(runId))).toBeFalse();
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
      await teardownSandbox(deps({ gitCwd: origin.originDir, gitRunner: failRunVerify }), runId);
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

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId);

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
      await teardownSandbox(deps({ gitCwd: host, gitRunner: brokenRunner, driver: driverW }), runId);
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
      await teardownSandbox(deps({ gitCwd: origin.originDir, driver: driverW }), runId);
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

    await teardownSandbox(h.deps, runId);

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

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId, { noHarvest: true });

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

    await teardownSandbox(deps({ gitCwd: origin.originDir, driver: driverW }), runId);

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

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId);
    const firstClosedAt = store.get(runId).closedAt;
    expect(firstClosedAt).toBeString();

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId);

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
    const keyless: TeardownDeps = { driver: recording, store, runsDir: store.dir, gitCwd: host, workdir: "app" };

    await teardownSandbox(keyless, runId);

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

    await teardownSandbox(h.deps, runId);

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

    await teardownSandbox(deps(), runId);

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

    await teardownSandbox(h.deps, runId);

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

    await teardownSandbox(deps(), runId);

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

    await expect(teardownSandbox(deps({ driver: failing as unknown as TeardownDeps["driver"] }), runId)).rejects.toThrow(
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
      /** When set, throws on next call with code/remediation */
      error?: { code: string; message: string; remediation: string };

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

      await teardownSandbox(deps_, runId);

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
      await teardownSandbox(deps_, runId);
      expect(boxRows().n).toBe(1);

      // D10: verify eventId is deterministic across re-runs
      const firstRow = rawDb.query("SELECT event_id FROM cost_events WHERE kind = 'box_hours' AND run_id = ?").get(runId) as { event_id: string };
      const firstEventId = firstRow.event_id;

      // Second run (already-closed early path again)
      await teardownSandbox(deps_, runId);
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
      await teardownSandbox(deps({ gitCwd: host }), runId);

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
        );
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(TeardownError);
      const te = err as TeardownError;
      expect(te.code).toBe("box-hour-rate-unconfigured");
      expect(te.remediation).toContain("boxHourRateMicroUsd");
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
      await teardownSandbox(deps({ gitCwd: host }), runId);
      expect(store.get(runId).closedAt).toBeString();
      expect(hook.ingestCount).toBe(0); // No hook first run

      // Second run: record is already closed, early path should still fire ingestBoxHours
      await teardownSandbox(
        deps({
          gitCwd: host,
          costLedger: hook,
        }),
        runId,
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
      );

      // ingestBoxHours NEVER called - non-primitive values count as no attribution
      expect(hook.ingestCount).toBe(0);
      expect(hook.calls).toHaveLength(0);

      // Teardown still completes successfully
      expect(store.get(runId).closedAt).toBeString();
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

    await teardownSandbox(deps({ gitCwd: origin.originDir }), runId);

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
      await teardownSandbox(deps(), runId);
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

    await teardownSandbox(deps({ gitCwd: origin.originDir, driver: exedevShape }), runId);

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

    await teardownSandbox(deps({ gitRunner: spy }), runId);

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

    await teardownSandbox(deps({ gitRunner: broken }), runId);

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
      await createRun(recording, altStore, { runId });
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

  await teardownSandbox(deps({ gitCwd: origin.originDir }), runId);

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
    await teardownSandbox(d, runId);
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
    await teardownSandbox(d, runId);
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
    await teardownSandbox(d, runId);
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
    await teardownSandbox(deps({ keyApi: undefined }), runId);
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
    await teardownSandbox(d, runId); // must not throw
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
    await teardownSandbox(d, runId);
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
