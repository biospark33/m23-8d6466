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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createRun } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { SBX_KEY_PREFIX } from "../../src/providers/credentials.ts";
import { bunGitRunner, type GitRunner } from "../../src/providers/harvest.ts";
import { teardownSandbox, TeardownError, type TeardownDeps } from "../../src/providers/teardown.ts";
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
  recording = new RecordingDriver(driver);
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
  // workdir "app": the fake box's clone target (impl default is DF2.2's /home/agent/src)
  return { driver: recording, store, keyApi: api, runsDir: store.dir, workdir: "app", ...overrides };
}

function boxDir(vm: string): string {
  return join(dir, "boxes", vm);
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

  // ─── 9a. No-VM guard ───────────────────────────────────────────────────────

  test("no-VM record: teardown completes, destroy skipped with the no-box reason, record closes", async () => {
    const runId = "df25-novm";
    store.create(runId); // a record that never got a VM — but it DID get a key
    const hash = await mintFor(runId);

    await teardownSandbox(deps(), runId);

    expect(store.get(runId).closedAt).toBeString();
    // the key lifecycle still ran end to end on the way past (spend → revoke → verify)
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeFalse();
    const destroy = logs.find((l) => l.operation === "teardown.destroy");
    expect(destroy?.outcome).toBe("skipped");
    expect(String(destroy?.reason)).toContain("no box was ever created");
  }, 30_000);

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
